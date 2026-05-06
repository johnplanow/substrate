/**
 * Unit tests for the Decision Router (Story 72-1).
 *
 * routeDecision is a pure function — no I/O, no mocking needed.
 * Tests cover all 6 required cases from AC9.
 */

import { describe, it, expect } from 'vitest'
import { routeDecision, DECISION_SEVERITY_MAP } from '../index.js'

describe('Decision Router — routeDecision', () => {
  // ---------------------------------------------------------------------------
  // AC9(a): --halt-on critical halts on cost-ceiling and build-failure
  // ---------------------------------------------------------------------------

  describe('policy: critical', () => {
    it('(AC9a) halts on cost-ceiling-exhausted (critical severity)', () => {
      const result = routeDecision('cost-ceiling-exhausted', 'critical')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('critical')
    })

    it('(AC9a) halts on build-verification-failure (critical severity)', () => {
      const result = routeDecision('build-verification-failure', 'critical')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('critical')
    })

    it('does NOT halt on recovery-retry-attempt (info severity)', () => {
      const result = routeDecision('recovery-retry-attempt', 'critical')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('info')
    })

    it('does NOT halt on re-scope-proposal (warning severity)', () => {
      const result = routeDecision('re-scope-proposal', 'critical')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('warning')
    })

    it('halts on cross-story-race-still-failed (critical severity)', () => {
      const result = routeDecision('cross-story-race-still-failed', 'critical')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('critical')
    })

    it('does NOT halt on cross-story-race-recovered (info severity)', () => {
      const result = routeDecision('cross-story-race-recovered', 'critical')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('info')
    })
  })

  // ---------------------------------------------------------------------------
  // AC9(b): --halt-on none does NOT halt on info and warning
  // ---------------------------------------------------------------------------

  describe('policy: none', () => {
    it('(AC9b) does NOT halt on recovery-retry-attempt (info)', () => {
      const result = routeDecision('recovery-retry-attempt', 'none')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('info')
    })

    it('(AC9b) does NOT halt on re-scope-proposal (warning)', () => {
      const result = routeDecision('re-scope-proposal', 'none')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('warning')
    })

    it('does NOT halt on cost-ceiling-exhausted (critical) under none policy', () => {
      const result = routeDecision('cost-ceiling-exhausted', 'none')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('critical')
    })

    it('does NOT halt on build-verification-failure (critical) under none policy', () => {
      const result = routeDecision('build-verification-failure', 'none')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('critical')
    })
  })

  // ---------------------------------------------------------------------------
  // AC9(c): --halt-on all halts on all severity tiers
  // ---------------------------------------------------------------------------

  describe('policy: all', () => {
    it('(AC9c) halts on info (recovery-retry-attempt)', () => {
      const result = routeDecision('recovery-retry-attempt', 'all')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('info')
    })

    it('(AC9c) halts on warning (re-scope-proposal)', () => {
      const result = routeDecision('re-scope-proposal', 'all')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('warning')
    })

    it('(AC9c) halts on critical (cost-ceiling-exhausted)', () => {
      const result = routeDecision('cost-ceiling-exhausted', 'all')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('critical')
    })

    it('(AC9c) halts on fatal (scope-violation)', () => {
      const result = routeDecision('scope-violation', 'all')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('fatal')
    })
  })

  // ---------------------------------------------------------------------------
  // AC9(d): scope-violation (fatal) halts regardless of policy
  // ---------------------------------------------------------------------------

  describe('fatal always-halts invariant (AC9d)', () => {
    it('scope-violation halts under critical policy', () => {
      const result = routeDecision('scope-violation', 'critical')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('fatal')
    })

    it('scope-violation halts under none policy', () => {
      const result = routeDecision('scope-violation', 'none')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('fatal')
    })

    it('scope-violation halts under all policy', () => {
      const result = routeDecision('scope-violation', 'all')
      expect(result.halt).toBe(true)
      expect(result.severity).toBe('fatal')
    })
  })

  // ---------------------------------------------------------------------------
  // AC9(e): unknown decision type defaults to severity critical
  // ---------------------------------------------------------------------------

  describe('unknown decision type safe default (AC9e)', () => {
    it('unknown type defaults to severity critical', () => {
      const result = routeDecision('totally-unknown-future-decision-xyz', 'critical')
      expect(result.severity).toBe('critical')
    })

    it('unknown type halts under critical policy (defaults to critical severity)', () => {
      const result = routeDecision('totally-unknown-future-decision-xyz', 'critical')
      expect(result.halt).toBe(true)
    })

    it('unknown type does NOT halt under none policy (critical but not fatal)', () => {
      const result = routeDecision('totally-unknown-future-decision-xyz', 'none')
      expect(result.halt).toBe(false)
      expect(result.severity).toBe('critical')
    })

    it('unknown type halts under all policy', () => {
      const result = routeDecision('totally-unknown-future-decision-xyz', 'all')
      expect(result.halt).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // AC9(f): default-action propagation when halt=false
  // ---------------------------------------------------------------------------

  describe('default-action propagation (AC9f)', () => {
    it('returns non-empty defaultAction for recovery-retry-attempt (info, non-halting under critical)', () => {
      const result = routeDecision('recovery-retry-attempt', 'critical')
      expect(result.halt).toBe(false)
      expect(typeof result.defaultAction).toBe('string')
      expect(result.defaultAction.trim()).not.toBe('')
    })

    it('returns expected defaultAction for recovery-retry-attempt', () => {
      const result = routeDecision('recovery-retry-attempt', 'critical')
      expect(result.defaultAction).toBe('continue-autonomous')
    })

    it('returns non-empty defaultAction for cross-story-race-recovered (info, non-halting under critical)', () => {
      const result = routeDecision('cross-story-race-recovered', 'critical')
      expect(result.halt).toBe(false)
      expect(typeof result.defaultAction).toBe('string')
      expect(result.defaultAction.trim()).not.toBe('')
    })

    it('returns expected defaultAction for cross-story-race-recovered', () => {
      const result = routeDecision('cross-story-race-recovered', 'critical')
      expect(result.defaultAction).toBe('continue-autonomous')
    })

    it('returns non-empty defaultAction for re-scope-proposal under critical policy', () => {
      const result = routeDecision('re-scope-proposal', 'critical')
      expect(result.halt).toBe(false)
      expect(result.defaultAction.trim()).not.toBe('')
    })

    it('returns non-empty defaultAction for build-verification-failure under none policy', () => {
      const result = routeDecision('build-verification-failure', 'none')
      expect(result.halt).toBe(false)
      expect(result.defaultAction.trim()).not.toBe('')
    })

    it('returns non-empty defaultAction for unknown type under none policy', () => {
      const result = routeDecision('unknown-future-decision', 'none')
      expect(result.halt).toBe(false)
      expect(result.defaultAction.trim()).not.toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // DECISION_SEVERITY_MAP correctness (AC3)
  // ---------------------------------------------------------------------------

  describe('DECISION_SEVERITY_MAP (AC3)', () => {
    it('has correct severity for all 7 decision types', () => {
      expect(DECISION_SEVERITY_MAP['cost-ceiling-exhausted']).toBe('critical')
      expect(DECISION_SEVERITY_MAP['build-verification-failure']).toBe('critical')
      expect(DECISION_SEVERITY_MAP['recovery-retry-attempt']).toBe('info')
      expect(DECISION_SEVERITY_MAP['re-scope-proposal']).toBe('warning')
      expect(DECISION_SEVERITY_MAP['scope-violation']).toBe('fatal')
      expect(DECISION_SEVERITY_MAP['cross-story-race-recovered']).toBe('info')
      expect(DECISION_SEVERITY_MAP['cross-story-race-still-failed']).toBe('critical')
    })
  })
})
