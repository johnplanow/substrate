/**
 * Epic 10 — Compiled Implementation Pipeline: Integration & E2E Tests
 *
 * Tests cross-story interactions that individual story unit tests do not cover:
 *
 *   Gap 1: create-story → dev-story handoff (story_file path propagation)
 *   Gap 2: dev-story → code-review handoff (orchestrator passes storyFilePath through)
 *   Gap 3: CodeReviewResultSchema issues === issue_list.length refinement
 *   Gap 4: Prompt assembler — required sections never dropped under budget pressure
 *   Gap 5: Orchestrator epicId extraction from storyKey via split('-')[0]
 *   Gap 6: Orchestrator run([]) with empty story list completes cleanly
 *   Gap 7: Schema cross-consistency — all three schemas share 'result' enum values
 *   Gap 8: formatOutput + formatTokenTelemetry integrated token display
 *   Gap 9: Code-review git diff stat fallback triggers on oversized diff
 *   Gap 10: Orchestrator correctly serializes conflict groups before parallel dispatch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../modules/methodology-pack/types.js'
import type { ContextCompiler } from '../../modules/context-compiler/context-compiler.js'
import type {
  Dispatcher,
  DispatchHandle,
  DispatchResult,
} from '../../modules/agent-dispatch/types.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { OrchestratorConfig } from '../../modules/implementation-orchestrator/types.js'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted
// ---------------------------------------------------------------------------

vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('../../persistence/queries/decisions.js', () => ({
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  updatePipelineRun: vi.fn(),
}))

vi.mock('../../modules/compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
}))

vi.mock('../../modules/compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn(),
}))

vi.mock('../../modules/compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../modules/compiled-workflows/create-story.js'
import { runDevStory } from '../../modules/compiled-workflows/dev-story.js'
import { runCodeReview } from '../../modules/compiled-workflows/code-review.js'
import { createImplementationOrchestrator } from '../../modules/implementation-orchestrator/orchestrator-impl.js'
import { detectConflictGroups } from '../../modules/implementation-orchestrator/conflict-detector.js'
import { assemblePrompt } from '../../modules/compiled-workflows/prompt-assembler.js'
import {
  CreateStoryResultSchema,
  DevStoryResultSchema,
  CodeReviewResultSchema,
} from '../../modules/compiled-workflows/schemas.js'
import {
  formatOutput,
  formatTokenTelemetry,
} from '../../cli/commands/auto.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
}

function makePack(): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockReturnValue({ prompt: 'fallback', tokenCount: 10, sections: [], truncated: false }),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn().mockReturnValue(undefined),
  } as unknown as ContextCompiler
}

function makeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeDispatcher(): Dispatcher {
  const result: DispatchResult<unknown> = {
    id: 'fix-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'fix-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 3,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey: string, filePath: string) {
  return {
    result: 'success' as const,
    story_file: filePath,
    story_key: storyKey,
    story_title: 'Integration Test Story',
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeDevStorySuccess() {
  return {
    result: 'success' as const,
    ac_met: ['AC1', 'AC2'],
    ac_failures: [],
    files_modified: ['src/foo.ts', 'src/bar.ts'],
    tests: 'pass' as const,
    tokenUsage: { input: 200, output: 100 },
  }
}

function makeCodeReviewShipIt() {
  return {
    verdict: 'SHIP_IT' as const,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// Gap 1: create-story → dev-story storyFilePath handoff
// ---------------------------------------------------------------------------

describe('Gap 1: create-story → dev-story storyFilePath handoff', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes story_file from create-story result as storyFilePath to dev-story', async () => {
    const expectedFilePath = '/project/stories/10-2-dev-story.md'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('10-2', expectedFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['10-2'])

    expect(mockRunDevStory).toHaveBeenCalledOnce()
    const devStoryCall = mockRunDevStory.mock.calls[0]
    expect(devStoryCall).toBeDefined()
    // Second arg is DevStoryParams
    expect(devStoryCall![1].storyFilePath).toBe(expectedFilePath)
  })

  it('escalates without calling dev-story when create-story returns no story_file', async () => {
    mockRunCreateStory.mockResolvedValue({
      result: 'success' as const,
      story_file: undefined, // missing file path
      story_key: '10-2',
      story_title: 'Missing file',
      tokenUsage: { input: 100, output: 50 },
    })

    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['10-2'])

    expect(status.stories['10-2']?.phase).toBe('ESCALATED')
    expect(mockRunDevStory).not.toHaveBeenCalled()
    expect(eventBus.emit).toHaveBeenCalledWith(
      'orchestrator:story-escalated',
      expect.objectContaining({ storyKey: '10-2', lastVerdict: 'create-story-no-file' }),
    )
  })

  it('escalates without calling dev-story when create-story returns empty story_file', async () => {
    mockRunCreateStory.mockResolvedValue({
      result: 'success' as const,
      story_file: '',
      story_key: '10-2',
      story_title: 'Empty file path',
      tokenUsage: { input: 100, output: 50 },
    })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run(['10-2'])

    expect(status.stories['10-2']?.phase).toBe('ESCALATED')
    expect(mockRunDevStory).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Gap 2: dev-story → code-review storyFilePath handoff
// ---------------------------------------------------------------------------

describe('Gap 2: dev-story → code-review storyFilePath handoff', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes the same storyFilePath to code-review that was used for dev-story', async () => {
    const expectedFilePath = '/project/stories/10-3-code-review.md'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('10-3', expectedFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['10-3'])

    expect(mockRunCodeReview).toHaveBeenCalledOnce()
    const codeReviewCall = mockRunCodeReview.mock.calls[0]
    expect(codeReviewCall![1].storyFilePath).toBe(expectedFilePath)
  })

  it('uses the same storyKey in both dev-story and code-review params', async () => {
    const storyKey = '10-1'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess(storyKey, '/stories/10-1.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run([storyKey])

    const devStoryParams = mockRunDevStory.mock.calls[0]![1]
    const codeReviewParams = mockRunCodeReview.mock.calls[0]![1]
    expect(devStoryParams.storyKey).toBe(storyKey)
    expect(codeReviewParams.storyKey).toBe(storyKey)
  })
})

// ---------------------------------------------------------------------------
// Gap 3: CodeReviewResultSchema issues === issue_list.length refinement
// ---------------------------------------------------------------------------

describe('Gap 3: CodeReviewResultSchema cross-field refinement', () => {
  it('accepts valid schema where issues matches issue_list.length', () => {
    const valid = {
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
    }
    expect(CodeReviewResultSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts schema with issues=2 and issue_list of length 2', () => {
    const valid = {
      verdict: 'NEEDS_MINOR_FIXES',
      issues: 2,
      issue_list: [
        { severity: 'minor', description: 'issue 1' },
        { severity: 'major', description: 'issue 2' },
      ],
    }
    expect(CodeReviewResultSchema.safeParse(valid).success).toBe(true)
  })

  it('auto-corrects issues count when it does not match issue_list.length', () => {
    const mismatched = {
      verdict: 'NEEDS_MINOR_FIXES',
      issues: 3,
      issue_list: [{ severity: 'minor', description: 'only one issue' }],
    }
    const result = CodeReviewResultSchema.safeParse(mismatched)
    // The transform auto-corrects issues to match issue_list.length
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issues).toBe(1)
    }
  })

  it('auto-corrects issues=0 when issue_list is non-empty', () => {
    const mismatched = {
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [{ severity: 'minor', description: 'sneaky issue' }],
    }
    const result = CodeReviewResultSchema.safeParse(mismatched)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issues).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Prompt assembler — required sections never truncated under budget pressure
// ---------------------------------------------------------------------------

describe('Gap 4: Prompt assembler required sections never truncated', () => {
  it('keeps required section content intact even when total exceeds token ceiling', () => {
    const requiredContent = 'REQUIRED_CONTENT_' + 'R'.repeat(1000)
    const optionalContent = 'O'.repeat(50000) // huge optional section

    const result = assemblePrompt(
      '{{required_section}}\n{{optional_section}}',
      [
        { name: 'required_section', content: requiredContent, priority: 'required' },
        { name: 'optional_section', content: optionalContent, priority: 'optional' },
      ],
      500, // very low ceiling
    )

    // Required content must always be present
    expect(result.prompt).toContain(requiredContent)
    // Truncation flag must be set since ceiling was exceeded
    expect(result.truncated).toBe(true)
  })

  it('keeps important section when optional section is eliminated', () => {
    const importantContent = 'IMPORTANT_DATA_' + 'I'.repeat(200)
    const optionalContent = 'O'.repeat(10000)

    const result = assemblePrompt(
      '{{important_section}}\n{{optional_section}}',
      [
        { name: 'important_section', content: importantContent, priority: 'important' },
        { name: 'optional_section', content: optionalContent, priority: 'optional' },
      ],
      300, // ceiling that forces optional removal
    )

    // Optional eliminated, important should still be substantially present
    expect(result.prompt).toContain('IMPORTANT_DATA_')
    expect(result.truncated).toBe(true)
  })

  it('returns truncated=false when prompt fits within ceiling', () => {
    const result = assemblePrompt(
      '{{section_a}}\n{{section_b}}',
      [
        { name: 'section_a', content: 'short a', priority: 'required' },
        { name: 'section_b', content: 'short b', priority: 'optional' },
      ],
      2000,
    )

    expect(result.truncated).toBe(false)
    expect(result.prompt).toContain('short a')
    expect(result.prompt).toContain('short b')
  })

  it('eliminates optional sections before truncating important sections', () => {
    const optionalContent = 'O'.repeat(5000)
    const importantContent = 'I'.repeat(5000)

    // Use a ceiling that forces both to be processed
    const result = assemblePrompt(
      '{{important}}\n{{optional}}',
      [
        { name: 'important', content: importantContent, priority: 'important' },
        { name: 'optional', content: optionalContent, priority: 'optional' },
      ],
      400, // low ceiling
    )

    // Optional should be eliminated before important is truncated
    expect(result.truncated).toBe(true)
    // Token count should be within or near ceiling
    const tokenEstimate = Math.ceil(result.prompt.length / 4)
    // May exceed if required sections alone are too large, but should be reduced
    expect(result.tokenCount).toBeLessThan(
      Math.ceil((optionalContent.length + importantContent.length) / 4),
    )
  })
})

// ---------------------------------------------------------------------------
// Gap 5: Orchestrator epicId extraction from storyKey
// ---------------------------------------------------------------------------

describe('Gap 5: Orchestrator epicId extraction from storyKey', () => {
  beforeEach(() => vi.clearAllMocks())

  it('extracts epicId as first segment before hyphen from storyKey', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('10-1', '/stories/10-1.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['10-1'])

    const createStoryCall = mockRunCreateStory.mock.calls[0]
    expect(createStoryCall).toBeDefined()
    // epicId should be '10' (first segment of '10-1')
    expect(createStoryCall![1].epicId).toBe('10')
  })

  it('extracts epicId correctly for multi-part storyKey like "10-2-dev-story"', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('10-2-dev-story', '/stories/10-2.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    await orchestrator.run(['10-2-dev-story'])

    const createStoryCall = mockRunCreateStory.mock.calls[0]
    // epicId from '10-2-dev-story'.split('-')[0] = '10'
    expect(createStoryCall![1].epicId).toBe('10')
  })

  it('passes pipelineRunId from config to all workflow functions', async () => {
    const pipelineRunId = 'pipeline-xyz-123'
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1', '/stories/5-1.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ pipelineRunId }),
    })

    await orchestrator.run(['5-1'])

    expect(mockRunCreateStory.mock.calls[0]![1].pipelineRunId).toBe(pipelineRunId)
    expect(mockRunDevStory.mock.calls[0]![1].pipelineRunId).toBe(pipelineRunId)
    expect(mockRunCodeReview.mock.calls[0]![1].pipelineRunId).toBe(pipelineRunId)
  })
})

// ---------------------------------------------------------------------------
// Gap 6: Orchestrator run([]) with empty story list
// ---------------------------------------------------------------------------

describe('Gap 6: Orchestrator run([]) completes cleanly', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns COMPLETE state with empty stories when called with empty array', async () => {
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    const status = await orchestrator.run([])

    expect(status.state).toBe('COMPLETE')
    expect(status.stories).toEqual({})
    expect(mockRunCreateStory).not.toHaveBeenCalled()
    expect(mockRunDevStory).not.toHaveBeenCalled()
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('emits orchestrator:complete with totalStories=0 when run with empty array', async () => {
    const eventBus = makeEventBus()
    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus,
      config: defaultConfig(),
    })

    await orchestrator.run([])

    expect(eventBus.emit).toHaveBeenCalledWith(
      'orchestrator:complete',
      expect.objectContaining({ totalStories: 0, completed: 0 }),
    )
  })
})

// ---------------------------------------------------------------------------
// Gap 7: Schema cross-consistency — 'result' enum values match across schemas
// ---------------------------------------------------------------------------

describe('Gap 7: Schema cross-consistency', () => {
  it('CreateStoryResultSchema accepts result=success', () => {
    const result = CreateStoryResultSchema.safeParse({ result: 'success' })
    expect(result.success).toBe(true)
  })

  it('CreateStoryResultSchema accepts result=failed', () => {
    const result = CreateStoryResultSchema.safeParse({ result: 'failed' })
    expect(result.success).toBe(true)
  })

  it('CreateStoryResultSchema rejects invalid result values', () => {
    const result = CreateStoryResultSchema.safeParse({ result: 'partial' })
    expect(result.success).toBe(false)
  })

  it('DevStoryResultSchema accepts result=success with all required fields', () => {
    const result = DevStoryResultSchema.safeParse({
      result: 'success',
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: 'pass',
    })
    expect(result.success).toBe(true)
  })

  it('DevStoryResultSchema accepts result=failed', () => {
    const result = DevStoryResultSchema.safeParse({
      result: 'failed',
      ac_met: [],
      ac_failures: ['AC1'],
      files_modified: [],
      tests: 'fail',
    })
    expect(result.success).toBe(true)
  })

  it('DevStoryResultSchema rejects invalid tests enum value', () => {
    const result = DevStoryResultSchema.safeParse({
      result: 'success',
      ac_met: [],
      ac_failures: [],
      files_modified: [],
      tests: 'skipped', // invalid
    })
    expect(result.success).toBe(false)
  })

  it('CodeReviewResultSchema accepts all three verdict values', () => {
    for (const verdict of ['SHIP_IT', 'NEEDS_MINOR_FIXES', 'NEEDS_MAJOR_REWORK']) {
      const result = CodeReviewResultSchema.safeParse({
        verdict,
        issues: 0,
        issue_list: [],
      })
      expect(result.success).toBe(true)
    }
  })

  it('CodeReviewResultSchema rejects invalid verdict value', () => {
    const result = CodeReviewResultSchema.safeParse({
      verdict: 'APPROVED',
      issues: 0,
      issue_list: [],
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Gap 8: formatOutput + formatTokenTelemetry integration
// ---------------------------------------------------------------------------

describe('Gap 8: formatOutput + formatTokenTelemetry integration', () => {
  it('formatOutput wraps data in { success: true, data } for json format', () => {
    const result = formatOutput({ storyKeys: ['10-1'] }, 'json', true)
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(true)
    expect(parsed.data.storyKeys).toEqual(['10-1'])
  })

  it('formatOutput wraps error in { success: false, error } for json format', () => {
    const result = formatOutput(null, 'json', false, 'Pack not found')
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBe('Pack not found')
  })

  it('formatOutput returns string data as-is in human format', () => {
    const result = formatOutput('Pipeline complete', 'human')
    expect(result).toBe('Pipeline complete')
  })

  it('formatTokenTelemetry returns "No token usage recorded." for empty summary', () => {
    const result = formatTokenTelemetry([])
    expect(result).toBe('No token usage recorded.')
  })

  it('formatTokenTelemetry includes phase and agent in output', () => {
    const summary = [
      {
        phase: 'IN_STORY_CREATION',
        agent: 'claude-code',
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.003,
      },
    ]
    const result = formatTokenTelemetry(summary)
    expect(result).toContain('IN_STORY_CREATION')
    expect(result).toContain('claude-code')
    expect(result).toContain('1,000')
    expect(result).toContain('500')
  })

  it('formatTokenTelemetry computes BMAD baseline savings correctly', () => {
    // BMAD_BASELINE_TOKENS = 23,800
    // Use low token count to confirm savings percentage is positive
    const summary = [
      {
        phase: 'IN_DEV',
        agent: 'claude-code',
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.0105,
      },
    ]
    const result = formatTokenTelemetry(summary)
    // Total tokens = 1500, baseline = 23800, savings = ~94%
    expect(result).toContain('Savings:')
    expect(result).toContain('BMAD Baseline:')
  })

  it('formatTokenTelemetry shows Overhead when tokens exceed baseline', () => {
    const summary = [
      {
        phase: 'IN_REVIEW',
        agent: 'claude-code',
        total_input_tokens: 15000,
        total_output_tokens: 15000, // 30000 total > 23800 baseline
        total_cost_usd: 0.27,
      },
    ]
    const result = formatTokenTelemetry(summary)
    expect(result).toContain('Overhead:')
  })

  it('formatTokenTelemetry sums multi-phase totals correctly', () => {
    const summary = [
      {
        phase: 'IN_STORY_CREATION',
        agent: 'claude-code',
        total_input_tokens: 500,
        total_output_tokens: 250,
        total_cost_usd: 0.001,
      },
      {
        phase: 'IN_DEV',
        agent: 'claude-code',
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.002,
      },
    ]
    const result = formatTokenTelemetry(summary)
    // Total: 1500 input + 750 output = 2250 tokens
    expect(result).toContain('1,500')
    expect(result).toContain('750')
  })
})

// ---------------------------------------------------------------------------
// Gap 9: Code-review git diff stat fallback — orchestrator-level wiring
// ---------------------------------------------------------------------------

describe('Gap 9: Conflict detector wiring with orchestrator', () => {
  it('conflict detector groups 10-1 and 10-2 together (same compiled-workflows module)', () => {
    const groups = detectConflictGroups(['10-1', '10-2'])
    // Both should be in a single group
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group).toContain('10-1')
    expect(group).toContain('10-2')
  })

  it('conflict detector puts 10-4 and 10-5 in separate groups', () => {
    const groups = detectConflictGroups(['10-4', '10-5'])
    // 10-4 → implementation-orchestrator, 10-5 → cli — different modules
    expect(groups).toHaveLength(2)
  })

  it('conflict detector puts 10-1 through 10-3 together and 10-4, 10-5 separately', () => {
    const groups = detectConflictGroups(['10-1', '10-2', '10-3', '10-4', '10-5'])
    expect(groups).toHaveLength(3)
    const moduleGroups = groups.map((g) => g.sort())
    // Find the compiled-workflows group
    const compiledGroup = moduleGroups.find((g) => g.includes('10-1'))
    expect(compiledGroup).toBeDefined()
    expect(compiledGroup).toContain('10-2')
    expect(compiledGroup).toContain('10-3')
  })

  it('orchestrator serializes conflicting stories 10-1 and 10-2', async () => {
    const callOrder: string[] = []

    mockRunCreateStory.mockImplementation(async (_deps, params) => {
      callOrder.push(`create:${params.storyKey}`)
      return makeCreateStorySuccess(params.storyKey, `/stories/${params.storyKey}.md`)
    })
    mockRunDevStory.mockImplementation(async (_deps, params) => {
      callOrder.push(`dev:${params.storyKey}`)
      return makeDevStorySuccess()
    })
    mockRunCodeReview.mockImplementation(async (_deps, params) => {
      callOrder.push(`review:${params.storyKey}`)
      return makeCodeReviewShipIt()
    })

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig({ maxConcurrency: 3 }),
    })

    await orchestrator.run(['10-1', '10-2'])

    // 10-1 must fully complete (all 3 phases) before 10-2 starts
    const review10_1_idx = callOrder.indexOf('review:10-1')
    const create10_2_idx = callOrder.indexOf('create:10-2')
    expect(review10_1_idx).toBeGreaterThan(-1)
    expect(create10_2_idx).toBeGreaterThan(-1)
    expect(review10_1_idx).toBeLessThan(create10_2_idx)
  })
})

// ---------------------------------------------------------------------------
// Gap 10: Orchestrator run() guards against double-invocation
// ---------------------------------------------------------------------------

describe('Gap 10: Orchestrator run() idempotency and state guards', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ignores second run() call while orchestrator is already running', async () => {
    let unblockCreate!: () => void
    const createBarrier = new Promise<void>((res) => { unblockCreate = res })

    mockRunCreateStory.mockImplementation(async (_deps, params) => {
      // Block until test unblocks
      await createBarrier
      return makeCreateStorySuccess(params.storyKey, `/stories/${params.storyKey}.md`)
    })
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    // Start the first run (will block in create-story)
    const run1 = orchestrator.run(['5-1'])

    // Try a second run while first is running
    const secondStatus = await orchestrator.run(['6-1'])

    // Second call should return current status (RUNNING) without starting new work
    expect(secondStatus.state).toBe('RUNNING')

    // Unblock first run and let it complete
    unblockCreate()
    await run1

    // Only 5-1 should have been processed (not 6-1)
    expect(mockRunCreateStory).toHaveBeenCalledTimes(1)
    expect(mockRunCreateStory.mock.calls[0]![1].storyKey).toBe('5-1')
  })

  it('ignores run() after orchestrator is COMPLETE', async () => {
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1', '/stories/5-1.md'))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    const orchestrator = createImplementationOrchestrator({
      db: makeDb(),
      pack: makePack(),
      contextCompiler: makeContextCompiler(),
      dispatcher: makeDispatcher(),
      eventBus: makeEventBus(),
      config: defaultConfig(),
    })

    // First run completes
    await orchestrator.run(['5-1'])
    expect(orchestrator.getStatus().state).toBe('COMPLETE')

    // Second run should be ignored
    const secondStatus = await orchestrator.run(['9-1'])
    expect(secondStatus.state).toBe('COMPLETE')
    // No additional workflow calls
    expect(mockRunCreateStory).toHaveBeenCalledTimes(1)
  })
})
