/**
 * Unit tests for validateStopAfterFromConflict()
 */

import { describe, it, expect } from 'vitest'
import { validateStopAfterFromConflict } from '../gate-impl.js'
import { STOP_AFTER_VALID_PHASES } from '../types.js'
import type { PhaseName } from '../types.js'

describe('validateStopAfterFromConflict()', () => {
  describe('undefined from — always valid', () => {
    it('returns valid when from is undefined (analysis stop)', () => {
      const result = validateStopAfterFromConflict('analysis', undefined)
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('returns valid when from is undefined (solutioning stop)', () => {
      const result = validateStopAfterFromConflict('solutioning', undefined)
      expect(result.valid).toBe(true)
    })

    it('returns valid when from is undefined (implementation stop)', () => {
      const result = validateStopAfterFromConflict('implementation', undefined)
      expect(result.valid).toBe(true)
    })
  })

  describe('valid cases — stopAfter >= from', () => {
    it('stopAfter=analysis, from=analysis — same phase is valid', () => {
      const result = validateStopAfterFromConflict('analysis', 'analysis')
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('stopAfter=solutioning, from=analysis — stop after from is valid', () => {
      const result = validateStopAfterFromConflict('solutioning', 'analysis')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=planning, from=analysis — stop after from is valid', () => {
      const result = validateStopAfterFromConflict('planning', 'analysis')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=implementation, from=analysis — stop after from is valid', () => {
      const result = validateStopAfterFromConflict('implementation', 'analysis')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=planning, from=planning — same phase is valid', () => {
      const result = validateStopAfterFromConflict('planning', 'planning')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=solutioning, from=planning — stop after from is valid', () => {
      const result = validateStopAfterFromConflict('solutioning', 'planning')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=implementation, from=planning — stop after from is valid', () => {
      const result = validateStopAfterFromConflict('implementation', 'planning')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=solutioning, from=solutioning — same phase is valid', () => {
      const result = validateStopAfterFromConflict('solutioning', 'solutioning')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=implementation, from=solutioning — stop after from is valid', () => {
      const result = validateStopAfterFromConflict('implementation', 'solutioning')
      expect(result.valid).toBe(true)
    })

    it('stopAfter=implementation, from=implementation — same phase is valid', () => {
      const result = validateStopAfterFromConflict('implementation', 'implementation')
      expect(result.valid).toBe(true)
    })
  })

  describe('invalid cases — stopAfter < from', () => {
    it('stopAfter=analysis, from=planning — returns error', () => {
      const result = validateStopAfterFromConflict('analysis', 'planning')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toContain('analysis')
      expect(result.error).toContain('planning')
    })

    it('stopAfter=analysis, from=solutioning — returns error', () => {
      const result = validateStopAfterFromConflict('analysis', 'solutioning')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('stopAfter=analysis, from=implementation — returns error', () => {
      const result = validateStopAfterFromConflict('analysis', 'implementation')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('stopAfter=planning, from=solutioning — returns error', () => {
      const result = validateStopAfterFromConflict('planning', 'solutioning')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toContain('planning')
      expect(result.error).toContain('solutioning')
    })

    it('stopAfter=planning, from=implementation — returns error', () => {
      const result = validateStopAfterFromConflict('planning', 'implementation')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('stopAfter=solutioning, from=implementation — returns error', () => {
      const result = validateStopAfterFromConflict('solutioning', 'implementation')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toContain('solutioning')
      expect(result.error).toContain('implementation')
    })
  })

  describe('error message format', () => {
    it('error message mentions --stop-after and --from flags', () => {
      const result = validateStopAfterFromConflict('analysis', 'planning')
      expect(result.error).toContain('--stop-after')
      expect(result.error).toContain('--from')
    })

    it('error message clearly states the conflict', () => {
      const result = validateStopAfterFromConflict('planning', 'solutioning')
      expect(result.error).toMatch(/stop.*before.*start|stop phase before start phase/i)
    })
  })

  describe('no exceptions thrown', () => {
    it('does not throw for any valid phase combination', () => {
      const phases = STOP_AFTER_VALID_PHASES as readonly PhaseName[]
      for (const stopAfter of phases) {
        for (const from of phases) {
          expect(() => validateStopAfterFromConflict(stopAfter, from)).not.toThrow()
        }
      }
    })

    it('does not throw when from is undefined', () => {
      const phases = STOP_AFTER_VALID_PHASES as readonly PhaseName[]
      for (const stopAfter of phases) {
        expect(() => validateStopAfterFromConflict(stopAfter, undefined)).not.toThrow()
      }
    })
  })

  describe('systematic phase pair validation', () => {
    it('validates all ordered pairs correctly', () => {
      const phases = STOP_AFTER_VALID_PHASES as readonly PhaseName[]

      for (let i = 0; i < phases.length; i++) {
        for (let j = 0; j < phases.length; j++) {
          const stopAfter = phases[i] as PhaseName
          const from = phases[j] as PhaseName
          const result = validateStopAfterFromConflict(stopAfter, from)

          if (i >= j) {
            // stopAfter comes at or after from — should be valid
            expect(result.valid).toBe(true)
          } else {
            // stopAfter comes before from — should be invalid
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
          }
        }
      }
    })
  })
})
