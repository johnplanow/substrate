/**
 * WorkerPoolManager — interface and supporting types for the worker pool.
 *
 * Defines the contract for managing a pool of CLI agent subprocesses.
 */

import type { BaseService } from '../../core/di.js'
import type { Task } from '../../persistence/queries/tasks.js'
import type { WorkerAdapter } from '../../adapters/worker-adapter.js'
import type { WorkerHandle } from './worker-handle.js'

// ---------------------------------------------------------------------------
// WorkerInfo
// ---------------------------------------------------------------------------

/**
 * Snapshot of a single active worker's state.
 */
export interface WorkerInfo {
  /** Unique identifier for this worker instance */
  workerId: string
  /** Task being processed by this worker */
  taskId: string
  /** Adapter id used to spawn the worker */
  adapter: string
  /** Current worker lifecycle status */
  status: 'spawning' | 'running' | 'terminating'
  /** When the worker was started */
  startedAt: Date
  /** Milliseconds elapsed since startedAt */
  elapsedMs: number
}

// ---------------------------------------------------------------------------
// WorkerPoolManager interface
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of CLI agent subprocesses.
 *
 * Responsibilities:
 *  - Spawning worker processes for tasks via CLI adapters
 *  - Tracking active workers in an in-memory pool
 *  - Handling worker completion / failure callbacks
 *  - Terminating workers individually or collectively
 */
export interface WorkerPoolManager extends BaseService {
  /**
   * Spawn a CLI agent subprocess for the given task.
   *
   * @param task         - Full task record (with prompt, agent, etc.)
   * @param adapter      - WorkerAdapter to use for this task
   * @param worktreePath - Working directory for the subprocess
   * @returns The WorkerHandle wrapping the spawned process
   */
  spawnWorker(task: Task, adapter: WorkerAdapter, worktreePath: string): WorkerHandle

  /**
   * Terminate a single worker by ID.
   *
   * @param workerId - The worker to terminate
   * @param reason   - Human-readable reason for termination
   */
  terminateWorker(workerId: string, reason: string): void

  /**
   * Terminate all active workers.
   *
   * Sends SIGTERM to all workers and, after a 5-second grace period,
   * SIGKILLs any that remain. Emits worker:terminated for each.
   */
  terminateAll(): Promise<void>

  /**
   * Return a snapshot list of all active workers.
   */
  getActiveWorkers(): WorkerInfo[]

  /**
   * Return the current count of active workers.
   */
  getWorkerCount(): number

  /**
   * Look up a single worker by ID.
   *
   * @returns WorkerInfo snapshot, or null if not found
   */
  getWorker(workerId: string): WorkerInfo | null
}
