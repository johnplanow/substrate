/**
 * E2E tests for Story 3.3: Worktree List CLI Command
 *
 * Tests the full flow from CLI command invocation through GitWorktreeManagerImpl
 * to output rendering. Uses mocked git-utils and fs/promises to avoid actual
 * git operations.
 *
 * Scenarios covered:
 *  - AC1: List command shows all worktrees with required fields
 *  - AC2: JSON output format with --json and --output-format json
 *  - AC3: Empty worktrees scenario
 *  - AC4: Filtering by task status
 *  - AC5: Sorting options
 *  - AC6: Task status shown in output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerWorktreesCommand } from '../../cli/commands/worktrees.js'

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: vi.fn(async () => undefined),   // Default: path exists
    readdir: vi.fn(async () => []),         // Default: empty directory
    stat: vi.fn(async () => ({
      birthtime: new Date('2024-01-15T10:00:00Z'),
      ctime: new Date('2024-01-15T10:00:00Z'),
      isDirectory: () => true,
    })),
  }
})

import * as fsp from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Mock git-utils
// ---------------------------------------------------------------------------

vi.mock(import('../../modules/git-worktree/git-utils.js'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    verifyGitVersion: vi.fn(async () => {}),
    createWorktree: vi.fn(async () => ({ worktreePath: '/tmp/worktree' })),
    removeWorktree: vi.fn(async () => {}),
    removeBranch: vi.fn(async () => true),
    getOrphanedWorktrees: vi.fn(async () => []),
    simulateMerge: vi.fn(async () => true),
    abortMerge: vi.fn(async () => {}),
    getConflictingFiles: vi.fn(async () => []),
    performMerge: vi.fn(async () => true),
    getMergedFiles: vi.fn(async () => []),
  }
})

import * as gitUtils from '../../modules/git-worktree/git-utils.js'

// ---------------------------------------------------------------------------
// Output capture helpers
// ---------------------------------------------------------------------------

let capturedOutput: string
let capturedError: string

function setupCapture(): void {
  capturedOutput = ''
  capturedError = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    capturedOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    capturedError += typeof data === 'string' ? data : data.toString()
    return true
  })
}

async function runWorktreesCommand(
  args: string[],
  projectRoot = '/project',
): Promise<{ output: string; error: string; exitCode: number }> {
  setupCapture()
  const program = new Command()
  program.exitOverride()
  registerWorktreesCommand(program, '0.1.0', projectRoot)

  const originalExitCode = process.exitCode
  process.exitCode = undefined

  try {
    await program.parseAsync(['node', 'substrate', 'worktrees', ...args])
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('process.exit(')) {
      // expected
    } else {
      const cmdErr = err as { code?: string }
      if (cmdErr.code !== 'commander.helpDisplayed') {
        throw err
      }
    }
  }

  const resultExitCode = typeof process.exitCode === 'number' ? process.exitCode : -1
  process.exitCode = originalExitCode

  return { output: capturedOutput, error: capturedError, exitCode: resultExitCode }
}

// ---------------------------------------------------------------------------
// Scenario: Empty worktrees directory
// ---------------------------------------------------------------------------

describe('E2E: AC3 - Empty worktrees handling', () => {
  beforeEach(() => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('displays "No active worktrees" when no worktrees exist', async () => {
    const { output, exitCode } = await runWorktreesCommand([])
    expect(output).toContain('No active worktrees')
    expect(exitCode).toBe(0)
  })

  it('exits with code 0 (success) for empty state', async () => {
    const { exitCode } = await runWorktreesCommand([])
    expect(exitCode).toBe(0)
  })

  it('shows empty JSON array for empty state with --json', async () => {
    const { output, exitCode } = await runWorktreesCommand(['--json'])
    const parsed = JSON.parse(output) as { data: unknown[] }
    expect(parsed.data).toHaveLength(0)
    expect(exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario: Single worktree
// ---------------------------------------------------------------------------

describe('E2E: AC1 - Single worktree listing', () => {
  beforeEach(() => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      '/project/.substrate-worktrees/task-001',
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-01-15T10:00:00Z'),
      ctime: new Date('2024-01-15T10:00:00Z'),
      isDirectory: () => true,
    } as unknown as import('fs').Stats)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows task ID in table output', async () => {
    const { output } = await runWorktreesCommand([])
    expect(output).toContain('task-001')
  })

  it('shows branch name in table output', async () => {
    const { output } = await runWorktreesCommand([])
    expect(output).toContain('substrate/task-task-001')
  })

  it('shows worktree path in table output', async () => {
    const { output } = await runWorktreesCommand([])
    expect(output).toContain('.substrate-worktrees/task-001')
  })

  it('shows task status in table output (AC6)', async () => {
    const { output } = await runWorktreesCommand([])
    expect(output).toContain('running')
  })

  it('shows creation timestamp in table output', async () => {
    const { output } = await runWorktreesCommand([])
    expect(output).toContain('2024')
  })

  it('output has table headers', async () => {
    const { output } = await runWorktreesCommand([])
    expect(output).toContain('Task ID')
    expect(output).toContain('Branch')
    expect(output).toContain('Status')
    expect(output).toContain('Created')
  })

  it('exits with code 0', async () => {
    const { exitCode } = await runWorktreesCommand([])
    expect(exitCode).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Scenario: JSON output (AC2)
// ---------------------------------------------------------------------------

describe('E2E: AC2 - JSON output format', () => {
  beforeEach(() => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      '/project/.substrate-worktrees/task-001',
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-01-15T10:00:00Z'),
      ctime: new Date('2024-01-15T10:00:00Z'),
      isDirectory: () => true,
    } as unknown as import('fs').Stats)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('outputs valid JSON with --output-format json', async () => {
    const { output } = await runWorktreesCommand(['--output-format', 'json'])
    expect((): void => { JSON.parse(output) }).not.toThrow()
  })

  it('outputs valid JSON with --json shorthand', async () => {
    const { output } = await runWorktreesCommand(['--json'])
    expect((): void => { JSON.parse(output) }).not.toThrow()
  })

  it('JSON contains worktree array in data field', async () => {
    const { output } = await runWorktreesCommand(['--json'])
    const parsed = JSON.parse(output) as { data: unknown[] }
    expect(Array.isArray(parsed.data)).toBe(true)
    expect(parsed.data).toHaveLength(1)
  })

  it('JSON entry has all required AC2 fields', async () => {
    const { output } = await runWorktreesCommand(['--json'])
    const parsed = JSON.parse(output) as {
      data: { taskId: string; branchName: string; worktreePath: string; taskStatus: string; createdAt: string; completedAt: string | null }[]
    }
    const entry = parsed.data[0]
    expect(entry).toHaveProperty('taskId', 'task-001')
    expect(entry).toHaveProperty('branchName', 'substrate/task-task-001')
    expect(entry).toHaveProperty('worktreePath')
    expect(entry).toHaveProperty('taskStatus')
    expect(entry).toHaveProperty('createdAt')
    expect(entry).toHaveProperty('completedAt')
  })

  it('JSON output ends with newline (jq compatibility)', async () => {
    const { output } = await runWorktreesCommand(['--json'])
    expect(output.endsWith('\n')).toBe(true)
  })

  it('--json and --output-format json produce same data structure', async () => {
    const { output: jsonFull } = await runWorktreesCommand(['--output-format', 'json'])
    const { output: jsonShort } = await runWorktreesCommand(['--json'])
    const fullData = (JSON.parse(jsonFull) as { data: unknown[] }).data
    const shortData = (JSON.parse(jsonShort) as { data: unknown[] }).data
    expect(fullData).toHaveLength(shortData.length)
  })
})

// ---------------------------------------------------------------------------
// Scenario: Multiple worktrees with sorting (AC5)
// ---------------------------------------------------------------------------

describe('E2E: AC5 - Sorting and ordering', () => {
  beforeEach(() => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      '/project/.substrate-worktrees/task-b',
      '/project/.substrate-worktrees/task-a',
      '/project/.substrate-worktrees/task-c',
    ])
    // Return different dates per stat call based on path
    vi.mocked(fsp.stat).mockImplementation(async (filePath: string | Buffer | URL) => {
      const path = typeof filePath === 'string' ? filePath : filePath.toString()
      const dateMap: Record<string, Date> = {
        '/project/.substrate-worktrees/task-a': new Date('2024-01-14T08:00:00Z'),
        '/project/.substrate-worktrees/task-b': new Date('2024-01-16T12:00:00Z'),
        '/project/.substrate-worktrees/task-c': new Date('2024-01-15T10:00:00Z'),
      }
      const date = dateMap[path] ?? new Date('2024-01-15T10:00:00Z')
      return {
        birthtime: date,
        ctime: date,
        isDirectory: () => true,
      } as unknown as import('fs').Stats
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('default sort is newest first (created)', async () => {
    const { output } = await runWorktreesCommand(['--json'])
    const parsed = JSON.parse(output) as { data: { taskId: string }[] }
    expect(parsed.data[0].taskId).toBe('task-b')  // 2024-01-16 newest
  })

  it('--sort task-id sorts alphabetically', async () => {
    const { output } = await runWorktreesCommand(['--sort', 'task-id', '--json'])
    const parsed = JSON.parse(output) as { data: { taskId: string }[] }
    expect(parsed.data[0].taskId).toBe('task-a')
    expect(parsed.data[1].taskId).toBe('task-b')
    expect(parsed.data[2].taskId).toBe('task-c')
  })

  it('--sort created sorts newest first', async () => {
    const { output } = await runWorktreesCommand(['--sort', 'created', '--json'])
    const parsed = JSON.parse(output) as { data: { taskId: string }[] }
    expect(parsed.data[0].taskId).toBe('task-b')  // newest
    expect(parsed.data[2].taskId).toBe('task-a')  // oldest
  })
})

// ---------------------------------------------------------------------------
// Scenario: Filtering by status (AC4)
// ---------------------------------------------------------------------------

describe('E2E: AC4 - Filtering by task status', () => {
  beforeEach(() => {
    vi.mocked(gitUtils.getOrphanedWorktrees).mockResolvedValue([
      '/project/.substrate-worktrees/task-001',
    ])
    vi.mocked(fsp.stat).mockResolvedValue({
      birthtime: new Date('2024-01-15T10:00:00Z'),
      ctime: new Date('2024-01-15T10:00:00Z'),
      isDirectory: () => true,
    } as unknown as import('fs').Stats)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('filters by running status shows worktrees with running status', async () => {
    // All worktrees default to 'running' status
    const { output, exitCode } = await runWorktreesCommand(['--status', 'running'])
    expect(output).toContain('task-001')
    expect(exitCode).toBe(0)
  })

  it('filters by completed shows no worktrees (all default to running)', async () => {
    const { output } = await runWorktreesCommand(['--status', 'completed'])
    expect(output).toContain('No active worktrees')
  })

  it('rejects invalid status values', async () => {
    const { error, exitCode } = await runWorktreesCommand(['--status', 'invalid'])
    expect(error).toContain('Invalid status')
    expect(exitCode).toBe(1)
  })
})
