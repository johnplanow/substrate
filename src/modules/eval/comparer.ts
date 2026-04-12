/**
 * Eval run comparison (V1b-5).
 *
 * Compares eval scores between two pipeline runs to detect regression.
 * A phase is flagged as regressed when its score drops by more than
 * the configured regression threshold.
 */

import type { EvalReport, PhaseEvalResult, EvalMetadata, ThresholdConfig } from './types.js'
import { DEFAULT_PASS_THRESHOLD } from './types.js'

export type PhaseVerdict = 'REGRESSION' | 'Improved' | 'Unchanged' | 'New' | 'Removed'

export interface PhaseComparison {
  phase: string
  scoreA: number | undefined
  scoreB: number | undefined
  delta: number | undefined
  verdict: PhaseVerdict
}

export interface MetadataDiff {
  gitShaChanged: boolean
  rubricHashesChanged: boolean
  judgeModelChanged: boolean
}

export interface CompareReport {
  runIdA: string
  runIdB: string
  phases: PhaseComparison[]
  metadataDiff?: MetadataDiff
  hasRegression: boolean
}

const DEFAULT_REGRESSION_THRESHOLD = 0.05

export class EvalComparer {
  /**
   * Compare two eval reports and flag regressions.
   *
   * @param reportA - Baseline report (the "before")
   * @param reportB - Current report (the "after")
   * @param thresholds - Optional threshold config with regression delta
   */
  compare(
    reportA: EvalReport,
    reportB: EvalReport,
    thresholds?: ThresholdConfig,
  ): CompareReport {
    const regressionThreshold = thresholds?.regression ?? DEFAULT_REGRESSION_THRESHOLD

    // Collect all phase names from both reports
    const allPhases = new Set<string>()
    for (const p of reportA.phases) allPhases.add(p.phase)
    for (const p of reportB.phases) allPhases.add(p.phase)

    const phaseMapA = new Map<string, PhaseEvalResult>()
    const phaseMapB = new Map<string, PhaseEvalResult>()
    for (const p of reportA.phases) phaseMapA.set(p.phase, p)
    for (const p of reportB.phases) phaseMapB.set(p.phase, p)

    const phases: PhaseComparison[] = []
    let hasRegression = false

    for (const phase of allPhases) {
      const a = phaseMapA.get(phase)
      const b = phaseMapB.get(phase)

      if (a && b) {
        const delta = b.score - a.score
        let verdict: PhaseVerdict
        if (delta < -regressionThreshold) {
          verdict = 'REGRESSION'
          hasRegression = true
        } else if (delta > regressionThreshold) {
          verdict = 'Improved'
        } else {
          verdict = 'Unchanged'
        }
        phases.push({ phase, scoreA: a.score, scoreB: b.score, delta, verdict })
      } else if (a && !b) {
        phases.push({ phase, scoreA: a.score, scoreB: undefined, delta: undefined, verdict: 'Removed' })
      } else {
        phases.push({ phase, scoreA: undefined, scoreB: b!.score, delta: undefined, verdict: 'New' })
      }
    }

    const metadataDiff = this.diffMetadata(reportA.metadata, reportB.metadata)

    return {
      runIdA: reportA.runId,
      runIdB: reportB.runId,
      phases,
      metadataDiff,
      hasRegression,
    }
  }

  private diffMetadata(
    a: EvalMetadata | undefined,
    b: EvalMetadata | undefined,
  ): MetadataDiff | undefined {
    if (!a && !b) return undefined
    return {
      gitShaChanged: (a?.gitSha ?? null) !== (b?.gitSha ?? null),
      rubricHashesChanged: JSON.stringify(a?.rubricHashes ?? null) !== JSON.stringify(b?.rubricHashes ?? null),
      judgeModelChanged: (a?.judgeModel ?? null) !== (b?.judgeModel ?? null),
    }
  }
}
