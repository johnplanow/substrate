/**
 * Unit tests for the Quality Gates module.
 *
 * Tests QualityGate (gate-impl), GatePipeline (gate-pipeline),
 * and the gate registry (gate-registry).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { QualityGateImpl, createQualityGate } from '../gate-impl.js'
import { GatePipelineImpl, createGatePipeline } from '../gate-pipeline.js'
import {
  createGate,
  registerGateType,
  getRegisteredGateTypes,
} from '../gate-registry.js'
import type { GateConfig, EvaluatorFn } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePassingConfig(name = 'always-pass', maxRetries = 0): GateConfig {
  return {
    name,
    maxRetries,
    evaluator: () => ({ pass: true, issues: [], severity: 'info' }),
  }
}

function makeFailingConfig(name = 'always-fail', maxRetries = 0): GateConfig {
  return {
    name,
    maxRetries,
    evaluator: () => ({
      pass: false,
      issues: [`${name} failed`],
      severity: 'error',
    }),
  }
}

// ---------------------------------------------------------------------------
// QualityGate (gate-impl) tests
// ---------------------------------------------------------------------------

describe('QualityGateImpl', () => {
  describe('AC1: evaluate() when gate passes', () => {
    it('returns action: proceed with result', () => {
      const gate = new QualityGateImpl(makePassingConfig())
      const result = gate.evaluate({ some: 'output' })
      expect(result.action).toBe('proceed')
      expect(result.result).toEqual({ some: 'output' })
      expect(result.issues).toEqual([])
    })

    it('includes retriesRemaining when passing', () => {
      const gate = new QualityGateImpl(makePassingConfig('p', 2))
      const result = gate.evaluate('output')
      expect(result.action).toBe('proceed')
      expect(result.retriesRemaining).toBeGreaterThanOrEqual(0)
    })
  })

  describe('AC1: evaluate() evaluator returns GateEvaluation shape', () => {
    it('calls the evaluator function with the output', () => {
      const evaluator = vi.fn(() => ({ pass: true, issues: [], severity: 'info' as const }))
      const gate = createQualityGate({ name: 'spy-gate', maxRetries: 0, evaluator })
      gate.evaluate({ data: 42 })
      expect(evaluator).toHaveBeenCalledWith({ data: 42 })
    })
  })

  describe('AC2: Retry logic with maxRetries: 2', () => {
    it('returns retry with retriesRemaining: 1 on first failure', () => {
      const gate = new QualityGateImpl(makeFailingConfig('f', 2))
      const result = gate.evaluate('output')
      expect(result.action).toBe('retry')
      expect(result.retriesRemaining).toBe(1)
    })

    it('returns retry with retriesRemaining: 0 on second failure', () => {
      const gate = new QualityGateImpl(makeFailingConfig('f', 2))
      gate.evaluate('output') // first failure
      const result = gate.evaluate('output') // second failure
      expect(result.action).toBe('retry')
      expect(result.retriesRemaining).toBe(0)
    })

    it('returns warn on third failure (no retries left)', () => {
      const gate = new QualityGateImpl(makeFailingConfig('f', 2))
      gate.evaluate('output') // first
      gate.evaluate('output') // second
      const result = gate.evaluate('output') // third — no retries left
      expect(result.action).toBe('warn')
      expect(result.retriesRemaining).toBe(0)
    })

    it('returns warn immediately with maxRetries: 0', () => {
      const gate = new QualityGateImpl(makeFailingConfig('f', 0))
      const result = gate.evaluate('output')
      expect(result.action).toBe('warn')
      expect(result.retriesRemaining).toBe(0)
    })
  })

  describe('reset()', () => {
    it('resets retry counter so gate can be re-evaluated', () => {
      const gate = new QualityGateImpl(makeFailingConfig('f', 1))
      gate.evaluate('output') // first failure → retry, retriesRemaining = 0

      gate.reset()

      // After reset, should start fresh
      const result = gate.evaluate('output')
      expect(result.action).toBe('retry')
      expect(result.retriesRemaining).toBe(0)
    })

    it('reset allows gate to pass again after previous failures', () => {
      let shouldPass = false
      const gate = createQualityGate({
        name: 'dynamic',
        maxRetries: 0,
        evaluator: () =>
          shouldPass
            ? { pass: true, issues: [], severity: 'info' }
            : { pass: false, issues: ['fail'], severity: 'error' },
      })

      gate.evaluate('x') // warn (no retries)
      gate.reset()
      shouldPass = true
      const result = gate.evaluate('x')
      expect(result.action).toBe('proceed')
    })
  })

  describe('name property', () => {
    it('returns the configured gate name', () => {
      const gate = new QualityGateImpl(makePassingConfig('my-gate'))
      expect(gate.name).toBe('my-gate')
    })
  })
})

// ---------------------------------------------------------------------------
// GatePipeline tests (AC3)
// ---------------------------------------------------------------------------

describe('GatePipelineImpl', () => {
  describe('AC3: runs gates in order', () => {
    it('proceeds when all gates pass', () => {
      const gate1 = createQualityGate(makePassingConfig('g1'))
      const gate2 = createQualityGate(makePassingConfig('g2'))
      const pipeline = new GatePipelineImpl([gate1, gate2])
      const result = pipeline.run('output')
      expect(result.action).toBe('proceed')
      expect(result.gatesRun).toBe(2)
      expect(result.gatesPassed).toBe(2)
    })

    it('halts on first gate that returns retry', () => {
      const gate1 = createQualityGate(makeFailingConfig('g1', 1)) // will retry
      const gate2 = createQualityGate(makePassingConfig('g2'))
      const pipeline = new GatePipelineImpl([gate1, gate2])
      const result = pipeline.run('output')
      expect(result.action).toBe('retry')
      expect(result.gatesRun).toBe(1)
      expect(result.gatesPassed).toBe(0)
    })

    it('accumulates issues from all evaluated gates', () => {
      // Gate 1 warns (maxRetries 0 → warn), Gate 2 retries (maxRetries 1 → retry)
      const gate1 = createQualityGate(makeFailingConfig('g1', 0)) // warn
      const gate2 = createQualityGate(makeFailingConfig('g2', 1)) // retry
      const pipeline = new GatePipelineImpl([gate1, gate2])
      const result = pipeline.run('output')
      // gate1 warns so continues; gate2 retries so halts
      expect(result.action).toBe('retry')
      expect(result.gatesRun).toBe(2)
      expect(result.issues.length).toBe(2)
    })

    it('returns proceed when all gates pass with accumulated empty issues', () => {
      const gate1 = createQualityGate(makePassingConfig('g1'))
      const gate2 = createQualityGate(makePassingConfig('g2'))
      const gate3 = createQualityGate(makePassingConfig('g3'))
      const pipeline = createGatePipeline([gate1, gate2, gate3])
      const result = pipeline.run('output')
      expect(result.action).toBe('proceed')
      expect(result.gatesRun).toBe(3)
      expect(result.gatesPassed).toBe(3)
      expect(result.issues).toEqual([])
    })

    it('returns gatesPassed correctly when some warn and some pass', () => {
      const gate1 = createQualityGate(makePassingConfig('g1'))
      const gate2 = createQualityGate(makeFailingConfig('g2', 0)) // warn
      const gate3 = createQualityGate(makePassingConfig('g3'))
      const pipeline = createGatePipeline([gate1, gate2, gate3])
      const result = pipeline.run('output')
      expect(result.action).toBe('proceed')
      expect(result.gatesRun).toBe(3)
      expect(result.gatesPassed).toBe(2) // g1 and g3 pass; g2 warns
    })

    it('gate issues include gate name', () => {
      const gate1 = createQualityGate(makeFailingConfig('my-gate', 0))
      const pipeline = createGatePipeline([gate1])
      const result = pipeline.run('output')
      expect(result.issues[0]?.gate).toBe('my-gate')
    })
  })
})

// ---------------------------------------------------------------------------
// Gate Registry tests (AC8)
// ---------------------------------------------------------------------------

describe('Gate Registry', () => {
  describe('predefined gate types', () => {
    it('ac-validation: passes when ac_met is "yes"', () => {
      const gate = createGate('ac-validation')
      const result = gate.evaluate({ ac_met: 'yes' })
      expect(result.action).toBe('proceed')
    })

    it('ac-validation: fails when ac_met is "no"', () => {
      const gate = createGate('ac-validation')
      const result = gate.evaluate({ ac_met: 'no' })
      expect(result.action).toBe('warn') // maxRetries defaults to 0
      expect(result.issues[0]).toContain('no')
    })

    it('ac-validation: fails when ac_met is missing', () => {
      const gate = createGate('ac-validation')
      const result = gate.evaluate({})
      expect(result.action).toBe('warn')
      expect(result.issues[0]).toContain('missing')
    })

    it('test-coverage: passes when tests.fail is 0', () => {
      const gate = createGate('test-coverage')
      const result = gate.evaluate({ tests: { fail: 0 } })
      expect(result.action).toBe('proceed')
    })

    it('test-coverage: fails when tests.fail > 0', () => {
      const gate = createGate('test-coverage')
      const result = gate.evaluate({ tests: { fail: 3 } })
      expect(result.action).toBe('warn')
      expect(result.issues[0]).toContain('3')
    })

    it('code-review-verdict: passes when verdict is SHIP_IT', () => {
      const gate = createGate('code-review-verdict')
      const result = gate.evaluate({ verdict: 'SHIP_IT' })
      expect(result.action).toBe('proceed')
    })

    it('code-review-verdict: fails when verdict is REWORK', () => {
      const gate = createGate('code-review-verdict')
      const result = gate.evaluate({ verdict: 'REWORK' })
      expect(result.action).toBe('warn')
      expect(result.issues[0]).toContain('REWORK')
    })

    it('schema-compliance: passes when output matches schema', () => {
      const schema = z.object({ name: z.string(), count: z.number() })
      const gate = createGate('schema-compliance', { schema })
      const result = gate.evaluate({ name: 'test', count: 42 })
      expect(result.action).toBe('proceed')
    })

    it('schema-compliance: fails when output does not match schema', () => {
      const schema = z.object({ name: z.string(), count: z.number() })
      const gate = createGate('schema-compliance', { schema })
      const result = gate.evaluate({ name: 123, count: 'wrong' })
      expect(result.action).toBe('warn')
      expect(result.issues.length).toBeGreaterThan(0)
    })

    it('schema-compliance: throws if no schema provided', () => {
      expect(() => createGate('schema-compliance')).toThrow('schema')
    })
  })

  describe('custom gate registration', () => {
    it('registerGateType registers a new gate type', () => {
      const customEvaluator: EvaluatorFn = (output) => {
        const o = output as Record<string, unknown>
        return o?.custom === true
          ? { pass: true, issues: [], severity: 'info' as const }
          : { pass: false, issues: ['custom check failed'], severity: 'error' as const }
      }

      registerGateType('custom-test-gate', customEvaluator)
      const gate = createGate('custom-test-gate')

      expect(gate.evaluate({ custom: true }).action).toBe('proceed')
      expect(gate.evaluate({ custom: false }).action).toBe('warn')
    })

    it('getRegisteredGateTypes includes all built-in types', () => {
      const types = getRegisteredGateTypes()
      expect(types).toContain('ac-validation')
      expect(types).toContain('test-coverage')
      expect(types).toContain('code-review-verdict')
    })

    it('createGate throws for unknown type', () => {
      expect(() => createGate('no-such-gate-xyz')).toThrow('Unknown gate type')
    })

    it('createGate accepts custom name override', () => {
      const gate = createGate('ac-validation', { name: 'my-named-gate' })
      expect(gate.name).toBe('my-named-gate')
    })

    it('createGate with maxRetries creates gate that retries', () => {
      const gate = createGate('ac-validation', { maxRetries: 1 })
      // Fail once → retry
      const r1 = gate.evaluate({ ac_met: 'no' })
      expect(r1.action).toBe('retry')
      expect(r1.retriesRemaining).toBe(0)
      // Fail twice → warn
      const r2 = gate.evaluate({ ac_met: 'no' })
      expect(r2.action).toBe('warn')
    })
  })
})
