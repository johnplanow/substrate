import { describe, it, expect } from 'vitest'
import { classifyVersionGap } from '../version-gap.js'

describe('classifyVersionGap', () => {
  describe("'none'", () => {
    it('returns none when versions are equal', () => {
      expect(classifyVersionGap('0.20.71', '0.20.71')).toBe('none')
    })

    it('returns none when current is ahead of latest (dev build)', () => {
      expect(classifyVersionGap('0.20.99', '0.20.71')).toBe('none')
    })

    it('returns none when current major+minor+patch all exceed latest', () => {
      expect(classifyVersionGap('1.0.0', '0.99.99')).toBe('none')
    })
  })

  describe("'patch-1' (acceptable lag)", () => {
    it('returns patch-1 for a single patch hop', () => {
      expect(classifyVersionGap('0.20.71', '0.20.72')).toBe('patch-1')
    })

    it('returns patch-1 even for the obs_017 incident case (v0.20.41 → v0.20.42)', () => {
      // The obs_017 incident itself was a single-patch-hop confusion; the
      // advisory is forward-looking — it should NOT fire on a 1-patch lag.
      // Multi-patch lag is the failure-class trigger.
      expect(classifyVersionGap('0.20.41', '0.20.42')).toBe('patch-1')
    })
  })

  describe("'significant' (advisory should fire)", () => {
    it('returns significant for a 2-patch hop', () => {
      expect(classifyVersionGap('0.20.71', '0.20.73')).toBe('significant')
    })

    it('returns significant for many-patch hop (canonical lag scenario)', () => {
      expect(classifyVersionGap('0.20.41', '0.20.71')).toBe('significant')
    })

    it('returns significant when minor differs', () => {
      expect(classifyVersionGap('0.20.99', '0.21.0')).toBe('significant')
    })

    it('returns significant when major differs', () => {
      expect(classifyVersionGap('0.99.99', '1.0.0')).toBe('significant')
    })
  })

  describe('robustness', () => {
    it('returns none when current is unparseable', () => {
      expect(classifyVersionGap('invalid', '0.20.71')).toBe('none')
    })

    it('returns none when latest is unparseable', () => {
      expect(classifyVersionGap('0.20.71', 'invalid')).toBe('none')
    })

    it('handles version strings with "v" prefix via semver.coerce', () => {
      expect(classifyVersionGap('v0.20.71', 'v0.20.73')).toBe('significant')
    })
  })
})
