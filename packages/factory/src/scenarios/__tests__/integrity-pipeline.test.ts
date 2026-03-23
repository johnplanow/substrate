/**
 * Integration and unit tests for scenario integrity verification during pipeline runs.
 * Story 44-4: Scenario Integrity Verification During Pipeline Runs.
 *
 * Tests:
 * - AC1: Manifest captured once at run start when scenarioStore configured
 * - AC2: verifyIntegrity() called before each tool node
 * - AC3: Tampered (modified or deleted) file halts pipeline with scenario:integrity-failed
 * - AC4: Unmodified scenarios emit scenario:integrity-passed and executor returns SUCCESS
 * - AC5: Integrity check skipped for non-tool nodes
 * - AC6: No scenarioStore → no discover(), no integrity events, backward-compatible
 * - Unit: verifyIntegrity() delegates to verify()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { ScenarioStore } from '../store.js'
import {
  makeEventSpy,
  makeMockRegistry,
  makeTmpDir,
  cleanDir,
} from '../../__tests__/integration/helpers.js'

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'substrate-integrity-test-'))
}

function setupScenariosDir(projectRoot: string): string {
  const scenariosDir = join(projectRoot, '.substrate', 'scenarios')
  mkdirSync(scenariosDir, { recursive: true })
  return scenariosDir
}

// ---------------------------------------------------------------------------
// DOT graph fixtures
// ---------------------------------------------------------------------------

/** Minimal graph: start → tool node → exit */
const TOOL_NODE_DOT = `
digraph test_tool_integrity {
  graph [goal="Integrity test"]
  start [shape=Mdiamond]
  tool1 [type=tool, label="Run scenario"]
  exit [shape=Msquare]
  start -> tool1
  tool1 -> exit
}
`

/** Graph with two sequential tool nodes */
const TWO_TOOL_NODES_DOT = `
digraph test_two_tools {
  graph [goal="Two tool nodes"]
  start [shape=Mdiamond]
  tool1 [type=tool, label="First scenario"]
  tool2 [type=tool, label="Second scenario"]
  exit [shape=Msquare]
  start -> tool1
  tool1 -> tool2
  tool2 -> exit
}
`

/** Graph with no tool nodes: start → codergen → exit */
const NO_TOOL_NODE_DOT = `
digraph test_no_tool {
  graph [goal="No tool node"]
  start [shape=Mdiamond]
  check [type=codergen, label="Check"]
  exit [shape=Msquare]
  start -> check
  check -> exit
}
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scenario Integrity Verification (Story 44-4)', () => {
  let tmpDir: string
  let logsRoot: string

  beforeEach(async () => {
    tmpDir = createTmpDir()
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true })
    await cleanDir(logsRoot)
    vi.restoreAllMocks()
  })

  // --------------------------------------------------------------------------
  // Unit test: verifyIntegrity() delegates to verify()
  // --------------------------------------------------------------------------

  it('verifyIntegrity() delegates to verify() and returns same result', async () => {
    const store = new ScenarioStore()
    const scenariosDir = setupScenariosDir(tmpDir)
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), 'echo login')

    const manifest = await store.discover(tmpDir)

    const verifyResult = await store.verify(manifest)
    const integrityResult = await store.verifyIntegrity(manifest)

    expect(integrityResult).toEqual(verifyResult)
    expect(integrityResult.valid).toBe(true)
    expect(integrityResult.tampered).toEqual([])
  })

  // --------------------------------------------------------------------------
  // AC1: Manifest captured at pipeline start
  // --------------------------------------------------------------------------

  it('AC1: discover() called exactly once at run start when scenarioStore is configured', async () => {
    const store = new ScenarioStore()
    const discoverSpy = vi.spyOn(store, 'discover')
    discoverSpy.mockResolvedValue({ scenarios: [], capturedAt: Date.now() })

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac1',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    expect(discoverSpy).toHaveBeenCalledTimes(1)
  })

  // --------------------------------------------------------------------------
  // AC6: Backward-compatible — no scenarioStore means no integrity checks
  // --------------------------------------------------------------------------

  it('AC6: discover() NOT called when no scenarioStore configured', async () => {
    const store = new ScenarioStore()
    const discoverSpy = vi.spyOn(store, 'discover')

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-ac6',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      // No scenarioStore — backward-compatible
    })

    expect(discoverSpy).not.toHaveBeenCalled()
    expect(outcome.status).toBe('SUCCESS')

    const integrityEvents = events.filter(
      (e) => e.event === 'scenario:integrity-passed' || e.event === 'scenario:integrity-failed',
    )
    expect(integrityEvents).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // AC2: verifyIntegrity() called before each tool node
  // --------------------------------------------------------------------------

  it('AC2: verifyIntegrity() called once per tool node visit', async () => {
    const store = new ScenarioStore()
    vi.spyOn(store, 'discover').mockResolvedValue({ scenarios: [], capturedAt: Date.now() })
    const verifySpy = vi.spyOn(store, 'verifyIntegrity')
    verifySpy.mockResolvedValue({ valid: true, tampered: [] })

    const graph = parseGraph(TWO_TOOL_NODES_DOT)
    const { registry } = makeMockRegistry()
    const { bus } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-ac2',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    // Two tool nodes → verifyIntegrity called twice
    expect(verifySpy).toHaveBeenCalledTimes(2)
  })

  // --------------------------------------------------------------------------
  // AC3: Tampered scenario file halts pipeline with event
  // --------------------------------------------------------------------------

  it('AC3: modified scenario file → status FAIL + scenario:integrity-failed event', async () => {
    const store = new ScenarioStore()
    const scenariosDir = setupScenariosDir(tmpDir)
    const scenarioFile = join(scenariosDir, 'scenario-login.sh')
    writeFileSync(scenarioFile, 'echo login')

    // Capture manifest before modification
    const manifest = await store.discover(tmpDir)

    // Modify the file to simulate tampering between iterations
    writeFileSync(scenarioFile, 'echo TAMPERED')

    // Mock discover() to return the original (pre-tamper) manifest
    vi.spyOn(store, 'discover').mockResolvedValue(manifest)

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-ac3-modify',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.failureReason).toContain('Scenario integrity violation')
    expect(outcome.failureReason).toContain('scenario-login.sh')

    const failedEvents = events.filter((e) => e.event === 'scenario:integrity-failed')
    expect(failedEvents).toHaveLength(1)
    const payload = failedEvents[0]!.payload as { runId: string; nodeId: string; tampered: string[] }
    expect(payload.runId).toBe('test-ac3-modify')
    expect(payload.nodeId).toBe('tool1')
    expect(payload.tampered).toContain('scenario-login.sh')
  })

  it('AC3: deleted scenario file → status FAIL + scenario:integrity-failed event', async () => {
    const store = new ScenarioStore()
    const scenariosDir = setupScenariosDir(tmpDir)
    const scenarioFile = join(scenariosDir, 'scenario-deploy.sh')
    writeFileSync(scenarioFile, 'echo deploy')

    // Capture manifest before deletion
    const manifest = await store.discover(tmpDir)

    // Delete the file to simulate tampering
    unlinkSync(scenarioFile)

    // Mock discover() to return the original (pre-delete) manifest
    vi.spyOn(store, 'discover').mockResolvedValue(manifest)

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-ac3-delete',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.failureReason).toContain('scenario-deploy.sh')

    const failedEvents = events.filter((e) => e.event === 'scenario:integrity-failed')
    expect(failedEvents).toHaveLength(1)
    const payload = failedEvents[0]!.payload as { runId: string; nodeId: string; tampered: string[] }
    expect(payload.tampered).toContain('scenario-deploy.sh')
  })

  // --------------------------------------------------------------------------
  // AC4: Unmodified scenarios emit pass event and proceed
  // --------------------------------------------------------------------------

  it('AC4: unmodified scenarios → scenario:integrity-passed event + SUCCESS outcome', async () => {
    const store = new ScenarioStore()
    const scenariosDir = setupScenariosDir(tmpDir)
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), 'echo login')

    // Capture the real manifest (files unmodified)
    const realManifest = await store.discover(tmpDir)
    vi.spyOn(store, 'discover').mockResolvedValue(realManifest)

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-ac4',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    expect(outcome.status).toBe('SUCCESS')

    const passedEvents = events.filter((e) => e.event === 'scenario:integrity-passed')
    expect(passedEvents).toHaveLength(1)
    const payload = passedEvents[0]!.payload as { runId: string; nodeId: string; scenarioCount: number }
    expect(payload.runId).toBe('test-ac4')
    expect(payload.nodeId).toBe('tool1')
    expect(payload.scenarioCount).toBe(1)
  })

  // --------------------------------------------------------------------------
  // AC5: Integrity check skipped for non-tool nodes
  // --------------------------------------------------------------------------

  it('AC5: verifyIntegrity() NOT called when graph has no tool nodes', async () => {
    const store = new ScenarioStore()
    vi.spyOn(store, 'discover').mockResolvedValue({ scenarios: [], capturedAt: Date.now() })
    const verifySpy = vi.spyOn(store, 'verifyIntegrity')

    const graph = parseGraph(NO_TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-ac5',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    expect(outcome.status).toBe('SUCCESS')
    expect(verifySpy).not.toHaveBeenCalled()
  })

  // --------------------------------------------------------------------------
  // Additional: graph:node-started not emitted when integrity check fails
  // --------------------------------------------------------------------------

  it('graph:node-started is NOT emitted for tool node when integrity check fails', async () => {
    const store = new ScenarioStore()
    const scenariosDir = setupScenariosDir(tmpDir)
    const scenarioFile = join(scenariosDir, 'scenario-login.sh')
    writeFileSync(scenarioFile, 'original content')

    const manifest = await store.discover(tmpDir)
    writeFileSync(scenarioFile, 'tampered content')
    vi.spyOn(store, 'discover').mockResolvedValue(manifest)

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-no-node-started',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    expect(outcome.status).toBe('FAIL')

    // graph:node-started must NOT be emitted for the tool node
    const nodeStartedForTool = events.filter(
      (e) =>
        e.event === 'graph:node-started' &&
        (e.payload as { nodeId: string }).nodeId === 'tool1',
    )
    expect(nodeStartedForTool).toHaveLength(0)
  })

  // --------------------------------------------------------------------------
  // Additional: scenario:integrity-failed not emitted when files unmodified
  // --------------------------------------------------------------------------

  it('scenario:integrity-failed is NOT emitted when files are unmodified', async () => {
    const store = new ScenarioStore()
    vi.spyOn(store, 'discover').mockResolvedValue({ scenarios: [], capturedAt: Date.now() })

    const graph = parseGraph(TOOL_NODE_DOT)
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()

    await createGraphExecutor().run(graph, {
      runId: 'test-no-fail-event',
      logsRoot,
      handlerRegistry: registry,
      eventBus: bus,
      scenarioStore: store,
    })

    const failedEvents = events.filter((e) => e.event === 'scenario:integrity-failed')
    expect(failedEvents).toHaveLength(0)
  })
})
