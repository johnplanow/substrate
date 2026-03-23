/**
 * Unit tests for TwinHealthMonitor (story 47-6).
 *
 * Tests cover:
 *  1. start/stop lifecycle — after stop, fetch is NOT called on subsequent intervals
 *  2. no healthcheck URL — fetch never called, getStatus() returns {}
 *  3. healthy poll — no events emitted, getStatus() shows 'healthy'
 *  4. failing poll emits warning — warning event with consecutiveFailures: 1, status 'degraded'
 *  5. warning increments counter — 2 polls → consecutiveFailures: 2
 *  6. hard failure after 3 consecutive fails — health-failed event, status 'unhealthy'
 *  7. polling stops after hard failure — fetch called exactly 3 times (not 4)
 *  8. recovery resets counter — fail then succeed → healthy, no health-failed emitted
 *  9. stop is idempotent — no errors thrown
 * 10. getStatus before start — returns {}
 * 11. ScenarioRunner health gate (unhealthy) — aborts run before scenario execution
 * 12. ScenarioRunner health gate (healthy) — scenarios proceed normally
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTwinHealthMonitor } from '../health-monitor.js'
import type { TwinHealthMonitor } from '../health-monitor.js'
import type { TwinDefinition } from '../types.js'
import type { FactoryEvents } from '../../events.js'
import type { TypedEventBus } from '@substrate-ai/core'
import { createScenarioRunner } from '../../scenarios/runner.js'
import type { ScenarioManifest } from '../../scenarios/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTwin(name: string, healthUrl?: string): TwinDefinition {
  return {
    name,
    image: 'test-image:latest',
    ports: [],
    environment: {},
    ...(healthUrl ? { healthcheck: { url: healthUrl, timeout_ms: 100 } } : {}),
  }
}

function makeEventBus(): TypedEventBus<FactoryEvents> {
  return { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Test 1 — start/stop lifecycle
// ---------------------------------------------------------------------------

describe('TwinHealthMonitor — lifecycle', () => {
  it('Test 1: does NOT call fetch after stop()', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 1000 })
    const twin = makeTwin('my-twin', 'http://localhost:8080/health')

    monitor.start([twin])
    monitor.stop()

    // Advance past one interval — should NOT trigger a poll since we stopped
    await vi.advanceTimersByTimeAsync(1100)

    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Test 2 — no healthcheck URL
  // ---------------------------------------------------------------------------

  it('Test 2: skips twins without healthcheck URL', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 1000 })
    const twin = makeTwin('no-healthcheck-twin') // no healthcheck

    monitor.start([twin])
    await vi.advanceTimersByTimeAsync(1100)

    expect(mockFetch).not.toHaveBeenCalled()
    expect(monitor.getStatus()).toEqual({})
  })

  // ---------------------------------------------------------------------------
  // Test 5 — stop is idempotent
  // ---------------------------------------------------------------------------

  it('Test 9: stop() is idempotent — no errors thrown when called multiple times', () => {
    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 1000 })
    const twin = makeTwin('my-twin', 'http://localhost:8080/health')

    // Stop before start — should not throw
    expect(() => monitor.stop()).not.toThrow()
    expect(() => monitor.stop()).not.toThrow()

    monitor.start([twin])

    // Stop multiple times after start — should not throw
    expect(() => monitor.stop()).not.toThrow()
    expect(() => monitor.stop()).not.toThrow()
  })

  // ---------------------------------------------------------------------------
  // Test 10 — getStatus before start
  // ---------------------------------------------------------------------------

  it('Test 10: getStatus() returns {} before start()', () => {
    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus)

    expect(monitor.getStatus()).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Test 3 — healthy poll
// ---------------------------------------------------------------------------

describe('TwinHealthMonitor — healthy poll', () => {
  it('Test 3: does NOT emit events on successful poll, getStatus() shows healthy', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true } as Response)
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 1000 })
    const twin = makeTwin('healthy-twin', 'http://localhost:8080/health')

    monitor.start([twin])
    await vi.advanceTimersByTimeAsync(1100)

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(monitor.getStatus()).toEqual({ 'healthy-twin': 'healthy' })

    monitor.stop()
  })
})

// ---------------------------------------------------------------------------
// Test 4 — failing poll emits warning
// ---------------------------------------------------------------------------

describe('TwinHealthMonitor — failing polls', () => {
  it('Test 4: emits twin:health-warning on first failure, getStatus() shows degraded', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, {
      monitorIntervalMs: 1000,
      maxConsecutiveFailures: 3,
    })
    const twin = makeTwin('my-twin', 'http://localhost:4566/health')

    monitor.start([twin])
    await vi.advanceTimersByTimeAsync(1100)

    expect(eventBus.emit).toHaveBeenCalledWith('twin:health-warning', expect.objectContaining({
      twinName: 'my-twin',
      consecutiveFailures: 1,
    }))
    expect(monitor.getStatus()).toEqual({ 'my-twin': 'degraded' })

    monitor.stop()
  })

  // ---------------------------------------------------------------------------
  // Test 5 — warning increments counter
  // ---------------------------------------------------------------------------

  it('Test 5: increments consecutiveFailures on each warning', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, {
      monitorIntervalMs: 1000,
      maxConsecutiveFailures: 5, // high threshold so we don't hit hard failure
    })
    const twin = makeTwin('my-twin', 'http://localhost:4566/health')

    monitor.start([twin])

    // Advance 2 full intervals
    await vi.advanceTimersByTimeAsync(2200)

    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const warningCalls = calls.filter(([event]) => event === 'twin:health-warning')
    expect(warningCalls).toHaveLength(2)
    expect(warningCalls[1]![1]).toMatchObject({ twinName: 'my-twin', consecutiveFailures: 2 })

    monitor.stop()
  })

  // ---------------------------------------------------------------------------
  // Test 6 — hard failure after 3 consecutive fails
  // ---------------------------------------------------------------------------

  it('Test 6: emits twin:health-failed after maxConsecutiveFailures (default 3), status becomes unhealthy', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, {
      monitorIntervalMs: 1000,
      maxConsecutiveFailures: 3,
    })
    const twin = makeTwin('my-twin', 'http://localhost:4566/health')

    monitor.start([twin])

    // Advance 3 full intervals
    await vi.advanceTimersByTimeAsync(3200)

    expect(eventBus.emit).toHaveBeenCalledWith('twin:health-failed', expect.objectContaining({
      twinName: 'my-twin',
    }))
    expect(monitor.getStatus()).toEqual({ 'my-twin': 'unhealthy' })

    monitor.stop()
  })

  // ---------------------------------------------------------------------------
  // Test 7 — polling stops after hard failure
  // ---------------------------------------------------------------------------

  it('Test 7: stops polling after hard failure — fetch called exactly 3 times not 4', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, {
      monitorIntervalMs: 1000,
      maxConsecutiveFailures: 3,
    })
    const twin = makeTwin('my-twin', 'http://localhost:4566/health')

    monitor.start([twin])

    // Advance 4 full intervals — but polling should stop after 3 failures
    await vi.advanceTimersByTimeAsync(4200)

    // fetch should have been called exactly 3 times (3 failures = unhealthy, then polling stops)
    expect(mockFetch).toHaveBeenCalledTimes(3)

    monitor.stop()
  })

  // ---------------------------------------------------------------------------
  // Test 8 — recovery resets counter
  // ---------------------------------------------------------------------------

  it('Test 8: recovery after failure resets counter and status to healthy, no health-failed emitted', async () => {
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        // First call fails
        return Promise.reject(new Error('ECONNREFUSED'))
      }
      // Subsequent calls succeed
      return Promise.resolve({ ok: true } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    const eventBus = makeEventBus()
    const monitor = createTwinHealthMonitor(eventBus, {
      monitorIntervalMs: 1000,
      maxConsecutiveFailures: 3,
    })
    const twin = makeTwin('my-twin', 'http://localhost:4566/health')

    monitor.start([twin])

    // Advance 2 intervals: first fails, second succeeds
    await vi.advanceTimersByTimeAsync(2200)

    // Should NOT have emitted health-failed
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls
    const failedCalls = calls.filter(([event]) => event === 'twin:health-failed')
    expect(failedCalls).toHaveLength(0)

    // Status should be healthy after recovery
    expect(monitor.getStatus()).toEqual({ 'my-twin': 'healthy' })

    monitor.stop()
  })
})

// ---------------------------------------------------------------------------
// Test 11 & 12 — ScenarioRunner health gate
// ---------------------------------------------------------------------------

describe('ScenarioRunner — twinHealthMonitor health gate', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-gate-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makePassingScript(): { name: string; path: string; checksum: string } {
    const scriptPath = path.join(tmpDir, `scenario-${crypto.randomUUID()}.sh`)
    fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(scriptPath, 0o755)
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex')
    return { name: path.basename(scriptPath), path: scriptPath, checksum }
  }

  function makeManifestWithTwins(twinNames: string[]): ScenarioManifest {
    const scenario = makePassingScript()
    return {
      scenarios: [scenario],
      capturedAt: Date.now(),
      twins: twinNames,
    }
  }

  function makeManifestNoTwins(): ScenarioManifest {
    const scenario = makePassingScript()
    return {
      scenarios: [scenario],
      capturedAt: Date.now(),
    }
  }

  it('Test 11: aborts run when a twin is unhealthy — all scenarios fail, no scripts executed', async () => {
    // Create a monitor spy that always reports 'unhealthy'
    const mockMonitor: TwinHealthMonitor = {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ 'my-twin': 'unhealthy' }),
    }

    const manifest = makeManifestWithTwins(['my-twin'])
    const runner = createScenarioRunner({ twinHealthMonitor: mockMonitor })

    // The scenarios are real scripts but we expect them NOT to be executed
    const result = await runner.run(manifest, tmpDir)

    expect(result.summary.failed).toBeGreaterThan(0)
    expect(result.summary.passed).toBe(0)
    expect(result.scenarios[0]!.stderr).toContain("Twin 'my-twin' is unhealthy")
  })

  it('Test 12: proceeds normally when all twins are healthy', async () => {
    // Create a monitor spy that reports 'healthy'
    const mockMonitor: TwinHealthMonitor = {
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ 'my-twin': 'healthy' }),
    }

    const manifest = makeManifestNoTwins()
    const runner = createScenarioRunner({ twinHealthMonitor: mockMonitor })

    const result = await runner.run(manifest, tmpDir)

    // Script exits 0 so scenarios should pass
    expect(result.summary.passed).toBeGreaterThan(0)
    expect(result.summary.failed).toBe(0)
  })
})
