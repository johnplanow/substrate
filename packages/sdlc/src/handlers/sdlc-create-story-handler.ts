/**
 * SdlcCreateStoryHandler — wraps the runCreateStory compiled workflow
 * as a graph NodeHandler for sdlc.create-story nodes.
 *
 * Story 43-3.
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
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/** Terminal status values for handler outcomes. */
type OutcomeStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'

/** Structured result returned by every node handler. */
interface Outcome {
  status: OutcomeStatus
  contextUpdates?: Record<string, unknown>
  failureReason?: string
  notes?: string
  error?: unknown
  preferredLabel?: string
  suggestedNextIds?: string[]
}

/** NodeHandler function signature — matches @substrate-ai/factory NodeHandler type. */
export type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>

// ---------------------------------------------------------------------------
// CreateStory workflow types (local minimal definitions)
// Matches CreateStoryParams and CreateStoryResult in src/modules/compiled-workflows/types.ts
// ---------------------------------------------------------------------------

/** Parameters for the create-story compiled workflow. */
export interface CreateStoryParams {
  epicId: string
  storyKey: string
  pipelineRunId?: string
}

/** Result from the create-story compiled workflow. */
export interface CreateStoryResult {
  result: 'success' | 'failed'
  story_file?: string
  story_key?: string
  story_title?: string
  error?: string
  details?: string
  tokenUsage: { input: number; output: number }
}

/** Injectable function type for the runCreateStory workflow. */
export type RunCreateStoryFn = (deps: unknown, params: CreateStoryParams) => Promise<CreateStoryResult>

// ---------------------------------------------------------------------------
// Handler options
// ---------------------------------------------------------------------------

/**
 * Configuration options for the sdlc.create-story handler factory.
 *
 * The `deps` field is typed as `unknown` because WorkflowDeps is defined in the
 * monolith (src/modules/compiled-workflows/types.ts) — passing it as unknown avoids
 * a packages→monolith compile-time coupling. The CLI composition root injects the
 * concrete WorkflowDeps instance at runtime.
 *
 * The `runCreateStory` field allows test injection of a mock — preferred per story
 * dev notes for testability. At runtime, the CLI composition root injects the real
 * runCreateStory from src/modules/compiled-workflows/create-story.ts.
 */
export interface SdlcCreateStoryHandlerOptions {
  /** Workflow dependencies — passed through as-is to runCreateStory. */
  deps: unknown
  /** SDLC event bus for telemetry events. */
  eventBus: TypedEventBus<SdlcEvents>
  /** Compiled workflow function — injectable for testing. */
  runCreateStory: RunCreateStoryFn
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an sdlc.create-story node handler.
 *
 * The returned handler:
 *   1. Validates storyKey and epicId are present in GraphContext (AC5)
 *   2. Emits orchestrator:story-phase-start telemetry (AC4)
 *   3. Delegates to runCreateStory(deps, { epicId, storyKey, pipelineRunId }) (AC1)
 *   4. Emits orchestrator:story-phase-complete telemetry (AC4)
 *   5. Maps the CreateStoryResult to an Outcome (AC2, AC3)
 *
 * @param options - Handler configuration.
 * @returns A NodeHandler function ready for registration under the 'sdlc.create-story' key.
 */
export function createSdlcCreateStoryHandler(options: SdlcCreateStoryHandlerOptions): NodeHandler {
  return async (_node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // AC5: Validate required context keys before calling runCreateStory
    const storyKey = context.getString('storyKey', '')
    if (!storyKey) {
      return { status: 'FAILURE', failureReason: 'storyKey is required in GraphContext' }
    }

    const epicId = context.getString('epicId', '')
    if (!epicId) {
      return { status: 'FAILURE', failureReason: 'epicId is required in GraphContext' }
    }

    // AC1: Extract optional pipelineRunId — build params without explicit undefined
    // (exactOptionalPropertyTypes requires optional fields to be absent, not undefined)
    const pipelineRunIdRaw = context.getString('pipelineRunId', '')
    const createStoryParams: CreateStoryParams = pipelineRunIdRaw !== ''
      ? { epicId, storyKey, pipelineRunId: pipelineRunIdRaw }
      : { epicId, storyKey }

    // AC4: Emit phase-start telemetry before calling runCreateStory
    options.eventBus.emit('orchestrator:story-phase-start', { storyKey, phase: 'create-story' })

    let workflowResult: CreateStoryResult
    try {
      // AC1: Delegate to runCreateStory
      workflowResult = await options.runCreateStory(options.deps, createStoryParams)
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err)
      const errorResult: CreateStoryResult = {
        result: 'failed',
        error: failureReason,
        tokenUsage: { input: 0, output: 0 },
      }
      // AC4: Emit phase-complete telemetry even on unexpected throw
      options.eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'create-story',
        result: errorResult,
      })
      return { status: 'FAILURE', failureReason }
    }

    // AC4: Emit phase-complete telemetry after runCreateStory returns
    options.eventBus.emit('orchestrator:story-phase-complete', {
      storyKey,
      phase: 'create-story',
      result: workflowResult,
    })

    // AC2: Map success result to SUCCESS Outcome
    if (workflowResult.result === 'success') {
      return {
        status: 'SUCCESS',
        contextUpdates: {
          storyFilePath: workflowResult.story_file,
          storyKey: workflowResult.story_key,
          storyTitle: workflowResult.story_title,
        },
      }
    }

    // AC3: Map failure result to FAILURE Outcome
    return {
      status: 'FAILURE',
      failureReason:
        workflowResult.error ?? workflowResult.details ?? 'create-story workflow failed',
    }
  }
}
