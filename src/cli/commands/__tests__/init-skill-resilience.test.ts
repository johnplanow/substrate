/**
 * Per-skill error tolerance in `syncSkillsToTarget` — F3 in the v0.20.132 batch.
 *
 * Before: an EPERM (or any I/O error) from `cpSync` on ONE skill propagated up
 * and aborted the entire `scaffoldCodexProject`, silently dropping every
 * subsequent skill. The user-reported symptom was a single warning naming
 * `bmad-advanced-elicitation` while the other skills also vanished. After:
 * each skill is tried independently; failures are logged by name and the loop
 * continues so the rest of the skills land.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// fs mock — declared before the SUT import (vi.mock hoists)
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn().mockReturnValue(true)
const mockReaddirSync = vi.fn()
const mockRmSync = vi.fn()
const mockCpSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
  // The init module imports several other fs APIs at top level; supply
  // inert vi.fns so the import resolves. We only exercise the four above.
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  chmodSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import under test AFTER mocks
// ---------------------------------------------------------------------------

import { syncSkillsToTarget } from '../init.js'

function entry(name: string): { name: string; isDirectory: () => boolean } {
  return { name, isDirectory: () => true }
}

describe('syncSkillsToTarget — per-skill EPERM tolerance', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true)
    mockReaddirSync.mockReset()
    mockRmSync.mockReset()
    mockCpSync.mockReset()
  })

  it('continues past one failing skill so the others still land', () => {
    // Three skills; the second throws EPERM (the reported failure mode).
    mockReaddirSync.mockReturnValue([entry('bmad-a'), entry('bmad-advanced-elicitation'), entry('bmad-c')])
    mockCpSync.mockImplementation((_src: string, dest: string) => {
      if (String(dest).includes('bmad-advanced-elicitation')) {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error('EPERM: operation not permitted'),
          { code: 'EPERM' },
        )
        throw err
      }
    })

    const count = syncSkillsToTarget('/src', '/dest', [], '')

    // The two healthy skills were copied; only the EPERM one was skipped.
    expect(count).toBe(2)
    expect(mockCpSync).toHaveBeenCalledTimes(3)
    const cpDests = mockCpSync.mock.calls.map((c) => String(c[1]))
    expect(cpDests).toContain('/dest/bmad-a')
    expect(cpDests).toContain('/dest/bmad-c')
  })

  it('returns 0 (no failure) when EVERY skill fails — but does not throw', () => {
    mockReaddirSync.mockReturnValue([entry('x'), entry('y')])
    mockCpSync.mockImplementation(() => {
      throw new Error('EPERM')
    })

    // The contract: never throw — the outer scaffold reports a warning and
    // init continues. A run where all skills happen to fail still returns 0.
    expect(() => syncSkillsToTarget('/src', '/dest', [], '')).not.toThrow()
    expect(syncSkillsToTarget('/src', '/dest', [], '')).toBe(0)
  })

  it('still returns 0 when the source directory is missing (existing contract)', () => {
    mockExistsSync.mockReturnValue(false)
    expect(syncSkillsToTarget('/missing', '/dest', [], '')).toBe(0)
    expect(mockCpSync).not.toHaveBeenCalled()
  })
})
