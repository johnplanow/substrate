/**
 * Unit tests for createStopAfterGate() factory
 */

import { describe, it, expect } from 'vitest'
import { createStopAfterGate } from '../gate-impl.js'
import type { PhaseName } from '../types.js'

describe('createStopAfterGate()', () => {
  describe('valid phase names', () => {
    const validPhases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']

    for (const phase of validPhases) {
      it(`creates a gate for phase '${phase}'`, () => {
        const gate = createStopAfterGate(phase)
        expect(gate).toBeDefined()
        expect(typeof gate.isStopPhase).toBe('function')
        expect(typeof gate.shouldHalt).toBe('function')
        expect(typeof gate.formatCompletionSummary).toBe('function')
      })
    }
  })

  describe('invalid phase name', () => {
    it('throws for an unknown phase name', () => {
      expect(() => createStopAfterGate('unknown' as PhaseName)).toThrow()
    })

    it('throws with a message mentioning valid phases', () => {
      expect(() => createStopAfterGate('deploy' as PhaseName)).toThrow(/valid phases/i)
    })

    it('throws for empty string', () => {
      expect(() => createStopAfterGate('' as PhaseName)).toThrow()
    })
  })

  describe('isStopPhase()', () => {
    it('returns true for analysis gate', () => {
      const gate = createStopAfterGate('analysis')
      expect(gate.isStopPhase()).toBe(true)
    })

    it('returns true for implementation gate', () => {
      const gate = createStopAfterGate('implementation')
      expect(gate.isStopPhase()).toBe(true)
    })
  })

  describe('shouldHalt()', () => {
    it('returns true for analysis gate', () => {
      const gate = createStopAfterGate('analysis')
      expect(gate.shouldHalt()).toBe(true)
    })

    it('returns true for planning gate', () => {
      const gate = createStopAfterGate('planning')
      expect(gate.shouldHalt()).toBe(true)
    })

    it('returns true for solutioning gate', () => {
      const gate = createStopAfterGate('solutioning')
      expect(gate.shouldHalt()).toBe(true)
    })

    it('returns true for implementation gate', () => {
      const gate = createStopAfterGate('implementation')
      expect(gate.shouldHalt()).toBe(true)
    })
  })

  describe('statelessness and independence', () => {
    it('two gates are independent objects', () => {
      const gate1 = createStopAfterGate('analysis')
      const gate2 = createStopAfterGate('planning')
      expect(gate1).not.toBe(gate2)
    })

    it('calling methods on one gate does not affect another gate', () => {
      const gate1 = createStopAfterGate('analysis')
      const gate2 = createStopAfterGate('solutioning')

      // Call shouldHalt on gate1, then verify gate2 is unaffected
      expect(gate1.shouldHalt()).toBe(true)
      expect(gate2.shouldHalt()).toBe(true)
      expect(gate1.isStopPhase()).toBe(true)
      expect(gate2.isStopPhase()).toBe(true)
    })

    it('multiple calls to the same gate produce consistent results', () => {
      const gate = createStopAfterGate('planning')
      expect(gate.isStopPhase()).toBe(true)
      expect(gate.isStopPhase()).toBe(true)
      expect(gate.shouldHalt()).toBe(true)
      expect(gate.shouldHalt()).toBe(true)
    })

    it('gates created concurrently are independent', () => {
      const phases: PhaseName[] = ['analysis', 'planning', 'solutioning', 'implementation']
      const gates = phases.map((p) => createStopAfterGate(p))

      for (const gate of gates) {
        expect(gate.isStopPhase()).toBe(true)
        expect(gate.shouldHalt()).toBe(true)
      }
    })
  })
})
