// @vitest-environment node
/**
 * Unit tests for dolt-init.ts.
 *
 * All Dolt CLI invocations are mocked via vi.mock('node:child_process').
 * Post-Ship-3: `initializeDolt` no longer applies a DDL file; `initSchema`
 * (called on first `substrate run`) is the sole runtime contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Mocks — must be declared before module imports that use them
// ---------------------------------------------------------------------------

type SpawnMockState = {
  exitCode: number
  errorCode?: string | null
  stdout?: string
}

const spawnState: SpawnMockState = { exitCode: 0, stdout: '' }
const spawnCalls: Array<{ cmd: string; args: string[]; cwd?: string }> = []

vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events')
  const actual = await importOriginal<typeof import('node:child_process')>()

  function mockSpawn(cmd: string, args: string[], options?: { cwd?: string }) {
    spawnCalls.push({ cmd, args, cwd: options?.cwd })

    const ee = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      stdout: EventEmitter
    }
    ee.stderr = new EventEmitter()
    ee.stdout = new EventEmitter()

    setImmediate(() => {
      if (spawnState.errorCode) {
        const err = Object.assign(new Error('spawn error'), {
          code: spawnState.errorCode,
        })
        ee.emit('error', err)
        return
      }
      if (spawnState.stdout) {
        ee.stdout.emit('data', Buffer.from(spawnState.stdout))
      }
      ee.emit('close', spawnState.exitCode)
    })

    return ee
  }

  return { ...actual, spawn: mockSpawn }
})

const mkdirMock = vi.fn().mockResolvedValue(undefined)
let accessShouldResolve = true

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    mkdir: (...args: Parameters<typeof original.mkdir>) => mkdirMock(...args),
    access: (...args: Parameters<typeof original.access>) => {
      if (accessShouldResolve) return Promise.resolve()
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    },
  }
})

import {
  checkDoltInstalled,
  initializeDolt,
  DoltNotInstalled,
  DoltInitError,
} from '../dolt-init.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetSpawnCalls() {
  spawnCalls.length = 0
}

function setSpawnExit(code: number, errorCode?: string, stdout?: string) {
  spawnState.exitCode = code
  spawnState.errorCode = errorCode ?? null
  spawnState.stdout = stdout ?? ''
}

// ---------------------------------------------------------------------------
// checkDoltInstalled
// ---------------------------------------------------------------------------

describe('checkDoltInstalled', () => {
  beforeEach(() => {
    resetSpawnCalls()
    setSpawnExit(0)
  })

  it('resolves when dolt version exits 0', async () => {
    await expect(checkDoltInstalled()).resolves.toBeUndefined()
    expect(spawnCalls[0]?.args).toEqual(['version'])
  })

  it('throws DoltNotInstalled when spawn emits ENOENT error', async () => {
    setSpawnExit(0, 'ENOENT')
    await expect(checkDoltInstalled()).rejects.toBeInstanceOf(DoltNotInstalled)
  })

  it('DoltNotInstalled message contains "Dolt CLI not found"', async () => {
    setSpawnExit(0, 'ENOENT')
    await expect(checkDoltInstalled()).rejects.toThrow('Dolt CLI not found')
  })

  it('DoltNotInstalled message contains the install URL', async () => {
    setSpawnExit(0, 'ENOENT')
    await expect(checkDoltInstalled()).rejects.toThrow(
      'https://docs.dolthub.com/introduction/installation',
    )
  })
})

// ---------------------------------------------------------------------------
// initializeDolt — first run (no .dolt/ dir)
// ---------------------------------------------------------------------------

describe('initializeDolt — first run', () => {
  beforeEach(() => {
    resetSpawnCalls()
    mkdirMock.mockResolvedValue(undefined)
    setSpawnExit(0)
    accessShouldResolve = false
  })

  it('calls dolt init when .dolt/ does not exist', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })

    const initCall = spawnCalls.find((c) => c.args[0] === 'init')
    expect(initCall).toBeDefined()
    expect(initCall?.cmd).toBe('dolt')
  })

  it('does NOT call dolt sql -f (post-Ship-3: no DDL file)', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })

    const sqlCall = spawnCalls.find((c) => c.args[0] === 'sql')
    expect(sqlCall).toBeUndefined()
  })

  it('calls dolt add -A and dolt commit when no commits exist', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })

    const addCall = spawnCalls.find((c) => c.args[0] === 'add')
    expect(addCall).toBeDefined()
    expect(addCall?.args[1]).toBe('-A')

    const commitCall = spawnCalls.find((c) => c.args[0] === 'commit')
    expect(commitCall).toBeDefined()
    expect(commitCall?.args).toContain('Initialize substrate state repo')
    // --allow-empty so the commit works even though no DDL was applied
    expect(commitCall?.args).toContain('--allow-empty')
  })

  it('calls mkdir with { recursive: true } on statePath', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })
    expect(mkdirMock).toHaveBeenCalledWith(
      expect.stringContaining('.substrate'),
      { recursive: true },
    )
  })

  it('commands run in correct order: init → log → add → commit (no sql)', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })
    const commands = spawnCalls.map((c) => c.args[0])
    const initIdx = commands.indexOf('init')
    const logIdx = commands.indexOf('log')
    const addIdx = commands.indexOf('add')
    const commitIdx = commands.indexOf('commit')
    expect(initIdx).toBeLessThan(logIdx)
    expect(logIdx).toBeLessThan(addIdx)
    expect(addIdx).toBeLessThan(commitIdx)
    // No sql call in the sequence
    expect(commands).not.toContain('sql')
  })
})

// ---------------------------------------------------------------------------
// initializeDolt — idempotency (.dolt/ already exists)
// ---------------------------------------------------------------------------

describe('initializeDolt — idempotency', () => {
  beforeEach(() => {
    resetSpawnCalls()
    mkdirMock.mockResolvedValue(undefined)
    setSpawnExit(0)
    accessShouldResolve = true
  })

  it('does NOT call dolt init when .dolt/ already exists', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })
    const initCall = spawnCalls.find((c) => c.args[0] === 'init')
    expect(initCall).toBeUndefined()
  })

  it('still checks for existing commits via dolt log', async () => {
    await initializeDolt({ projectRoot: '/fake/project' })
    const logCall = spawnCalls.find((c) => c.args[0] === 'log')
    expect(logCall).toBeDefined()
  })

  it('does NOT commit again when commits already exist', async () => {
    setSpawnExit(0, undefined, 'abc123 Initialize substrate state repo\n')

    await initializeDolt({ projectRoot: '/fake/project' })

    const commitCall = spawnCalls.find((c) => c.args[0] === 'commit')
    expect(commitCall).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// initializeDolt — error propagation
// ---------------------------------------------------------------------------

describe('initializeDolt — error propagation', () => {
  beforeEach(() => {
    resetSpawnCalls()
    mkdirMock.mockResolvedValue(undefined)
    accessShouldResolve = false
  })

  it('propagates DoltNotInstalled when spawn emits ENOENT on version check', async () => {
    setSpawnExit(0, 'ENOENT')
    await expect(initializeDolt({ projectRoot: '/fake/project' })).rejects.toBeInstanceOf(
      DoltNotInstalled,
    )
  })

  it('propagates DoltInitError when dolt init exits non-zero', async () => {
    setSpawnExit(1)
    await expect(initializeDolt({ projectRoot: '/fake/project' })).rejects.toBeInstanceOf(
      DoltInitError,
    )
  })

  it('DoltInitError message contains the failing command', async () => {
    setSpawnExit(1)
    await expect(initializeDolt({ projectRoot: '/fake/project' })).rejects.toThrow('dolt')
  })
})
