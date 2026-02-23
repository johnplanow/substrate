/**
 * Tests for runCodeReview — compiled code-review workflow.
 *
 * Mocks: MethodologyPack.getPrompt, fs/promises.readFile,
 * child_process.spawn (via git-helpers), Dispatcher.dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock functions so they are available when vi.mock factories execute
// ---------------------------------------------------------------------------

const { mockReadFile, mockGetGitDiffSummary, mockGetGitDiffStatSummary, mockGetGitDiffForFiles } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockGetGitDiffSummary: vi.fn(),
  mockGetGitDiffStatSummary: vi.fn(),
  mockGetGitDiffForFiles: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('../git-helpers.js', () => ({
  getGitDiffSummary: mockGetGitDiffSummary,
  getGitDiffStatSummary: mockGetGitDiffStatSummary,
  getGitDiffForFiles: mockGetGitDiffForFiles,
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
// Import after mocks
// ---------------------------------------------------------------------------

import { runCodeReview } from '../code-review.js'
import type { WorkflowDeps, CodeReviewParams } from '../types.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockDispatchResult(overrides: Partial<DispatchResult<unknown>> = {}): DispatchResult<unknown> {
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

const DEFAULT_TEMPLATE = 'Review the story: {{story_content}}\n\nGit diff: {{git_diff}}\n\nConstraints: {{arch_constraints}}\n\nFind 3-10 issues minimum. Re-examine if fewer than 3 issues found. Dimensions: AC compliance, task completion, code quality, test coverage. Severity: blocker, major, minor. Verify claims against diff.'

function makeMockDeps(overrides: {
  getPrompt?: ReturnType<typeof vi.fn>
  dispatch?: ReturnType<typeof vi.fn>
  db?: Partial<BetterSqlite3Database>
} = {}): WorkflowDeps {
  const mockPack: MethodologyPack = {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: { 'code-review': 'prompts/code-review.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: overrides.getPrompt ?? vi.fn().mockResolvedValue(DEFAULT_TEMPLATE),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }

  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn(),
    }),
    ...(overrides.db ?? {}),
  } as unknown as BetterSqlite3Database

  const defaultDispatchFn = vi.fn().mockReturnValue({
    id: 'test-id',
    status: 'running',
    cancel: vi.fn(),
    result: Promise.resolve(
      makeMockDispatchResult({
        parsed: {
          verdict: 'SHIP_IT',
          issues: 0,
          issue_list: [],
          notes: 'No issues found.',
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

const DEFAULT_PARAMS: CodeReviewParams = {
  storyKey: '10-3-code-review',
  storyFilePath: '/path/to/story.md',
  workingDirectory: '/repo',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCodeReview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadFile.mockResolvedValue('## Story\nAs a developer...\n\n## Acceptance Criteria\n### AC1: ...')
    mockGetGitDiffSummary.mockResolvedValue('diff --git a/src/foo.ts b/src/foo.ts\n+line added\n')
    mockGetGitDiffStatSummary.mockResolvedValue('src/foo.ts | 5 ++---\n1 file changed\n')
    mockGetGitDiffForFiles.mockResolvedValue('diff --git a/src/foo.ts b/src/foo.ts\n+scoped line\n')
  })

  // -------------------------------------------------------------------------
  // AC4: Dispatch and Output Parsing
  // -------------------------------------------------------------------------

  it('returns SHIP_IT verdict with empty issue_list on success', async () => {
    const deps = makeMockDeps()
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('SHIP_IT')
    expect(result.issues).toBe(0)
    expect(result.issue_list).toEqual([])
    expect(result.notes).toBe('No issues found.')
    expect(result.error).toBeUndefined()
  })

  it('returns NEEDS_MINOR_FIXES verdict with 3 minor issues', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: {
          verdict: 'NEEDS_MINOR_FIXES',
          issues: 3,
          issue_list: [
            { severity: 'minor', description: 'Missing error handling' },
            { severity: 'minor', description: 'Test coverage below threshold' },
            { severity: 'minor', description: 'ESM import missing .js extension', file: 'src/foo.ts', line: 5 },
          ],
          notes: 'Fix the listed issues.',
        },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MINOR_FIXES')
    expect(result.issues).toBe(3)
    expect(result.issue_list).toHaveLength(3)
    expect(result.issue_list[0].severity).toBe('minor')
    expect(result.issue_list[2].file).toBe('src/foo.ts')
    expect(result.issue_list[2].line).toBe(5)
  })

  it('returns NEEDS_MAJOR_REWORK verdict with blocker issue', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: {
          verdict: 'NEEDS_MAJOR_REWORK',
          issues: 1,
          issue_list: [
            { severity: 'blocker', description: 'Security vulnerability in auth module', file: 'src/auth.ts', line: 42 },
          ],
        },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.issues).toBe(1)
    expect(result.issue_list[0].severity).toBe('blocker')
  })

  it('dispatches with taskType code-review and agent claude-code', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, DEFAULT_PARAMS)

    expect(dispatchFn).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'code-review',
        agent: 'claude-code',
      })
    )
  })

  // -------------------------------------------------------------------------
  // AC1: Pack Prompt Retrieval
  // -------------------------------------------------------------------------

  it('retrieves prompt via pack.getPrompt("code-review")', async () => {
    const getPromptFn = vi.fn().mockResolvedValue('Review: {{story_content}} Diff: {{git_diff}} Constraints: {{arch_constraints}}')
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ getPrompt: getPromptFn, dispatch: dispatchFn })
    await runCodeReview(deps, DEFAULT_PARAMS)
    expect(getPromptFn).toHaveBeenCalledWith('code-review')
  })

  it('returns NEEDS_MAJOR_REWORK if pack.getPrompt throws', async () => {
    const getPromptFn = vi.fn().mockRejectedValue(new Error('Template not found'))
    const deps = makeMockDeps({ getPrompt: getPromptFn })

    const result = await runCodeReview(deps, DEFAULT_PARAMS)
    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.error).toContain('Failed to retrieve prompt template')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  // -------------------------------------------------------------------------
  // AC2: Context Injection with Git Diff
  // -------------------------------------------------------------------------

  it('injects story_content, git_diff into prompt', async () => {
    const storyContent = '## Story\nAs a developer I want...'
    mockReadFile.mockResolvedValue(storyContent)
    mockGetGitDiffSummary.mockResolvedValue('diff --git a/foo.ts b/foo.ts')

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, DEFAULT_PARAMS)

    expect(mockReadFile).toHaveBeenCalledWith('/path/to/story.md', 'utf-8')
    expect(mockGetGitDiffSummary).toHaveBeenCalledWith('/repo')

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    expect(callArgs.prompt).toContain('As a developer I want')
    expect(callArgs.prompt).toContain('diff --git a/foo.ts b/foo.ts')
  })

  it('injects arch_constraints from decision store into prompt', async () => {
    const archDecisions = [
      {
        id: 'dec-1',
        phase: 'solutioning',
        category: 'architecture',
        key: 'api_style',
        value: 'REST only no GraphQL',
        rationale: null,
        pipeline_run_id: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'dec-2',
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

    // Override db.prepare so getDecisionsByPhase returns arch decisions
    const dbOverride = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue(archDecisions),
        get: vi.fn().mockReturnValue(undefined),
        run: vi.fn(),
      }),
    }

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn, db: dbOverride as Partial<BetterSqlite3Database> })
    await runCodeReview(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    expect(callArgs.prompt).toContain('api_style: REST only no GraphQL')
    expect(callArgs.prompt).toContain('db_engine: SQLite via better-sqlite3')
  })

  it('returns NEEDS_MAJOR_REWORK if story file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'))
    const deps = makeMockDeps()

    const result = await runCodeReview(deps, DEFAULT_PARAMS)
    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.error).toContain('Failed to read story file')
  })

  it('proceeds with empty git diff if git command fails', async () => {
    mockGetGitDiffSummary.mockResolvedValue('')

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('SHIP_IT')
    expect(dispatchFn).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC3: Token Budget Enforcement
  // -------------------------------------------------------------------------

  it('falls back to stat-only diff when full diff causes over-budget', async () => {
    // Create a very large git diff that will overflow the 50000 token ceiling
    const largeDiff = 'x'.repeat(220000) // ~55000 tokens

    mockGetGitDiffSummary.mockResolvedValue(largeDiff)
    mockGetGitDiffStatSummary.mockResolvedValue('src/foo.ts | 5 ++---\n1 file changed\n')

    // Template that puts all content into the prompt without summarizing
    const getPromptFn = vi.fn().mockResolvedValue(
      '{{story_content}}\n{{git_diff}}\n{{arch_constraints}}'
    )

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ getPrompt: getPromptFn, dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    // Should have called both diff functions
    expect(mockGetGitDiffSummary).toHaveBeenCalled()
    expect(mockGetGitDiffStatSummary).toHaveBeenCalled()
    expect(result.verdict).toBe('SHIP_IT')
  })

  it('story_content is never truncated even when over budget', async () => {
    // Story content plus large constraints causes overflow
    const largeStory = 'Story content: '.repeat(100)
    mockReadFile.mockResolvedValue(largeStory)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // Story content should be preserved in the assembled prompt
    expect(callArgs.prompt).toContain('Story content:')
  })

  // -------------------------------------------------------------------------
  // Scoped diff: three-tier diff selection
  // -------------------------------------------------------------------------

  it('uses scoped diff when filesModified provided and fits budget', async () => {
    mockGetGitDiffForFiles.mockResolvedValue('diff scoped\n+small change\n')

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, { ...DEFAULT_PARAMS, filesModified: ['src/foo.ts', 'src/bar.ts'] })

    expect(mockGetGitDiffForFiles).toHaveBeenCalledWith(['src/foo.ts', 'src/bar.ts'], '/repo')
    // Should NOT call the full diff when scoped diff is used
    expect(mockGetGitDiffSummary).not.toHaveBeenCalled()
  })

  it('falls back to stat-only when scoped diff exceeds ceiling', async () => {
    // Scoped diff that exceeds 50000 token ceiling
    mockGetGitDiffForFiles.mockResolvedValue('x'.repeat(220000)) // ~55000 tokens

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, { ...DEFAULT_PARAMS, filesModified: ['src/huge.ts'] })

    expect(mockGetGitDiffForFiles).toHaveBeenCalled()
    expect(mockGetGitDiffStatSummary).toHaveBeenCalled()
  })

  it('uses full diff path when no filesModified provided', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, DEFAULT_PARAMS)

    expect(mockGetGitDiffForFiles).not.toHaveBeenCalled()
    expect(mockGetGitDiffSummary).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC7: Failure and Timeout Handling
  // -------------------------------------------------------------------------

  it('returns default NEEDS_MAJOR_REWORK on dispatch failure', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        status: 'failed',
        exitCode: 1,
        output: 'stderr: something went wrong',
        parsed: null,
        parseError: 'Agent exited with code 1',
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.issues).toBe(0)
    expect(result.issue_list).toEqual([])
    expect(result.error).toContain('Dispatch status: failed')
  })

  it('returns default NEEDS_MAJOR_REWORK on dispatch timeout', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        status: 'timeout',
        exitCode: -1,
        output: '',
        parsed: null,
        parseError: 'Agent timed out after 300000ms',
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.error).toContain('timeout')
  })

  it('returns NEEDS_MAJOR_REWORK when dispatch throws unexpectedly', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.reject(new Error('Internal error')),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.error).toContain('Dispatch error')
  })

  // -------------------------------------------------------------------------
  // AC6: Output Schema Validation
  // -------------------------------------------------------------------------

  it('returns schema_validation_failed when YAML output has invalid verdict', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: {
          verdict: 'INVALID_VERDICT',
          issues: 0,
          issue_list: [],
        },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.error).toBe('schema_validation_failed')
    expect(result.details).toBeDefined()
  })

  it('returns schema_validation_failed when no YAML block in output', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        status: 'completed',
        exitCode: 0,
        parsed: null,
        parseError: 'no_yaml_block',
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.verdict).toBe('NEEDS_MAJOR_REWORK')
    expect(result.error).toBe('schema_validation_failed')
  })

  // -------------------------------------------------------------------------
  // AC5: Adversarial Review Framing
  // -------------------------------------------------------------------------

  it('template contains adversarial framing and review dimensions', async () => {
    // Use default template that includes the adversarial framing
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, DEFAULT_PARAMS)

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    const prompt = callArgs.prompt

    // Adversarial framing (from template)
    expect(prompt).toContain('3-10 issues minimum')
    // Four review dimensions
    expect(prompt).toContain('AC compliance')
    expect(prompt).toContain('task completion')
    expect(prompt).toContain('code quality')
    expect(prompt).toContain('test coverage')
    // Severity system
    expect(prompt).toContain('blocker')
    expect(prompt).toContain('major')
    expect(prompt).toContain('minor')
    // Git reality check
    expect(prompt).toContain('Verify claims against diff')
    // <3 issues re-examine rule
    expect(prompt).toContain('Re-examine if fewer than 3 issues found')
  })

  // -------------------------------------------------------------------------
  // AC8: Token Usage Reporting
  // -------------------------------------------------------------------------

  it('includes tokenUsage in successful result', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        tokenEstimate: { input: 350, output: 120 },
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.tokenUsage).toEqual({ input: 350, output: 120 })
  })

  it('includes tokenUsage in failure result', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'failed',
        tokenEstimate: { input: 200, output: 0 },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    const result = await runCodeReview(deps, DEFAULT_PARAMS)

    expect(result.tokenUsage).toEqual({ input: 200, output: 0 })
  })

  it('uses workingDirectory param for git diff capture', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, { ...DEFAULT_PARAMS, workingDirectory: '/custom/repo' })

    expect(mockGetGitDiffSummary).toHaveBeenCalledWith('/custom/repo')
  })

  it('uses process.cwd() when no workingDirectory provided', async () => {
    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(makeMockDispatchResult({
        parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
      })),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, {
      storyKey: '10-3',
      storyFilePath: '/path/to/story.md',
    })

    expect(mockGetGitDiffSummary).toHaveBeenCalledWith(process.cwd())
  })
})
