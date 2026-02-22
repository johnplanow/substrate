/**
 * Stop-After Gate Module
 *
 * Provides reusable stop-after gate semantics for the autonomous pipeline.
 * After any phase completes, the orchestrator can evaluate a gate to determine
 * if the pipeline should halt cleanly at that phase boundary.
 *
 * Usage:
 *   import { createStopAfterGate, validateStopAfterFromConflict } from './modules/stop-after/index.js'
 *
 *   const gate = createStopAfterGate('analysis')
 *   if (gate.shouldHalt()) {
 *     const summary = gate.formatCompletionSummary({ ... })
 *     process.stdout.write(summary + '\n')
 *     // orchestrator transitions run state to 'stopped'
 *   }
 */

export type { StopAfterGate } from './gate.js'
export type { PhaseName, CompletionSummaryParams, StopAfterGateParams, ValidationResult } from './types.js'
export { VALID_PHASES, STOP_AFTER_VALID_PHASES } from './types.js'
export { createStopAfterGate, validateStopAfterFromConflict, formatPhaseCompletionSummary } from './gate-impl.js'
