// @vitest-environment node
/**
 * Unit tests for the createStateStore factory.
 */

import { describe, it, expect, vi } from 'vitest'
import { createStateStore, FileStateStore, DoltStateStore } from '../index.js'

// Suppress logger output
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('createStateStore', () => {
  it('returns a FileStateStore when called with no arguments', () => {
    const store = createStateStore()
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns a FileStateStore when called with { backend: "file" }', () => {
    const store = createStateStore({ backend: 'file' })
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns a FileStateStore when called with { backend: "file", basePath: "/tmp" }', () => {
    const store = createStateStore({ backend: 'file', basePath: '/tmp' })
    expect(store).toBeInstanceOf(FileStateStore)
  })

  it('returns a DoltStateStore when called with { backend: "dolt" }', () => {
    const store = createStateStore({ backend: 'dolt' })
    expect(store).toBeInstanceOf(DoltStateStore)
  })

  it('returns a DoltStateStore when called with { backend: "dolt", basePath: "/tmp/repo" }', () => {
    const store = createStateStore({ backend: 'dolt', basePath: '/tmp/repo' })
    expect(store).toBeInstanceOf(DoltStateStore)
  })
})
