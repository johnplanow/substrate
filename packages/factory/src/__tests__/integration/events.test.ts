/**
 * Integration tests: Event emission and ScenarioStore discovery (Story 44-10 AC5, AC6).
 *
 * AC5: graph:node-started and graph:node-completed emitted for validate tool node
 * AC6: ScenarioStore.discover() produces a valid manifest for mock scenario files
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.mock hoisted — must appear before imports that use spawn
// Use importOriginal to preserve exec/execFile/etc. — @substrate-ai/core uses them
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: vi.fn(),
  }
})

import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypedEventBusImpl } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import { ScenarioStore } from '../../scenarios/store.js'
import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { HandlerRegistry } from '../../handlers/registry.js'
import { startHandler } from '../../handlers/start.js'
import { exitHandler } from '../../handlers/exit.js'
import { conditionalHandler } from '../../handlers/conditional.js'
import { createToolHandler } from '../../handlers/tool.js'
import {
  makeTmpDir,
  cleanDir,
  buildScenarioRunResult,
  createMockSpawnProcess,
  readFixtureDot,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSpawn = vi.mocked(spawn)

function createTestRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register('conditional', conditionalHandler)
  registry.register('tool', createToolHandler())
  const mockSuccess = async () => ({ status: 'SUCCESS' as const })
  registry.register('codergen', mockSuccess)
  registry.registerShape('Mdiamond', 'start')
  registry.registerShape('Msquare', 'exit')
  registry.registerShape('diamond', 'conditional')
  registry.registerShape('box', 'codergen')
  registry.registerShape('parallelogram', 'tool')
  registry.setDefault(mockSuccess)
  return registry
}

// ---------------------------------------------------------------------------
// AC5: event emission for validate tool node
// ---------------------------------------------------------------------------

describe('AC5: graph:node-started and graph:node-completed emitted for validate node', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
    vi.clearAllMocks()
  })

  it('AC5a: graph:node-started emitted before graph:node-completed for validate', async () => {
    const result1 = buildScenarioRunResult(3, 3) // pass first time to terminate
    mockSpawn.mockImplementationOnce(() =>
      createMockSpawnProcess({ stdout: JSON.stringify(result1), exitCode: 0 })
    )

    // Use real TypedEventBusImpl with on() listeners
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const emitted: string[] = []

    eventBus.on('graph:node-started', ({ nodeId }) => {
      emitted.push(`started:${nodeId}`)
    })
    eventBus.on('graph:node-completed', ({ nodeId }) => {
      emitted.push(`completed:${nodeId}`)
    })

    const graph = parseGraph(readFixtureDot())
    await createGraphExecutor().run(graph, {
      runId: 'test-ac5a',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus,
    })

    const validateStartedIdx = emitted.findIndex((e) => e === 'started:validate')
    const validateCompletedIdx = emitted.findIndex((e) => e === 'completed:validate')

    expect(validateStartedIdx).toBeGreaterThanOrEqual(0)
    expect(validateCompletedIdx).toBeGreaterThan(validateStartedIdx)
  })

  it('AC5b: graph:node-started for validate has nodeId === "validate"', async () => {
    mockSpawn.mockImplementationOnce(() =>
      createMockSpawnProcess({ stdout: JSON.stringify(buildScenarioRunResult(3, 3)), exitCode: 0 })
    )

    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const nodeStartedEvents: Array<{ runId: string; nodeId: string; nodeType: string }> = []
    eventBus.on('graph:node-started', (payload) => {
      nodeStartedEvents.push(payload)
    })

    await createGraphExecutor().run(parseGraph(readFixtureDot()), {
      runId: 'test-ac5b',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus,
    })

    const validateEvent = nodeStartedEvents.find((e) => e.nodeId === 'validate')
    expect(validateEvent).toBeDefined()
    expect(validateEvent?.nodeId).toBe('validate')
  })

  it('AC5c: graph:node-completed for validate has status === "SUCCESS"', async () => {
    mockSpawn.mockImplementationOnce(() =>
      createMockSpawnProcess({ stdout: JSON.stringify(buildScenarioRunResult(3, 3)), exitCode: 0 })
    )

    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    const nodeCompletedEvents: Array<{
      runId: string
      nodeId: string
      outcome: { status: string }
    }> = []
    eventBus.on('graph:node-completed', (payload) => {
      nodeCompletedEvents.push(payload)
    })

    await createGraphExecutor().run(parseGraph(readFixtureDot()), {
      runId: 'test-ac5c',
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus,
    })

    const validateCompleted = nodeCompletedEvents.find((e) => e.nodeId === 'validate')
    expect(validateCompleted?.outcome.status).toBe('SUCCESS')
  })

  it('AC5d: graph:node-started and graph:node-completed for validate share the same runId', async () => {
    mockSpawn.mockImplementationOnce(() =>
      createMockSpawnProcess({ stdout: JSON.stringify(buildScenarioRunResult(3, 3)), exitCode: 0 })
    )

    const testRunId = 'test-ac5d-run'
    const eventBus = new TypedEventBusImpl<FactoryEvents>()
    let startedRunId: string | undefined
    let completedRunId: string | undefined

    eventBus.on('graph:node-started', ({ nodeId, runId }) => {
      if (nodeId === 'validate') startedRunId = runId
    })
    eventBus.on('graph:node-completed', ({ nodeId, runId }) => {
      if (nodeId === 'validate') completedRunId = runId
    })

    await createGraphExecutor().run(parseGraph(readFixtureDot()), {
      runId: testRunId,
      logsRoot,
      handlerRegistry: createTestRegistry(),
      eventBus,
    })

    expect(startedRunId).toBe(testRunId)
    expect(completedRunId).toBe(testRunId)
    expect(startedRunId).toBe(completedRunId)
  })
})

// ---------------------------------------------------------------------------
// AC6: ScenarioStore discovery
// ---------------------------------------------------------------------------

describe('AC6: ScenarioStore.discover() produces valid manifest', () => {
  let tempDir: string
  let scenariosDir: string
  const store = new ScenarioStore()

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'scenario-discover-test-'))
    scenariosDir = join(tempDir, '.substrate', 'scenarios')
    await mkdir(scenariosDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('AC6a: manifest contains exactly 2 entries for 2 scenario files', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    expect(manifest.scenarios).toHaveLength(2)
  })

  it('AC6b: each manifest entry checksum is a 64-character hex string (SHA-256)', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    for (const entry of manifest.scenarios) {
      expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('AC6c: manifest.capturedAt is within 5000 ms of Date.now()', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')

    const before = Date.now()
    const manifest = await store.discover(tempDir)
    const after = Date.now()

    expect(manifest.capturedAt).toBeGreaterThanOrEqual(before - 5000)
    expect(manifest.capturedAt).toBeLessThanOrEqual(after + 5000)
  })

  it('AC6d: each manifest entry path matches the written file paths', async () => {
    const passPath = join(scenariosDir, 'scenario-pass.sh')
    const failPath = join(scenariosDir, 'scenario-fail.sh')
    await writeFile(passPath, '#!/bin/bash\nexit 0\n')
    await writeFile(failPath, '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    const paths = manifest.scenarios.map((s) => s.path)
    expect(paths).toContain(passPath)
    expect(paths).toContain(failPath)
  })
})
