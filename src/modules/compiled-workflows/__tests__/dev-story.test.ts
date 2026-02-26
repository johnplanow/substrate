/**
 * Tests for runDevStory() — compiled dev-story workflow function.
 *
 * Mocks:
 *  - fs/promises.readFile — simulates story file I/O
 *  - getDecisionsByPhase — simulates decision store queries
 *  - WorkflowDeps (pack, dispatcher) — controls template and dispatch results
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { runDevStory } from '../dev-story.js'
import { DevStoryResultSchema } from '../schemas.js'
import type { WorkflowDeps, DevStoryParams } from '../types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Mock fs/promises
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock getDecisionsByPhase from persistence
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getDecisionsByPhase: vi.fn(),
}))

vi.mock('../git-helpers.js', () => ({
  getGitChangedFiles: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { getDecisionsByPhase } from '../../../persistence/queries/decisions.js'
import { getGitChangedFiles } from '../git-helpers.js'

const mockReadFile = vi.mocked(readFile)
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)
const mockGetGitChangedFiles = vi.mocked(getGitChangedFiles)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_CONTENT = `# Story 10.2: Compiled Dev-Story Workflow
Status: draft

## Story
As a pipeline developer, I want compiled dev-story workflow.

## Acceptance Criteria
### AC1: Template retrieval
### AC2: Context injection

## Tasks / Subtasks
- [ ] Task 1: Implement feature
`

const TEMPLATE_WITH_PLACEHOLDERS = `You are a dev agent.

Story:
{{story_content}}

Architecture:
{{arch_constraints}}

{{task_scope}}

{{prior_files}}

Test Patterns:
{{test_patterns}}

Implement all tasks and return YAML.`

// ---------------------------------------------------------------------------
// Factory: create WorkflowDeps mock
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<WorkflowDeps>): WorkflowDeps {
  const mockPack: MethodologyPack = {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: { 'dev-story': 'prompts/dev-story.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(TEMPLATE_WITH_PLACEHOLDERS),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }

  const mockContextCompiler: ContextCompiler = {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  }

  const mockDispatcher: Dispatcher = {
    dispatch: vi.fn(),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }

  const mockDb = {} as import('better-sqlite3').Database

  return {
    db: mockDb,
    pack: mockPack,
    contextCompiler: mockContextCompiler,
    dispatcher: mockDispatcher,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Factory: create successful DispatchResult
// ---------------------------------------------------------------------------

function createSuccessDispatchResult(parsedOverrides?: Partial<z.infer<typeof DevStoryResultSchema>>): DispatchResult<z.infer<typeof DevStoryResultSchema>> {
  const parsed = {
    result: 'success' as const,
    ac_met: ['AC1', 'AC2'],
    ac_failures: [],
    files_modified: ['src/modules/compiled-workflows/dev-story.ts'],
    tests: 'pass' as const,
    notes: 'All AC met. 12 tests added.',
    ...parsedOverrides,
  }

  return {
    id: 'test-dispatch-id',
    status: 'completed',
    exitCode: 0,
    output: '```yaml\nresult: success\n```',
    parsed,
    parseError: null,
    durationMs: 5000,
    tokenEstimate: { input: 500, output: 200 },
  }
}

// ---------------------------------------------------------------------------
// Factory: create failed DispatchResult
// ---------------------------------------------------------------------------

function createFailedDispatchResult(options?: { status?: 'failed' | 'timeout'; exitCode?: number; parseError?: string }): DispatchResult<z.infer<typeof DevStoryResultSchema>> {
  return {
    id: 'test-dispatch-id',
    status: options?.status ?? 'failed',
    exitCode: options?.exitCode ?? 1,
    output: 'Some error output',
    parsed: null,
    parseError: options?.parseError ?? null,
    durationMs: 3000,
    tokenEstimate: { input: 300, output: 0 },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const DEFAULT_PARAMS: DevStoryParams = {
  storyKey: '10-2-dev-story',
  storyFilePath: '/path/to/story.md',
}

beforeEach(() => {
  vi.clearAllMocks()

  // Default: story file exists with content
  mockReadFile.mockResolvedValue(STORY_CONTENT as unknown as string)

  // Default: no decisions in the store
  mockGetDecisionsByPhase.mockReturnValue([])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDevStory', () => {
  // -------------------------------------------------------------------------
  // AC1: Pack Prompt Retrieval
  // -------------------------------------------------------------------------

  describe('AC1: Pack prompt retrieval', () => {
    it('calls pack.getPrompt("dev-story") with valid parameters', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createSuccessDispatchResult()),
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(deps.pack.getPrompt).toHaveBeenCalledWith('dev-story')
    })

    it('returns failure if pack.getPrompt throws', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.pack.getPrompt).mockRejectedValue(new Error('Pack not loaded'))

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toContain('template_load_failed')
      expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
    })
  })

  // -------------------------------------------------------------------------
  // Task 5: contextCompiler.registerTemplate() call
  // -------------------------------------------------------------------------

  describe('Task 5: Context template registration', () => {
    it('calls contextCompiler.registerTemplate() with taskType "dev-story"', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createSuccessDispatchResult()),
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(deps.contextCompiler.registerTemplate).toHaveBeenCalledOnce()
      expect(deps.contextCompiler.registerTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ taskType: 'dev-story' }),
      )
    })

    it('registered template has story-content and test-patterns sections (no arch-constraints)', async () => {
      const deps = createMockDeps()
      let capturedTemplate: { taskType: string; sections: Array<{ name: string; priority: string }> } | null = null
      vi.mocked(deps.contextCompiler.registerTemplate).mockImplementation((tmpl) => {
        capturedTemplate = tmpl as { taskType: string; sections: Array<{ name: string; priority: string }> }
      })
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createSuccessDispatchResult()),
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(capturedTemplate).not.toBeNull()
      const sectionNames = capturedTemplate!.sections.map((s: { name: string }) => s.name)
      expect(sectionNames).toContain('story-content')
      expect(sectionNames).toContain('test-patterns')
      // Architecture constraints are embedded in story content, not injected separately
      expect(sectionNames).not.toContain('arch-constraints')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Context Injection with Story File
  // -------------------------------------------------------------------------

  describe('AC2: Context injection with story file', () => {
    it('reads the story file and injects story_content into the prompt', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(mockReadFile).toHaveBeenCalledWith('/path/to/story.md', 'utf-8')
      expect(capturedPrompt).toContain('As a pipeline developer')
    })

    it('does not inject architecture constraints separately (they are in story content)', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''

      mockGetDecisionsByPhase.mockImplementation((_db, phase) => {
        if (phase === 'solutioning') {
          return [
            { id: '1', phase: 'solutioning', category: 'architecture', key: 'ADR-001', value: 'Modular Monolith', pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
          ]
        }
        return []
      })

      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      // Architecture constraints should NOT be injected as a separate section
      expect(capturedPrompt).not.toContain('## Architecture Constraints')
    })

    it('injects test patterns from decision store', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''

      mockGetDecisionsByPhase.mockImplementation((_db, phase) => {
        if (phase === 'solutioning') {
          return [
            { id: '1', phase: 'solutioning', category: 'test-patterns', key: 'framework', value: 'vitest', pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
          ]
        }
        return []
      })

      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(capturedPrompt).toContain('vitest')
    })

    it('injects story content and test patterns into the assembled prompt', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''

      mockGetDecisionsByPhase.mockReturnValue([
        { id: '1', phase: 'solutioning', category: 'architecture', key: 'ADR-001', value: 'Modular Monolith', pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
        { id: '2', phase: 'solutioning', category: 'test-patterns', key: 'framework', value: 'vitest', pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
      ])

      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      // story_content
      expect(capturedPrompt).toContain('As a pipeline developer')
      // test_patterns
      expect(capturedPrompt).toContain('vitest')
      // arch_constraints NOT injected separately
      expect(capturedPrompt).not.toContain('## Architecture Constraints')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Token Budget Enforcement
  // -------------------------------------------------------------------------

  describe('AC3: Token budget enforcement', () => {
    it('truncates optional test_patterns section if over 24000-token ceiling', async () => {
      const deps = createMockDeps()

      // Create a HUGE test_patterns content to force truncation
      const hugeTestPatterns = 'x'.repeat(80_000) // ~20,000 tokens on its own

      mockGetDecisionsByPhase.mockReturnValue([
        { id: '1', phase: 'solutioning', category: 'test-patterns', key: 'patterns', value: hugeTestPatterns, pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
      ])

      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      // Prompt should be assembled (not fail)
      expect(result.result).toBe('success')
      // Token count should be strictly within budget
      const estimatedTokens = Math.ceil(capturedPrompt.length / 4)
      expect(estimatedTokens).toBeLessThanOrEqual(24_000)
    })

    it('never truncates story_content (required section)', async () => {
      const deps = createMockDeps()

      // Make arch_constraints very large to force truncation
      mockGetDecisionsByPhase.mockReturnValue([
        { id: '1', phase: 'solutioning', category: 'architecture', key: 'arch', value: 'z'.repeat(6000), pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
      ])

      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      // Story content should still be fully present
      expect(capturedPrompt).toContain('As a pipeline developer')
      expect(capturedPrompt).toContain('Task 1: Implement feature')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Dispatch and Output Parsing
  // -------------------------------------------------------------------------

  describe('AC4: Dispatch and output parsing', () => {
    it('dispatches with taskType "dev-story" and timeout 600000ms', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createSuccessDispatchResult()),
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(deps.dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'claude-code',
          taskType: 'dev-story',
          timeout: 1_800_000,
          outputSchema: DevStoryResultSchema,
        }),
      )
    })

    it('returns typed result with ac_met, ac_failures, files_modified, tests', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(
          createSuccessDispatchResult({
            ac_met: ['AC1', 'AC2', 'AC3'],
            ac_failures: [],
            files_modified: ['src/foo.ts', 'src/foo.test.ts'],
            tests: 'pass',
            notes: 'All good!',
          }),
        ),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('success')
      expect(result.ac_met).toEqual(['AC1', 'AC2', 'AC3'])
      expect(result.ac_failures).toEqual([])
      expect(result.files_modified).toEqual(['src/foo.ts', 'src/foo.test.ts'])
      expect(result.tests).toBe('pass')
      expect(result.notes).toBe('All good!')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Failure and Timeout Handling
  // -------------------------------------------------------------------------

  describe('AC5: Failure and timeout handling', () => {
    it('returns failure result when dispatch fails (exit code != 0)', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'running',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createFailedDispatchResult({ status: 'failed', exitCode: 1 })),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toContain('dispatch_failed')
      expect(result.ac_met).toEqual([])
      expect(result.ac_failures).toEqual([])
      expect(result.files_modified).toEqual([])
      expect(result.tests).toBe('fail')
    })

    it('returns failure result when dispatch times out', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'running',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createFailedDispatchResult({ status: 'timeout', exitCode: 1 })),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toContain('dispatch_timeout')
    })

    it('logs partial output when dispatch fails with non-empty output', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'running',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createFailedDispatchResult({ status: 'failed', exitCode: 1 }),
          output: 'Partial agent output before failure',
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      // Verify the failure result is returned (partial output was logged internally)
      expect(result.result).toBe('failed')
      expect(result.error).toContain('dispatch_failed')
      // The partial output content should appear in the error message (first 200 chars)
      expect(result.error).toContain('Partial agent output before failure')
    })

    it('includes tokenUsage even on dispatch failure', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'running',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createFailedDispatchResult({ status: 'failed', exitCode: 1 }),
          tokenEstimate: { input: 300, output: 0 },
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.tokenUsage.input).toBe(300)
      expect(result.tokenUsage.output).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Story file not found / empty (Task 4)
  // -------------------------------------------------------------------------

  describe('Story file errors', () => {
    it('returns story_file_not_found when file does not exist', async () => {
      const deps = createMockDeps()
      mockReadFile.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      )

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('story_file_not_found')
      expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
    })

    it('returns story_file_empty when file exists but is empty', async () => {
      const deps = createMockDeps()
      mockReadFile.mockResolvedValue('   \n   ' as unknown as string)

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('story_file_empty')
    })

    it('wraps generic readFile errors with descriptive message', async () => {
      const deps = createMockDeps()
      mockReadFile.mockRejectedValue(new Error('Permission denied'))

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toContain('story_file_read_error')
      expect(result.error).toContain('Permission denied')
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Output Schema Validation
  // -------------------------------------------------------------------------

  describe('AC6: Output schema validation', () => {
    it('returns typed DevStoryResult when schema validation passes', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createSuccessDispatchResult()),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('success')
      expect(Array.isArray(result.ac_met)).toBe(true)
      expect(Array.isArray(result.ac_failures)).toBe(true)
      expect(Array.isArray(result.files_modified)).toBe(true)
      expect(['pass', 'fail']).toContain(result.tests)
    })

    it('returns schema_validation_failed when parseError is non-null', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          status: 'completed' as const,
          parsed: null,
          parseError: 'Missing required field: ac_met',
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
      expect(result.details).toBe('Missing required field: ac_met')
    })

    it('returns schema_validation_failed when parsed is null without parseError', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          status: 'completed' as const,
          parsed: null,
          parseError: null,
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
      expect(result.details).toContain('null')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Token Usage Reporting
  // -------------------------------------------------------------------------

  describe('AC7: Token usage reporting', () => {
    it('includes tokenUsage from dispatch result on success', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          tokenEstimate: { input: 750, output: 350 },
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.tokenUsage).toEqual({ input: 750, output: 350 })
    })

    it('includes zero tokenUsage when pack.getPrompt fails (pre-dispatch failure)', async () => {
      const deps = createMockDeps()
      vi.mocked(deps.pack.getPrompt).mockRejectedValue(new Error('Pack error'))

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
    })
  })

  // -------------------------------------------------------------------------
  // Default Vitest patterns (Task 4 / AC2)
  // -------------------------------------------------------------------------

  describe('Default test patterns injection', () => {
    it('injects default Vitest patterns when no test-pattern decisions exist', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''

      // No decisions at all
      mockGetDecisionsByPhase.mockReturnValue([])

      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      // Default patterns should mention Vitest
      expect(capturedPrompt).toContain('Vitest')
      expect(capturedPrompt).toContain('vi.mock')
    })

    it('uses decision store test patterns instead of defaults when present', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''

      mockGetDecisionsByPhase.mockReturnValue([
        { id: '1', phase: 'solutioning', category: 'test-patterns', key: 'custom-framework', value: 'jest-custom', pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
      ])

      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(capturedPrompt).toContain('jest-custom')
    })
  })

  // -------------------------------------------------------------------------
  // Git fallback for files_modified when YAML parsing fails
  // -------------------------------------------------------------------------

  describe('Git fallback for files_modified', () => {
    it('recovers files_modified from git when parseError is no_yaml_block', async () => {
      const deps = createMockDeps()
      mockGetGitChangedFiles.mockResolvedValue([
        'src/state/play-vs-ai-machine.ts',
        'src/ui/components/game/mode-selection.tsx',
      ])

      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          status: 'completed' as const,
          parsed: null,
          parseError: 'no_yaml_block',
          output: 'Story 7.1 implementation complete! All tasks done.',
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
      expect(result.files_modified).toEqual([
        'src/state/play-vs-ai-machine.ts',
        'src/ui/components/game/mode-selection.tsx',
      ])
      expect(mockGetGitChangedFiles).toHaveBeenCalledOnce()
    })

    it('recovers files_modified from git when parsed is null without parseError', async () => {
      const deps = createMockDeps()
      mockGetGitChangedFiles.mockResolvedValue(['src/foo.ts'])

      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          status: 'completed' as const,
          parsed: null,
          parseError: null,
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.files_modified).toEqual(['src/foo.ts'])
    })

    it('returns empty files_modified if git fallback fails', async () => {
      const deps = createMockDeps()
      mockGetGitChangedFiles.mockRejectedValue(new Error('git not found'))

      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          status: 'completed' as const,
          parsed: null,
          parseError: 'no_yaml_block',
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.files_modified).toEqual([])
    })

    it('returns empty files_modified if git reports clean repo', async () => {
      const deps = createMockDeps()
      mockGetGitChangedFiles.mockResolvedValue([])

      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve({
          ...createSuccessDispatchResult(),
          status: 'completed' as const,
          parsed: null,
          parseError: 'no_yaml_block',
        }),
      })

      const result = await runDevStory(deps, DEFAULT_PARAMS)

      expect(result.result).toBe('failed')
      expect(result.files_modified).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // AC2 (13-3): taskScope injection into prompt
  // -------------------------------------------------------------------------

  describe('AC2 (13-3): taskScope prompt injection', () => {
    it('injects task_scope section into prompt when taskScope param is provided', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, {
        ...DEFAULT_PARAMS,
        taskScope: 'T1: Implement type extension\nT2: Update dev-story module',
      })

      expect(capturedPrompt).toContain('T1: Implement type extension')
      expect(capturedPrompt).toContain('T2: Update dev-story module')
      expect(capturedPrompt).toContain('ONLY the following tasks')
    })

    it('does not inject task_scope section when taskScope param is absent', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(capturedPrompt).not.toContain('ONLY the following tasks')
    })

    it('does not inject task_scope when taskScope is empty string', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, { ...DEFAULT_PARAMS, taskScope: '' })

      expect(capturedPrompt).not.toContain('ONLY the following tasks')
    })
  })

  // -------------------------------------------------------------------------
  // AC4 (13-3): priorFiles injection into prompt
  // -------------------------------------------------------------------------

  describe('AC4 (13-3): priorFiles prompt injection', () => {
    it('injects prior_files section into prompt when priorFiles param is provided', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, {
        ...DEFAULT_PARAMS,
        priorFiles: ['src/types.ts', 'src/impl.ts'],
      })

      expect(capturedPrompt).toContain('src/types.ts')
      expect(capturedPrompt).toContain('src/impl.ts')
      expect(capturedPrompt).toContain('prior batch')
    })

    it('does not inject prior_files section when priorFiles is absent', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, DEFAULT_PARAMS)

      expect(capturedPrompt).not.toContain('prior batch')
    })

    it('does not inject prior_files when priorFiles is empty array', async () => {
      const deps = createMockDeps()
      let capturedPrompt = ''
      vi.mocked(deps.dispatcher.dispatch).mockImplementation((req) => {
        capturedPrompt = req.prompt
        return {
          id: 'test-id',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(createSuccessDispatchResult()),
        }
      })

      await runDevStory(deps, { ...DEFAULT_PARAMS, priorFiles: [] })

      expect(capturedPrompt).not.toContain('prior batch')
    })
  })

  // -------------------------------------------------------------------------
  // Successful full flow
  // -------------------------------------------------------------------------

  describe('Successful full flow', () => {
    it('executes complete flow: template -> story file read -> context injected -> dispatched -> parsed', async () => {
      const deps = createMockDeps()

      mockGetDecisionsByPhase.mockReturnValue([
        { id: '1', phase: 'solutioning', category: 'architecture', key: 'ADR-001', value: 'Modular Monolith', pipeline_run_id: null, rationale: null, created_at: '', updated_at: '' },
      ])

      vi.mocked(deps.dispatcher.dispatch).mockReturnValue({
        id: 'test-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(
          createSuccessDispatchResult({
            ac_met: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8'],
            files_modified: ['src/modules/compiled-workflows/dev-story.ts'],
            tests: 'pass',
            notes: 'Complete implementation.',
          }),
        ),
      })

      const result = await runDevStory(deps, {
        storyKey: '10-2-dev-story',
        storyFilePath: '/stories/10-2.md',
        pipelineRunId: 'run-123',
      })

      // Verify the full chain
      expect(deps.pack.getPrompt).toHaveBeenCalledWith('dev-story')
      expect(mockReadFile).toHaveBeenCalledWith('/stories/10-2.md', 'utf-8')
      expect(mockGetDecisionsByPhase).toHaveBeenCalledWith(expect.anything(), 'solutioning')
      expect(deps.dispatcher.dispatch).toHaveBeenCalledOnce()
      expect(result.result).toBe('success')
      expect(result.ac_met).toHaveLength(8)
      expect(result.tests).toBe('pass')
      expect(result.tokenUsage.input).toBeGreaterThan(0)
    })
  })
})
