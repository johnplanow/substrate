/**
 * Unit tests for runBuildVerification (Story 24-2).
 *
 * Tests the build verification gate that runs after dev-story and before
 * code-review to catch compile-time errors before wasting a review cycle.
 *
 * Mocks execSync to avoid spawning real build processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runBuildVerification,
  detectPackageManager,
  DEFAULT_VERIFY_COMMAND,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from '../dispatcher-impl.js'

// ---------------------------------------------------------------------------
// Hoisted spies (must be defined before vi.mock calls are hoisted)
// ---------------------------------------------------------------------------

const mockLoggerInfo = vi.hoisted(() => vi.fn())

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the logger so we can assert on logger.info calls (AC4).
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }),
}))

// Mock node:child_process so execSync never runs a real process.
// Also provides spawn (used by DispatcherImpl) to avoid module errors.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

// Mock node:fs so existsSync/readFileSync never touch the real filesystem.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
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

// Import the mocked helpers AFTER vi.mock() declarations (hoisting ensures
// the mock is applied before module code runs).
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const mockExecSync = vi.mocked(execSync)
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

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
    mockLoggerInfo.mockReset()
    // Default: no lockfiles present (existsSync returns false)
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
  })

  // -------------------------------------------------------------------------
  // AC2: Build success proceeds to review
  // -------------------------------------------------------------------------

  it('returns status: passed when command exits with code 0', () => {
    // Simulate a Node.js project so detection finds a lockfile
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    mockExecSync.mockReturnValue('Build succeeded\n')

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('passed')
    expect(result.exitCode).toBe(0)
  })

  it('uses default command "npm run build" when verifyCommand is not specified and package-lock.json present (AC5)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    mockExecSync.mockReturnValue('')

    runBuildVerification({ projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      DEFAULT_VERIFY_COMMAND,
      expect.objectContaining({ cwd: projectRoot }),
    )
  })

  it('returns status: skipped when no build system is detected (no lockfiles, no markers)', () => {
    mockExistsSync.mockReturnValue(false)

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('skipped')
    expect(mockExecSync).not.toHaveBeenCalled()
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
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    mockExecSync.mockReturnValue('')

    runBuildVerification({ projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: DEFAULT_VERIFY_TIMEOUT_MS }),
    )
  })

  it('uses custom verifyTimeoutMs when specified', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
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
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({ status: 1, stderr: 'Type error in foo.ts\n' })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(1)
    expect(result.reason).toBe('build-verification-failed')
  })

  it('captures stderr output in the result on build failure (AC3)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({ status: 1, stderr: 'Cannot find module "missing-module"', stdout: '' })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.output).toContain('Cannot find module "missing-module"')
  })

  it('combines stdout and stderr output on build failure', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({ status: 1, stdout: 'partial output', stderr: 'error details' })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.output).toContain('partial output')
    expect(result.output).toContain('error details')
  })

  it('returns exitCode from error.status on failure', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({ status: 2 })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.exitCode).toBe(2)
  })

  // -------------------------------------------------------------------------
  // AC8: Timeout protection
  // -------------------------------------------------------------------------

  it('returns status: timeout when process is killed due to timeout (AC8)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({ killed: true, signal: 'SIGTERM', status: null })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('timeout')
    expect(result.reason).toBe('build-verification-timeout')
    expect(result.exitCode).toBe(-1)
  })

  it('returns timeout reason when killed is true regardless of signal value', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
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
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    mockExecSync.mockImplementation(() => { throw 'string error' })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('build-verification-failed')
    expect(result.output).toBe('string error')
  })

  // -------------------------------------------------------------------------
  // Greenfield detection: missing build script → skip (not fail)
  // -------------------------------------------------------------------------

  it('returns status: skipped when npm reports "Missing script" (greenfield repo)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({
      status: 1,
      stderr: 'npm error Missing script: "build"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n',
    })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('build-script-not-found')
  })

  it('returns status: skipped when yarn reports "Command build not found" (greenfield repo)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('yarn.lock'))
    const err = makeExecError({
      status: 1,
      stderr: 'error Command "build" not found.',
    })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('build-script-not-found')
  })

  it('still returns status: failed for real build errors (not missing script)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({
      status: 1,
      stderr: 'error TS2304: Cannot find name "foo".',
    })
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.status).toBe('failed')
    expect(result.reason).toBe('build-verification-failed')
  })

  it('handles Buffer stdout/stderr in error object', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))
    const err = makeExecError({ status: 1 })
    // Simulate Buffer values (as execSync may return without encoding option)
    ;(err as Record<string, unknown>).stdout = Buffer.from('stdout bytes')
    ;(err as Record<string, unknown>).stderr = Buffer.from('stderr bytes')
    mockExecSync.mockImplementation(() => { throw err })

    const result = runBuildVerification({ projectRoot })

    expect(result.output).toContain('stdout bytes')
    expect(result.output).toContain('stderr bytes')
  })

  // -------------------------------------------------------------------------
  // AC1 + AC4 integration: auto-detection through runBuildVerification
  // -------------------------------------------------------------------------

  it('uses pnpm run build when pnpm-lock.yaml detected (AC1, AC4)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pnpm-lock.yaml'))
    mockExecSync.mockReturnValue('')

    runBuildVerification({ projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      'pnpm run build',
      expect.objectContaining({ cwd: projectRoot }),
    )

    // AC4: logger.info must be called with the detection fields
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        packageManager: 'pnpm',
        lockfile: 'pnpm-lock.yaml',
        resolvedCommand: 'pnpm run build',
      }),
      expect.any(String),
    )
  })

  it('uses explicit verifyCommand even when pnpm-lock.yaml exists (AC2)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pnpm-lock.yaml'))
    mockExecSync.mockReturnValue('')

    runBuildVerification({ verifyCommand: 'make build', projectRoot })

    expect(mockExecSync).toHaveBeenCalledWith(
      'make build',
      expect.objectContaining({ cwd: projectRoot }),
    )
  })
})

// ---------------------------------------------------------------------------
// detectPackageManager (Story 24-8)
// ---------------------------------------------------------------------------

describe('detectPackageManager', () => {
  const projectRoot = '/fake/project'

  beforeEach(() => {
    mockExistsSync.mockReset()
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockReset()
    mockExecSync.mockReset()
  })

  it('returns pnpm run build when pnpm-lock.yaml exists (AC1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pnpm-lock.yaml'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('pnpm')
    expect(result.lockfile).toBe('pnpm-lock.yaml')
    expect(result.command).toBe('pnpm run build')
  })

  it('returns yarn run build when yarn.lock exists (AC1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('yarn.lock'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('yarn')
    expect(result.lockfile).toBe('yarn.lock')
    expect(result.command).toBe('yarn run build')
  })

  it('returns bun run build when bun.lockb exists (AC1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('bun.lockb'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('bun')
    expect(result.lockfile).toBe('bun.lockb')
    expect(result.command).toBe('bun run build')
  })

  it('returns npm run build when package-lock.json exists (AC1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('package-lock.json'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('npm')
    expect(result.lockfile).toBe('package-lock.json')
    expect(result.command).toBe('npm run build')
  })

  it('falls back to skip (none) when no lockfile or marker is found', () => {
    mockExistsSync.mockReturnValue(false)

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('none')
    expect(result.lockfile).toBeNull()
    expect(result.command).toBe('')
  })

  it('returns none with empty command when pyproject.toml exists (Python project)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('pyproject.toml'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('none')
    expect(result.lockfile).toBe('pyproject.toml')
    expect(result.command).toBe('')
  })

  it('Python marker wins over package-lock.json (mixed project with bmad tooling)', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('pyproject.toml') || path.endsWith('package-lock.json')
    })

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('none')
    expect(result.lockfile).toBe('pyproject.toml')
    expect(result.command).toBe('')
  })

  it('returns none with empty command when Cargo.toml exists (Rust project)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('Cargo.toml'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('none')
    expect(result.lockfile).toBe('Cargo.toml')
    expect(result.command).toBe('')
  })

  it('returns none with empty command when go.mod exists (Go project)', () => {
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('go.mod'))

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('none')
    expect(result.lockfile).toBe('go.mod')
    expect(result.command).toBe('')
  })

  it('pnpm wins priority when both pnpm-lock.yaml and package-lock.json exist (AC1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('pnpm-lock.yaml') || path.endsWith('package-lock.json')
    })

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('pnpm')
    expect(result.command).toBe('pnpm run build')
  })

  it('yarn wins over bun and npm in priority order (AC1)', () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p)
      return path.endsWith('yarn.lock') || path.endsWith('bun.lockb') || path.endsWith('package-lock.json')
    })

    const result = detectPackageManager(projectRoot)

    expect(result.packageManager).toBe('yarn')
    expect(result.command).toBe('yarn run build')
  })

  it('checks lockfiles in the project root directory', () => {
    const calls: string[] = []
    mockExistsSync.mockImplementation((p: unknown) => {
      calls.push(String(p))
      return false
    })

    detectPackageManager('/my/project')

    expect(calls.some((p) => p.startsWith('/my/project'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Profile override (Story 37-3)
  // -------------------------------------------------------------------------

  describe('profile override (Story 37-3)', () => {
    it('AC1: returns buildCommand from profile when project-profile.yaml exists with buildCommand', () => {
      mockExistsSync.mockImplementation((p: unknown) =>
        String(p).endsWith('project-profile.yaml'),
      )
      mockReadFileSync.mockReturnValue('project:\n  buildCommand: "turbo build"\n')

      const result = detectPackageManager(projectRoot)

      expect(result.command).toBe('turbo build')
      expect(result.lockfile).toBe('project-profile.yaml')
      expect(result.packageManager).toBe('none')
    })

    it('AC5: falls through gracefully when no profile exists (no lockfiles → skip)', () => {
      mockExistsSync.mockReturnValue(false)

      const result = detectPackageManager(projectRoot)

      expect(result.command).toBe('')
      expect(result.packageManager).toBe('none')
    })

    it('AC7: malformed YAML in profile falls through to lockfile detection', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = String(p)
        // profile exists, pnpm-lock.yaml also exists
        return path.endsWith('project-profile.yaml') || path.endsWith('pnpm-lock.yaml')
      })
      mockReadFileSync.mockReturnValue(':::invalid yaml:::')

      const result = detectPackageManager(projectRoot)

      // Should fall through past malformed profile to pnpm lockfile detection
      expect(result.command).toBe('pnpm run build')
      expect(result.packageManager).toBe('pnpm')
    })

    it('AC7: profile missing buildCommand field falls through to lockfile detection', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = String(p)
        return path.endsWith('project-profile.yaml') || path.endsWith('pnpm-lock.yaml')
      })
      mockReadFileSync.mockReturnValue('project:\n  type: single\n')

      const result = detectPackageManager(projectRoot)

      // buildCommand field missing → fall through to pnpm lockfile
      expect(result.command).toBe('pnpm run build')
      expect(result.packageManager).toBe('pnpm')
    })

    it('AC6: profile buildCommand runs through runBuildVerification and calls execSync', () => {
      mockExistsSync.mockImplementation((p: unknown) =>
        String(p).endsWith('project-profile.yaml'),
      )
      mockReadFileSync.mockReturnValue('project:\n  buildCommand: "go build ./..."\n')
      mockExecSync.mockReturnValue('')

      const result = runBuildVerification({ projectRoot })

      expect(mockExecSync).toHaveBeenCalledWith(
        'go build ./...',
        expect.objectContaining({ cwd: projectRoot }),
      )
      expect(result.status).toBe('passed')
    })
  })

  // -------------------------------------------------------------------------
  // Turborepo detection (Story 37-3)
  // -------------------------------------------------------------------------

  describe('turborepo detection (Story 37-3)', () => {
    it('AC2: returns npx turbo build when turbo.json exists and no profile', () => {
      mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('turbo.json'))

      const result = detectPackageManager(projectRoot)

      expect(result.command).toBe('npx turbo build')
      expect(result.packageManager).toBe('none')
      expect(result.lockfile).toBe('turbo.json')
    })

    it('AC3: returns pnpm run build when no profile and no turbo.json but pnpm-lock.yaml exists', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = String(p)
        return !path.endsWith('project-profile.yaml') &&
          !path.endsWith('turbo.json') &&
          path.endsWith('pnpm-lock.yaml')
      })

      const result = detectPackageManager(projectRoot)

      expect(result.command).toBe('pnpm run build')
      expect(result.packageManager).toBe('pnpm')
    })

    it('AC4: skips build when no profile and no turbo.json but go.mod exists', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = String(p)
        return !path.endsWith('project-profile.yaml') &&
          !path.endsWith('turbo.json') &&
          path.endsWith('go.mod')
      })
      mockExecSync.mockReturnValue('')

      const result = runBuildVerification({ projectRoot })

      expect(result.status).toBe('skipped')
      expect(mockExecSync).not.toHaveBeenCalled()
    })

    it('profile wins over turbo.json when both exist', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const path = String(p)
        return path.endsWith('project-profile.yaml') || path.endsWith('turbo.json')
      })
      mockReadFileSync.mockReturnValue('project:\n  buildCommand: "custom build"\n')

      const result = detectPackageManager(projectRoot)

      expect(result.command).toBe('custom build')
      expect(result.lockfile).toBe('project-profile.yaml')
    })
  })
})
