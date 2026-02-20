/**
 * WorkerManager — interface and stub for managing worker subprocesses.
 *
 * The full implementation will be provided by a later story.
 * This stub subscribes to task:started and task:complete events and
 * satisfies the BaseService lifecycle contract.
 *
 * Event subscriptions (Architecture Section 19):
 *  - Listens to task:started events to spawn workers
 *  - Listens to task:complete events to clean up workers
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('worker')

// ---------------------------------------------------------------------------
// WorkerManager interface
// ---------------------------------------------------------------------------

export interface WorkerManager extends BaseService {
  // Full interface to be expanded in worker pool implementation story
}

// ---------------------------------------------------------------------------
// WorkerManagerImpl (stub)
// ---------------------------------------------------------------------------

export class WorkerManagerImpl implements WorkerManager {
  private readonly _eventBus: TypedEventBus

  constructor(eventBus: TypedEventBus) {
    this._eventBus = eventBus
  }

  async initialize(): Promise<void> {
    logger.info('WorkerManager.initialize() — stub')

    // Subscribe to task lifecycle events for worker management
    this._eventBus.on('task:started', ({ taskId, workerId, agent }) => {
      logger.debug({ taskId, workerId, agent }, 'task:started — worker spawn needed')
    })

    this._eventBus.on('task:complete', ({ taskId }) => {
      logger.debug({ taskId }, 'task:complete — clean up worker')
    })

    this._eventBus.on('task:failed', ({ taskId }) => {
      logger.debug({ taskId }, 'task:failed — clean up worker')
    })

    this._eventBus.on('task:cancelled', ({ taskId }) => {
      logger.debug({ taskId }, 'task:cancelled — terminate worker')
    })
  }

  async shutdown(): Promise<void> {
    logger.info('WorkerManager.shutdown() — stub')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface WorkerManagerOptions {
  eventBus: TypedEventBus
}

export function createWorkerManager(options: WorkerManagerOptions): WorkerManager {
  return new WorkerManagerImpl(options.eventBus)
}
