// @vitest-environment node
/**
 * Unit tests for typed error classes in errors.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  StateStoreError,
  DoltNotInitializedError,
  DoltQueryError,
  DoltMergeConflictError,
} from '../errors.js'

describe('StateStoreError', () => {
  it('sets name, code, and message', () => {
    const err = new StateStoreError('TEST_CODE', 'test message')
    expect(err.name).toBe('StateStoreError')
    expect(err.code).toBe('TEST_CODE')
    expect(err.message).toBe('test message')
  })

  it('is an instance of Error', () => {
    expect(new StateStoreError('X', 'y')).toBeInstanceOf(Error)
  })
})

describe('DoltNotInitializedError', () => {
  it('includes repoPath in message', () => {
    const err = new DoltNotInitializedError('/tmp/myrepo')
    expect(err.name).toBe('DoltNotInitializedError')
    expect(err.code).toBe('DOLT_NOT_INITIALIZED')
    expect(err.message).toContain('/tmp/myrepo')
    expect(err.repoPath).toBe('/tmp/myrepo')
  })

  it('is an instance of StateStoreError', () => {
    expect(new DoltNotInitializedError('/tmp')).toBeInstanceOf(StateStoreError)
  })
})

describe('DoltQueryError', () => {
  it('stores sql and detail', () => {
    const err = new DoltQueryError('SELECT 1', 'connection refused')
    expect(err.name).toBe('DoltQueryError')
    expect(err.sql).toBe('SELECT 1')
    expect(err.detail).toBe('connection refused')
    expect(err.message).toContain('connection refused')
  })

  it('is an instance of Error', () => {
    expect(new DoltQueryError('', '')).toBeInstanceOf(Error)
  })
})

describe('DoltMergeConflictError', () => {
  it('stores table and conflicting keys', () => {
    const err = new DoltMergeConflictError('stories', ['26-1', '26-2'])
    expect(err.name).toBe('DoltMergeConflictError')
    expect(err.code).toBe('DOLT_MERGE_CONFLICT')
    expect(err.table).toBe('stories')
    expect(err.conflictingKeys).toEqual(['26-1', '26-2'])
    expect(err.message).toContain('stories')
    expect(err.message).toContain('26-1')
  })

  it('is an instance of StateStoreError', () => {
    expect(new DoltMergeConflictError('t', [])).toBeInstanceOf(StateStoreError)
  })
})
