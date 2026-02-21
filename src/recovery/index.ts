/**
 * Public API for the recovery module.
 *
 * Re-exports CrashRecoveryManager, RecoveryResult, RecoveryAction from crash-recovery.ts
 * and setupGracefulShutdown, ShutdownHandlerOptions from shutdown-handler.ts.
 */

export {
  CrashRecoveryManager,
  type RecoveryResult,
  type RecoveryAction,
  type CrashRecoveryManagerOptions,
} from './crash-recovery.js'

export {
  setupGracefulShutdown,
  type ShutdownHandlerOptions,
} from './shutdown-handler.js'
