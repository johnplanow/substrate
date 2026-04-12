// src/persistence/queries/eval-results.ts — re-export shim (packages/core)
export {
  writeEvalResult,
  getLatestEvalForRun,
  getEvalsForRun,
  loadEvalPairForComparison,
} from '@substrate-ai/core'
export type { EvalResultRow, CreateEvalResultInput } from '@substrate-ai/core'
