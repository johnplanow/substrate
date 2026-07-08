/**
 * Acceptance Gate — precision + canary-recall instrumentation (A6.2).
 *
 * Design principle 4, operationalized: "false positives are tracked as
 * first-class as false negatives." Two operator-local tallies (outside git,
 * like gate-state):
 *
 *  - fails/overrides → VERDICT PRECISION = confirmed-fails / total-fails. Each
 *    journey-critical FAIL/UNREACHABLE the gate blocks on increments
 *    total-fails; an operator override (`substrate acceptance override`)
 *    marks that block a false positive. Precision below `precision_floor`
 *    means the gate is blocking too much correct work — it auto-demotes to
 *    advisory (the same overlay a canary miss uses), because a gate operators
 *    can't trust to be right is worse than no gate.
 *  - canary runs → RECALL = caught / planted (from the canary tally).
 *
 * Kept operator-local + simple (JSON tallies); Dolt persistence is a later
 * enhancement ("where available" per the plan) — the trust-critical behavior
 * (demote-below-floor) does not depend on it.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { demoteGate } from './gate-state.js'

export const ACCEPTANCE_METRICS_PATH = '.substrate/acceptance/metrics.json'

export const AcceptanceMetricsSchema = z.object({
  /** Journey-critical FAIL/UNREACHABLE verdicts the gate blocked on. */
  total_fails: z.number().int().nonnegative().default(0),
  /** Operator overrides — blocks judged to be false positives. */
  overrides: z
    .array(z.object({ story: z.string(), reason: z.string(), at: z.string() }))
    .default([]),
  /** Canary runs (recall numerator/denominator). */
  canaries_planted: z.number().int().nonnegative().default(0),
  canaries_caught: z.number().int().nonnegative().default(0),
})

export type AcceptanceMetrics = z.infer<typeof AcceptanceMetricsSchema>

const EMPTY: AcceptanceMetrics = { total_fails: 0, overrides: [], canaries_planted: 0, canaries_caught: 0 }

export function readAcceptanceMetrics(projectRoot: string): AcceptanceMetrics {
  const path = join(projectRoot, ACCEPTANCE_METRICS_PATH)
  if (!existsSync(path)) return { ...EMPTY }
  try {
    const parsed = AcceptanceMetricsSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
    return parsed.success ? parsed.data : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

function writeMetrics(projectRoot: string, m: AcceptanceMetrics): void {
  const path = join(projectRoot, ACCEPTANCE_METRICS_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n', 'utf-8')
}

/** Precision = confirmed-fails / total-fails. 1.0 when no fails yet (nothing to be wrong about). */
export function computePrecision(m: AcceptanceMetrics): number {
  if (m.total_fails === 0) return 1
  const confirmed = Math.max(0, m.total_fails - m.overrides.length)
  return confirmed / m.total_fails
}

/** Recall = caught / planted. 1.0 when no canaries run yet. */
export function computeRecall(m: AcceptanceMetrics): number {
  if (m.canaries_planted === 0) return 1
  return m.canaries_caught / m.canaries_planted
}

/** A6.2: the gate blocked a journey-critical FAIL — count it (precision denominator). */
export function recordCriticalFail(projectRoot: string): void {
  const m = readAcceptanceMetrics(projectRoot)
  m.total_fails += 1
  writeMetrics(projectRoot, m)
}

/** A6.1: record a canary outcome (recall). */
export function recordCanary(projectRoot: string, caught: boolean): void {
  const m = readAcceptanceMetrics(projectRoot)
  m.canaries_planted += 1
  if (caught) m.canaries_caught += 1
  writeMetrics(projectRoot, m)
}

export interface OverrideResult {
  metrics: AcceptanceMetrics
  precision: number
  /** true when this override pushed precision below the floor and demoted the gate. */
  demoted: boolean
}

/**
 * A6.2 AC1: record an operator override of a FAIL verdict, then re-check the
 * precision floor. Below floor → auto-demote (AC2).
 */
export function recordOverride(
  projectRoot: string,
  story: string,
  reason: string,
  precisionFloor: number,
): OverrideResult {
  const m = readAcceptanceMetrics(projectRoot)
  m.overrides.push({ story, reason, at: new Date().toISOString() })
  writeMetrics(projectRoot, m)
  const precision = computePrecision(m)
  let demoted = false
  // Only demote once there's a meaningful sample (≥3 blocks) so a single early
  // override doesn't nuke the gate; below-floor after that is a real pattern.
  if (m.total_fails >= 3 && precision < precisionFloor) {
    demoteGate(projectRoot, 'precision-floor', `verdict precision ${precision.toFixed(2)} < floor ${precisionFloor.toFixed(2)} (${m.overrides.length} overrides / ${String(m.total_fails)} blocks)`)
    demoted = true
  }
  return { metrics: m, precision, demoted }
}
