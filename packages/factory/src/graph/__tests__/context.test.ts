/**
 * Unit tests for GraphContext (story 42-8).
 *
 * Covers all ACs:
 *   AC1 – basic get/set
 *   AC2 – typed accessors with defaults
 *   AC3 – batch update via applyUpdates
 *   AC4 – snapshot returns serializable Record
 *   AC5 – independent clone
 *   AC6 – Outcome / OutcomeStatus type compliance
 *   AC7 – all tests pass
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { GraphContext } from '../context.js'
import type { IGraphContext, Outcome, OutcomeStatus } from '../types.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeCtx(initial?: Record<string, unknown>): GraphContext {
  return new GraphContext(initial)
}

// ---------------------------------------------------------------------------
// AC1 – Basic Get / Set
// ---------------------------------------------------------------------------

describe('GraphContext – get / set (AC1)', () => {
  it('returns the value after set', () => {
    const ctx = makeCtx()
    ctx.set('key', 'value')
    expect(ctx.get('key')).toBe('value')
  })

  it('returns undefined for a missing key', () => {
    const ctx = makeCtx()
    expect(ctx.get('missing')).toBeUndefined()
  })

  it('overwrites an existing key', () => {
    const ctx = makeCtx()
    ctx.set('x', 1)
    ctx.set('x', 2)
    expect(ctx.get('x')).toBe(2)
  })

  it('round-trips a number value', () => {
    const ctx = makeCtx()
    ctx.set('n', 42)
    expect(ctx.get('n')).toBe(42)
  })

  it('round-trips a boolean value', () => {
    const ctx = makeCtx()
    ctx.set('b', true)
    expect(ctx.get('b')).toBe(true)
  })

  it('round-trips an object value', () => {
    const obj = { a: 1, b: [2, 3] }
    const ctx = makeCtx()
    ctx.set('obj', obj)
    expect(ctx.get('obj')).toBe(obj) // same reference (shallow)
  })

  it('initialises from constructor seed values', () => {
    const ctx = makeCtx({ foo: 'bar', num: 99 })
    expect(ctx.get('foo')).toBe('bar')
    expect(ctx.get('num')).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// AC2 – Typed Accessors with Defaults
// ---------------------------------------------------------------------------

describe('GraphContext – getString (AC2)', () => {
  it('returns the value as a string when present', () => {
    const ctx = makeCtx({ s: 'hello' })
    expect(ctx.getString('s')).toBe('hello')
  })

  it('coerces a number to string', () => {
    const ctx = makeCtx({ n: 42 })
    expect(ctx.getString('n')).toBe('42')
  })

  it('returns explicit default for absent key', () => {
    const ctx = makeCtx()
    expect(ctx.getString('missing', 'fallback')).toBe('fallback')
  })

  it('returns empty string when absent and no default given', () => {
    const ctx = makeCtx()
    expect(ctx.getString('missing')).toBe('')
  })
})

describe('GraphContext – getNumber (AC2)', () => {
  it('returns the stored number', () => {
    const ctx = makeCtx({ n: 7 })
    expect(ctx.getNumber('n')).toBe(7)
  })

  it('coerces a numeric string', () => {
    const ctx = makeCtx({ n: '3.14' })
    expect(ctx.getNumber('n')).toBeCloseTo(3.14)
  })

  it('returns explicit default for absent key', () => {
    const ctx = makeCtx()
    expect(ctx.getNumber('n', 0)).toBe(0)
  })

  it('returns 0 when absent and no default given', () => {
    const ctx = makeCtx()
    expect(ctx.getNumber('n')).toBe(0)
  })

  it('resolves NaN to the default', () => {
    const ctx = makeCtx({ n: 'not-a-number' })
    expect(ctx.getNumber('n', 99)).toBe(99)
  })

  it('resolves NaN to 0 when no default given', () => {
    const ctx = makeCtx({ n: 'not-a-number' })
    expect(ctx.getNumber('n')).toBe(0)
  })
})

describe('GraphContext – getBoolean (AC2)', () => {
  it('returns true for truthy stored value', () => {
    const ctx = makeCtx({ b: true })
    expect(ctx.getBoolean('b')).toBe(true)
  })

  it('returns false for falsy stored value', () => {
    const ctx = makeCtx({ b: 0 })
    expect(ctx.getBoolean('b')).toBe(false)
  })

  it('returns explicit default for absent key', () => {
    const ctx = makeCtx()
    expect(ctx.getBoolean('b', false)).toBe(false)
  })

  it('returns false when absent and no default given', () => {
    const ctx = makeCtx()
    expect(ctx.getBoolean('b')).toBe(false)
  })

  it('returns true when default is true and key is absent', () => {
    const ctx = makeCtx()
    expect(ctx.getBoolean('b', true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC3 – Batch Update via applyUpdates
// ---------------------------------------------------------------------------

describe('GraphContext – applyUpdates (AC3)', () => {
  let ctx: GraphContext

  beforeEach(() => {
    ctx = makeCtx({ existing: 'keep-me' })
  })

  it('sets all keys in the update map', () => {
    ctx.applyUpdates({ a: 1, b: 'hello' })
    expect(ctx.get('a')).toBe(1)
    expect(ctx.get('b')).toBe('hello')
  })

  it('does not remove pre-existing keys outside the update', () => {
    ctx.applyUpdates({ a: 1 })
    expect(ctx.get('existing')).toBe('keep-me')
  })

  it('overwrites a pre-existing key that appears in the update', () => {
    ctx.applyUpdates({ existing: 'new-value' })
    expect(ctx.get('existing')).toBe('new-value')
  })

  it('handles an empty update map gracefully', () => {
    ctx.applyUpdates({})
    expect(ctx.get('existing')).toBe('keep-me')
  })
})

// ---------------------------------------------------------------------------
// AC4 – Snapshot Returns Serializable Record
// ---------------------------------------------------------------------------

describe('GraphContext – snapshot (AC4)', () => {
  it('returns a plain object with all keys', () => {
    const ctx = makeCtx({ x: 1, y: 'two' })
    const snap = ctx.snapshot()
    expect(snap).toEqual({ x: 1, y: 'two' })
  })

  it('is JSON-serializable', () => {
    const ctx = makeCtx({ a: 1, b: true, c: 'hello' })
    expect(() => JSON.stringify(ctx.snapshot())).not.toThrow()
  })

  it('returns an empty object for an empty context', () => {
    const ctx = makeCtx()
    expect(ctx.snapshot()).toEqual({})
  })

  it('modifying the snapshot does not affect the context', () => {
    const ctx = makeCtx({ key: 'original' })
    const snap = ctx.snapshot()
    snap['key'] = 'mutated'
    expect(ctx.get('key')).toBe('original')
  })

  it('snapshot reflects the current state after mutations', () => {
    const ctx = makeCtx()
    ctx.set('k', 'v1')
    ctx.set('k', 'v2')
    expect(ctx.snapshot()).toEqual({ k: 'v2' })
  })
})

// ---------------------------------------------------------------------------
// AC5 – Independent Clone — Mutations Do Not Propagate
// ---------------------------------------------------------------------------

describe('GraphContext – clone (AC5)', () => {
  it('clone starts with the same values as the original', () => {
    const ctx = makeCtx({ x: 'original' })
    const clone = ctx.clone()
    expect(clone.get('x')).toBe('original')
  })

  it('mutating the clone does not affect the original', () => {
    const ctx = makeCtx({ x: 'original' })
    const clone = ctx.clone()
    clone.set('x', 'mutated')
    expect(ctx.get('x')).toBe('original')
  })

  it('mutating the original does not affect the clone', () => {
    const ctx = makeCtx({ x: 'original' })
    const clone = ctx.clone()
    ctx.set('x', 'changed-in-original')
    expect(clone.get('x')).toBe('original')
  })

  it('new keys added to clone are not visible in original', () => {
    const ctx = makeCtx()
    const clone = ctx.clone()
    clone.set('newKey', 'cloneOnly')
    expect(ctx.get('newKey')).toBeUndefined()
  })

  it('new keys added to original are not visible in clone', () => {
    const ctx = makeCtx()
    const clone = ctx.clone()
    ctx.set('newKey', 'originalOnly')
    expect(clone.get('newKey')).toBeUndefined()
  })

  it('clone satisfies IGraphContext interface', () => {
    const ctx = makeCtx({ y: 99 })
    const clone: IGraphContext = ctx.clone()
    expect(clone.get('y')).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// AC6 – Outcome Type Covers All Terminal Statuses
// ---------------------------------------------------------------------------

describe('Outcome / OutcomeStatus types (AC6)', () => {
  it('OutcomeStatus covers all five required literals', () => {
    // Type-level verification via satisfies — if the union changes, this
    // will cause a TypeScript compile error.
    const statuses: OutcomeStatus[] = [
      'SUCCESS',
      'PARTIAL_SUCCESS',
      'FAILURE',
      'NEEDS_RETRY',
      'ESCALATE',
    ]
    expect(statuses).toHaveLength(5)
  })

  it('Outcome with all fields is JSON-serializable', () => {
    const outcome: Outcome = {
      status: 'SUCCESS',
      preferredLabel: 'done',
      suggestedNextIds: ['node-2'],
      contextUpdates: { result: 'ok' },
      notes: 'completed normally',
      error: undefined,
    }
    const serialized = JSON.stringify(outcome)
    expect(() => JSON.parse(serialized)).not.toThrow()
    const parsed = JSON.parse(serialized) as Outcome
    expect(parsed.status).toBe('SUCCESS')
    expect(parsed.preferredLabel).toBe('done')
  })

  it('Outcome with only required status field is valid', () => {
    const outcome: Outcome = { status: 'FAILURE' }
    expect(outcome.status).toBe('FAILURE')
    expect(outcome.preferredLabel).toBeUndefined()
  })

  it('NEEDS_RETRY status is assignable to Outcome', () => {
    const outcome: Outcome = { status: 'NEEDS_RETRY' }
    expect(outcome.status).toBe('NEEDS_RETRY')
  })

  it('ESCALATE status is assignable to Outcome', () => {
    const outcome: Outcome = { status: 'ESCALATE', error: new Error('boom') }
    expect(outcome.status).toBe('ESCALATE')
    expect(outcome.error).toBeInstanceOf(Error)
  })

  it('PARTIAL_SUCCESS status is assignable to Outcome', () => {
    const outcome: Outcome = { status: 'PARTIAL_SUCCESS', notes: 'partial work done' }
    expect(outcome.status).toBe('PARTIAL_SUCCESS')
  })
})
