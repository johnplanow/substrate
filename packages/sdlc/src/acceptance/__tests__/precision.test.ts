/**
 * A6.2 — precision/recall instrumentation + demotion state machine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAcceptanceMetrics, computePrecision, computeRecall, recordCriticalFail, recordCanary, recordOverride } from '../precision.js'
import { isGateDemoted, clearGateDemotion } from '../gate-state.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'precision-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('precision/recall', () => {
  it('precision = 1.0 with no fails; drops as overrides accumulate', () => {
    expect(computePrecision(readAcceptanceMetrics(root))).toBe(1)
    for (let i = 0; i < 4; i++) recordCriticalFail(root)
    expect(computePrecision(readAcceptanceMetrics(root))).toBe(1) // 4 blocks, 0 overrides
    recordOverride(root, '1-1', 'wrong', 0.8)
    expect(computePrecision(readAcceptanceMetrics(root))).toBeCloseTo(0.75) // 3/4
  })

  it('recall = caught/planted', () => {
    recordCanary(root, true); recordCanary(root, true); recordCanary(root, false)
    expect(computeRecall(readAcceptanceMetrics(root))).toBeCloseTo(2 / 3)
  })
})

describe('precision-floor demotion state machine (AC3)', () => {
  it('does NOT demote below the ≥3-block sample threshold', () => {
    recordCriticalFail(root); recordCriticalFail(root) // 2 blocks
    const r = recordOverride(root, '1-1', 'wrong', 0.8) // 1/2 = 0.5 but sample < 3
    expect(r.demoted).toBe(false)
    expect(isGateDemoted(root)).toBe(false)
  })

  it('DEMOTES when precision falls below floor with a real sample; operator clears; re-promotes', () => {
    for (let i = 0; i < 4; i++) recordCriticalFail(root) // 4 blocks
    recordOverride(root, '1-1', 'fp', 0.8) // 3/4 = 0.75 < 0.8 → demote
    const r = recordOverride(root, '1-2', 'fp', 0.8) // 2/4 = 0.5
    expect(r.demoted).toBe(true)
    expect(isGateDemoted(root)).toBe(true)
    // operator clears after diagnosing
    expect(clearGateDemotion(root)).toBe(true)
    expect(isGateDemoted(root)).toBe(false)
  })

  it('a passing precision does not demote', () => {
    for (let i = 0; i < 10; i++) recordCriticalFail(root)
    const r = recordOverride(root, '1-1', 'one fp', 0.8) // 9/10 = 0.9 ≥ 0.8
    expect(r.demoted).toBe(false)
  })
})
