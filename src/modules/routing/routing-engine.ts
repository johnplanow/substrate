/**
 * RoutingEngine — interface and stub for task-to-agent routing.
 *
 * The full implementation will be provided by a later story.
 * This stub subscribes to task:ready events and satisfies the BaseService
 * lifecycle contract.
 *
 * Event subscriptions (Architecture Section 19):
 *  - Listens to task:ready events to trigger routing decisions
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('routing')

// ---------------------------------------------------------------------------
// RoutingEngine interface
// ---------------------------------------------------------------------------

export interface RoutingEngine extends BaseService {
  // Full interface to be expanded in routing engine implementation story
}

// ---------------------------------------------------------------------------
// RoutingEngineImpl (stub)
// ---------------------------------------------------------------------------

export class RoutingEngineImpl implements RoutingEngine {
  private readonly _eventBus: TypedEventBus

  constructor(eventBus: TypedEventBus) {
    this._eventBus = eventBus
  }

  async initialize(): Promise<void> {
    logger.info('RoutingEngine.initialize() — stub')

    // Subscribe to task:ready events to make routing decisions
    this._eventBus.on('task:ready', ({ taskId }) => {
      logger.debug({ taskId }, 'task:ready — routing decision needed')
    })
  }

  async shutdown(): Promise<void> {
    logger.info('RoutingEngine.shutdown() — stub')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface RoutingEngineOptions {
  eventBus: TypedEventBus
}

export function createRoutingEngine(options: RoutingEngineOptions): RoutingEngine {
  return new RoutingEngineImpl(options.eventBus)
}
