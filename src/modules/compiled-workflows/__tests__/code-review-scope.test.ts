/**
 * Tests for scope_analysis injection in the code-review workflow.
 * Focuses on Task 5: verifying the scope_analysis section is assembled and injected correctly.
 *
 * Uses the same mock dispatcher pattern as code-review.test.ts.
 * Does NOT make real agent dispatches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock functions
// ---------------------------------------------------------------------------

const {
  mockReadFile,
  mockGetGitDiffSummary,
  mockGetGitDiffStatSummary,
  mockGetGitDiffStatForFiles,
  mockGetGitDiffForFiles,
  mockStageIntentToAdd,
  mockGetGitChangedFiles,
  mockLogger,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockGetGitDiffSummary: vi.fn(),
  mockGetGitDiffStatSummary: vi.fn(),
  mockGetGitDiffStatForFiles: vi.fn(),
  mockGetGitDiffForFiles: vi.fn(),
  mockStageIntentToAdd: vi.fn(),
  mockGetGitChangedFiles: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  readdir: vi.fn().mockResolvedValue([]),
}))

vi.mock('../git-helpers.js', () => ({
  getGitDiffSummary: mockGetGitDiffSummary,
  getGitDiffStatSummary: mockGetGitDiffStatSummary,
  getGitDiffStatForFiles: mockGetGitDiffStatForFiles,
  getGitDiffForFiles: mockGetGitDiffForFiles,
  stageIntentToAdd: mockStageIntentToAdd,
  getGitChangedFiles: mockGetGitChangedFiles,
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => mockLogger,
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runCodeReview } from '../code-review.js'
import type { WorkflowDeps, CodeReviewParams } from '../types.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * A template that includes the scope_analysis placeholder so we can verify
 * injection in assembled prompts.
 */
const TEMPLATE_WITH_SCOPE =
  'Review: {{story_content}}\nDiff: {{git_diff}}\nScope: {{scope_analysis}}\nConstraints: {{arch_constraints}}'

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
      prompts: { 'code-review': 'prompts/code-review.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: overrides.getPrompt ?? vi.fn().mockResolvedValue(TEMPLATE_WITH_SCOPE),
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

// Story content with a declared "File Paths to Create" section
const STORY_WITH_FILE_PATHS = `
## Story
As a developer, I want something.

### File Paths to Create
- src/modules/foo/new-module.ts

### File Paths to Modify
- src/modules/bar/existing.ts

## Acceptance Criteria

### AC1: Something
Given something
`

// Story content with no file path declarations
const STORY_WITHOUT_FILE_PATHS = `
## Story
As a developer, I want something.

## Acceptance Criteria

### AC1: Something works
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCodeReview — scope_analysis injection (Task 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetGitDiffSummary.mockResolvedValue('diff --git a/src/foo.ts b/src/foo.ts\n+line added\n')
    mockGetGitDiffStatSummary.mockResolvedValue('src/foo.ts | 1 +\n1 file changed\n')
    mockGetGitDiffForFiles.mockResolvedValue('diff --git a/src/foo.ts b/src/foo.ts\n+scoped line\n')
    mockGetGitDiffStatForFiles.mockResolvedValue('src/foo.ts | 1 +\n1 file changed\n')
    mockStageIntentToAdd.mockResolvedValue(undefined)
    mockGetGitChangedFiles.mockResolvedValue([])
  })

  it('includes scope_analysis section in assembled prompt when out-of-scope files exist', async () => {
    mockReadFile.mockResolvedValue(STORY_WITH_FILE_PATHS)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, {
      storyKey: 'test-scope-1',
      storyFilePath: '/path/to/story.md',
      workingDirectory: '/repo',
      // filesModified includes an unexpected file not in story spec
      filesModified: [
        'src/modules/foo/new-module.ts',
        'src/modules/bar/existing.ts',
        'src/modules/baz/unexpected.ts',
      ],
    })

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // The scope_analysis section should be injected (contains analysis content)
    expect(callArgs.prompt).toContain('Out-of-scope files')
    expect(callArgs.prompt).toContain('src/modules/baz/unexpected.ts')
  })

  it('omits scope_analysis section when all filesModified are within the expected set', async () => {
    mockReadFile.mockResolvedValue(STORY_WITH_FILE_PATHS)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, {
      storyKey: 'test-scope-2',
      storyFilePath: '/path/to/story.md',
      workingDirectory: '/repo',
      // Only files declared in the story spec
      filesModified: ['src/modules/foo/new-module.ts', 'src/modules/bar/existing.ts'],
    })

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // No scope violations → scope_analysis section should be empty/omitted
    expect(callArgs.prompt).not.toContain('Out-of-scope files')
    expect(callArgs.prompt).not.toContain('Pre-Computed Scope Analysis')
  })

  it('skips scope analysis gracefully when storyContent is not available (missing story file)', async () => {
    // Simulate story file read failure
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'))

    const deps = makeMockDeps()
    const result = await runCodeReview(deps, {
      storyKey: 'test-scope-3',
      storyFilePath: '/path/to/missing-story.md',
      workingDirectory: '/repo',
      filesModified: ['src/modules/baz/unexpected.ts'],
    })

    // Should return a failure result (story file missing) without crashing
    expect(result.verdict).toBe('NEEDS_MINOR_FIXES')
    expect(result.error).toContain('Failed to read story file')
  })

  it('skips scope analysis when filesModified is not provided', async () => {
    mockReadFile.mockResolvedValue(STORY_WITH_FILE_PATHS)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    // No filesModified provided — scope analysis should be skipped (no crash)
    await runCodeReview(deps, {
      storyKey: 'test-scope-4',
      storyFilePath: '/path/to/story.md',
      workingDirectory: '/repo',
      // filesModified intentionally omitted
    })

    // Should dispatch without error
    expect(dispatchFn).toHaveBeenCalled()
    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // No scope analysis section injected
    expect(callArgs.prompt).not.toContain('Out-of-scope files')
  })

  it('test files are exempt and do not trigger scope_analysis section', async () => {
    mockReadFile.mockResolvedValue(STORY_WITH_FILE_PATHS)

    const dispatchFn = vi.fn().mockReturnValue({
      id: 'test-id',
      status: 'running',
      cancel: vi.fn(),
      result: Promise.resolve(
        makeMockDispatchResult({
          parsed: { verdict: 'SHIP_IT', issues: 0, issue_list: [] },
        })
      ),
    })

    const deps = makeMockDeps({ dispatch: dispatchFn })
    await runCodeReview(deps, {
      storyKey: 'test-scope-5',
      storyFilePath: '/path/to/story.md',
      workingDirectory: '/repo',
      // Only declared files + test files not in spec
      filesModified: [
        'src/modules/foo/new-module.ts',
        'src/modules/bar/existing.ts',
        'src/modules/foo/__tests__/new-module.test.ts',
      ],
    })

    const callArgs = dispatchFn.mock.calls[0][0] as { prompt: string }
    // Test file is exempt → no scope violations → section omitted
    expect(callArgs.prompt).not.toContain('Out-of-scope files')
    expect(callArgs.prompt).not.toContain('Pre-Computed Scope Analysis')
  })
})
