/**
 * Unit tests for `src/cli/commands/cost.ts`
 *
 * Covers all 8 Acceptance Criteria:
 *   AC1: Default session cost summary (table output)
 *   AC2: --by-task shows per-task breakdown
 *   AC3: --by-agent shows per-agent breakdown
 *   AC4: --by-billing shows billing mode breakdown
 *   AC5: Planning costs shown separately; --include-planning includes them
 *   AC6: --output-format json (and csv) outputs valid structured data
 *   AC7: --session <id> shows cost for specific session
 *   AC8: Empty data shows "No cost data found" and exits 0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that reference mocked modules
// ---------------------------------------------------------------------------

// Mock DatabaseWrapper
const mockOpen = vi.fn()
const mockClose = vi.fn()
let mockDb: Record<string, unknown> = { fake: true }

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
  })),
}))

// Mock migrations
vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

// Mock cost queries
const mockGetSessionCostSummary = vi.fn()
const mockGetAllCostEntriesFiltered = vi.fn()
const mockGetSessionCostSummaryFiltered = vi.fn()
const mockGetPlanningCostTotal = vi.fn()

vi.mock('../../../persistence/queries/cost.js', () => ({
  getSessionCostSummary: (...args: unknown[]) => mockGetSessionCostSummary(...args),
  getAllCostEntriesFiltered: (...args: unknown[]) => mockGetAllCostEntriesFiltered(...args),
  getSessionCostSummaryFiltered: (...args: unknown[]) => mockGetSessionCostSummaryFiltered(...args),
  getPlanningCostTotal: (...args: unknown[]) => mockGetPlanningCostTotal(...args),
}))

// Mock session queries
const mockGetLatestSessionId = vi.fn()

vi.mock('../../../persistence/queries/sessions.js', () => ({
  getLatestSessionId: (...args: unknown[]) => mockGetLatestSessionId(...args),
}))

// Mock fs.existsSync
const mockExistsSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  runCostAction,
  formatCostSummaryTable,
  formatByTaskTable,
  formatByAgentTable,
  formatByBillingTable,
  formatCostCsv,
  COST_EXIT_SUCCESS,
  COST_EXIT_ERROR,
} from '../cost.js'
import type { CostActionOptions } from '../cost.js'
import type { SessionCostSummary, CostEntry, AgentCostBreakdown } from '../../../modules/cost-tracker/types.js'
import { DatabaseWrapper } from '../../../persistence/database.js'

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function createMockSummary(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
  return {
    session_id: 'session-abc123',
    total_cost_usd: 0.42,
    subscription_cost_usd: 0.0,
    api_cost_usd: 0.42,
    savings_usd: 1.23,
    savingsSummary: 'Saved ~$1.23 by routing 3 tasks through subscriptions vs. equivalent API pricing',
    per_agent_breakdown: [
      {
        agent: 'claude-code',
        task_count: 8,
        cost_usd: 0.42,
        savings_usd: 1.23,
        subscription_tasks: 3,
        api_tasks: 5,
      },
    ],
    task_count: 8,
    subscription_task_count: 3,
    api_task_count: 5,
    created_at: '2024-01-15T10:00:00Z',
    ...overrides,
  }
}

function createMockSummaryWithBudget(): SessionCostSummary {
  return createMockSummary({
    budget_usd: 10.0,
    remaining_budget_usd: 9.58,
    percentage_used: 4.2,
    budget_status: 'ok',
  })
}

function createMockEntries(): CostEntry[] {
  return [
    {
      id: 1,
      session_id: 'session-abc123',
      task_id: 'auth-setup',
      agent: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      billing_mode: 'subscription',
      tokens_input: 1000,
      tokens_output: 500,
      cost_usd: 0.0,
      savings_usd: 0.45,
      created_at: '2024-01-15T10:01:00Z',
    },
    {
      id: 2,
      session_id: 'session-abc123',
      task_id: 'api-test',
      agent: 'claude-code',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      billing_mode: 'api',
      tokens_input: 2000,
      tokens_output: 1000,
      cost_usd: 0.25,
      savings_usd: 0.0,
      created_at: '2024-01-15T10:02:00Z',
    },
  ]
}

function createEmptySummary(): SessionCostSummary {
  return createMockSummary({
    total_cost_usd: 0,
    subscription_cost_usd: 0,
    api_cost_usd: 0,
    savings_usd: 0,
    savingsSummary: 'No subscription savings recorded this session',
    per_agent_breakdown: [],
    task_count: 0,
    subscription_task_count: 0,
    api_task_count: 0,
  })
}

// ---------------------------------------------------------------------------
// stdout/stderr capture helpers
// ---------------------------------------------------------------------------

let stdoutOutput: string
let stderrOutput: string

function captureOutput(): void {
  stdoutOutput = ''
  stderrOutput = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    stdoutOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    stderrOutput += typeof data === 'string' ? data : data.toString()
    return true
  })
}

function getStdout(): string {
  return stdoutOutput
}

function getStderr(): string {
  return stderrOutput
}

// ---------------------------------------------------------------------------
// Default options factory
// ---------------------------------------------------------------------------

function defaultOptions(overrides: Partial<CostActionOptions> = {}): CostActionOptions {
  return {
    outputFormat: 'table',
    byTask: false,
    byAgent: false,
    byBilling: false,
    includePlanning: false,
    projectRoot: '/fake/project',
    version: '1.0.0',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  captureOutput()
  // Default: database file exists
  mockExistsSync.mockReturnValue(true)
  // Default: latest session found
  mockGetLatestSessionId.mockReturnValue('session-abc123')
  // Default: return a valid summary
  mockGetSessionCostSummary.mockReturnValue(createMockSummary())
  mockGetSessionCostSummaryFiltered.mockReturnValue(createMockSummary())
  mockGetAllCostEntriesFiltered.mockReturnValue(createMockEntries())
  mockGetPlanningCostTotal.mockReturnValue(0.05)
  // Reset db mock
  mockDb = { fake: true }
  // Re-apply DatabaseWrapper mock implementation in case vi.restoreAllMocks() cleared it
  vi.mocked(DatabaseWrapper).mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() {
      return mockDb
    },
  }) as unknown as InstanceType<typeof DatabaseWrapper>)
})

afterEach(() => {
  vi.restoreAllMocks()
  mockGetSessionCostSummary.mockReset()
  mockGetSessionCostSummaryFiltered.mockReset()
  mockGetAllCostEntriesFiltered.mockReset()
  mockGetPlanningCostTotal.mockReset()
  mockGetLatestSessionId.mockReset()
  mockExistsSync.mockReset()
  mockOpen.mockReset()
  mockClose.mockReset()
})

// ---------------------------------------------------------------------------
// AC1: Default Session Cost Summary
// ---------------------------------------------------------------------------

describe('AC1: substrate cost — default session cost summary', () => {
  it('displays session cost summary as table output', async () => {
    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Session: session-abc123')
    expect(output).toContain('Total Cost:')
    expect(output).toContain('$0.4200')
    expect(output).toContain('Subscription:')
    expect(output).toContain('API Billed:')
    expect(output).toContain('Savings:')
  })

  it('shows subscription and API task counts', async () => {
    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('3 tasks')
    expect(output).toContain('5 tasks')
  })

  it('shows savings summary when savings exist', async () => {
    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Saved ~$1.23')
  })

  it('displays date when available', async () => {
    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Date:')
    expect(output).toContain('2024-01-15')
  })

  it('uses latest session ID when none specified', async () => {
    await runCostAction(defaultOptions())

    expect(mockGetLatestSessionId).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// AC2: --session <id> shows cost for specific session
// ---------------------------------------------------------------------------

describe('AC2: substrate cost --session <id>', () => {
  it('uses specified session ID instead of latest', async () => {
    const exitCode = await runCostAction(defaultOptions({ sessionId: 'my-session-id' }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    // Should NOT call getLatestSessionId when session is explicit
    expect(mockGetLatestSessionId).not.toHaveBeenCalled()
    // Should query with the specified session
    expect(mockGetSessionCostSummaryFiltered).toHaveBeenCalledWith(
      expect.anything(),
      'my-session-id',
      false,
    )
  })

  it('displays output for specified session', async () => {
    const customSummary = createMockSummary({ session_id: 'custom-sess' })
    mockGetSessionCostSummaryFiltered.mockReturnValue(customSummary)

    const exitCode = await runCostAction(defaultOptions({ sessionId: 'custom-sess' }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Session: custom-sess')
  })
})

// ---------------------------------------------------------------------------
// AC3: --by-task shows per-task breakdown
// ---------------------------------------------------------------------------

describe('AC3: substrate cost --by-task', () => {
  it('shows per-task cost breakdown table', async () => {
    const exitCode = await runCostAction(defaultOptions({ byTask: true }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Task ID')
    expect(output).toContain('Agent')
    expect(output).toContain('Billing Mode')
    expect(output).toContain('Cost ($)')
    expect(output).toContain('Savings ($)')
    expect(output).toContain('auth-setup')
    expect(output).toContain('api-test')
    expect(output).toContain('subscription')
    expect(output).toContain('api')
  })

  it('calls getAllCostEntriesFiltered with correct args', async () => {
    await runCostAction(defaultOptions({ byTask: true }))

    expect(mockGetAllCostEntriesFiltered).toHaveBeenCalledWith(
      expect.anything(),
      'session-abc123',
      false, // includePlanning=false by default
    )
  })

  it('respects includePlanning=false filter (FIX 3)', async () => {
    await runCostAction(defaultOptions({ byTask: true, includePlanning: false }))

    expect(mockGetAllCostEntriesFiltered).toHaveBeenCalledWith(
      expect.anything(),
      'session-abc123',
      false,
    )
  })

  it('respects includePlanning=true filter', async () => {
    await runCostAction(defaultOptions({ byTask: true, includePlanning: true }))

    expect(mockGetAllCostEntriesFiltered).toHaveBeenCalledWith(
      expect.anything(),
      'session-abc123',
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// AC4: --output-format json outputs valid JSON
// ---------------------------------------------------------------------------

describe('AC4: substrate cost --output-format json', () => {
  it('outputs valid JSON', async () => {
    const exitCode = await runCostAction(defaultOptions({ outputFormat: 'json' }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it('JSON output contains CLIJsonOutput structure', async () => {
    await runCostAction(defaultOptions({ outputFormat: 'json', version: '2.0.0' }))

    const parsed = JSON.parse(getStdout()) as {
      timestamp: string
      version: string
      command: string
      data: { session_id: string; summary: SessionCostSummary }
    }
    expect(parsed.command).toBe('substrate cost')
    expect(parsed.version).toBe('2.0.0')
    expect(parsed.timestamp).toBeDefined()
    expect(parsed.data.session_id).toBe('session-abc123')
    expect(parsed.data.summary).toBeDefined()
    expect(parsed.data.summary.total_cost_usd).toBe(0.42)
  })

  it('JSON output includes tasks when --by-task is set', async () => {
    await runCostAction(defaultOptions({ outputFormat: 'json', byTask: true }))

    const parsed = JSON.parse(getStdout()) as {
      data: { tasks?: CostEntry[] }
    }
    expect(parsed.data.tasks).toBeDefined()
    expect(parsed.data.tasks).toHaveLength(2)
  })

  it('JSON output includes agents when --by-agent is set', async () => {
    await runCostAction(defaultOptions({ outputFormat: 'json', byAgent: true }))

    const parsed = JSON.parse(getStdout()) as {
      data: { agents?: AgentCostBreakdown[] }
    }
    expect(parsed.data.agents).toBeDefined()
    expect(parsed.data.agents).toHaveLength(1)
    expect(parsed.data.agents?.[0]?.agent).toBe('claude-code')
  })
})

// ---------------------------------------------------------------------------
// AC5: Planning costs shown separately; --include-planning includes them
// ---------------------------------------------------------------------------

describe('AC5: planning costs shown separately', () => {
  it('default view (includePlanning=false) shows planning costs as excluded line', async () => {
    const filteredSummary = createMockSummary({ total_cost_usd: 0.30 })
    mockGetSessionCostSummaryFiltered.mockReturnValue(filteredSummary)
    mockGetPlanningCostTotal.mockReturnValue(0.12)

    const exitCode = await runCostAction(defaultOptions({ includePlanning: false }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Planning Costs (excluded):')
    expect(output).toContain('$0.1200')
  })

  it('--include-planning includes planning costs in totals (no separate line)', async () => {
    const fullSummary = createMockSummary({ total_cost_usd: 0.42 })
    mockGetSessionCostSummary.mockReturnValue(fullSummary)

    const exitCode = await runCostAction(defaultOptions({ includePlanning: true }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).not.toContain('Planning Costs (excluded):')
    expect(output).toContain('$0.4200')
  })

  it('uses getSessionCostSummaryFiltered when includePlanning=false', async () => {
    await runCostAction(defaultOptions({ includePlanning: false }))

    expect(mockGetSessionCostSummaryFiltered).toHaveBeenCalledWith(
      expect.anything(),
      'session-abc123',
      false,
    )
  })

  it('uses getSessionCostSummary when includePlanning=true', async () => {
    await runCostAction(defaultOptions({ includePlanning: true }))

    expect(mockGetSessionCostSummary).toHaveBeenCalledWith(
      expect.anything(),
      'session-abc123',
    )
    expect(mockGetSessionCostSummaryFiltered).not.toHaveBeenCalled()
  })

  it('does not show planning line when planning cost is zero', async () => {
    const filteredSummary = createMockSummary({ total_cost_usd: 0.42 })
    mockGetSessionCostSummaryFiltered.mockReturnValue(filteredSummary)
    mockGetPlanningCostTotal.mockReturnValue(0)

    const exitCode = await runCostAction(defaultOptions({ includePlanning: false }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).not.toContain('Planning Costs (excluded):')
  })
})

// ---------------------------------------------------------------------------
// AC6: --output-format csv outputs CSV
// ---------------------------------------------------------------------------

describe('AC6: substrate cost --output-format csv', () => {
  it('outputs valid CSV for session summary', async () => {
    const exitCode = await runCostAction(defaultOptions({ outputFormat: 'csv' }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('session_id,total_cost_usd,subscription_cost_usd,api_cost_usd,savings_usd')
    expect(output).toContain('session-abc123')
  })

  it('outputs per-task CSV when --by-task is set', async () => {
    const exitCode = await runCostAction(defaultOptions({ outputFormat: 'csv', byTask: true }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('task_id,agent,billing_mode,cost_usd,savings_usd')
    expect(output).toContain('auth-setup')
    expect(output).toContain('api-test')
  })

  it('CSV output has correct number of rows', async () => {
    await runCostAction(defaultOptions({ outputFormat: 'csv', byTask: true }))

    const lines = getStdout().trim().split('\n')
    // header + 2 entries + trailing newline handling
    expect(lines.length).toBe(3) // header + 2 data rows
  })
})

// ---------------------------------------------------------------------------
// AC7: Budget status shown
// ---------------------------------------------------------------------------

describe('AC7: budget status display', () => {
  it('shows budget cap when budget is set', async () => {
    const summaryWithBudget = createMockSummaryWithBudget()
    mockGetSessionCostSummaryFiltered.mockReturnValue(summaryWithBudget)
    mockGetSessionCostSummary.mockReturnValue(summaryWithBudget)

    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Budget: $10.00 cap')
  })

  it('shows remaining budget amount', async () => {
    const summaryWithBudget = createMockSummaryWithBudget()
    mockGetSessionCostSummaryFiltered.mockReturnValue(summaryWithBudget)
    mockGetSessionCostSummary.mockReturnValue(summaryWithBudget)

    await runCostAction(defaultOptions())

    const output = getStdout()
    expect(output).toContain('Remaining: $9.58')
  })

  it('shows percentage used', async () => {
    const summaryWithBudget = createMockSummaryWithBudget()
    mockGetSessionCostSummaryFiltered.mockReturnValue(summaryWithBudget)
    mockGetSessionCostSummary.mockReturnValue(summaryWithBudget)

    await runCostAction(defaultOptions())

    const output = getStdout()
    expect(output).toContain('Used: 4.2%')
  })

  it('shows budget status', async () => {
    const summaryWithBudget = createMockSummaryWithBudget()
    mockGetSessionCostSummaryFiltered.mockReturnValue(summaryWithBudget)
    mockGetSessionCostSummary.mockReturnValue(summaryWithBudget)

    await runCostAction(defaultOptions())

    const output = getStdout()
    expect(output).toContain('Status: ok')
  })

  it('does not show budget section when no budget set', async () => {
    // Default mock has no budget fields
    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).not.toContain('Budget:')
    expect(output).not.toContain('Remaining:')
  })

  it('shows budget info in JSON output', async () => {
    const summaryWithBudget = createMockSummaryWithBudget()
    mockGetSessionCostSummaryFiltered.mockReturnValue(summaryWithBudget)
    mockGetSessionCostSummary.mockReturnValue(summaryWithBudget)

    await runCostAction(defaultOptions({ outputFormat: 'json' }))

    const parsed = JSON.parse(getStdout()) as {
      data: { summary: SessionCostSummary }
    }
    expect(parsed.data.summary.budget_usd).toBe(10.0)
    expect(parsed.data.summary.remaining_budget_usd).toBe(9.58)
    expect(parsed.data.summary.percentage_used).toBe(4.2)
    expect(parsed.data.summary.budget_status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// AC8: Error handling
// ---------------------------------------------------------------------------

describe('AC8: error handling', () => {
  it('returns error when database file not found', async () => {
    mockExistsSync.mockReturnValue(false)

    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_ERROR)
    const errOutput = getStderr()
    expect(errOutput).toContain('No Substrate database found')
    expect(errOutput).toContain("Run 'substrate init' first")
  })

  it('returns success with "No cost data found" when no sessions exist', async () => {
    mockGetLatestSessionId.mockReturnValue(null)

    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('No cost data found')
  })

  it('returns success with "No cost data found" in JSON when no sessions exist', async () => {
    mockGetLatestSessionId.mockReturnValue(null)

    const exitCode = await runCostAction(defaultOptions({ outputFormat: 'json' }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const parsed = JSON.parse(getStdout()) as { data: { message: string } }
    expect(parsed.data.message).toBe('No cost data found')
  })

  it('returns success with "No cost data found" when session has no entries (task_count=0)', async () => {
    mockGetSessionCostSummaryFiltered.mockReturnValue(createEmptySummary())
    mockGetSessionCostSummary.mockReturnValue(createEmptySummary())

    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('No cost data found')
  })

  it('returns error for invalid output format (FIX 4)', async () => {
    const exitCode = await runCostAction(
      defaultOptions({ outputFormat: 'xml' as 'table' | 'json' | 'csv' }),
    )

    expect(exitCode).toBe(COST_EXIT_ERROR)
    const errOutput = getStderr()
    expect(errOutput).toContain('Invalid output format')
    expect(errOutput).toContain('xml')
    expect(errOutput).toContain('table, json, csv')
  })

  it('returns error for another invalid output format', async () => {
    const exitCode = await runCostAction(
      defaultOptions({ outputFormat: 'yaml' as 'table' | 'json' | 'csv' }),
    )

    expect(exitCode).toBe(COST_EXIT_ERROR)
    const errOutput = getStderr()
    expect(errOutput).toContain('Invalid output format')
    expect(errOutput).toContain('yaml')
  })

  it('handles database open error gracefully', async () => {
    mockOpen.mockImplementation(() => {
      throw new Error('cannot open database')
    })

    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_ERROR)
    const errOutput = getStderr()
    expect(errOutput).toContain('cannot open database')
  })

  it('handles query error gracefully', async () => {
    mockGetSessionCostSummaryFiltered.mockImplementation(() => {
      throw new Error('SQL error: no such table')
    })

    const exitCode = await runCostAction(defaultOptions())

    expect(exitCode).toBe(COST_EXIT_ERROR)
    const errOutput = getStderr()
    expect(errOutput).toContain('SQL error')
  })

  it('closes database wrapper in finally block even on error', async () => {
    mockGetSessionCostSummaryFiltered.mockImplementation(() => {
      throw new Error('some error')
    })

    await runCostAction(defaultOptions())

    expect(mockClose).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('exit code constants', () => {
  it('COST_EXIT_SUCCESS is 0', () => {
    expect(COST_EXIT_SUCCESS).toBe(0)
  })

  it('COST_EXIT_ERROR is 1', () => {
    expect(COST_EXIT_ERROR).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// formatCostSummaryTable unit tests
// ---------------------------------------------------------------------------

describe('formatCostSummaryTable', () => {
  it('includes session id and date', () => {
    const summary = createMockSummary()
    const result = formatCostSummaryTable(summary)

    expect(result).toContain('Session: session-abc123')
    expect(result).toContain('Date:')
  })

  it('includes cost breakdown', () => {
    const summary = createMockSummary()
    const result = formatCostSummaryTable(summary)

    expect(result).toContain('Total Cost:')
    expect(result).toContain('Subscription:')
    expect(result).toContain('API Billed:')
    expect(result).toContain('Savings:')
  })

  it('shows planning costs excluded line when includePlanning=false and cost > 0', () => {
    const summary = createMockSummary()
    const result = formatCostSummaryTable(summary, false, 0.15)

    expect(result).toContain('Planning Costs (excluded): $0.1500')
  })

  it('does not show planning line when includePlanning=true', () => {
    const summary = createMockSummary()
    const result = formatCostSummaryTable(summary, true, 0.15)

    expect(result).not.toContain('Planning Costs')
  })

  it('does not show planning line when planningCostUsd is 0', () => {
    const summary = createMockSummary()
    const result = formatCostSummaryTable(summary, false, 0)

    expect(result).not.toContain('Planning Costs')
  })

  it('includes budget section when budget_usd is set', () => {
    const summary = createMockSummaryWithBudget()
    const result = formatCostSummaryTable(summary)

    expect(result).toContain('Budget: $10.00 cap')
    expect(result).toContain('Remaining: $9.58')
    expect(result).toContain('Used: 4.2%')
    expect(result).toContain('Status: ok')
  })

  it('singular "task" for count of 1', () => {
    const summary = createMockSummary({
      subscription_task_count: 1,
      api_task_count: 1,
    })
    const result = formatCostSummaryTable(summary)

    expect(result).toContain('(1 task)')
    // Not "1 tasks"
    expect(result).not.toContain('1 tasks')
  })
})

// ---------------------------------------------------------------------------
// formatByTaskTable unit tests
// ---------------------------------------------------------------------------

describe('formatByTaskTable', () => {
  it('formats entries as a table', () => {
    const entries = createMockEntries()
    const result = formatByTaskTable(entries)

    expect(result).toContain('Task ID')
    expect(result).toContain('auth-setup')
    expect(result).toContain('api-test')
    expect(result).toContain('subscription')
    expect(result).toContain('api')
  })

  it('returns message when no entries', () => {
    const result = formatByTaskTable([])
    expect(result).toContain('No task cost entries found')
  })

  it('handles null task_id gracefully', () => {
    const entries: CostEntry[] = [
      {
        id: 1,
        session_id: 'sess',
        task_id: null,
        agent: 'claude-code',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        billing_mode: 'api',
        tokens_input: 100,
        tokens_output: 50,
        cost_usd: 0.01,
        savings_usd: 0.0,
        created_at: '2024-01-01',
      },
    ]
    const result = formatByTaskTable(entries)
    expect(result).toContain('(no task)')
  })
})

// ---------------------------------------------------------------------------
// formatByAgentTable unit tests
// ---------------------------------------------------------------------------

describe('formatByAgentTable', () => {
  it('formats agent breakdown as table', () => {
    const breakdown: AgentCostBreakdown[] = [
      {
        agent: 'claude-code',
        task_count: 8,
        cost_usd: 0.42,
        savings_usd: 1.23,
        subscription_tasks: 3,
        api_tasks: 5,
      },
    ]
    const result = formatByAgentTable(breakdown)

    expect(result).toContain('Agent')
    expect(result).toContain('claude-code')
    expect(result).toContain('8')
    expect(result).toContain('3')
    expect(result).toContain('5')
  })

  it('returns message when no agent data', () => {
    const result = formatByAgentTable([])
    expect(result).toContain('No agent cost data found')
  })
})

// ---------------------------------------------------------------------------
// formatByBillingTable unit tests
// ---------------------------------------------------------------------------

describe('formatByBillingTable', () => {
  it('formats billing breakdown as table', () => {
    const summary = createMockSummary()
    const result = formatByBillingTable(summary)

    expect(result).toContain('Billing Mode')
    expect(result).toContain('subscription')
    expect(result).toContain('api')
    expect(result).toContain('Tasks')
    expect(result).toContain('Cost ($)')
    expect(result).toContain('Savings ($)')
  })
})

// ---------------------------------------------------------------------------
// formatCostCsv unit tests
// ---------------------------------------------------------------------------

describe('formatCostCsv', () => {
  it('outputs session summary CSV when no task entries', () => {
    const summary = createMockSummary()
    const result = formatCostCsv(summary)

    expect(result).toContain('session_id,total_cost_usd,subscription_cost_usd,api_cost_usd,savings_usd')
    expect(result).toContain('session-abc123,0.4200,0.0000,0.4200,1.2300')
  })

  it('outputs per-task CSV when entries provided', () => {
    const summary = createMockSummary()
    const entries = createMockEntries()
    const result = formatCostCsv(summary, entries)

    expect(result).toContain('task_id,agent,billing_mode,cost_usd,savings_usd')
    expect(result).toContain('auth-setup,claude-code,subscription,0.0000,0.4500')
    expect(result).toContain('api-test,claude-code,api,0.2500,0.0000')
  })

  it('outputs summary CSV when empty entries array provided', () => {
    const summary = createMockSummary()
    const result = formatCostCsv(summary, [])

    expect(result).toContain('session_id,total_cost_usd')
  })
})

// ---------------------------------------------------------------------------
// by-agent and by-billing view integration
// ---------------------------------------------------------------------------

describe('--by-agent view', () => {
  it('displays per-agent breakdown table', async () => {
    const exitCode = await runCostAction(defaultOptions({ byAgent: true }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Agent')
    expect(output).toContain('claude-code')
  })
})

describe('--by-billing view', () => {
  it('displays billing mode breakdown table', async () => {
    const exitCode = await runCostAction(defaultOptions({ byBilling: true }))

    expect(exitCode).toBe(COST_EXIT_SUCCESS)
    const output = getStdout()
    expect(output).toContain('Billing Mode')
    expect(output).toContain('subscription')
    expect(output).toContain('api')
  })
})
