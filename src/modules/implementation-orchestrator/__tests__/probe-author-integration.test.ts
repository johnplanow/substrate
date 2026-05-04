/**
 * Unit tests for probe-author-integration.ts — Story 60-13.
 *
 * Covers:
 *  1. Event-driven AC + no probes → probe-author dispatches
 *  2. Non-event-driven AC → skip (result 'skipped', no dispatch)
 *  3. Story artifact already has ## Runtime Probes → skip
 *  4. Idempotent append — calling twice on same file does not duplicate section
 *  5. Telemetry event probe-author:dispatched emitted with correct shape
 *  6. Dispatch error → probe-author:dispatch-error event, result 'failed' (no throw)
 *  7. Timeout → probe-author:timeout event, 1.5× retry, fall-through on second timeout
 *  8. Invalid YAML → probe-author:invalid-output event with parse error + 500 chars,
 *     retry with augmented prompt, fall-through on second failure
 *  9. Empty probes list → probe-author:no-probes-authored info event, no retry
 * 10. Smoke test: event-driven AC → artifact gains ## Runtime Probes section
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkflowDeps } from '../../compiled-workflows/types.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { runProbeAuthor } from '../probe-author-integration.js'

// ---------------------------------------------------------------------------
// Mock logger so tests don't spam output
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
// Constants and fixtures
// ---------------------------------------------------------------------------

const STORY_KEY = '60-13'
const PIPELINE_RUN_ID = 'run-test-60-13'

/** Epic content that IS event-driven (contains post-merge hook reference) */
const EVENT_DRIVEN_EPIC_CONTENT = `
## Story 60-13: Post-Merge Conflict Resolution

### Acceptance Criteria

- AC1: When the post-merge git hook fires after a conflict, the resolver runs
- AC2: Given a merge conflict, when the hook fires, then conflict markers are removed
`

/** Epic content that is NOT event-driven (no hooks/timers/signals/webhooks) */
const NON_EVENT_DRIVEN_EPIC_CONTENT = `
## Story 60-13: Config Writer

### Acceptance Criteria

- AC1: Config is written to disk on save
- AC2: The config file contains the user's preferences
`

/** Story artifact without ## Runtime Probes */
const STORY_ARTIFACT_WITHOUT_PROBES = `# Story 60-13: Post-Merge Conflict Resolution

Status: ready-for-dev

## Story
As a developer, I want conflict resolution.

## Acceptance Criteria

- AC1: When the post-merge hook fires, conflict is resolved
`

/** Story artifact with existing ## Runtime Probes section */
const STORY_ARTIFACT_WITH_PROBES = `${STORY_ARTIFACT_WITHOUT_PROBES}
## Runtime Probes

\`\`\`yaml
- name: existing-probe
  sandbox: twin
  command: git merge test-branch
\`\`\`
`

/** Valid probe returned by a successful dispatch */
const VALID_PROBE = {
  name: 'hook-fires-and-resolves',
  sandbox: 'twin',
  command: 'git merge test-branch',
  description: 'Merge fires post-merge hook',
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeDispatchResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    id: 'dispatch-1',
    status: 'completed',
    exitCode: 0,
    output: 'result: success\nprobes:\n  - name: hook-fires-and-resolves\n    sandbox: twin\n    command: git merge test-branch\n',
    parsed: {
      result: 'success',
      probes: [VALID_PROBE],
    },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 500, output: 100 },
    ...overrides,
  }
}

function makeDispatcher(resultOrFn: DispatchResult | (() => Promise<DispatchResult>) | (() => DispatchResult) = makeDispatchResult()): Dispatcher {
  const resultPromise =
    typeof resultOrFn === 'function'
      ? resultOrFn()
      : Promise.resolve(resultOrFn)

  const resultP = typeof resultPromise === 'object' && 'then' in resultPromise
    ? (resultPromise as Promise<DispatchResult>)
    : Promise.resolve(resultPromise as DispatchResult)

  const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
    id: 'dispatch-1',
    status: 'queued',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: resultP,
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({
      freeMB: 2048,
      thresholdMB: 256,
      pressureLevel: 1,
      isPressured: false,
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Build a dispatcher that returns different results on successive calls.
 * Used for timeout-retry and invalid-YAML-retry tests.
 */
function makeSequentialDispatcher(results: DispatchResult[]): Dispatcher {
  let callCount = 0
  const dispatch = vi.fn().mockImplementation(() => {
    const result = results[callCount] ?? results.at(-1)!
    callCount++
    const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
      id: `dispatch-${callCount}`,
      status: 'queued',
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(result),
    }
    return handle
  })
  return {
    dispatch,
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({
      freeMB: 2048,
      thresholdMB: 256,
      pressureLevel: 1,
      isPressured: false,
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(template = 'PROBE AUTHOR\n\n{{rendered_ac_section}}\n\n{{source_epic_ac_section}}\n\nEmit YAML.'): MethodologyPack {
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
    dispatcher: makeDispatcher(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test setup: temp directory
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'probe-author-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function createStoryFile(content: string): Promise<string> {
  const filePath = join(tmpDir, `${STORY_KEY}-test-story.md`)
  await writeFile(filePath, content, 'utf-8')
  return filePath
}

// ---------------------------------------------------------------------------
// Test 1: event-driven AC + no probes → probe-author dispatches
// ---------------------------------------------------------------------------

describe('event-driven AC + no existing probes → probe-author dispatches', () => {
  it('calls dispatcher.dispatch when AC is event-driven and no probes exist', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const dispatcher = makeDispatcher()
    const deps = makeDeps({ dispatcher })

    await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(dispatcher.dispatch).toHaveBeenCalledOnce()
    expect(dispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'probe-author',
        storyKey: STORY_KEY,
      }),
    )
  })

  it('returns result success with probesAuthoredCount when dispatch succeeds', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const deps = makeDeps({ dispatcher: makeDispatcher(makeDispatchResult()) })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.result).toBe('success')
    expect(result.probesAuthoredCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Test 2: non-event-driven AC → skip
// ---------------------------------------------------------------------------

describe('non-event-driven AC → skip', () => {
  it('returns result skipped without calling dispatcher when AC is not event-driven', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const dispatcher = makeDispatcher()
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: NON_EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: NON_EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.result).toBe('skipped')
    expect(result.probesAuthoredCount).toBe(0)
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('returns zero tokenUsage on skip', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const deps = makeDeps()

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: NON_EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: NON_EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.tokenUsage).toEqual({ input: 0, output: 0 })
  })
})

// ---------------------------------------------------------------------------
// Test 3: story artifact already has ## Runtime Probes → skip
// ---------------------------------------------------------------------------

describe('story artifact already has ## Runtime Probes → skip', () => {
  it('returns result skipped without dispatching when probes section exists', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITH_PROBES)
    const dispatcher = makeDispatcher()
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.result).toBe('skipped')
    expect(result.probesAuthoredCount).toBe(0)
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Test 4: idempotent append — calling probe-author twice does not duplicate
// ---------------------------------------------------------------------------

describe('idempotent append — calling twice does not duplicate section', () => {
  it('does not create a second ## Runtime Probes section on a second run', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const deps = makeDeps({ dispatcher: makeDispatcher(makeDispatchResult()) })

    // First run: appends the section
    await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    // Second run: should detect existing section and skip
    const secondDeps = makeDeps({ dispatcher: makeDispatcher() })
    const secondResult = await runProbeAuthor(secondDeps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    // Second run returns skipped (no dispatch on second call)
    expect(secondResult.result).toBe('skipped')
    expect(secondDeps.dispatcher.dispatch).not.toHaveBeenCalled()

    // File must have exactly one ## Runtime Probes heading
    const finalContent = await readFile(storyFilePath, 'utf-8')
    const probeHeadings = (finalContent.match(/^## Runtime Probes/gm) ?? []).length
    expect(probeHeadings).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Test 5: telemetry event probe-author:dispatched emitted with correct shape
// ---------------------------------------------------------------------------

describe('telemetry event probe-author:dispatched emitted with correct shape', () => {
  it('calls emitEvent with probe-author:dispatched and correct payload fields', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const emitEvent = vi.fn()
    const deps = makeDeps({ dispatcher: makeDispatcher(makeDispatchResult()) })

    await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      emitEvent,
    })

    expect(emitEvent).toHaveBeenCalledWith(
      'probe-author:dispatched',
      expect.objectContaining({
        storyKey: STORY_KEY,
        runId: PIPELINE_RUN_ID,
        probesAuthoredCount: expect.any(Number),
        dispatchDurationMs: expect.any(Number),
        costUsd: expect.any(Number),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 6: dispatch error → probe-author:dispatch-error event, result 'failed'
// ---------------------------------------------------------------------------

describe('dispatch error → probe-author:dispatch-error event, result failed (no throw)', () => {
  it('returns result failed and emits dispatch-error event on dispatcher throw', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const emitEvent = vi.fn()

    // Make dispatcher.dispatch throw
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(() => {
        const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
          id: 'dispatch-1',
          status: 'queued',
          cancel: vi.fn().mockResolvedValue(undefined),
          result: Promise.reject(new Error('process crashed')),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      getMemoryState: vi.fn().mockReturnValue({ freeMB: 2048, thresholdMB: 256, pressureLevel: 1, isPressured: false }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      emitEvent,
    })

    expect(result.result).toBe('failed')
    expect(result.error).toContain('dispatch_error')
    expect(result.probesAuthoredCount).toBe(0)
    expect(emitEvent).toHaveBeenCalledWith(
      'probe-author:dispatch-error',
      expect.objectContaining({ storyKey: STORY_KEY, runId: PIPELINE_RUN_ID }),
    )
  })

  it('does not throw even on dispatch error', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(() => ({
        id: 'd1',
        status: 'queued',
        cancel: vi.fn(),
        result: Promise.reject(new Error('network failure')),
      })),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      getMemoryState: vi.fn().mockReturnValue({ freeMB: 2048, thresholdMB: 256, pressureLevel: 1, isPressured: false }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps({ dispatcher })

    // Must not throw
    await expect(
      runProbeAuthor(deps, {
        storyKey: STORY_KEY,
        storyFilePath,
        pipelineRunId: PIPELINE_RUN_ID,
        sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
        epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      }),
    ).resolves.toMatchObject({ result: 'failed' })
  })
})

// ---------------------------------------------------------------------------
// Test 7: timeout → probe-author:timeout event, single 1.5× retry, fall-through
// ---------------------------------------------------------------------------

describe('timeout → probe-author:timeout event, single 1.5× retry, fall-through on second timeout', () => {
  it('emits probe-author:timeout on first timeout and retries with extended timeout', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const emitEvent = vi.fn()

    const timeoutResult = makeDispatchResult({
      status: 'timeout',
      exitCode: -1,
      parsed: null,
      parseError: 'timed out',
      durationMs: 300_000,
      tokenEstimate: { input: 200, output: 0 },
    })
    const successResult = makeDispatchResult()
    const dispatcher = makeSequentialDispatcher([timeoutResult, successResult])
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      emitEvent,
    })

    // Should have been called twice (first attempt + retry)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)

    // Second call should use 1.5× timeout. obs_2026-05-04_023 layer 2:
    // default raised 300_000 → 600_000, so retry is 600_000 * 1.5 = 900_000.
    const firstCallArgs = vi.mocked(dispatcher.dispatch).mock.calls[0]![0]
    const secondCallArgs = vi.mocked(dispatcher.dispatch).mock.calls[1]![0]
    expect(firstCallArgs.timeout).toBe(600_000)
    expect(secondCallArgs.timeout).toBeCloseTo(900_000, -3) // 600_000 * 1.5

    // Should emit the timeout event
    expect(emitEvent).toHaveBeenCalledWith(
      'probe-author:timeout',
      expect.objectContaining({ storyKey: STORY_KEY, runId: PIPELINE_RUN_ID }),
    )

    // Retry succeeded → overall success
    expect(result.result).toBe('success')
  })

  it('falls through when retry also times out', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const emitEvent = vi.fn()

    const timeoutResult = makeDispatchResult({
      status: 'timeout',
      exitCode: -1,
      parsed: null,
      parseError: 'timed out',
      durationMs: 300_000,
      tokenEstimate: { input: 200, output: 0 },
    })
    const dispatcher = makeSequentialDispatcher([timeoutResult, timeoutResult])
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      emitEvent,
    })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('dispatch_timeout')
  })
})

// ---------------------------------------------------------------------------
// Test 8: invalid YAML → retry with augmented prompt, fall-through
// ---------------------------------------------------------------------------

describe('invalid YAML → probe-author:invalid-output event + retry with augmented prompt', () => {
  it('emits probe-author:invalid-output with parseError and first 500 chars on parse failure', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const emitEvent = vi.fn()

    const badOutput = 'x'.repeat(600) // output longer than 500 chars
    const invalidResult = makeDispatchResult({
      status: 'completed',
      exitCode: 0,
      output: badOutput,
      parsed: null,
      parseError: 'Schema validation error: required field missing',
    })
    const successResult = makeDispatchResult()
    const dispatcher = makeSequentialDispatcher([invalidResult, successResult])
    const deps = makeDeps({ dispatcher })

    await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      emitEvent,
    })

    expect(emitEvent).toHaveBeenCalledWith(
      'probe-author:invalid-output',
      expect.objectContaining({
        storyKey: STORY_KEY,
        runId: PIPELINE_RUN_ID,
        parseError: 'Schema validation error: required field missing',
        rawOutputSnippet: badOutput.slice(0, 500), // exactly first 500 chars
      }),
    )
  })

  it('retries with augmented prompt containing the parse error', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)

    const parseError = 'Schema validation error: sandbox is required'
    const invalidResult = makeDispatchResult({
      status: 'completed',
      exitCode: 0,
      output: 'bad yaml output',
      parsed: null,
      parseError,
    })
    const successResult = makeDispatchResult()
    const dispatcher = makeSequentialDispatcher([invalidResult, successResult])
    const deps = makeDeps({ dispatcher })

    await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    // Second dispatch should use augmented prompt
    const secondCallArgs = vi.mocked(dispatcher.dispatch).mock.calls[1]![0]
    expect(secondCallArgs.prompt).toContain('Previous output failed parsing with')
    expect(secondCallArgs.prompt).toContain(parseError)
    expect(secondCallArgs.prompt).toContain('RuntimeProbeListSchema')
  })

  it('falls through when retry also produces invalid YAML', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)

    const invalidResult = makeDispatchResult({
      status: 'completed',
      exitCode: 0,
      output: 'still invalid',
      parsed: null,
      parseError: 'still invalid',
    })
    const dispatcher = makeSequentialDispatcher([invalidResult, invalidResult])
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('invalid_yaml_after_retry')
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Test 9: empty probes list → no-probes-authored event, no retry, fall-through
// ---------------------------------------------------------------------------

describe('empty probes list → probe-author:no-probes-authored info event, no retry', () => {
  it('emits probe-author:no-probes-authored and returns success with 0 probes', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const emitEvent = vi.fn()

    const emptyProbesResult = makeDispatchResult({
      output: 'result: success\nprobes: []\n',
      parsed: { result: 'success', probes: [] },
    })
    const dispatcher = makeDispatcher(emptyProbesResult)
    const deps = makeDeps({ dispatcher })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
      emitEvent,
    })

    expect(result.result).toBe('success')
    expect(result.probesAuthoredCount).toBe(0)
    expect(emitEvent).toHaveBeenCalledWith(
      'probe-author:no-probes-authored',
      expect.objectContaining({ storyKey: STORY_KEY, runId: PIPELINE_RUN_ID }),
    )
    // Only dispatched once (no retry)
    expect(dispatcher.dispatch).toHaveBeenCalledOnce()

    // File should NOT gain a ## Runtime Probes section for empty list
    const fileContent = await readFile(storyFilePath, 'utf-8')
    expect(fileContent).not.toContain('## Runtime Probes')
  })
})

// ---------------------------------------------------------------------------
// Test 10: smoke test — event-driven AC → artifact gains ## Runtime Probes
// ---------------------------------------------------------------------------

describe('smoke test: event-driven AC → artifact file gains ## Runtime Probes with probe entries', () => {
  it('appends a valid ## Runtime Probes section with probe entries to the story file', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const deps = makeDeps({ dispatcher: makeDispatcher(makeDispatchResult()) })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.result).toBe('success')
    expect(result.probesAuthoredCount).toBeGreaterThan(0)

    const finalContent = await readFile(storyFilePath, 'utf-8')
    expect(finalContent).toContain('## Runtime Probes')

    // The section must contain a yaml fenced block with valid probe entries
    const probesMatch = finalContent.match(/^## Runtime Probes\s*\n+```yaml\n([\s\S]*?)```/m)
    expect(probesMatch).toBeTruthy()

    // The probe YAML must parse correctly
    const { load } = await import('js-yaml')
    const probesRaw = load(probesMatch![1]!)
    expect(Array.isArray(probesRaw)).toBe(true)
    expect((probesRaw as object[]).length).toBeGreaterThan(0)
    const firstProbe = (probesRaw as Record<string, unknown>[])[0]!
    expect(firstProbe).toHaveProperty('name')
    expect(firstProbe).toHaveProperty('sandbox')
    expect(firstProbe).toHaveProperty('command')
  })

  it('returns tokenUsage from dispatch result', async () => {
    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const dispatchResult = makeDispatchResult({ tokenEstimate: { input: 1234, output: 567 } })
    const deps = makeDeps({ dispatcher: makeDispatcher(dispatchResult) })

    const result = await runProbeAuthor(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    expect(result.tokenUsage).toEqual({ input: 1234, output: 567 })
  })
})

// ---------------------------------------------------------------------------
// obs_2026-05-04_023 layer 2: SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS env-var override
// ---------------------------------------------------------------------------

describe('SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS env-var override (obs_023 layer 2)', () => {
  const ENV_KEY = 'SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS'
  let originalEnvValue: string | undefined

  beforeEach(() => {
    originalEnvValue = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
    vi.resetModules()
  })

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnvValue
    }
    vi.resetModules()
  })

  it('reads SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS at module load and uses it for the initial dispatch', async () => {
    process.env[ENV_KEY] = '720000'

    // Re-import with the env var now set so DEFAULT_TIMEOUT_MS resolves to 720_000.
    const { runProbeAuthor: runProbeAuthorWithOverride } = await import(
      '../probe-author-integration.js'
    )

    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const dispatchResult = makeDispatchResult()
    const dispatcher = makeDispatcher(dispatchResult)
    const deps = makeDeps({ dispatcher })

    await runProbeAuthorWithOverride(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    const firstCallArgs = vi.mocked(dispatcher.dispatch).mock.calls[0]![0]
    expect(firstCallArgs.timeout).toBe(720_000)
  })

  it('default of 600_000 ms applies when env var is unset', async () => {
    // Env var deliberately unset in beforeEach.
    const { runProbeAuthor: runProbeAuthorDefault } = await import(
      '../probe-author-integration.js'
    )

    const storyFilePath = await createStoryFile(STORY_ARTIFACT_WITHOUT_PROBES)
    const dispatchResult = makeDispatchResult()
    const dispatcher = makeDispatcher(dispatchResult)
    const deps = makeDeps({ dispatcher })

    await runProbeAuthorDefault(deps, {
      storyKey: STORY_KEY,
      storyFilePath,
      pipelineRunId: PIPELINE_RUN_ID,
      sourceAcContent: EVENT_DRIVEN_EPIC_CONTENT,
      epicContent: EVENT_DRIVEN_EPIC_CONTENT,
    })

    const firstCallArgs = vi.mocked(dispatcher.dispatch).mock.calls[0]![0]
    expect(firstCallArgs.timeout).toBe(600_000)
  })
})
