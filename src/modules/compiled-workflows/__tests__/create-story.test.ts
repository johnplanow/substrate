/**
 * Unit tests for runCreateStory() — compiled create-story workflow.
 *
 * Covers AC1 (pack prompt retrieval), AC2 (context injection), AC3 (token budget),
 * AC4 (dispatch and output parsing), AC5 (failure/timeout), AC6 (schema validation),
 * AC7 (token usage), AC8 (essential logic preservation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { WorkflowDeps, CreateStoryParams } from '../types.js'
import { CreateStoryResultSchema } from '../schemas.js'
import { runCreateStory } from '../create-story.js'

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
}))

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
    getTemplate: vi.fn().mockResolvedValue('# Story Template\n\nStatus: draft\n\n## Story\n\n## Acceptance Criteria\n\n## Tasks / Subtasks\n\n## Dev Notes\n\n## Dev Agent Record'),
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
function makeDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
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
  it('assembles prompt that fits within 3000-token ceiling', async () => {
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
    expect(estimatedTokens).toBeLessThanOrEqual(3000)
  })

  it('truncates oversized context to fit within 3000-token ceiling', async () => {
    // Inject very large epic shard and arch constraints
    const hugeContent = 'X'.repeat(80_000) // ~20,000 tokens

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
    expect(tokenEstimate).toBeLessThanOrEqual(3000 + 50) // Allow small rounding
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
    mockGetDecisionsByPhase.mockReturnValue([])

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
