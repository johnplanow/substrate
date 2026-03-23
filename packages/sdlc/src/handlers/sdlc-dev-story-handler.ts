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

import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '../events.js'

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
 *   3. Emits orchestrator:story-phase-start telemetry (AC5)
 *   4. Delegates to runDevStory(deps, params) (AC1)
 *   5. Emits orchestrator:story-phase-complete telemetry in finally block (AC5)
 *   6. Maps the DevStoryResult to an Outcome (AC2, AC3)
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
      const missingFields = [
        !storyKey && 'storyKey',
        !storyFilePath && 'storyFilePath',
      ].filter(Boolean)
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
    }

    // AC5: Emit phase-start telemetry before calling runDevStory
    options.eventBus.emit('orchestrator:story-phase-start', {
      storyKey,
      phase: 'dev-story',
      ...(pipelineRunIdRaw !== '' ? { pipelineRunId: pipelineRunIdRaw } : {}),
    })

    // Initialize outcome to a default so finally block always has a valid status
    let outcome: Outcome = { status: 'FAILURE', failureReason: 'unexpected error in dev-story handler' }

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
