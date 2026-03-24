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

    // Story-key skip: when --stories is provided (explicit story dispatch), the linear
    // engine skips analysis/planning/solutioning entirely. Mirror that behavior in the
    // graph engine by checking for storyKey in context — its presence means we're
    // targeting implementation directly and early phases should be skipped.
    const PRE_IMPL_PHASES = ['analysis', 'planning', 'solutioning']
    const storyKey = context.getString('storyKey', '')
    if (storyKey && PRE_IMPL_PHASES.includes(phaseName)) {
      return {
        status: 'SUCCESS',
        notes: `Phase ${phaseName} skipped — explicit story dispatch (storyKey=${storyKey})`,
      }
    }

    // Phase-skip check: if the phase's output artifact already exists (from a prior run or
    // from the linear engine having completed it), skip dispatch and return SUCCESS.
    // This gives the graph engine behavioral parity with the linear engine's detectStartPhase().
    //
    // When skipping, we also register the artifact(s) for the CURRENT pipeline run so that
    // downstream entry gates (which filter by pipeline_run_id) can find them. Without this,
    // the implementation phase's entry gate would fail because it only sees artifacts from
    // the current run.
    const PHASE_ARTIFACT_TYPES: Record<string, string[]> = {
      analysis: ['product-brief'],
      planning: ['prd'],
      solutioning: ['architecture', 'stories'],
    }
    const artifactTypes = PHASE_ARTIFACT_TYPES[phaseName]
    if (artifactTypes !== undefined) {
      try {
        const db = (deps.phaseDeps as { db?: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> } }).db
        if (db) {
          // Check if ALL required artifacts for this phase exist globally
          let allExist = true
          for (const at of artifactTypes) {
            const rows = await db.query(
              'SELECT id, path, content_hash, summary FROM artifacts WHERE phase = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
              [phaseName, at],
            )
            if (!Array.isArray(rows) || rows.length === 0) {
              allExist = false
              break
            }
          }
          if (allExist) {
            // Register each artifact for the current pipeline run so downstream entry gates pass.
            // The pipelineRunId comes from context (set by the graph orchestrator).
            const pipelineRunId = context.getString('pipelineRunId', '')
            if (pipelineRunId) {
              for (const at of artifactTypes) {
                const existing = await db.query(
                  'SELECT id, path, content_hash, summary FROM artifacts WHERE phase = ? AND type = ? ORDER BY created_at DESC LIMIT 1',
                  [phaseName, at],
                ) as Array<{ id: string; path: string; content_hash?: string; summary?: string }>
                const src = existing[0] as { path: string; content_hash?: string; summary?: string } | undefined
                if (src) {
                  // Check if we've already registered this for the current run
                  const alreadyRegistered = await db.query(
                    'SELECT id FROM artifacts WHERE pipeline_run_id = ? AND phase = ? AND type = ? LIMIT 1',
                    [pipelineRunId, phaseName, at],
                  )
                  if (!Array.isArray(alreadyRegistered) || alreadyRegistered.length === 0) {
                    const newId = crypto.randomUUID()
                    await db.query(
                      'INSERT INTO artifacts (id, pipeline_run_id, phase, type, path, content_hash, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
                      [newId, pipelineRunId, phaseName, at, src.path, src.content_hash ?? null, src.summary ?? null],
                    )
                  }
                }
              }
            }
            return {
              status: 'SUCCESS',
              notes: `Phase ${phaseName} already complete — artifact(s) exist, skipping dispatch`,
            }
          }
        }
      } catch {
        // DB query failed — proceed with normal dispatch (don't block on skip check failure)
      }
    }

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
