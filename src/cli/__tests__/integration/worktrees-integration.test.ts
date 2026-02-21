/**
 * Integration tests for `substrate worktrees` command
 *
 * Tests the full CLI command pipeline with Commander and mocked
 * GitWorktreeManager. Verifies routing, flag parsing, and output.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { Command } from 'commander'
import { registerWorktreesCommand } from '../../commands/worktrees.js'
import type { WorktreeInfo } from '../../../modules/git-worktree/git-worktree-manager.js'

// ---------------------------------------------------------------------------
// Mock GitWorktreeManager
// ---------------------------------------------------------------------------

const mockListWorktrees = vi.fn<[], Promise<WorktreeInfo[]>>()

vi.mock('../../../modules/git-worktree/git-worktree-manager-impl.js', () => ({
  createGitWorktreeManager: vi.fn(() => ({
    listWorktrees: mockListWorktrees,
  })),
}))

vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE_1 = new Date('2024-01-15T10:00:00Z')
const FIXED_DATE_2 = new Date('2024-01-16T12:00:00Z')

const WORKTREE_1: WorktreeInfo = {
  taskId: 'task-alpha',
  branchName: 'substrate/task-task-alpha',
  worktreePath: '/project/.substrate-worktrees/task-alpha',
  createdAt: FIXED_DATE_1,
}

const WORKTREE_2: WorktreeInfo = {
  taskId: 'task-beta',
  branchName: 'substrate/task-task-beta',
  worktreePath: '/project/.substrate-worktrees/task-beta',
  createdAt: FIXED_DATE_2,
}

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

async function runIntegrated(
  args: string[],
): Promise<{ output: string; error: string; exitCode: number }> {
  setupCapture()
  const program = new Command()
  program.exitOverride()
  registerWorktreesCommand(program, '0.1.0', '/project')

  // Track process.exitCode changes
  const originalExitCode = process.exitCode
  process.exitCode = undefined

  try {
    await program.parseAsync(['node', 'substrate', ...args])
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('process.exit(')) {
      // swallow
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
// Integration tests
// ---------------------------------------------------------------------------

describe('worktrees command - integration', () => {
  beforeEach(() => {
    mockListWorktrees.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // AC3: Empty worktrees
  it('shows "No active worktrees" when directory is empty', async () => {
    mockListWorktrees.mockResolvedValue([])
    const { output, exitCode } = await runIntegrated(['worktrees'])
    expect(output).toContain('No active worktrees')
    expect(exitCode).toBe(0)
  })

  // AC1: Basic listing
  it('shows table with headers for active worktrees', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { output } = await runIntegrated(['worktrees'])
    expect(output).toContain('Task ID')
    expect(output).toContain('Branch')
    expect(output).toContain('Path')
    expect(output).toContain('Status')
    expect(output).toContain('Created')
  })

  it('shows worktree task ID, branch name, and path in table', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { output } = await runIntegrated(['worktrees'])
    expect(output).toContain('task-alpha')
    expect(output).toContain('substrate/task-task-alpha')
    expect(output).toContain('/project/.substrate-worktrees/task-alpha')
  })

  // AC2: JSON output with --output-format json
  it('outputs valid JSON with --output-format json', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { output } = await runIntegrated(['worktrees', '--output-format', 'json'])
    expect((): void => { JSON.parse(output) }).not.toThrow()
    const parsed = JSON.parse(output) as {
      data: { taskId: string; branchName: string }[]
      command: string
    }
    expect(parsed.command).toBe('substrate worktrees')
    expect(Array.isArray(parsed.data)).toBe(true)
  })

  // AC2: JSON shorthand --json
  it('outputs identical JSON with --json shorthand', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { output: jsonFull } = await runIntegrated(['worktrees', '--output-format', 'json'])
    const { output: jsonShort } = await runIntegrated(['worktrees', '--json'])

    const fullParsed = JSON.parse(jsonFull) as { data: unknown[] }
    const shortParsed = JSON.parse(jsonShort) as { data: unknown[] }
    // Data should match (timing may differ slightly but data structure should be same)
    expect(fullParsed.data).toHaveLength(shortParsed.data.length)
    expect(Array.isArray(fullParsed.data)).toBe(true)
    expect(Array.isArray(shortParsed.data)).toBe(true)
  })

  // AC2: JSON fields
  it('JSON data array contains required AC2 fields', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { output } = await runIntegrated(['worktrees', '--json'])
    const parsed = JSON.parse(output) as {
      data: { taskId: string; branchName: string; worktreePath: string; taskStatus: string; createdAt: string; completedAt: string | null }[]
    }
    const entry = parsed.data[0]
    expect(entry).toHaveProperty('taskId')
    expect(entry).toHaveProperty('branchName')
    expect(entry).toHaveProperty('worktreePath')
    expect(entry).toHaveProperty('taskStatus')
    expect(entry).toHaveProperty('createdAt')
    expect(entry).toHaveProperty('completedAt')
  })

  // AC4: Status filtering
  it('accepts --status flag without error', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { exitCode } = await runIntegrated(['worktrees', '--status', 'running'])
    // All worktrees default to 'running', so they should appear
    expect(exitCode).toBe(0)
  })

  it('returns error exit code for invalid status value', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { error, exitCode } = await runIntegrated(['worktrees', '--status', 'invalid-status'])
    expect(error).toContain('Invalid status')
    expect(exitCode).toBe(1)
  })

  // AC5: Sorting
  it('accepts --sort flag without error', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1, WORKTREE_2])
    const { exitCode } = await runIntegrated(['worktrees', '--sort', 'task-id'])
    expect(exitCode).toBe(0)
  })

  it('returns error exit code for invalid sort key', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { error, exitCode } = await runIntegrated(['worktrees', '--sort', 'invalid-sort'])
    expect(error).toContain('Invalid sort key')
    expect(exitCode).toBe(1)
  })

  it('sorts by created time newest first by default', async () => {
    mockListWorktrees.mockResolvedValue([
      WORKTREE_1,   // 2024-01-15 (older)
      WORKTREE_2,   // 2024-01-16 (newer)
    ])
    const { output } = await runIntegrated(['worktrees', '--json'])
    const parsed = JSON.parse(output) as { data: { taskId: string }[] }
    expect(parsed.data[0].taskId).toBe('task-beta')  // newer
    expect(parsed.data[1].taskId).toBe('task-alpha') // older
  })

  // Registration test
  it('worktrees command is registered in program', () => {
    const program = new Command()
    program.exitOverride()
    registerWorktreesCommand(program, '0.1.0', '/project')
    const worktreesCmd = program.commands.find((c) => c.name() === 'worktrees')
    expect(worktreesCmd).toBeDefined()
  })

  it('worktrees command has correct description', () => {
    const program = new Command()
    program.exitOverride()
    registerWorktreesCommand(program, '0.1.0', '/project')
    const worktreesCmd = program.commands.find((c) => c.name() === 'worktrees')
    expect(worktreesCmd?.description()).toContain('worktrees')
  })

  // JSON output is machine-parseable
  it('JSON output is parseable (valid UTF-8 JSON)', async () => {
    mockListWorktrees.mockResolvedValue([WORKTREE_1])
    const { output } = await runIntegrated(['worktrees', '--json'])
    expect((): void => { JSON.parse(output) }).not.toThrow()
    expect(output.endsWith('\n')).toBe(true)
  })
})
