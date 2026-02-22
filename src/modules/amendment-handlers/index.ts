/**
 * Amendment Context Handler Module
 *
 * Provides a shared `AmendmentContextHandler` that loads parent run decisions
 * and injects them with framing text into each pipeline phase's prompt context.
 *
 * All four pipeline phases (analysis, planning, solutioning, implementation)
 * can use this handler uniformly without duplicating context-loading logic.
 *
 * The handler never writes to the database — reads via loadParentRunDecisions()
 * are acceptable, but all write operations (e.g. supersedeDecision) must be
 * called by the caller directly.
 *
 * Usage:
 *   import { createAmendmentContextHandler } from './modules/amendment-handlers/index.js'
 *
 *   const handler = createAmendmentContextHandler(db, parentRunId, { framingConcept: 'Add dark mode' })
 *   const context = handler.loadContextForPhase('analysis')
 *   handler.logSupersession({ originalDecisionId, supersedingDecisionId, phase, reason, loggedAt })
 *   const log = handler.getSupersessionLog()
 *   const decisions = handler.getParentDecisions()
 */

import type { Database } from 'better-sqlite3'
import { loadParentRunDecisions } from '../../persistence/queries/amendments.js'
import type { Decision } from '../../persistence/schemas/decisions.js'
import type { PhaseName } from '../stop-after/types.js'

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * Options for an amendment phase run.
 *
 * parentRunId is required and must reference a completed pipeline run.
 * phaseFilter limits which phases' decisions are loaded for context.
 * framingConcept is an optional concept statement injected into framing header.
 */
export interface AmendmentPhaseRunOptions {
  parentRunId: string
  phaseFilter?: PhaseName[]
  framingConcept?: string
}

/**
 * A single entry in the in-memory supersession log.
 *
 * Callers are responsible for persisting supersession to the database
 * via supersedeDecision() from Story 12-7. This entry only tracks
 * in-memory state for the duration of the amendment session.
 */
export interface SupersessionLogEntry {
  originalDecisionId: string
  supersedingDecisionId: string
  phase: string
  key: string       // Decision key (category/key tuple's key part)
  reason: string
  loggedAt: string  // ISO 8601
}

/**
 * Interface for the amendment context handler.
 *
 * Defined as an interface (not a class) so it can be mocked in tests.
 * Implementations are created via createAmendmentContextHandler().
 */
export interface AmendmentContextHandler {
  /**
   * Returns a formatted context string containing parent run decisions
   * filtered to the given phase name, wrapped in amendment framing text.
   *
   * Suitable for injection as a system prompt prefix or context block.
   */
  loadContextForPhase(phaseName: PhaseName): string

  /**
   * Appends a supersession event to the in-memory log.
   * Does NOT write to the database.
   */
  logSupersession(entry: SupersessionLogEntry): void

  /**
   * Returns a defensive copy of the accumulated supersession log.
   * Returns an empty array if no supersessions have been logged.
   */
  getSupersessionLog(): SupersessionLogEntry[]

  /**
   * Returns the full array of parent run decisions loaded at handler creation time.
   * Not re-queried on each call — reflects state at creation.
   */
  getParentDecisions(): Decision[]
}

// ---------------------------------------------------------------------------
// Framing Text Templates
// ---------------------------------------------------------------------------

const FRAMING_HEADER = `=== AMENDMENT CONTEXT ===
This is an amendment run. The following decisions were established in the parent run
and represent committed product direction:`

const FRAMING_FOOTER = `When generating new decisions, explicitly note which parent decisions this conflicts
with, extends, or supersedes.
=== END AMENDMENT CONTEXT ===`

const FRAMING_CONCEPT_PREFIX = 'Concept being explored:'

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Format a single decision as a list entry string.
 */
function formatDecision(decision: Decision): string {
  const rationale = decision.rationale ? `\n    Rationale: ${decision.rationale}` : ''
  return `  - ${decision.category}/${decision.key}: ${decision.value}${rationale}`
}

/**
 * Group decisions by phase and render the formatted context block.
 */
function buildContextBlock(
  decisions: Decision[],
  phaseName: PhaseName,
  framingConcept?: string,
): string {
  // Filter decisions to the given phase
  const phaseDecisions = decisions.filter((d) => d.phase === phaseName)

  const lines: string[] = [FRAMING_HEADER, '']

  if (phaseDecisions.length === 0) {
    lines.push(`[Phase: ${phaseName}]`)
    lines.push('  (No prior decisions recorded for this phase)')
    lines.push('')
  } else {
    lines.push(`[Phase: ${phaseName}]`)
    for (const decision of phaseDecisions) {
      lines.push(formatDecision(decision))
    }
    lines.push('')
  }

  if (framingConcept) {
    lines.push(`${FRAMING_CONCEPT_PREFIX} ${framingConcept}`)
    lines.push('')
  }

  lines.push(FRAMING_FOOTER)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create an AmendmentContextHandler for the given parent run.
 *
 * Parent decisions are loaded eagerly from the database during construction
 * to avoid repeated DB queries per phase. The result is cached on the handler.
 *
 * Throws if parentRunId is not found (delegates to loadParentRunDecisions()).
 *
 * @param db - better-sqlite3 Database instance
 * @param parentRunId - ID of the completed parent pipeline run
 * @param options - Optional configuration (phaseFilter, framingConcept)
 * @returns AmendmentContextHandler instance
 */
export function createAmendmentContextHandler(
  db: Database,
  parentRunId: string,
  options?: Partial<AmendmentPhaseRunOptions>,
): AmendmentContextHandler {
  // Eagerly load parent decisions at construction time (AC5, Dev Notes: Loading Strategy)
  const allDecisions: Decision[] = loadParentRunDecisions(db, parentRunId)

  // Apply phaseFilter if provided
  const parentDecisions: Decision[] =
    options?.phaseFilter && options.phaseFilter.length > 0
      ? allDecisions.filter((d) => (options.phaseFilter as string[]).includes(d.phase))
      : allDecisions

  const framingConcept: string | undefined = options?.framingConcept

  // In-memory supersession log (AC3, AC4)
  const supersessionLog: SupersessionLogEntry[] = []

  // Return handler object (interface, not class — AC7)
  const handler: AmendmentContextHandler = {
    loadContextForPhase(phaseName: PhaseName): string {
      return buildContextBlock(parentDecisions, phaseName, framingConcept)
    },

    logSupersession(entry: SupersessionLogEntry): void {
      supersessionLog.push(entry)
    },

    getSupersessionLog(): SupersessionLogEntry[] {
      // Return defensive copy (AC4)
      return [...supersessionLog]
    },

    getParentDecisions(): Decision[] {
      // Return cached decisions — not re-queried (AC5)
      return parentDecisions
    },
  }

  return handler
}
