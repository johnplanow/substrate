/**
 * Tests for resolveMainRepoRoot utility.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { resolve, dirname } from 'node:path'

// Mock child_process.spawn
const mockOn = vi.fn()
const mockStdoutOn = vi.fn()
const mockSpawn = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

import { resolveMainRepoRoot } from '../git-root.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function setupSpawnMock(exitCode: number, stdout: string, error?: Error) {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const stdoutHandlers: Record<string, (...args: unknown[]) => void> = {}

  mockSpawn.mockReturnValue({
    stdout: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        stdoutHandlers[event] = cb
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb
    },
  })

  // Return a function to trigger the events
  return () => {
    if (error) {
      handlers['error']?.(error)
    } else {
      if (stdout) {
        stdoutHandlers['data']?.(Buffer.from(stdout))
      }
      handlers['close']?.(exitCode)
    }
  }
}

describe('resolveMainRepoRoot', () => {
  it('resolves main repo root from relative .git (main worktree)', async () => {
    const trigger = setupSpawnMock(0, '.git\n')

    const promise = resolveMainRepoRoot('/my/project')
    trigger()
    const result = await promise

    // .git relative to /my/project → /my/project/.git → dirname → /my/project
    expect(result).toBe('/my/project')
    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--git-common-dir'],
      { cwd: '/my/project', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  })

  it('resolves main repo root from absolute path (linked worktree)', async () => {
    const trigger = setupSpawnMock(0, '/main/repo/.git\n')

    const promise = resolveMainRepoRoot('/main/repo/.claude/worktrees/feature')
    trigger()
    const result = await promise

    expect(result).toBe('/main/repo')
  })

  it('falls back to cwd on non-zero exit code', async () => {
    const trigger = setupSpawnMock(128, '')

    const promise = resolveMainRepoRoot('/not/a/repo')
    trigger()
    const result = await promise

    expect(result).toBe('/not/a/repo')
  })

  it('falls back to cwd on spawn error', async () => {
    const trigger = setupSpawnMock(0, '', new Error('ENOENT'))

    const promise = resolveMainRepoRoot('/no/git')
    trigger()
    const result = await promise

    expect(result).toBe('/no/git')
  })

  it('falls back to cwd on empty stdout', async () => {
    const trigger = setupSpawnMock(0, '')

    const promise = resolveMainRepoRoot('/empty')
    trigger()
    const result = await promise

    expect(result).toBe('/empty')
  })

  it('defaults cwd to process.cwd() when omitted', async () => {
    const trigger = setupSpawnMock(0, '.git\n')

    const promise = resolveMainRepoRoot()
    trigger()
    await promise

    expect(mockSpawn).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--git-common-dir'],
      expect.objectContaining({ cwd: process.cwd() }),
    )
  })
})
