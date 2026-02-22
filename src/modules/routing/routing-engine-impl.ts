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

import type { TypedEventBus } from '../../core/event-bus.js'
import type { ConfigSystem } from '../config/config-system.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { loadRoutingPolicy, type RoutingPolicy, type ProviderPolicy } from './routing-policy.js'
import { ProviderStatusTracker, type ProviderStatus } from './provider-status.js'
import { makeRoutingDecision, type RoutingDecision } from './routing-decision.js'
import type { RoutingEngine } from './routing-engine.js'
import type { TaskNode } from '../../core/types.js'
import type { MonitorAgent } from '../monitor/monitor-agent.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('routing')

/** Default path to the routing policy YAML */
const DEFAULT_ROUTING_POLICY_PATH = '.substrate/routing-policy.yaml'

// ---------------------------------------------------------------------------
// RoutingEngineImpl
// ---------------------------------------------------------------------------

export class RoutingEngineImpl implements RoutingEngine {
  private readonly _eventBus: TypedEventBus
  private readonly _configSystem: ConfigSystem | null
  private readonly _adapterRegistry: AdapterRegistry | null

  private _policy: RoutingPolicy | null = null
  private _policyPath = DEFAULT_ROUTING_POLICY_PATH
  private readonly _statusTracker = new ProviderStatusTracker()

  /** Optional monitor agent for advisory recommendations (AC5) */
  private _monitorAgent: MonitorAgent | null = null
  /** Whether to consult monitor for recommendations (AC6) */
  private _useMonitorRecommendations = false

  /** Bound references for event listener management */
  private readonly _onTaskReady: (payload: { taskId: string; taskType?: string }) => void
  private readonly _onTaskComplete: (payload: { taskId: string; result: { tokensUsed?: number } }) => void
  private readonly _onConfigReloaded: (payload: { changedKeys: string[]; newConfig: Record<string, unknown> }) => void

  constructor(
    eventBus: TypedEventBus,
    configSystem?: ConfigSystem | null,
    adapterRegistry?: AdapterRegistry | null,
  ) {
    this._eventBus = eventBus
    this._configSystem = configSystem ?? null
    this._adapterRegistry = adapterRegistry ?? null

    this._onTaskReady = ({ taskId, taskType }: { taskId: string; taskType?: string }) => {
      this._handleTaskReady(taskId, taskType)
    }

    this._onTaskComplete = ({ taskId, result }: { taskId: string; result: { tokensUsed?: number } }) => {
      this._handleTaskComplete(taskId, result)
    }

    this._onConfigReloaded = (payload: { changedKeys: string[]; newConfig: Record<string, unknown> }) => {
      this._handleConfigReloaded(payload.changedKeys, payload.newConfig)
    }
  }

  // ---------------------------------------------------------------------------
  // BaseService lifecycle
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    logger.info('RoutingEngine.initialize()')

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
      logger.info({ policyPath: this._policyPath }, 'Routing policy loaded successfully')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ policyPath: this._policyPath, err: message }, 'Routing policy not loaded — routing will use fallback behavior')
      this._policy = null
    }

    // Subscribe to events
    this._eventBus.on('task:ready', this._onTaskReady)
    this._eventBus.on('task:complete', this._onTaskComplete)
    this._eventBus.on('config:reloaded', this._onConfigReloaded as Parameters<typeof this._eventBus.on>[1])
  }

  async shutdown(): Promise<void> {
    logger.info('RoutingEngine.shutdown()')
    this._eventBus.off('task:ready', this._onTaskReady)
    this._eventBus.off('task:complete', this._onTaskComplete)
    this._eventBus.off('config:reloaded', this._onConfigReloaded as Parameters<typeof this._eventBus.off>[1])
  }

  // ---------------------------------------------------------------------------
  // RoutingEngine interface
  // ---------------------------------------------------------------------------

  /**
   * Set the monitor agent for advisory recommendations (AC5).
   * Called externally when use_monitor_recommendations=true.
   */
  setMonitorAgent(monitorAgent: MonitorAgent, useRecommendations = true): void {
    this._monitorAgent = monitorAgent
    this._useMonitorRecommendations = useRecommendations
    logger.debug({ useRecommendations }, 'Monitor agent registered with routing engine')
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
  routeTask(task: TaskNode): RoutingDecision {
    const taskId = task.id
    const taskType = (task.metadata?.taskType as string | undefined) ?? ''

    logger.debug({ taskId, taskType }, 'routeTask called')

    // No policy loaded — emit basic decision with first available adapter
    if (this._policy === null) {
      return this._routeWithoutPolicy(task)
    }

    // Get preferred agents based on task type (falls back to default)
    const taskTypePolicy = taskType.length > 0 ? this._policy.task_types?.[taskType] : undefined
    const preferredAgents = taskTypePolicy?.preferred_agents ?? this._policy.default.preferred_agents
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
            .withRationale(`Explicit agent assignment: ${explicitAgent} via ${decision.billingMode}`)
            .withFallbackChain([explicitAgent])
          this._attachMonitorRecommendation(builder, taskType, decision.agent)
          return builder.build()
        }
      }

      // Explicit agent unavailable — fall through to policy routing
      logger.debug({ taskId, explicitAgent }, 'Explicit agent unavailable, falling back to policy')
    }

    // Evaluate each preferred agent in order
    for (const agentName of preferredAgents) {
      const provider = this._policy.providers[agentName]
      if (provider === undefined || !provider.enabled) {
        logger.debug({ taskId, agentName }, 'Agent not in providers or disabled, skipping')
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
    logger.warn({ taskId, preferredAgents }, rationale)

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
    logger.debug({ provider, tokensUsed }, 'Rate limit updated')
  }

  /**
   * Hot-reload the routing policy from disk without daemon restart (FR38).
   */
  async reloadPolicy(): Promise<void> {
    logger.info({ policyPath: this._policyPath }, 'Reloading routing policy')

    const newPolicy = loadRoutingPolicy(this._policyPath)
    this._policy = newPolicy
    this._initializeProviderTracking()

    logger.info('Routing policy reloaded successfully')
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  private _handleTaskReady(taskId: string, taskType?: string): void {
    logger.debug({ taskId, taskType }, 'task:ready — making routing decision')

    if (this._policy === null) {
      logger.debug({ taskId }, 'No routing policy — emitting minimal routing decision')
      const decision = makeRoutingDecision(taskId)
        .withAgent('', 'unavailable')
        .withRationale('No routing policy configured')
        .build()
      this._eventBus.emit('task:routed', { taskId, decision })
      return
    }

    // Build task node with task type from the event payload
    const minimalTask: TaskNode = {
      id: taskId,
      title: '',
      description: '',
      status: 'ready',
      priority: 'normal',
      dependencies: [],
      metadata: taskType ? { taskType } : {},
      createdAt: new Date(),
    }

    const decision = this.routeTask(minimalTask)
    this._eventBus.emit('task:routed', { taskId, decision })
  }

  private _handleTaskComplete(taskId: string, result: { tokensUsed?: number }): void {
    // We need to know which provider was used — this requires tracking from task:routed
    // For now, we can't easily reverse-map taskId→provider without additional state.
    // The full integration with billing/cost tracking happens in Story 4.2.
    logger.debug({ taskId, tokensUsed: result.tokensUsed }, 'task:complete received — rate limit tracking deferred to cost tracker')
  }

  private _handleConfigReloaded(changedKeys: string[], newConfig: Record<string, unknown>): void {
    // Use provider configuration from newConfig directly when available (AC4)
    // Already-dispatched tasks are NOT re-routed; routing is determined at dispatch time.
    const hasRoutingChanges = changedKeys.some(
      (k) => k.startsWith('providers.') || k.startsWith('routing') || k === 'routing_policy_path',
    )

    if (!hasRoutingChanges) {
      logger.debug({ changedKeys }, 'Config reloaded but no routing-relevant changes — skipping policy reload')
      return
    }

    // Update policy path from newConfig if provided
    const configRoutingPolicyPath = (newConfig as Record<string, unknown>)['routing_policy_path']
    if (typeof configRoutingPolicyPath === 'string' && configRoutingPolicyPath.length > 0) {
      this._policyPath = configRoutingPolicyPath
    }

    // Reload routing policy from its dedicated file (routing policy is separate from main config)
    this.reloadPolicy().then(() => {
      logger.info({ changedKeys }, 'Routing policy updated from config reload')
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ err: message }, 'Failed to reload routing policy after config reload')
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
    modelPreferences: Record<string, string>,
  ): { agent: string; billingMode: 'subscription' | 'api'; model?: string } | null {
    const model = modelPreferences[agentName]
    const status = this._statusTracker.getStatus(agentName)

    // Check subscription path first (ADR-008: subscription-first is mandatory)
    if (provider.subscription_routing) {
      const rateLimitOk = status !== null
        ? this._statusTracker.checkRateLimit(agentName, 1) // pass 1 to detect fully-exhausted window
        : true // No tracking = assume available

      if (rateLimitOk) {
        logger.debug({ taskId, agentName }, 'Subscription routing selected')
        return { agent: agentName, billingMode: 'subscription', model }
      }

      // Rate limit exceeded — log and try API fallback
      logger.debug({ taskId, agentName }, 'Subscription rate limit exceeded, trying API billing')

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
        logger.debug({ taskId, agentName }, 'API billing selected')
        return { agent: agentName, billingMode: 'api', model }
      } else if (apiKeyEnv === undefined) {
        // API key env not required — assume configured
        logger.debug({ taskId, agentName }, 'API billing selected (no key env required)')
        return { agent: agentName, billingMode: 'api', model }
      }

      logger.debug({ taskId, agentName, apiKeyEnv }, 'API key not configured, skipping agent')
    }

    return null
  }

  /**
   * Build a human-readable rationale for the routing decision (NFR7).
   */
  private _buildRationale(
    taskId: string,
    agent: string,
    billingMode: 'subscription' | 'api',
    taskType: string,
  ): string {
    const status = this._statusTracker.getStatus(agent)
    const tokensInfo = status !== null && status.rateLimit.tokensPerWindow > 0
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
  private _routeWithoutPolicy(task: TaskNode): RoutingDecision {
    const taskId = task.id
    const taskType = (task.metadata?.taskType as string | undefined) ?? ''

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
      const adapters = this._adapterRegistry.getAll()
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
   *
   * @param builder - The routing decision builder to attach the recommendation to
   * @param taskType - The task type being routed
   * @param selectedAgent - The agent selected by the routing policy (for AC7 override-logging)
   */
  private _attachMonitorRecommendation(
    builder: import('./routing-decision.js').RoutingDecisionBuilder,
    taskType: string,
    selectedAgent = '',
  ): void {
    if (!this._useMonitorRecommendations || this._monitorAgent === null) return

    // Mark that monitor was consulted regardless of recommendation availability
    builder.withMonitorInfluenced(true)

    if (taskType.length === 0) return

    try {
      const recommendation = this._monitorAgent.getRecommendation(taskType)
      if (recommendation !== null && recommendation.confidence !== 'low') {
        builder.withMonitorRecommendation(recommendation)
        logger.debug(
          { taskType, confidence: recommendation.confidence, improvement: recommendation.improvement_percentage },
          'Monitor recommendation attached to routing decision',
        )

        // AC7: Log when routing policy overrides the monitor recommendation
        if (selectedAgent.length > 0 && recommendation.recommended_agent !== selectedAgent) {
          logger.debug(
            {
              taskType,
              selectedAgent,
              recommendedAgent: recommendation.recommended_agent,
              confidence: recommendation.confidence,
              improvement: recommendation.improvement_percentage,
            },
            'Routing policy overrides monitor recommendation',
          )
        }
      }
    } catch (err) {
      // Never let advisory monitor errors affect routing
      logger.warn({ err, taskType }, 'Failed to get monitor recommendation — continuing without it')
      // AC5: monitorInfluenced should remain true (monitor was consulted) but we need to
      // reset it here since the consultation failed and returned no useful data
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

      const rateLimit = provider.rate_limit !== undefined
        ? { tokensPerWindow: provider.rate_limit.tokens_per_window, windowSeconds: provider.rate_limit.window_seconds }
        : undefined

      this._statusTracker.initProvider(name, provider.subscription_routing, apiBillingEnabled, rateLimit)

      logger.debug(
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
  eventBus: TypedEventBus
  configSystem?: ConfigSystem | null
  adapterRegistry?: AdapterRegistry | null
  /** Optional monitor agent for advisory recommendations (AC5) */
  monitorAgent?: MonitorAgent | null
  /** Whether to use monitor recommendations (AC6, default: false) */
  useMonitorRecommendations?: boolean
}

export function createRoutingEngineImpl(options: RoutingEngineImplOptions): RoutingEngineImpl {
  const engine = new RoutingEngineImpl(
    options.eventBus,
    options.configSystem ?? null,
    options.adapterRegistry ?? null,
  )

  if (options.monitorAgent != null && options.useMonitorRecommendations === true) {
    engine.setMonitorAgent(options.monitorAgent, true)
  }

  return engine
}
