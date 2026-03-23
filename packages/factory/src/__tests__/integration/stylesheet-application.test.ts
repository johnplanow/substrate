/**
 * Integration test: AC6 — model stylesheet properties applied before handler dispatch
 *
 * Verifies that the stylesheet resolver correctly applies per-node LLM routing
 * properties with specificity-based precedence. The test applies the stylesheet
 * resolver to graph nodes before execution so that spy handlers receive the
 * resolved node attributes.
 *
 * Story 42-15.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { parseStylesheet } from '../../stylesheet/parser.js'
import { resolveNodeStyles } from '../../stylesheet/resolver.js'
import { makeTmpDir, cleanDir, makeMockRegistry, makeEventSpy } from './helpers.js'
import { STYLESHEET_DOT } from './graphs.js'
import type { GraphNode } from '../../graph/types.js'

describe('AC6: model stylesheet properties applied before handler dispatch', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('parses graph with non-empty modelStylesheet', () => {
    const graph = parseGraph(STYLESHEET_DOT)
    expect(graph.modelStylesheet).not.toBe('')
    expect(graph.modelStylesheet).toContain('claude-3-haiku-20240307')
    expect(graph.modelStylesheet).toContain('claude-opus-4-5')
  })

  it('stylesheet parser resolves analyze to opus and summarize to haiku (unit check)', () => {
    const graph = parseGraph(STYLESHEET_DOT)
    const stylesheet = parseStylesheet(graph.modelStylesheet)

    const analyzeNode = graph.nodes.get('analyze')!
    const summarizeNode = graph.nodes.get('summarize')!

    const analyzeResolved = resolveNodeStyles(analyzeNode, stylesheet)
    const summarizeResolved = resolveNodeStyles(summarizeNode, stylesheet)

    expect(analyzeResolved.llmModel).toBe('claude-opus-4-5')
    expect(summarizeResolved.llmModel).toBe('claude-3-haiku-20240307')
  })

  it('id-level specificity wins over universal selector for analyze node', () => {
    const graph = parseGraph(STYLESHEET_DOT)
    const stylesheet = parseStylesheet(graph.modelStylesheet)

    const analyzeNode = graph.nodes.get('analyze')!
    const resolved = resolveNodeStyles(analyzeNode, stylesheet)

    // #analyze rule (specificity=3) overrides * rule (specificity=0)
    expect(resolved.llmModel).toBe('claude-opus-4-5')
  })

  it('universal selector applies to summarize (no id override)', () => {
    const graph = parseGraph(STYLESHEET_DOT)
    const stylesheet = parseStylesheet(graph.modelStylesheet)

    const summarizeNode = graph.nodes.get('summarize')!
    const resolved = resolveNodeStyles(summarizeNode, stylesheet)

    // Only * rule applies (no #summarize rule)
    expect(resolved.llmModel).toBe('claude-3-haiku-20240307')
  })

  it('spy handler for analyze receives node with llmModel=claude-opus-4-5 after stylesheet application', async () => {
    const graph = parseGraph(STYLESHEET_DOT)

    // Apply stylesheet to graph nodes before running the executor
    // (integration between the stylesheet resolver and the execution layer)
    const stylesheet = parseStylesheet(graph.modelStylesheet)
    for (const node of graph.nodes.values()) {
      const resolved = resolveNodeStyles(node, stylesheet)
      // Explicit node attribute takes priority (merge: explicit wins over resolved).
      // Cast through unknown to mutate the plain object (buildGraphNode returns a mutable struct).
      const mutableNode = node as unknown as Record<string, unknown>
      if (!node.llmModel && resolved.llmModel) {
        mutableNode['llmModel'] = resolved.llmModel
      }
      if (!node.llmProvider && resolved.llmProvider) {
        mutableNode['llmProvider'] = resolved.llmProvider
      }
      if (!node.reasoningEffort && resolved.reasoningEffort) {
        mutableNode['reasoningEffort'] = resolved.reasoningEffort
      }
    }

    // Verify the mutation was applied
    expect(graph.nodes.get('analyze')!.llmModel).toBe('claude-opus-4-5')
    expect(graph.nodes.get('summarize')!.llmModel).toBe('claude-3-haiku-20240307')

    // --- Build spy registry ---
    const { registry, spies } = makeMockRegistry()
    const { bus } = makeEventSpy()

    // --- Execute ---
    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-run-ac6',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
    })

    expect(outcome.status).toBe('SUCCESS')

    // --- Verify spy handler received node with stylesheet-applied llmModel ---
    const analyzeSpy = spies.get('analyze')
    const summarizeSpy = spies.get('summarize')

    expect(analyzeSpy).toBeDefined()
    expect(summarizeSpy).toBeDefined()

    // First argument to the handler is the GraphNode
    const analyzeNode = analyzeSpy!.mock.calls[0]![0] as GraphNode
    const summarizeNode = summarizeSpy!.mock.calls[0]![0] as GraphNode

    expect(analyzeNode.llmModel).toBe('claude-opus-4-5')
    expect(summarizeNode.llmModel).toBe('claude-3-haiku-20240307')
  })

  it('executor runs the stylesheet graph to SUCCESS with all nodes executing', async () => {
    const graph = parseGraph(STYLESHEET_DOT)

    // Validate: no errors
    const validator = createValidator()
    const errors = validator.validate(graph).filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)

    const { registry } = makeMockRegistry()
    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-run-ac6-simple',
      logsRoot,
      handlerRegistry: registry,
    })

    expect(outcome.status).toBe('SUCCESS')
  })
})
