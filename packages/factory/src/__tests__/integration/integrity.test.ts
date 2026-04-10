/**
 * Integration tests: ScenarioStore integrity verification (Story 44-10 AC3).
 *
 * Verifies that ScenarioStore.discover() captures SHA-256 checksums and
 * ScenarioStore.verify() correctly detects tampered, missing, and added files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScenarioStore } from '../../scenarios/store.js'
import { parseGraph } from '../../graph/parser.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { makeEventSpy, makeMockRegistry, makeTmpDir, cleanDir, readFixtureDot } from './helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ScenarioStore's expected directory: tempDir/.substrate/scenarios/ */
async function createScenariosDir(tempDir: string): Promise<string> {
  const scenariosDir = join(tempDir, '.substrate', 'scenarios')
  await writeFile(join(tempDir, '.gitkeep'), '') // ensure tempDir exists (mkdtemp handles this)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(scenariosDir, { recursive: true })
  return scenariosDir
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tempDir: string
let scenariosDir: string
let store: ScenarioStore

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'integrity-test-'))
  scenariosDir = await createScenariosDir(tempDir)
  store = new ScenarioStore()
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AC3: Integrity tamper detection
// ---------------------------------------------------------------------------

describe('ScenarioStore integrity verification (AC3)', () => {
  it('AC3a: discover returns manifest with 2 entries when 2 scenario files exist', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    expect(manifest.scenarios).toHaveLength(2)
    expect(manifest.scenarios.every((s) => s.checksum.length > 0)).toBe(true)
  })

  it('AC3b: verify returns invalid result when a scenario file is modified', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    // Tamper: modify scenario-pass.sh content
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 99\n')

    const result = await store.verify(manifest)

    expect(result.valid).toBe(false)
  })

  it('AC3c: verify returns the tampered scenario name in the failure details', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    // Tamper only scenario-pass.sh
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 42\n')

    const result = await store.verify(manifest)

    expect(result.tampered).toContain('scenario-pass.sh')
    expect(result.tampered).not.toContain('scenario-fail.sh')
  })

  it('AC3d: verify passes when no files are modified after manifest capture', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)
    const result = await store.verify(manifest)

    expect(result.valid).toBe(true)
    expect(result.tampered).toHaveLength(0)
  })

  it('AC3d-alias: verifyIntegrity delegates to verify and passes for unmodified files', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')

    const manifest = await store.discover(tempDir)
    const result = await store.verifyIntegrity(manifest)

    expect(result.valid).toBe(true)
  })

  it('AC3e: verify detects a deleted scenario file as tampered', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const manifest = await store.discover(tempDir)

    // Delete one file
    const { unlink } = await import('node:fs/promises')
    await unlink(join(scenariosDir, 'scenario-pass.sh'))

    const result = await store.verify(manifest)

    expect(result.valid).toBe(false)
    expect(result.tampered).toContain('scenario-pass.sh')
  })

  it('AC3f: ScenarioStoreVerifyResult type shape — valid boolean and tampered string array', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    const manifest = await store.discover(tempDir)
    const result = await store.verify(manifest)

    // Type check: valid is boolean, tampered is string[]
    expect(typeof result.valid).toBe('boolean')
    expect(Array.isArray(result.tampered)).toBe(true)
    result.tampered.forEach((entry) => {
      expect(typeof entry).toBe('string')
    })
  })
})

// ---------------------------------------------------------------------------
// AC3-executor: integrity tamper detected by executor — execution halts
// ---------------------------------------------------------------------------

describe('AC3-executor: graph executor halts before validate node when integrity check fails', () => {
  it('AC3-executor-a: executor returns FAIL outcome when a scenario file is tampered before validate dispatch', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    // Capture manifest BEFORE tampering
    const realManifest = await store.discover(tempDir)

    // Create a proxy ScenarioStore whose discover() returns the pre-captured manifest
    // (executor calls discover() without args, which would default to process.cwd()).
    // verifyIntegrity() delegates to the real implementation so tampered files are detected.
    const proxyStore = new ScenarioStore()
    vi.spyOn(proxyStore, 'discover').mockResolvedValue(realManifest)

    // Tamper AFTER manifest capture — simulate a tampered file between capture and dispatch
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 99\n')

    const graph = parseGraph(readFixtureDot())
    const { registry } = makeMockRegistry()
    const logsRoot = await makeTmpDir()
    try {
      const outcome = await createGraphExecutor().run(graph, {
        runId: 'test-integrity-halt-a',
        logsRoot,
        handlerRegistry: registry,
        scenarioStore: proxyStore,
      })

      expect(outcome.status).toBe('FAIL')
    } finally {
      await cleanDir(logsRoot)
    }
  })

  it('AC3-executor-b: graph:node-started is never emitted for validate when integrity check fails', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')

    const realManifest = await store.discover(tempDir)
    const proxyStore = new ScenarioStore()
    vi.spyOn(proxyStore, 'discover').mockResolvedValue(realManifest)

    // Tamper the only scenario file
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\necho tampered\n')

    const graph = parseGraph(readFixtureDot())
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()
    const logsRoot = await makeTmpDir()
    try {
      await createGraphExecutor().run(graph, {
        runId: 'test-integrity-halt-b',
        logsRoot,
        handlerRegistry: registry,
        eventBus: bus,
        scenarioStore: proxyStore,
      })

      // The validate tool node must never have been started
      const validateStarted = events.filter(
        (e) =>
          e.event === 'graph:node-started' &&
          (e.payload as Record<string, unknown>)['nodeId'] === 'validate'
      )
      expect(validateStarted).toHaveLength(0)
    } finally {
      await cleanDir(logsRoot)
    }
  })

  it('AC3-executor-c: scenario:integrity-failed event is emitted with tampered file name', async () => {
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 0\n')
    await writeFile(join(scenariosDir, 'scenario-fail.sh'), '#!/bin/bash\nexit 1\n')

    const realManifest = await store.discover(tempDir)
    const proxyStore = new ScenarioStore()
    vi.spyOn(proxyStore, 'discover').mockResolvedValue(realManifest)

    // Tamper only scenario-pass.sh
    await writeFile(join(scenariosDir, 'scenario-pass.sh'), '#!/bin/bash\nexit 100\n')

    const graph = parseGraph(readFixtureDot())
    const { registry } = makeMockRegistry()
    const { bus, events } = makeEventSpy()
    const logsRoot = await makeTmpDir()
    try {
      await createGraphExecutor().run(graph, {
        runId: 'test-integrity-event',
        logsRoot,
        handlerRegistry: registry,
        eventBus: bus,
        scenarioStore: proxyStore,
      })

      const integrityFailedEvents = events.filter((e) => e.event === 'scenario:integrity-failed')
      expect(integrityFailedEvents).toHaveLength(1)
      const payload = integrityFailedEvents[0]?.payload as Record<string, unknown>
      expect(Array.isArray(payload['tampered'])).toBe(true)
      expect(payload['tampered'] as string[]).toContain('scenario-pass.sh')
    } finally {
      await cleanDir(logsRoot)
    }
  })
})
