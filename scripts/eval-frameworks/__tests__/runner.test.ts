import { describe, it, expect, beforeEach } from 'vitest'
// @ts-expect-error — .mjs module, no types
import {
  registerFrameworkRunner,
  getFrameworkRunner,
  listFrameworkRunners,
  _resetFrameworkRunners,
  fromDispatchEnvelope,
  validateRunResult,
  toGraderEnvelope,
  toGraderPair,
} from '../runner.mjs'

describe('FrameworkRunner registry', () => {
  beforeEach(() => _resetFrameworkRunners())

  it('registers and retrieves a runner', async () => {
    const runner = async () => ({ framework: 'x', task_id: 't', diff: null, run_outcome: 'completed', cost_usd: 0 })
    registerFrameworkRunner('x', runner)
    expect(listFrameworkRunners()).toEqual(['x'])
    expect(getFrameworkRunner('x')).toBe(runner)
  })

  it('throws with the known list when a runner is missing', () => {
    registerFrameworkRunner('a', async () => ({}))
    expect(() => getFrameworkRunner('nope')).toThrow(/no runner registered for "nope".*Registered: a/)
  })

  it('rejects non-function runners and empty names', () => {
    // @ts-expect-error intentional misuse
    expect(() => registerFrameworkRunner('y', 42)).toThrow(/must be a function/)
    expect(() => registerFrameworkRunner('', async () => ({}))).toThrow(/non-empty string/)
  })
})

describe('fromDispatchEnvelope — substrate path fits the neutral interface', () => {
  const baseEnvelope = {
    pack: 'bmad',
    pack_path: '/packs/bmad',
    dispatch_outcome: 'completed',
    diff: 'diff --git a/src/x.ts b/src/x.ts',
    total_turns: 7,
    total_tokens: { input: 100, output: 50 },
    verdict: 'SHIP_IT',
    recovery_history: [{ tier: 'A' }],
    escalation_reason: null,
    duration_seconds: 42,
    cost_usd: 0.31,
  }

  it('maps the neutral fields and quarantines BMad-specific signals', () => {
    const r = fromDispatchEnvelope(baseEnvelope, 'task-1')
    expect(r.framework).toBe('bmad-substrate')
    expect(r.task_id).toBe('task-1')
    expect(r.diff).toBe(baseEnvelope.diff)
    expect(r.total_turns).toBe(7)
    expect(r.total_tokens).toEqual({ input: 100, output: 50 })
    expect(r.cost_usd).toBe(0.31)
    expect(r.duration_seconds).toBe(42)
    expect(r.run_outcome).toBe('completed')
    // BMad vocabulary is preserved but quarantined (neutral graders ignore it)
    expect(r.framework_specific.verdict).toBe('SHIP_IT')
    expect(r.framework_specific.recovery_history).toEqual([{ tier: 'A' }])
    expect(validateRunResult(r)).toEqual([])
  })

  it('collapses escalated → failed (escalation = did not autonomously complete)', () => {
    const r = fromDispatchEnvelope({ ...baseEnvelope, dispatch_outcome: 'escalated' }, 't')
    expect(r.run_outcome).toBe('failed')
  })

  it('maps budget-exceeded and unknown outcomes', () => {
    expect(fromDispatchEnvelope({ ...baseEnvelope, dispatch_outcome: 'budget-exceeded' }, 't').run_outcome).toBe('budget-exceeded')
    expect(fromDispatchEnvelope({ ...baseEnvelope, dispatch_outcome: 'weird' }, 't').run_outcome).toBe('error')
    expect(fromDispatchEnvelope(null, 't').run_outcome).toBe('error')
  })

  it('allows a custom framework name (e.g. for a native or ralph adapter reusing the envelope)', () => {
    const r = fromDispatchEnvelope(baseEnvelope, 't', 'claude-native')
    expect(r.framework).toBe('claude-native')
  })
})

describe('toGraderEnvelope / toGraderPair — bridge to the Epic 81 axes', () => {
  // Regression guard: the code-quality axis gates on `dispatch_outcome === 'completed'`,
  // but the neutral envelope uses `run_outcome`. Without this bridge, FrameworkRunResults
  // are silently skipped as 'not-both-completed'. (Caught by the Phase-1 end-to-end smoke.)
  const result = {
    framework: 'r', task_id: 't', diff: 'diff --git a/x b/x', total_turns: 5,
    total_tokens: { input: 100, output: 20 }, cost_usd: 0.1, duration_seconds: 30, run_outcome: 'completed',
  }

  it('maps run_outcome:completed → dispatch_outcome:completed (the axis gate)', () => {
    expect(toGraderEnvelope(result).dispatch_outcome).toBe('completed')
  })

  it('passes diff/turns/tokens through unchanged for the cost + code-quality axes', () => {
    const g = toGraderEnvelope(result)
    expect(g.diff).toBe(result.diff)
    expect(g.total_turns).toBe(5)
    expect(g.total_tokens).toEqual({ input: 100, output: 20 })
  })

  it('preserves non-completing outcomes so the axis excludes them', () => {
    expect(toGraderEnvelope({ ...result, run_outcome: 'failed' }).dispatch_outcome).toBe('failed')
    expect(toGraderEnvelope({ ...result, run_outcome: 'budget-exceeded' }).dispatch_outcome).toBe('budget-exceeded')
  })

  it('builds a {current, candidate, ground_truth_diff} pair', () => {
    const pair = toGraderPair(result, { ...result, framework: 'r2' }, 'GT')
    expect(pair.current.dispatch_outcome).toBe('completed')
    expect(pair.candidate.dispatch_outcome).toBe('completed')
    expect(pair.ground_truth_diff).toBe('GT')
  })
})

describe('validateRunResult', () => {
  it('passes a well-formed result', () => {
    expect(validateRunResult({ framework: 'r', task_id: 't', diff: null, run_outcome: 'failed', cost_usd: 0 })).toEqual([])
  })
  it('catches missing/invalid fields', () => {
    const problems = validateRunResult({ task_id: '', run_outcome: 'nope', cost_usd: 'x' })
    expect(problems).toContain('framework missing')
    expect(problems).toContain('task_id missing')
    expect(problems.some((p: string) => p.startsWith('run_outcome invalid'))).toBe(true)
    expect(problems).toContain('cost_usd must be a number')
  })
  it('rejects total_tokens missing numeric fields', () => {
    const problems = validateRunResult({ framework: 'r', task_id: 't', diff: null, run_outcome: 'completed', cost_usd: 0, total_tokens: { input: 1 } })
    expect(problems).toContain('total_tokens present but missing numeric input/output')
  })
})
