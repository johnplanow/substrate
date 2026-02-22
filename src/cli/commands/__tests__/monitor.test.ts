/**
 * Unit tests for `src/cli/commands/monitor.ts`
 *
 * Covers:
 *   AC1: Default monitor report display — agents, task types, summary
 *   AC2: --since filters data
 *   AC3: --days filters data; --since and --days mutual exclusivity
 *   AC4: --output-format json / --json emits CLIJsonOutput
 *   AC5: --include-recommendations includes routing recommendations
 *   AC6: monitor status subcommand
 *   AC7: monitor reset subcommand (force + confirmation)
 *   AC8: monitor recommendations subcommand
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that reference mocked modules
// ---------------------------------------------------------------------------

// Mock existsSync and statSync from 'fs'
const mockExistsSync = vi.fn()
const mockStatSync = vi.fn()

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    statSync: (...args: unknown[]) => mockStatSync(...args),
  }
})

// Mock homedir from 'os'
const mockHomedir = vi.fn().mockReturnValue('/home/testuser')
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    homedir: () => mockHomedir(),
  }
})

// Mock MonitorDatabaseImpl
const mockGetAggregates = vi.fn()
const mockClose = vi.fn()
const mockResetAllData = vi.fn()

vi.mock('../../../persistence/monitor-database.js', () => ({
  MonitorDatabaseImpl: vi.fn().mockImplementation(() => ({
    getAggregates: (...args: unknown[]) => mockGetAggregates(...args),
    getAgentPerformance: vi.fn().mockReturnValue(null),
    getTaskTypeBreakdown: vi.fn().mockReturnValue(null),
    insertTaskMetrics: vi.fn(),
    updateAggregates: vi.fn(),
    updatePerformanceAggregates: vi.fn(),
    pruneOldData: vi.fn().mockReturnValue(0),
    rebuildAggregates: vi.fn(),
    resetAllData: (...args: unknown[]) => mockResetAllData(...args),
    close: mockClose,
  })),
}))

// Mock RecommendationEngine
const mockExportRecommendationsJson = vi.fn()
vi.mock('../../../modules/monitor/recommendation-engine.js', () => ({
  RecommendationEngine: vi.fn().mockImplementation(() => ({
    exportRecommendationsJson: (...args: unknown[]) => mockExportRecommendationsJson(...args),
    generateRecommendations: vi.fn().mockReturnValue([]),
  })),
}))

// Mock generateMonitorReport
const mockGenerateMonitorReport = vi.fn()
vi.mock('../../../modules/monitor/report-generator.js', () => ({
  generateMonitorReport: (...args: unknown[]) => mockGenerateMonitorReport(...args),
}))

// Mock readline — use a module-level variable that the factory can reference via closure
// The factory is hoisted, so we need to use `vi.hoisted` pattern or use a getter
let _mockRlAnswer = ''

vi.mock('readline', () => {
  return {
    createInterface: vi.fn().mockImplementation(() => ({
      question: (_prompt: string, cb: (answer: string) => void) => {
        // Use the module-level answer variable
        cb(_mockRlAnswer)
      },
      close: vi.fn(),
    })),
  }
})

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import {
  runMonitorReportAction,
  runMonitorStatusAction,
  runMonitorResetAction,
  runMonitorRecommendationsAction,
  registerMonitorCommand,
  resolveMonitorDbPath,
  MONITOR_EXIT_SUCCESS,
  MONITOR_EXIT_ERROR,
} from '../monitor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport() {
  return {
    generated_at: '2026-02-22T10:00:00.000Z',
    summary: {
      total_tasks: 100,
      total_agents: 2,
      total_task_types: 3,
      date_range: { earliest: '2026-01-01T00:00:00.000Z', latest: '2026-02-22T10:00:00.000Z' },
    },
    agents: [
      {
        agent: 'claude-sonnet',
        total_tasks: 60,
        success_rate: 90,
        failure_rate: 10,
        average_tokens: 1500,
        average_duration: 500,
        token_efficiency: 0.5,
      },
      {
        agent: 'claude-haiku',
        total_tasks: 40,
        success_rate: 75,
        failure_rate: 25,
        average_tokens: 800,
        average_duration: 200,
        token_efficiency: 0.4,
      },
    ],
    task_types: [
      {
        task_type: 'coding',
        total_tasks: 60,
        agents: [
          { agent: 'claude-sonnet', success_rate: 90, average_tokens: 1500, sample_size: 60 },
        ],
      },
    ],
  }
}

function makeAggregates() {
  return [
    {
      agent: 'claude-sonnet',
      taskType: 'coding',
      totalTasks: 60,
      successfulTasks: 54,
      failedTasks: 6,
      totalInputTokens: 60000,
      totalOutputTokens: 30000,
      totalDurationMs: 30000,
      totalCost: 0.6,
      lastUpdated: '2026-02-22T10:00:00.000Z',
    },
  ]
}

// ---------------------------------------------------------------------------
// resolveMonitorDbPath tests
// ---------------------------------------------------------------------------

describe('resolveMonitorDbPath()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/testuser')
  })

  it('returns project-local path when it exists', () => {
    mockExistsSync.mockImplementation((p: string) => p.includes('.substrate/monitor.db') && p.startsWith('/project'))
    const result = resolveMonitorDbPath('/project/root')
    expect(result).toBe('/project/root/.substrate/monitor.db')
  })

  it('returns global path when project-local does not exist', () => {
    mockExistsSync.mockImplementation((p: string) => p.startsWith('/home'))
    const result = resolveMonitorDbPath('/project/root')
    expect(result).toBe('/home/testuser/.substrate/monitor.db')
  })

  it('returns null when neither path exists', () => {
    mockExistsSync.mockReturnValue(false)
    const result = resolveMonitorDbPath('/project/root')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runMonitorReportAction tests
// ---------------------------------------------------------------------------

describe('runMonitorReportAction()', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/testuser')
    mockExistsSync.mockImplementation((p: string) => p.includes('monitor.db'))
    mockStatSync.mockReturnValue({ size: 1024 })
    mockGenerateMonitorReport.mockReturnValue(makeReport())
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('returns exit code 0 when db exists and has data (AC1)', async () => {
    const exitCode = await runMonitorReportAction({
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    expect(mockGenerateMonitorReport).toHaveBeenCalledOnce()
  })

  it('returns error exit code when monitor.db not found', async () => {
    mockExistsSync.mockReturnValue(false)

    const exitCode = await runMonitorReportAction({
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_ERROR)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No monitor database found'))
  })

  it('returns error when both --since and --days are provided (AC3)', async () => {
    const exitCode = await runMonitorReportAction({
      since: '2026-02-01',
      days: 7,
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_ERROR)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'))
  })

  it('passes sinceDate to generateMonitorReport when --since is provided (AC2)', async () => {
    const exitCode = await runMonitorReportAction({
      since: '2026-02-01',
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const call = mockGenerateMonitorReport.mock.calls[0] as [unknown, { sinceDate?: string }]
    expect(call[1].sinceDate).toBeDefined()
    expect(call[1].sinceDate).toContain('2026-02-01')
  })

  it('passes sinceDate computed from --days to generateMonitorReport (AC3)', async () => {
    const exitCode = await runMonitorReportAction({
      days: 7,
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const call = mockGenerateMonitorReport.mock.calls[0] as [unknown, { sinceDate?: string }]
    expect(call[1].sinceDate).toBeDefined()
  })

  it('emits CLIJsonOutput when outputFormat is json (AC4)', async () => {
    const exitCode = await runMonitorReportAction({
      outputFormat: 'json',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)

    const writtenArgs = stdoutSpy.mock.calls.flat()
    const writtenOutput = writtenArgs.join('')
    const parsed = JSON.parse(writtenOutput) as Record<string, unknown>

    expect(parsed).toHaveProperty('timestamp')
    expect(parsed).toHaveProperty('version')
    expect(parsed).toHaveProperty('command', 'substrate monitor report')
    expect(parsed).toHaveProperty('data')
  })

  it('passes includeRecommendations to generateMonitorReport (AC5)', async () => {
    const exitCode = await runMonitorReportAction({
      outputFormat: 'table',
      includeRecommendations: true,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const call = mockGenerateMonitorReport.mock.calls[0] as [unknown, { includeRecommendations?: boolean }]
    expect(call[1].includeRecommendations).toBe(true)
  })

  it('returns error when --since is an invalid date string (AC2)', async () => {
    const exitCode = await runMonitorReportAction({
      since: 'not-a-date',
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_ERROR)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid date value for --since'))
  })

  it('returns error when --days is NaN (AC3)', async () => {
    const exitCode = await runMonitorReportAction({
      days: NaN,
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_ERROR)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid value for --days'))
  })

  it('shows no data message when time range produces empty results (AC2)', async () => {
    const emptyReport = {
      ...makeReport(),
      summary: { ...makeReport().summary, total_tasks: 0 },
      time_range: { since: '2026-02-01T00:00:00.000Z', until: '2026-02-22T10:00:00.000Z' },
    }
    mockGenerateMonitorReport.mockReturnValue(emptyReport)

    const exitCode = await runMonitorReportAction({
      since: '2026-02-01',
      outputFormat: 'table',
      includeRecommendations: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const writtenArgs = stdoutSpy.mock.calls.flat()
    expect(writtenArgs.join('')).toContain('No data in specified time range')
  })
})

// ---------------------------------------------------------------------------
// runMonitorStatusAction tests
// ---------------------------------------------------------------------------

describe('runMonitorStatusAction()', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/testuser')
    mockExistsSync.mockImplementation((p: string) => p.includes('monitor.db'))
    mockStatSync.mockReturnValue({ size: 2048 })
    mockGetAggregates.mockReturnValue(makeAggregates())
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('returns exit code 0 and shows summary (AC6)', async () => {
    const exitCode = await runMonitorStatusAction({
      outputFormat: 'table',
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const writtenArgs = stdoutSpy.mock.calls.flat()
    const output = writtenArgs.join('')
    expect(output).toContain('Monitor Status')
    expect(output).toContain('Total Tasks Tracked')
    expect(output).toContain('claude-sonnet')
  })

  it('returns error when db not found (AC6)', async () => {
    mockExistsSync.mockReturnValue(false)

    const exitCode = await runMonitorStatusAction({
      outputFormat: 'table',
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_ERROR)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No monitor database found'))
  })

  it('emits CLIJsonOutput with json flag (AC6)', async () => {
    const exitCode = await runMonitorStatusAction({
      outputFormat: 'json',
      projectRoot: '/project/root',
      version: '1.0.0',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)

    const writtenArgs = stdoutSpy.mock.calls.flat()
    const parsed = JSON.parse(writtenArgs.join('')) as Record<string, unknown>

    expect(parsed).toHaveProperty('command', 'substrate monitor status')
    expect(parsed).toHaveProperty('data')
    const data = parsed['data'] as Record<string, unknown>
    expect(data).toHaveProperty('total_tasks')
    expect(data).toHaveProperty('agents')
    expect(data).toHaveProperty('task_types')
    expect(data).toHaveProperty('database')
  })

  it('lists distinct agents tracked (AC6)', async () => {
    const exitCode = await runMonitorStatusAction({
      outputFormat: 'table',
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const writtenArgs = stdoutSpy.mock.calls.flat()
    const output = writtenArgs.join('')
    expect(output).toContain('claude-sonnet')
  })
})

// ---------------------------------------------------------------------------
// runMonitorResetAction tests
// ---------------------------------------------------------------------------

describe('runMonitorResetAction()', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/testuser')
    mockExistsSync.mockImplementation((p: string) => p.includes('monitor.db'))
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockResetAllData.mockReset()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('clears all data without prompt when --force is provided (AC7)', async () => {
    const exitCode = await runMonitorResetAction({
      force: true,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    expect(mockResetAllData).toHaveBeenCalledOnce()
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Monitor data reset successfully'))
  })

  it('prompts for confirmation and cancels when input is not "yes" (AC7)', async () => {
    // Simulate user typing "no"
    _mockRlAnswer = 'no'

    const exitCode = await runMonitorResetAction({
      force: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    expect(mockResetAllData).not.toHaveBeenCalled()
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Reset cancelled'))
  })

  it('proceeds with reset when user confirms with "yes" (AC7)', async () => {
    // Simulate user typing "yes"
    _mockRlAnswer = 'yes'

    const exitCode = await runMonitorResetAction({
      force: false,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    expect(mockResetAllData).toHaveBeenCalledOnce()
  })

  it('returns error when db not found', async () => {
    mockExistsSync.mockReturnValue(false)

    const exitCode = await runMonitorResetAction({
      force: true,
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_ERROR)
  })
})

// ---------------------------------------------------------------------------
// runMonitorRecommendationsAction tests
// ---------------------------------------------------------------------------

describe('runMonitorRecommendationsAction()', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHomedir.mockReturnValue('/home/testuser')
    mockExistsSync.mockImplementation((p: string) => p.includes('monitor.db'))
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockExportRecommendationsJson.mockReturnValue({
      generated_at: '2026-02-22T10:00:00.000Z',
      count: 0,
      recommendations: [],
    })
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('returns exit 0 with message when no data (AC8)', async () => {
    mockExistsSync.mockReturnValue(false)

    const exitCode = await runMonitorRecommendationsAction({
      outputFormat: 'table',
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const writtenArgs = stdoutSpy.mock.calls.flat()
    expect(writtenArgs.join('')).toContain('No monitor database found')
  })

  it('returns exit 0 with "No recommendations available" when count is 0 (AC8)', async () => {
    const exitCode = await runMonitorRecommendationsAction({
      outputFormat: 'table',
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const writtenArgs = stdoutSpy.mock.calls.flat()
    expect(writtenArgs.join('')).toContain('No recommendations available')
  })

  it('emits RecommendationExport as CLIJsonOutput with --json flag (AC8)', async () => {
    const exportData = {
      generated_at: '2026-02-22T10:00:00.000Z',
      count: 1,
      recommendations: [
        {
          task_type: 'coding',
          current_agent: 'agent-b',
          recommended_agent: 'agent-a',
          reason: 'agent-a shows 15% higher success rate',
          confidence: 'high' as const,
          current_success_rate: 70,
          recommended_success_rate: 85,
          current_avg_tokens: 1000,
          recommended_avg_tokens: 900,
          improvement_percentage: 15,
          sample_size_current: 60,
          sample_size_recommended: 60,
        },
      ],
    }
    mockExportRecommendationsJson.mockReturnValue(exportData)

    const exitCode = await runMonitorRecommendationsAction({
      outputFormat: 'json',
      projectRoot: '/project/root',
      version: '1.0.0',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)

    const writtenArgs = stdoutSpy.mock.calls.flat()
    const parsed = JSON.parse(writtenArgs.join('')) as Record<string, unknown>

    expect(parsed).toHaveProperty('command', 'substrate monitor recommendations')
    const data = parsed['data'] as Record<string, unknown>
    expect(data).toHaveProperty('count', 1)
    expect(data).toHaveProperty('recommendations')
  })

  it('shows formatted table when recommendations exist', async () => {
    const exportData = {
      generated_at: '2026-02-22T10:00:00.000Z',
      count: 1,
      recommendations: [
        {
          task_type: 'coding',
          current_agent: 'agent-b',
          recommended_agent: 'agent-a',
          reason: 'agent-a shows 15% higher success rate',
          confidence: 'high' as const,
          current_success_rate: 70,
          recommended_success_rate: 85,
          current_avg_tokens: 1000,
          recommended_avg_tokens: 900,
          improvement_percentage: 15,
          sample_size_current: 60,
          sample_size_recommended: 60,
        },
      ],
    }
    mockExportRecommendationsJson.mockReturnValue(exportData)

    const exitCode = await runMonitorRecommendationsAction({
      outputFormat: 'table',
      projectRoot: '/project/root',
    })

    expect(exitCode).toBe(MONITOR_EXIT_SUCCESS)
    const writtenArgs = stdoutSpy.mock.calls.flat()
    const output = writtenArgs.join('')
    expect(output).toContain('Routing Recommendations')
    expect(output).toContain('coding')
  })
})

// ---------------------------------------------------------------------------
// registerMonitorCommand tests
// ---------------------------------------------------------------------------

describe('registerMonitorCommand()', () => {
  it('registers monitor command with report, status, reset, recommendations subcommands', () => {
    const program = new Command()
    registerMonitorCommand(program, '1.0.0', '/project/root')

    const monitorCmd = program.commands.find((c) => c.name() === 'monitor')
    expect(monitorCmd).toBeDefined()

    const subcommandNames = monitorCmd!.commands.map((c) => c.name())
    expect(subcommandNames).toContain('report')
    expect(subcommandNames).toContain('status')
    expect(subcommandNames).toContain('reset')
    expect(subcommandNames).toContain('recommendations')
  })

  it('report subcommand has --since, --days, --output-format, --json, --include-recommendations options', () => {
    const program = new Command()
    registerMonitorCommand(program, '1.0.0', '/project/root')

    const monitorCmd = program.commands.find((c) => c.name() === 'monitor')!
    const reportCmd = monitorCmd.commands.find((c) => c.name() === 'report')!

    const optionNames = reportCmd.options.map((o) => o.long)
    expect(optionNames).toContain('--since')
    expect(optionNames).toContain('--days')
    expect(optionNames).toContain('--output-format')
    expect(optionNames).toContain('--json')
    expect(optionNames).toContain('--include-recommendations')
  })

  it('reset subcommand has --force option', () => {
    const program = new Command()
    registerMonitorCommand(program, '1.0.0', '/project/root')

    const monitorCmd = program.commands.find((c) => c.name() === 'monitor')!
    const resetCmd = monitorCmd.commands.find((c) => c.name() === 'reset')!

    const optionNames = resetCmd.options.map((o) => o.long)
    expect(optionNames).toContain('--force')
  })
})
