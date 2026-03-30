/**
 * Unit tests for the pipeline template registry.
 *
 * Story 50-10 AC7 — ≥10 test cases covering registry correctness and DOT validity.
 */

import { describe, it, expect } from 'vitest'
import { listPipelineTemplates, getPipelineTemplate } from '../index.js'
import { parseGraph } from '../../graph/parser.js'

describe('listPipelineTemplates()', () => {
  it('returns exactly 4 entries', () => {
    const templates = listPipelineTemplates()
    expect(templates).toHaveLength(4)
  })

  it('returns templates in insertion order (trycycle first, staged-validation last)', () => {
    const templates = listPipelineTemplates()
    expect(templates[0]?.name).toBe('trycycle')
    expect(templates[3]?.name).toBe('staged-validation')
  })
})

describe('getPipelineTemplate()', () => {
  it("returns trycycle template with name === 'trycycle'", () => {
    const t = getPipelineTemplate('trycycle')
    expect(t).toBeDefined()
    expect(t?.name).toBe('trycycle')
  })

  it("returns dual-review template with name === 'dual-review'", () => {
    const t = getPipelineTemplate('dual-review')
    expect(t).toBeDefined()
    expect(t?.name).toBe('dual-review')
  })

  it("returns parallel-exploration template with name === 'parallel-exploration'", () => {
    const t = getPipelineTemplate('parallel-exploration')
    expect(t).toBeDefined()
    expect(t?.name).toBe('parallel-exploration')
  })

  it("returns staged-validation template with name === 'staged-validation'", () => {
    const t = getPipelineTemplate('staged-validation')
    expect(t).toBeDefined()
    expect(t?.name).toBe('staged-validation')
  })

  it("returns undefined for an unknown template name", () => {
    const t = getPipelineTemplate('nonexistent')
    expect(t).toBeUndefined()
  })
})

describe('DOT content validity — trycycle', () => {
  it('parseGraph(trycycle.dotContent) does not throw', () => {
    const trycycle = getPipelineTemplate('trycycle')!
    expect(() => parseGraph(trycycle.dotContent)).not.toThrow()
  })

  it("parsed trycycle graph contains a node with id 'eval_plan'", () => {
    const trycycle = getPipelineTemplate('trycycle')!
    const graph = parseGraph(trycycle.dotContent)
    expect(graph.nodes.has('eval_plan')).toBe(true)
  })
})

describe('DOT content validity — dual-review', () => {
  it('parseGraph(dual_review.dotContent) does not throw', () => {
    const dualReview = getPipelineTemplate('dual-review')!
    expect(() => parseGraph(dualReview.dotContent)).not.toThrow()
  })

  it("parsed dual-review graph has at least one node whose type is 'parallel' (fan-out handler)", () => {
    const dualReview = getPipelineTemplate('dual-review')!
    const graph = parseGraph(dualReview.dotContent)
    const parallelNodes = Array.from(graph.nodes.values()).filter((n) => n.type === 'parallel')
    expect(parallelNodes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('DOT content validity — parallel-exploration', () => {
  it('parseGraph(parallel_exploration.dotContent) does not throw', () => {
    const parallelExploration = getPipelineTemplate('parallel-exploration')!
    expect(() => parseGraph(parallelExploration.dotContent)).not.toThrow()
  })

  it("parsed parallel-exploration graph has at least one node whose type is 'parallel.fan_in'", () => {
    const parallelExploration = getPipelineTemplate('parallel-exploration')!
    const graph = parseGraph(parallelExploration.dotContent)
    const fanInNodes = Array.from(graph.nodes.values()).filter((n) => n.type === 'parallel.fan_in')
    expect(fanInNodes.length).toBeGreaterThanOrEqual(1)
  })
})

describe('DOT content validity — staged-validation', () => {
  it('parseGraph(staged_validation.dotContent) does not throw', () => {
    const stagedValidation = getPipelineTemplate('staged-validation')!
    expect(() => parseGraph(stagedValidation.dotContent)).not.toThrow()
  })

  it("parsed staged-validation graph contains a node with id 'lint'", () => {
    const stagedValidation = getPipelineTemplate('staged-validation')!
    const graph = parseGraph(stagedValidation.dotContent)
    expect(graph.nodes.has('lint')).toBe(true)
  })
})
