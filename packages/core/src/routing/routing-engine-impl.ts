/**
 * RoutingEngineImpl — full implementation of the RoutingEngine.
 *
 * Responsibilities:
 *  1. Load and validate routing policy on initialization
 *  2. Subscribe to task:ready events and make routing decisions
 *  3. Emit task:routed events with full RoutingDecision
 *  4. Subscribe to task:complete events to update rate limit tracking
 *  5. Emit provider:unavailable when rate limits are exhausted
 *  6. Support hot-reload via reloadPolicy()
 *
 * Architecture constraints:
 *  - ADR-004: Stateless except for rate limit tracking in-memory
 *  - ADR-008: Subscription-first policy is mandatory
 *  - FR22, FR23, FR25: Subscription routing toggles per provider
 *  - FR29: Rate limit management
 *  - FR38: Hot-reload without daemon restart
 *  - NFR7: Routing decision rationale in all decisions
 */

import type { TypedEventBus } from '../events/event-bus.js'
import type { CoreEvents } from '../events/core-events.js'
import type { IAdapterRegistry, ILogger } from '../dispatch/types.js'
import { loadRoutingPolicy, type RoutingPolicy, type ProviderPolicy } from './routing-policy.js'
import { ProviderStatusTracker, type ProviderStatus } from './provider-status.js'
import {
  makeRoutingDecision,
  type RoutingDecision,
  type MonitorRecommendation,
} from './routing-decision.js'
import type { RoutingEngine, RoutingTask } from './routing-engine.js'
import type { IConfigSystem, IMonitorAgent } from './types.js'

/** Default path to the routing policy YAML */
const DEFAULT_ROUTING_POLICY_PATH = '.substrate/routing-policy.yaml'

// ---------------------------------------------------------------------------
// RoutingEngineImpl
// ---------------------------------------------------------------------------

export class RoutingEngineImpl implements RoutingEngine {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _configSystem: IConfigSystem | null
  private readonly _adapterRegistry: IAdapterRegistry | null
  private readonly _logger: ILogger

  private _policy: RoutingPolicy | null = null
  private _policyPath = DEFAULT_ROUTING_POLICY_PATH
  private readonly _statusTracker = new ProviderStatusTracker()

  /** Optional monitor agent for advisory recommendations (AC5) */
  private _monitorAgent: IMonitorAgent | null = null
  /** Whether to consult monitor for recommendations (AC6) */
  private _useMonitorRecommendations = false

  /** Bound references for event listener management */
  private readonly _onTaskReady: (payload: { taskId: string; taskType?: string }) => void
  private readonly _onTaskComplete: (payload: {
    taskId: string
    result: { tokensUsed?: number }
  }) => void
  private readonly _onConfigReloaded: (payload: {
    changedKeys: string[]
    newConfig: Record<string, unknown>
  }) => void

  constructor(
    eventBus: TypedEventBus<CoreEvents>,
    configSystem?: IConfigSystem | null,
    adapterRegistry?: IAdapterRegistry | null,
    logger?: ILogger
  ) {
    this._eventBus = eventBus
    this._configSystem = configSystem ?? null
    this._adapterRegistry = adapterRegistry ?? null
    this._logger = logger ?? console

    this._onTaskReady = ({ taskId, taskType }: { taskId: string; taskType?: string }) => {
      this._handleTaskReady(taskId, taskType)
    }

    this._onTaskComplete = ({
      taskId,
      result,
    }: {
      taskId: string
      result: { tokensUsed?: number }
    }) => {
      this._handleTaskComplete(taskId, result)
    }

    this._onConfigReloaded = (payload: {
      changedKeys: string[]
      newConfig: Record<string, unknown>
    }) => {
      this._handleConfigReloaded(payload.changedKeys, payload.newConfig)
    }
  }

  // ---------------------------------------------------------------------------
  // BaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    this._logger.info('RoutingEngine.initialize()')

    // Resolve routing policy path from config
    if (this._configSystem !== null) {
      const configuredPath = this._configSystem.get('routing_policy_path')
      if (typeof configuredPath === 'string' && configuredPath.length > 0) {
        this._policyPath = configuredPath
      }
    }

    // Load routing policy (gracefully handle missing file — policy is optional)
    try {
      this._policy = loadRoutingPolicy(this._policyPath)
      this._initializeProviderTracking()
      this._logger.info({ policyPath: this._policyPath }, 'Routing policy loaded successfully')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._logger.debug(
        { policyPath: this._policyPath, err: message },
        'Routing policy not loaded — routing will use fallback behavior'
      )
      this._policy = null
    }

    // Subscribe to events
    this._eventBus.on('task:ready', this._onTaskReady)
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on(
      'config:reloaded',
      this._onConfigReloaded as Parameters<typeof this._eventBus.on>[1]
    )
  }

  async shutdown(): Promise<void> {
    this._logger.info('RoutingEngine.shutdown()')
    this._eventBus.off('task:ready', this._onTaskReady)
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off(
      'config:reloaded',
      this._onConfigReloaded as Parameters<typeof this._eventBus.off>[1]
    )
  }

  // ---------------------------------------------------------------------------
  // RoutingEngine interface
  // ---------------------------------------------------------------------------

  /**
   * Set the monitor agent for advisory recommendations (AC5).
   * Called externally when use_monitor_recommendations=true.
   */
  setMonitorAgent(monitorAgent: IMonitorAgent, useRecommendations = true): void {
    this._monitorAgent = monitorAgent
    this._useMonitorRecommendations = useRecommendations
    this._logger.debug({ useRecommendations }, 'Monitor agent registered with routing engine')
  }

  /**
   * Make a routing decision for a task.
   *
   * Implements the subscription-first algorithm from Architecture Section 8:
   * 1. Check if task has explicit agent assignment
   * 2. Determine preferred agents from routing policy (task type → preferred_agents)
   * 3. For each preferred agent, evaluate subscription-first logic:
   *    a. If subscription_routing=true AND capacity available AND rate limit OK → subscription
   *    b. Else if API billing enabled AND API key configured → API
   *    c. Else try next fallback agent
   * 4. If no agent available → return unavailable decision
   * 5. (Advisory) If monitor agent available, attach recommendation (AC5)
   */
  routeTask(task: RoutingTask): RoutingDecision {
    const taskId = task.id
    // Support both task.type (new RoutingTask style) and task.metadata?.taskType (TaskNode style)
    const taskType = task.type ?? (task.metadata?.['taskType'] as string | undefined) ?? ''

    this._logger.debug({ taskId, taskType }, 'routeTask called')

    // No policy loaded — emit basic decision with first available adapter
    if (this._policy === null) {
      return this._routeWithoutPolicy(task)
    }

    // Get preferred agents based on task type (falls back to default)
    const taskTypePolicy = taskType.length > 0 ? this._policy.task_types?.[taskType] : undefined
    const preferredAgents =
      taskTypePolicy?.preferred_agents ?? this._policy.default.preferred_agents
    const modelPreferences = taskTypePolicy?.model_preferences ?? {}

    // Collect the fallback chain for auditing
    const fallbackChain: string[] = [...preferredAgents]

    // Check explicit agent assignment
    if (task.agentId !== undefined && task.agentId.length > 0) {
      const explicitAgent = task.agentId
      const provider = this._policy.providers[explicitAgent]

      if (provider !== undefined && provider.enabled) {
        const decision = this._evaluateAgent(taskId, explicitAgent, provider, modelPreferences)
        if (decision !== null) {
          const builder = makeRoutingDecision(taskId)
            .withAgent(decision.agent, decision.billingMode)
            .withModel(decision.model ?? '')
            .withRationale(
              `Explicit agent assignment: ${explicitAgent} via ${decision.billingMode}`
            )
            .withFallbackChain([explicitAgent])
          this._attachMonitorRecommendation(builder, taskType, decision.agent)
          return builder.build()
        }
      }

      // Explicit agent unavailable — fall through to policy routing
      this._logger.debug(
        { taskId, explicitAgent },
        'Explicit agent unavailable, falling back to policy'
      )
    }

    // Evaluate each preferred agent in order
    for (const agentName of preferredAgents) {
      const provider = this._policy.providers[agentName]
      if (provider === undefined || !provider.enabled) {
        this._logger.debug({ taskId, agentName }, 'Agent not in providers or disabled, skipping')
        continue
      }

      const decision = this._evaluateAgent(taskId, agentName, provider, modelPreferences)
      if (decision !== null) {
        // Determine rationale
        const rationale = this._buildRationale(taskId, agentName, decision.billingMode, taskType)
        const builder = makeRoutingDecision(taskId)
          .withAgent(decision.agent, decision.billingMode)
          .withModel(decision.model ?? '')
          .withRationale(rationale)
          .withFallbackChain(fallbackChain)
        this._attachMonitorRecommendation(builder, taskType, decision.agent)
        return builder.build()
      }
    }

    // All preferred agents unavailable
    const rationale = `All preferred agents unavailable for task type "${taskType || 'default'}": [${preferredAgents.join(', ')}]`
    this._logger.warn({ taskId, preferredAgents }, rationale)

    // Emit provider:unavailable for the primary agent
    if (preferredAgents.length > 0) {
      this._eventBus.emit('provider:unavailable', {
        provider: preferredAgents[0]!,
        reason: 'rate_limit',
        resetAtMs: this._statusTracker.getRateLimitResetTime(preferredAgents[0]!).getTime(),
      })
    }

    return makeRoutingDecision(taskId)
      .unavailable(rationale)
      .withFallbackChain(fallbackChain)
      .build()
  }

  /**
   * Get the current status of a provider.
   */
  getProviderStatus(providerName: string): ProviderStatus | null {
    return this._statusTracker.getStatus(providerName)
  }

  /**
   * Record token usage for rate limit tracking after task completion.
   */
  updateRateLimit(provider: string, tokensUsed: number): void {
    this._statusTracker.recordTokenUsage(provider, tokensUsed)
    this._logger.debug({ provider, tokensUsed }, 'Rate limit updated')
  }

  /**
   * Hot-reload the routing policy from disk without daemon restart (FR38).
   */
  async reloadPolicy(): Promise<void> {
    this._logger.info({ policyPath: this._policyPath }, 'Reloading routing policy')

    const newPolicy = loadRoutingPolicy(this._policyPath)
    this._policy = newPolicy
    this._initializeProviderTracking()

    this._logger.info('Routing policy reloaded successfully')
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _handleTaskReady(taskId: string, taskType?: string): void {
    this._logger.debug({ taskId, taskType }, 'task:ready — making routing decision')

    if (this._policy === null) {
      this._logger.debug({ taskId }, 'No routing policy — emitting minimal routing decision')
      const decision = makeRoutingDecision(taskId)
        .withAgent('', 'unavailable')
        .withRationale('No routing policy configured')
        .build()
      this._eventBus.emit('task:routed', { taskId, decision })
      return
    }

    // Build task node with task type from the event payload
    const minimalTask: RoutingTask = {
      id: taskId,
      ...(taskType !== undefined ? { type: taskType } : {}),
      metadata: taskType ? { taskType } : {},
    }

    const decision = this.routeTask(minimalTask)
    this._eventBus.emit('task:routed', { taskId, decision })
  }

  private _handleTaskComplete(taskId: string, result: { tokensUsed?: number }): void {
    // We need to know which provider was used — this requires tracking from task:routed
    // For now, we can't easily reverse-map taskId→provider without additional state.
    // The full integration with billing/cost tracking happens in Story 4.2.
    this._logger.debug(
      { taskId, tokensUsed: result.tokensUsed },
      'task:complete received — rate limit tracking deferred to cost tracker'
    )
  }

  private _handleConfigReloaded(changedKeys: string[], newConfig: Record<string, unknown>): void {
    // Use provider configuration from newConfig directly when available (AC4)
    // Already-dispatched tasks are NOT re-routed; routing is determined at dispatch time.
    const hasRoutingChanges = changedKeys.some(
      (k) => k.startsWith('providers.') || k.startsWith('routing') || k === 'routing_policy_path'
    )

    if (!hasRoutingChanges) {
      this._logger.debug(
        { changedKeys },
        'Config reloaded but no routing-relevant changes — skipping policy reload'
      )
      return
    }

    // Update policy path from newConfig if provided
    const configRoutingPolicyPath = (newConfig as Record<string, unknown>)['routing_policy_path']
    if (typeof configRoutingPolicyPath === 'string' && configRoutingPolicyPath.length > 0) {
      this._policyPath = configRoutingPolicyPath
    }

    // Reload routing policy from its dedicated file (routing policy is separate from main config)
    this.reloadPolicy()
      .then(() => {
        this._logger.info({ changedKeys }, 'Routing policy updated from config reload')
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this._logger.warn({ err: message }, 'Failed to reload routing policy after config reload')
      })
  }

  // ---------------------------------------------------------------------------
  // Routing algorithm helpers
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a single agent using the subscription-first algorithm.
   * Returns { agent, billingMode, model } if available, null if not.
   */
  private _evaluateAgent(
    taskId: string,
    agentName: string,
    provider: ProviderPolicy,
    modelPreferences: Record<string, string>
  ): { agent: string; billingMode: 'subscription' | 'api'; model?: string } | null {
    const model = modelPreferences[agentName]
    const status = this._statusTracker.getStatus(agentName)

    // Check subscription path first (ADR-008: subscription-first is mandatory)
    if (provider.subscription_routing) {
      const rateLimitOk =
        status !== null
          ? this._statusTracker.checkRateLimit(agentName, 1) // pass 1 to detect fully-exhausted window
          : true // No tracking = assume available

      if (rateLimitOk) {
        this._logger.debug({ taskId, agentName }, 'Subscription routing selected')
        return {
          agent: agentName,
          billingMode: 'subscription' as const,
          ...(model !== undefined ? { model } : {}),
        }
      }

      // Rate limit exceeded — log and try API fallback
      this._logger.debug(
        { taskId, agentName },
        'Subscription rate limit exceeded, trying API billing'
      )

      // Emit provider:unavailable for rate limit
      const resetTime = this._statusTracker.getRateLimitResetTime(agentName)
      this._eventBus.emit('provider:unavailable', {
        provider: agentName,
        reason: 'rate_limit',
        resetAtMs: resetTime.getTime(),
      })
    }

    // Check API billing path
    const apiBillingConfig = provider.api_billing
    if (apiBillingConfig?.enabled === true) {
      // Check if API key is configured in environment
      const apiKeyEnv = apiBillingConfig.api_key_env
      if (apiKeyEnv !== undefined && process.env[apiKeyEnv] !== undefined) {
        this._logger.debug({ taskId, agentName }, 'API billing selected')
        return {
          agent: agentName,
          billingMode: 'api' as const,
          ...(model !== undefined ? { model } : {}),
        }
      } else if (apiKeyEnv === undefined) {
        // API key env not required — assume configured
        this._logger.debug({ taskId, agentName }, 'API billing selected (no key env required)')
        return {
          agent: agentName,
          billingMode: 'api' as const,
          ...(model !== undefined ? { model } : {}),
        }
      }

      this._logger.debug({ taskId, agentName, apiKeyEnv }, 'API key not configured, skipping agent')
    }

    return null
  }

  /**
   * Build a human-readable rationale for the routing decision (NFR7).
   */
  private _buildRationale(
    _taskId: string,
    agent: string,
    billingMode: 'subscription' | 'api',
    taskType: string
  ): string {
    const status = this._statusTracker.getStatus(agent)
    const tokensInfo =
      status !== null && status.rateLimit.tokensPerWindow > 0
        ? `, tokens ${status.tokensUsedInWindow}/${status.rateLimit.tokensPerWindow}`
        : ''

    if (billingMode === 'subscription') {
      if (taskType.length > 0) {
        return `Task type "${taskType}" → preferred agent ${agent} via subscription${tokensInfo}`
      }
      return `Subscription-first: ${agent} subscription available${tokensInfo}`
    }

    // API billing
    if (taskType.length > 0) {
      return `Task type "${taskType}" → ${agent} via API billing (subscription exhausted or disabled)`
    }
    return `Subscription exhausted or disabled for ${agent}, falling back to API billing`
  }

  /**
   * Route a task without a loaded routing policy.
   * Uses the first available adapter in the registry.
   * Monitor recommendations are still consulted when use_monitor_recommendations=true (AC1, AC4).
   */
  private _routeWithoutPolicy(task: RoutingTask): RoutingDecision {
    const taskId = task.id
    const taskType = task.type ?? (task.metadata?.['taskType'] as string | undefined) ?? ''

    // If there's an explicit agent, try to use it
    if (task.agentId !== undefined && task.agentId.length > 0) {
      if (this._adapterRegistry !== null) {
        const adapter = this._adapterRegistry.get(task.agentId)
        if (adapter !== undefined) {
          const builder = makeRoutingDecision(taskId)
            .withAgent(task.agentId, 'subscription')
            .withRationale(`No routing policy: using explicit agent ${task.agentId}`)
          this._attachMonitorRecommendation(builder, taskType, task.agentId)
          return builder.build()
        }
      }
    }

    // Try first available adapter
    if (this._adapterRegistry !== null) {
      const adapters = this._adapterRegistry.getAll ? this._adapterRegistry.getAll() : []
      if (adapters.length > 0) {
        const adapter = adapters[0]!
        const builder = makeRoutingDecision(taskId)
          .withAgent(adapter.id, 'subscription')
          .withRationale(`No routing policy: using first available adapter ${adapter.id}`)
        this._attachMonitorRecommendation(builder, taskType, adapter.id)
        return builder.build()
      }
    }

    return makeRoutingDecision(taskId)
      .unavailable('No routing policy configured and no adapters available')
      .build()
  }

  // ---------------------------------------------------------------------------
  // Monitor recommendation helper
  // ---------------------------------------------------------------------------

  /**
   * Attach advisory monitor recommendation to a routing decision builder (AC5, AC7).
   * Only attaches when use_monitor_recommendations=true and a recommendation
   * is available for the task type with confidence >= "medium".
   * Explicit routing policy always takes precedence (AC5).
   *
   * When the monitor recommends a different agent than the policy-selected agent,
   * a debug log is emitted to record the override (AC7).
   */
  private _attachMonitorRecommendation(
    builder: import('./routing-decision.js').RoutingDecisionBuilder,
    taskType: string,
    selectedAgent = ''
  ): void {
    if (!this._useMonitorRecommendations || this._monitorAgent === null) return

    // Mark that monitor was consulted regardless of recommendation availability
    builder.withMonitorInfluenced(true)

    if (taskType.length === 0) return

    try {
      const recommendation = this._monitorAgent.getRecommendation(taskType)
      if (recommendation !== null && recommendation.confidence !== 'low') {
        builder.withMonitorRecommendation(recommendation as MonitorRecommendation)
        this._logger.debug(
          {
            taskType,
            confidence: recommendation.confidence,
            improvement: recommendation.improvement_percentage,
          },
          'Monitor recommendation attached to routing decision'
        )

        // AC7: Log when routing policy overrides the monitor recommendation
        if (selectedAgent.length > 0 && recommendation.recommended_agent !== selectedAgent) {
          this._logger.debug(
            {
              taskType,
              selectedAgent,
              recommendedAgent: recommendation.recommended_agent,
              confidence: recommendation.confidence,
              improvement: recommendation.improvement_percentage,
            },
            'Routing policy overrides monitor recommendation'
          )
        }
      }
    } catch (err) {
      // Never let advisory monitor errors affect routing
      this._logger.warn(
        { err, taskType },
        'Failed to get monitor recommendation — continuing without it'
      )
      // AC5: monitor consultation failed, so the monitor did not influence this decision.
      // Set monitorInfluenced to false since no useful recommendation was obtained.
      builder.withMonitorInfluenced(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Initialization helpers
  // ---------------------------------------------------------------------------

  /**
   * Initialize provider tracking from the loaded routing policy.
   */
  private _initializeProviderTracking(): void {
    if (this._policy === null) return

    for (const [name, provider] of Object.entries(this._policy.providers)) {
      const apiBillingEnabled = provider.api_billing?.enabled === true

      const rateLimit =
        provider.rate_limit !== undefined
          ? {
              tokensPerWindow: provider.rate_limit.tokens_per_window,
              windowSeconds: provider.rate_limit.window_seconds,
            }
          : undefined

      this._statusTracker.initProvider(
        name,
        provider.subscription_routing,
        apiBillingEnabled,
        rateLimit
      )

      this._logger.debug(
        { provider: name, subscriptionRouting: provider.subscription_routing, apiBillingEnabled },
        'Provider tracking initialized'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface RoutingEngineImplOptions {
  eventBus: TypedEventBus<CoreEvents>
  configSystem?: IConfigSystem | null
  adapterRegistry?: IAdapterRegistry | null
  /** Optional monitor agent for advisory recommendations (AC5) */
  monitorAgent?: IMonitorAgent | null
  /** Whether to use monitor recommendations (AC6, default: false) */
  useMonitorRecommendations?: boolean
  /** Optional logger (defaults to console) */
  logger?: ILogger
}

export function createRoutingEngineImpl(options: RoutingEngineImplOptions): RoutingEngineImpl {
  const engine = new RoutingEngineImpl(
    options.eventBus,
    options.configSystem ?? null,
    options.adapterRegistry ?? null,
    options.logger
  )

  if (options.monitorAgent != null && options.useMonitorRecommendations === true) {
    engine.setMonitorAgent(options.monitorAgent, true)
  }

  return engine
}

// ---------------------------------------------------------------------------
// createRoutingEngine factory (thin wrapper)
// ---------------------------------------------------------------------------

/**
 * Create a new RoutingEngine instance using the decoupled core types.
 * This is the primary factory for external consumers of @substrate-ai/core.
 *
 * @example
 * const engine = createRoutingEngine({ eventBus, adapterRegistry })
 * await engine.initialize()
 * const decision = engine.routeTask({ id: 'task-1', type: 'dev-story' })
 */
export function createRoutingEngine(options: RoutingEngineImplOptions): RoutingEngine {
  return createRoutingEngineImpl(options)
}
