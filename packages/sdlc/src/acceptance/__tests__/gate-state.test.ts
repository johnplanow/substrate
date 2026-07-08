/**
 * A6 — gate auto-demotion overlay unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGateState, isGateDemoted, demoteGate, clearGateDemotion, effectiveAcceptanceMode, GATE_STATE_PATH } from '../gate-state.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-state-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('gate-state overlay', () => {
  it('absent overlay = not demoted', () => {
    expect(isGateDemoted(root)).toBe(false)
    expect(readGateState(root)).toBeUndefined()
  })

  it('demoteGate writes an overlay that isGateDemoted reads', () => {
    demoteGate(root, 'canary-missed', 'journey UJ-9')
    expect(isGateDemoted(root)).toBe(true)
    const state = readGateState(root)
    expect(state?.reason).toBe('canary-missed')
    expect(state?.detail).toBe('journey UJ-9')
    expect(existsSync(join(root, GATE_STATE_PATH))).toBe(true)
  })

  it('clearGateDemotion removes the overlay', () => {
    demoteGate(root, 'precision-floor')
    expect(clearGateDemotion(root)).toBe(true)
    expect(isGateDemoted(root)).toBe(false)
    expect(clearGateDemotion(root)).toBe(false) // already clear
  })

  it('effectiveAcceptanceMode forces blocking→advisory when demoted, never touches off/advisory', () => {
    expect(effectiveAcceptanceMode('blocking', root)).toBe('blocking')
    demoteGate(root, 'canary-missed')
    expect(effectiveAcceptanceMode('blocking', root)).toBe('advisory') // demoted can't block
    expect(effectiveAcceptanceMode('advisory', root)).toBe('advisory')
    expect(effectiveAcceptanceMode('off', root)).toBe('off') // off stays off even demoted
  })
})
