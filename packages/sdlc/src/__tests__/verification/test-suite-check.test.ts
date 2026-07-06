/**
 * TestSuiteCheck tests (H1.2, hardening program — field finding #11).
 *
 * The check runs the project's REAL test suite (profile testCommand /
 * context override) and gates on ground truth. Mirrors build-check.test.ts's
 * mocked-spawn harness: no real processes, no real fs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import {
  TestSuiteCheck,
  detectTestCommand,
} from '../../verification/checks/test-suite-check.js'
import type { VerificationContext } from '../../verification/types.js'
import { detectsExitCodeLaundering } from '../../verification/checks/test-suite-check.js'

const mockSpawn = vi.mocked(spawn)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    storyKey: 'h1-2',
    workingDir: '/tmp/test-project',
    commitSha: 'abc123',
    timeout: 30_000,
    ...overrides,
  }
}

function makeMockChild(exitCode: number | null, stdout = '', stderr = '') {
  const child = new EventEmitter() as ReturnType<typeof spawn>
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).stdout = stdoutEmitter
  ;(child as unknown as Record<string, unknown>).stderr = stderrEmitter
  ;(child as unknown as Record<string, unknown>).pid = 12345
  process.nextTick(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout))
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr))
    child.emit('close', exitCode)
  })
  return child
}

const UV_PROFILE =
  'project:\n  type: single\n  language: python\n  buildTool: uv\n  buildCommand: uv sync\n  testCommand: uv run pytest\n'

describe('TestSuiteCheck (H1.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    // These tests use a MOCKED spawn (no real processes), so the vitest
    // recursion guard can be safely opted out to exercise the check body.
    process.env.SUBSTRATE_ALLOW_NESTED_TESTS = '1'
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.SUBSTRATE_ALLOW_NESTED_TESTS
  })

  it('GUARDRAIL: refuses to run inside a test runner (VITEST set) unless explicitly allowed', async () => {
    delete process.env.SUBSTRATE_ALLOW_NESTED_TESTS
    // Profile exists with a real testCommand — without the guard this would spawn.
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)

    const check = new TestSuiteCheck()
    const result = await check.run(makeContext())

    expect(result.status).toBe('warn')
    expect(result.details).toContain('recursion guard')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('has name "test-suite" and tier "A"', () => {
    const check = new TestSuiteCheck()
    expect(check.name).toBe('test-suite')
    expect(check.tier).toBe('A')
  })

  it('warn-skips with guidance when no test command is configured', async () => {
    const check = new TestSuiteCheck()
    const result = await check.run(makeContext())
    expect(result.status).toBe('warn')
    expect(result.findings[0]?.category).toBe('test-suite-skip')
    expect(result.details).toContain('project-profile.yaml')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('runs the profile testCommand in the worktree and passes on exit 0 (the uv case)', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)
    mockSpawn.mockReturnValue(makeMockChild(0, '2 passed in 0.01s'))

    const check = new TestSuiteCheck()
    const result = await check.run(makeContext({ workingDir: '/wt' }))

    expect(result.status).toBe('pass')
    expect(mockSpawn).toHaveBeenCalledWith(
      'uv run pytest',
      [],
      expect.objectContaining({ cwd: '/wt', shell: true, detached: true }),
    )
  })

  it('FAILS on a red suite with the failing output in the finding (finding #11 regression)', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)
    mockSpawn.mockReturnValue(
      makeMockChild(1, 'FAILED tests/test_pause.py::test_absence_pause - AssertionError\n1 failed, 56 passed'),
    )

    const check = new TestSuiteCheck()
    const result = await check.run(makeContext({ workingDir: '/wt' }))

    expect(result.status).toBe('fail')
    expect(result.findings[0]?.category).toBe('test-suite-fail')
    expect(result.findings[0]?.message).toContain('test_absence_pause')
    expect(result.findings[0]?.exitCode).toBe(1)
  })

  it('H1.6: flags tests-claim-mismatch when the agent claimed pass over a red suite', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)
    mockSpawn.mockReturnValue(makeMockChild(1, '1 failed'))

    const check = new TestSuiteCheck()
    const result = await check.run(
      makeContext({
        workingDir: '/wt',
        devStoryResult: { result: 'success', ac_met: [], ac_failures: [], files_modified: [], tests: 'pass' },
      }),
    )

    expect(result.status).toBe('fail')
    const categories = result.findings.map((f) => f.category)
    expect(categories).toContain('test-suite-fail')
    expect(categories).toContain('tests-claim-mismatch')
  })

  it('context.testCommand override outranks the profile', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)
    mockSpawn.mockReturnValue(makeMockChild(0, 'ok'))

    const check = new TestSuiteCheck()
    await check.run(makeContext({ testCommand: 'make test-fast' }))

    expect(mockSpawn).toHaveBeenCalledWith('make test-fast', [], expect.anything())
  })

  it('empty-string override means EXPLICIT SKIP even when a profile with a testCommand exists', async () => {
    // Regression: the first implementation let '' fall through to profile
    // detection — in substrate's own repo (profile testCommand: npm test)
    // that recursively spawned the whole suite inside the tests, orphaning
    // 25 vitest processes in one session. '' must mean skip, full stop.
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)

    const check = new TestSuiteCheck()
    const result = await check.run(makeContext({ testCommand: '' }))

    expect(result.status).toBe('warn')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('fails (not throws) when the command cannot be spawned', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('project-profile.yaml'))
    mockReadFileSync.mockReturnValue(UV_PROFILE)
    const child = new EventEmitter() as ReturnType<typeof spawn>
    ;(child as unknown as Record<string, unknown>).stdout = new EventEmitter()
    ;(child as unknown as Record<string, unknown>).stderr = new EventEmitter()
    process.nextTick(() => child.emit('error', new Error('spawn uv ENOENT')))
    mockSpawn.mockReturnValue(child)

    const check = new TestSuiteCheck()
    const result = await check.run(makeContext())

    expect(result.status).toBe('fail')
    expect(result.findings[0]?.category).toBe('test-suite-error')
    expect(result.findings[0]?.message).toContain('ENOENT')
  })
})

describe('H7: exit-code laundering rejection', () => {
  it.each([
    'python3 -m pytest -q || true',
    'uv run pytest ; exit 0',
    'pytest || :',
    'npm test || exit 0',
    'go test ./... ; true',
    'pytest ; { exit 0; }',
    'pytest || return 0',
    'pytest || exec true',
  ])('FAILS a test command that masks its exit code: %s', async (cmd) => {
    const check = new TestSuiteCheck()
    // explicit override path — the command reaches the check as context.testCommand
    const result = await check.run(makeContext({ testCommand: cmd }))
    expect(result.status).toBe('fail')
    expect(result.findings?.[0]?.category).toBe('test-command-tampered')
  })

  it.each([
    'uv run pytest -q',
    'npm run build && npm test',
    'pytest tests/',
    'pytest && exit 0',
  ])('does NOT flag a legitimate command: %s', (cmd) => {
    expect(detectsExitCodeLaundering(cmd)).toBe(false)
  })

  it('rejects laundering BEFORE spawning the suite (no child process)', async () => {
    vi.mocked(spawn).mockClear()
    const check = new TestSuiteCheck()
    const result = await check.run(makeContext({ testCommand: 'pytest || true' }))
    expect(result.status).toBe('fail')
    // spawn must not have been called — the guard short-circuits.
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })
})

describe('detectTestCommand (H1.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  it('returns undefined when the profile is absent', () => {
    expect(detectTestCommand('/project')).toBeUndefined()
  })

  it('reads project.testCommand from the profile', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(UV_PROFILE)
    expect(detectTestCommand('/project')).toBe('uv run pytest')
  })

  it('returns undefined when the profile has no testCommand', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('project:\n  type: single\n  language: python\n')
    expect(detectTestCommand('/project')).toBeUndefined()
  })
})
