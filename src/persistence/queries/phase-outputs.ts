// src/persistence/queries/phase-outputs.ts — re-export shim (packages/core)
export {
  upsertPhaseOutput,
  getRawOutputsByPhaseForRun,
} from '@substrate-ai/core'
export type { PhaseOutput, CreatePhaseOutputInput } from '@substrate-ai/core'
