/**
 * Recovery Engine — Phase D Story 54-1 (2026-04-05 original spec).
 *
 * Consumes Decision Router halt decisions and applies tiered recovery actions
 * based on root-cause classification and retry budget:
 *
 *   Tier A: auto-retry-with-context — inject diagnosis + findings into retry prompt
 *   Tier B: re-scope proposal — append Proposal to RunManifest.pending_proposals
 *   Tier C: halt — emit halt event for orchestrator / Decision Router
 *
 * Related context:
 *   - Epic 70: cross-story-race-recovery (similar tier-A pattern for race recovery)
 *   - Epic 72: Decision Router that Recovery Engine consumes (72-1, 72-2)
 *   - Story 73-2: implements the Tier C interactive prompt used on halt
 *
 * Canonical helper discipline (Story 69-2 / 71-2 / 72-x — 4 prior incidents):
 *   - All manifest reads/writes via RunManifest class
 *   - Never read/write manifest JSON directly
 *   - Never introduce new aggregate manifest formats
 */

import type { TypedEventBus, DatabaseAdapter } from '@substrate-ai/core'
import type { SdlcEvents, RunManifest } from '@substrate-ai/sdlc'
import { createLogger } from '../../utils/logger.js'
import { randomUUID } from 'node:crypto'
import { WorkGraphRepository } from '../state/work-graph-repository.js'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = createLogger('recovery-engine')

// ---------------------------------------------------------------------------
// Root cause classification maps
// ---------------------------------------------------------------------------

/**
 * Root causes that map to Tier A (auto-retry) when retry budget is available.
 * Transient failures that can be resolved by re-dispatching with additional context.
 */
const RETRY_ROOT_CAUSES = new Set([
  'build-failure',
  'test-coverage-gap',
  'ac-missing-evidence',
  'missing-import',
])

/**
 * Root causes that always map to Tier B (re-scope proposal) regardless of budget.
 * Structural failures that cannot be resolved by retrying the same approach.
 */
const PROPOSE_ROOT_CAUSES = new Set([
  'scope-violation',
  'fundamental-design-error',
  'cross-story-contract-mismatch',
])

/**
 * Root causes that map to Tier C (halt) — requires operator intervention.
 */
const HALT_ROOT_CAUSES = new Set([
  'halt-policy',
  'irreversible',
  'security-violation',
  'data-loss-risk',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Failure information passed to the Recovery Engine.
 */
export interface RecoveryFailure {
  /** Root cause classification (e.g. 'build-failure', 'scope-violation'). */
  rootCause: string
  /** Raw findings from the verification summary. */
  findings?: unknown[]
  /** Narrative diagnosis text to prepend to the retry prompt (Tier A). */
  diagnosis?: string
}

/**
 * Retry budget for the current story.
 */
export interface RecoveryBudget {
  /** Remaining retry attempts. 0 = budget exhausted. */
  remaining: number
  /** Maximum retry attempts configured for this run. */
  max: number
}

/**
 * Input for `runRecoveryEngine`.
 * Modelled on StaleVerificationRecoveryInput from cross-story-race-recovery.ts (Epic 70).
 */
export interface RecoveryEngineInput {
  /** Run ID for event emission and manifest access. */
  runId: string
  /** Story key that failed. */
  storyKey: string
  /** Failure information (root cause, findings, diagnosis). */
  failure: RecoveryFailure
  /** Retry budget for the current story. */
  budget: RecoveryBudget
  /** Typed event bus for emitting recovery lifecycle events. */
  bus: TypedEventBus<SdlcEvents>
  /** RunManifest instance for state reads and writes. */
  manifest: RunManifest
  /**
   * Database adapter for Dolt persistence and work-graph dependency queries.
   * Used by back-pressure logic to query story_dependencies.
   */
  adapter: DatabaseAdapter
  /**
   * Engine mode — 'linear' disables work-graph dependency resolution and pauses
   * all pending dispatches when >= 2 proposals exist.
   */
  engine?: 'linear' | 'graph'
  /**
   * Keys of stories still pending/dispatched at the time of recovery invocation.
   * Used by back-pressure logic to compute pause/continue sets.
   */
  pendingStoryKeys?: string[]
}

/**
 * Discriminated result union returned by `runRecoveryEngine`.
 * The orchestrator reads this result and acts accordingly (AC9).
 */
export type RecoveryEngineResult =
  | {
      /** Tier A: re-dispatch with enriched prompt. */
      action: 'retry'
      attempt: number
      retryBudgetRemaining: number
      /** Enriched prompt with diagnosis + findings prepended (ready for dispatcher). */
      enrichedPrompt?: string
    }
  | {
      /** Tier B: re-scope proposal appended. Apply back-pressure. */
      action: 'propose'
      storyKey: string
      pendingProposalsCount: number
      /** Story keys whose dispatch should be paused (depend on a proposed story). */
      pause?: string[]
      /** Story keys that can continue (independent of proposed stories). */
      continue?: string[]
      /** When true (linear mode): pause ALL remaining dispatches. */
      pauseAll?: boolean
    }
  | {
      /** Tier C: operator intervention required (Decision Router / Story 73-2 prompt). */
      action: 'halt'
    }
  | {
      /** Safety valve: >= 5 proposals — halt the entire run (exit 1). */
      action: 'halt-entire-run'
      pendingProposalsCount: number
    }

// ---------------------------------------------------------------------------
// classifyRecoveryAction — pure function, no I/O (AC1)
// ---------------------------------------------------------------------------

/**
 * Classify a failure into a recovery action tier.
 *
 * Pure function — no imports from I/O modules, no side effects.
 * The action handler (`runRecoveryEngine`) owns all I/O.
 *
 * Classification rules:
 *   1. HALT root causes → 'halt' always
 *   2. PROPOSE root causes → 'propose' always (structural, not retry-able)
 *   3. RETRY root causes:
 *      - budget.remaining > 0 → 'retry'
 *      - budget.remaining <= 0 → 'propose' (exhausted, escalate)
 *   4. Unknown root cause → 'propose' (safe default)
 *
 * @param failure - Failure with rootCause field
 * @param budget  - Retry budget with remaining count
 * @returns 'retry' | 'propose' | 'halt'
 */
export function classifyRecoveryAction(
  failure: Pick<RecoveryFailure, 'rootCause'>,
  budget: RecoveryBudget,
): 'retry' | 'propose' | 'halt' {
  const { rootCause } = failure

  // Tier C: operator intervention required — halt always
  if (HALT_ROOT_CAUSES.has(rootCause) || rootCause.startsWith('halt-')) {
    return 'halt'
  }

  // Tier B: structural failures — always propose regardless of budget
  if (PROPOSE_ROOT_CAUSES.has(rootCause)) {
    return 'propose'
  }

  // Tier A: transient failures — retry if budget available
  if (RETRY_ROOT_CAUSES.has(rootCause)) {
    if (budget.remaining > 0) {
      return 'retry'
    }
    // Budget exhausted — escalate to Tier B
    return 'propose'
  }

  // Unknown root cause — safe default is propose (human should review)
  return 'propose'
}

// ---------------------------------------------------------------------------
// Back-pressure helpers
// ---------------------------------------------------------------------------

/**
 * Query work-graph dependency edges to find stories that depend on any
 * proposed story. Used for Tier B back-pressure when NOT in linear mode.
 *
 * @param proposedStoryKeys - Story keys currently in pending_proposals
 * @param pendingStoryKeys  - Story keys still pending / dispatching
 * @param adapter           - DatabaseAdapter for wg_stories / story_dependencies
 * @returns { pause: string[], continue: string[] }
 */
async function computeDependencyAwarePause(
  proposedStoryKeys: string[],
  pendingStoryKeys: string[],
  adapter: DatabaseAdapter,
): Promise<{ pause: string[]; continue: string[] }> {
  if (pendingStoryKeys.length === 0) {
    return { pause: [], continue: [] }
  }

  try {
    // Query all blocking dependency edges via canonical WorkGraphRepository (AC7)
    const wgRepo = new WorkGraphRepository(adapter)
    const deps = await wgRepo.getDependencyEdges()

    const proposedSet = new Set(proposedStoryKeys)

    // A pending story should be paused if any of its blockers are proposed
    const pause: string[] = []
    const continueKeys: string[] = []

    for (const pendingKey of pendingStoryKeys) {
      const blockers = deps
        .filter((d) => d.story_key === pendingKey)
        .map((d) => d.depends_on)

      const isBlocked = blockers.some((b) => proposedSet.has(b))
      if (isBlocked) {
        pause.push(pendingKey)
      } else {
        continueKeys.push(pendingKey)
      }
    }

    return { pause, continue: continueKeys }
  } catch (err) {
    // Dependency query failed — fall back to pausing all (safe)
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Work-graph dependency query failed — falling back to pause-all for back-pressure',
    )
    return { pause: pendingStoryKeys, continue: [] }
  }
}

// ---------------------------------------------------------------------------
// runRecoveryEngine — action handler (AC1)
// ---------------------------------------------------------------------------

/**
 * Recovery Engine action handler.
 *
 * Consumes a halt decision (failure + budget) and applies tiered recovery:
 *
 *   Tier A (retry): emits recovery:tier-a-retry, returns enriched prompt for re-dispatch.
 *   Tier B (propose): appends Proposal to RunManifest.pending_proposals, applies back-pressure.
 *   Tier C (halt): emits recovery:tier-c-halt, returns halt action for Decision Router.
 *
 * Safety valve: if pending_proposals.length >= 5 after any Tier B append,
 * emits pipeline:halted-pending-proposals and returns halt-entire-run.
 *
 * Back-pressure:
 *   >= 2 proposals + work graph: pauses dependent stories, continues independent ones.
 *   >= 2 proposals + linear mode: pauses ALL remaining dispatches.
 *
 * Idempotency: re-invoking on a story already in pending_proposals is a no-op
 * (handled inside RunManifest.appendProposal via storyKey deduplication).
 *
 * Canonical helper discipline: all manifest reads/writes via RunManifest class.
 * No direct JSON file access. No new aggregate manifest formats.
 *
 * @param input - Recovery engine input (see RecoveryEngineInput)
 * @returns Recovery action result for the orchestrator to act on
 */
export async function runRecoveryEngine(
  input: RecoveryEngineInput,
): Promise<RecoveryEngineResult> {
  const {
    runId,
    storyKey,
    failure,
    budget,
    bus,
    manifest,
    adapter,
    engine,
    pendingStoryKeys = [],
  } = input

  const action = classifyRecoveryAction(failure, budget)

  // ---- Tier A: auto-retry-with-context ----------------------------------------

  if (action === 'retry') {
    const attempt = budget.max - budget.remaining + 1
    const retryBudgetRemaining = budget.remaining - 1

    // Build enriched prompt with diagnosis + findings prepended
    const diagnosisParts: string[] = []
    if (failure.diagnosis) {
      diagnosisParts.push(`## Recovery Diagnosis\n\n${failure.diagnosis}`)
    }
    if (failure.findings && failure.findings.length > 0) {
      diagnosisParts.push(
        `## Prior Attempt Findings\n\n${failure.findings
          .map((f, i) => `${i + 1}. ${typeof f === 'string' ? f : JSON.stringify(f)}`)
          .join('\n')}`,
      )
    }
    const enrichedPrompt =
      diagnosisParts.length > 0
        ? diagnosisParts.join('\n\n') + '\n\n---\n\n'
        : undefined

    bus.emit('recovery:tier-a-retry', {
      runId,
      storyKey,
      rootCause: failure.rootCause,
      attempt,
      retryBudgetRemaining,
    })

    logger.info(
      { runId, storyKey, rootCause: failure.rootCause, attempt, retryBudgetRemaining },
      'Recovery Engine: Tier A retry dispatched',
    )

    return { action: 'retry', attempt, retryBudgetRemaining, ...(enrichedPrompt !== undefined ? { enrichedPrompt } : {}) }
  }

  // ---- Tier C: halt -------------------------------------------------------

  if (action === 'halt') {
    bus.emit('recovery:tier-c-halt', {
      runId,
      storyKey,
      rootCause: failure.rootCause,
    })

    logger.warn(
      { runId, storyKey, rootCause: failure.rootCause },
      'Recovery Engine: Tier C halt — operator intervention required',
    )

    return { action: 'halt' }
  }

  // ---- Tier B: re-scope proposal ------------------------------------------

  const attempts = budget.max - budget.remaining
  const suggestedAction = buildSuggestedAction(failure.rootCause, storyKey)
  const blastRadius: string[] = [] // populated from manifest or caller context

  const proposal = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    description: `Recovery Engine: ${failure.rootCause} on story ${storyKey} after ${attempts} attempt(s)`,
    type: 'escalate' as const,
    story_key: storyKey,
    storyKey,
    rootCause: failure.rootCause,
    attempts,
    suggestedAction,
    blastRadius,
  }

  // Append proposal via canonical helper (idempotent by storyKey)
  await manifest.appendProposal(proposal).catch((err: unknown) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), storyKey },
      'Recovery Engine: appendProposal failed — pipeline continues',
    )
  })

  // Read updated manifest to get current proposals count
  let pendingProposals: Array<{ storyKey?: string; story_key?: string }> = []
  try {
    const manifestData = await manifest.read()
    pendingProposals = manifestData.pending_proposals
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Recovery Engine: manifest read failed after appendProposal',
    )
  }

  const pendingProposalsCount = pendingProposals.length

  // Safety valve: >= 5 proposals → halt the entire run (AC6, AC7)
  if (pendingProposalsCount >= 5) {
    bus.emit('pipeline:halted-pending-proposals', {
      runId,
      pendingProposalsCount,
    })

    logger.error(
      { runId, pendingProposalsCount },
      'Recovery Engine: safety valve triggered — >= 5 pending proposals, halting run',
    )

    return { action: 'halt-entire-run', pendingProposalsCount }
  }

  // Emit Tier B event after safety valve check (but before back-pressure)
  bus.emit('recovery:tier-b-proposal', {
    runId,
    storyKey,
    rootCause: failure.rootCause,
    attempts,
    suggestedAction,
    blastRadius,
  })

  logger.info(
    { runId, storyKey, rootCause: failure.rootCause, pendingProposalsCount },
    'Recovery Engine: Tier B proposal appended',
  )

  // Back-pressure logic: >= 2 proposals (AC6)
  if (pendingProposalsCount >= 2) {
    const isLinearMode = engine === 'linear'

    if (isLinearMode) {
      // Linear engine mode — pause ALL remaining dispatches (AC6)
      logger.info(
        { runId, pendingProposalsCount },
        'Recovery Engine: linear mode back-pressure — pausing all pending dispatches',
      )
      return {
        action: 'propose',
        storyKey,
        pendingProposalsCount,
        pauseAll: true,
      }
    }

    // Work graph available — compute dependency-aware pause/continue sets (AC6)
    const proposedStoryKeys = pendingProposals
      .map((p) => p.storyKey ?? p.story_key)
      .filter((k): k is string => k !== undefined)

    const { pause, continue: continueKeys } = await computeDependencyAwarePause(
      proposedStoryKeys,
      pendingStoryKeys,
      adapter,
    )

    logger.info(
      { runId, pendingProposalsCount, pause, continue: continueKeys },
      'Recovery Engine: work-graph back-pressure computed',
    )

    return {
      action: 'propose',
      storyKey,
      pendingProposalsCount,
      pause,
      continue: continueKeys,
    }
  }

  // < 2 proposals — no back-pressure needed yet
  return {
    action: 'propose',
    storyKey,
    pendingProposalsCount,
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build a human-readable suggested action for the operator based on root cause.
 */
function buildSuggestedAction(rootCause: string, storyKey: string): string {
  switch (rootCause) {
    case 'scope-violation':
      return `Split story ${storyKey} into smaller stories with narrower scope`
    case 'fundamental-design-error':
      return `Revisit the architecture for story ${storyKey} — design approach is not viable`
    case 'cross-story-contract-mismatch':
      return `Reconcile interface contracts for story ${storyKey} with dependent stories`
    case 'build-failure':
      return `Fix build errors for story ${storyKey} — retry budget exhausted`
    case 'test-coverage-gap':
      return `Add missing test coverage for story ${storyKey}`
    case 'ac-missing-evidence':
      return `Story ${storyKey} lacks acceptance criteria evidence — revisit scope or provide evidence`
    case 'missing-import':
      return `Fix missing import dependencies for story ${storyKey}`
    default:
      return `Manual review required for story ${storyKey}: ${rootCause}`
  }
}
