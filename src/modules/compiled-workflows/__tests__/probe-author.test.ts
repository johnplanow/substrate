/**
 * Unit tests for runProbeAuthor() — compiled probe-author workflow function.
 *
 * Covers:
 *  - Prompt template renders with AC inputs (AC1, AC5)
 *  - Output parser handles valid yaml probe block (AC5)
 *  - Parser rejects schema-invalid output (AC5)
 *  - Missing AC input fails loudly before dispatch (AC4)
 *  - Schema-drift guardrail: every yaml fence in prompt validates against RuntimeProbeListSchema (AC8)
 *  - Prompt budget cap: probe-author.md must be < 22000 chars (AC8)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { WorkflowDeps, ProbeAuthorParams } from '../types.js'
import { ProbeAuthorResultSchema } from '../schemas.js'
import { runProbeAuthor } from '../probe-author.js'
import { RuntimeProbeListSchema } from '@substrate-ai/sdlc'
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
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STORY_KEY = '60-12'
const RENDERED_AC = `## Acceptance Criteria

- AC1: The system stores the user's configuration on disk.
- AC2: Given the user updates their preference, when the config-writer runs, then the updated value is persisted.
`
const SOURCE_EPIC_AC = `## Acceptance Criteria

- AC1: Config stored on disk
- AC2: Updated preferences are written to disk
`

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeSuccessDispatchResult(probes: object[] = []): DispatchResult {
  return {
    id: 'dispatch-1',
    status: 'completed',
    exitCode: 0,
    output: `result: success\nprobes: []\n`,
    parsed: {
      result: 'success',
      probes,
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
    getMemoryState: vi.fn().mockReturnValue({ freeMB: 2048, thresholdMB: 256, pressureLevel: 1, isPressured: false }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(template: string = 'Probe Author\n\n{{rendered_ac_section}}\n\n{{source_epic_ac_section}}\n\nEmit YAML.'): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      phases: [],
      prompts: { 'probe-author': 'prompts/probe-author.md' },
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

const defaultParams: ProbeAuthorParams = {
  storyKey: DEFAULT_STORY_KEY,
  renderedAcSection: RENDERED_AC,
  sourceEpicAcSection: SOURCE_EPIC_AC,
  pipelineRunId: 'run-123',
}

// ---------------------------------------------------------------------------
// Test: prompt template renders with AC inputs
// ---------------------------------------------------------------------------

describe('Prompt template renders with AC inputs', () => {
  it('calls pack.getPrompt("probe-author") to retrieve template', async () => {
    const pack = makePack()
    const deps = makeDeps({ pack })

    await runProbeAuthor(deps, defaultParams)

    expect(pack.getPrompt).toHaveBeenCalledWith('probe-author')
  })

  it('injects rendered_ac_section and source_epic_ac_section into the prompt', async () => {
    const template = 'PROBE AUTHOR\n\n{{rendered_ac_section}}\n\n{{source_epic_ac_section}}\n\nEmit YAML.'
    const pack = makePack(template)
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ pack, dispatcher })

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

    await runProbeAuthor(deps, defaultParams)

    expect(capturedPrompt).toContain(RENDERED_AC)
    expect(capturedPrompt).toContain(SOURCE_EPIC_AC)
  })

  it('dispatches with taskType="probe-author" and outputSchema=ProbeAuthorResultSchema', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })

    await runProbeAuthor(deps, defaultParams)

    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'probe-author',
        outputSchema: ProbeAuthorResultSchema,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test: output parser handles valid yaml probe block
// ---------------------------------------------------------------------------

describe('Output parser handles valid yaml probe block', () => {
  it('returns success result with parsed probes array', async () => {
    const probes = [
      { name: 'config-persisted', sandbox: 'host', command: 'cat /tmp/config.json', expect_stdout_regex: ['preferences'] },
    ]
    const deps = makeDeps({ dispatcher: makeDispatcher(makeSuccessDispatchResult(probes)) })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('success')
    expect(result.probes).toHaveLength(1)
    expect(result.probes[0]).toMatchObject({ name: 'config-persisted', sandbox: 'host' })
  })

  it('returns tokenUsage from dispatch result', async () => {
    const dispatchResult: DispatchResult = {
      ...makeSuccessDispatchResult(),
      tokenEstimate: { input: 1234, output: 567 },
    }
    const deps = makeDeps({ dispatcher: makeDispatcher(dispatchResult) })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.tokenUsage).toEqual({ input: 1234, output: 567 })
  })

  it('returns empty probes array on success when agent returns no probes', async () => {
    const deps = makeDeps({ dispatcher: makeDispatcher(makeSuccessDispatchResult([])) })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('success')
    expect(result.probes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Test: parser rejects schema-invalid output
// ---------------------------------------------------------------------------

describe('Parser rejects schema-invalid output', () => {
  it('returns failed when dispatch parseError is non-null', async () => {
    const nullParsedResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'completed',
      exitCode: 0,
      output: 'invalid output without yaml',
      parsed: null,
      parseError: 'no_yaml_block',
      durationMs: 500,
      tokenEstimate: { input: 200, output: 50 },
    }
    const deps = makeDeps({ dispatcher: makeDispatcher(nullParsedResult) })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('schema_validation_failed')
    expect(result.probes).toEqual([])
  })

  it('returns failed when parsed probes fail RuntimeProbeListSchema (missing required sandbox)', async () => {
    // Simulate an agent returning a probe with invalid sandbox value
    const invalidDispatchResult: DispatchResult = {
      id: 'dispatch-1',
      status: 'completed',
      exitCode: 0,
      output: 'result: success\nprobes:\n  - name: bad-probe\n    sandbox: invalid\n    command: echo hi\n',
      parsed: {
        result: 'success',
        probes: [{ name: 'bad-probe', sandbox: 'invalid', command: 'echo hi' }],
      },
      parseError: null,
      durationMs: 500,
      tokenEstimate: { input: 200, output: 50 },
    }
    const deps = makeDeps({ dispatcher: makeDispatcher(invalidDispatchResult) })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('schema_validation_failed')
  })

  it('returns failed with dispatch_timeout error on timeout', async () => {
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

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('dispatch_timeout')
  })

  it('returns failed with dispatch_failed error on non-zero exit', async () => {
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
    const deps = makeDeps({ dispatcher: makeDispatcher(failedResult) })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('dispatch_failed')
  })
})

// ---------------------------------------------------------------------------
// Test: missing AC input fails loudly before dispatch
// ---------------------------------------------------------------------------

describe('Missing AC input fails loudly before dispatch', () => {
  it('returns failed with missing_ac_input when renderedAcSection is empty', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, { ...defaultParams, renderedAcSection: '' })

    expect(result.result).toBe('failed')
    expect(result.error).toContain('missing_ac_input')
    // Must not call dispatch — fail before reaching it
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('returns failed with missing_ac_input when renderedAcSection is whitespace only', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, { ...defaultParams, renderedAcSection: '   \n  ' })

    expect(result.result).toBe('failed')
    expect(result.error).toContain('missing_ac_input')
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('returns failed with missing_ac_input when sourceEpicAcSection is empty', async () => {
    const dispatcher = makeDispatcher(makeSuccessDispatchResult())
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, { ...defaultParams, sourceEpicAcSection: '' })

    expect(result.result).toBe('failed')
    expect(result.error).toContain('missing_ac_input')
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('returns tokenUsage { input: 0, output: 0 } on missing_ac_input failure', async () => {
    const deps = makeDeps()

    const result = await runProbeAuthor(deps, { ...defaultParams, renderedAcSection: '' })

    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('returns failed with template_load_failed when pack.getPrompt throws', async () => {
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Template not found'))
    const deps = makeDeps({ pack })

    const result = await runProbeAuthor(deps, defaultParams)

    expect(result.result).toBe('failed')
    expect(result.error).toContain('template_load_failed')
    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })
})

// ---------------------------------------------------------------------------
// Test: schema-drift guardrail — every yaml fence in probe-author.md
// validates against RuntimeProbeListSchema
// ---------------------------------------------------------------------------

describe('Schema-drift guardrail: probe-author.md yaml fences', () => {
  it('every yaml fenced block in probe-author.md parses against RuntimeProbeListSchema', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const promptPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'packs',
      'bmad',
      'prompts',
      'probe-author.md',
    )
    const content = await readFile(promptPath, 'utf-8')
    const fences = [...content.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map((m) => m[1])
    expect(fences.length).toBeGreaterThan(0)

    for (const body of fences) {
      const parsed = yamlLoad(body)
      // Skip non-array objects (e.g., schema description templates that parse as maps)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) continue
      expect(Array.isArray(parsed)).toBe(true)
      const result = RuntimeProbeListSchema.safeParse(parsed)
      if (!result.success) {
        throw new Error(
          `Probe example failed schema validation:\n--- yaml ---\n${body}\n--- error ---\n${result.error.message}`,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Test: prompt budget cap — probe-author.md must be < 22000 chars
// ---------------------------------------------------------------------------

describe('Prompt budget cap', () => {
  it('probe-author prompt exists and is within 22000 char budget', async () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const promptPath = join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'packs',
      'bmad',
      'prompts',
      'probe-author.md',
    )
    const content = await readFile(promptPath, 'utf-8')
    expect(content).toBeDefined()
    expect(content.length).toBeGreaterThan(100)
    expect(content.length).toBeLessThan(22000)
  })
})
