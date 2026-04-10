// Re-export shim — implementation moved to @substrate-ai/core (story 41-10)
export {
  initializeDolt,
  checkDoltInstalled,
  runDoltCommand,
  DoltNotInstalled,
  DoltInitError,
} from '@substrate-ai/core'
export type { DoltInitConfig } from '@substrate-ai/core'
