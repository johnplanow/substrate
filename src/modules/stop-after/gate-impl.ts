/**
 * Stop-After Gate Module — Implementation
 *
 * Implements createStopAfterGate(), formatPhaseCompletionSummary(), and
 * validateStopAfterFromConflict(). All functions are pure (no side effects).
 */

import type { StopAfterGate } from './gate.js'
import {
  type PhaseName,
  type CompletionSummaryParams,
  type ValidationResult,
  STOP_AFTER_VALID_PHASES,
} from './types.js'

// ---------------------------------------------------------------------------
// Word count helper
// ---------------------------------------------------------------------------

/**
 * Count words in a string using whitespace splitting.
 * Filters empty tokens to handle leading/trailing whitespace.
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

// ---------------------------------------------------------------------------
// Next-phase descriptions
// ---------------------------------------------------------------------------

/** Default descriptions of what each phase produces for the next phase */
const NEXT_PHASE_DESCRIPTIONS: Record<PhaseName, string> = {
  analysis: 'Planning will consume the product brief to define requirements and user stories.',
  planning:
    'Solutioning will consume the requirements and user stories to design the technical architecture.',
  solutioning:
    'Implementation will consume the architecture decisions and story definitions to build the solution.',
  implementation: 'The pipeline is complete. All phases have finished.',
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Format wall-clock duration from two ISO 8601 timestamps.
 * Returns a human-readable string like "45 seconds" or "2 minutes 30 seconds".
 */
function formatDuration(startedAt: string, completedAt: string): string {
  const startMs = Date.parse(startedAt)
  const endMs = Date.parse(completedAt)

  if (isNaN(startMs) || isNaN(endMs)) {
    return 'unknown duration'
  }

  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes === 0) {
    return `${seconds} second${seconds !== 1 ? 's' : ''}`
  }
  if (seconds === 0) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`
  }
  return `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`
}

// ---------------------------------------------------------------------------
// Summary formatting
// ---------------------------------------------------------------------------

/**
 * Format a phase completion summary string.
 *
 * The output will be <= 500 words. If needed, the artifact list is truncated
 * (showing count and "...X more artifacts") to stay within limit.
 * The resume command is never truncated.
 */
export function formatPhaseCompletionSummary(params: CompletionSummaryParams): string {
  const {
    phaseName,
    startedAt,
    completedAt,
    decisionsCount,
    artifactPaths,
    runId,
    nextPhaseDescription,
  } = params

  const capitalizedPhase = phaseName.charAt(0).toUpperCase() + phaseName.slice(1)
  const duration = formatDuration(startedAt, completedAt)
  const nextDesc = nextPhaseDescription ?? NEXT_PHASE_DESCRIPTIONS[phaseName]
  const resumeCommand = `substrate auto resume --run-id ${runId}`

  // Build the required non-artifact parts first
  const headerLine = `${capitalizedPhase} phase completed successfully.`
  const durationLine = `Duration: ${duration}`
  const decisionsLine = `Decisions written: ${decisionsCount}`
  const nextPhaseLine = `Next phase: ${nextDesc}`
  const resumeLine = `To resume: ${resumeCommand}`

  // Attempt to include all artifacts
  const buildSummary = (paths: string[], truncated: boolean, truncatedCount: number): string => {
    const lines: string[] = []
    lines.push(headerLine)
    lines.push('')
    lines.push(`Pipeline phase: ${phaseName}`)
    lines.push(`Run ID: ${runId}`)
    lines.push(durationLine)
    lines.push(`Started at: ${startedAt}`)
    lines.push(`Completed at: ${completedAt}`)
    lines.push(decisionsLine)
    lines.push('')

    if (paths.length > 0) {
      lines.push(`Artifacts created (${paths.length + (truncated ? truncatedCount : 0)} total):`)
      for (const p of paths) {
        lines.push(`  - ${p}`)
      }
      if (truncated) {
        lines.push(`  - ...${truncatedCount} more artifact${truncatedCount !== 1 ? 's' : ''}`)
      }
    } else if (truncated) {
      lines.push(
        `Artifacts created (${truncatedCount} total): list omitted to stay within word budget.`,
      )
    } else {
      lines.push('Artifacts created: none for this phase.')
    }

    lines.push('')
    lines.push(`What happens next:`)
    lines.push(nextPhaseLine)
    lines.push('')
    lines.push(resumeLine)

    return lines.join('\n')
  }

  // Try with all artifacts
  let result = buildSummary(artifactPaths, false, 0)

  if (countWords(result) <= 500) {
    return result
  }

  // Binary search to find how many artifacts fit within 500 words
  let lo = 0
  let hi = artifactPaths.length

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const truncatedCount = artifactPaths.length - mid
    const candidate = buildSummary(artifactPaths.slice(0, mid), truncatedCount > 0, truncatedCount)
    if (countWords(candidate) <= 500) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  const finalTruncatedCount = artifactPaths.length - lo
  result = buildSummary(
    artifactPaths.slice(0, lo),
    finalTruncatedCount > 0,
    finalTruncatedCount,
  )

  return result
}

// ---------------------------------------------------------------------------
// Gate factory
// ---------------------------------------------------------------------------

/**
 * Create a stateless stop-after gate for the given phase name.
 *
 * Validates phaseName against STOP_AFTER_VALID_PHASES at construction time.
 * Throws if an invalid phase name is provided.
 *
 * @param phaseName - The phase after which the pipeline should halt
 * @returns A StopAfterGate object
 * @throws Error if phaseName is not a valid phase
 */
export function createStopAfterGate(phaseName: PhaseName): StopAfterGate {
  // Validate at construction time
  if (!STOP_AFTER_VALID_PHASES.includes(phaseName)) {
    throw new Error(
      `Invalid phase name '${phaseName}'. Valid phases: ${STOP_AFTER_VALID_PHASES.join(', ')}`,
    )
  }

  // The gate holds no mutable state — all methods are pure
  return {
    isStopPhase(): boolean {
      return true
    },

    shouldHalt(): boolean {
      return true
    },

    formatCompletionSummary(params: CompletionSummaryParams): string {
      return formatPhaseCompletionSummary(params)
    },
  }
}

// ---------------------------------------------------------------------------
// Conflict validation
// ---------------------------------------------------------------------------

/**
 * Validate that stopAfter is not before from in phase order.
 *
 * Returns { valid: true } if:
 *   - from is undefined (no start phase restriction)
 *   - stopAfter comes after or equals from in phase order
 *
 * Returns { valid: false, error: "..." } if stopAfter comes before from.
 *
 * Never throws; all error conditions return structured results.
 *
 * @param stopAfter - The phase after which the pipeline should halt
 * @param from      - The phase from which the pipeline starts (optional)
 * @returns ValidationResult
 */
export function validateStopAfterFromConflict(
  stopAfter: PhaseName,
  from?: PhaseName,
): ValidationResult {
  if (from === undefined) {
    return { valid: true }
  }

  const stopIdx = STOP_AFTER_VALID_PHASES.indexOf(stopAfter)
  const fromIdx = STOP_AFTER_VALID_PHASES.indexOf(from)

  if (stopIdx < fromIdx) {
    return {
      valid: false,
      error: `Cannot use --stop-after ${stopAfter} when --from ${from} (stop phase before start phase)`,
    }
  }

  return { valid: true }
}
