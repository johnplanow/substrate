import { describe, it, expect } from 'vitest'
import { checkAdapterVersionCompat } from '../version-compat.js'

const RANGE = { min: '2.0.0', max: '2.1.158' }

describe('checkAdapterVersionCompat', () => {
  it('returns compatible:true for a version inside the tested range', () => {
    const r = checkAdapterVersionCompat('claude-code', '2.1.100', RANGE)
    expect(r.compatible).toBe(true)
    expect(r.warning).toBeUndefined()
  })

  it('treats the inclusive bounds as compatible', () => {
    expect(checkAdapterVersionCompat('x', '2.0.0', RANGE).compatible).toBe(true)
    expect(checkAdapterVersionCompat('x', '2.1.158', RANGE).compatible).toBe(true)
  })

  it('flags a version BELOW the tested range with an actionable warning', () => {
    const r = checkAdapterVersionCompat('claude-code', '1.9.0', RANGE)
    expect(r.compatible).toBe(false)
    expect(r.warning).toMatch(/claude-code/)
    expect(r.warning).toMatch(/below substrate's tested range/i)
    expect(r.warning).toMatch(/2\.0\.0/)
    expect(r.warning).toMatch(/2\.1\.158/)
  })

  it('flags a version ABOVE the tested range with an actionable warning', () => {
    // The Codex-arc scenario: substrate was tested against 0.111.0; operator
    // runs 0.134.0; flag behavior drifted under us. This is exactly the
    // warning shape we'd want to fire the moment substrate spawns.
    const r = checkAdapterVersionCompat('codex', '0.134.0', { min: '0.110.0', max: '0.111.0' })
    expect(r.compatible).toBe(false)
    expect(r.warning).toMatch(/codex/)
    expect(r.warning).toMatch(/newer than substrate's tested range/i)
    expect(r.warning).toMatch(/0\.134\.0/)
  })

  it('surfaces an informational note even when compatible', () => {
    const r = checkAdapterVersionCompat('claude-code', '2.1.100', {
      ...RANGE,
      note: '--max-turns is silently ignored across this range',
    })
    expect(r.compatible).toBe(true)
    expect(r.warning).toMatch(/--max-turns is silently ignored/)
  })

  it('appends the note to the actionable warning when not compatible', () => {
    const r = checkAdapterVersionCompat('claude-code', '3.0.0', {
      ...RANGE,
      note: '--max-turns is silently ignored',
    })
    expect(r.compatible).toBe(false)
    expect(r.warning).toMatch(/newer than/i)
    expect(r.warning).toMatch(/Range note:/)
    expect(r.warning).toMatch(/--max-turns is silently ignored/)
  })

  it('degrades gracefully when actual version is unparseable — never throws', () => {
    const r = checkAdapterVersionCompat('weird', 'not-a-version', RANGE)
    expect(r.compatible).toBe(false)
    expect(r.warning).toMatch(/could not be parsed/i)
  })

  it('tolerates leading `v` and prerelease suffixes via semver coerce', () => {
    expect(checkAdapterVersionCompat('x', 'v2.1.0', RANGE).compatible).toBe(true)
    expect(checkAdapterVersionCompat('x', '2.1.0-beta.1', RANGE).compatible).toBe(true)
  })

  it('lower bound is INCLUSIVE: exact match of actualVersion === tested.min returns compatible:true', () => {
    const r = checkAdapterVersionCompat('claude-code', RANGE.min, RANGE)
    expect(r.compatible).toBe(true)
  })

  it('upper bound is INCLUSIVE: exact match of actualVersion === tested.max returns compatible:true', () => {
    const r = checkAdapterVersionCompat('claude-code', RANGE.max, RANGE)
    expect(r.compatible).toBe(true)
  })

  it('degenerate single-version range (min === max) is supported: exact match returns compatible:true', () => {
    const singleVersion = { min: '0.111.0', max: '0.111.0' }
    const r = checkAdapterVersionCompat('codex', '0.111.0', singleVersion)
    expect(r.compatible).toBe(true)
  })
})
