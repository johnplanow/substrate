/**
 * Unit tests for BuildCheck — Story 51-4.
 *
 * Framework: vitest (describe / it / expect / vi — no Jest globals, no jest.fn()).
 * All shell commands and filesystem calls are mocked — no real processes are spawned.
 *
 * AC coverage:
 *   AC1 — passing build (exit 0) → status: 'pass'
 *   AC2 — failing build (non-zero exit) → status: 'fail' with truncated output
 *   AC3 — timeout + process group kill → status: 'fail' with "build-timeout"
 *   AC4 — no recognized build system → status: 'warn' with "build-skip"
 *   AC5 — explicit buildCommand override used; empty string → warn
 *   AC6 — name === 'build', tier === 'A', run is a function
 *   AC7 — ≥9 it() cases; duration_ms is a non-negative number
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// Module-level mocks must be hoisted before the module imports
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}))

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  BuildCheck,
  BUILD_CHECK_TIMEOUT_MS,
  detectBuildCommand,
} from '../../verification/checks/build-check.js'
import type { VerificationContext } from '../../verification/types.js'

const mockSpawn = vi.mocked(spawn)
const mockExistsSync = vi.mocked(existsSync)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    storyKey: '51-4',
    workingDir: '/tmp/test-project',
    commitSha: 'abc123',
    timeout: 30_000,
    ...overrides,
  }
}

/**
 * Create a mock ChildProcess-like object that emits data and close events
 * on stdout/stderr, and exposes `on` for the 'close' event.
 */
function makeMockChild(exitCode: number | null, stdout = '', stderr = '') {
  const child = new EventEmitter() as ReturnType<typeof spawn>

  // Mock stdout and stderr as readable-stream-like objects
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).stdout = stdoutEmitter
  ;(child as unknown as Record<string, unknown>).stderr = stderrEmitter
  ;(child as unknown as Record<string, unknown>).pid = 12345

  // Emit stdout/stderr data then close in the next microtask
  process.nextTick(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout))
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr))
    child.emit('close', exitCode)
  })

  return child
}

/**
 * Create a mock ChildProcess that never fires its 'close' event (simulates a hang).
 */
function makeHangingChild() {
  const child = new EventEmitter() as ReturnType<typeof spawn>
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).stdout = stdoutEmitter
  ;(child as unknown as Record<string, unknown>).stderr = stderrEmitter
  ;(child as unknown as Record<string, unknown>).pid = 12345
  // Never emits 'close'
  return child
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BuildCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: existsSync returns false (no build markers found)
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // AC6 — metadata
  // -------------------------------------------------------------------------

  it('has name "build" and tier "A"', () => {
    const check = new BuildCheck()
    expect(check.name).toBe('build')
    expect(check.tier).toBe('A')
  })

  it('has a run method that is a function', () => {
    const check = new BuildCheck()
    expect(typeof check.run).toBe('function')
  })

  // -------------------------------------------------------------------------
  // AC1 — passing build
  // -------------------------------------------------------------------------

  it('returns pass when build command exits with code 0', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    mockSpawn.mockReturnValue(makeMockChild(0))

    const check = new BuildCheck()
    const result = await check.run(makeContext())

    expect(result.status).toBe('pass')
    expect(result.details).toBe('build passed')
  })

  // -------------------------------------------------------------------------
  // AC2 — failing build with output
  // -------------------------------------------------------------------------

  it('returns fail with output details when build command exits with non-zero code', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    mockSpawn.mockReturnValue(makeMockChild(1, '', 'error TS2322: Type mismatch'))

    const check = new BuildCheck()
    const result = await check.run(makeContext())

    expect(result.status).toBe('fail')
    expect(result.details).toContain('build failed')
    expect(result.details).toContain('exit 1')
    expect(result.details).toContain('error TS2322')
  })

  it('truncates build output exceeding 2000 chars and appends "... (truncated)"', async () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    // Create output longer than MAX_OUTPUT_CHARS (2000)
    const longOutput = 'a'.repeat(2500)
    mockSpawn.mockReturnValue(makeMockChild(1, longOutput))

    const check = new BuildCheck()
    const result = await check.run(makeContext())

    expect(result.status).toBe('fail')
    // Suffix is appended when truncated
    expect(result.details).toContain('... (truncated)')
    // First 2000 chars are preserved
    expect(result.details).toContain('a'.repeat(2000))
    // The full 2500-char string is NOT present — confirms truncation happened
    expect(result.details).not.toContain('a'.repeat(2001))
  })

  // -------------------------------------------------------------------------
  // AC3 — timeout + process group kill
  // -------------------------------------------------------------------------

  it('returns fail with build-timeout message and kills process group on timeout', async () => {
    vi.useFakeTimers()

    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    mockSpawn.mockReturnValue(makeHangingChild())

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const check = new BuildCheck()
    const resultPromise = check.run(makeContext())

    // Advance time past the timeout
    await vi.advanceTimersByTimeAsync(BUILD_CHECK_TIMEOUT_MS + 1)

    const result = await resultPromise

    expect(result.status).toBe('fail')
    expect(result.details).toContain('build-timeout')
    expect(result.details).toContain(`${BUILD_CHECK_TIMEOUT_MS}ms`)
    expect(result.duration_ms).toBeGreaterThanOrEqual(BUILD_CHECK_TIMEOUT_MS)

    // Should have killed the process group (negative PID)
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL')

    killSpy.mockRestore()
  })

  // -------------------------------------------------------------------------
  // AC4 — no build system detected → warn
  // -------------------------------------------------------------------------

  it('returns warn with build-skip when no build system is detected and no override', async () => {
    // existsSync always returns false → no build markers
    mockExistsSync.mockReturnValue(false)

    const check = new BuildCheck()
    const result = await check.run(makeContext())

    expect(result.status).toBe('warn')
    expect(result.details).toContain('build-skip')
    expect(result.details).toContain('/tmp/test-project')
    // spawn should NOT have been called
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC5 — explicit buildCommand override used
  // -------------------------------------------------------------------------

  it('uses explicit buildCommand override instead of detecting from filesystem', async () => {
    // existsSync returns false everywhere — but we override the command
    mockExistsSync.mockReturnValue(false)
    mockSpawn.mockReturnValue(makeMockChild(0))

    const check = new BuildCheck()
    const result = await check.run(makeContext({ buildCommand: 'make release' }))

    expect(result.status).toBe('pass')
    // spawn should have been called with the override command
    expect(mockSpawn).toHaveBeenCalledWith(
      'make release',
      [],
      expect.objectContaining({ cwd: '/tmp/test-project', shell: true })
    )
  })

  it('returns warn when buildCommand override is an empty string (explicit skip)', async () => {
    const check = new BuildCheck()
    const result = await check.run(makeContext({ buildCommand: '' }))

    expect(result.status).toBe('warn')
    expect(result.details).toContain('build-skip')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC7 — duration_ms type and value
  // -------------------------------------------------------------------------

  it('includes a non-negative number duration_ms in all result types', async () => {
    // Pass case
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    mockSpawn.mockReturnValue(makeMockChild(0))
    const check = new BuildCheck()

    const passResult = await check.run(makeContext())
    expect(typeof passResult.duration_ms).toBe('number')
    expect(passResult.duration_ms).toBeGreaterThanOrEqual(0)

    // Warn case (no build system)
    mockExistsSync.mockReturnValue(false)
    const warnResult = await check.run(makeContext())
    expect(typeof warnResult.duration_ms).toBe('number')
    expect(warnResult.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// detectBuildCommand unit tests
// ---------------------------------------------------------------------------

describe('detectBuildCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  it('returns "turbo build" when turbo.json is present (priority 1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('turbo.json'))
    expect(detectBuildCommand('/project')).toBe('turbo build')
  })

  it('returns "pnpm run build" when pnpm-lock.yaml is present (priority 2)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pnpm-lock.yaml'))
    expect(detectBuildCommand('/project')).toBe('pnpm run build')
  })

  it('returns "npm run build" when only package.json is present (priority 5)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package.json'))
    expect(detectBuildCommand('/project')).toBe('npm run build')
  })

  it('returns empty string when pyproject.toml is present (non-Node marker)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pyproject.toml'))
    expect(detectBuildCommand('/project')).toBe('')
  })

  it('returns empty string when nothing is found', () => {
    mockExistsSync.mockReturnValue(false)
    expect(detectBuildCommand('/project')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// BUILD_CHECK_TIMEOUT_MS constant
// ---------------------------------------------------------------------------

describe('BUILD_CHECK_TIMEOUT_MS', () => {
  it('is 60000 (60 seconds)', () => {
    expect(BUILD_CHECK_TIMEOUT_MS).toBe(60_000)
  })
})
