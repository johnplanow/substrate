/**
 * Worker Pool module — barrel exports
 *
 * Re-exports the WorkerPoolManager interface, WorkerInfo type,
 * WorkerHandle class, and the WorkerPoolManagerImpl with its factory.
 */

export type { WorkerPoolManager, WorkerInfo } from './worker-pool-manager.js'
export { WorkerHandle } from './worker-handle.js'
export type { WorkerCompleteCallback, WorkerErrorCallback } from './worker-handle.js'
export {
  WorkerPoolManagerImpl,
  createWorkerPoolManager,
} from './worker-pool-manager-impl.js'
export type { WorkerPoolManagerOptions } from './worker-pool-manager-impl.js'
