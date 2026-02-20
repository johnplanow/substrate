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

  /** Bound references for event listener management */
  private readonly _onTaskReady: (payload: { taskId: string }) => void
  private readonly _onTaskComplete: (payload: { taskId: string; result: { tokensUsed?: number } }) => void

  constructor(
    eventBus: TypedEventBus,
    configSystem?: ConfigSystem | null,
    adapterRegistry?: AdapterRegistry | null,
  ) {
    this._eventBus = eventBus
    this._configSystem = configSystem ?? null
    this._adapterRegistry = adapterRegistry ?? null

    this._onTaskReady = ({ taskId }: { taskId: string }) => {
      this._handleTaskReady(taskId)
    }

    this._onTaskComplete = ({ taskId, result }: { taskId: string; result: { tokensUsed?: number } }) => {
      this._handleTaskComplete(taskId, result)
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
  }

  async shutdown(): Promise<void> {
    logger.info('RoutingEngine.shutdown()')
    this._eventBus.off('task:ready', this._onTaskReady)
    this._eventBus.off('task:complete', this._onTaskComplete)
  }

  // ---------------------------------------------------------------------------
  // RoutingEngine interface
  // ---------------------------------------------------------------------------

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
          return makeRoutingDecision(taskId)
            .withAgent(decision.agent, decision.billingMode)
            .withModel(decision.model ?? '')
            .withRationale(`Explicit agent assignment: ${explicitAgent} via ${decision.billingMode}`)
            .withFallbackChain([explicitAgent])
            .build()
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
        return makeRoutingDecision(taskId)
          .withAgent(decision.agent, decision.billingMode)
          .withModel(decision.model ?? '')
          .withRationale(rationale)
          .withFallbackChain(fallbackChain)
          .build()
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

  private _handleTaskReady(taskId: string): void {
    logger.debug({ taskId }, 'task:ready — making routing decision')

    // We need the full task node to route; if adapter registry is available, use it.
    // Otherwise emit a basic routing decision with rationale.
    // In the full orchestrator, the task graph engine provides task details.
    // Here we emit task:routed with whatever info we have.
    //
    // NOTE: Full integration with task graph engine happens in Task 7 (orchestrator wiring).
    // For now, we create a minimal decision so the event is emitted.
    if (this._policy === null) {
      logger.debug({ taskId }, 'No routing policy — emitting minimal routing decision')
      const decision = makeRoutingDecision(taskId)
        .withAgent('', 'unavailable')
        .withRationale('No routing policy configured')
        .build()
      this._eventBus.emit('task:routed', { taskId, decision })
      return
    }

    // Create a minimal task node for routing
    const minimalTask: TaskNode = {
      id: taskId,
      title: '',
      description: '',
      status: 'ready',
      priority: 'normal',
      dependencies: [],
      metadata: {},
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
   */
  private _routeWithoutPolicy(task: TaskNode): RoutingDecision {
    const taskId = task.id

    // If there's an explicit agent, try to use it
    if (task.agentId !== undefined && task.agentId.length > 0) {
      if (this._adapterRegistry !== null) {
        const adapter = this._adapterRegistry.get(task.agentId)
        if (adapter !== undefined) {
          return makeRoutingDecision(taskId)
            .withAgent(task.agentId, 'subscription')
            .withRationale(`No routing policy: using explicit agent ${task.agentId}`)
            .build()
        }
      }
    }

    // Try first available adapter
    if (this._adapterRegistry !== null) {
      const adapters = this._adapterRegistry.getAll()
      if (adapters.length > 0) {
        const adapter = adapters[0]!
        return makeRoutingDecision(taskId)
          .withAgent(adapter.id, 'subscription')
          .withRationale(`No routing policy: using first available adapter ${adapter.id}`)
          .build()
      }
    }

    return makeRoutingDecision(taskId)
      .unavailable('No routing policy configured and no adapters available')
      .build()
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
}

export function createRoutingEngineImpl(options: RoutingEngineImplOptions): RoutingEngineImpl {
  return new RoutingEngineImpl(
    options.eventBus,
    options.configSystem ?? null,
    options.adapterRegistry ?? null,
  )
}
