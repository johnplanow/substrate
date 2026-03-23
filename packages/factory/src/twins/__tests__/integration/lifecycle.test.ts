/**
 * Integration tests for twin lifecycle with ScenarioRunner.
 *
 * Verifies:
 *  1. startTwins is called before scenario subprocess executes
 *  2. stopTwins is called exactly once when scenario passes
 *  3. stopTwins is called exactly once even when scenario fails
 *  4. startup failure returns all-failed result, stopTwins NOT called
 *  5. env vars from startTwins are injected into scenario subprocess
 *
 * Story 47-8, Task 2 (AC1).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScenarioRunner } from '../../../scenarios/runner.js'
import type { TwinCoordinator } from '../../../scenarios/runner.js'
import type { ScenarioManifest } from '../../../scenarios/types.js'
import { makeTmpScenario } from './helpers.js'

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let cleanupFn: (() => void) | null = null
let extraTmpDir: string | null = null

beforeEach(() => {
  cleanupFn = null
  extraTmpDir = null
})

afterEach(() => {
  cleanupFn?.()
  cleanupFn = null
  if (extraTmpDir !== null) {
    fs.rmSync(extraTmpDir, { recursive: true, force: true })
    extraTmpDir = null
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('twin lifecycle integration', () => {
  it('Test 1 — startTwins is called before scenario script executes', async () => {
    let startWasCalled = false
    const callOrder: string[] = []

    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockImplementation(async (names: string[]) => {
        startWasCalled = true
        callOrder.push('startTwins:' + names.join(','))
        return {}
      }),
      stopTwins: vi.fn().mockImplementation(async () => {
        callOrder.push('stopTwins')
      }),
    }

    const { manifest, cleanup } = makeTmpScenario(['localstack'])
    cleanupFn = cleanup

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    await runner.run(manifest, os.tmpdir())

    expect(startWasCalled).toBe(true)
    expect(coordinator.startTwins).toHaveBeenCalledWith(['localstack'])
    expect(callOrder.indexOf('startTwins:localstack')).toBeLessThan(callOrder.indexOf('stopTwins'))
  })

  it('Test 2 — stopTwins called exactly once when scenario passes', async () => {
    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockResolvedValue({}),
      stopTwins: vi.fn().mockResolvedValue(undefined),
    }

    const { manifest, cleanup } = makeTmpScenario(['localstack'], 0)
    cleanupFn = cleanup

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, os.tmpdir())

    expect(result.scenarios[0]!.status).toBe('pass')
    expect(coordinator.stopTwins).toHaveBeenCalledTimes(1)
  })

  it('Test 3 — stopTwins called exactly once even when scenario fails', async () => {
    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockResolvedValue({}),
      stopTwins: vi.fn().mockResolvedValue(undefined),
    }

    const { manifest, cleanup } = makeTmpScenario(['localstack'], 1)
    cleanupFn = cleanup

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, os.tmpdir())

    expect(result.scenarios[0]!.status).toBe('fail')
    expect(coordinator.stopTwins).toHaveBeenCalledTimes(1)
  })

  it('Test 4 — startup failure returns all-failed result without calling stopTwins', async () => {
    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockRejectedValue(new Error('Docker not found')),
      stopTwins: vi.fn().mockResolvedValue(undefined),
    }

    const { manifest, cleanup } = makeTmpScenario(['localstack'])
    cleanupFn = cleanup

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, os.tmpdir())

    expect(result.summary.failed).toBe(manifest.scenarios.length)
    expect(result.summary.passed).toBe(0)
    for (const scenario of result.scenarios) {
      expect(scenario.status).toBe('fail')
      expect(scenario.stderr).toContain('Docker not found')
    }
    expect(coordinator.stopTwins).not.toHaveBeenCalled()
  })

  it('Test 5 — env vars from startTwins are injected into scenario subprocess', async () => {
    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockResolvedValue({ TWIN_TEST_PORT: '19999' }),
      stopTwins: vi.fn().mockResolvedValue(undefined),
    }

    // Create a script that prints the env var as JSON
    extraTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-integ-env-'))
    const scriptPath = path.join(extraTmpDir, 'scenario-env.sh')
    fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf \'{"v":"%s"}\' "$TWIN_TEST_PORT"\n')
    fs.chmodSync(scriptPath, 0o755)
    const checksum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(scriptPath))
      .digest('hex')

    const manifest: ScenarioManifest = {
      scenarios: [{ name: 'scenario-env.sh', path: scriptPath, checksum }],
      capturedAt: Date.now(),
      twins: ['localstack'],
    }

    const runner = createScenarioRunner({ twinCoordinator: coordinator })
    const result = await runner.run(manifest, extraTmpDir)

    expect(result.scenarios[0]!.stdout).toContain('19999')
  })
})
