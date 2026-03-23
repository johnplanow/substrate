/**
 * Tests for packages/sdlc/graphs/sdlc-pipeline.dot
 *
 * Validates that the DOT file encodes the correct SDLC pipeline topology
 * and passes all structural lint rules.
 *
 * Story 43-1
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGraph, createValidator } from '@substrate-ai/factory'
import type { Graph } from '@substrate-ai/factory'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dotPath = join(__dirname, '../../graphs/sdlc-pipeline.dot')

describe('sdlc-pipeline.dot', () => {
  let graph: Graph

  beforeAll(async () => {
    const dotSource = await readFile(dotPath, 'utf-8')
    graph = parseGraph(dotSource)
  })

  // ── AC1: DOT File Parses to 8-Node Graph ────────────────────────────────────
  it('AC1: parses to a graph with exactly 8 nodes', () => {
    expect(graph.nodes.size).toBe(8)

    const expectedIds = [
      'start',
      'analysis',
      'planning',
      'solutioning',
      'create_story',
      'dev_story',
      'code_review',
      'exit',
    ]
    for (const id of expectedIds) {
      expect(graph.nodes.has(id), `expected node '${id}' to exist`).toBe(true)
    }
  })

  // ── AC2: Zero Lint Errors and Zero Warnings ──────────────────────────────────
  it('AC2: zero diagnostics (errors and warnings) from createValidator().validate()', () => {
    const diagnostics = createValidator().validate(graph)
    if (diagnostics.length > 0) {
      console.error('Validation diagnostics:', JSON.stringify(diagnostics, null, 2))
    }
    expect(diagnostics.length, `expected zero diagnostics but got: ${JSON.stringify(diagnostics)}`).toBe(0)
  })

  // ── AC3: dev_story Node Has Required Attributes ────────────────────────────
  it('AC3: dev_story has goalGate, retryTarget, maxRetries, and correct type', () => {
    const devStory = graph.nodes.get('dev_story')
    expect(devStory).toBeDefined()
    expect(devStory!.goalGate).toBe(true)
    expect(devStory!.retryTarget).toBe('dev_story')
    expect(devStory!.maxRetries).toBe(2)
    expect(devStory!.type).toBe('sdlc.dev-story')
  })

  // ── AC4: code_review Is Diamond with Two Conditional Outgoing Edges ──────────
  it('AC4: code_review has shape=diamond, type=sdlc.code-review, and two conditional edges', () => {
    const codeReview = graph.nodes.get('code_review')
    expect(codeReview).toBeDefined()
    expect(codeReview!.shape).toBe('diamond')
    expect(codeReview!.type).toBe('sdlc.code-review')

    const outgoing = graph.outgoingEdges('code_review')
    expect(outgoing.length).toBe(2)

    const successEdge = outgoing.find((e) => e.condition === 'outcome=success')
    expect(successEdge, 'expected an edge with condition=outcome=success').toBeDefined()
    expect(successEdge!.toNode).toBe('exit')

    const failEdge = outgoing.find((e) => e.condition === 'outcome=fail')
    expect(failEdge, 'expected an edge with condition=outcome=fail').toBeDefined()
    expect(failEdge!.toNode).toBe('dev_story')
  })

  // ── AC5: Phase Nodes Have type === 'sdlc.phase' ──────────────────────────────
  it('AC5: analysis, planning, solutioning have type=sdlc.phase; create_story has type=sdlc.create-story', () => {
    const analysis = graph.nodes.get('analysis')
    const planning = graph.nodes.get('planning')
    const solutioning = graph.nodes.get('solutioning')
    const createStory = graph.nodes.get('create_story')

    expect(analysis).toBeDefined()
    expect(analysis!.type).toBe('sdlc.phase')

    expect(planning).toBeDefined()
    expect(planning!.type).toBe('sdlc.phase')

    expect(solutioning).toBeDefined()
    expect(solutioning!.type).toBe('sdlc.phase')

    expect(createStory).toBeDefined()
    expect(createStory!.type).toBe('sdlc.create-story')
  })

  // ── AC6: Linear Topology from start to code_review ──────────────────────────
  it('AC6: start has shape=Mdiamond, exit has shape=Msquare, linear edges are correct', () => {
    const start = graph.nodes.get('start')
    const exit = graph.nodes.get('exit')

    expect(start).toBeDefined()
    expect(start!.shape).toBe('Mdiamond')

    expect(exit).toBeDefined()
    expect(exit!.shape).toBe('Msquare')

    // start → analysis (single outgoing edge)
    const startOut = graph.outgoingEdges('start')
    expect(startOut.length).toBe(1)
    expect(startOut[0]!.toNode).toBe('analysis')

    // verify full linear chain by checking each step's outgoing edges
    const chain: Array<[string, string]> = [
      ['analysis', 'planning'],
      ['planning', 'solutioning'],
      ['solutioning', 'create_story'],
      ['create_story', 'dev_story'],
    ]
    for (const [from, to] of chain) {
      const out = graph.outgoingEdges(from)
      expect(out.length, `${from} should have exactly 1 outgoing edge`).toBe(1)
      expect(out[0]!.toNode, `${from} should point to ${to}`).toBe(to)
    }

    // dev_story → code_review (single unconditional outgoing edge)
    // outgoingEdges filters by fromNode, so the code_review -> dev_story back-edge
    // (which is an INCOMING edge to dev_story) is not included here.
    const devStoryOut = graph.outgoingEdges('dev_story')
    expect(devStoryOut.length, 'dev_story should have exactly 1 outgoing edge').toBe(1)
    expect(devStoryOut[0]!.toNode, 'dev_story should point to code_review').toBe('code_review')
  })
})
