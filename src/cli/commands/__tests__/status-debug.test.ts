import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockOpen = vi.fn()
const mockClose = vi.fn()
let mockDb: Record<string, unknown> = {}

vi.mock('../../../persistence/database.js', () => ({
  DatabaseWrapper: vi.fn().mockImplementation(() => ({
    open: mockOpen,
    close: mockClose,
    get db() { return mockDb },
  })),
}))

vi.mock('../../../persistence/migrations/index.js', () => ({
  runMigrations: vi.fn(),
}))

const mockGetSession = vi.fn()
const mockGetLatestSessionId = vi.fn()

vi.mock('../../../persistence/queries/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getLatestSessionId: (...args: unknown[]) => mockGetLatestSessionId(...args),
}))

const mockGetAllTasks = vi.fn()

vi.mock('../../../persistence/queries/tasks.js', () => ({
  getAllTasks: (...args: unknown[]) => mockGetAllTasks(...args),
}))

vi.mock('fs', () => ({
  existsSync: () => true,
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { runStatusAction } from '../status.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockDb = {}
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('debug', () => {
  it('AC1 direct', async () => {
    const session = {
      id: 'test-session-id', name: null, graph_file: 'tasks.yaml', status: 'active',
      budget_usd: null, total_cost_usd: 1.23, planning_cost_usd: 0,
      config_snapshot: null, base_branch: 'main', plan_source: null, planning_agent: null,
      created_at: new Date(Date.now() - 10000).toISOString(),
      updated_at: new Date().toISOString(),
    }
    mockGetSession.mockReturnValue(session)
    mockGetAllTasks.mockReturnValue([])

    const stderrCalls: string[] = []
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      stderrCalls.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    const stdoutCalls: string[] = []
    const origStdout = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      stdoutCalls.push(String(chunk))
      return true
    }) as typeof process.stdout.write

    const exitCode = await runStatusAction({
      sessionId: 'test-session-id',
      watch: false,
      outputFormat: 'human',
      showGraph: false,
      pollIntervalMs: 2000,
      projectRoot: '/test/project',
    })

    process.stderr.write = origStderr
    process.stdout.write = origStdout

    console.log('Exit code:', exitCode)
    console.log('STDERR:', stderrCalls)
    console.log('STDOUT:', stdoutCalls.map(s => s.substring(0, 50)))
    
    expect(exitCode).toBe(0)
  })
})
