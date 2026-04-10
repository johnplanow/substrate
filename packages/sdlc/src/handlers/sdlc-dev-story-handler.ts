/**
 * SdlcDevStoryHandler — wraps the runDevStory compiled workflow
 * as a graph NodeHandler for sdlc.dev-story nodes.
 *
 * Story 43-4.
 *
 * Architecture note (ADR-003): The SDLC package does not compile-time-depend on
 * @substrate-ai/factory to avoid circular references. Compatible types are
 * defined locally using TypeScript structural typing — they are assignable to
 * the factory types when the CLI composition root wires them together at runtime.
 */

import { readFileSync } from 'node:fs'
import type { TypedEventBus, DatabaseAdapter } from '@substrate-ai/core'
import type { SdlcEvents } from '../events.js'
import { classifyAndPersist } from '../learning/finding-classifier.js'
import type { StoryFailureContext } from '../learning/types.js'
import {
  FindingsInjector,
  extractTargetFilesFromStoryContent,
} from '../learning/findings-injector.js'
import type { InjectionContext } from '../learning/relevance-scorer.js'
import { FindingLifecycleManager } from '../learning/finding-lifecycle.js'
import type { SuccessContext } from '../learning/finding-lifecycle.js'
import { DispatchGate } from '../gating/dispatch-gate.js'
import type { DispatchGateOptions } from '../gating/types.js'

// ---------------------------------------------------------------------------
// Local structural types — compatible with @substrate-ai/factory via duck typing
// ---------------------------------------------------------------------------

/** Minimal GraphNode interface needed by this handler. */
interface GraphNode {
  id: string
  [key: string]: unknown
}

/** Minimal Graph type — not used by this handler but required for NodeHandler signature. */
type Graph = object

/** Minimal IGraphContext interface needed by this handler. */
interface IGraphContext {
  getString(key: string, defaultValue?: string): string
  getList?(key: string): string[]
  get?(key: string): unknown
  set?(key: string, value: unknown): void
}

/** Terminal status values for handler outcomes. */
type OutcomeStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'

/** Structured result returned by every node handler. */
interface Outcome {
  status: OutcomeStatus
  contextUpdates?: Record<string, unknown>
  failureReason?: string
  notes?: string
}

/** NodeHandler function signature — matches @substrate-ai/factory NodeHandler type. */
type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>

// ---------------------------------------------------------------------------
// DevStory workflow types (local minimal definitions)
// Matches DevStoryParams and DevStoryResult in src/modules/compiled-workflows/types.ts
// ---------------------------------------------------------------------------

/** Parameters for the dev-story compiled workflow. */
export interface DevStoryParams {
  storyKey: string
  storyFilePath: string
  pipelineRunId?: string
  priorFiles?: string[]
  taskScope?: string
  /** Learning loop findings prompt — prepended to story context for the agent (Story 53-8). */
  findingsPrompt?: string
}

/** Result from the dev-story compiled workflow. */
export interface DevStoryResult {
  result: 'success' | 'failed'
  ac_met: string[]
  ac_failures: string[]
  files_modified: string[]
  tests: 'pass' | 'fail'
  notes?: string
  error?: string
}

/** Injectable function type for the runDevStory workflow. */
export type RunDevStoryFn = (deps: unknown, params: DevStoryParams) => Promise<DevStoryResult>

// ---------------------------------------------------------------------------
// Handler options
// ---------------------------------------------------------------------------

/**
 * Configuration options for the sdlc.dev-story handler factory.
 *
 * The `deps` field is typed as `unknown` because WorkflowDeps is defined in the
 * monolith (src/modules/compiled-workflows/types.ts) — passing it as unknown avoids
 * a packages→monolith compile-time coupling. The CLI composition root injects the
 * concrete WorkflowDeps instance at runtime.
 *
 * The `runDevStory` field allows test injection of a mock — preferred per story
 * dev notes for testability. At runtime, the CLI composition root injects the real
 * runDevStory from src/modules/compiled-workflows/dev-story.ts.
 */
/** Result of a build verification check (injectable). */
export interface BuildVerifyResult {
  status: 'passed' | 'failed' | 'timeout' | 'skipped'
  output?: string
}

/** Injectable build verification function. */
export type BuildVerifierFn = (projectRoot: string) => BuildVerifyResult

export interface SdlcDevStoryHandlerOptions {
  /** Workflow dependencies — passed through as-is to runDevStory. */
  deps: unknown
  /** SDLC event bus for telemetry events. */
  eventBus: TypedEventBus<SdlcEvents>
  /** Compiled workflow function — injectable for testing. */
  runDevStory: RunDevStoryFn
  /**
   * Optional build verification to run after a successful dev-story.
   * Injected by the CLI composition root — runs `npm run build` + `tsc --noEmit`
   * to catch compile errors before code-review wastes a review cycle.
   * If omitted, no build verification is performed (backward-compatible).
   */
  buildVerifier?: BuildVerifierFn
  /**
   * Optional database adapter for the learning loop (Story 53-8).
   * When provided, enables finding capture on failure, findings injection before
   * dispatch, and finding retirement on success.
   * When null or omitted, all learning calls are skipped gracefully.
   */
  db?: DatabaseAdapter | null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an sdlc.dev-story node handler.
 *
 * The returned handler:
 *   1. Validates storyKey and storyFilePath are present in GraphContext (AC6)
 *   2. Reads optional retry remediation context from prior iteration (AC4)
 *   3. Injects relevant prior-run findings into dispatch params (Story 53-8 AC2)
 *   4. Emits orchestrator:story-phase-start telemetry (AC5)
 *   5. Delegates to runDevStory(deps, params) (AC1)
 *   6. Emits orchestrator:story-phase-complete telemetry in finally block (AC5)
 *   7. Maps the DevStoryResult to an Outcome (AC2, AC3)
 *   8. On failure: classifyAndPersist + emit pipeline:finding-captured (Story 53-8 AC1, AC6)
 *   9. On success: retireContradictedFindings (Story 53-8 AC4)
 *
 * @param options - Handler configuration.
 * @returns A NodeHandler function ready for registration under the 'sdlc.dev-story' key.
 */
export function createSdlcDevStoryHandler(options: SdlcDevStoryHandlerOptions): NodeHandler {
  return async (_node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // AC6: Validate required context keys before calling runDevStory
    const storyKey = context.getString('storyKey', '')
    const storyFilePath = context.getString('storyFilePath', '')

    if (!storyKey || !storyFilePath) {
      const missingFields = [!storyKey && 'storyKey', !storyFilePath && 'storyFilePath'].filter(
        Boolean
      )
      return {
        status: 'FAILURE',
        failureReason: `Missing required context: ${missingFields.join(', ')}`,
      }
    }

    // AC1: Extract optional pipelineRunId — omit key when absent
    // (exactOptionalPropertyTypes requires optional fields to be absent, not undefined)
    const pipelineRunIdRaw = context.getString('pipelineRunId', '')

    // AC4: Read prior iteration remediation context from context
    const priorFiles = context.getList?.('devStoryFilesModified') ?? []
    const priorAcFailures = context.getList?.('devStoryAcFailures') ?? []

    // ---------------------------------------------------------------------------
    // Read story content (used for findings injection and dispatch gating)
    // ---------------------------------------------------------------------------
    let storyContent = ''
    try {
      storyContent = readFileSync(storyFilePath, 'utf-8')
    } catch {
      // Non-fatal: if file can't be read, use empty content
    }

    // ---------------------------------------------------------------------------
    // Story 53-8 AC2: Pre-dispatch findings injection
    // ---------------------------------------------------------------------------
    let findingsPrompt = ''
    if (options.db != null) {
      try {
        // Infer packageName from storyKey prefix (e.g., '53-8' → no package, or from path)
        const pkgMatch = /packages\/([^/]+)\//.exec(storyFilePath)
        const packageName = pkgMatch?.[1]

        const injectionCtx: InjectionContext = {
          storyKey,
          runId: pipelineRunIdRaw !== '' ? pipelineRunIdRaw : 'unknown',
          targetFiles: extractTargetFilesFromStoryContent(storyContent),
          ...(packageName !== undefined ? { packageName } : {}),
        }

        findingsPrompt = await FindingsInjector.inject(options.db, injectionCtx)
      } catch {
        // AC5: Non-fatal — DB errors must never block dispatch
        console.warn(
          '[sdlc-dev-story-handler] FindingsInjector.inject failed; proceeding without findings'
        )
        findingsPrompt = ''
      }
    }

    // ---------------------------------------------------------------------------
    // Story 53-9: Dispatch pre-condition gating
    // Runs after findings injection, before agent dispatch.
    // Non-fatal: any gate error is caught and dispatch proceeds normally.
    // ---------------------------------------------------------------------------
    if (options.db != null) {
      try {
        const pendingFiles = extractTargetFilesFromStoryContent(storyContent)

        const gateOptions: DispatchGateOptions = {
          storyKey,
          storyContent,
          pendingFiles,
          // completedStories: populated from run manifest per_story_state.
          // Currently no modifiedFiles tracked in manifest — empty array is
          // correct (gate degrades gracefully per AC7). Learning pre-emption
          // (AC6) still functions via the DB query path.
          completedStories: [],
          db: options.db,
          projectRoot: process.cwd(),
        }

        const gateResult = await DispatchGate.check(gateOptions)

        if (
          gateResult.decision === 'warn' &&
          gateResult.overlappingFiles !== undefined &&
          gateResult.completedStoryKey !== undefined
        ) {
          // AC2: emit warning event; dispatch proceeds normally
          options.eventBus.emit('pipeline:dispatch-warn', {
            storyKey,
            completedStoryKey: gateResult.completedStoryKey,
            overlappingFiles: gateResult.overlappingFiles,
          })
        } else if (gateResult.decision === 'block' && gateResult.modifiedPrompt !== undefined) {
          // AC4: auto-resolved; extract extension note from modifiedPrompt and inject
          // into findingsPrompt so the agent receives the namespace extension guidance.
          // modifiedPrompt = storyContent + '\n\n' + extensionNote
          const extensionNote = gateResult.modifiedPrompt.slice(storyContent.length).trim()
          if (extensionNote.length > 0) {
            findingsPrompt =
              findingsPrompt !== '' ? `${findingsPrompt}\n\n${extensionNote}` : extensionNote
          }
        } else if (gateResult.decision === 'gated') {
          // AC5: non-resolvable conflict; place story in gated phase
          options.eventBus.emit('pipeline:story-gated', {
            storyKey,
            conflictType: gateResult.conflictType ?? 'namespace-collision',
            reason: gateResult.reason ?? 'dispatch gate: non-resolvable conflict',
            ...(gateResult.completedStoryKey !== undefined
              ? { completedStoryKey: gateResult.completedStoryKey }
              : {}),
          })
          // Return early without dispatching — story stays in gated phase
          return {
            status: 'FAILURE',
            failureReason:
              gateResult.reason ?? 'dispatch gate: story gated — operator review required',
          }
        }
      } catch {
        // AC7: gate error must never block dispatch
        console.debug(
          '[sdlc-dev-story-handler] DispatchGate.check failed; proceeding with original dispatch'
        )
      }
    }

    // Build DevStoryParams with required + optional fields
    const devStoryParams: DevStoryParams = {
      storyKey,
      storyFilePath,
      ...(pipelineRunIdRaw !== '' ? { pipelineRunId: pipelineRunIdRaw } : {}),
      // AC4: Pass accumulated modified files from prior iteration as priorFiles
      ...(priorFiles.length > 0 ? { priorFiles } : {}),
      // AC4: Construct taskScope note describing prior failures if present
      ...(priorAcFailures.length > 0
        ? { taskScope: `Prior attempt failed ACs: ${priorAcFailures.join(', ')}` }
        : {}),
      // Story 53-8 AC2 + Story 53-9 AC4: findings + gate extension note (if any)
      ...(findingsPrompt !== '' ? { findingsPrompt } : {}),
    }

    // AC5: Emit phase-start telemetry before calling runDevStory
    options.eventBus.emit('orchestrator:story-phase-start', {
      storyKey,
      phase: 'dev-story',
      ...(pipelineRunIdRaw !== '' ? { pipelineRunId: pipelineRunIdRaw } : {}),
    })

    // Initialize outcome to a default so finally block always has a valid status
    let outcome: Outcome = {
      status: 'FAILURE',
      failureReason: 'unexpected error in dev-story handler',
    }

    try {
      // AC1: Delegate to runDevStory
      const workflowResult = await options.runDevStory(options.deps, devStoryParams)

      if (workflowResult.result === 'success') {
        // Build verification gate: catch compile errors before code-review
        if (options.buildVerifier) {
          const projectRoot = context.getString('projectRoot', '')
          if (projectRoot) {
            const buildResult = options.buildVerifier(projectRoot)
            if (buildResult.status === 'failed' || buildResult.status === 'timeout') {
              outcome = {
                status: 'FAILURE',
                failureReason: `build verification failed after dev-story: ${buildResult.output?.slice(0, 500) ?? 'no output'}`,
                contextUpdates: {
                  filesModified: workflowResult.files_modified,
                  devStoryFilesModified: workflowResult.files_modified,
                  devStoryAcFailures: ['build-verification'],
                },
              }
              return outcome
            }
          }
        }

        // AC2: Map success result to SUCCESS Outcome with implementation artifacts
        outcome = {
          status: 'SUCCESS',
          contextUpdates: {
            filesModified: workflowResult.files_modified,
            acMet: workflowResult.ac_met,
            // Persist for retry pass-through (AC4)
            devStoryFilesModified: workflowResult.files_modified,
          },
        }

        // ---------------------------------------------------------------------------
        // Story 53-8 AC4: Retire contradicted findings on success
        // ---------------------------------------------------------------------------
        if (options.db != null) {
          const successCtx: SuccessContext = {
            modifiedFiles: workflowResult.files_modified,
            runId: pipelineRunIdRaw !== '' ? pipelineRunIdRaw : 'unknown',
          }
          try {
            await FindingLifecycleManager.retireContradictedFindings(successCtx, options.db)
          } catch {
            // AC5: Non-fatal — DB errors must never block success outcome
            console.warn('[sdlc-dev-story-handler] retireContradictedFindings failed; continuing')
          }
        }
      } else {
        // AC3: Map failure result to FAILURE Outcome with remediation context
        const failureReason =
          workflowResult.error ??
          (workflowResult.ac_failures.length > 0
            ? `dev-story failed ACs: ${workflowResult.ac_failures.join(', ')}`
            : 'dev-story workflow failed')

        outcome = {
          status: 'FAILURE',
          failureReason,
          contextUpdates: {
            acFailures: workflowResult.ac_failures,
            filesModified: workflowResult.files_modified,
            // Persist for retry pass-through (AC4)
            devStoryFilesModified: workflowResult.files_modified,
            devStoryAcFailures: workflowResult.ac_failures,
          },
        }

        // ---------------------------------------------------------------------------
        // Story 53-8 AC1: Classify and persist failure finding
        // ---------------------------------------------------------------------------
        if (options.db != null) {
          const failureCtx: StoryFailureContext = {
            storyKey,
            runId: pipelineRunIdRaw !== '' ? pipelineRunIdRaw : 'unknown',
            // exactOptionalPropertyTypes: omit 'error' when undefined rather than set to undefined
            ...(workflowResult.error !== undefined ? { error: workflowResult.error } : {}),
            affectedFiles: workflowResult.files_modified,
            buildFailed: workflowResult.ac_failures.includes('build-verification'),
            testsFailed: workflowResult.tests === 'fail',
          }
          try {
            const finding = await classifyAndPersist(failureCtx, options.db)

            // AC6: Emit pipeline:finding-captured after successful persist
            options.eventBus.emit('pipeline:finding-captured', {
              storyKey,
              runId: failureCtx.runId,
              rootCause: finding.root_cause,
            })
          } catch {
            // AC5: Non-fatal — DB errors must never block failure outcome
            console.warn('[sdlc-dev-story-handler] classifyAndPersist failed; continuing')
          }
        }
      }
    } catch (err) {
      // Handle unexpected throws from runDevStory
      const failureReason = err instanceof Error ? err.message : String(err)
      outcome = { status: 'FAILURE', failureReason }
    } finally {
      // AC5: Emit phase-complete in finally block — guaranteed even on throw
      options.eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'dev-story',
        result: { status: outcome.status },
        ...(pipelineRunIdRaw !== '' ? { pipelineRunId: pipelineRunIdRaw } : {}),
      })
    }

    return outcome
  }
}
