/**
 * Unit tests for runBuildVerification (Story 24-2).
 *
 * Tests the build verification gate that runs after dev-story and before
 * code-review to catch compile-time errors before wasting a review cycle.
 *
 * Mocks execSync to avoid spawning real build processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runBuildVerification, DEFAULT_VERIFY_COMMAND, DEFAULT_VERIFY_TIMEOUT_MS } from '../dispatcher-impl.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock node:child_process so execSync never runs a real process.
// Also provides spawn (used by DispatcherImpl) to avoid module errors.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

// Mock node:os so platform() returns 'linux' (avoids vm_stat calls in
// getAvailableMemory()) and freemem() returns ample memory.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    freemem: vi.fn(() => 4 * 1024 * 1024 * 1024), // 4 GB
    platform: vi.fn(() => 'linux'),
  }
})

// Import the mocked execSync AFTER vi.mock() declarations (hoisting ensures
// the mock is applied before module code runs).
import { execSync } from 'node:child_process'

const mockExecSync = vi.mocked(execSync)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an error object similar to what execSync throws on non-zero exit */
function makeExecError(opts: {
  status?: number | null
  stdout?: string
  stderr?: string
  killed?: boolean
  signal?: string | null
}): Error & { status?: number | null; stdout?: string; stderr?: string; killed?: boolean; signal?: string | null } {
  const err = new Error('Command failed') as Error & {
    status?: number | null
    stdout?: string
    stderr?: string
    killed?: boolean
    signal?: string | null
  }
  err.status = opts.status ?? 1
  err.stdout = opts.stdout ?? ''
  err.stderr = opts.stderr ?? ''
  err.killed = opts.killed ?? false
  err.signal = opts.signal ?? null
  return err
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runBuildVerification', () => {
  const projectRoot = '/fake/project'

  beforeEach(() => {
    mockExecSync.mockReset()
  })

  // -------------------------------------------------------------------------
  // AC2: Build success proceeds to review
  // -------------------------------------------------------------------------

  it('returns status: passed when command exits with code 0', () => {
    mockExecSync.mockReturnValue('Build succeeded\n')

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('passed')
    expect(result.exitCode).toBe(0)
  })

  it('uses default command "npm run build" when verifyCommand is not specified (AC5)', () => {
    mockExecSync.mockReturnValue('')

    runBuildVerification({ projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      DEFAULT_VERIFY_COMMAND,
      expect.objectContaining({ cwd: projectRoot }),
    )
  })

  it('uses verifyCommand from pack manifest when present (AC4)', () => {
    mockExecSync.mockReturnValue('')

    runBuildVerification({ verifyCommand: 'pnpm build', projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      'pnpm build',
      expect.objectContaining({ cwd: projectRoot }),
    )
  })

  it('uses default timeout of 60s when verifyTimeoutMs is not specified', () => {
    mockExecSync.mockReturnValue('')

    runBuildVerification({ projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: DEFAULT_VERIFY_TIMEOUT_MS }),
    )
  })

  it('uses custom verifyTimeoutMs when specified', () => {
    mockExecSync.mockReturnValue('')

    runBuildVerification({ projectRoot, verifyTimeoutMs: 30_000 })

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 30_000 }),
    )
  })

  // -------------------------------------------------------------------------
  // AC3: Build failure escalates
  // -------------------------------------------------------------------------

  it('returns status: failed when command exits with non-zero code (AC3)', () => {
    const err = makeExecError({ status: 1, stderr: 'Type error in foo.ts\n' })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
    expect(result.reason).toBe('build-verification-failed')
  })

  it('captures stderr output in the result on build failure (AC3)', () => {
    const err = makeExecError({ status: 1, stderr: 'Cannot find module "missing-module"', stdout: '' })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.output).toContain('Cannot find module "missing-module"')
  })

  it('combines stdout and stderr output on build failure', () => {
    const err = makeExecError({ status: 1, stdout: 'partial output', stderr: 'error details' })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.output).toContain('partial output')
    expect(result.output).toContain('error details')
  })

  it('returns exitCode from error.status on failure', () => {
    const err = makeExecError({ status: 2 })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.exitCode).toBe(2)
  })

  // -------------------------------------------------------------------------
  // AC8: Timeout protection
  // -------------------------------------------------------------------------

  it('returns status: timeout when process is killed due to timeout (AC8)', () => {
    const err = makeExecError({ killed: true, signal: 'SIGTERM', status: null })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('timeout')
    expect(result.reason).toBe('build-verification-timeout')
    expect(result.exitCode).toBe(-1)
  })

  it('returns timeout reason when killed is true regardless of signal value', () => {
    const err = makeExecError({ killed: true, signal: null, status: null })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('timeout')
    expect(result.reason).toBe('build-verification-timeout')
  })

  // -------------------------------------------------------------------------
  // AC6: Gate can be disabled
  // -------------------------------------------------------------------------

  it('returns status: skipped when verifyCommand is empty string (AC6)', () => {
    const result = runBuildVerification({ verifyCommand: '', projectRoot })

    expect(result.status).toBe('skipped')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('returns status: skipped when verifyCommand is false (AC6)', () => {
    const result = runBuildVerification({ verifyCommand: false, projectRoot })

    expect(result.status).toBe('skipped')
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  it('DEFAULT_VERIFY_COMMAND is "npm run build"', () => {
    expect(DEFAULT_VERIFY_COMMAND).toBe('npm run build')
  })

  it('DEFAULT_VERIFY_TIMEOUT_MS is 60000', () => {
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(60_000)
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles non-Error throw from execSync gracefully', () => {
    mockExecSync.mockImplementation(() => { throw 'string error' })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('build-verification-failed')
    expect(result.output).toBe('string error')
  })

  it('handles Buffer stdout/stderr in error object', () => {
    const err = makeExecError({ status: 1 })
    // Simulate Buffer values (as execSync may return without encoding option)
    ;(err as Record<string, unknown>).stdout = Buffer.from('stdout bytes')
    ;(err as Record<string, unknown>).stderr = Buffer.from('stderr bytes')
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.output).toContain('stdout bytes')
    expect(result.output).toContain('stderr bytes')
  })
})
