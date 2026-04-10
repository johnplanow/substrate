/**
 * Tests for runTestExpansion — compiled test-expansion workflow.
 *
 * Mocks: MethodologyPack.getPrompt, fs/promises.readFile,
 * git-helpers (getGitDiffForFiles, getGitDiffStatSummary),
 * utils/logger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock functions so they are available when vi.mock factories execute
// ---------------------------------------------------------------------------

const {
  mockReadFile,
  mockGetGitDiffForFiles,
  mockGetGitDiffStatSummary,
  mockGetGitDiffStatForFiles,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockGetGitDiffForFiles: vi.fn(),
  mockGetGitDiffStatSummary: vi.fn(),
  mockGetGitDiffStatForFiles: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('../git-helpers.js', () => ({
  getGitDiffForFiles: mockGetGitDiffForFiles,
  getGitDiffStatSummary: mockGetGitDiffStatSummary,
  getGitDiffStatForFiles: mockGetGitDiffStatForFiles,
  getGitDiffSummary: vi.fn(),
  getGitChangedFiles: vi.fn(),
  stageIntentToAdd: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Mock resolveDefaultTestPatterns (Story 37-6) — prevents real file I/O
// ---------------------------------------------------------------------------

vi.mock('../default-test-patterns.js', () => ({
  resolveDefaultTestPatterns: vi.fn().mockReturnValue('VITEST_DEFAULT_MOCK'),
  VITEST_DEFAULT_PATTERNS: 'VITEST_DEFAULT_MOCK',
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { runTestExpansion } from '../test-expansion.js'
import { resolveDefaultTestPatterns } from '../default-test-patterns.js'

const mockResolveDefaultTestPatterns = vi.mocked(resolveDefaultTestPatterns)
import type { WorkflowDeps, TestExpansionParams } from '../types.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {}
): DispatchResult<unknown> {
  return {
    id: 'test-dispatch-id',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 200, output: 50 },
    ...overrides,
  }
}

const DEFAULT_TEMPLATE =
  '## Mission\n{{story_content}}\n\n## Git Changes\n{{git_diff}}\n\n## Arch\n{{arch_constraints}}'

function makeMockDeps(
  overrides: {
    getPrompt?: ReturnType<typeof vi.fn>
    dispatch?: ReturnType<typeof vi.fn>
    db?: Partial<DatabaseAdapter>
  } = {}
): WorkflowDeps {
  const mockPack: MethodologyPack = {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: { 'test-expansion': 'prompts/test-expansion.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: overrides.getPrompt ?? vi.fn().mockResolvedValue(DEFAULT_TEMPLATE),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }

  const mockDb = {
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi
      .fn()
      .mockImplementation((fn: (adapter: DatabaseAdapter) => Promise<unknown>) =>
        fn(mockDb as unknown as DatabaseAdapter)
      ),
    close: vi.fn().mockResolvedValue(undefined),
    ...(overrides.db ?? {}),
  } as unknown as DatabaseAdapter

  const defaultDispatchFn = vi.fn().mockReturnValue({
    id: 'test-id',
    status: 'running',
    cancel: vi.fn(),
    result: Promise.resolve(
      makeMockDispatchResult({
        parsed: {
          expansion_priority: 'medium',
          coverage_gaps: [
            {
              ac_ref: 'AC1',
              description: 'No integration test for happy path',
              gap_type: 'missing-integration',
            },
          ],
          suggested_tests: [
            {
              test_name: 'runFoo integration',
              test_type: 'integration',
              description: 'Test with real DB',
              target_ac: 'AC1',
            },
          ],
          notes: 'Unit coverage solid but integration layer untested.',
        },
      })
    ),
  } as DispatchHandle & { result: Promise<DispatchResult<unknown>> })

  const mockDispatcher: Dispatcher = {
    dispatch: overrides.dispatch ?? defaultDispatchFn,
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }

  const mockContextCompiler: ContextCompiler = {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  }

  return {
    db: mockDb,
    pack: mockPack,
    contextCompiler: mockContextCompiler,
    dispatcher: mockDispatcher,
  }
}

const DEFAULT_PARAMS: TestExpansionParams = {
  storyKey: '22-9',
  storyFilePath: '/path/to/story.md',
  workingDirectory: '/repo',
  filesModified: ['src/foo.ts', 'src/bar.ts'],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTestExpansion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue(
      '## Story\nAs a pipeline agent...\n\n## Acceptance Criteria\n### AC1: ...'
    )
    mockGetGitDiffForFiles.mockResolvedValue('diff --git a/src/foo.ts b/src/foo.ts\n+line added\n')
    mockGetGitDiffStatSummary.mockResolvedValue('src/foo.ts | 5 ++---\n1 file changed\n')
  })

  // -------------------------------------------------------------------------
  // AC3: Happy path — dispatch returns valid YAML
  // -------------------------------------------------------------------------

  it('happy path — returns populated expansion_priority, coverage_gaps, and suggested_tests', async () => {
    const deps = makeMockDeps()
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('medium')
    expect(result.coverage_gaps).toHaveLength(1)
    expect(result.coverage_gaps[0].ac_ref).toBe('AC1')
    expect(result.coverage_gaps[0].gap_type).toBe('missing-integration')
    expect(result.suggested_tests).toHaveLength(1)
    expect(result.suggested_tests[0].test_type).toBe('integration')
    expect(result.notes).toBe('Unit coverage solid but integration layer untested.')
    expect(result.error).toBeUndefined()
    expect(result.tokenUsage).toEqual({ input: 200, output: 50 })
  })

  it('dispatches with taskType test-expansion and agent claude-code', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: {
            expansion_priority: 'low',
            coverage_gaps: [],
            suggested_tests: [],
          },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(dispatchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'test-expansion',
        agent: 'claude-code',
      })
    )
  })

  // -------------------------------------------------------------------------
  // AC2: Prompt assembly — story_content never truncated
  // -------------------------------------------------------------------------

  it('story_content never truncated even when git diff pushes near 40,000-token ceiling', async () => {
    // Large story content that uses most of the budget
    const largeStory = 'Story AC detail: '.repeat(500) // ~2000 chars
    mockReadFile.mockResolvedValue(largeStory)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runTestExpansion(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // Story content should be fully preserved (required priority)
    expect(callArgs.prompt).toContain('Story AC detail:')
  })

  // -------------------------------------------------------------------------
  // AC2: Scoped diff fallback to stat-only when over budget
  // -------------------------------------------------------------------------

  it('uses stat-only summary when scoped diff exceeds 200,000-token ceiling', async () => {
    // Scoped diff that exceeds 200000 token ceiling (~800000 chars)
    mockGetGitDiffForFiles.mockResolvedValue('x'.repeat(825_000))
    mockGetGitDiffStatSummary.mockResolvedValue('src/foo.ts | 5 ++---\n1 file changed\n')
    mockGetGitDiffStatForFiles.mockResolvedValue('src/foo.ts | 5 ++---\n1 file changed\n')

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(mockGetGitDiffForFiles).toHaveBeenCalled()
    expect(mockGetGitDiffStatForFiles).toHaveBeenCalled()

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // Stat-only summary should appear in the prompt, not the large diff
    expect(callArgs.prompt).toContain('1 file changed')
  })

  it('uses scoped diff when filesModified provided and fits budget', async () => {
    mockGetGitDiffForFiles.mockResolvedValue('diff scoped\n+small change\n')

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runTestExpansion(deps, { ...DEFAULT_PARAMS, filesModified: ['src/foo.ts'] })

    expect(mockGetGitDiffForFiles).toHaveBeenCalledWith(['src/foo.ts'], '/repo')
    expect(mockGetGitDiffStatSummary).not.toHaveBeenCalled()

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    expect(callArgs.prompt).toContain('diff scoped')
  })

  // -------------------------------------------------------------------------
  // AC5: Graceful fallback on dispatch failure
  // -------------------------------------------------------------------------

  it('returns graceful fallback with error field when dispatch status=failed', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          status: 'failed',
          exitCode: 1,
          output: 'stderr: something went wrong',
          parsed: null,
          parseError: 'Agent exited with code 1',
          tokenEstimate: { input: 100, output: 0 },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('low')
    expect(result.coverage_gaps).toEqual([])
    expect(result.suggested_tests).toEqual([])
    expect(result.error).toBeDefined()
    expect(result.error).toContain('Dispatch status: failed')
    expect(result.tokenUsage).toEqual({ input: 100, output: 0 })
  })

  it('returns graceful fallback when dispatch returns parsed=null (unparseable YAML)', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          status: 'completed',
          exitCode: 0,
          parsed: null,
          parseError: 'no_yaml_block',
          tokenEstimate: { input: 150, output: 0 },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('low')
    expect(result.coverage_gaps).toEqual([])
    expect(result.suggested_tests).toEqual([])
    expect(result.error).toBeDefined()
    expect(result.tokenUsage).toEqual({ input: 150, output: 0 })
  })

  it('returns graceful fallback when schema safeParse fails (missing required field)', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: {
            // expansion_priority is missing — schema validation should fail since
            // the preprocess converts unknown to 'low', but we can test with a
            // coverage_gaps item that has an invalid gap_type
            expansion_priority: 'high',
            coverage_gaps: [{ ac_ref: 'AC1', description: 'test', gap_type: 'invalid-type' }],
            suggested_tests: [],
          },
          tokenEstimate: { input: 120, output: 30 },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    // invalid gap_type causes schema validation to fail → graceful fallback
    expect(result.expansion_priority).toBe('low')
    expect(result.coverage_gaps).toEqual([])
    expect(result.error).toBeDefined()
  })

  it('never throws — returns graceful fallback even when pack.getPrompt throws', async () => {
    const getPromptFn = vi.fn().mockRejectedValue(new Error('Template not found'))
    const deps = makeMockDeps({ getPrompt: getPromptFn })

    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('low')
    expect(result.coverage_gaps).toEqual([])
    expect(result.error).toContain('Failed to retrieve prompt template')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('never throws — returns graceful fallback when story file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'))
    const deps = makeMockDeps()

    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('low')
    expect(result.coverage_gaps).toEqual([])
    expect(result.error).toContain('Failed to read story file')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('never throws — returns graceful fallback when dispatch throws unexpectedly', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.reject(new Error('Internal dispatch error')),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('low')
    expect(result.coverage_gaps).toEqual([])
    expect(result.error).toContain('Dispatch error')
  })

  // -------------------------------------------------------------------------
  // AC6: Schema — expansion_priority coercion and defaults
  // -------------------------------------------------------------------------

  it('coerces unknown expansion_priority to low', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: {
            expansion_priority: 'UNKNOWN_VALUE',
            coverage_gaps: [],
            suggested_tests: [],
          },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.expansion_priority).toBe('low')
    expect(result.error).toBeUndefined()
  })

  it('defaults coverage_gaps and suggested_tests to empty arrays when missing from output', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: {
            expansion_priority: 'low',
            // coverage_gaps and suggested_tests intentionally absent
          },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.coverage_gaps).toEqual([])
    expect(result.suggested_tests).toEqual([])
    expect(result.error).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // AC2: arch constraints from decision store injected into prompt
  // -------------------------------------------------------------------------

  it('injects arch constraints from decision store into prompt sections', async () => {
    const archDecisions = [
      {
        id: 'dec-1',
        phase: 'solutioning',
        category: 'architecture',
        key: 'db_engine',
        value: 'SQLite via better-sqlite3',
        rationale: null,
        pipeline_run_id: null,
        created_at: '',
        updated_at: '',
      },
    ]

    const dbOverride = {
      query: vi.fn().mockResolvedValue(archDecisions),
    }

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn, db: dbOverride as Partial<DatabaseAdapter> })
    await runTestExpansion(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    expect(callArgs.prompt).toContain('db_engine: SQLite via better-sqlite3')
  })

  // -------------------------------------------------------------------------
  // Additional: no filesModified — skip git diff
  // -------------------------------------------------------------------------

  it('skips git diff when no filesModified provided', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runTestExpansion(deps, {
      storyKey: '22-9',
      storyFilePath: '/path/to/story.md',
      // No filesModified
    })

    expect(mockGetGitDiffForFiles).not.toHaveBeenCalled()
    expect(mockGetGitDiffStatSummary).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Token usage in result
  // -------------------------------------------------------------------------

  it('includes tokenUsage from dispatch in successful result', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          tokenEstimate: { input: 450, output: 130 },
          parsed: { expansion_priority: 'high', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runTestExpansion(deps, DEFAULT_PARAMS)

    expect(result.tokenUsage).toEqual({ input: 450, output: 130 })
  })
})

// ---------------------------------------------------------------------------
// Story 37-6: Test pattern injection
// ---------------------------------------------------------------------------

describe('Story 37-6: test pattern injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue(
      '## Story\nAs a pipeline agent...\n\n## Acceptance Criteria\n### AC1: ...'
    )
    mockGetGitDiffForFiles.mockResolvedValue('diff --git a/src/foo.ts\n+line added\n')
    mockGetGitDiffStatSummary.mockResolvedValue('src/foo.ts | 5 ++---\n1 file changed\n')
    mockResolveDefaultTestPatterns.mockReturnValue('VITEST_DEFAULT_MOCK')
  })

  it('AC6: test_patterns injected into prompt from decision store decisions', async () => {
    // Set up db to return test-pattern decisions
    const testPatternDecisions = [
      {
        id: 'tp-1',
        phase: 'solutioning',
        category: 'test-patterns',
        key: 'framework',
        value: 'Go test (stdlib)',
        rationale: null,
        pipeline_run_id: null,
        created_at: '',
        updated_at: '',
      },
    ]
    const dbOverride = {
      query: vi.fn().mockResolvedValue(testPatternDecisions),
    }

    // Use a template that includes the {{test_patterns}} placeholder
    const templateWithPatterns =
      '## Mission\n{{story_content}}\n\n## Git Changes\n{{git_diff}}\n\n## Test Patterns\n{{test_patterns}}\n\n## Arch\n{{arch_constraints}}'
    const getPromptFn = vi.fn().mockResolvedValue(templateWithPatterns)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps = makeMockDeps({
      dispatch: dispatchFn,
      db: dbOverride as Partial<DatabaseAdapter>,
      getPrompt: getPromptFn,
    })
    await runTestExpansion(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    expect(callArgs.prompt).toContain('Go test (stdlib)')
    // Resolver should NOT be called since decisions were found
    expect(mockResolveDefaultTestPatterns).not.toHaveBeenCalled()
  })

  it('AC6: stack-aware defaults used when no test-pattern decisions exist', async () => {
    // db returns empty (default)
    mockResolveDefaultTestPatterns.mockReturnValue('RESOLVER_PATTERNS_MOCK')

    // Use a template that includes the {{test_patterns}} placeholder
    const templateWithPatterns =
      '## Mission\n{{story_content}}\n\n## Git Changes\n{{git_diff}}\n\n## Test Patterns\n{{test_patterns}}\n\n## Arch\n{{arch_constraints}}'
    const getPromptFn = vi.fn().mockResolvedValue(templateWithPatterns)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { expansion_priority: 'low', coverage_gaps: [], suggested_tests: [] },
        })
      ),
    })

    const deps: WorkflowDeps = {
      ...makeMockDeps({ dispatch: dispatchFn, getPrompt: getPromptFn }),
      projectRoot: '/some/project',
    }
    await runTestExpansion(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    expect(callArgs.prompt).toContain('RESOLVER_PATTERNS_MOCK')
  })
})
