// @vitest-environment node
/**
 * Unit tests for the degraded-mode-hint shared utility.
 *
 * Story 26-12: CLI Degraded-Mode Hints
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports of the modules under test
// ---------------------------------------------------------------------------

// Hoisted helpers give us references to mock fns before vi.mock factories run
const { mockCheckDoltInstalled, MockDoltNotInstalled } = vi.hoisted(() => {
  class MockDoltNotInstalled extends Error {
    constructor(message = 'dolt not found') {
      super(message)
      this.name = 'DoltNotInstalled'
    }
  }

  return {
    mockCheckDoltInstalled: vi.fn<() => Promise<void>>(),
    MockDoltNotInstalled,
  }
})

vi.mock('../../modules/state/index.js', () => ({
  checkDoltInstalled: mockCheckDoltInstalled,
  DoltNotInstalled: MockDoltNotInstalled,
}))

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(path: string) => boolean>().mockReturnValue(false),
}))

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}))

import { getDegradedModeHint, emitDegradedModeHint } from '../degraded-mode-hint.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDegradedModeHint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns not-installed hint when checkDoltInstalled throws DoltNotInstalled', async () => {
    mockCheckDoltInstalled.mockRejectedValueOnce(new MockDoltNotInstalled())

    const { hint, doltInstalled } = await getDegradedModeHint('/project/.substrate/state')

    expect(doltInstalled).toBe(false)
    expect(hint).toContain('Dolt is not installed')
    expect(hint).toContain('https://docs.dolthub.com/introduction/installation')
    expect(hint).toContain('substrate init --dolt')
  })

  it('returns not-initialized hint when Dolt binary exists but .dolt dir is absent', async () => {
    mockCheckDoltInstalled.mockResolvedValueOnce(undefined)
    mockExistsSync.mockReturnValueOnce(false) // no .dolt directory

    const { hint, doltInstalled } = await getDegradedModeHint('/project/.substrate/state')

    expect(doltInstalled).toBe(true)
    expect(hint).toContain('Dolt is installed but not initialized')
    expect(hint).toContain('substrate init --dolt')
  })

  it('returns generic file-backend hint when .dolt dir exists (edge-case guard)', async () => {
    mockCheckDoltInstalled.mockResolvedValueOnce(undefined)
    mockExistsSync.mockReturnValueOnce(true) // .dolt directory present

    const { hint, doltInstalled } = await getDegradedModeHint('/project/.substrate/state')

    expect(doltInstalled).toBe(true)
    expect(hint).toContain('file backend')
  })

  it('re-throws unexpected errors from checkDoltInstalled', async () => {
    mockCheckDoltInstalled.mockRejectedValueOnce(new Error('unexpected'))

    await expect(getDegradedModeHint('/project/.substrate/state')).rejects.toThrow('unexpected')
  })
})

describe('emitDegradedModeHint', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('writes hint to stderr in text mode (not installed)', async () => {
    mockCheckDoltInstalled.mockRejectedValueOnce(new MockDoltNotInstalled())
    mockExistsSync.mockReturnValue(false)

    await emitDegradedModeHint({
      outputFormat: 'text',
      command: 'diff',
      statePath: '/project/.substrate/state',
    })

    expect(stderrSpy).toHaveBeenCalledOnce()
    const written = String(stderrSpy.mock.calls[0][0])
    expect(written).toContain('Dolt is not installed')
    expect(written).toContain('https://docs.dolthub.com/introduction/installation')
  })

  it('writes hint to stderr in text mode (not initialized)', async () => {
    mockCheckDoltInstalled.mockResolvedValueOnce(undefined)
    mockExistsSync.mockReturnValueOnce(false)

    await emitDegradedModeHint({
      outputFormat: 'text',
      command: 'history',
      statePath: '/project/.substrate/state',
    })

    expect(stderrSpy).toHaveBeenCalledOnce()
    const written = String(stderrSpy.mock.calls[0][0])
    expect(written).toContain('Dolt is installed but not initialized')
    expect(written).toContain('substrate init --dolt')
  })

  it('does NOT write to stderr in JSON mode; returns populated hint field', async () => {
    mockCheckDoltInstalled.mockRejectedValueOnce(new MockDoltNotInstalled())
    mockExistsSync.mockReturnValue(false)

    const result = await emitDegradedModeHint({
      outputFormat: 'json',
      command: 'diff',
      statePath: '/project/.substrate/state',
    })

    expect(stderrSpy).not.toHaveBeenCalled()
    expect(result.hint).toBeTruthy()
    expect(result.hint).toContain('Dolt is not installed')
  })

  it('returns doltInstalled=false when Dolt binary is missing', async () => {
    mockCheckDoltInstalled.mockRejectedValueOnce(new MockDoltNotInstalled())
    mockExistsSync.mockReturnValue(false)

    const result = await emitDegradedModeHint({
      outputFormat: 'text',
      command: 'diff',
      statePath: '/project/.substrate/state',
    })

    expect(result.doltInstalled).toBe(false)
  })

  it('returns doltInstalled=true when Dolt binary is present but not initialized', async () => {
    mockCheckDoltInstalled.mockResolvedValueOnce(undefined)
    mockExistsSync.mockReturnValueOnce(false)

    const result = await emitDegradedModeHint({
      outputFormat: 'text',
      command: 'history',
      statePath: '/project/.substrate/state',
    })

    expect(result.doltInstalled).toBe(true)
  })
})
