/**
 * SdlcPhaseHandler — wraps SDLC pipeline phase execution as a graph NodeHandler.
 *
 * Story 43-2.
 *
 * Architecture note (ADR-003): This package does not import from @substrate-ai/factory
 * or from the monolith source tree at compile time. All external dependencies
 * (orchestrator, phaseDeps, phase runner functions) are injected via
 * SdlcPhaseHandlerDeps at construction time.
 *
 * TypeScript structural typing ensures the returned SdlcNodeHandler is
 * assignable to NodeHandler from @substrate-ai/factory at the CLI composition
 * root — no sdlc→factory import required.
 */

import type { SdlcPhaseHandlerDeps, SdlcNodeHandler, SdlcOutcome } from './types.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an sdlc.phase node handler.
 *
 * The returned handler:
 *   1. Resolves the phase name from node.id (AC5)
 *   2. Looks up the corresponding runner in the PHASE_RUNNERS map (AC7)
 *   3. Calls the runner with phaseDeps and phase-specific params (AC1, AC2, AC5)
 *   4. On runner error, returns FAILURE without re-throwing (AC3)
 *   5. If advanceAfterRun !== false, calls orchestrator.advancePhase(runId) (AC4)
 *   6. If gate check fails (advanced === false), returns FAILURE with gate messages (AC4)
 *   7. On full success, returns SUCCESS with phase output in contextUpdates (AC1, AC2)
 *
 * @param deps - Injected dependencies: orchestrator, phaseDeps, phase runners.
 * @returns A SdlcNodeHandler ready for registration under the 'sdlc.phase' key.
 */
export function createSdlcPhaseHandler(deps: SdlcPhaseHandlerDeps): SdlcNodeHandler {
  // Build the PHASE_RUNNERS map from the injected phase runner functions.
  // Using a Map allows O(1) lookup and supports the unknown-phase check (AC7).
  const PHASE_RUNNERS = new Map(Object.entries(deps.phases))

  return async (
    node: { id: string; label: string; prompt: string },
    context: { getString(key: string, defaultValue?: string): string },
    _graph: unknown,
  ): Promise<SdlcOutcome> => {
    // AC5: Phase selection is driven by node.id
    const phaseName = node.id

    // AC7: Unknown phase — no runner registered
    const runner = PHASE_RUNNERS.get(phaseName)
    if (runner === undefined) {
      return {
        status: 'FAILURE',
        failureReason: `No phase runner registered for phase: ${phaseName}`,
      }
    }

    // Extract context values
    const runId = context.getString('runId')
    // AC1: concept is only needed for the analysis phase
    const concept = phaseName === 'analysis' ? context.getString('concept', '') : ''

    // Build phase-specific params (analysis requires concept; others only runId)
    const params: Record<string, unknown> =
      phaseName === 'analysis' ? { runId, concept } : { runId }

    // Outer try/catch wraps the entry gate check, runner call, and advancePhase call.
    // This boundary satisfies AC3 (runner error) and also handles the case
    // where evaluateEntryGates or advancePhase itself throws (network/DB error).
    try {
      // Story 43-13 AC1, AC2, AC4: Evaluate entry gates before dispatching runner.
      // evaluateEntryGates is always called regardless of advanceAfterRun flag.
      const entryGateResult = await deps.orchestrator.evaluateEntryGates(runId)
      if (!entryGateResult.passed) {
        const failures =
          entryGateResult.failures
            ?.map((f) => `${f.gate}: ${f.error}`)
            .join('; ') ?? 'no details'
        return { status: 'FAILURE', failureReason: `entry gate failed: ${failures}` }
      }

      // AC1, AC2, AC5: Dispatch to the registered phase runner
      const phaseOutput = await runner(deps.phaseDeps, params)

      // AC4: Advance phase unless the caller has disabled it
      if (deps.advanceAfterRun !== false) {
        const advanceResult = await deps.orchestrator.advancePhase(runId)

        if (!advanceResult.advanced) {
          // Story 43-13 AC3, AC4: Exit gate failure — prefix with 'exit gate failed: '
          const failures =
            advanceResult.gateFailures
              ?.map((f) => `${f.gate}: ${f.error}`)
              .join('; ') ?? 'no details'
          return { status: 'FAILURE', failureReason: `exit gate failed: ${failures}` }
        }

        // AC1, AC2: Full success — include phase output and advanced phase name
        return {
          status: 'SUCCESS',
          contextUpdates: { ...phaseOutput, advancedPhase: advanceResult.phase },
        }
      }

      // advanceAfterRun === false: return success without advancing
      return {
        status: 'SUCCESS',
        contextUpdates: phaseOutput,
      }
    } catch (err) {
      // AC3: runner threw, or evaluateEntryGates/advancePhase threw unexpectedly
      const message = err instanceof Error ? err.message : String(err)
      return { status: 'FAILURE', failureReason: message }
    }
  }
}
