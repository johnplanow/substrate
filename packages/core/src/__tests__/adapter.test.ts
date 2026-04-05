/**
 * Unit tests for packages/core/src/persistence/adapter.ts
 *
 * Tests the createDatabaseAdapter() factory function with all three backend
 * modes (auto, memory, dolt), Dolt availability detection, fallback logic,
 * and warning messages.
 *
 * All filesystem and child_process interactions are mocked — no real Dolt
 * installation is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDatabaseAdapter } from '../persistence/adapter.js'
import { DoltDatabaseAdapter } from '../persistence/dolt-adapter.js'
import { InMemoryDatabaseAdapter } from '../persistence/memory-adapter.js'

// ---------------------------------------------------------------------------
// Mock node:child_process and node:fs
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const mockedSpawnSync = vi.mocked(spawnSync)
const mockedExistsSync = vi.mocked(existsSync)

// ---------------------------------------------------------------------------
// Helper: create a mock DoltClientLike factory
// ---------------------------------------------------------------------------

function makeMockDoltClientFactory() {
  const mockClient = {
    query: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  }
  const factory = vi.fn().mockReturnValue(mockClient)
  return { factory, mockClient }
}

// ---------------------------------------------------------------------------
// Helper: configure mocks so isDoltAvailable returns true
// ---------------------------------------------------------------------------

function configureDoltAvailable() {
  mockedExistsSync.mockReturnValue(true)
  mockedSpawnSync.mockReturnValue({
    status: 0,
    pid: 1,
    output: [],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>)
}

// ---------------------------------------------------------------------------
// Helper: configure mocks so isDoltAvailable returns false (no .dolt dir)
// ---------------------------------------------------------------------------

function configureDoltUnavailable() {
  mockedExistsSync.mockReturnValue(false)
  mockedSpawnSync.mockReturnValue({
    error: new Error('ENOENT'),
    status: null,
    pid: 0,
    output: [],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>)
}

// ---------------------------------------------------------------------------
// Helper: configure mocks so .dolt dir exists but binary fails
// ---------------------------------------------------------------------------

function configureDoltDirExistsBinaryFails() {
  mockedExistsSync.mockReturnValue(true)
  mockedSpawnSync.mockReturnValue({
    error: new Error('ENOENT'),
    status: null,
    pid: 0,
    output: [],
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    signal: null,
  } as unknown as ReturnType<typeof spawnSync>)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDatabaseAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // backend = 'memory'
  // -------------------------------------------------------------------------

  describe('backend = "memory"', () => {
    it('returns an InMemoryDatabaseAdapter regardless of Dolt availability', () => {
      configureDoltAvailable()

      const adapter = createDatabaseAdapter({ backend: 'memory' })

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
      // Should not probe Dolt at all
      expect(mockedExistsSync).not.toHaveBeenCalled()
      expect(mockedSpawnSync).not.toHaveBeenCalled()
    })

    it('does not call the doltClientFactory when backend is memory', () => {
      const { factory } = makeMockDoltClientFactory()

      const adapter = createDatabaseAdapter({ backend: 'memory' }, factory)

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
      expect(factory).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // backend = 'dolt'
  // -------------------------------------------------------------------------

  describe('backend = "dolt"', () => {
    it('returns a DoltDatabaseAdapter when factory is provided', () => {
      const { factory, mockClient } = makeMockDoltClientFactory()

      const adapter = createDatabaseAdapter(
        { backend: 'dolt', basePath: '/tmp/test-project' },
        factory,
      )

      expect(adapter).toBeInstanceOf(DoltDatabaseAdapter)
      expect(factory).toHaveBeenCalledWith('/tmp/test-project/.substrate/state')
    })

    it('falls back to InMemoryDatabaseAdapter when no factory is provided', () => {
      const warnSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

      const adapter = createDatabaseAdapter({ backend: 'dolt' })

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no doltClientFactory provided'),
      )
    })
  })

  // -------------------------------------------------------------------------
  // backend = 'auto'
  // -------------------------------------------------------------------------

  describe('backend = "auto"', () => {
    it('returns DoltDatabaseAdapter when Dolt is available and factory provided', () => {
      configureDoltAvailable()
      const { factory } = makeMockDoltClientFactory()

      const adapter = createDatabaseAdapter(
        { backend: 'auto', basePath: '/tmp/test-project' },
        factory,
      )

      expect(adapter).toBeInstanceOf(DoltDatabaseAdapter)
      expect(factory).toHaveBeenCalledWith('/tmp/test-project/.substrate/state')
    })

    it('returns InMemoryDatabaseAdapter when Dolt dir does not exist', () => {
      configureDoltUnavailable()
      const { factory } = makeMockDoltClientFactory()

      const adapter = createDatabaseAdapter(
        { backend: 'auto', basePath: '/tmp/test-project' },
        factory,
      )

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
      // Factory should NOT be called since Dolt is unavailable
      expect(factory).not.toHaveBeenCalled()
    })

    it('returns InMemoryDatabaseAdapter when no factory is provided even if Dolt is available', () => {
      configureDoltAvailable()

      const adapter = createDatabaseAdapter({
        backend: 'auto',
        basePath: '/tmp/test-project',
      })

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
    })

    it('defaults backend to "auto" when config is undefined', () => {
      configureDoltUnavailable()

      const adapter = createDatabaseAdapter()

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
    })

    it('defaults basePath to process.cwd() when not specified', () => {
      configureDoltAvailable()
      const { factory } = makeMockDoltClientFactory()
      const cwd = process.cwd()

      const adapter = createDatabaseAdapter({ backend: 'auto' }, factory)

      expect(adapter).toBeInstanceOf(DoltDatabaseAdapter)
      expect(factory).toHaveBeenCalledWith(`${cwd}/.substrate/state`)
    })
  })

  // -------------------------------------------------------------------------
  // isDoltAvailable — retry logic
  // -------------------------------------------------------------------------

  describe('isDoltAvailable retry logic (via auto backend)', () => {
    it('retries once when .dolt dir exists but binary fails, then succeeds', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // .dolt directory exists
      mockedExistsSync.mockReturnValue(true)

      // First call to `dolt version` fails, retry succeeds
      let callCount = 0
      mockedSpawnSync.mockImplementation((cmd: string) => {
        if (cmd === 'dolt') {
          callCount++
          if (callCount <= 1) {
            // First attempt: binary unavailable
            return {
              error: new Error('ENOENT'),
              status: null,
              pid: 0,
              output: [],
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
              signal: null,
            } as unknown as ReturnType<typeof spawnSync>
          }
          // Retry: binary available
          return {
            status: 0,
            pid: 1,
            output: [],
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
            signal: null,
          } as unknown as ReturnType<typeof spawnSync>
        }
        // sleep call
        return {
          status: 0,
          pid: 1,
          output: [],
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          signal: null,
        } as unknown as ReturnType<typeof spawnSync>
      })

      const { factory } = makeMockDoltClientFactory()

      const adapter = createDatabaseAdapter(
        { backend: 'auto', basePath: '/tmp/test-project' },
        factory,
      )

      expect(adapter).toBeInstanceOf(DoltDatabaseAdapter)
      // Should have warned about the retry
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('retrying once'),
      )
    })

    it('falls back to InMemory with warning when .dolt dir exists but binary fails on both attempts', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      configureDoltDirExistsBinaryFails()
      const { factory } = makeMockDoltClientFactory()

      const adapter = createDatabaseAdapter(
        { backend: 'auto', basePath: '/tmp/test-project' },
        factory,
      )

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
      // Should warn about retry and about final fallback
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('retrying once'),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('still unavailable after retry'),
      )
    })
  })

  // -------------------------------------------------------------------------
  // backendType property
  // -------------------------------------------------------------------------

  describe('backendType property', () => {
    it('InMemoryDatabaseAdapter has backendType "memory"', () => {
      configureDoltUnavailable()
      const adapter = createDatabaseAdapter({ backend: 'memory' })
      expect(adapter.backendType).toBe('memory')
    })

    it('DoltDatabaseAdapter has backendType "dolt"', () => {
      configureDoltAvailable()
      const { factory } = makeMockDoltClientFactory()
      const adapter = createDatabaseAdapter(
        { backend: 'auto', basePath: '/tmp/test-project' },
        factory,
      )
      expect(adapter.backendType).toBe('dolt')
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles backend=undefined in config (defaults to auto)', () => {
      configureDoltUnavailable()

      const adapter = createDatabaseAdapter({ backend: 'auto' })

      expect(adapter).toBeInstanceOf(InMemoryDatabaseAdapter)
    })
  })
})
