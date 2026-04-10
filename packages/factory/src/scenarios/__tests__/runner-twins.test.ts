/**
 * Unit tests for ScenarioRunner twin integration (story 47-3).
 *
 * Tests cover:
 *  (a) startTwins called with correct names before scenario execution
 *  (b) env vars from startTwins are injected into subprocess environment
 *  (c) stopTwins called after all scenarios pass
 *  (d) stopTwins called even when a scenario exits with non-zero code
 *  (e) twin startup failure returns error ScenarioRunResult without executing any scenarios and without calling stopTwins
 *  (f) manifest with no twins field triggers no coordinator calls
 */

import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScenarioRunner } from '../runner.js'
import type { TwinCoordinator } from '../runner.js'
import type { ScenarioManifest } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

function createTmpScript(content: string): { scriptPath: string; checksum: string } {
  const scriptPath = path.join(tmpDir, `scenario-${crypto.randomUUID()}.sh`)
  fs.writeFileSync(scriptPath, content)
  fs.chmodSync(scriptPath, 0o755)
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex')
  return { scriptPath, checksum }
}

function makeMockCoordinator(overrides?: Partial<TwinCoordinator>): TwinCoordinator {
  return {
    startTwins: vi.fn().mockResolvedValue({}),
    stopTwins: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-twins-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScenarioRunner — twin integration', () => {
  // (a) startTwins is called with correct twin names before scenario execution
  it('(a) calls startTwins with the correct twin names before any scenario runs', async () => {
    const callOrder: string[] = []

    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\necho "{}"\nexit 0\n')
    const scenarioName = path.basename(scriptPath)

    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockImplementation(async (names: string[]) => {
        callOrder.push('startTwins:' + names.join(','))
        return {}
      }),
      stopTwins: vi.fn().mockImplementation(async () => {
        callOrder.push('stopTwins')
      }),
    }

    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: ['stripe', 'sendgrid'],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    expect(coordinator.startTwins).toHaveBeenCalledWith(['stripe', 'sendgrid'])
    expect(callOrder[0]).toBe('startTwins:stripe,sendgrid')
    // startTwins must appear before stopTwins
    expect(callOrder.indexOf('startTwins:stripe,sendgrid')).toBeLessThan(
      callOrder.indexOf('stopTwins')
    )
    expect(result.summary.total).toBe(1)
  })

  // (b) env vars from startTwins are present in subprocess environment
  it('(b) injects env vars from startTwins into scenario subprocess environment', async () => {
    // Script prints an env var as JSON
    const { scriptPath, checksum } = createTmpScript(
      '#!/bin/sh\nprintf \'{"TWIN_INJECTED":"%s"}\' "$TWIN_URL"\n'
    )
    const scenarioName = path.basename(scriptPath)

    const coordinator = makeMockCoordinator({
      startTwins: vi.fn().mockResolvedValue({ TWIN_URL: 'http://localhost:9999' }),
    })

    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: ['twin-service'],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    expect(result.scenarios).toHaveLength(1)
    const scenarioResult = result.scenarios[0]!
    expect(scenarioResult.status).toBe('pass')
    expect(scenarioResult.parsedOutput).toEqual({ TWIN_INJECTED: 'http://localhost:9999' })
  })

  // (c) stopTwins is called after all scenarios pass
  it('(c) calls stopTwins exactly once after all scenarios pass', async () => {
    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\necho "{}"\nexit 0\n')
    const scenarioName = path.basename(scriptPath)

    const coordinator = makeMockCoordinator()

    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: ['my-twin'],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    expect(result.scenarios[0]!.status).toBe('pass')
    expect(coordinator.stopTwins).toHaveBeenCalledTimes(1)
  })

  // (d) stopTwins is called even when a scenario exits with non-zero code
  it('(d) calls stopTwins exactly once even when a scenario fails', async () => {
    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\nexit 1\n')
    const scenarioName = path.basename(scriptPath)

    const coordinator = makeMockCoordinator()

    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: ['my-twin'],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    expect(result.scenarios[0]!.status).toBe('fail')
    // stopTwins must be called regardless of scenario outcome
    expect(coordinator.stopTwins).toHaveBeenCalledTimes(1)
  })

  // (e) startup failure: no scripts run, all results are fail, stopTwins not called
  it('(e) returns error ScenarioRunResult on startup failure without running scenarios or calling stopTwins', async () => {
    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\necho "{}"\nexit 0\n')
    const scenarioName = path.basename(scriptPath)

    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockRejectedValue(new Error('Docker not found — twins require Docker')),
      stopTwins: vi.fn(),
    }

    const manifest: ScenarioManifest = {
      scenarios: [
        { name: scenarioName, path: scriptPath, checksum },
        { name: 'another.sh', path: scriptPath, checksum },
      ],
      capturedAt: Date.now(),
      twins: ['stripe'],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    // All scenarios should be failed
    expect(result.summary.failed).toBe(2)
    expect(result.summary.passed).toBe(0)
    expect(result.scenarios).toHaveLength(2)
    for (const s of result.scenarios) {
      expect(s.status).toBe('fail')
      expect(s.exitCode).toBe(-1)
      expect(s.stderr).toContain('Docker not found')
    }

    // stopTwins must NOT be called (nothing was started)
    expect(coordinator.stopTwins).not.toHaveBeenCalled()
  })

  // (f) no twins field — no coordinator calls, run completes normally
  it('(f) does not call coordinator methods when manifest has no twins field', async () => {
    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\necho "{}"\nexit 0\n')
    const scenarioName = path.basename(scriptPath)

    const coordinator = makeMockCoordinator()

    // No twins field at all
    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    expect(coordinator.startTwins).not.toHaveBeenCalled()
    expect(coordinator.stopTwins).not.toHaveBeenCalled()
    expect(result.summary.total).toBe(1)
    expect(result.scenarios[0]!.status).toBe('pass')
  })

  it('(f) does not call coordinator methods when manifest has twins: []', async () => {
    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\necho "{}"\nexit 0\n')
    const scenarioName = path.basename(scriptPath)

    const coordinator = makeMockCoordinator()

    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: [],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, tmpDir)

    expect(coordinator.startTwins).not.toHaveBeenCalled()
    expect(coordinator.stopTwins).not.toHaveBeenCalled()
    expect(result.summary.total).toBe(1)
  })

  it('(f) does not call coordinator methods when no twinCoordinator is provided', async () => {
    const { scriptPath, checksum } = createTmpScript('#!/bin/sh\necho "{}"\nexit 0\n')
    const scenarioName = path.basename(scriptPath)

    const manifest: ScenarioManifest = {
      scenarios: [{ name: scenarioName, path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: ['stripe'],
    }

    // No twinCoordinator in options
    const runner = createScenarioRunner()
    const result = await runner.run(manifest, tmpDir)

    // Should complete normally using existing code path
    expect(result.summary.total).toBe(1)
    expect(result.scenarios[0]!.status).toBe('pass')
  })
})
