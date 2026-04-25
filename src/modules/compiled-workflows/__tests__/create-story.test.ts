/**
 * Unit tests for runCreateStory() — compiled create-story workflow.
 *
 * Covers AC1 (pack prompt retrieval), AC2 (context injection), AC3 (token budget),
 * AC4 (dispatch and output parsing), AC5 (failure/timeout), AC6 (schema validation),
 * AC7 (token usage), AC8 (essential logic preservation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { RuntimeProbeListSchema, parseRuntimeProbes } from '@substrate-ai/sdlc'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { WorkflowDeps, CreateStoryParams } from '../types.js'
import { CreateStoryResultSchema } from '../schemas.js'
import { runCreateStory, extractStorySection, hashSourceAcSection } from '../create-story.js'
import { load as yamlLoad } from 'js-yaml'

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
  getDecisionsByPhase: vi.fn(),
  getDecisionsByPhaseForRun: vi.fn().mockResolvedValue([]),
}))

// ---------------------------------------------------------------------------
// Mock node:fs for file-based fallback tests
// ---------------------------------------------------------------------------

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  }
})

import { existsSync, readFileSync } from 'node:fs'
const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { getDecisionsByPhase } from '../../../persistence/queries/decisions.js'
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)

/**
 * Build a mock Decision object with required fields
 */
function makeDecision(phase: string, category: string, key: string, value: string) {
  return {
    id: crypto.randomUUID(),
    pipeline_run_id: null,
    phase,
    category,
    key,
    value,
    rationale: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build a successful DispatchResult for CreateStoryResultSchema output
 */
function makeSuccessDispatchResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    id: 'dispatch-1',
    status: 'completed',
    exitCode: 0,
    output: 'result: success\nstory_file: /path/to/story.md\nstory_key: 10-2-dev-story\nstory_title: Story Title\n',
    parsed: {
      result: 'success',
      story_file: '/path/to/story.md',
      story_key: '10-2-dev-story',
      story_title: 'Story Title',
    },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 500, output: 100 },
    ...overrides,
  }
}

/**
 * Build a mock dispatcher that returns the given result
 */
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

/**
 * Build a mock MethodologyPack
 */
function makePack(template: string = 'Epic: {{epic_shard}}\nPrev: {{prev_dev_notes}}\nArch: {{arch_constraints}}\nTemplate: {{story_template}}'): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      phases: [],
      prompts: { 'create-story': 'prompts/create-story.md' },
      constraints: {},
      templates: { story: 'templates/story.md' },
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(template),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue('# Story Template\n\n## Story\n\n## Acceptance Criteria\n\n## Tasks / Subtasks\n\n## Dev Notes\n\n## Dev Agent Record'),
  }
}

/**
 * Build a mock ContextCompiler
 */
function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockReturnValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn().mockReturnValue(undefined),
  }
}

/**
 * Build a mock SQLite database
 */
function makeDb(): DatabaseAdapter {
  return {
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn().mockImplementation((fn: (adapter: DatabaseAdapter) => Promise<unknown>) => fn({} as DatabaseAdapter)),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DatabaseAdapter
}

/**
 * Build WorkflowDeps with defaults
 */
function makeDeps(overrides: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    db: makeDb(),
    pack: makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher: makeDispatcher(makeSuccessDispatchResult()),
    ...overrides,
  }
}

const defaultParams: CreateStoryParams = {
  epicId: 'epic-10',
  storyKey: '10-2-dev-story',
  pipelineRunId: 'run-123',
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // Default: epic shard found, no prev notes, no arch constraints
  mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
    if (phase === 'implementation') {
      return [makeDecision('implementation', 'epic-shard', 'epic-10', 'Epic 10: Compiled Workflows\n\nDescription: Token-efficient workflows.')]
    }
    if (phase === 'solutioning') {
      return [makeDecision('solutioning', 'architecture', 'ADR-001', 'Modular monolith')]
    }
    return []
  })
})

// ---------------------------------------------------------------------------
// AC1: Pack prompt retrieval
// ---------------------------------------------------------------------------

describe('AC1: Pack Prompt Retrieval', () => {
  it('calls pack.getPrompt("create-story") to retrieve the template', async () => {
    const pack = makePack()
    const deps = makeDeps({ pack })

    await runCreateStory(deps, defaultParams)

    expect(pack.getPrompt).toHaveBeenCalledWith('create-story')
  })

  it('returns failure result when getPrompt throws', async () => {
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Template not found'))

    const deps = makeDeps({ pack })
    const result = await runCreateStory(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('Template not found')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('template contains expected BMAD placeholders', async () => {
    const capturedPrompts: string[] = []
    const template = 'Epic: {{epic_shard}}\nPrev: {{prev_dev_notes}}\nArch: {{arch_constraints}}\nTemplate: {{story_template}}'
    const pack = makePack(template)

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps({ pack, dispatcher })
    await runCreateStory(deps, defaultParams)

    expect(capturedPrompts).toHaveLength(1)
    // The original template had these placeholders — they should be replaced
    expect(capturedPrompts[0]).not.toContain('{{epic_shard}}')
    expect(capturedPrompts[0]).not.toContain('{{prev_dev_notes}}')
    expect(capturedPrompts[0]).not.toContain('{{arch_constraints}}')
  })
})

// ---------------------------------------------------------------------------
// AC2: Context Injection from Decision Store
// ---------------------------------------------------------------------------

describe('AC2: Context Injection from Decision Store', () => {
  it('injects epic shard from decisions (phase=implementation, category=epic-shard, key=epicId)', async () => {
    const capturedPrompts: string[] = []
    const epicShard = 'EPIC 10 CONTENT - should appear in prompt'

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', 'epic-10', epicShard)]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(capturedPrompts[0]).toContain(epicShard)
  })

  it('injects previous dev notes from most recent completed story in same epic', async () => {
    const capturedPrompts: string[] = []
    const prevNotes = 'PREVIOUS DEV NOTES - should be injected'

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [
          makeDecision('implementation', 'epic-shard', 'epic-10', 'Epic content'),
          makeDecision('implementation', 'prev-dev-notes', 'epic-10-10-1', prevNotes),
        ]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(capturedPrompts[0]).toContain(prevNotes)
  })

  it('injects architecture constraints from decisions (phase=solutioning, category=architecture)', async () => {
    const capturedPrompts: string[] = []
    const archContent = 'ADR-001: Modular Monolith - should appear in prompt'

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', 'epic-10', 'Epic content')]
      }
      if (phase === 'solutioning') {
        return [makeDecision('solutioning', 'architecture', 'ADR-001', archContent)]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(capturedPrompts[0]).toContain(archContent)
  })

  it('queries decision store twice: implementation phase and solutioning phase', async () => {
    await runCreateStory(makeDeps(), defaultParams)

    // Should query both phases
    expect(mockGetDecisionsByPhase).toHaveBeenCalledWith(expect.anything(), 'implementation')
    expect(mockGetDecisionsByPhase).toHaveBeenCalledWith(expect.anything(), 'solutioning')
  })
})

// ---------------------------------------------------------------------------
// AC3: Token Budget Enforcement
// ---------------------------------------------------------------------------

describe('AC3: Token Budget Enforcement', () => {
  it('assembles prompt that fits within 50000-token ceiling', async () => {
    const capturedRequests: Array<{ prompt: string }> = []

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedRequests.push({ prompt: req.prompt })
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(capturedRequests).toHaveLength(1)
    const prompt = capturedRequests[0].prompt
    // Token estimate: chars / 4
    const estimatedTokens = Math.ceil(prompt.length / 4)
    expect(estimatedTokens).toBeLessThanOrEqual(50_000)
  })

  it('truncates oversized context to fit within 50000-token ceiling', async () => {
    // Inject very large epic shard and arch constraints
    const hugeContent = 'X'.repeat(400_000) // ~100,000 tokens

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'prev-dev-notes', 'epic-10-10-1', hugeContent)]
      }
      if (phase === 'solutioning') {
        return [makeDecision('solutioning', 'architecture', 'ADR-001', hugeContent)]
      }
      return []
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    const prompt = capturedPrompts[0]
    const tokenEstimate = Math.ceil(prompt.length / 4)
    expect(tokenEstimate).toBeLessThanOrEqual(50_000 + 50) // Allow small rounding
  })
})

// ---------------------------------------------------------------------------
// AC4: Dispatch and Output Parsing
// ---------------------------------------------------------------------------

describe('AC4: Dispatch and Output Parsing', () => {
  it('dispatches with taskType="create-story"', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'create-story' })
    )
  })

  it('dispatches with agent="claude-code"', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude-code' })
    )
  })

  it('dispatches with CreateStoryResultSchema as outputSchema', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ outputSchema: CreateStoryResultSchema })
    )
  })

  it('returns parsed result with story_file, story_key, story_title on success', async () => {
    const result = await runCreateStory(makeDeps(), defaultParams)

    expect(result.result).toBe('success')
    expect(result.story_file).toBe('/path/to/story.md')
    expect(result.story_key).toBe('10-2-dev-story')
    expect(result.story_title).toBe('Story Title')
  })
})

// ---------------------------------------------------------------------------
// AC5: Failure and Timeout Handling
// ---------------------------------------------------------------------------

describe('AC5: Failure and Timeout Handling', () => {
  it('returns { result: "failed", error } when dispatch status is "failed"', async () => {
    const failedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'failed',
      exitCode: 1,
      output: 'Error: agent crashed\nstderr: fatal error',
      parsed: null,
      parseError: 'Exit code: 1',
      durationMs: 500,
      tokenEstimate: { input: 200, output: 0 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(failedResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toBeDefined()
    expect(result.error).toContain('failed')
    expect(result.story_file).toBeUndefined()
    expect(result.story_key).toBeUndefined()
  })

  it('error message includes dispatch status "failed" and exit code', async () => {
    const failedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'failed',
      exitCode: 2,
      output: 'fatal: agent error',
      parsed: null,
      parseError: 'Exit code: 2',
      durationMs: 100,
      tokenEstimate: { input: 100, output: 0 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(failedResult) }),
      defaultParams
    )

    expect(result.error).toContain('failed')
  })

  it('returns { result: "failed", error } when dispatch status is "timeout"', async () => {
    const timeoutResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'timeout',
      exitCode: -1,
      output: '',
      parsed: null,
      parseError: 'Dispatch timed out after 180000ms',
      durationMs: 180_000,
      tokenEstimate: { input: 200, output: 0 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(timeoutResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toContain('timeout')
    expect(result.story_file).toBeUndefined()
  })

  it('no partial or invalid story data returned on failure', async () => {
    const failedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'failed',
      exitCode: 1,
      output: 'story_file: /bad/partial/path.md',
      parsed: null,
      parseError: null,
      durationMs: 100,
      tokenEstimate: { input: 100, output: 0 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(failedResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    // Should not return partial story data
    expect(result.story_file).toBeUndefined()
    expect(result.story_key).toBeUndefined()
    expect(result.story_title).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC6: Output Schema Validation
// ---------------------------------------------------------------------------

describe('AC6: Output Schema Validation', () => {
  it('returns typed CreateStoryResult on valid parsed output', async () => {
    const result = await runCreateStory(makeDeps(), defaultParams)

    expect(result.result).toBe('success')
    expect(typeof result.story_file).toBe('string')
    expect(typeof result.story_key).toBe('string')
    expect(typeof result.story_title).toBe('string')
  })

  it('returns { result: "failed", error: "schema_validation_failed" } when parsed YAML is null', async () => {
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

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(nullParsedResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toBe('schema_validation_failed')
    expect(result.details).toBeDefined()
  })

  it('returns { result: "failed", error: "schema_validation_failed", details } when YAML schema validation fails', async () => {
    const invalidParsedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'completed',
      exitCode: 0,
      output: 'result: unknown_value\n',
      parsed: {
        result: 'unknown_value', // Not 'success' | 'failed'
        // Missing required fields
      },
      parseError: null,
      durationMs: 500,
      tokenEstimate: { input: 200, output: 50 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(invalidParsedResult) }),
      defaultParams
    )

    expect(result.result).toBe('failed')
    expect(result.error).toBe('schema_validation_failed')
    expect(result.details).toBeDefined()
    expect(typeof result.details).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// AC7: Token Usage Reporting
// ---------------------------------------------------------------------------

describe('AC7: Token Usage Reporting', () => {
  it('returns tokenUsage with input and output from dispatch result', async () => {
    const result = await runCreateStory(makeDeps(), defaultParams)

    expect(result.tokenUsage).toBeDefined()
    expect(typeof result.tokenUsage.input).toBe('number')
    expect(typeof result.tokenUsage.output).toBe('number')
  })

  it('returns tokenUsage from dispatch tokenEstimate on success', async () => {
    const dispatchResult = makeSuccessDispatchResult({
      tokenEstimate: { input: 1234, output: 567 },
    })

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(dispatchResult) }),
      defaultParams
    )

    expect(result.tokenUsage.input).toBe(1234)
    expect(result.tokenUsage.output).toBe(567)
  })

  it('returns tokenUsage from dispatch tokenEstimate on failure', async () => {
    const failedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'failed',
      exitCode: 1,
      output: 'error',
      parsed: null,
      parseError: 'Exit code: 1',
      durationMs: 100,
      tokenEstimate: { input: 999, output: 0 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(failedResult) }),
      defaultParams
    )

    expect(result.tokenUsage.input).toBe(999)
    expect(result.tokenUsage.output).toBe(0)
  })

  it('returns tokenUsage even on timeout', async () => {
    const timeoutResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'timeout',
      exitCode: -1,
      output: '',
      parsed: null,
      parseError: 'timed out',
      durationMs: 180_000,
      tokenEstimate: { input: 450, output: 0 },
    }

    const result = await runCreateStory(
      makeDeps({ dispatcher: makeDispatcher(timeoutResult) }),
      defaultParams
    )

    expect(result.tokenUsage.input).toBe(450)
    expect(result.tokenUsage.output).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC8: Essential Logic Preservation
// ---------------------------------------------------------------------------

describe('AC8: Essential Logic Preservation', () => {
  it('template contains placeholder for epic_shard', async () => {
    const capturedTemplates: string[] = []
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockImplementation(async () => {
      const template = '{{epic_shard}} {{prev_dev_notes}} {{arch_constraints}} {{story_template}}'
      capturedTemplates.push(template)
      return template
    })

    await runCreateStory(makeDeps({ pack }), defaultParams)

    // The template included the placeholder (captured before substitution)
    expect(capturedTemplates[0]).toContain('{{epic_shard}}')
  })

  it('template contains placeholder for prev_dev_notes', async () => {
    const pack = makePack('{{epic_shard}}\n{{prev_dev_notes}}\n{{arch_constraints}}\n{{story_template}}')
    const templateContent = await pack.getPrompt('create-story')

    expect(templateContent).toContain('{{prev_dev_notes}}')
  })

  it('template contains placeholder for arch_constraints', async () => {
    const pack = makePack('{{epic_shard}}\n{{prev_dev_notes}}\n{{arch_constraints}}\n{{story_template}}')
    const templateContent = await pack.getPrompt('create-story')

    expect(templateContent).toContain('{{arch_constraints}}')
  })

  it('template contains placeholder for story_template', async () => {
    const pack = makePack('{{epic_shard}}\n{{prev_dev_notes}}\n{{arch_constraints}}\n{{story_template}}')
    const templateContent = await pack.getPrompt('create-story')

    expect(templateContent).toContain('{{story_template}}')
  })

  it('uses dispatch taskType create-story (matching BMAD workflow identity)', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    await runCreateStory(makeDeps({ dispatcher }), defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'create-story' })
    )
  })
})

// ---------------------------------------------------------------------------
// Additional: Decision store fallback behavior
// ---------------------------------------------------------------------------

describe('Decision store fallback behavior', () => {
  it('proceeds with empty context when decision store queries return no results', async () => {
    mockGetDecisionsByPhase.mockResolvedValue([])

    const result = await runCreateStory(makeDeps(), defaultParams)

    // Should succeed even with no context (template still dispatched)
    expect(result.result).toBe('success')
  })

  it('returns failure when decision store throws', async () => {
    // Even if DB throws, the function should handle it gracefully
    mockGetDecisionsByPhase.mockImplementation(() => {
      throw new Error('Database connection failed')
    })

    const result = await runCreateStory(makeDeps(), defaultParams)

    // Should succeed because errors are caught and empty strings returned
    // The workflow continues with empty context sections
    expect(result.result).toBe('success')
  })

  it('uses epic shard matching the provided epicId key', async () => {
    const capturedPrompts: string[] = []

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [
          makeDecision('implementation', 'epic-shard', 'epic-9', 'WRONG EPIC CONTENT'),
          makeDecision('implementation', 'epic-shard', 'epic-10', 'CORRECT EPIC CONTENT for epic-10'),
        ]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ dispatcher }), { ...defaultParams, epicId: 'epic-10' })

    // Should inject the correct epic's content, not epic-9's
    expect(capturedPrompts[0]).toContain('CORRECT EPIC CONTENT for epic-10')
    expect(capturedPrompts[0]).not.toContain('WRONG EPIC CONTENT')
  })
})

// ---------------------------------------------------------------------------
// File-based fallback when decisions table is empty
// ---------------------------------------------------------------------------

describe('File-based fallback for empty decisions table', () => {
  afterEach(() => {
    mockExistsSync.mockRestore()
    mockReadFileSync.mockRestore()
  })

  it('falls back to epics.md when decisions table has no epic-shard rows', async () => {
    // Empty decisions table
    mockGetDecisionsByPhase.mockResolvedValue([])

    // Mock epics.md file
    const epicsContent = `# Epics

## Epic 7: Mode Selection & Game Setup

Implement mode selection landing screen, variant configuration, and setup execution.

### Stories
- 7-1: Mode Selection & Game Setup Screen

## Epic 8: Something Else
`
    mockExistsSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return epicsContent
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      { ...defaultParams, epicId: '7', storyKey: '7-1' },
    )

    expect(capturedPrompts[0]).toContain('Mode Selection & Game Setup')
  })

  it('falls back to architecture.md when solutioning decisions are empty', async () => {
    // Empty decisions table
    mockGetDecisionsByPhase.mockResolvedValue([])

    const archContent = '# Architecture\n\nModular monolith with XState state machines.\n\n## Key Decisions\n\nADR-001: Use Zustand for state management.'

    mockExistsSync.mockImplementation((p: unknown) => {
      if (String(p).includes('architecture.md')) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('architecture.md')) return archContent
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      defaultParams,
    )

    expect(capturedPrompts[0]).toContain('Modular monolith')
  })

  it('returns empty string gracefully when fallback files do not exist', async () => {
    mockGetDecisionsByPhase.mockResolvedValue([])
    mockExistsSync.mockReturnValue(false)

    const result = await runCreateStory(
      makeDeps({ projectRoot: '/fake/project' }),
      defaultParams,
    )

    // Should still succeed (dispatch runs, just with empty context sections)
    expect(result.result).toBe('success')
  })

  it('does not attempt file fallback when projectRoot is not provided', async () => {
    mockGetDecisionsByPhase.mockResolvedValue([])

    await runCreateStory(makeDeps(), defaultParams)

    // existsSync should NOT have been called with epics.md or architecture.md paths
    const fsCalls = mockExistsSync.mock.calls.map(c => String(c[0]))
    expect(fsCalls.filter(p => p.includes('epics.md'))).toHaveLength(0)
    expect(fsCalls.filter(p => p.includes('architecture.md'))).toHaveLength(0)
  })

  it('falls back to epics.md with h3 headings (readEpicShardFromFile h3 coverage)', async () => {
    mockGetDecisionsByPhase.mockResolvedValue([])

    const epicsH3Content = `# Epics

### Epic 7: Mode Selection & Game Setup

Implement mode selection with h3 headings.

### Stories
- 7-1: Mode Selection Screen

### Epic 8: Something Else
Other epic content.
`
    mockExistsSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return epicsH3Content
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      { ...defaultParams, epicId: '7', storyKey: '7-1' },
    )

    expect(capturedPrompts[0]).toContain('Mode Selection & Game Setup')
  })

  it('falls back to epics.md with h4 headings (readEpicShardFromFile h4 coverage)', async () => {
    mockGetDecisionsByPhase.mockResolvedValue([])

    const epicsH4Content = `# Epics

#### Epic 7: Mode Selection & Game Setup

Implement mode selection with h4 headings.

#### Stories
- 7-1: Mode Selection Screen

#### Epic 8: Something Else
Other epic content.
`
    mockExistsSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return true
      return false
    })
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return epicsH4Content
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      { ...defaultParams, epicId: '7', storyKey: '7-1' },
    )

    expect(capturedPrompts[0]).toContain('Mode Selection & Game Setup')
  })
})

// ---------------------------------------------------------------------------
// AC3: extractStorySection() — dedicated unit tests (Task 3)
// ---------------------------------------------------------------------------

describe('AC3: extractStorySection() unit tests', () => {
  it('returns null for empty shardContent', () => {
    expect(extractStorySection('', '23-1')).toBeNull()
  })

  it('returns null for empty storyKey', () => {
    expect(extractStorySection('### Story 23-1: Epic Shard Overhaul\nContent here.', '')).toBeNull()
  })

  it('returns null when no matching story section exists', () => {
    const shard = `## Epic 23: Cross-Project Pipeline Correctness

### Story 23-2: Dispatch Error Separation
This story handles dispatch errors.
`
    expect(extractStorySection(shard, '23-1')).toBeNull()
  })

  it('matches "### Story 23-1" heading pattern and returns the section', () => {
    const shard = `## Epic 23: Cross-Project Pipeline Correctness

### Story 23-1: Epic Shard Overhaul
This story handles the epic shard logic.
AC1: Content-Hash Re-Seed

### Story 23-2: Dispatch Error Separation
This story handles dispatch error separation.
`
    const result = extractStorySection(shard, '23-1')
    expect(result).not.toBeNull()
    expect(result).toContain('Epic Shard Overhaul')
    expect(result).toContain('Content-Hash Re-Seed')
    // Must NOT include the next story
    expect(result).not.toContain('Dispatch Error Separation')
  })

  it('matches "#### Story 23-1" (h4) heading pattern', () => {
    const shard = `## Epic 23: Cross-Project Pipeline Correctness

#### Story 23-1: Epic Shard Overhaul
h4 heading content here.

#### Story 23-2: Next Story
Other content.
`
    const result = extractStorySection(shard, '23-1')
    expect(result).not.toBeNull()
    expect(result).toContain('h4 heading content here')
    expect(result).not.toContain('Next Story')
  })

  it('matches "Story 23-1:" label-with-colon pattern', () => {
    const shard = `## Epic 23

Story 23-1: Epic Shard Overhaul
Description of the story.

Story 23-2: Next Story
Other content.
`
    const result = extractStorySection(shard, '23-1')
    expect(result).not.toBeNull()
    expect(result).toContain('Epic Shard Overhaul')
    expect(result).not.toContain('Next Story')
  })

  it('matches "**23-1**" bold pattern', () => {
    const shard = `## Epic 23

**23-1** Epic Shard Overhaul
Bold story section content.

**23-2** Next Story
Other content.
`
    const result = extractStorySection(shard, '23-1')
    expect(result).not.toBeNull()
    expect(result).toContain('Bold story section content')
    expect(result).not.toContain('Next Story')
  })

  it('matches bare "23-1:" pattern', () => {
    const shard = `## Epic 23

23-1: Epic Shard Overhaul
Bare key content.

23-2: Next Story
Other content.
`
    const result = extractStorySection(shard, '23-1')
    expect(result).not.toBeNull()
    expect(result).toContain('Bare key content')
    expect(result).not.toContain('Next Story')
  })

  it('returns the last story section when it is at the end of the shard (no next heading)', () => {
    const shard = `## Epic 23

### Story 23-1: Epic Shard Overhaul
This is the only story in the shard.
`
    const result = extractStorySection(shard, '23-1')
    expect(result).not.toBeNull()
    expect(result).toContain('This is the only story in the shard')
  })

  it('does not confuse 23-1 with 23-10 or 23-11 (key specificity)', () => {
    const shard = `## Epic 23

### Story 23-10: Some Other Story
Not what we want.

### Story 23-1: Epic Shard Overhaul
This is 23-1 content.
`
    const result = extractStorySection(shard, '23-1')
    // Should match 23-1, not 23-10
    expect(result).not.toBeNull()
    expect(result).toContain('Epic Shard Overhaul')
    expect(result).not.toContain('Some Other Story')
  })

  // -------------------------------------------------------------------------
  // Story 58-5: separator normalization (dash / dot / underscore / space)
  //
  // Epic authors use different conventions. Substrate's own docs use
  // `### Story 23-1`, strata's use `### Story 1.7:`, others may use
  // underscores or spaces. The extractor must find the right section
  // regardless of which separator the author chose or which separator the
  // caller supplies as `storyKey`.
  //
  // Root cause of strata obs_2026-04-20_001: `--stories 1-7` couldn't
  // match `### Story 1.7:`, extraction returned null, caller fell through
  // to "return full epic", and the create-story agent freelanced ACs from
  // the whole epic — dropping hard clauses.
  // -------------------------------------------------------------------------

  it('58-5: dash key matches dot-notation heading (1-7 → ### Story 1.7:)', () => {
    const shard = `## Epic 1

### Story 1.6: Earlier Story
earlier content.

### Story 1.7: Unified jarvis CLI
This is the 1.7 content with a MUST NOT clause.

### Story 1.8: Later Story
later content.
`
    const result = extractStorySection(shard, '1-7')
    expect(result).not.toBeNull()
    expect(result).toContain('Unified jarvis CLI')
    expect(result).toContain('MUST NOT')
    expect(result).not.toContain('Earlier Story')
    expect(result).not.toContain('Later Story')
  })

  it('58-5: dot key matches dash-notation heading (1.7 → ### Story 1-7:)', () => {
    const shard = `### Story 1-7: Dash-notation heading
content goes here.

### Story 1-8: next
`
    const result = extractStorySection(shard, '1.7')
    expect(result).not.toBeNull()
    expect(result).toContain('Dash-notation heading')
    expect(result).not.toContain('next')
  })

  it('58-5: underscore and space keys match dash headings', () => {
    const shard = `### Story 1-7: Some Title
content.

### Story 1-8: next
`
    expect(extractStorySection(shard, '1_7')).toContain('Some Title')
    expect(extractStorySection(shard, '1 7')).toContain('Some Title')
  })

  it('58-5: dot-separated next-story heading terminates the section', () => {
    // Strata-style epic: both headings use dots. Boundary detection must
    // stop at `### Story 1.8:` even though the original regex only knew
    // about dash-delimited next-story keys.
    const shard = `### Story 1.7: Target Story
This is 1.7's content.
MUST NOT leak into 1.8.

### Story 1.8: Next Story
This belongs to 1.8, not 1.7.
`
    const result = extractStorySection(shard, '1.7')
    expect(result).not.toBeNull()
    expect(result).toContain("Target Story")
    expect(result).toContain('MUST NOT leak into 1.8')
    expect(result).not.toContain("belongs to 1.8")
  })

  it('58-5: letter-suffix keys work across dash and dot (1-11a, 1.11a)', () => {
    const shard = `### Story 1.11a: Suffixed Story
Content for 1.11a.

### Story 1.11b: Next
Next content.
`
    expect(extractStorySection(shard, '1-11a')).toContain('Suffixed Story')
    expect(extractStorySection(shard, '1.11a')).toContain('Suffixed Story')
    expect(extractStorySection(shard, '1-11a')).not.toContain('Next')
  })

  it('58-5: key specificity holds across separator variants (1-7 does NOT match 1.70)', () => {
    const shard = `### Story 1.70: Impostor
wrong match.

### Story 1.7: Real Target
right match.
`
    const result = extractStorySection(shard, '1-7')
    expect(result).not.toBeNull()
    expect(result).toContain('Real Target')
    expect(result).not.toContain('Impostor')
  })
})

// ---------------------------------------------------------------------------
// AC4 (Story 37-0): Direct per-storyKey lookup in getEpicShard()
// ---------------------------------------------------------------------------

describe('AC4 (37-0): Direct per-storyKey epic shard lookup', () => {
  it('uses per-story shard (key=storyKey) directly without extraction when available', async () => {
    const capturedPrompts: string[] = []
    const perStoryContent = '### Story 37-1: Project Profile\nThis is the per-story shard content.'

    // Simulate post-37-0 schema: shard keyed by storyKey '37-1'
    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '37-1', perStoryContent)]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher }),
      { epicId: '37', storyKey: '37-1' }
    )

    // Per-story shard content must appear directly in the prompt
    expect(capturedPrompts[0]).toContain(perStoryContent)
  })

  it('per-story shard lookup takes priority over per-epic shard', async () => {
    const capturedPrompts: string[] = []
    const perStoryContent = 'PER_STORY_CONTENT_37-1'
    const perEpicContent = 'PER_EPIC_CONTENT_37'

    // Both types present: per-story should win
    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [
          makeDecision('implementation', 'epic-shard', '37', perEpicContent),
          makeDecision('implementation', 'epic-shard', '37-1', perStoryContent),
        ]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher }),
      { epicId: '37', storyKey: '37-1' }
    )

    expect(capturedPrompts[0]).toContain(perStoryContent)
    expect(capturedPrompts[0]).not.toContain(perEpicContent)
  })
})

// ---------------------------------------------------------------------------
// AC6 (Story 37-0): Backward-compat fallback for pre-37-0 per-epic shards
// ---------------------------------------------------------------------------

describe('AC6 (37-0): Backward-compat fallback for pre-37-0 per-epic shards', () => {
  it('falls back to per-epic shard + extractStorySection when no per-story shard exists', async () => {
    const capturedPrompts: string[] = []

    // Simulate pre-37-0 state: only per-epic shard (key = epicId)
    const perEpicShard = `## Epic 23: Test Epic

### Story 23-1: Target Story
This is the target story content.

### Story 23-2: Other Story
Other story content.
`
    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '23', perEpicShard)]
      }
      return []
    })

    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher }),
      { epicId: '23', storyKey: '23-1' }
    )

    // Should inject the story-specific section (extracted from per-epic shard)
    expect(capturedPrompts[0]).toContain('Target Story')
    // Must NOT include the other story's content
    expect(capturedPrompts[0]).not.toContain('Other story content')
  })
})

// ---------------------------------------------------------------------------
// Story 58-13: getEpicShard file-based fall-through when decisions shard lacks story
//
// Strata obs_2026-04-20_001 Run 8 asymmetric-fix finding (2026-04-23):
// an earlier solutioning-phase run stored a truncated 12K per-epic shard
// that ended partway through Story 1.7, so Stories 1.6, 1.8, 1.9+ were
// absent from the decision-store shard entirely. When create-story
// dispatched for 1-9, the old code returned the full stale shard here
// (12K of content about 1.1-1.7), create-story saw no 1-9 AC text at
// all, and the agent hallucinated the spec from domain priors — LanceDB
// class-based design instead of the source-specified JSON adjacency
// list.
//
// Fix: when the decisions-store shard exists but extractStorySection
// returns null for the requested storyKey, fall through to the
// file-based fallback (readEpicShardFromFile) BEFORE returning the
// stale shard. If the file ALSO doesn't contain the section, return the
// full epic content from the file. Stale-shard return is reserved as
// the last-resort when neither decisions extract nor file fallback is
// available.
// ---------------------------------------------------------------------------

describe('Story 58-13: getEpicShard file-based fall-through when decisions shard lacks story', () => {
  it('falls through to epics.md file when decisions-store shard is missing the requested story', async () => {
    // Decisions shard: truncated — contains only Stories 1.1 and 1.7, NO 1.9
    const truncatedShard = `## Epic 1: Fleet Foundation

### Story 1.1: Monorepo scaffolding
Stub content for 1.1 in decisions shard.

### Story 1.7: CLI subcommand
Stub content for 1.7 in decisions shard.
`

    // epics.md on disk: full epic, includes Story 1.9 with the source-specified AC
    const epicsFileContent = `# Epics

## Epic 1: Fleet Foundation

### Story 1.9: Wikilink JSON adjacency builder
**Acceptance Criteria:**
Uses a plain JSON file with atomic tmp-rename writes.
Files: \`packages/memory/src/graph/adjacency-store.ts\`.
`

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '1', truncatedShard)]
      }
      return []
    })
    mockExistsSync.mockImplementation((p: unknown) => String(p).includes('epics.md'))
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return epicsFileContent
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      { ...defaultParams, epicId: '1', storyKey: '1-9' },
    )

    // File-based fallback text appears in the prompt
    expect(capturedPrompts[0]).toContain('Wikilink JSON adjacency builder')
    expect(capturedPrompts[0]).toContain('adjacency-store.ts')
    expect(capturedPrompts[0]).toContain('atomic tmp-rename writes')
    // And the stale-shard's OTHER-story content must NOT leak in as the context
    expect(capturedPrompts[0]).not.toContain('Stub content for 1.1 in decisions shard')
    expect(capturedPrompts[0]).not.toContain('Stub content for 1.7 in decisions shard')
  })

  it('preserves extraction-from-decisions when decisions shard DOES contain the requested story', async () => {
    // Decisions shard: contains the target story's section
    const decisionsShard = `## Epic 23: Test Epic

### Story 23-1: Target Story (from decisions)
Content stored in decisions.

### Story 23-2: Unrelated
Other content.
`
    // epics.md on disk: a DIFFERENT version of the target story section
    const epicsFileContent = `# Epics

## Epic 23: Test Epic

### Story 23-1: Target Story (FROM FILE)
File-based content.
`

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '23', decisionsShard)]
      }
      return []
    })
    mockExistsSync.mockImplementation((p: unknown) => String(p).includes('epics.md'))
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return epicsFileContent
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      { ...defaultParams, epicId: '23', storyKey: '23-1' },
    )

    // Decisions-store content wins — the AC6 backward-compat path is preserved.
    expect(capturedPrompts[0]).toContain('Content stored in decisions')
    expect(capturedPrompts[0]).not.toContain('File-based content')
  })

  it('returns stale decisions shard as LAST RESORT when file fallback has no matching section', async () => {
    // Decisions shard: truncated, missing the target story
    const truncatedShard = `## Epic 5

### Story 5-1: Not Our Target
Some content.
`
    // epics.md: ALSO missing the story (corrupted / stale / different project state)
    const epicsFileContent = `# Epics
(epic 5 section is absent from this file too)
`

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '5', truncatedShard)]
      }
      return []
    })
    mockExistsSync.mockImplementation((p: unknown) => String(p).includes('epics.md'))
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).includes('epics.md')) return epicsFileContent
      throw new Error('ENOENT')
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher, projectRoot: '/fake/project' }),
      { ...defaultParams, epicId: '5', storyKey: '5-2' },
    )

    // Stale shard returned as last resort (its 'Not Our Target' content is present)
    expect(capturedPrompts[0]).toContain('Not Our Target')
  })

  it('no projectRoot: returns stale decisions shard when extract fails (file fallback unavailable)', async () => {
    const truncatedShard = `## Epic 9

### Story 9-1: Something Else
Content unrelated to our target.
`

    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '9', truncatedShard)]
      }
      return []
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    // No projectRoot passed — file fallback path is unreachable.
    await runCreateStory(
      makeDeps({ dispatcher }),
      { ...defaultParams, epicId: '9', storyKey: '9-99' },
    )

    // Stale shard returned as last resort
    expect(capturedPrompts[0]).toContain('Something Else')
  })
})

// ---------------------------------------------------------------------------
// Story 58-18: source_ac_hash content integrity
//
// The orchestrator computes source_ac_hash from epics.md before dispatch.
// runCreateStory should re-derive the hash from the actual epicShardContent
// the agent receives — closing the gap where the embedded hash claimed
// authority over content the agent didn't see.
//
// Three cases covered:
//   1. Decisions-store hit: hash is computed from the per-story decision
//      content. Should equal the orchestrator's hash when the file's
//      extracted section is bit-identical to the decision (normal case).
//   2. Mismatch: orchestrator-supplied hash differs from computed →
//      computed wins (preserves integrity).
//   3. Full-epic fallback (extractStorySection on epicShardContent fails):
//      effectiveSourceAcHash falls back to orchestrator-supplied; if also
//      undefined, no hash comment is injected.
// ---------------------------------------------------------------------------

describe('Story 58-18: source_ac_hash derived from actual epic_shard content', () => {
  // The default makePack template doesn't include {{source_ac_hash}}; these
  // tests need a template that does so the assembled prompt contains the
  // hash and the assertions can detect it.
  const TEMPLATE_WITH_HASH = 'Epic: {{epic_shard}}\nHash: {{source_ac_hash}}'

  it('hashes the per-story content the agent will actually see (decisions-store path)', async () => {
    const storySection = `### Story 22-1: Test Target
Source AC text that the agent receives in the prompt.
`
    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '22-1', storySection)]
      }
      return []
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    // Compute the expected hash from the section content directly using the
    // exported helper. After 58-18, the hash injected into the prompt MUST
    // equal this — proving the hash represents the actual content the agent
    // received, not some external source.
    const expectedHash = hashSourceAcSection(storySection)

    await runCreateStory(
      makeDeps({ dispatcher, pack: makePack(TEMPLATE_WITH_HASH) }),
      { epicId: '22', storyKey: '22-1' }, // No source_ac_hash supplied
    )

    expect(capturedPrompts[0]).toContain(expectedHash)
  })

  it('overrides orchestrator-supplied hash when it differs from epic_shard content hash', async () => {
    const storySection = `### Story 33-1: Override Target
Authoritative AC content.
`
    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '33-1', storySection)]
      }
      return []
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    // Orchestrator passes a different hash (simulating decisions vs file
    // divergence). 58-18 should override with the content-derived hash.
    const wrongHash = 'a'.repeat(64) // 64-char hex like SHA-256
    const expectedHash = hashSourceAcSection(storySection)
    expect(wrongHash).not.toBe(expectedHash)

    await runCreateStory(
      makeDeps({ dispatcher, pack: makePack(TEMPLATE_WITH_HASH) }),
      { epicId: '33', storyKey: '33-1', source_ac_hash: wrongHash },
    )

    // Computed hash wins
    expect(capturedPrompts[0]).toContain(expectedHash)
    // Wrong hash MUST NOT appear in the prompt (it was overridden)
    expect(capturedPrompts[0]).not.toContain(wrongHash)
  })

  it('falls back to orchestrator-supplied hash when extractStorySection fails on the shard content', async () => {
    // Shard content does NOT contain a heading matching '99-99' → re-extract
    // returns null → effectiveSourceAcHash = orchestrator-supplied hash.
    const unrelatedShard = `## Epic 99

### Story 99-1: Some Other Story
Other content.
`
    mockGetDecisionsByPhase.mockImplementation((_, phase: string) => {
      if (phase === 'implementation') {
        return [makeDecision('implementation', 'epic-shard', '99', unrelatedShard)]
      }
      return []
    })

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const orchestratorHash = 'b'.repeat(64)

    await runCreateStory(
      makeDeps({ dispatcher, pack: makePack(TEMPLATE_WITH_HASH) }),
      { epicId: '99', storyKey: '99-99', source_ac_hash: orchestratorHash },
    )

    // Re-extract failed; orchestrator-supplied hash flows through unchanged
    expect(capturedPrompts[0]).toContain(orchestratorHash)
  })

  it('omits the source_ac_hash context item entirely when both computed and supplied are absent', async () => {
    // Empty epic shard + no orchestrator-supplied hash → effectiveSourceAcHash
    // stays undefined → context item is NOT injected → prompt has no
    // source_ac_hash placeholder substitution.
    mockGetDecisionsByPhase.mockResolvedValue([])

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(
      makeDeps({ dispatcher }),
      { epicId: '50', storyKey: '50-1' }, // no source_ac_hash supplied
    )

    // No 64-hex-char hash should appear in the prompt for this story key
    // (the prompt template's {{source_ac_hash}} placeholder receives an
    // empty/absent value and the directive says omit the comment when blank).
    const hashPattern = /[0-9a-f]{64}/
    const hashMatch = hashPattern.exec(capturedPrompts[0])
    expect(hashMatch).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Story 56-create-story-probe-awareness: Runtime Verification guidance
// ---------------------------------------------------------------------------
//
// The create-story prompt teaches the agent to propose `## Runtime Probes`
// sections for runtime-dependent artifacts (systemd units, containers,
// install scripts, migrations, compose files). These tests pin both the
// presence of the guidance and the parseability of every probe example
// against the production `RuntimeProbeListSchema` — if the examples drift
// from the schema the template ships bad syntax to every agent.

describe('Story 56: Runtime Verification guidance in create-story prompt', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const promptPath = join(__dirname, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'create-story.md')

  let promptContent: string

  beforeEach(async () => {
    promptContent = await readFile(promptPath, 'utf-8')
  })

  it('AC1: prompt template includes a Runtime Verification guidance heading', () => {
    expect(promptContent).toMatch(/^##\s+Runtime\s+Verification\s+Guidance/mi)
  })

  it('AC1: prompt teaches the `## Runtime Probes` section name agents must emit', () => {
    // The parser recognizes exactly `## Runtime Probes` (case-insensitive).
    // Authors must know the literal heading; drift here breaks the check.
    expect(promptContent).toContain('## Runtime Probes')
  })

  it('AC1: prompt documents the probe YAML schema (name, sandbox, command, timeout_ms?, description?)', () => {
    expect(promptContent).toMatch(/name:\s*<hyphen-separated-identifier>/)
    expect(promptContent).toMatch(/sandbox:\s*host\s*\|\s*twin/)
    expect(promptContent).toMatch(/command:/)
    expect(promptContent).toMatch(/timeout_ms:/)
    expect(promptContent).toMatch(/description:/)
  })

  it('AC1: prompt includes one concrete probe example per runtime-dependent artifact class', () => {
    // Brief AC1: systemd unit, container, install script, migration, compose
    expect(promptContent.toLowerCase()).toContain('systemd')
    expect(promptContent.toLowerCase()).toMatch(/podman|container|quadlet/)
    expect(promptContent.toLowerCase()).toContain('install script')
    expect(promptContent.toLowerCase()).toMatch(/migration/)
    expect(promptContent.toLowerCase()).toMatch(/docker\s+compose|compose file/i)
  })

  it('AC2: prompt guides sandbox=twin as the default for host-mutating probes', () => {
    expect(promptContent).toMatch(/sandbox:\s*twin/)
    expect(promptContent).toMatch(/sandbox:\s*host/)
    // Must state the "when in doubt" default explicitly
    expect(promptContent).toMatch(/when in doubt[^\n]*twin/i)
  })

  it('AC3: prompt guides separate named probes per concern (granularity)', () => {
    expect(promptContent).toMatch(/separate named probes/i)
    // Hyphen-separated identifier guidance present
    expect(promptContent).toMatch(/hyphen-separated/i)
  })

  it('AC4 + AC5: prompt explicitly tells the agent NOT to declare probes for static-output stories', () => {
    // Must be imperative, not hedged. The wording doesn't matter but the intent does.
    expect(promptContent).toMatch(/omit the `## Runtime Probes` section/i)
    // Must enumerate the most common static case so TypeScript/test stories
    // (the default substrate self-development case) don't grow probes.
    expect(promptContent.toLowerCase()).toMatch(/typescript|javascript|code\s*\+\s*tests/)
    expect(promptContent.toLowerCase()).toMatch(/refactor|documentation|build/)
  })

  it('AC1 guardrail: every ```yaml fenced block parses against RuntimeProbeListSchema', () => {
    // This is the schema-drift trip-wire: if an author edits the prompt and
    // introduces a probe example that doesn't parse, the check fails before
    // the broken example ever ships to an agent.
    const fences = [...promptContent.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1])
    expect(fences.length).toBeGreaterThan(0)

    for (const body of fences) {
      const parsed = yamlLoad(body)
      // Skip the schema-shape template (the one using `<hyphen-separated-identifier>` placeholders)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        continue
      }
      // Everything else must be a list of valid probes.
      expect(Array.isArray(parsed)).toBe(true)
      const result = RuntimeProbeListSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(
          `Probe example failed schema validation:\n--- yaml ---\n${body}\n--- error ---\n${result.error.message}`,
        )
      }
    }
  })

  it('AC8 (strata Story 1-4 class): probe examples include a container image pull check', () => {
    // The scar that motivated Epic 56: wrong image path (403 Forbidden on
    // ghcr.io/dolthub/dolt-sql-server). At least one example must be the
    // `podman pull` / container-image class of probe so agents see the
    // precedent for that failure class.
    expect(promptContent).toMatch(/podman pull|docker pull|image[^\n]*pull/i)
  })

  it('Backward compat: pipeline-rendered prompt sent to the dispatcher also carries probe guidance', async () => {
    // AC7 verifies presence in the template file. This extra test closes
    // the loop: the rendered prompt (post-placeholder substitution) is
    // what the agent actually receives, so confirm no assembly step drops
    // the guidance.
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockResolvedValue(promptContent)

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ pack, dispatcher }), defaultParams)

    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0]).toMatch(/Runtime Verification Guidance/i)
    expect(capturedPrompts[0]).toContain('## Runtime Probes')
  })

  it('parser round-trip: a sample story embedding one of the prompt examples parses cleanly', () => {
    // Pull the podman example out of the prompt and wrap it in a minimal
    // story. parseRuntimeProbes() must return kind='parsed' with one probe.
    // This is the end-to-end guardrail: prompt example → story markdown →
    // production parser → ready-to-execute probe.
    const fences = [...promptContent.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1])
    // Pick the first list-shaped example (skip the schema template).
    const listBody = fences.find((body) => {
      const parsed = yamlLoad(body)
      return Array.isArray(parsed)
    })
    expect(listBody).toBeDefined()

    const story = `# Sample Story\n\n## Runtime Probes\n\n\`\`\`yaml\n${listBody}\n\`\`\`\n`
    const result = parseRuntimeProbes(story)
    expect(result.kind).toBe('parsed')
    if (result.kind === 'parsed') {
      expect(result.probes.length).toBeGreaterThan(0)
      for (const probe of result.probes) {
        expect(probe.name).toMatch(/^[a-z0-9][a-z0-9-]*$/i)
        expect(['host', 'twin']).toContain(probe.sandbox)
        expect(probe.command.length).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Story 58-1: AC Preservation Directive in create-story prompt
// ---------------------------------------------------------------------------
//
// The create-story prompt must treat AC text from the Story Definition as
// read-only input so that hard clauses (MUST / MUST NOT / SHALL / enumerated
// paths / explicit storage choices / runtime probes) reach the rendered
// artifact verbatim. Before 58-1 the prompt actively instructed the agent
// to transform ACs into BDD Given/When/Then — imperative source clauses
// were silently softened ("MUST remove X" → "keep X for backward compat"),
// and mandatory `## Runtime Probes` sections were dropped with rationales
// like "no integration probe needed for this story". The dev-story and
// code-review phases then validated against the rewritten AC, not the
// source, so the epic author's intent never reached implementation.
// Source: strata agent report 2026-04-20 on stories 1-7 and 1-9
// (run 19d14a3b-511a-4fce-92d5-7750ea53511b).
//
// These tests pin the prompt-level guardrails that prevent the rewrite.

describe('Story 58-1: AC Preservation Directive in create-story prompt', () => {
  const __dirname58 = dirname(fileURLToPath(import.meta.url))
  const promptPath58 = join(__dirname58, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'create-story.md')

  let promptContent58: string

  beforeEach(async () => {
    promptContent58 = await readFile(promptPath58, 'utf-8')
  })

  it('AC1: prompt declares AC text from the Story Definition as read-only input', () => {
    // The exact phrase is the trip-wire — a future edit that paraphrases away
    // "read-only input" removes the explicit guardrail.
    expect(promptContent58.toLowerCase()).toContain('read-only input')
  })

  it('AC2: prompt enumerates hard-clause keywords and requires them verbatim', () => {
    // Hard-clause keywords must be named. A future agent reading this prompt
    // needs to know which source clauses cannot be reshaped.
    expect(promptContent58).toMatch(/`MUST`/)
    expect(promptContent58).toMatch(/`MUST NOT`/)
    expect(promptContent58).toMatch(/`SHALL`/)
    expect(promptContent58).toMatch(/`SHALL NOT`/)
    // "verbatim" must appear in the AC preservation clause.
    expect(promptContent58.toLowerCase()).toContain('verbatim')
  })

  it('AC3: prompt explicitly forbids softening, abstracting, or paraphrasing hard clauses', () => {
    // Mechanism: the agent can comply with BDD format AND violate the spirit
    // by reshaping MUST NOT into "consider deprecating". The prompt must
    // name the failure mode in terms the agent will recognize.
    const preservationParagraph = promptContent58.match(/read-only input[\s\S]{0,1200}/i)?.[0] ?? ''
    expect(preservationParagraph.toLowerCase()).toContain('soften')
    expect(preservationParagraph.toLowerCase()).toContain('paraphrase')
  })

  it('AC4: prompt tells the agent to transfer a source `## Runtime Probes` section verbatim', () => {
    // The strata failure included mandatory probes being dropped with the
    // rationale "no integration probe needed for this story". The fix:
    // when the source has probes, the agent is not authorized to re-judge.
    expect(promptContent58).toMatch(/Story Definition[\s\S]{0,200}`## Runtime Probes`[\s\S]{0,200}verbatim/i)
  })

  it('AC5: BDD format is demoted from mandatory to optional for hard clauses', () => {
    // The pre-58-1 prompt said "Acceptance criteria in BDD Given/When/Then
    // format (minimum 3, maximum 8)" — a prescriptive rule that compelled
    // transformation. Post-58-1: BDD is permitted-when-appropriate, never
    // mandatory over a hard clause.
    expect(promptContent58).toMatch(/BDD[\s\S]{0,400}optional/i)
    // And the new language explicitly names what BDD may NOT do.
    expect(promptContent58).toMatch(/Never let BDD reshape|Never let BDD rewrite|BDD[\s\S]{0,200}MUST[\s\S]{0,200}clause/i)
  })

  it('AC6: scope cap guidance does not license condensing source ACs', () => {
    // The 6-7 AC cap is aimed at authored-from-scratch stories. The prompt
    // must make clear the cap does not authorize dropping clauses from the
    // source Story Definition to hit the target count.
    expect(promptContent58).toMatch(/scope cap[\s\S]{0,400}(condens|source AC)/i)
    // When the source genuinely exceeds a single story, surface as failure
    // rather than silently dropping.
    expect(promptContent58).toMatch(/result:\s*failure[\s\S]{0,200}split upstream|split upstream[\s\S]{0,200}failure/i)
  })

  it('Story 56 backward compat: Runtime Verification guidance heading and probe schema still present', () => {
    // The 58-1 edits touched the Runtime Verification section to add the
    // "transfer verbatim" clause. Verify we did not break the Story 56
    // guardrails: the heading, probe YAML shape, and sandbox guidance all
    // survive.
    expect(promptContent58).toMatch(/^##\s+Runtime\s+Verification\s+Guidance/mi)
    expect(promptContent58).toContain('## Runtime Probes')
    expect(promptContent58).toMatch(/sandbox:\s*host\s*\|\s*twin/)
  })

  it('Rendered prompt sent to the dispatcher also carries the AC preservation directive', async () => {
    // Closing the loop: the rendered prompt (post-placeholder substitution)
    // is what the agent actually receives, so confirm no assembly step
    // drops the 58-1 directives.
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockResolvedValue(promptContent58)

    const capturedPrompts: string[] = []
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation((req) => {
        capturedPrompts.push(req.prompt)
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-58-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.resolve(makeSuccessDispatchResult()),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    await runCreateStory(makeDeps({ pack, dispatcher }), defaultParams)

    expect(capturedPrompts).toHaveLength(1)
    expect(capturedPrompts[0].toLowerCase()).toContain('read-only input')
    expect(capturedPrompts[0].toLowerCase()).toContain('verbatim')
  })
})

// ---------------------------------------------------------------------------
// Story 58-6: AC3 — source-ac-hash emission directive in create-story prompt
// ---------------------------------------------------------------------------
//
// The create-story prompt must instruct agents to emit a `<!-- source-ac-hash: <hex> -->`
// HTML comment immediately after the `## Acceptance Criteria` heading so that
// the orchestrator's freshness check (orchestrator-impl.ts) can detect edits to
// the source epic without re-invoking create-story unnecessarily.
//
// This describe block pins the presence of the directive in the prompt file.
// Without this test, a future prompt edit could silently remove the directive
// and the freshness check would always see "absent hash → drift" on every run,
// forcing create-story to be re-dispatched for every story on every pipeline run.

// ---------------------------------------------------------------------------
// Story 58-10: Create-story prompt hardening — verbatim first, reformulation below
//
// Strata's obs_2026-04-20_001 (Run 4 on v0.20.12 + Epic 58): even after 58-1's
// "AC text is read-only" directive, 1-9's rendered artifact renamed source-
// declared filenames (`adjacency-store.ts` → `wikilink-queries.ts`), flipped
// storage backend (JSON file → LanceDB table), and dropped the specific
// probe filename. 58-1's language mentioned "enumerated file paths" and
// "explicit technology / storage / data-format choices" but those categories
// were being interpreted liberally. 58-10 adopts observer's option (4):
// default rendering is a VERBATIM copy; any agent reformulation goes in a
// distinct `### Create-story reformulation (optional)` subsection below.
// Also expands the enumeration to name filenames, directories, storage
// backends, and probe identifiers explicitly.
// ---------------------------------------------------------------------------

describe('Story 58-10: verbatim-first AC rendering directive in create-story prompt', () => {
  const __dirname58_10 = dirname(fileURLToPath(import.meta.url))
  const promptPath58_10 = join(__dirname58_10, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'create-story.md')

  let promptContent58_10: string

  beforeEach(async () => {
    promptContent58_10 = await readFile(promptPath58_10, 'utf-8')
  })

  it('AC1: prompt declares the default rendering of the source AC as a verbatim copy', () => {
    // The exact phrase "verbatim copy" — the trip-wire for a future edit that
    // paraphrases away the verbatim-first rule.
    expect(promptContent58_10.toLowerCase()).toContain('verbatim copy')
  })

  it('AC2: prompt directs agent reformulation to a separate subsection below the verbatim copy', () => {
    // The "### Create-story reformulation (optional)" subsection is observer's
    // suggestion (4): source stays the binding contract; reformulation is a
    // suggestion the operator can accept or reject.
    expect(promptContent58_10).toContain('### Create-story reformulation (optional)')
    expect(promptContent58_10).toMatch(/never in place of/i)
  })

  it('AC3: prompt explicitly names filenames as a verbatim-preserve category', () => {
    // 58-1 said "enumerated file paths" but the agent was reshaping filenames
    // anyway (strata 1-9: adjacency-store.ts → wikilink-queries.ts). Spell it
    // out with specific scar-tissue examples.
    expect(promptContent58_10.toLowerCase()).toContain('named filenames')
    expect(promptContent58_10).toMatch(/do not rename/i)
  })

  it('AC4: prompt explicitly names storage/technology choices as a verbatim-preserve category', () => {
    // 58-1 had this category but the agent flipped JSON → LanceDB on strata
    // 1-9. 58-10 spells out the exact categories (storage backend, data
    // format) and names the specific failure mode.
    expect(promptContent58_10.toLowerCase()).toMatch(/storage.*data-format|technology.*storage/)
    // The scar-tissue JSON/LanceDB example must be referenced so the agent
    // recognizes the failure class.
    expect(promptContent58_10).toMatch(/JSON[^\n]*LanceDB|LanceDB[^\n]*JSON/i)
  })

  it('AC5: prompt explicitly names probe identifiers as a verbatim-preserve category', () => {
    // 58-1 didn't call out probe filenames. Strata 1-9 renamed
    // real-wikilink-adjacency-probe.mjs → real-vault-graph-probe.mjs
    // silently. Name this category.
    expect(promptContent58_10.toLowerCase()).toContain('probe')
    expect(promptContent58_10).toMatch(/probe[^\n]*identifier|probe filename|probe `name:`/i)
  })

  it('AC6: prompt explains WHY verbatim-first — cites the real failure class', () => {
    // The agent's "judgment" about what the author meant has been
    // systematically wrong on these dimensions. The rule exists because of
    // recorded incidents, not abstract principles. Naming the scar-tissue
    // examples in the prompt helps the agent recognize the failure shape.
    expect(promptContent58_10).toMatch(/shipped code that violated/i)
    // At least one of the three named failure classes is referenced:
    const hasScarExample =
      promptContent58_10.includes('MUST remove X') ||
      promptContent58_10.includes('adjacency-store.ts') ||
      promptContent58_10.includes('plain JSON file')
    expect(hasScarExample).toBe(true)
  })

  it('58-1 backward compat: read-only input + verbatim + never soften directives remain', () => {
    // 58-10 is an addition, not a replacement. The existing 58-1 guardrails
    // must still be present in the prompt so no regression in the simpler
    // hard-clause cases.
    expect(promptContent58_10.toLowerCase()).toContain('read-only input')
    expect(promptContent58_10.toLowerCase()).toContain('verbatim')
    expect(promptContent58_10).toMatch(/never soften|soften, abstract, or paraphrase/i)
  })
})

describe('Story 58-14: Input-validation fail-loud guard in create-story prompt', () => {
  const __dirname58_14 = dirname(fileURLToPath(import.meta.url))
  const promptPath58_14 = join(__dirname58_14, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'create-story.md')

  let promptContent58_14: string

  beforeEach(async () => {
    promptContent58_14 = await readFile(promptPath58_14, 'utf-8')
  })

  it('AC1: prompt contains an Input Validation section positioned BEFORE the Instructions section', () => {
    // The guard must fire before the agent reads the "verbatim copy" instruction —
    // otherwise a missing-AC input path would skip the validation entirely.
    const validationIdx = promptContent58_14.search(/^##\s+Input\s+Validation/mi)
    const instructionsIdx = promptContent58_14.search(/^##\s+Instructions/mi)
    expect(validationIdx).toBeGreaterThanOrEqual(0)
    expect(instructionsIdx).toBeGreaterThan(validationIdx)
  })

  it('AC2: prompt instructs to emit result:failure with error:source-ac-content-missing on empty input', () => {
    // The orchestrator (getEpicShard 58-13 fallthrough) is the primary defense;
    // this prompt instruction is the agent-side belt-and-suspenders so that if
    // input starvation happens from any other cause (future pipeline changes,
    // new backends), the agent fails loudly instead of hallucinating.
    expect(promptContent58_14).toContain('source-ac-content-missing')
    // And it must reference the structured failure shape
    expect(promptContent58_14).toMatch(/result:\s*failure[\s\S]{0,150}error:\s*source-ac-content-missing/i)
  })

  it('AC3: prompt explicitly warns against hallucinating from domain priors', () => {
    // The "graph builder → LanceDB" failure mode from strata obs_2026-04-20_001
    // Run 8 is named explicitly so the reader understands the stakes.
    expect(promptContent58_14).toMatch(/hallucinat|infer|guess/i)
    expect(promptContent58_14.toLowerCase()).toMatch(/domain priors|trained prior|pattern/i)
  })

  it('AC4: prompt directs agent to look for both heading match AND AC-bearing block', () => {
    // Two-signal check — a story heading alone isn't enough; the section must
    // contain Acceptance Criteria content. Otherwise a shard containing only a
    // stub "Story 1.9: Wikilink adjacency builder" heading (no body) would
    // pass the guard despite having zero AC content.
    expect(promptContent58_14).toMatch(/story\s+.*key/i)
    expect(promptContent58_14).toMatch(/Acceptance Criteria/i)
  })

  it('AC5: prompt forbids writing a partial story file on the failure path', () => {
    // Without this, an agent might emit BOTH a minimal partial artifact AND
    // the failure YAML — confusing the 58-9d fraud-guard and the orchestrator.
    expect(promptContent58_14).toMatch(/do\s+not\s+write/i)
  })
})

describe('Story 58-6: AC3 — source-ac-hash emission directive in create-story prompt', () => {
  const __dirname58_6 = dirname(fileURLToPath(import.meta.url))
  const promptPath58_6 = join(__dirname58_6, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'create-story.md')

  let promptContent58_6: string

  beforeEach(async () => {
    promptContent58_6 = await readFile(promptPath58_6, 'utf-8')
  })

  it('AC3: prompt contains the source-ac-hash HTML comment literal', () => {
    // The orchestrator regex expects `<!-- source-ac-hash: <64 hex chars> -->`.
    // The prompt must use this exact comment format so agents emit it verbatim.
    expect(promptContent58_6).toContain('source-ac-hash')
  })

  it('AC3: prompt references the {{source_ac_hash}} template variable', () => {
    // The placeholder is injected by runCreateStory() via CreateStoryParams.source_ac_hash.
    // If this placeholder is removed from the prompt, agents receive no hash to embed.
    expect(promptContent58_6).toContain('source_ac_hash')
  })

  it('AC3: prompt instructs to emit the hash immediately after the ## Acceptance Criteria heading', () => {
    // The placement requirement — "immediately after the `## Acceptance Criteria` heading" —
    // is what lets the orchestrator regex reliably find the hash without full AST parsing.
    expect(promptContent58_6).toMatch(/## Acceptance Criteria/i)
    expect(promptContent58_6).toMatch(/source-ac-hash[\s\S]{0,200}source_ac_hash/i)
  })

  it('AC3: prompt instructs to omit the comment when source_ac_hash is absent or blank', () => {
    // Prevents agents from emitting `<!-- source-ac-hash:  -->` (empty value).
    // An absent/empty hash comment would not match the 64-hex-char regex and
    // would be treated as "absent hash → drift" — functionally equivalent to omitting
    // the comment, but the guidance should be explicit to avoid confusion.
    expect(promptContent58_6).toMatch(/empty|blank|absent|omit|not provided/i)
  })
})

// ---------------------------------------------------------------------------
// hashSourceAcSection — Story 58-6, AC5
// ---------------------------------------------------------------------------

describe('hashSourceAcSection', () => {
  it('produces a 64-character hex string for non-empty input', () => {
    const result = hashSourceAcSection('## Acceptance Criteria\nAC1: Do something\n')
    expect(result).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable (idempotent) — same input always produces the same hash', () => {
    const section = '## Acceptance Criteria\n\nAC1: The system MUST do X\nAC2: The system MUST NOT do Y\n'
    const hash1 = hashSourceAcSection(section)
    const hash2 = hashSourceAcSection(section)
    expect(hash1).toBe(hash2)
  })

  it('trims surrounding whitespace — leading/trailing newlines do not change the hash', () => {
    const core = '## Acceptance Criteria\nAC1: Do something'
    const withPadding = `\n\n  ${core}  \n\n`
    // After trim(), core and withPadding normalize to the same string
    expect(hashSourceAcSection(core)).toBe(hashSourceAcSection(withPadding))
  })

  it('strips trailing whitespace per line — trailing spaces on a line do not change the hash', () => {
    const withTrailingSpaces = '## Acceptance Criteria\nAC1: Do something   \nAC2: Another thing  '
    const withoutTrailingSpaces = '## Acceptance Criteria\nAC1: Do something\nAC2: Another thing'
    expect(hashSourceAcSection(withTrailingSpaces)).toBe(hashSourceAcSection(withoutTrailingSpaces))
  })

  it('produces a different hash for different content (basic collision avoidance)', () => {
    const hash1 = hashSourceAcSection('AC1: The system MUST do X')
    const hash2 = hashSourceAcSection('AC1: The system MUST do Y')
    expect(hash1).not.toBe(hash2)
  })

  it('handles empty input (after trimming) without throwing — returns a deterministic hex string', () => {
    // Empty string after trim should still produce a SHA-256 hash, not throw
    expect(() => hashSourceAcSection('')).not.toThrow()
    expect(() => hashSourceAcSection('   \n  ')).not.toThrow()
    const emptyHash = hashSourceAcSection('')
    const whitespaceHash = hashSourceAcSection('   \n  ')
    expect(emptyHash).toMatch(/^[0-9a-f]{64}$/)
    // Both normalize to empty string, so they hash to the same value
    expect(emptyHash).toBe(whitespaceHash)
  })
})
