/**
 * Unit tests for the codergen handler (story 42-10).
 *
 * Covers:
 *   AC1 – prompt template interpolation ({{variable}} substitution)
 *   AC2 – model resolution via stylesheet
 *   AC3 – LLM invocation with resolved parameters
 *   AC4 – successful response mapped to SUCCESS outcome
 *   AC5 – transient LLM errors (429, timeout, network reset) → NEEDS_RETRY
 *   AC6 – non-transient errors → FAILURE
 *   AC7 – codergen handler is the default in createDefaultRegistry()
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// vi.mock is hoisted automatically by Vitest so the mock is in place before
// any module imports are resolved.
vi.mock('@substrate-ai/core', () => ({
  callLLM: vi.fn(),
}))

import { callLLM } from '@substrate-ai/core'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, ParsedStylesheet } from '../../graph/types.js'
import {
  createCodergenHandler,
  interpolatePrompt,
  isTransientError,
  resolveModel,
} from '../codergen-handler.js'
import { createDefaultRegistry } from '../registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cast the mock so we can call .mockResolvedValue / .mockRejectedValue */
const mockCallLLM = vi.mocked(callLLM)

/** Minimal node factory */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node1',
    label: '',
    shape: 'box',
    type: 'codergen',
    prompt: '',
    maxRetries: 0,
    goalGate: false,
    retryTarget: '',
    fallbackRetryTarget: '',
    fidelity: '',
    threadId: '',
    class: '',
    timeout: 0,
    llmModel: '',
    llmProvider: '',
    reasoningEffort: '',
    autoStatus: false,
    allowPartial: false,
    toolCommand: '',
    backend: '',
    ...overrides,
  }
}

/** Stub graph — not used by the codergen handler */
const stubGraph = {} as Graph

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// AC1 – Prompt template interpolation
// ---------------------------------------------------------------------------

describe('interpolatePrompt (AC1)', () => {
  it('replaces a single placeholder with the context value', () => {
    const ctx = new GraphContext({ name: 'Alice' })
    expect(interpolatePrompt('Hello {{name}}!', ctx)).toBe('Hello Alice!')
  })

  it('replaces multiple distinct placeholders', () => {
    const ctx = new GraphContext({ a: 'foo', b: 'bar' })
    expect(interpolatePrompt('{{a}} and {{b}}', ctx)).toBe('foo and bar')
  })

  it('replaces repeated occurrences of the same placeholder', () => {
    const ctx = new GraphContext({ x: 'X' })
    expect(interpolatePrompt('{{x}}{{x}}', ctx)).toBe('XX')
  })

  it('resolves missing keys to empty string without throwing', () => {
    const ctx = new GraphContext({})
    expect(interpolatePrompt('value={{missing}}', ctx)).toBe('value=')
  })

  it('leaves a template with no placeholders unchanged', () => {
    const ctx = new GraphContext({ x: 'ignored' })
    expect(interpolatePrompt('no placeholders here', ctx)).toBe('no placeholders here')
  })

  it('returns empty string for an empty template', () => {
    const ctx = new GraphContext({})
    expect(interpolatePrompt('', ctx)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// AC1 (continued) – node.prompt vs node.label fallback in the handler
// ---------------------------------------------------------------------------

describe('codergen handler – prompt source (AC1)', () => {
  it('uses node.prompt when non-empty', async () => {
    mockCallLLM.mockResolvedValue({ text: 'response' })
    const node = makeNode({ prompt: 'from prompt', label: 'from label' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'from prompt' })
    )
  })

  it('falls back to node.label when prompt is empty', async () => {
    mockCallLLM.mockResolvedValue({ text: 'response' })
    const node = makeNode({ prompt: '', label: 'from label' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'from label' })
    )
  })

  it('sends empty string when both prompt and label are empty', async () => {
    mockCallLLM.mockResolvedValue({ text: 'response' })
    const node = makeNode({ prompt: '', label: '' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '' })
    )
  })

  it('interpolates context variables in the prompt before calling the LLM', async () => {
    mockCallLLM.mockResolvedValue({ text: 'result' })
    const node = makeNode({ prompt: 'Generate {{thing}} for {{topic}}' })
    const ctx = new GraphContext({ thing: 'code', topic: 'sorting' })
    const handler = createCodergenHandler()
    await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Generate code for sorting' })
    )
  })
})

// ---------------------------------------------------------------------------
// AC2 – Model resolution via stylesheet
// ---------------------------------------------------------------------------

describe('resolveModel (AC2)', () => {
  it('uses system defaults when no options, node attributes, or stylesheet are provided', () => {
    const node = makeNode()
    const result = resolveModel(node)
    expect(result.llm_model).toBe('claude-sonnet-4-5')
    expect(result.llm_provider).toBe('anthropic')
    expect(result.reasoning_effort).toBe('medium')
  })

  it('uses option defaults when node attributes are absent', () => {
    const node = makeNode()
    const result = resolveModel(node, undefined, {
      defaultModel: 'opt-model',
      defaultProvider: 'opt-provider',
      defaultReasoningEffort: 'high',
    })
    expect(result.llm_model).toBe('opt-model')
    expect(result.llm_provider).toBe('opt-provider')
    expect(result.reasoning_effort).toBe('high')
  })

  it('uses stylesheet values when node attributes are absent', () => {
    const node = makeNode({ shape: 'box' })
    const stylesheet: ParsedStylesheet = [
      {
        selector: { type: 'shape', value: 'box', specificity: 1 },
        declarations: [
          { property: 'llm_model', value: 'sheet-model' },
          { property: 'llm_provider', value: 'sheet-provider' },
          { property: 'reasoning_effort', value: 'low' },
        ],
      },
    ]
    const result = resolveModel(node, stylesheet)
    expect(result.llm_model).toBe('sheet-model')
    expect(result.llm_provider).toBe('sheet-provider')
    expect(result.reasoning_effort).toBe('low')
  })

  it('node-level attributes override stylesheet values', () => {
    const node = makeNode({
      llmModel: 'node-model',
      llmProvider: 'node-provider',
      reasoningEffort: 'high',
      shape: 'box',
    })
    const stylesheet: ParsedStylesheet = [
      {
        selector: { type: 'shape', value: 'box', specificity: 1 },
        declarations: [
          { property: 'llm_model', value: 'sheet-model' },
          { property: 'llm_provider', value: 'sheet-provider' },
          { property: 'reasoning_effort', value: 'low' },
        ],
      },
    ]
    const result = resolveModel(node, stylesheet)
    expect(result.llm_model).toBe('node-model')
    expect(result.llm_provider).toBe('node-provider')
    expect(result.reasoning_effort).toBe('high')
  })

  it('stylesheet values override option defaults', () => {
    const node = makeNode({ shape: 'box' })
    const stylesheet: ParsedStylesheet = [
      {
        selector: { type: 'shape', value: 'box', specificity: 1 },
        declarations: [{ property: 'llm_model', value: 'sheet-model' }],
      },
    ]
    const result = resolveModel(node, stylesheet, { defaultModel: 'opt-model' })
    expect(result.llm_model).toBe('sheet-model')
  })
})

// ---------------------------------------------------------------------------
// AC3 + AC4 – LLM invocation and SUCCESS outcome
// ---------------------------------------------------------------------------

describe('codergen handler – success path (AC3, AC4)', () => {
  it('calls callLLM with the resolved model, provider, reasoning_effort, and prompt', async () => {
    mockCallLLM.mockResolvedValue({ text: 'generated output' })
    const node = makeNode({ id: 'n1', prompt: 'Do something' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledOnce()
    expect(mockCallLLM).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      reasoningEffort: 'medium',
      prompt: 'Do something',
    })
  })

  it('returns status SUCCESS on a successful LLM response', async () => {
    mockCallLLM.mockResolvedValue({ text: 'hello world' })
    const node = makeNode({ id: 'n1', prompt: 'test' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    const outcome = await handler(node, ctx, stubGraph)
    expect(outcome.status).toBe('SUCCESS')
  })

  it('puts the response text in outcome.notes', async () => {
    mockCallLLM.mockResolvedValue({ text: 'the response' })
    const node = makeNode({ id: 'n1', prompt: 'test' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    const outcome = await handler(node, ctx, stubGraph)
    expect(outcome.notes).toBe('the response')
  })

  it('stores response in contextUpdates under "nodeId_output"', async () => {
    mockCallLLM.mockResolvedValue({ text: 'the response' })
    const node = makeNode({ id: 'myNode', prompt: 'test' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    const outcome = await handler(node, ctx, stubGraph)
    expect(outcome.contextUpdates).toEqual({ myNode_output: 'the response' })
  })

  it('uses options.stylesheet when resolving the model', async () => {
    mockCallLLM.mockResolvedValue({ text: 'response' })
    const node = makeNode({ id: 'n1', prompt: 'test', shape: 'box' })
    const ctx = new GraphContext({})
    const stylesheet: ParsedStylesheet = [
      {
        selector: { type: 'shape', value: 'box', specificity: 1 },
        declarations: [{ property: 'llm_model', value: 'custom-model' }],
      },
    ]
    const handler = createCodergenHandler({ stylesheet })
    await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-model' })
    )
  })
})

// ---------------------------------------------------------------------------
// AC5 – Transient errors → NEEDS_RETRY
// ---------------------------------------------------------------------------

describe('codergen handler – transient error path (AC5)', () => {
  it('returns NEEDS_RETRY when LLM throws a 429 rate-limit error', async () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 })
    mockCallLLM.mockRejectedValue(err)
    const node = makeNode({ id: 'n1', prompt: 'test' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler()
    const outcome = await handler(node, ctx, stubGraph)
    expect(outcome.status).toBe('NEEDS_RETRY')
    expect(outcome.error).toBe(err)
  })

  it('returns NEEDS_RETRY for timeout errors', async () => {
    const err = new Error('Request timeout exceeded')
    mockCallLLM.mockRejectedValue(err)
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('NEEDS_RETRY')
  })

  it('returns NEEDS_RETRY for ETIMEDOUT errors', async () => {
    const err = new Error('ETIMEDOUT: connection timed out')
    mockCallLLM.mockRejectedValue(err)
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('NEEDS_RETRY')
  })

  it('returns NEEDS_RETRY for ECONNRESET errors', async () => {
    const err = new Error('ECONNRESET: connection reset by peer')
    mockCallLLM.mockRejectedValue(err)
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('NEEDS_RETRY')
  })
})

// ---------------------------------------------------------------------------
// AC6 – Non-transient errors → FAILURE
// ---------------------------------------------------------------------------

describe('codergen handler – non-transient error path (AC6)', () => {
  it('returns FAILURE for authentication errors', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })
    mockCallLLM.mockRejectedValue(err)
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('FAILURE')
    expect(outcome.error).toBe(err)
  })

  it('returns FAILURE for unknown errors', async () => {
    const err = new Error('Some unknown error')
    mockCallLLM.mockRejectedValue(err)
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('FAILURE')
  })

  it('returns FAILURE for non-Error thrown values', async () => {
    mockCallLLM.mockRejectedValue('string error')
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('FAILURE')
  })

  it('does not set error to undefined on FAILURE', async () => {
    const err = new Error('Bad request')
    mockCallLLM.mockRejectedValue(err)
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ prompt: 'test' }), new GraphContext({}), stubGraph)
    expect(outcome.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// isTransientError edge cases
// ---------------------------------------------------------------------------

describe('isTransientError', () => {
  it('returns true for status 429', () => {
    expect(isTransientError(Object.assign(new Error('rate limit'), { status: 429 }))).toBe(true)
  })

  it('returns true for statusCode 429', () => {
    expect(isTransientError(Object.assign(new Error('rate limit'), { statusCode: 429 }))).toBe(true)
  })

  it('returns true for message containing "timeout"', () => {
    expect(isTransientError(new Error('Request timeout'))).toBe(true)
  })

  it('returns true for message containing "ETIMEDOUT"', () => {
    expect(isTransientError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(true)
  })

  it('returns true for message containing "ECONNRESET"', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('returns true for message containing "ECONNREFUSED"', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:80'))).toBe(true)
  })

  it('returns false for a generic Error', () => {
    expect(isTransientError(new Error('Something went wrong'))).toBe(false)
  })

  it('returns false for status 401', () => {
    expect(isTransientError(Object.assign(new Error('unauthorized'), { status: 401 }))).toBe(false)
  })

  it('returns false for a plain string', () => {
    expect(isTransientError('network error')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isTransientError(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isTransientError(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC7 – createDefaultRegistry() routes to codergen handler
// ---------------------------------------------------------------------------

describe('createDefaultRegistry – codergen routing (AC7)', () => {
  it('resolves type="codergen" to a handler function', async () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'codergen', shape: '' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('resolves shape="box" to a handler function', async () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: '', shape: 'box' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('resolves an unrecognised node to a handler function via default', async () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'unknown-type', shape: 'unknown-shape' })
    const handler = registry.resolve(node)
    expect(typeof handler).toBe('function')
  })

  it('codergen handler returns SUCCESS outcome when invoked (smoke test)', async () => {
    mockCallLLM.mockResolvedValue({ text: 'smoke test response' })
    const registry = createDefaultRegistry()
    const node = makeNode({ id: 'smoke', type: 'codergen', prompt: 'Hello' })
    const handler = registry.resolve(node)
    const outcome = await handler(node, new GraphContext({}), stubGraph)
    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates).toEqual({ smoke_output: 'smoke test response' })
  })
})

// ---------------------------------------------------------------------------
// AC5 (story 48-10) – node-level directBackend routing
// ---------------------------------------------------------------------------

describe('codergen handler – directBackend routing (AC5, story 48-10)', () => {
  it('invokes directBackend.run() when node.backend==="direct" and directBackend is set', async () => {
    const directRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const directBackend = { run: directRun }
    const node = makeNode({ id: 'n1', prompt: 'task', backend: 'direct' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler({ directBackend })
    const outcome = await handler(node, ctx, stubGraph)
    expect(directRun).toHaveBeenCalledOnce()
    expect(directRun).toHaveBeenCalledWith(node, 'task', ctx)
    expect(mockCallLLM).not.toHaveBeenCalled()
    expect(outcome.status).toBe('SUCCESS')
  })

  it('uses callLLM when node.backend==="" even if directBackend is set', async () => {
    mockCallLLM.mockResolvedValue({ text: 'llm response' })
    const directRun = vi.fn()
    const directBackend = { run: directRun }
    const node = makeNode({ id: 'n2', prompt: 'task', backend: '' })
    const ctx = new GraphContext({})
    const handler = createCodergenHandler({ directBackend })
    const outcome = await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledOnce()
    expect(directRun).not.toHaveBeenCalled()
    expect(outcome.status).toBe('SUCCESS')
  })

  it('falls through to callLLM when node.backend==="direct" but directBackend is NOT set', async () => {
    mockCallLLM.mockResolvedValue({ text: 'fallback response' })
    const node = makeNode({ id: 'n3', prompt: 'task', backend: 'direct' })
    const ctx = new GraphContext({})
    // No directBackend in options
    const handler = createCodergenHandler()
    const outcome = await handler(node, ctx, stubGraph)
    expect(mockCallLLM).toHaveBeenCalledOnce()
    expect(outcome.status).toBe('SUCCESS')
  })

  it('interpolates the prompt before passing it to directBackend.run()', async () => {
    const directRun = vi.fn().mockResolvedValue({ status: 'SUCCESS' as const })
    const directBackend = { run: directRun }
    const node = makeNode({ id: 'n4', prompt: 'Hello {{name}}', backend: 'direct' })
    const ctx = new GraphContext({ name: 'World' })
    const handler = createCodergenHandler({ directBackend })
    await handler(node, ctx, stubGraph)
    expect(directRun).toHaveBeenCalledWith(node, 'Hello World', ctx)
  })
})
