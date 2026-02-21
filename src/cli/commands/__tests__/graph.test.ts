/**
 * Unit tests for `src/cli/commands/graph.ts`
 *
 * Covers Acceptance Criteria:
 *   AC1: Valid YAML with tasks and dependencies → ASCII output, exit 0
 *   AC2: Task with agent and description → appears in output
 *   AC3: --output-format json → valid JSON with required keys
 *   AC4: Graph with cycle → stderr contains cycle path, exit 2
 *   AC5: Graph with dangling reference → stderr contains missing dep, exit 2
 *   AC6: Non-existent file → stderr "Graph file not found", exit 2
 *   AC6: Invalid YAML syntax → stderr parse error, exit 2
 *   AC7: Summary line with correct task count, root, leaf, max depth
 *   AC8: Unknown agent → warning on stderr, exit 0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'

// ---------------------------------------------------------------------------
// SUT imports
// ---------------------------------------------------------------------------

import {
  runGraphAction,
  buildAdjacencyList,
  topoSort,
  renderAscii,
  renderJson,
  GRAPH_EXIT_SUCCESS,
  GRAPH_EXIT_USAGE_ERROR,
} from '../graph.js'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let testDir: string

function setupTestDir() {
  testDir = join(tmpdir(), `graph-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
}

function teardownTestDir() {
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function writeYaml(name: string, content: string): string {
  const p = join(testDir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

// ---------------------------------------------------------------------------
// stdout / stderr capture helpers
// ---------------------------------------------------------------------------

type WrittenChunk = string

function captureStdout(): { chunks: WrittenChunk[]; restore: () => void } {
  const chunks: WrittenChunk[] = []
  const original = process.stdout.write.bind(process.stdout)
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return {
    chunks,
    restore: () => {
      spy.mockRestore()
      void original
    },
  }
}

function captureStderr(): { chunks: WrittenChunk[]; restore: () => void } {
  const chunks: WrittenChunk[] = []
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return {
    chunks,
    restore: () => spy.mockRestore(),
  }
}

// ---------------------------------------------------------------------------
// Shared YAML fixtures
// ---------------------------------------------------------------------------

const SIMPLE_GRAPH_YAML = `
version: "1"
session:
  name: test-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
  task-b:
    name: Task B
    prompt: Do task B
    type: testing
    depends_on:
      - task-a
  task-c:
    name: Task C
    prompt: Do task C
    type: docs
    depends_on:
      - task-b
`

const AGENT_DESCRIPTION_GRAPH_YAML = `
version: "1"
session:
  name: test-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
    agent: claude-code
    description: "This is a fairly long description that should be shown truncated in the output if it exceeds sixty characters limit"
  task-b:
    name: Task B
    prompt: Do task B
    type: testing
    agent: claude-code
    description: "Short desc"
    depends_on:
      - task-a
`

const CYCLE_GRAPH_YAML = `
version: "1"
session:
  name: cycle-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
    depends_on:
      - task-b
  task-b:
    name: Task B
    prompt: Do task B
    type: testing
    depends_on:
      - task-a
`

const DANGLING_REF_GRAPH_YAML = `
version: "1"
session:
  name: dangling-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
  task-b:
    name: Task B
    prompt: Do task B
    type: testing
    depends_on:
      - task-x
`

const INVALID_YAML = `
version: "1"
session:
  name: bad
tasks:
  task-a:
    name: [unclosed bracket
`

const UNKNOWN_AGENT_GRAPH_YAML = `
version: "1"
session:
  name: agent-session
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
    agent: unknown-agent-xyz
`

// ---------------------------------------------------------------------------
// Helper to build a TaskGraphFile from parsed graph (for unit tests)
// ---------------------------------------------------------------------------

import { validateGraph } from '../../../modules/task-graph/task-validator.js'
import { parseGraphString } from '../../../modules/task-graph/task-parser.js'
import type { TaskGraphFile } from '../../../modules/task-graph/schemas.js'

function parseValidGraph(yaml: string): TaskGraphFile {
  const raw = parseGraphString(yaml, 'yaml')
  const result = validateGraph(raw)
  if (!result.valid || !result.graph) {
    throw new Error(`Test graph is not valid: ${result.errors.join(', ')}`)
  }
  return result.graph
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('graph command — unit helpers', () => {
  describe('buildAdjacencyList', () => {
    it('identifies root and leaf tasks correctly', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const { rootTasks, leafTasks } = buildAdjacencyList(graph)
      expect(rootTasks).toContain('task-a')
      expect(leafTasks).toContain('task-c')
      expect(rootTasks).not.toContain('task-b')
      expect(rootTasks).not.toContain('task-c')
      expect(leafTasks).not.toContain('task-a')
      expect(leafTasks).not.toContain('task-b')
    })

    it('computes correct max depth', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const { maxDepth } = buildAdjacencyList(graph)
      // task-a depth=0, task-b depth=1, task-c depth=2
      expect(maxDepth).toBe(2)
    })

    it('computes dependents correctly', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const { dependents } = buildAdjacencyList(graph)
      expect(dependents['task-a']).toContain('task-b')
      expect(dependents['task-b']).toContain('task-c')
      expect(dependents['task-c']).toEqual([])
    })
  })

  describe('topoSort', () => {
    it('returns tasks in dependency order', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const sorted = topoSort(graph)
      expect(sorted.indexOf('task-a')).toBeLessThan(sorted.indexOf('task-b'))
      expect(sorted.indexOf('task-b')).toBeLessThan(sorted.indexOf('task-c'))
    })

    it('includes all tasks', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const sorted = topoSort(graph)
      expect(sorted).toHaveLength(3)
      expect(sorted).toContain('task-a')
      expect(sorted).toContain('task-b')
      expect(sorted).toContain('task-c')
    })
  })

  describe('renderAscii', () => {
    it('includes all task IDs', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const sorted = topoSort(graph)
      const output = renderAscii(graph, sorted)
      expect(output).toContain('task-a')
      expect(output).toContain('task-b')
      expect(output).toContain('task-c')
    })

    it('includes task types', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const sorted = topoSort(graph)
      const output = renderAscii(graph, sorted)
      expect(output).toContain('coding')
      expect(output).toContain('testing')
      expect(output).toContain('docs')
    })

    it('labels root tasks', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const sorted = topoSort(graph)
      const output = renderAscii(graph, sorted)
      expect(output).toContain('[root]')
    })

    it('shows dependency arrows', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const sorted = topoSort(graph)
      const output = renderAscii(graph, sorted)
      expect(output).toContain('-->')
    })

    it('shows agent in output', () => {
      const graph = parseValidGraph(AGENT_DESCRIPTION_GRAPH_YAML)
      const sorted = topoSort(graph)
      const output = renderAscii(graph, sorted)
      expect(output).toContain('claude-code')
    })

    it('truncates description to max 60 chars', () => {
      const graph = parseValidGraph(AGENT_DESCRIPTION_GRAPH_YAML)
      const sorted = topoSort(graph)
      const output = renderAscii(graph, sorted)
      // Long description should be truncated with ...
      expect(output).toContain('...')
      // Short description shown as-is
      expect(output).toContain('Short desc')
    })
  })

  describe('renderJson', () => {
    it('produces valid JSON with required keys', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const jsonStr = renderJson(graph)
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>
      expect(parsed).toHaveProperty('version')
      expect(parsed).toHaveProperty('session')
      expect(parsed).toHaveProperty('tasks')
      expect(parsed).toHaveProperty('rootTasks')
      expect(parsed).toHaveProperty('leafTasks')
      expect(parsed).toHaveProperty('summary')
    })

    it('includes all task IDs in tasks object', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const jsonStr = renderJson(graph)
      const parsed = JSON.parse(jsonStr) as { tasks: Record<string, unknown> }
      expect(Object.keys(parsed.tasks)).toContain('task-a')
      expect(Object.keys(parsed.tasks)).toContain('task-b')
      expect(Object.keys(parsed.tasks)).toContain('task-c')
    })

    it('includes dependents in each task', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const jsonStr = renderJson(graph)
      const parsed = JSON.parse(jsonStr) as { tasks: Record<string, { dependents: string[] }> }
      expect(parsed.tasks['task-a'].dependents).toContain('task-b')
    })

    it('rootTasks and leafTasks are arrays', () => {
      const graph = parseValidGraph(SIMPLE_GRAPH_YAML)
      const jsonStr = renderJson(graph)
      const parsed = JSON.parse(jsonStr) as { rootTasks: unknown; leafTasks: unknown }
      expect(Array.isArray(parsed.rootTasks)).toBe(true)
      expect(Array.isArray(parsed.leafTasks)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Integration tests via runGraphAction
// ---------------------------------------------------------------------------

describe('runGraphAction', () => {
  beforeEach(() => {
    setupTestDir()
  })

  afterEach(() => {
    teardownTestDir()
  })

  // -------------------------------------------------------------------------
  // AC1: Valid graph renders ASCII, exit 0
  // -------------------------------------------------------------------------
  it('AC1: renders ASCII for valid YAML file, exits 0', async () => {
    const filePath = writeYaml('tasks.yaml', SIMPLE_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    expect(out).toContain('task-a')
    expect(out).toContain('task-b')
    expect(out).toContain('task-c')
    // Dependency arrows
    expect(out).toContain('-->')
    // No stderr errors
    expect(stderr.chunks.join('')).toBe('')
  })

  // -------------------------------------------------------------------------
  // AC2: Agent and description appear in output
  // -------------------------------------------------------------------------
  it('AC2: shows agent and truncated description in ASCII output', async () => {
    const filePath = writeYaml('tasks.yaml', AGENT_DESCRIPTION_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    expect(out).toContain('claude-code')
    // Long description truncated
    expect(out).toContain('...')
    // Short description shown
    expect(out).toContain('Short desc')
  })

  // -------------------------------------------------------------------------
  // AC3: --output-format json → valid JSON with required keys
  // -------------------------------------------------------------------------
  it('AC3: outputs valid JSON adjacency list with required keys, exits 0', async () => {
    const filePath = writeYaml('tasks.yaml', SIMPLE_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'json' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed).toHaveProperty('tasks')
    expect(parsed).toHaveProperty('rootTasks')
    expect(parsed).toHaveProperty('leafTasks')
    expect(Array.isArray(parsed['rootTasks'])).toBe(true)
    expect(Array.isArray(parsed['leafTasks'])).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC4: Cycle detection
  // -------------------------------------------------------------------------
  it('AC4: detects cycle, prints to stderr, exits 2', async () => {
    const filePath = writeYaml('cycle.yaml', CYCLE_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_USAGE_ERROR)
    const errOut = stderr.chunks.join('')
    expect(errOut).toContain('Circular dependency detected')
    // Should show the cycle path with -->
    expect(errOut).toContain('task-a')
    expect(errOut).toContain('task-b')
  })

  // -------------------------------------------------------------------------
  // AC5: Dangling reference detection
  // -------------------------------------------------------------------------
  it('AC5: detects dangling reference, prints to stderr, exits 2', async () => {
    const filePath = writeYaml('dangling.yaml', DANGLING_REF_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_USAGE_ERROR)
    const errOut = stderr.chunks.join('')
    expect(errOut).toContain('task-x')
    expect(errOut).toContain('task-b')
  })

  // -------------------------------------------------------------------------
  // AC6: Non-existent file
  // -------------------------------------------------------------------------
  it('AC6: non-existent file prints "Graph file not found", exits 2', async () => {
    const filePath = join(testDir, 'nonexistent.yaml')
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_USAGE_ERROR)
    const errOut = stderr.chunks.join('')
    expect(errOut).toContain('Graph file not found')
    expect(errOut).toContain(filePath)
  })

  // -------------------------------------------------------------------------
  // AC6: Invalid YAML syntax
  // -------------------------------------------------------------------------
  it('AC6: invalid YAML syntax prints parse error, exits 2', async () => {
    const filePath = writeYaml('bad.yaml', INVALID_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_USAGE_ERROR)
    const errOut = stderr.chunks.join('')
    expect(errOut).toContain('Error')
  })

  // -------------------------------------------------------------------------
  // AC7: Summary line
  // -------------------------------------------------------------------------
  it('AC7: human output includes summary with task count, root, leaf, max depth', async () => {
    const filePath = writeYaml('tasks.yaml', SIMPLE_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    // Summary: "3 tasks, 1 root(s), 1 leaf(s), max depth 2"
    expect(out).toContain('3 tasks')
    expect(out).toContain('1 root(s)')
    expect(out).toContain('1 leaf(s)')
    expect(out).toContain('max depth 2')
  })

  it('AC7: JSON output includes summary key', async () => {
    const filePath = writeYaml('tasks.yaml', SIMPLE_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'json' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const parsed = JSON.parse(stdout.chunks.join('')) as { summary: string }
    expect(parsed.summary).toContain('3 tasks')
    expect(parsed.summary).toContain('1 root(s)')
    expect(parsed.summary).toContain('1 leaf(s)')
    expect(parsed.summary).toContain('max depth 2')
  })

  // -------------------------------------------------------------------------
  // AC8: Unknown agent warning
  // -------------------------------------------------------------------------
  it('AC8: unknown agent prints warning to stderr, exits 0', async () => {
    const filePath = writeYaml('agent.yaml', UNKNOWN_AGENT_GRAPH_YAML)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    // The command passes an empty AdapterRegistry to validateGraph, so any
    // task agent reference that is not registered generates a warning.
    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const errOut = stderr.chunks.join('')
    expect(errOut).toContain('Warning: Task "task-a" references unregistered agent "unknown-agent-xyz"')
    // stdout should contain the task (graph still renders)
    expect(stdout.chunks.join('')).toContain('task-a')
  })
})

// ---------------------------------------------------------------------------
// Additional edge case tests
// ---------------------------------------------------------------------------

describe('graph command — edge cases', () => {
  beforeEach(() => {
    setupTestDir()
  })

  afterEach(() => {
    teardownTestDir()
  })

  it('handles single task graph (root and leaf same node)', async () => {
    const yaml = `
version: "1"
session:
  name: single
tasks:
  only-task:
    name: Only Task
    prompt: Do it
    type: coding
`
    const filePath = writeYaml('single.yaml', yaml)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'human' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)
    const out = stdout.chunks.join('')
    expect(out).toContain('only-task')
    expect(out).toContain('[root]')
    expect(out).toContain('1 tasks')
    expect(out).toContain('1 root(s)')
    expect(out).toContain('1 leaf(s)')
    expect(out).toContain('max depth 0')
  })

  it('JSON output contains correct task structure', async () => {
    const yaml = `
version: "1"
session:
  name: json-test
tasks:
  task-a:
    name: Task A
    prompt: Do A
    type: coding
    agent: my-agent
    description: "A description"
  task-b:
    name: Task B
    prompt: Do B
    type: testing
    depends_on:
      - task-a
`
    const filePath = writeYaml('tasks.yaml', yaml)
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runGraphAction({ filePath, outputFormat: 'json' })

    stdout.restore()
    stderr.restore()

    expect(code).toBe(GRAPH_EXIT_SUCCESS)

    type ParsedTask = {
      id: string
      name: string
      type: string
      agent: string | null
      description: string | null
      depends_on: string[]
      dependents: string[]
    }

    const parsed = JSON.parse(stdout.chunks.join('')) as {
      tasks: Record<string, ParsedTask>
      rootTasks: string[]
      leafTasks: string[]
      session: { name: string; budget_usd: number | null }
    }

    const taskA = parsed.tasks['task-a']
    expect(taskA.id).toBe('task-a')
    expect(taskA.name).toBe('Task A')
    expect(taskA.type).toBe('coding')
    expect(taskA.agent).toBe('my-agent')
    expect(taskA.description).toBe('A description')
    expect(taskA.depends_on).toEqual([])
    expect(taskA.dependents).toContain('task-b')

    const taskB = parsed.tasks['task-b']
    expect(taskB.depends_on).toContain('task-a')
    expect(taskB.dependents).toEqual([])

    expect(parsed.rootTasks).toContain('task-a')
    expect(parsed.leafTasks).toContain('task-b')
    expect(parsed.session.name).toBe('json-test')
    expect(parsed.session.budget_usd).toBeNull()
  })

  it('JSON output handles session budget_usd', async () => {
    const yaml = `
version: "1"
session:
  name: budget-session
  budget_usd: 5.0
tasks:
  task-a:
    name: Task A
    prompt: Do A
    type: coding
`
    const filePath = writeYaml('budget.yaml', yaml)
    const stdout = captureStdout()
    const stderr = captureStderr()

    await runGraphAction({ filePath, outputFormat: 'json' })

    stdout.restore()
    stderr.restore()

    const parsed = JSON.parse(stdout.chunks.join('')) as {
      session: { budget_usd: number | null }
    }
    expect(parsed.session.budget_usd).toBe(5.0)
  })
})
