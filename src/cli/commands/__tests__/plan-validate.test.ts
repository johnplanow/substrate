/**
 * Unit tests for the `plan validate <file>` subcommand action.
 *
 * Tests runPlanValidateAction() covering:
 *   - Valid plan → stdout "Plan is valid", exit 0 (AC5)
 *   - Schema error → stderr with field path and suggestion, exit 2 (AC5, AC6)
 *   - Cycle → stderr with cycle path, exit 2 (AC2, AC5)
 *   - Dangling reference → stderr with task ID, exit 2 (AC3, AC5)
 *   - File not found → stderr "Plan file not found", exit 2 (AC5)
 *   - Invalid YAML → stderr parse error, exit 2 (AC5)
 *   - --output-format json valid plan → valid JSON stdout (AC5)
 *   - --output-format json invalid plan → JSON with errors array (AC5)
 *   - Unknown agent → exit 0 (warnings don't block) (AC4, AC5)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Mock AdapterRegistry so healthChecks don't actually call CLI tools
// ---------------------------------------------------------------------------

vi.mock('../../../adapters/adapter-registry.js', () => {
  return {
    AdapterRegistry: vi.fn().mockImplementation(() => ({
      discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 0, failedCount: 0, results: [] }),
      getAll: vi.fn().mockReturnValue([]),
      getPlanningCapable: vi.fn().mockReturnValue([]),
      get: vi.fn(),
      register: vi.fn(),
    })),
  }
})

// ---------------------------------------------------------------------------
// SUT imports (after mock setup)
// ---------------------------------------------------------------------------

import {
  runPlanValidateAction,
  PLAN_EXIT_SUCCESS,
  PLAN_EXIT_USAGE_ERROR,
} from '../plan.js'

// ---------------------------------------------------------------------------
// stdout / stderr capture helpers
// ---------------------------------------------------------------------------

type WrittenChunk = string

function captureStdout(): { chunks: WrittenChunk[]; restore: () => void } {
  const chunks: WrittenChunk[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

function captureStderr(): { chunks: WrittenChunk[]; restore: () => void } {
  const chunks: WrittenChunk[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { chunks, restore: () => spy.mockRestore() }
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let testDir: string

function setupTestDir(): void {
  testDir = join(tmpdir(), `plan-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
}

function teardownTestDir(): void {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function writeYaml(name: string, content: string): string {
  const p = join(testDir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

// ---------------------------------------------------------------------------
// Plan fixture content strings
// ---------------------------------------------------------------------------

const VALID_PLAN_YAML = `version: "1"
session:
  name: valid-test-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
  task-b:
    name: Task B
    prompt: Do task B
    type: testing
    depends_on:
      - task-a
`

const CYCLIC_PLAN_YAML = `version: "1"
session:
  name: cyclic-test-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
    depends_on:
      - task-b
  task-b:
    name: Task B
    prompt: Do task B
    type: coding
    depends_on:
      - task-a
`

const DANGLING_PLAN_YAML = `version: "1"
session:
  name: dangling-test-session
tasks:
  task-b:
    name: Task B
    prompt: Do task B
    type: coding
    depends_on:
      - nonexistent-task
`

const SCHEMA_ERROR_PLAN_YAML = `version: "1"
session:
  name: schema-error-test-session
tasks:
  build-api:
    name: Build API
    prompt: Build the API
    type: scripting
`

const UNKNOWN_AGENT_PLAN_YAML = `version: "1"
session:
  name: unknown-agent-test-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
    agent: some-unknown-agent
`

const INVALID_YAML = `version: "1"
session:
  name: test
tasks:
  bad-indent:
    name: Bad
      prompt: this is wrong yaml indentation
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanValidateAction — valid plan', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('returns exit 0 and prints "Plan is valid" for a valid plan', async () => {
    const filePath = writeYaml('valid-plan.yaml', VALID_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    expect(out).toContain('Plan is valid')
    expect(out).toContain('2 tasks')
  })
})

describe('runPlanValidateAction — schema error', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('returns exit 2 and prints structured error with field path for schema error', async () => {
    const filePath = writeYaml('schema-error-plan.yaml', SCHEMA_ERROR_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_USAGE_ERROR)
    const err = stderr.chunks.join('')
    expect(err).toContain('Error [schema]')
    // Should include field path
    expect(err).toContain('type')
    // Should include fix suggestion
    expect(err).toContain('Fix:')
  })
})

describe('runPlanValidateAction — cyclic dependency', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('returns exit 2 and includes cycle path in stderr', async () => {
    const filePath = writeYaml('cyclic-plan.yaml', CYCLIC_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_USAGE_ERROR)
    const err = stderr.chunks.join('')
    expect(err).toContain('[cycle]')
    expect(err).toContain('->')
  })
})

describe('runPlanValidateAction — dangling reference', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('returns exit 2 and includes task ID and missing dep in stderr', async () => {
    const filePath = writeYaml('dangling-plan.yaml', DANGLING_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_USAGE_ERROR)
    const err = stderr.chunks.join('')
    expect(err).toContain('[dangling_ref]')
    expect(err).toContain('nonexistent-task')
  })
})

describe('runPlanValidateAction — file not found', () => {
  it('returns exit 2 and prints "Plan file not found"', async () => {
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({
      filePath: '/nonexistent/path/to/plan.yaml',
      outputFormat: 'human',
    })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_USAGE_ERROR)
    const err = stderr.chunks.join('')
    expect(err).toContain('Plan file not found')
    expect(err).toContain('/nonexistent/path/to/plan.yaml')
  })
})

describe('runPlanValidateAction — invalid YAML syntax', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('returns exit 2 and prints parse error details', async () => {
    const filePath = writeYaml('invalid-syntax.yaml', INVALID_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_USAGE_ERROR)
    const err = stderr.chunks.join('')
    expect(err.toLowerCase()).toContain('error')
  })
})

describe('runPlanValidateAction — json format, valid plan', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('outputs valid JSON with valid=true and errors=[] for valid plan', async () => {
    const filePath = writeYaml('valid-plan.yaml', VALID_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'json' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    const parsed = JSON.parse(out) as { valid: boolean; errors: unknown[] }
    expect(parsed.valid).toBe(true)
    expect(parsed.errors).toHaveLength(0)
  })
})

describe('runPlanValidateAction — json format, invalid plan', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('outputs valid JSON with valid=false and errors array populated', async () => {
    const filePath = writeYaml('schema-error-plan.yaml', SCHEMA_ERROR_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'json' })

    stdout.restore()
    stderr.restore()

    expect(exitCode).toBe(PLAN_EXIT_USAGE_ERROR)
    const out = stdout.chunks.join('')
    const parsed = JSON.parse(out) as { valid: boolean; errors: unknown[] }
    expect(parsed.valid).toBe(false)
    expect(parsed.errors.length).toBeGreaterThan(0)
  })
})

describe('runPlanValidateAction — unknown agent (warning only)', () => {
  beforeEach(setupTestDir)
  afterEach(teardownTestDir)

  it('returns exit 0 for unknown agent (warnings do not block)', async () => {
    const filePath = writeYaml('unknown-agent-plan.yaml', UNKNOWN_AGENT_PLAN_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const exitCode = await runPlanValidateAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    // Unknown agent is a warning, not an error — exit 0
    expect(exitCode).toBe(PLAN_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    expect(out).toContain('Plan is valid')
  })
})
