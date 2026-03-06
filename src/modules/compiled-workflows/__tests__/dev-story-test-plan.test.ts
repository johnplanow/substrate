/**
 * Tests for test plan injection into runDevStory() — AC3 and AC4 of story 22-7.
 *
 * Uses the capture-dispatcher pattern to assert on the assembled prompt.
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
  stat: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock decision store — we need both getDecisionsByPhase and getDecisionsByCategory
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getDecisionsByPhase: vi.fn(),
  getDecisionsByCategory: vi.fn(),
}))

vi.mock('../git-helpers.js', () => ({
  getGitChangedFiles: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../implementation-orchestrator/project-findings.js', () => ({
  getProjectFindings: vi.fn().mockReturnValue([]),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'
import { getDecisionsByPhase, getDecisionsByCategory } from '../../../persistence/queries/decisions.js'

const mockReadFile = vi.mocked(readFile)
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)
const mockGetDecisionsByCategory = vi.mocked(getDecisionsByCategory)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORY_KEY = '22-7'

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

const TEMPLATE = `Story:
{{story_content}}

Test Patterns:
{{test_patterns}}

Test Plan:
{{test_plan}}

Prior Findings:
{{prior_findings}}`

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createSuccessDispatchResult(): DispatchResult<z.infer<typeof DevStoryResultSchema>> {
  return {
    id: 'test-dispatch-id',
    status: 'completed',
    exitCode: 0,
    output: 'result: success\n',
    parsed: {
      result: 'success' as const,
      ac_met: ['AC1', 'AC2'],
      ac_failures: [],
      files_modified: ['src/modules/test-plan.ts'],
      tests: 'pass' as const,
    },
    parseError: null,
    durationMs: 5000,
    tokenEstimate: { input: 500, output: 200 },
  }
}

function createMockDeps(capturedPrompts: string[]): WorkflowDeps {
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
    getPrompt: vi.fn().mockResolvedValue(TEMPLATE),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }

  const mockContextCompiler: ContextCompiler = {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  }

  const mockDispatcher: Dispatcher = {
    dispatch: vi.fn().mockImplementation((req: { prompt: string }) => {
      capturedPrompts.push(req.prompt)
      return {
        id: 'test-dispatch-id',
        status: 'queued',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(createSuccessDispatchResult()),
      }
    }),
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
  }
}

const DEFAULT_PARAMS: DevStoryParams = {
  storyKey: STORY_KEY,
  storyFilePath: '/path/to/22-7.md',
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  mockReadFile.mockResolvedValue(STORY_CONTENT as unknown as string)
  mockGetDecisionsByPhase.mockReturnValue([])
  mockGetDecisionsByCategory.mockReturnValue([])
})

// ---------------------------------------------------------------------------
// AC3: Dev-story injects test plan when available
// ---------------------------------------------------------------------------

describe('AC3: Dev-story injects test plan when available', () => {
  it('includes ## Test Plan section when test plan decision exists for storyKey', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'decision-1',
        pipeline_run_id: 'run-123',
        phase: 'implementation',
        category: 'test-plan',
        key: STORY_KEY,
        value: JSON.stringify({
          test_files: ['src/modules/test-plan/__tests__/test-plan.test.ts'],
          test_categories: ['unit'],
          coverage_notes: 'AC1 covered by test-plan.test.ts',
        }),
        rationale: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])

    await runDevStory(deps, DEFAULT_PARAMS)

    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0]).toContain('## Test Plan')
  })

  it('includes test file names in the prompt when test plan exists', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'decision-1',
        pipeline_run_id: 'run-123',
        phase: 'implementation',
        category: 'test-plan',
        key: STORY_KEY,
        value: JSON.stringify({
          test_files: ['src/modules/foo/__tests__/foo.test.ts', 'src/modules/bar/__tests__/bar.test.ts'],
          test_categories: ['unit', 'integration'],
          coverage_notes: 'AC1 covered by foo.test.ts. AC2 covered by bar.test.ts.',
        }),
        rationale: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])

    await runDevStory(deps, DEFAULT_PARAMS)

    expect(capturedPrompts[0]).toContain('src/modules/foo/__tests__/foo.test.ts')
    expect(capturedPrompts[0]).toContain('src/modules/bar/__tests__/bar.test.ts')
  })

  it('includes test categories in the prompt when test plan exists', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'decision-1',
        pipeline_run_id: 'run-123',
        phase: 'implementation',
        category: 'test-plan',
        key: STORY_KEY,
        value: JSON.stringify({
          test_files: ['src/foo.test.ts'],
          test_categories: ['unit', 'integration'],
          coverage_notes: 'Notes here',
        }),
        rationale: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])

    await runDevStory(deps, DEFAULT_PARAMS)

    expect(capturedPrompts[0]).toContain('unit')
    expect(capturedPrompts[0]).toContain('integration')
  })

  it('includes coverage notes in the prompt when test plan exists', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    const coverageNotes = 'AC1 covered by runTestPlan.test.ts. AC2 verified by decision-store.test.ts.'

    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'decision-1',
        pipeline_run_id: 'run-123',
        phase: 'implementation',
        category: 'test-plan',
        key: STORY_KEY,
        value: JSON.stringify({
          test_files: ['src/foo.test.ts'],
          test_categories: ['unit'],
          coverage_notes: coverageNotes,
        }),
        rationale: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])

    await runDevStory(deps, DEFAULT_PARAMS)

    expect(capturedPrompts[0]).toContain(coverageNotes)
  })

  it('does NOT inject test plan for a different storyKey', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    // Decision exists for a different story key
    mockGetDecisionsByCategory.mockReturnValue([
      {
        id: 'decision-1',
        pipeline_run_id: 'run-123',
        phase: 'implementation',
        category: 'test-plan',
        key: 'different-story-key',
        value: JSON.stringify({
          test_files: ['src/wrong-story.test.ts'],
          test_categories: ['unit'],
          coverage_notes: 'Notes for a different story',
        }),
        rationale: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ])

    await runDevStory(deps, DEFAULT_PARAMS)

    expect(capturedPrompts[0]).not.toContain('## Test Plan')
    expect(capturedPrompts[0]).not.toContain('src/wrong-story.test.ts')
  })
})

// ---------------------------------------------------------------------------
// AC4: Dev-story graceful fallback when no test plan exists
// ---------------------------------------------------------------------------

describe('AC4: Dev-story graceful fallback when no test plan exists', () => {
  it('does NOT include ## Test Plan section when no test plan decision exists', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    // Default: empty array from mock
    mockGetDecisionsByCategory.mockReturnValue([])

    await runDevStory(deps, DEFAULT_PARAMS)

    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0]).not.toContain('## Test Plan')
  })

  it('does not throw when getDecisionsByCategory returns empty array', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    mockGetDecisionsByCategory.mockReturnValue([])

    const result = await runDevStory(deps, DEFAULT_PARAMS)

    expect(result.result).toBe('success')
  })

  it('does not throw when getDecisionsByCategory throws', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    mockGetDecisionsByCategory.mockImplementation(() => {
      throw new Error('Database error')
    })

    // Should not throw — graceful fallback
    const result = await runDevStory(deps, DEFAULT_PARAMS)

    expect(result.result).toBe('success')
    expect(capturedPrompts[0]).not.toContain('## Test Plan')
  })

  it('still injects default Vitest patterns when no test plan is present', async () => {
    const capturedPrompts: string[] = []
    const deps = createMockDeps(capturedPrompts)

    // No decisions of any kind
    mockGetDecisionsByPhase.mockReturnValue([])
    mockGetDecisionsByCategory.mockReturnValue([])

    await runDevStory(deps, DEFAULT_PARAMS)

    // Default patterns should still appear
    expect(capturedPrompts[0]).toContain('Vitest')
  })
})
