/**
 * Unit tests for BuildValidationLevel (Story 33-3, AC1–AC6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SpawnSyncReturns } from 'node:child_process'

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module under test
// Use vi.hoisted so mockSpawnSync is available inside the vi.mock factory.
// ---------------------------------------------------------------------------

const { mockSpawnSync } = vi.hoisted(() => {
  return {
    mockSpawnSync: vi.fn<
      Parameters<typeof import('node:child_process').spawnSync>,
      SpawnSyncReturns<string>
    >(),
  }
})

vi.mock('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}))

// Import after mock is set up
import { BuildValidationLevel, parseTscDiagnostics, determineBuildScope } from '../build.js'
import type { ValidationContext } from '../../types.js'
import type { StoryRecord } from '../../../state/index.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const dummyStory: StoryRecord = {
  storyKey: '33-3',
  phase: 'DEV',
  reviewCycles: 0,
}

const baseContext: ValidationContext = {
  story: dummyStory,
  result: null,
  attempt: 1,
  projectRoot: '/project',
}

/** Returns a SpawnSyncReturns that simulates a successful (exit 0) run */
function makeSuccess(): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, '', ''],
    stdout: '',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
  }
}

/** Returns a SpawnSyncReturns that simulates a failed (exit 1) run with given output */
function makeFailure(stdout = '', stderr = '', status = 1): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
    error: undefined,
  }
}

/** Returns a SpawnSyncReturns that simulates a timeout (SIGTERM) */
function makeTimeout(): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, '', ''],
    stdout: '',
    stderr: '',
    status: null,
    signal: 'SIGTERM',
    error: undefined,
  }
}

// Realistic single-file tsc diagnostic
const SINGLE_FILE_TSC_OUTPUT = `src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`

// Two-file tsc diagnostic (still surgical)
const TWO_FILE_TSC_OUTPUT = [
  `src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
  `src/bar.ts(3,1): error TS2339: Property 'x' does not exist on type '{}'.`,
].join('\n')

// Three-file tsc diagnostic (partial scope)
const THREE_FILE_TSC_OUTPUT = [
  `src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`,
  `src/bar.ts(3,1): error TS2339: Property 'x' does not exist on type '{}'.`,
  `src/baz.ts(7,2): error TS2322: Type 'number' is not assignable to type 'string'.`,
].join('\n')

// ---------------------------------------------------------------------------
// parseTscDiagnostics
// ---------------------------------------------------------------------------

describe('parseTscDiagnostics', () => {
  it('parses a single diagnostic', () => {
    const results = parseTscDiagnostics(SINGLE_FILE_TSC_OUTPUT, '/project')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      file: 'src/foo.ts',
      line: 12,
      message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    })
  })

  it('parses multiple diagnostics', () => {
    const results = parseTscDiagnostics(TWO_FILE_TSC_OUTPUT, '/project')
    expect(results).toHaveLength(2)
    expect(results[0].file).toBe('src/foo.ts')
    expect(results[1].file).toBe('src/bar.ts')
  })

  it('returns empty array when no diagnostics are present', () => {
    const results = parseTscDiagnostics('Build succeeded', '/project')
    expect(results).toHaveLength(0)
  })

  it('normalizes absolute file paths to relative', () => {
    const absoluteOutput = `/project/src/foo.ts(5,3): error TS2345: some message`
    const results = parseTscDiagnostics(absoluteOutput, '/project')
    expect(results[0].file).toBe('src/foo.ts')
  })
})

// ---------------------------------------------------------------------------
// determineBuildScope
// ---------------------------------------------------------------------------

describe('determineBuildScope', () => {
  it('returns surgical for 0 diagnostics', () => {
    expect(determineBuildScope([])).toBe('surgical')
  })

  it('returns surgical for 1 distinct file', () => {
    const diags = [
      { file: 'src/foo.ts', line: 1, message: 'err' },
      { file: 'src/foo.ts', line: 2, message: 'err2' },
    ]
    expect(determineBuildScope(diags)).toBe('surgical')
  })

  it('returns surgical for exactly 2 distinct files', () => {
    const diags = [
      { file: 'src/foo.ts', line: 1, message: 'err' },
      { file: 'src/bar.ts', line: 1, message: 'err' },
    ]
    expect(determineBuildScope(diags)).toBe('surgical')
  })

  it('returns partial for 3 or more distinct files', () => {
    const diags = [
      { file: 'src/foo.ts', line: 1, message: 'err' },
      { file: 'src/bar.ts', line: 1, message: 'err' },
      { file: 'src/baz.ts', line: 1, message: 'err' },
    ]
    expect(determineBuildScope(diags)).toBe('partial')
  })
})

// ---------------------------------------------------------------------------
// BuildValidationLevel
// ---------------------------------------------------------------------------

describe('BuildValidationLevel', () => {
  let level: BuildValidationLevel

  beforeEach(() => {
    level = new BuildValidationLevel({ projectRoot: '/project' })
    mockSpawnSync.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC1 + AC6(a): Clean build passes
  // -------------------------------------------------------------------------
  it('returns passed=true when tsc and npm run build both succeed', async () => {
    mockSpawnSync
      .mockReturnValueOnce(makeSuccess()) // tsc
      .mockReturnValueOnce(makeSuccess()) // npm run build

    const result = await level.run(baseContext)

    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.canAutoRemediate).toBe(false)
    expect(result.remediationContext).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC2 + AC3 + AC4 + AC6(b): Single-file type error → surgical scope
  // -------------------------------------------------------------------------
  it('returns structured diagnostics and surgical scope for single-file error', async () => {
    mockSpawnSync.mockReturnValueOnce(makeFailure(SINGLE_FILE_TSC_OUTPUT))
    // npm run build should NOT be called after tsc fails

    const result = await level.run(baseContext)

    expect(result.passed).toBe(false)
    expect(result.canAutoRemediate).toBe(true)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toMatchObject({
      category: 'build',
      location: 'src/foo.ts:12',
      suggestedAction: 'Fix type errors',
    })
    expect(result.failures[0].evidence).toBe(SINGLE_FILE_TSC_OUTPUT + '\n')
    expect(result.remediationContext).toBeDefined()
    expect(result.remediationContext?.scope).toBe('surgical')
    expect(result.remediationContext?.canAutoRemediate).toBe(true)

    // npm run build must NOT have been called
    expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    expect(mockSpawnSync.mock.calls[0]?.[0]).toBe('npx')
  })

  // -------------------------------------------------------------------------
  // AC4 + AC6(c): Errors in 3+ files → partial scope
  // -------------------------------------------------------------------------
  it('returns partial scope when diagnostics span 3+ distinct files', async () => {
    mockSpawnSync.mockReturnValueOnce(makeFailure(THREE_FILE_TSC_OUTPUT))

    const result = await level.run(baseContext)

    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(3)
    expect(result.remediationContext?.scope).toBe('partial')
  })

  // -------------------------------------------------------------------------
  // AC5 + AC6(d): Timeout → failure with timeout evidence, canAutoRemediate=false
  // -------------------------------------------------------------------------
  it('returns timeout evidence and canAutoRemediate=false when tsc times out', async () => {
    const timeoutMs = 15_000
    level = new BuildValidationLevel({ projectRoot: '/project', timeoutMs })
    mockSpawnSync.mockReturnValueOnce(makeTimeout())

    const result = await level.run(baseContext)

    expect(result.passed).toBe(false)
    expect(result.canAutoRemediate).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].category).toBe('build')
    expect(result.failures[0].evidence).toBe(`Build step timed out after ${timeoutMs}ms`)
    expect(result.remediationContext?.canAutoRemediate).toBe(false)

    // npm run build must NOT be called after timeout
    expect(mockSpawnSync).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // AC5 + AC6(d): npm run build timeout also returns correct evidence
  // -------------------------------------------------------------------------
  it('returns timeout evidence when npm run build times out', async () => {
    const timeoutMs = 20_000
    level = new BuildValidationLevel({ projectRoot: '/project', timeoutMs })
    mockSpawnSync
      .mockReturnValueOnce(makeSuccess()) // tsc passes
      .mockReturnValueOnce(makeTimeout()) // npm run build times out

    const result = await level.run(baseContext)

    expect(result.passed).toBe(false)
    expect(result.canAutoRemediate).toBe(false)
    expect(result.failures[0].evidence).toBe(`Build step timed out after ${timeoutMs}ms`)
  })

  // -------------------------------------------------------------------------
  // AC1 + AC6(e): npm run build failure (non-zero exit) after tsc passes
  // -------------------------------------------------------------------------
  it('captures npm run build failure output when tsc passes but npm build fails', async () => {
    const buildOutput = 'Error: Cannot find module ./missing-module'
    mockSpawnSync
      .mockReturnValueOnce(makeSuccess()) // tsc passes
      .mockReturnValueOnce(makeFailure(buildOutput, '', 1)) // npm run build fails

    const result = await level.run(baseContext)

    expect(result.passed).toBe(false)
    expect(result.canAutoRemediate).toBe(true)
    expect(result.failures[0].category).toBe('build')
    expect(result.failures[0].evidence).toContain(buildOutput)
  })

  // -------------------------------------------------------------------------
  // Short-circuit: npm run build is NOT called when tsc fails
  // -------------------------------------------------------------------------
  it('does not call npm run build when tsc fails', async () => {
    mockSpawnSync.mockReturnValueOnce(makeFailure(SINGLE_FILE_TSC_OUTPUT))

    await level.run(baseContext)

    expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    // The one call must be to npx (tsc)
    expect(mockSpawnSync.mock.calls[0]?.[0]).toBe('npx')
  })

  // -------------------------------------------------------------------------
  // AC1: spawnSync cwd is set to projectRoot
  // -------------------------------------------------------------------------
  it('passes projectRoot as cwd to spawnSync', async () => {
    mockSpawnSync.mockReturnValueOnce(makeSuccess()).mockReturnValueOnce(makeSuccess())

    await level.run(baseContext)

    for (const call of mockSpawnSync.mock.calls) {
      const opts = call[2] as { cwd?: string } | undefined
      expect(opts?.cwd).toBe('/project')
    }
  })

  // -------------------------------------------------------------------------
  // AC1: uses context.projectRoot when config.projectRoot is not provided
  // -------------------------------------------------------------------------
  it('falls back to context.projectRoot when config does not specify one', async () => {
    const levelNoRoot = new BuildValidationLevel({})
    mockSpawnSync.mockReturnValueOnce(makeSuccess()).mockReturnValueOnce(makeSuccess())

    await levelNoRoot.run({ ...baseContext, projectRoot: '/ctx-root' })

    for (const call of mockSpawnSync.mock.calls) {
      const opts = call[2] as { cwd?: string } | undefined
      expect(opts?.cwd).toBe('/ctx-root')
    }
  })

  // -------------------------------------------------------------------------
  // AC5: timeout value passed to spawnSync matches config
  // -------------------------------------------------------------------------
  it('passes configured timeoutMs to spawnSync', async () => {
    const customTimeout = 5_000
    level = new BuildValidationLevel({ projectRoot: '/project', timeoutMs: customTimeout })
    mockSpawnSync.mockReturnValueOnce(makeSuccess()).mockReturnValueOnce(makeSuccess())

    await level.run(baseContext)

    for (const call of mockSpawnSync.mock.calls) {
      const opts = call[2] as { timeout?: number } | undefined
      expect(opts?.timeout).toBe(customTimeout)
    }
  })

  // -------------------------------------------------------------------------
  // AC3: remediationContext.level is set to the build level number (1)
  // -------------------------------------------------------------------------
  it('sets remediationContext.level to 1', async () => {
    mockSpawnSync.mockReturnValueOnce(makeFailure(SINGLE_FILE_TSC_OUTPUT))

    const result = await level.run(baseContext)

    expect(result.remediationContext?.level).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Two-file error still counts as surgical
  // -------------------------------------------------------------------------
  it('returns surgical scope for errors in exactly 2 files', async () => {
    mockSpawnSync.mockReturnValueOnce(makeFailure(TWO_FILE_TSC_OUTPUT))

    const result = await level.run(baseContext)

    expect(result.remediationContext?.scope).toBe('surgical')
    expect(result.failures).toHaveLength(2)
  })
})
