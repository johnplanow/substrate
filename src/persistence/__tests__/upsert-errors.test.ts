// Unit tests for the shared upsert error detection helper.
//
// G10 (DB-enforced upsert idempotency) relies on catching UNIQUE
// constraint violations and retrying as UPDATE. Each backing adapter
// surfaces these violations with a different error message format,
// so the detection helper must match them all without catching
// unrelated errors.
//
// Adapter error formats seen in the wild:
//   - InMemoryDatabaseAdapter: "UNIQUE constraint failed: <table> (<cols>)"
//   - MySQL classic: "Duplicate entry 'x' for key 'y'"
//   - Dolt (observed 2026-04-12 on live pipeline): "duplicate unique key
//     given: [<val1>,<val2>,<val3>]"
//
// If a new adapter is added, append its error format here with a
// regression-guard test so the helper keeps up.

import { describe, it, expect } from 'vitest'
import { isUniqueConstraintViolation } from '../upsert-errors.js'

describe('isUniqueConstraintViolation', () => {
  it('matches the InMemoryDatabaseAdapter format', () => {
    const err = new Error('UNIQUE constraint failed: decisions (pipeline_run_id, category, `key`)')
    expect(isUniqueConstraintViolation(err)).toBe(true)
  })

  it('matches the MySQL classic "Duplicate entry ... for key ..." format', () => {
    const err = new Error("Duplicate entry 'run-1-product-brief-constraints' for key 'uniq_decisions_composite'")
    expect(isUniqueConstraintViolation(err)).toBe(true)
  })

  it('matches the Dolt "duplicate unique key given: [...]" format (2026-04-12 regression)', () => {
    // Real error surfaced by a 2026-04-12 live pipeline run. The pre-fix
    // regex checked for "duplicate key" (with a single space) and
    // "duplicate entry" but MISSED this variant because "duplicate
    // unique key" has "unique" wedged between "duplicate" and "key".
    // The G10 upsert catch branch fell through and the INSERT error
    // bubbled up, crashing the analysis phase mid-pipeline.
    const err = new Error(
      'error on line 1 for query INSERT INTO decisions (id, pipeline_run_id, phase, category, `key`, value, rationale) VALUES (...): duplicate unique key given: [8dfb9868-3e6d-4bde-8674-8bcce8d511f7,product-brief,constraints]',
    )
    expect(isUniqueConstraintViolation(err)).toBe(true)
  })

  it('matches a bare "duplicate key" format (MySQL ER_DUP_KEYNAME)', () => {
    const err = new Error("ER_DUP_KEYNAME: Duplicate key name 'uniq_composite'")
    expect(isUniqueConstraintViolation(err)).toBe(true)
  })

  it('rejects unrelated errors (schema / type / permission)', () => {
    expect(isUniqueConstraintViolation(new Error('Table not found'))).toBe(false)
    expect(isUniqueConstraintViolation(new Error('Column type mismatch'))).toBe(false)
    expect(isUniqueConstraintViolation(new Error('Access denied'))).toBe(false)
    expect(isUniqueConstraintViolation(new Error('Syntax error near INSERT'))).toBe(false)
  })

  it('rejects non-Error values (string, number, null, undefined)', () => {
    expect(isUniqueConstraintViolation('unique constraint failed')).toBe(false)
    expect(isUniqueConstraintViolation(42)).toBe(false)
    expect(isUniqueConstraintViolation(null)).toBe(false)
    expect(isUniqueConstraintViolation(undefined)).toBe(false)
  })

  it('rejects an Error whose message coincidentally contains unrelated "unique" or "duplicate"', () => {
    // "unique" without "constraint" should not false-positive
    expect(isUniqueConstraintViolation(new Error('This is a unique situation'))).toBe(false)
    // "duplicate" without "key" or "entry" should not false-positive
    expect(isUniqueConstraintViolation(new Error('Duplicate work detected'))).toBe(false)
  })
})
