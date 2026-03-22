// src/persistence/queries/amendments.ts — re-export shim (migrated to packages/core in story 41-3)
export {
  createAmendmentRun,
  loadParentRunDecisions,
  supersedeDecision,
  getActiveDecisions,
  getAmendmentRunChain,
  getLatestCompletedRun,
} from '@substrate-ai/core'
export type {
  CreateAmendmentRunInput,
  ActiveDecisionsFilter,
  SupersessionEvent,
  AmendmentChainEntry,
} from '@substrate-ai/core'
