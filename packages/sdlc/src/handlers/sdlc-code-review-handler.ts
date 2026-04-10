/**
 * SdlcCodeReviewHandler — wraps the runCodeReview compiled workflow
 * as a graph NodeHandler for sdlc.code-review nodes.
 *
 * Story 43-5.
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
  /**
   * Optional preferred edge label for the graph engine's edge selector.
   * 'SHIP_IT' routes to exit; 'NEEDS_FIXES' routes back to dev_story.
   */
  preferredLabel?: string
}

/** NodeHandler function signature — matches @substrate-ai/factory NodeHandler type. */
type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>

// ---------------------------------------------------------------------------
// CodeReview workflow types (local minimal definitions)
// Matches CodeReviewParams, CodeReviewResult, and CodeReviewIssue in
// src/modules/compiled-workflows/types.ts
// ---------------------------------------------------------------------------

/**
 * A single issue from a code review.
 * Using optional fields to be compatible with both the monolith's CodeReviewIssue
 * (required severity/description) and the looser previousIssues shape in CodeReviewParams.
 */
export interface CodeReviewIssue {
  severity?: string
  description?: string
  file?: string
  line?: number
}

/** Parameters for the code-review compiled workflow. */
export interface CodeReviewParams {
  storyKey: string
  storyFilePath: string
  pipelineRunId?: string
  filesModified?: string[]
  previousIssues?: CodeReviewIssue[]
}

/** Result from the code-review compiled workflow. */
export interface CodeReviewResult {
  verdict: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' | 'LGTM_WITH_NOTES'
  issues: number
  issue_list: CodeReviewIssue[]
  error?: string
  dispatchFailed?: boolean
  tokenUsage: { input: number; output: number }
}

/** Injectable function type for the runCodeReview workflow. */
export type RunCodeReviewFn = (deps: unknown, params: CodeReviewParams) => Promise<CodeReviewResult>

// ---------------------------------------------------------------------------
// Handler options
// ---------------------------------------------------------------------------

/**
 * Configuration options for the sdlc.code-review handler factory.
 *
 * The `deps` field is typed as `unknown` because WorkflowDeps is defined in the
 * monolith (src/modules/compiled-workflows/types.ts) — passing it as unknown avoids
 * a packages→monolith compile-time coupling. The CLI composition root injects the
 * concrete WorkflowDeps instance at runtime.
 *
 * The `runCodeReview` field allows test injection of a mock — preferred per story
 * dev notes for testability. At runtime, the CLI composition root injects the real
 * runCodeReview from src/modules/compiled-workflows/code-review.ts.
 */
export interface SdlcCodeReviewHandlerOptions {
  /** Workflow dependencies — passed through as-is to runCodeReview. */
  deps: unknown
  /** SDLC event bus for telemetry events. */
  eventBus: TypedEventBus<SdlcEvents>
  /** Compiled workflow function — injectable for testing. */
  runCodeReview: RunCodeReviewFn
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an sdlc.code-review node handler.
 *
 * The returned handler:
 *   1. Validates storyKey and storyFilePath are present in GraphContext (AC4)
 *   2. Reads optional context fields: pipelineRunId, filesModified, codeReviewIssueList (AC5)
 *   3. Emits orchestrator:story-phase-start telemetry (AC6)
 *   4. Delegates to runCodeReview(deps, params)
 *   5. Emits orchestrator:story-phase-complete telemetry in finally block (AC6)
 *   6. Maps the CodeReviewResult verdict to an Outcome (AC1, AC2, AC3)
 *
 * Verdict mapping:
 *   SHIP_IT / LGTM_WITH_NOTES → SUCCESS with preferredLabel: 'SHIP_IT' (AC1)
 *   NEEDS_MINOR_FIXES / NEEDS_MAJOR_REWORK → FAILURE with preferredLabel: 'NEEDS_FIXES' (AC2)
 *   dispatchFailed: true → FAILURE with escalation failureReason, no contextUpdates (AC3)
 *   throws → FAILURE with error message, no contextUpdates
 *
 * @param options - Handler configuration.
 * @returns A NodeHandler function ready for registration under the 'sdlc.code-review' key.
 */
export function createSdlcCodeReviewHandler(options: SdlcCodeReviewHandlerOptions): NodeHandler {
  return async (_node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // AC4: Validate required context keys before calling runCodeReview
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

    // AC5: Extract optional fields
    // pipelineRunId: omit key when absent (exactOptionalPropertyTypes pattern)
    const pipelineRunIdRaw = context.getString('pipelineRunId', '')
    const pipelineRunId = pipelineRunIdRaw !== '' ? pipelineRunIdRaw : undefined

    // filesModified: string[] from context
    const filesModifiedRaw = context.getList?.('filesModified') ?? []
    const filesModified = filesModifiedRaw.length > 0 ? filesModifiedRaw : undefined

    // codeReviewIssueList: complex object array — retrieved via get() not getList()
    const codeReviewIssueListRaw = context.get?.('codeReviewIssueList') as
      | CodeReviewIssue[]
      | undefined
    const previousIssues =
      Array.isArray(codeReviewIssueListRaw) && codeReviewIssueListRaw.length > 0
        ? codeReviewIssueListRaw
        : undefined

    // Build CodeReviewParams with required + optional fields
    const params: CodeReviewParams = {
      storyKey,
      storyFilePath,
      ...(pipelineRunId !== undefined ? { pipelineRunId } : {}),
      ...(filesModified !== undefined ? { filesModified } : {}),
      ...(previousIssues !== undefined ? { previousIssues } : {}),
    }

    // AC6: Emit phase-start telemetry before calling runCodeReview
    options.eventBus.emit('orchestrator:story-phase-start', { storyKey, phase: 'code-review' })

    // Initialize outcome to a default so finally block always has a valid status
    let outcome: Outcome = {
      status: 'FAILURE',
      failureReason: 'unexpected error in code-review handler',
    }
    let codeReviewVerdict: string | undefined

    try {
      // Delegate to runCodeReview
      const result = await options.runCodeReview(options.deps, params)

      // AC3: Short-circuit on dispatch failure → escalation FAILURE, no contextUpdates written
      if (result.dispatchFailed === true) {
        outcome = {
          status: 'FAILURE',
          failureReason: `escalation: code-review dispatch failed: ${result.error ?? 'unknown error'}`,
        }
        return outcome
      }

      // Capture verdict for telemetry
      codeReviewVerdict = result.verdict

      // Context updates written for all non-escalation outcomes (AC1, AC2)
      const contextUpdates: Record<string, unknown> = {
        codeReviewVerdict: result.verdict,
        codeReviewIssues: result.issues,
        codeReviewIssueList: result.issue_list,
      }

      if (result.verdict === 'SHIP_IT' || result.verdict === 'LGTM_WITH_NOTES') {
        // AC1: SHIP_IT or LGTM_WITH_NOTES → SUCCESS with preferredLabel: 'SHIP_IT'
        outcome = {
          status: 'SUCCESS',
          preferredLabel: 'SHIP_IT',
          contextUpdates,
        }
      } else {
        // AC2: NEEDS_MINOR_FIXES or NEEDS_MAJOR_REWORK → FAILURE with preferredLabel: 'NEEDS_FIXES'
        outcome = {
          status: 'FAILURE',
          preferredLabel: 'NEEDS_FIXES',
          failureReason: `${result.verdict}: ${result.issues} issue(s)`,
          contextUpdates,
        }
      }
    } catch (err) {
      // Handle unexpected throws from runCodeReview — no contextUpdates
      const failureReason = err instanceof Error ? err.message : String(err)
      outcome = { status: 'FAILURE', failureReason }
    } finally {
      // AC6: Emit phase-complete in finally block — guaranteed even on throw
      options.eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'code-review',
        result: { status: outcome.status, verdict: codeReviewVerdict },
      })
    }

    return outcome
  }
}
