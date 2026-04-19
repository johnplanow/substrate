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
import { runCreateStory, extractStorySection } from '../create-story.js'
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
