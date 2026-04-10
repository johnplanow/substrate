// @vitest-environment node
/**
 * Unit tests for the `substrate epic-status` CLI command.
 *
 * Story 31-9: substrate epic-status Command (AC1–AC6)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Mocks (declared before imports via vi.hoisted)
// ---------------------------------------------------------------------------

const {
  mockAdapterExec,
  mockAdapterQuery,
  mockAdapterClose,
  mockCreateDatabaseAdapter,
  mockListStories,
  mockGetBlockedStories,
  mockGetReadyStories,
} = vi.hoisted(() => {
  const mockAdapterExec = vi.fn().mockResolvedValue(undefined)
  const mockAdapterClose = vi.fn().mockResolvedValue(undefined)
  const mockAdapterQuery = vi.fn().mockResolvedValue([])

  const mockCreateDatabaseAdapter = vi.fn(() => ({
    exec: mockAdapterExec,
    query: mockAdapterQuery,
    close: mockAdapterClose,
  }))

  const mockListStories = vi.fn().mockResolvedValue([])
  const mockGetBlockedStories = vi.fn().mockResolvedValue([])
  const mockGetReadyStories = vi.fn().mockResolvedValue([])

  return {
    mockAdapterExec,
    mockAdapterQuery,
    mockAdapterClose,
    mockCreateDatabaseAdapter,
    mockListStories,
    mockGetBlockedStories,
    mockGetReadyStories,
  }
})

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: mockCreateDatabaseAdapter,
}))

vi.mock('../../../modules/state/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../modules/state/index.js')>()
  return {
    ...original,
    WorkGraphRepository: vi.fn().mockImplementation(() => ({
      listStories: mockListStories,
      getBlockedStories: mockGetBlockedStories,
      getReadyStories: mockGetReadyStories,
    })),
  }
})

// Import after mocks are set up
import { runEpicStatusAction, registerEpicStatusCommand } from '../epic-status.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY_31_1 = {
  story_key: '31-1',
  epic: '31',
  title: 'Create Dolt Work Graph Schema',
  status: 'complete',
  spec_path: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
}

const STORY_31_2 = {
  story_key: '31-2',
  epic: '31',
  title: 'Epic Doc Ingestion',
  status: 'complete',
  spec_path: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
}

const STORY_31_3 = {
  story_key: '31-3',
  epic: '31',
  title: 'Dispatch Gating',
  status: 'in_progress',
  spec_path: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
}

const STORY_31_4 = {
  story_key: '31-4',
  epic: '31',
  title: 'Status Lifecycle',
  status: 'planned',
  spec_path: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
}

const STORY_31_5 = {
  story_key: '31-5',
  epic: '31',
  title: 'Ready Stories View',
  status: 'ready',
  spec_path: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
}

const STORY_31_10 = {
  story_key: '31-10',
  epic: '31',
  title: 'Story Ten',
  status: 'planned',
  spec_path: null,
  created_at: null,
  updated_at: null,
  completed_at: null,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerEpicStatusCommand(program)
  return program
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('epic-status command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.exitCode = 0

    // Default: return empty results
    mockListStories.mockResolvedValue([])
    mockGetBlockedStories.mockResolvedValue([])
    mockGetReadyStories.mockResolvedValue([])
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.exitCode = 0
  })

  // -------------------------------------------------------------------------
  // AC6: Unknown epic exits cleanly
  // -------------------------------------------------------------------------

  describe('AC6: no stories found', () => {
    it('writes "No stories found" to stderr when no stories exist for the epic', async () => {
      mockListStories.mockResolvedValue([])

      await runEpicStatusAction('99', { outputFormat: 'human' })

      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(errOutput).toContain('No stories found for epic 99')
      expect(errOutput).toContain('substrate ingest-epic')
    })

    it('sets process.exitCode to 1 when no stories found', async () => {
      mockListStories.mockResolvedValue([])

      await runEpicStatusAction('99', { outputFormat: 'human' })

      expect(process.exitCode).toBe(1)
    })

    it('does not write to stdout when no stories found', async () => {
      mockListStories.mockResolvedValue([])

      await runEpicStatusAction('99', { outputFormat: 'human' })

      expect(stdoutSpy).not.toHaveBeenCalled()
    })

    it('calls adapter.close even when no stories found', async () => {
      mockListStories.mockResolvedValue([])

      await runEpicStatusAction('99', { outputFormat: 'human' })

      expect(mockAdapterClose).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // AC1: Lists all stories
  // -------------------------------------------------------------------------

  describe('AC1: lists all stories ordered by story key', () => {
    it('prints all story keys in the output', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_2, STORY_31_3])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('31-1')
      expect(output).toContain('31-2')
      expect(output).toContain('31-3')
    })

    it('sorts stories by numeric suffix (31-2 before 31-10)', async () => {
      // Provide stories out of natural order
      mockListStories.mockResolvedValue([STORY_31_10, STORY_31_2, STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const pos1 = output.indexOf('31-1')
      const pos2 = output.indexOf('31-2')
      const pos10 = output.indexOf('31-10')

      expect(pos1).toBeGreaterThanOrEqual(0)
      expect(pos2).toBeGreaterThan(pos1)
      expect(pos10).toBeGreaterThan(pos2)
    })

    it('prints story titles in the output', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('Create Dolt Work Graph Schema')
    })

    it('uses story_key as display name when title is null', async () => {
      const storyNoTitle = { ...STORY_31_1, title: null }
      mockListStories.mockResolvedValue([storyNoTitle])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      // Should display the key as the fallback title
      expect(output).toContain('31-1')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Status badges
  // -------------------------------------------------------------------------

  describe('AC2: status badges', () => {
    it('shows [complete  ] badge for complete stories', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('[complete  ]')
    })

    it('shows [in_progress] badge for in_progress stories', async () => {
      mockListStories.mockResolvedValue([STORY_31_3])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('[in_progress]')
    })

    it('shows [ready     ] badge for ready stories', async () => {
      mockGetReadyStories.mockResolvedValue([STORY_31_5])
      mockListStories.mockResolvedValue([STORY_31_5])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('[ready     ]')
    })

    it('shows [planned   ] badge for planned stories', async () => {
      mockListStories.mockResolvedValue([STORY_31_4])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('[planned   ]')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Blocked stories show dependency explanation
  // -------------------------------------------------------------------------

  describe('AC3: blocked stories show dependency explanation', () => {
    it('shows [blocked   ] badge for blocked stories', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_4])
      mockGetBlockedStories.mockResolvedValue([
        {
          story: STORY_31_4,
          blockers: [
            { key: '31-1', title: 'Create Dolt Work Graph Schema', status: 'in_progress' },
          ],
        },
      ])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('[blocked   ]')
    })

    it('shows [waiting on: ...] annotation for blocked stories', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_4])
      mockGetBlockedStories.mockResolvedValue([
        {
          story: STORY_31_4,
          blockers: [{ key: '31-1', title: 'Schema', status: 'in_progress' }],
        },
      ])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('[waiting on: 31-1 (in_progress)]')
    })

    it('shows multiple blockers in the waiting annotation', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_2, STORY_31_4])
      mockGetBlockedStories.mockResolvedValue([
        {
          story: STORY_31_4,
          blockers: [
            { key: '31-1', title: 'Schema', status: 'planned' },
            { key: '31-2', title: 'Ingestion', status: 'planned' },
          ],
        },
      ])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('31-1 (planned), 31-2 (planned)')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Summary line
  // -------------------------------------------------------------------------

  describe('AC4: summary line', () => {
    it('prints a summary line with epic number and counts', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_2, STORY_31_3])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('Epic 31:')
      expect(output).toContain('complete')
      expect(output).toContain('in_progress')
    })

    it('counts complete stories correctly', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_2, STORY_31_3])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('2 complete')
    })

    it('counts blocked stories in summary', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_4])
      mockGetBlockedStories.mockResolvedValue([
        {
          story: STORY_31_4,
          blockers: [{ key: '31-1', title: 'Schema', status: 'in_progress' }],
        },
      ])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('1 blocked')
    })

    it('counts ready stories (not blocked) separately from planned', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_5])
      mockGetReadyStories.mockResolvedValue([STORY_31_5])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toContain('1 ready')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: JSON output
  // -------------------------------------------------------------------------

  describe('AC5: JSON output', () => {
    it('emits valid JSON with epic, stories, summary fields', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_2])

      await runEpicStatusAction('31', { outputFormat: 'json' })

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const parsed = JSON.parse(rawOutput) as {
        epic: string
        stories: unknown[]
        summary: Record<string, number>
      }

      expect(parsed.epic).toBe('31')
      expect(Array.isArray(parsed.stories)).toBe(true)
      expect(parsed.summary).toBeDefined()
    })

    it('JSON stories array is sorted by key', async () => {
      mockListStories.mockResolvedValue([STORY_31_10, STORY_31_2, STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'json' })

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const parsed = JSON.parse(rawOutput) as {
        stories: Array<{ key: string }>
      }

      const keys = parsed.stories.map((s) => s.key)
      expect(keys).toEqual(['31-1', '31-2', '31-10'])
    })

    it('JSON story object has key, title, status fields', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'json' })

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const parsed = JSON.parse(rawOutput) as {
        stories: Array<{ key: string; title: string | null; status: string }>
      }

      expect(parsed.stories[0]).toMatchObject({
        key: '31-1',
        title: 'Create Dolt Work Graph Schema',
        status: 'complete',
      })
    })

    it('JSON blocked story shows status="blocked" and has blockers array', async () => {
      mockListStories.mockResolvedValue([STORY_31_4])
      mockGetBlockedStories.mockResolvedValue([
        {
          story: STORY_31_4,
          blockers: [{ key: '31-3', title: 'Dispatch', status: 'in_progress' }],
        },
      ])

      await runEpicStatusAction('31', { outputFormat: 'json' })

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const parsed = JSON.parse(rawOutput) as {
        stories: Array<{
          key: string
          status: string
          blockers?: Array<{ key: string; title: string; status: string }>
        }>
        summary: Record<string, number>
      }

      expect(parsed.stories[0]?.status).toBe('blocked')
      expect(parsed.stories[0]?.blockers).toHaveLength(1)
      expect(parsed.stories[0]?.blockers?.[0]?.key).toBe('31-3')
      expect(parsed.summary.blocked).toBe(1)
    })

    it('JSON summary has all required fields', async () => {
      mockListStories.mockResolvedValue([STORY_31_1, STORY_31_2, STORY_31_3])

      await runEpicStatusAction('31', { outputFormat: 'json' })

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      const parsed = JSON.parse(rawOutput) as {
        summary: {
          total: number
          complete: number
          inProgress: number
          ready: number
          blocked: number
          planned: number
          escalated: number
        }
      }

      expect(parsed.summary.total).toBe(3)
      expect(parsed.summary.complete).toBe(2)
      expect(parsed.summary.inProgress).toBe(1)
      expect(typeof parsed.summary.ready).toBe('number')
      expect(typeof parsed.summary.blocked).toBe('number')
      expect(typeof parsed.summary.planned).toBe('number')
      expect(typeof parsed.summary.escalated).toBe('number')
    })

    it('JSON no stories found also exits with code 1', async () => {
      mockListStories.mockResolvedValue([])

      await runEpicStatusAction('99', { outputFormat: 'json' })

      expect(process.exitCode).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Infrastructure: adapter lifecycle
  // -------------------------------------------------------------------------

  describe('adapter lifecycle', () => {
    it('creates adapter with backend=auto', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      expect(mockCreateDatabaseAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ backend: 'auto' })
      )
    })

    it('calls adapter.close() after a successful run', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      expect(mockAdapterClose).toHaveBeenCalledOnce()
    })

    it('calls adapter.exec() for schema init', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      await runEpicStatusAction('31', { outputFormat: 'human' })

      expect(mockAdapterExec).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Command registration
  // -------------------------------------------------------------------------

  describe('AC7: commander registration', () => {
    it('registers epic-status command in the program', async () => {
      const program = createTestProgram()
      const commands = program.commands.map((c) => c.name())
      expect(commands).toContain('epic-status')
    })

    it('shows description in help', async () => {
      const program = createTestProgram()
      const epicStatusCmd = program.commands.find((c) => c.name() === 'epic-status')
      expect(epicStatusCmd?.description()).toBeTruthy()
    })

    it('parses --output-format json and passes it to the action', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      const program = createTestProgram()
      await program.parseAsync([
        'node',
        'substrate',
        'epic-status',
        '31',
        '--output-format',
        'json',
      ])

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      // Verify it's valid JSON
      expect(() => JSON.parse(rawOutput)).not.toThrow()
    })

    it('defaults to human output when --output-format is not specified', async () => {
      mockListStories.mockResolvedValue([STORY_31_1])

      const program = createTestProgram()
      await program.parseAsync(['node', 'substrate', 'epic-status', '31'])

      const rawOutput = stdoutSpy.mock.calls.map((c) => String(c[0])).join('')
      // Human output is not parseable as JSON
      expect(() => JSON.parse(rawOutput)).toThrow()
      expect(rawOutput).toContain('Epic 31')
    })
  })
})
