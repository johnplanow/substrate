/**
 * GitManager — interface and stub for git worktree management.
 *
 * The full implementation will be provided by a later story.
 * This stub subscribes to worktree events and satisfies the IBaseService
 * lifecycle contract.
 *
 * Event subscriptions (Architecture Section 19):
 *  - Listens to worktree:created, worktree:merged, worktree:conflict, worktree:removed events
 */

import type { IBaseService } from '../types.js'
import type { TypedEventBus } from '../events/index.js'
import type { CoreEvents } from '../events/index.js'
import type { ILogger } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// GitManager interface
// ---------------------------------------------------------------------------

export interface GitManager extends IBaseService {
  // Full interface to be expanded in git worktree implementation story
}

// ---------------------------------------------------------------------------
// GitManagerImpl (stub)
// ---------------------------------------------------------------------------

export class GitManagerImpl implements GitManager {
  private readonly _eventBus: TypedEventBus<CoreEvents>
  private readonly _logger: ILogger
  readonly repoRoot: string | undefined

  constructor(eventBus: TypedEventBus<CoreEvents>, repoRoot?: string, logger?: ILogger) {
    this._eventBus = eventBus
    this.repoRoot = repoRoot
    this._logger = logger ?? console
  }

  async initialize(): Promise<void> {
    this._logger.info({ repoRoot: this.repoRoot }, 'GitManager.initialize() — stub')

    // Subscribe to worktree lifecycle events
    this._eventBus.on('worktree:created', ({ taskId, worktreePath, branchName }) => {
      this._logger.debug({ taskId, worktreePath, branchName }, 'worktree:created')
    })

    this._eventBus.on('worktree:merged', ({ taskId, branch }) => {
      this._logger.debug({ taskId, branch }, 'worktree:merged')
    })

    this._eventBus.on('worktree:conflict', ({ taskId, conflictingFiles }) => {
      this._logger.warn({ taskId, conflictingFiles }, 'worktree:conflict')
    })

    this._eventBus.on('worktree:removed', ({ taskId, branchName }) => {
      this._logger.debug({ taskId, branchName }, 'worktree:removed')
    })
  }

  async shutdown(): Promise<void> {
    this._logger.info('GitManager.shutdown() — stub')
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface GitManagerOptions {
  eventBus: TypedEventBus<CoreEvents>
  repoRoot?: string
  logger?: ILogger
}

export function createGitManager(options: GitManagerOptions): GitManager {
  return new GitManagerImpl(options.eventBus, options.repoRoot, options.logger)
}
