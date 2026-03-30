/**
 * Integration tests for pipeline template catalog.
 * Story 50-11 AC6.
 *
 * Tests cover:
 *   - listPipelineTemplates() returns all 4 built-in templates
 *   - getPipelineTemplate(name) retrieves named template or returns undefined
 *   - Every template's DOT content is parseable without error
 *   - Template node types match expected graph structure
 *   - Specific template structures (parallel nodes, eval gates, stages)
 *   - Execute a simple template through the graph executor → SUCCESS
 *
 * ≥7 `it(...)` cases required (AC7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import crypto from 'node:crypto'

import { listPipelineTemplates, getPipelineTemplate } from '../../templates/index.js'
import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { createParallelHandler } from '../../handlers/parallel.js'
import { createFanInHandler } from '../../handlers/fan-in.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `templates-test-${crypto.randomUUID()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Build a registry that handles all node types used by built-in templates. */
function makeTemplateRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register('parallel', createParallelHandler({ handlerRegistry: registry }))
  registry.register('parallel.fan_in', createFanInHandler())
  // codergen nodes (and any other type) return SUCCESS
  registry.setDefault(vi.fn().mockResolvedValue({ status: 'SUCCESS' }))
  return registry
}

// ---------------------------------------------------------------------------
// AC6: Template catalog API
// ---------------------------------------------------------------------------

describe('pipeline templates — catalog API', () => {
  it('listPipelineTemplates() returns exactly 4 templates', () => {
    const templates = listPipelineTemplates()
    expect(templates).toHaveLength(4)
  })

  it('getPipelineTemplate returns all 4 known templates by name', () => {
    const names = ['trycycle', 'dual-review', 'parallel-exploration', 'staged-validation']
    for (const name of names) {
      const t = getPipelineTemplate(name)
      expect(t, `Expected template "${name}" to be defined`).toBeDefined()
      expect(t!.name).toBe(name)
    }
  })

  it('getPipelineTemplate returns undefined for unknown template name', () => {
    expect(getPipelineTemplate('not-a-real-template')).toBeUndefined()
    expect(getPipelineTemplate('')).toBeUndefined()
    expect(getPipelineTemplate('TRYCYCLE')).toBeUndefined() // case-sensitive
  })

  it('every template has a non-empty name, description, and dotContent', () => {
    for (const t of listPipelineTemplates()) {
      expect(t.name.trim()).not.toBe('')
      expect(t.description.trim()).not.toBe('')
      expect(t.dotContent.trim()).not.toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// AC6: DOT content parseability
// ---------------------------------------------------------------------------

describe('pipeline templates — DOT content is valid and parseable', () => {
  it('all 4 template DOT strings parse without throwing', () => {
    for (const t of listPipelineTemplates()) {
      expect(() => parseGraph(t.dotContent), `Template "${t.name}" should parse`).not.toThrow()
    }
  })

  it('all 4 templates have both a start and exit node after parsing', () => {
    for (const t of listPipelineTemplates()) {
      const graph = parseGraph(t.dotContent)
      const types = Array.from(graph.nodes.values()).map((n) => n.type)
      expect(types, `Template "${t.name}" should have start node`).toContain('start')
      expect(types, `Template "${t.name}" should have exit node`).toContain('exit')
    }
  })

  it('dual-review template contains parallel and parallel.fan_in node types', () => {
    const t = getPipelineTemplate('dual-review')!
    const graph = parseGraph(t.dotContent)
    const types = Array.from(graph.nodes.values()).map((n) => n.type)
    expect(types).toContain('parallel')
    expect(types).toContain('parallel.fan_in')
  })

  it('parallel-exploration template has parallel and parallel.fan_in node types', () => {
    const t = getPipelineTemplate('parallel-exploration')!
    const graph = parseGraph(t.dotContent)
    const types = Array.from(graph.nodes.values()).map((n) => n.type)
    expect(types).toContain('parallel')
    expect(types).toContain('parallel.fan_in')
  })

  it('trycycle template has revision_needed and approved labeled edges (eval gates)', () => {
    const t = getPipelineTemplate('trycycle')!
    const graph = parseGraph(t.dotContent)
    const labels = graph.edges.map((e) => e.label)
    expect(labels).toContain('revision_needed')
    expect(labels).toContain('approved')
  })

  it('staged-validation template has 4 codergen nodes (implement/lint/test/validate)', () => {
    const t = getPipelineTemplate('staged-validation')!
    const graph = parseGraph(t.dotContent)
    const codergenNodes = Array.from(graph.nodes.values()).filter((n) => n.type === 'codergen')
    expect(codergenNodes.length).toBe(4)
    const ids = codergenNodes.map((n) => n.id)
    expect(ids).toContain('implement')
    expect(ids).toContain('lint')
    expect(ids).toContain('test')
    expect(ids).toContain('validate')
  })
})

// ---------------------------------------------------------------------------
// AC6: Template execution
// ---------------------------------------------------------------------------

describe('pipeline templates — execution via graph executor', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('staged-validation template executes end-to-end and returns SUCCESS', async () => {
    const t = getPipelineTemplate('staged-validation')!
    const graph = parseGraph(t.dotContent)
    const registry = makeTemplateRegistry()

    const result = await createGraphExecutor().run(graph, {
      runId: 'staged-val-test',
      logsRoot,
      handlerRegistry: registry,
    })

    expect(result.status).toBe('SUCCESS')
  })

  it('dual-review template executes end-to-end and returns SUCCESS', async () => {
    const t = getPipelineTemplate('dual-review')!
    const graph = parseGraph(t.dotContent)
    const registry = makeTemplateRegistry()

    const result = await createGraphExecutor().run(graph, {
      runId: 'dual-review-test',
      logsRoot,
      handlerRegistry: registry,
    })

    expect(result.status).toBe('SUCCESS')
  })

  it('trycycle template has two evaluation nodes (eval_plan and eval_impl)', () => {
    const t = getPipelineTemplate('trycycle')!
    const graph = parseGraph(t.dotContent)
    expect(graph.nodes.has('eval_plan')).toBe(true)
    expect(graph.nodes.has('eval_impl')).toBe(true)
    expect(graph.nodes.get('eval_plan')!.type).toBe('codergen')
    expect(graph.nodes.get('eval_impl')!.type).toBe('codergen')
  })
})
