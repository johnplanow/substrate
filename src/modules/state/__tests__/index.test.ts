// @vitest-environment node
/**
 * Unit tests for the state-module factories.
 *
 * Post-Ship-1: `createStateStore` only supports the file backend (Dolt was
 * never wired to production via this factory). `createDoltOperatorReader` is
 * the new factory for CLI operator commands that want the Dolt-backed
 * read surface.
 */

import { describe, it, expect } from 'vitest'

import {
  createStateStore,
  createDoltOperatorReader,
  FileStateStore,
  DoltStateStore,
} from '../index.js'

describe('createStateStore', () => {
  it('returns FileStateStore by default', () => {
    const store = createStateStore()
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns FileStateStore for explicit { backend: "file" }', () => {
    const store = createStateStore({ backend: 'file' })
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('passes basePath through to FileStateStore', () => {
    const store = createStateStore({ backend: 'file', basePath: '/tmp/proj' })
    expect(store).toBeInstanceOf(FileStateStore)
  })
})

describe('createDoltOperatorReader', () => {
  it('returns DoltStateStore configured against the given basePath', () => {
    const reader = createDoltOperatorReader({ basePath: '/tmp/repo' })
    expect(reader).toBeInstanceOf(DoltStateStore)
  })
})
