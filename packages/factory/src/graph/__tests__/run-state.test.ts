/**
 * Unit tests for RunStateManager (story 44-7).
 *
 * Covers all acceptance criteria:
 *   AC1 — initRun() creates run dir and writes graph.dot
 *   AC2 — writeNodeArtifacts() writes status.json; no prompt.md when prompt omitted
 *   AC3 — writeNodeArtifacts() writes prompt.md and response.md when provided
 *   AC4 — writeScenarioIteration() writes manifest.json
 *   AC5 — writeScenarioIteration() writes results.json when provided
 *   + additional: no results.json when results omitted; initRun is idempotent
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RunStateManager } from '../run-state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8')
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RunStateManager', () => {
  let tmpDir: string
  let manager: RunStateManager

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'run-state-test-'))
    manager = new RunStateManager({ runDir: tmpDir })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // AC1: initRun creates directory and graph.dot
  // -------------------------------------------------------------------------

  describe('initRun()', () => {
    it('AC1: creates graph.dot containing the DOT source string', async () => {
      const dotSource = 'digraph G {}'
      await manager.initRun(dotSource)

      const graphDotPath = path.join(tmpDir, 'graph.dot')
      expect(await fileExists(graphDotPath)).toBe(true)
      expect(await readText(graphDotPath)).toBe(dotSource)
    })

    it('AC1: creates run directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'r1', 'nested')
      const nestedManager = new RunStateManager({ runDir: nestedDir })
      await nestedManager.initRun('digraph {}')

      expect(await fileExists(path.join(nestedDir, 'graph.dot'))).toBe(true)
    })

    it('is idempotent — calling twice does not throw', async () => {
      await manager.initRun('digraph A {}')
      await expect(manager.initRun('digraph B {}')).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC2: writeNodeArtifacts writes status.json for all node types
  // -------------------------------------------------------------------------

  describe('writeNodeArtifacts()', () => {
    it('AC2: writes status.json with all 6 required fields', async () => {
      await manager.writeNodeArtifacts({
        nodeId: 'n1',
        nodeType: 'codergen',
        status: 'SUCCESS',
        startedAt: 1000,
        completedAt: 2000,
        durationMs: 1000,
      })

      const statusPath = path.join(tmpDir, 'n1', 'status.json')
      expect(await fileExists(statusPath)).toBe(true)

      const status = (await readJson(statusPath)) as Record<string, unknown>
      expect(status.nodeId).toBe('n1')
      expect(status.nodeType).toBe('codergen')
      expect(status.status).toBe('SUCCESS')
      expect(status.startedAt).toBe(1000)
      expect(status.completedAt).toBe(2000)
      expect(status.durationMs).toBe(1000)
    })

    it('AC2: does NOT write prompt.md when prompt is omitted', async () => {
      await manager.writeNodeArtifacts({
        nodeId: 'n1',
        nodeType: 'codergen',
        status: 'SUCCESS',
        startedAt: 1000,
        completedAt: 2000,
        durationMs: 1000,
      })

      const promptPath = path.join(tmpDir, 'n1', 'prompt.md')
      expect(await fileExists(promptPath)).toBe(false)
    })

    it('AC2: does NOT write response.md when response is omitted', async () => {
      await manager.writeNodeArtifacts({
        nodeId: 'n1',
        nodeType: 'validate',
        status: 'FAIL',
        startedAt: 100,
        completedAt: 200,
        durationMs: 100,
      })

      const responsePath = path.join(tmpDir, 'n1', 'response.md')
      expect(await fileExists(responsePath)).toBe(false)
    })

    // -----------------------------------------------------------------------
    // AC3: prompt.md and response.md written for codergen nodes
    // -----------------------------------------------------------------------

    it('AC3: writes prompt.md and response.md when both are provided', async () => {
      await manager.writeNodeArtifacts({
        nodeId: 'n1',
        nodeType: 'codergen',
        status: 'SUCCESS',
        startedAt: 1000,
        completedAt: 2000,
        durationMs: 1000,
        prompt: 'Do X',
        response: 'Done',
      })

      expect(await readText(path.join(tmpDir, 'n1', 'prompt.md'))).toBe('Do X')
      expect(await readText(path.join(tmpDir, 'n1', 'response.md'))).toBe('Done')
    })

    it('AC3: creates node subdirectory automatically', async () => {
      await manager.writeNodeArtifacts({
        nodeId: 'deep_node',
        nodeType: 'tool',
        status: 'SUCCESS',
        startedAt: 0,
        completedAt: 1,
        durationMs: 1,
      })

      expect(await fileExists(path.join(tmpDir, 'deep_node', 'status.json'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC4 + AC5: writeScenarioIteration
  // -------------------------------------------------------------------------

  describe('writeScenarioIteration()', () => {
    const manifest = { scenarios: [], capturedAt: 0 }

    it('AC4: writes manifest.json that round-trips via JSON.parse', async () => {
      await manager.writeScenarioIteration({ iteration: 2, manifest })

      const manifestPath = path.join(tmpDir, 'scenarios', '2', 'manifest.json')
      expect(await fileExists(manifestPath)).toBe(true)

      const parsed = await readJson(manifestPath)
      expect(parsed).toEqual(manifest)
    })

    it('AC5: writes results.json when results are provided', async () => {
      const results = {
        scenarios: [],
        summary: { total: 0, passed: 0, failed: 0 },
        durationMs: 0,
      }
      await manager.writeScenarioIteration({ iteration: 2, manifest, results })

      const resultsPath = path.join(tmpDir, 'scenarios', '2', 'results.json')
      expect(await fileExists(resultsPath)).toBe(true)

      const parsed = await readJson(resultsPath)
      expect(parsed).toEqual(results)
    })

    it('does NOT write results.json when results are omitted', async () => {
      await manager.writeScenarioIteration({ iteration: 2, manifest })

      const resultsPath = path.join(tmpDir, 'scenarios', '2', 'results.json')
      expect(await fileExists(resultsPath)).toBe(false)
    })

    it('creates nested scenario directory automatically', async () => {
      await manager.writeScenarioIteration({ iteration: 5, manifest })

      const iterDir = path.join(tmpDir, 'scenarios', '5')
      expect(await fileExists(path.join(iterDir, 'manifest.json'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Expose runDir
  // -------------------------------------------------------------------------

  it('exposes runDir as a readonly property', () => {
    expect(manager.runDir).toBe(tmpDir)
  })
})
