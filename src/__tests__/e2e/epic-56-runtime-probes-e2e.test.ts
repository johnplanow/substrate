/**
 * End-to-end validation — Epic 55 Phase 2 (Runtime Probes).
 *
 * Reconstructs the class of failure the strata agent reported on
 * 2026-04-18: a story that shipped SHIP_IT with runtime-broken
 * artifacts (wrong image path, bad systemctl invocation, unset env
 * vars, …) because substrate's Tier A checks only test static shape.
 *
 * This suite demonstrates that with RuntimeProbeCheck wired into the
 * default pipeline, a probe that exercises the real artifact on a
 * real shell produces a structured fail finding with diagnostic
 * output (command, exit code, stdout tail, stderr tail) that flows
 * through the Phase 1 persistence surface.
 *
 * Runs real `sh -c` commands — no mocks — because the point of Phase 2
 * is runtime behavior and mocking the shell would defeat the test.
 * Timeouts are kept under 200 ms per probe so the whole suite is fast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { createDefaultVerificationPipeline, RunManifest } from '@substrate-ai/sdlc'
import type { VerificationContext } from '@substrate-ai/sdlc'
import { createEventBus } from '@substrate-ai/core'

function makeTempDir(): string {
  return join(tmpdir(), `epic-56-e2e-${randomUUID()}`)
}

function storyWithProbes(body: string): string {
  // A deliberate minimum: one AC that is satisfied, so the AC-evidence
  // check passes and we isolate the behavior to the runtime-probe check.
  return [
    '# Story 56-e2e',
    '',
    '## Acceptance Criteria',
    '',
    '### AC1: placeholder',
    '',
    '## Runtime Probes',
    '',
    '```yaml',
    body,
    '```',
    '',
  ].join('\n')
}

function makeContext(overrides: Partial<VerificationContext> & { storyContent?: string }): VerificationContext {
  return {
    storyKey: '56-e2e',
    workingDir: process.cwd(),
    commitSha: 'e2e',
    timeout: 30_000,
    // Satisfy the Tier A checks ahead of runtime-probes so we isolate
    // the behavior under test (probe verdict).
    reviewResult: { dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n' },
    outputTokenCount: 500,
    devStoryResult: {
      result: 'success',
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: 'pass',
    },
    buildCommand: 'true', // stand-in: always passes so aggregate reflects the probe verdict
    ...overrides,
  }
}

describe('Epic 56 — runtime probes catch strata-style runtime bugs', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('catches a failing install probe that would previously have shipped SHIP_IT', async () => {
    // Simulates the strata Story 1-4 pattern: an install script that
    // appears to succeed by static inspection but fails on a real host.
    // Here we stand in a shell script that deterministically exits 1
    // with a diagnostic message, representing `task dolt:install` failing
    // because of the wrong image path / systemctl Quadlet error / etc.
    const story = storyWithProbes(
      [
        '- name: install-smoke',
        '  sandbox: host',
        '  description: dolt install smoke test',
        '  command: |',
        '    echo "pulling image…" >&2',
        "    echo 'Error: 403 Forbidden pulling ghcr.io/dolthub/dolt-sql-server:latest' >&2",
        '    exit 1',
        '  timeout_ms: 3000',
      ].join('\n'),
    )

    const bus = createEventBus()
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({ storyContent: story }), 'A')

    // Aggregate verdict fails, preventing auto-approval at max-review-cycles.
    expect(summary.status).toBe('fail')

    // Runtime-probe check is the failing one.
    const probeCheck = summary.checks.find((c) => c.checkName === 'runtime-probes')
    expect(probeCheck?.status).toBe('fail')
    expect(probeCheck?.findings).toBeDefined()
    expect(probeCheck?.findings?.length).toBeGreaterThan(0)

    // The structured finding carries enough diagnostic info to act on.
    const f = probeCheck?.findings?.[0]
    expect(f?.category).toBe('runtime-probe-fail')
    expect(f?.severity).toBe('error')
    expect(f?.message).toContain('install-smoke')
    expect(f?.message).toContain('dolt install smoke test') // description surfaced
    expect(f?.exitCode).toBe(1)
    expect(f?.stderrTail).toContain('403 Forbidden')
    expect(typeof f?.durationMs).toBe('number')
    expect(f?.durationMs).toBeGreaterThanOrEqual(0)

    // Findings round-trip through the real run manifest, so a supervisor
    // restart or post-run analysis sees the same diagnostic info.
    const runId = randomUUID()
    const manifest = new RunManifest(runId, tempDir)
    await manifest.patchStoryState('56-e2e', { verification_result: summary })
    const readBack = await RunManifest.read(runId, tempDir)
    const readProbe = readBack.per_story_state['56-e2e']?.verification_result?.checks.find(
      (c) => c.checkName === 'runtime-probes',
    )
    expect(readProbe?.findings?.[0]?.exitCode).toBe(1)
    expect(readProbe?.findings?.[0]?.stderrTail).toContain('403 Forbidden')
  })

  it('catches a probe that times out (runtime-probe-timeout category)', async () => {
    const story = storyWithProbes(
      [
        '- name: stuck-probe',
        '  sandbox: host',
        '  command: sleep 10',
        '  timeout_ms: 150',
      ].join('\n'),
    )

    const bus = createEventBus()
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({ storyContent: story }), 'A')

    const probeCheck = summary.checks.find((c) => c.checkName === 'runtime-probes')
    expect(probeCheck?.status).toBe('fail')
    expect(probeCheck?.findings?.[0]?.category).toBe('runtime-probe-timeout')
    expect(probeCheck?.findings?.[0]?.exitCode).toBeUndefined()
  }, 10_000)

  it('passes cleanly when every probe exits 0', async () => {
    const story = storyWithProbes(
      [
        '- name: smoke',
        '  sandbox: host',
        '  command: echo ok && exit 0',
        '  timeout_ms: 3000',
        '- name: multi-line',
        '  sandbox: host',
        '  command: |',
        '    echo first',
        '    echo second',
        '    exit 0',
        '  timeout_ms: 3000',
      ].join('\n'),
    )

    const bus = createEventBus()
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({ storyContent: story }), 'A')

    expect(summary.status).toBe('pass')
    const probeCheck = summary.checks.find((c) => c.checkName === 'runtime-probes')
    expect(probeCheck?.status).toBe('pass')
    expect(probeCheck?.findings).toEqual([])
  })

  it('preserves backward compatibility: a story with no ## Runtime Probes section passes', async () => {
    const story = [
      '# Story 56-old-school',
      '',
      '## Acceptance Criteria',
      '',
      '### AC1: placeholder',
    ].join('\n')

    const bus = createEventBus()
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({ storyContent: story }), 'A')

    expect(summary.status).toBe('pass')
    const probeCheck = summary.checks.find((c) => c.checkName === 'runtime-probes')
    expect(probeCheck?.status).toBe('pass')
    expect(probeCheck?.findings).toEqual([])
    expect(probeCheck?.details).toMatch(/no ## Runtime Probes section/)
  })

  it('emits a runtime-probe-deferred warn finding for sandbox: twin probes (Phase 3 placeholder)', async () => {
    const story = storyWithProbes(
      [
        '- name: future-twin',
        '  sandbox: twin',
        '  command: echo will-run-in-twin-once-phase-3-lands',
      ].join('\n'),
    )

    const bus = createEventBus()
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(makeContext({ storyContent: story }), 'A')

    const probeCheck = summary.checks.find((c) => c.checkName === 'runtime-probes')
    expect(probeCheck?.status).toBe('warn')
    expect(probeCheck?.findings).toHaveLength(1)
    expect(probeCheck?.findings?.[0]?.category).toBe('runtime-probe-deferred')
    expect(probeCheck?.findings?.[0]?.severity).toBe('warn')
  })
})
