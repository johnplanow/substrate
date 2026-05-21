// @vitest-environment node
/**
 * Unit tests for the state-module factories.
 *
 * Post-Ship-2 (Item 7 arc, v0.20.107):
 *  - `createStateStore` + `StateStore` interface deleted (the orchestrator-side
 *    surface was dead code in production)
 *  - `FileStateStore` renamed to `FileKvStore` — narrow KV store for routing
 *    telemetry only (constructed directly, no factory needed)
 *  - `createDoltOperatorReader` is the only factory now — returns the
 *    Dolt-backed read surface for CLI operator commands
 */

import { describe, it, expect } from 'vitest'

import {
  createDoltOperatorReader,
  DoltStateStore,
  FileKvStore,
} from '../index.js'

describe('FileKvStore', () => {
  it('can be constructed with no options (in-memory mode)', () => {
    const store = new FileKvStore()
    expect(store).toBeInstanceOf(FileKvStore)
  })

  it('can be constructed with a basePath (persistent mode)', () => {
    const store = new FileKvStore({ basePath: '/tmp/proj' })
    expect(store).toBeInstanceOf(FileKvStore)
  })
})

describe('createDoltOperatorReader', () => {
  it('returns DoltStateStore configured against the given basePath', () => {
    const reader = createDoltOperatorReader({ basePath: '/tmp/repo' })
    expect(reader).toBeInstanceOf(DoltStateStore)
  })
})
