/**
 * GitManager — interface and stub for git worktree management.
 *
 * The full implementation will be provided by a later story.
 * This stub subscribes to worktree events and satisfies the BaseService
 * lifecycle contract.
 *
 * Event subscriptions (Architecture Section 19):
 *  - Listens to worktree:created, worktree:merged, worktree:conflict, worktree:removed events
 */

import type { BaseService } from '../../core/di.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('git')

// ---------------------------------------------------------------------------
// GitManager interface
// ---------------------------------------------------------------------------

export interface GitManager extends BaseService {
  // Full interface to be expanded in git worktree implementation story
}

// ---------------------------------------------------------------------------
// GitManagerImpl (stub)
// ---------------------------------------------------------------------------

export class GitManagerImpl implements GitManager {
  private readonly _eventBus: TypedEventBus
  readonly repoRoot: string | undefined

  constructor(eventBus: TypedEventBus, repoRoot?: string) {
    this._eventBus = eventBus
    this.repoRoot = repoRoot
  }

  async initialize(): Promise<void> {
    logger.info({ repoRoot: this.repoRoot }, 'GitManager.initialize() — stub')

    // Subscribe to worktree lifecycle events
    this._eventBus.on('worktree:created', ({ taskId, worktreePath, branchName }) => {
      logger.debug({ taskId, worktreePath, branchName }, 'worktree:created')
    })

    this._eventBus.on('worktree:merged', ({ taskId, branch }) => {
      logger.debug({ taskId, branch }, 'worktree:merged')
    })

    this._eventBus.on('worktree:conflict', ({ taskId, conflictingFiles }) => {
      logger.warn({ taskId, conflictingFiles }, 'worktree:conflict')
    })

    this._eventBus.on('worktree:removed', ({ taskId, branchName }) => {
      logger.debug({ taskId, branchName }, 'worktree:removed')
    })
  }

  async shutdown(): Promise<void> {
    logger.info('GitManager.shutdown() — stub')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GitManagerOptions {
  eventBus: TypedEventBus
  repoRoot?: string
}

export function createGitManager(options: GitManagerOptions): GitManager {
  return new GitManagerImpl(options.eventBus, options.repoRoot)
}
