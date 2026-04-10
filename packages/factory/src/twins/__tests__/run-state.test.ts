/**
 * Unit tests for the run-state helpers.
 *
 * Mocks `node:fs/promises` to avoid real filesystem I/O.
 *
 * Story 47-5 — Task 7.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any imports from mocked modules
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  mkdir: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked functions after vi.mock declarations
// ---------------------------------------------------------------------------

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { runStatePath, readRunState, writeRunState, clearRunState } from '../run-state.js'
import type { TwinRunState } from '../run-state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_DIR = '/test/project'

function makeState(overrides?: Partial<TwinRunState>): TwinRunState {
  return {
    composeDir: '/tmp/abc123',
    twinNames: ['localstack', 'wiremock'],
    startedAt: '2026-03-23T12:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(readFile).mockResolvedValue('' as any)
  vi.mocked(writeFile).mockResolvedValue(undefined)
  vi.mocked(unlink).mockResolvedValue(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(mkdir).mockResolvedValue(undefined as any)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runStatePath', () => {
  it('returns path ending in .substrate/twins/.run-state.json', () => {
    const p = runStatePath(PROJECT_DIR)
    expect(p).toContain('.substrate')
    expect(p).toContain('twins')
    expect(p).toContain('.run-state.json')
    expect(p).toBe(`${PROJECT_DIR}/.substrate/twins/.run-state.json`)
  })
})

describe('readRunState', () => {
  it('returns null when file does not exist (ENOENT)', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    vi.mocked(readFile).mockRejectedValue(err)

    const result = await readRunState(PROJECT_DIR)
    expect(result).toBeNull()
  })

  it('returns parsed TwinRunState when file contains valid JSON', async () => {
    const state = makeState()
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(state) as any)

    const result = await readRunState(PROJECT_DIR)
    expect(result).toEqual(state)
  })

  it('throws when the file contains invalid JSON', async () => {
    vi.mocked(readFile).mockResolvedValue('not valid json }{' as any)

    await expect(readRunState(PROJECT_DIR)).rejects.toThrow()
  })

  it('throws on I/O errors other than ENOENT', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    vi.mocked(readFile).mockRejectedValue(err)

    await expect(readRunState(PROJECT_DIR)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('writeRunState', () => {
  it('calls mkdir with recursive: true before writing', async () => {
    const state = makeState()
    await writeRunState(PROJECT_DIR, state)

    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('.substrate'), { recursive: true })
  })

  it('calls writeFile with the correct JSON content and path', async () => {
    const state = makeState()
    await writeRunState(PROJECT_DIR, state)

    const expectedPath = runStatePath(PROJECT_DIR)
    const expectedContent = JSON.stringify(state, null, 2)
    expect(writeFile).toHaveBeenCalledWith(expectedPath, expectedContent, 'utf-8')
  })
})

describe('clearRunState', () => {
  it('calls unlink with the state file path', async () => {
    await clearRunState(PROJECT_DIR)

    expect(unlink).toHaveBeenCalledWith(runStatePath(PROJECT_DIR))
  })

  it('is a no-op when file does not exist (ENOENT) — does not throw', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    vi.mocked(unlink).mockRejectedValue(err)

    await expect(clearRunState(PROJECT_DIR)).resolves.toBeUndefined()
  })

  it('re-throws I/O errors other than ENOENT', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    vi.mocked(unlink).mockRejectedValue(err)

    await expect(clearRunState(PROJECT_DIR)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
