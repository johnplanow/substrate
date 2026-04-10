// @vitest-environment node
/**
 * Unit tests for dolt-init.ts
 *
 * All Dolt CLI invocations are mocked via vi.mock('node:child_process').
 * Schema content validation uses real fs.readFile against the bundled
 * schema.sql file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Mocks — must be declared before module imports that use them
// ---------------------------------------------------------------------------

// We need mutable state so tests can configure different behaviours.
type SpawnMockState = {
  exitCode: number
  errorCode?: string | null
  stdout?: string
}

const spawnState: SpawnMockState = { exitCode: 0, stdout: '' }

// Keep track of all spawn calls for assertion
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

// fs/promises mock — only mock mkdir and access, allow readFile to pass through
const mkdirMock = vi.fn().mockResolvedValue(undefined)
// By default access resolves (i.e., .dolt/ dir exists); individual tests override this
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

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------
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
      'https://docs.dolthub.com/introduction/installation'
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
    // .dolt/ does NOT exist on first run
    accessShouldResolve = false
  })

  it('calls dolt init when .dolt/ does not exist', async () => {
    // Override stdout for dolt log to return empty (no commits)
    // We'll use a simple approach: all commands exit 0, log returns empty stdout
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })

    const initCall = spawnCalls.find((c) => c.args[0] === 'init')
    expect(initCall).toBeDefined()
    expect(initCall?.cmd).toBe('dolt')
  })

  it('calls dolt sql -f <schemaPath> after init', async () => {
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })

    const sqlCall = spawnCalls.find((c) => c.args[0] === 'sql')
    expect(sqlCall).toBeDefined()
    expect(sqlCall?.args[1]).toBe('-f')
  })

  it('calls dolt add -A and dolt commit when no commits exist', async () => {
    // log returns empty output → no commits → should commit
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })

    const addCall = spawnCalls.find((c) => c.args[0] === 'add')
    expect(addCall).toBeDefined()
    expect(addCall?.args[1]).toBe('-A')

    const commitCall = spawnCalls.find((c) => c.args[0] === 'commit')
    expect(commitCall).toBeDefined()
    expect(commitCall?.args).toContain('Initialize substrate state schema v1')
  })

  it('calls mkdir with { recursive: true } on statePath', async () => {
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining('.substrate'), {
      recursive: true,
    })
  })

  it('commands run in correct order: init → sql → log → add → commit', async () => {
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    const commands = spawnCalls.map((c) => c.args[0])
    const initIdx = commands.indexOf('init')
    const sqlIdx = commands.indexOf('sql')
    const logIdx = commands.indexOf('log')
    const addIdx = commands.indexOf('add')
    const commitIdx = commands.indexOf('commit')
    expect(initIdx).toBeLessThan(sqlIdx)
    expect(sqlIdx).toBeLessThan(logIdx)
    expect(logIdx).toBeLessThan(addIdx)
    expect(addIdx).toBeLessThan(commitIdx)
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
    // .dolt/ already exists
    accessShouldResolve = true
  })

  it('does NOT call dolt init when .dolt/ already exists', async () => {
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    const initCall = spawnCalls.find((c) => c.args[0] === 'init')
    expect(initCall).toBeUndefined()
  })

  it('still calls dolt sql -f to apply DDL', async () => {
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    const sqlCall = spawnCalls.find((c) => c.args[0] === 'sql')
    expect(sqlCall).toBeDefined()
  })

  it('still checks for existing commits via dolt log', async () => {
    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    const logCall = spawnCalls.find((c) => c.args[0] === 'log')
    expect(logCall).toBeDefined()
  })

  it('does NOT commit again when commits already exist', async () => {
    // Return a non-empty log (has commits)
    setSpawnExit(0, undefined, 'abc123 Initialize substrate state schema v1\n')

    await initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })

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
    await expect(
      initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    ).rejects.toBeInstanceOf(DoltNotInstalled)
  })

  it('propagates DoltInitError when dolt init exits non-zero', async () => {
    // checkDoltInstalled resolves even on exit 1 (binary found but unhealthy).
    // runDoltCommand('init') with exit 1 throws DoltInitError.
    setSpawnExit(1)
    await expect(
      initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    ).rejects.toBeInstanceOf(DoltInitError)
  })

  it('DoltInitError message contains the failing command', async () => {
    setSpawnExit(1)
    await expect(
      initializeDolt({ projectRoot: '/fake/project', schemaPath: '/fake/project/schema.sql' })
    ).rejects.toThrow('dolt')
  })
})

// ---------------------------------------------------------------------------
// schema.sql content validation
// ---------------------------------------------------------------------------

const SCHEMA_PATH = fileURLToPath(new URL('../../state/schema.sql', import.meta.url))

describe('schema.sql content validation', () => {
  let schemaContent: string

  beforeEach(async () => {
    schemaContent = await readFile(SCHEMA_PATH, 'utf8')
  })

  it('schema.sql file exists and is non-empty', () => {
    expect(schemaContent.length).toBeGreaterThan(0)
  })

  const EXPECTED_TABLES = [
    'stories',
    'contracts',
    'metrics',
    'dispatch_log',
    'build_results',
    'review_verdicts',
    '_schema_version',
  ]

  for (const table of EXPECTED_TABLES) {
    it(`defines table "${table}" with CREATE TABLE IF NOT EXISTS`, () => {
      expect(schemaContent).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'))
    })

    it(`table "${table}" has a PRIMARY KEY clause`, () => {
      // Find the CREATE TABLE block for this table and check it contains PRIMARY KEY
      const tableBlockMatch = schemaContent.match(
        new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]*?\\);`, 'i')
      )
      expect(tableBlockMatch).not.toBeNull()
      expect(tableBlockMatch![0]).toMatch(/PRIMARY KEY/i)
    })
  }

  it('does not use AUTO_INCREMENT outside repo_map_symbols', () => {
    // repo_map_symbols uses BIGINT AUTO_INCREMENT per story 28-2 spec
    const withoutRepoMapSymbols = schemaContent.replace(
      /CREATE TABLE IF NOT EXISTS repo_map_symbols[\s\S]*?\);/i,
      ''
    )
    expect(withoutRepoMapSymbols).not.toMatch(/AUTO_INCREMENT/i)
  })

  it('inserts schema version 1 with INSERT IGNORE', () => {
    expect(schemaContent).toMatch(/INSERT IGNORE INTO _schema_version/)
    expect(schemaContent).toMatch(/VALUES\s*\(\s*1\s*,/)
  })

  it('schema version description matches spec', () => {
    expect(schemaContent).toMatch(/Initial substrate state schema/)
  })

  it('uses DATETIME for time columns (not TIMESTAMP column type)', () => {
    // Confirm at least some DATETIME columns exist
    expect(schemaContent).toMatch(/DATETIME/)
    // No TIMESTAMP as a column type — only CURRENT_TIMESTAMP (default value) is permitted.
    // Match " TIMESTAMP" followed by space or comma (the column type pattern), not CURRENT_TIMESTAMP.
    expect(schemaContent).not.toMatch(/\s+TIMESTAMP\s+(NOT NULL|DEFAULT|,|\))/i)
  })
})
