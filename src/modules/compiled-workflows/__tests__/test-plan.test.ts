/**
 * Unit tests for runTestPlan() — compiled test-plan workflow function.
 *
 * Covers AC1 (dispatch + typed result), AC2 (decision store persistence),
 * AC6 (graceful failure handling), AC7 (TestPlanResultSchema validation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { WorkflowDeps, TestPlanParams } from '../types.js'
import { TestPlanResultSchema } from '../schemas.js'
import { runTestPlan } from '../test-plan.js'

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Mock persistence queries
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/queries/decisions.js', () => ({
  createDecision: vi.fn(),
  getDecisionsByCategory: vi.fn(),
  getDecisionsByPhase: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Mock node:fs/promises for story file reading
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock resolveDefaultTestPatterns (Story 37-6) — prevents real file I/O
// ---------------------------------------------------------------------------

vi.mock('../default-test-patterns.js', () => ({
  resolveDefaultTestPatterns: vi.fn().mockReturnValue('VITEST_DEFAULT_MOCK'),
  VITEST_DEFAULT_PATTERNS: 'VITEST_DEFAULT_MOCK',
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { createDecision, getDecisionsByPhase } from '../../../persistence/queries/decisions.js'
import { TEST_PLAN } from '../../../persistence/schemas/operational.js'
import { resolveDefaultTestPatterns } from '../default-test-patterns.js'

const mockReadFile = vi.mocked(readFile)
const mockCreateDecision = vi.mocked(createDecision)
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)
const mockResolveDefaultTestPatterns = vi.mocked(resolveDefaultTestPatterns)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_CONTENT = `# Story 22-7: Pre-Implementation Test Planning

Status: ready-for-dev

## Story
As a pipeline engineer, I want test planning.

## Acceptance Criteria
### AC1: runTestPlan dispatches sub-agent
### AC2: Test plan stored in decision store

## Tasks
- [ ] Task 1: Add TEST_PLAN constant
`

const DEFAULT_STORY_KEY = '22-7'
const DEFAULT_STORY_FILE_PATH = '/path/to/stories/22-7-test-planning.md'

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeSuccessDispatchResult(): DispatchResult {
  return {
    id: 'dispatch-1',
    status: 'completed',
    exitCode: 0,
    output:
      'result: success\ntest_files:\n  - src/foo/__tests__/foo.test.ts\ntest_categories:\n  - unit\ncoverage_notes: "AC1 covered"\n',
    parsed: {
      result: 'success',
      test_files: ['src/foo/__tests__/foo.test.ts'],
      test_categories: ['unit'],
      coverage_notes: 'AC1 covered',
    },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 500, output: 100 },
  }
}

function makeDispatcher(result: DispatchResult | Promise<DispatchResult>): Dispatcher {
  const resultPromise = result instanceof Promise ? result : Promise.resolve(result)
  const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
    id: 'dispatch-1',
    status: 'queued',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: resultPromise,
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(
  template: string = 'Test Plan\n\n{{story_content}}\n\nEmit YAML.'
): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      phases: [],
      prompts: { 'test-plan': 'prompts/test-plan.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(template),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockReturnValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn().mockReturnValue(undefined),
  }
}

function makeDb(): DatabaseAdapter {
  return {} as DatabaseAdapter
}

function makeDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    db: makeDb(),
    pack: makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher: makeDispatcher(makeSuccessDispatchResult()),
    ...overrides,
  }
}

const defaultParams: TestPlanParams = {
  storyKey: DEFAULT_STORY_KEY,
  storyFilePath: DEFAULT_STORY_FILE_PATH,
  pipelineRunId: 'run-123',
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Default: story file exists with content
  mockReadFile.mockResolvedValue(STORY_CONTENT as unknown as string)
  // Default: createDecision succeeds
  mockCreateDecision.mockReturnValue({
    id: 'decision-1',
    pipeline_run_id: 'run-123',
    phase: 'implementation',
    category: TEST_PLAN,
    key: DEFAULT_STORY_KEY,
    value: '{}',
    rationale: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
})

// ---------------------------------------------------------------------------
// AC1: runTestPlan dispatches sub-agent and returns typed result
// ---------------------------------------------------------------------------

describe('AC1: runTestPlan dispatches sub-agent and returns typed result', () => {
  it('calls pack.getPrompt("test-plan") to retrieve template', async () => {
    const pack = makePack()
    const deps = makeDeps({ pack })

    await runTestPlan(deps, defaultParams)

    expect(pack.getPrompt).toHaveBeenCalledWith('test-plan')
  })

  it('reads the story file from storyFilePath', async () => {
    await runTestPlan(makeDeps(), defaultParams)

    expect(mockReadFile).toHaveBeenCalledWith(DEFAULT_STORY_FILE_PATH, 'utf-8')
  })

  it('dispatches with taskType="test-plan" and agent="claude-code"', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })

    await runTestPlan(deps, defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude-code',
        taskType: 'test-plan',
        outputSchema: TestPlanResultSchema,
      })
    )
  })

  it('dispatches with TestPlanResultSchema as outputSchema', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })

    await runTestPlan(deps, defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outputSchema: TestPlanResultSchema })
    )
  })

  it('returns success result with test_files, test_categories, coverage_notes', async () => {
    const result = await runTestPlan(makeDeps(), defaultParams)

    expect(result.result).toBe('success')
    expect(result.test_files).toEqual(['src/foo/__tests__/foo.test.ts'])
    expect(result.test_categories).toEqual(['unit'])
    expect(result.coverage_notes).toBe('AC1 covered')
  })

  it('returns tokenUsage from dispatch result', async () => {
    const dispatchResult: DispatchResult = {
      ...makeSuccessDispatchResult(),
      tokenEstimate: { input: 1234, output: 567 },
    }
    const deps = makeDeps({ dispatcher: makeDispatcher(dispatchResult) })

    const result = await runTestPlan(deps, defaultParams)

    expect(result.tokenUsage).toEqual({ input: 1234, output: 567 })
  })
})

// ---------------------------------------------------------------------------
// AC2: Test plan is stored in the decision store
// ---------------------------------------------------------------------------

describe('AC2: Test plan stored in decision store', () => {
  it('calls createDecision with category=TEST_PLAN and key=storyKey on success', async () => {
    await runTestPlan(makeDeps(), defaultParams)

    expect(mockCreateDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        phase: 'implementation',
        category: TEST_PLAN,
        key: DEFAULT_STORY_KEY,
      })
    )
  })

  it('stores test_files, test_categories, coverage_notes in decision value', async () => {
    await runTestPlan(makeDeps(), defaultParams)

    const call = mockCreateDecision.mock.calls[0]
    const input = call[1]
    const parsed = JSON.parse(input.value as string) as {
      test_files: string[]
      test_categories: string[]
      coverage_notes: string
    }
    expect(parsed.test_files).toEqual(['src/foo/__tests__/foo.test.ts'])
    expect(parsed.test_categories).toEqual(['unit'])
    expect(parsed.coverage_notes).toBe('AC1 covered')
  })

  it('includes pipeline_run_id in createDecision call', async () => {
    await runTestPlan(makeDeps(), { ...defaultParams, pipelineRunId: 'run-abc' })

    expect(mockCreateDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pipeline_run_id: 'run-abc' })
    )
  })

  it('does NOT call createDecision when dispatch status is "failed"', async () => {
    const failedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'failed',
      exitCode: 1,
      output: 'error',
      parsed: null,
      parseError: 'Exit code: 1',
      durationMs: 500,
      tokenEstimate: { input: 200, output: 0 },
    }
    const deps = makeDeps({ dispatcher: makeDispatcher(failedResult) })

    const result = await runTestPlan(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(mockCreateDecision).not.toHaveBeenCalled()
  })

  it('does NOT call createDecision when dispatch status is "timeout"', async () => {
    const timeoutResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'timeout',
      exitCode: -1,
      output: '',
      parsed: null,
      parseError: 'timed out',
      durationMs: 300_000,
      tokenEstimate: { input: 200, output: 0 },
    }
    const deps = makeDeps({ dispatcher: makeDispatcher(timeoutResult) })

    const result = await runTestPlan(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(mockCreateDecision).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC6: Failure scenarios (non-blocking)
// ---------------------------------------------------------------------------

describe('AC6: Failure scenarios', () => {
  it('returns failure when pack.getPrompt throws', async () => {
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Template not found'))
    const deps = makeDeps({ pack })

    const result = await runTestPlan(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('template_load_failed')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('returns failure with story_file_not_found when ENOENT', async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    )

    const result = await runTestPlan(makeDeps(), defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('story_file_not_found')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('returns failure when readFile throws generic error', async () => {
    mockReadFile.mockRejectedValue(new Error('Permission denied'))

    const result = await runTestPlan(makeDeps(), defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('story_file_read_error')
  })

  it('returns failure when dispatch status is "failed"', async () => {
    const failedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'failed',
      exitCode: 1,
      output: 'error output',
      parsed: null,
      parseError: null,
      durationMs: 500,
      tokenEstimate: { input: 200, output: 0 },
    }
    const result = await runTestPlan(
      makeDeps({ dispatcher: makeDispatcher(failedResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toContain('dispatch_failed')
  })

  it('returns failure when dispatch status is "timeout"', async () => {
    const timeoutResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'timeout',
      exitCode: -1,
      output: '',
      parsed: null,
      parseError: 'timed out',
      durationMs: 300_000,
      tokenEstimate: { input: 200, output: 0 },
    }
    const result = await runTestPlan(
      makeDeps({ dispatcher: makeDispatcher(timeoutResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toContain('dispatch_timeout')
  })

  it('returns failure when schema validation fails (parsed is null)', async () => {
    const nullParsedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'completed',
      exitCode: 0,
      output: 'some output without valid YAML',
      parsed: null,
      parseError: 'no_yaml_block',
      durationMs: 500,
      tokenEstimate: { input: 200, output: 50 },
    }
    const result = await runTestPlan(
      makeDeps({ dispatcher: makeDispatcher(nullParsedResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toContain('schema_validation_failed')
  })

  it('returns success even when createDecision throws (best-effort storage)', async () => {
    mockCreateDecision.mockImplementation(() => {
      throw new Error('Database error')
    })

    const result = await runTestPlan(makeDeps(), defaultParams)

    // createDecision failure should not bubble up — result is still success
    expect(result.result).toBe('success')
    expect(result.test_files).toEqual(['src/foo/__tests__/foo.test.ts'])
  })

  it('returns failure with { test_files: [], test_categories: [], coverage_notes: "" } shape', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await runTestPlan(makeDeps(), defaultParams)

    expect(result.result).toBe('failed')
    expect(result.test_files).toEqual([])
    expect(result.test_categories).toEqual([])
    expect(result.coverage_notes).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC7: TestPlanResultSchema validates output shape
// ---------------------------------------------------------------------------

describe('AC7: TestPlanResultSchema validates output shape', () => {
  it('accepts valid success output', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: ['src/foo/__tests__/foo.test.ts'],
      test_categories: ['unit', 'integration'],
      coverage_notes: 'AC1 covered by foo.test.ts',
    })

    expect(parsed.result).toBe('success')
    expect(parsed.test_files).toEqual(['src/foo/__tests__/foo.test.ts'])
    expect(parsed.test_categories).toEqual(['unit', 'integration'])
    expect(parsed.coverage_notes).toBe('AC1 covered by foo.test.ts')
  })

  it('normalises "failure" → "failed"', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'failure',
      test_files: [],
      test_categories: [],
      coverage_notes: '',
    })

    expect(parsed.result).toBe('failed')
  })

  it('defaults test_files to [] when missing', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_categories: ['unit'],
      coverage_notes: 'notes',
    })

    expect(parsed.test_files).toEqual([])
  })

  it('defaults test_categories to [] when missing', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: ['src/foo.test.ts'],
      coverage_notes: 'notes',
    })

    expect(parsed.test_categories).toEqual([])
  })

  it('defaults coverage_notes to "" when missing', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: [],
      test_categories: [],
    })

    expect(parsed.coverage_notes).toBe('')
  })

  it('rejects invalid result values', () => {
    expect(() =>
      TestPlanResultSchema.parse({
        result: 'unknown_value',
        test_files: [],
        test_categories: [],
        coverage_notes: '',
      })
    ).toThrow()
  })

  it('accepts "failed" as result', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'failed',
      test_files: [],
      test_categories: [],
      coverage_notes: '',
    })

    expect(parsed.result).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Workdir injection
// ---------------------------------------------------------------------------

describe('projectRoot injection', () => {
  it('passes workingDirectory to dispatch when projectRoot is set', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher, projectRoot: '/my/project' })

    await runTestPlan(deps, defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/my/project' })
    )
  })

  it('does not include workingDirectory when projectRoot is not set', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })
    // Ensure projectRoot is undefined
    delete (deps as { projectRoot?: string }).projectRoot

    await runTestPlan(deps, defaultParams)

    const call = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
    expect(call).not.toHaveProperty('workingDirectory')
  })
})

// ---------------------------------------------------------------------------
// Story 37-6: Test pattern injection
// ---------------------------------------------------------------------------

describe('Story 37-6: test pattern injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue(STORY_CONTENT as unknown as string)
    mockCreateDecision.mockReturnValue({
      id: 'decision-1',
      pipeline_run_id: 'run-123',
      phase: 'implementation',
      category: TEST_PLAN,
      key: DEFAULT_STORY_KEY,
      value: '{}',
      rationale: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    mockGetDecisionsByPhase.mockResolvedValue([])
    mockResolveDefaultTestPatterns.mockReturnValue('VITEST_DEFAULT_MOCK')
  })

  it('AC4: test_patterns section injected into prompt from decision store decisions', async () => {
    // Second call to getDecisionsByPhase returns test-pattern decisions
    mockGetDecisionsByPhase
      .mockResolvedValueOnce([]) // getArchConstraints call
      .mockResolvedValueOnce([
        {
          id: 'tp-1',
          phase: 'solutioning',
          category: 'test-patterns',
          key: 'framework',
          value: 'Go test (stdlib)',
          pipeline_run_id: null,
          rationale: null,
          created_at: '',
          updated_at: '',
        },
      ])

    // Use a template that includes the {{test_patterns}} placeholder
    const pack = makePack('Test Plan\n\n{{story_content}}\n\n{{test_patterns}}\n\nEmit YAML.')
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher, pack })
    let capturedPrompt = ''
    vi.mocked(dispatcher.dispatch).mockImplementation((req) => {
      capturedPrompt = req.prompt
      return {
        id: 'dispatch-1',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeSuccessDispatchResult()),
      }
    })

    await runTestPlan(deps, defaultParams)

    expect(capturedPrompt).toContain('Go test (stdlib)')
    // Resolver should NOT be called since decisions were found
    expect(mockResolveDefaultTestPatterns).not.toHaveBeenCalled()
  })

  it('AC5: stack-aware defaults used when no test-pattern decisions exist', async () => {
    // Both calls return empty (no arch constraints, no test-patterns)
    mockGetDecisionsByPhase.mockResolvedValue([])
    mockResolveDefaultTestPatterns.mockReturnValue('STACK_AWARE_FALLBACK')

    // Use a template that includes the {{test_patterns}} placeholder
    const pack = makePack('Test Plan\n\n{{story_content}}\n\n{{test_patterns}}\n\nEmit YAML.')
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher, pack, projectRoot: '/some/project' })
    let capturedPrompt = ''
    vi.mocked(dispatcher.dispatch).mockImplementation((req) => {
      capturedPrompt = req.prompt
      return {
        id: 'dispatch-1',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeSuccessDispatchResult()),
      }
    })

    await runTestPlan(deps, defaultParams)

    expect(capturedPrompt).toContain('STACK_AWARE_FALLBACK')
    expect(mockResolveDefaultTestPatterns).toHaveBeenCalledWith('/some/project')
  })
})
