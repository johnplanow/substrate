/**
 * Unit tests for HandlerRegistry and built-in handlers (story 42-9).
 *
 * Covers:
 *   AC1  – handler lookup by explicit type
 *   AC2  – shape-based fallback when type is absent
 *   AC3  – default handler for unrecognized nodes
 *   AC4  – startHandler returns SUCCESS with no side effects
 *   AC5  – exitHandler returns SUCCESS with no side effects
 *   AC6  – conditionalHandler returns SUCCESS and defers routing
 *   AC7  – dynamic registration and override
 */

import { describe, it, expect, vi } from 'vitest'
import { startHandler } from '../start.js'
import { exitHandler } from '../exit.js'
import { conditionalHandler } from '../conditional.js'
import { HandlerRegistry, createDefaultRegistry } from '../registry.js'
import { GraphContext } from '../../graph/context.js'
import type { GraphNode, Graph, IGraphContext } from '../../graph/types.js'
import type { NodeHandler } from '../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal node factory — only sets the fields needed for resolution tests. */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'test-node',
    label: '',
    shape: '',
    type: '',
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
    ...overrides,
  }
}

/** Minimal Graph stub — not needed by handlers but required by the signature. */
const stubGraph = {} as Graph

/** Empty context for use in handler invocations. */
function makeContext(initial?: Record<string, unknown>): IGraphContext {
  return new GraphContext(initial)
}

// ---------------------------------------------------------------------------
// AC4 – startHandler returns SUCCESS with no side effects
// ---------------------------------------------------------------------------

describe('startHandler (AC4)', () => {
  it('returns an Outcome with status SUCCESS', async () => {
    const ctx = makeContext()
    const result = await startHandler(makeNode({ type: 'start' }), ctx, stubGraph)
    expect(result.status).toBe('SUCCESS')
  })

  it('contextUpdates is absent (no side effects)', async () => {
    const ctx = makeContext()
    const result = await startHandler(makeNode({ type: 'start' }), ctx, stubGraph)
    expect(result.contextUpdates).toBeUndefined()
  })

  it('does not mutate the context', async () => {
    const ctx = makeContext({ existing: 'value' })
    const snapshotBefore = ctx.snapshot()
    await startHandler(makeNode(), ctx, stubGraph)
    expect(ctx.snapshot()).toEqual(snapshotBefore)
  })

  it('is async (returns a Promise)', async () => {
    const promise = startHandler(makeNode(), makeContext(), stubGraph)
    expect(promise).toBeInstanceOf(Promise)
    await promise
  })
})

// ---------------------------------------------------------------------------
// AC5 – exitHandler returns SUCCESS with no side effects
// ---------------------------------------------------------------------------

describe('exitHandler (AC5)', () => {
  it('returns an Outcome with status SUCCESS', async () => {
    const ctx = makeContext()
    const result = await exitHandler(makeNode({ type: 'exit' }), ctx, stubGraph)
    expect(result.status).toBe('SUCCESS')
  })

  it('contextUpdates is absent (no side effects)', async () => {
    const ctx = makeContext()
    const result = await exitHandler(makeNode({ type: 'exit' }), ctx, stubGraph)
    expect(result.contextUpdates).toBeUndefined()
  })

  it('does not mutate the context', async () => {
    const ctx = makeContext({ existing: 'value' })
    const snapshotBefore = ctx.snapshot()
    await exitHandler(makeNode(), ctx, stubGraph)
    expect(ctx.snapshot()).toEqual(snapshotBefore)
  })

  it('is async (returns a Promise)', async () => {
    const promise = exitHandler(makeNode(), makeContext(), stubGraph)
    expect(promise).toBeInstanceOf(Promise)
    await promise
  })
})

// ---------------------------------------------------------------------------
// AC6 – conditionalHandler returns SUCCESS and defers routing
// ---------------------------------------------------------------------------

describe('conditionalHandler (AC6)', () => {
  it('returns an Outcome with status SUCCESS', async () => {
    const ctx = makeContext()
    const result = await conditionalHandler(makeNode({ type: 'conditional' }), ctx, stubGraph)
    expect(result.status).toBe('SUCCESS')
  })

  it('does not set suggestedNextIds (routing delegated to edge selection)', async () => {
    const ctx = makeContext()
    const result = await conditionalHandler(makeNode(), ctx, stubGraph)
    expect(result.suggestedNextIds).toBeUndefined()
  })

  it('contextUpdates is absent', async () => {
    const ctx = makeContext()
    const result = await conditionalHandler(makeNode(), ctx, stubGraph)
    expect(result.contextUpdates).toBeUndefined()
  })

  it('is async (returns a Promise)', async () => {
    const promise = conditionalHandler(makeNode(), makeContext(), stubGraph)
    expect(promise).toBeInstanceOf(Promise)
    await promise
  })
})

// ---------------------------------------------------------------------------
// AC1 – Handler lookup by explicit type
// ---------------------------------------------------------------------------

describe('HandlerRegistry.resolve – explicit type (AC1)', () => {
  it('returns the handler registered under the matching type', () => {
    const registry = new HandlerRegistry()
    const mockHandler: NodeHandler = vi.fn()
    registry.register('start', mockHandler)
    const node = makeNode({ type: 'start' })
    expect(registry.resolve(node)).toBe(mockHandler)
  })

  it('resolves start type to startHandler in createDefaultRegistry()', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'start' })
    expect(registry.resolve(node)).toBe(startHandler)
  })

  it('resolves exit type to exitHandler in createDefaultRegistry()', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'exit' })
    expect(registry.resolve(node)).toBe(exitHandler)
  })

  it('resolves conditional type to conditionalHandler in createDefaultRegistry()', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'conditional' })
    expect(registry.resolve(node)).toBe(conditionalHandler)
  })

  it('explicit type takes priority over shape mapping', () => {
    const registry = new HandlerRegistry()
    const explicitHandler: NodeHandler = vi.fn()
    const shapeHandler: NodeHandler = vi.fn()
    registry.register('start', explicitHandler)
    registry.register('shape-type', shapeHandler)
    registry.registerShape('Mdiamond', 'shape-type')
    // Node has both type="start" and shape="Mdiamond"
    const node = makeNode({ type: 'start', shape: 'Mdiamond' })
    expect(registry.resolve(node)).toBe(explicitHandler)
  })
})

// ---------------------------------------------------------------------------
// AC2 – Shape-based fallback when type is absent
// ---------------------------------------------------------------------------

describe('HandlerRegistry.resolve – shape fallback (AC2)', () => {
  it('Mdiamond resolves to startHandler', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: '', shape: 'Mdiamond' })
    expect(registry.resolve(node)).toBe(startHandler)
  })

  it('Msquare resolves to exitHandler', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: '', shape: 'Msquare' })
    expect(registry.resolve(node)).toBe(exitHandler)
  })

  it('diamond resolves to conditionalHandler', () => {
    const registry = createDefaultRegistry()
    const node = makeNode({ type: '', shape: 'diamond' })
    expect(registry.resolve(node)).toBe(conditionalHandler)
  })

  it('shape lookup is skipped if type is set and matched', () => {
    const registry = new HandlerRegistry()
    const typeHandler: NodeHandler = vi.fn()
    registry.register('known', typeHandler)
    // shape would map to nothing (no shape mapping registered)
    const node = makeNode({ type: 'known', shape: 'Mdiamond' })
    expect(registry.resolve(node)).toBe(typeHandler)
  })

  it('shape is ignored when shape maps to an unregistered type', () => {
    const registry = new HandlerRegistry()
    registry.registerShape('triangle', 'unregistered-type')
    const defaultHandler: NodeHandler = vi.fn()
    registry.setDefault(defaultHandler)
    const node = makeNode({ type: '', shape: 'triangle' })
    // Shape maps to 'unregistered-type' but no handler registered for it → falls to default
    expect(registry.resolve(node)).toBe(defaultHandler)
  })

  it('falls through to shape lookup when type is non-empty but unregistered', () => {
    // This exercises the branch where node.type is set but has no handler,
    // so resolution falls through to the shape-based step (step 1 miss → step 2 hit).
    const registry = createDefaultRegistry()
    const node = makeNode({ type: 'unregistered', shape: 'Mdiamond' })
    // type='unregistered' has no handler, but shape='Mdiamond' maps to startHandler
    expect(registry.resolve(node)).toBe(startHandler)
  })
})

// ---------------------------------------------------------------------------
// AC3 – Default handler for unrecognized nodes
// ---------------------------------------------------------------------------

describe('HandlerRegistry.resolve – default handler (AC3)', () => {
  it('returns the default handler when type and shape are unrecognized', () => {
    const registry = new HandlerRegistry()
    const defaultHandler: NodeHandler = vi.fn()
    registry.setDefault(defaultHandler)
    const node = makeNode({ type: 'unknown', shape: 'unknown-shape' })
    expect(registry.resolve(node)).toBe(defaultHandler)
  })

  it('returns the default handler when type and shape are both empty', () => {
    const registry = new HandlerRegistry()
    const defaultHandler: NodeHandler = vi.fn()
    registry.setDefault(defaultHandler)
    const node = makeNode({ type: '', shape: '' })
    expect(registry.resolve(node)).toBe(defaultHandler)
  })

  it('throws when no handler is found and no default is set', () => {
    const registry = new HandlerRegistry()
    const node = makeNode({ id: 'n1', type: 'unknown', shape: 'unrecognized' })
    expect(() => registry.resolve(node)).toThrow(
      'No handler for node "n1" (type="unknown", shape="unrecognized")'
    )
  })

  it('throws with correct node details in the error message', () => {
    const registry = new HandlerRegistry()
    const node = makeNode({ id: 'myNode', type: 'foo', shape: 'bar' })
    expect(() => registry.resolve(node)).toThrow(
      'No handler for node "myNode" (type="foo", shape="bar")'
    )
  })

  it('throws for empty type/shape when no default is set', () => {
    const registry = new HandlerRegistry()
    const node = makeNode({ id: 'n2', type: '', shape: '' })
    expect(() => registry.resolve(node)).toThrow('No handler for node "n2"')
  })
})

// ---------------------------------------------------------------------------
// AC7 – Dynamic registration and override
// ---------------------------------------------------------------------------

describe('HandlerRegistry.register – dynamic registration and override (AC7)', () => {
  it('registers and resolves a custom handler', () => {
    const registry = new HandlerRegistry()
    const customHandler: NodeHandler = vi.fn()
    registry.register('my-type', customHandler)
    const node = makeNode({ type: 'my-type' })
    expect(registry.resolve(node)).toBe(customHandler)
  })

  it('replaces the previous handler when register is called twice with the same key', () => {
    const registry = new HandlerRegistry()
    const first: NodeHandler = vi.fn()
    const second: NodeHandler = vi.fn()
    registry.register('my-type', first)
    registry.register('my-type', second)
    const node = makeNode({ type: 'my-type' })
    expect(registry.resolve(node)).toBe(second)
  })

  it('override in createDefaultRegistry() replaces the built-in handler', () => {
    const registry = createDefaultRegistry()
    const overrideHandler: NodeHandler = vi.fn()
    registry.register('start', overrideHandler)
    const node = makeNode({ type: 'start' })
    expect(registry.resolve(node)).toBe(overrideHandler)
  })

  it('registerShape overwrites an existing shape mapping', () => {
    const registry = new HandlerRegistry()
    const handlerA: NodeHandler = vi.fn()
    const handlerB: NodeHandler = vi.fn()
    registry.register('typeA', handlerA)
    registry.register('typeB', handlerB)
    registry.registerShape('custom-shape', 'typeA')
    registry.registerShape('custom-shape', 'typeB')
    const node = makeNode({ type: '', shape: 'custom-shape' })
    expect(registry.resolve(node)).toBe(handlerB)
  })

  it('setDefault overwrites a previously set default handler', () => {
    const registry = new HandlerRegistry()
    const first: NodeHandler = vi.fn()
    const second: NodeHandler = vi.fn()
    registry.setDefault(first)
    registry.setDefault(second)
    const node = makeNode({ type: 'unknown', shape: 'unknown' })
    expect(registry.resolve(node)).toBe(second)
  })
})

// ---------------------------------------------------------------------------
// createDefaultRegistry() shape wiring
// ---------------------------------------------------------------------------

describe('createDefaultRegistry()', () => {
  it('sets codergen as the default handler (story 42-10)', () => {
    const registry = createDefaultRegistry()
    // A node with unrecognized type and no shape should resolve to the codergen default,
    // not throw — codergen was registered as the default handler in story 42-10.
    const node = makeNode({ id: 'x', type: 'completely-unknown', shape: '' })
    expect(() => registry.resolve(node)).not.toThrow()
    expect(typeof registry.resolve(node)).toBe('function')
  })

  it('pre-registers all three shape mappings correctly', () => {
    const registry = createDefaultRegistry()
    expect(registry.resolve(makeNode({ type: '', shape: 'Mdiamond' }))).toBe(startHandler)
    expect(registry.resolve(makeNode({ type: '', shape: 'Msquare' }))).toBe(exitHandler)
    expect(registry.resolve(makeNode({ type: '', shape: 'diamond' }))).toBe(conditionalHandler)
  })
})
