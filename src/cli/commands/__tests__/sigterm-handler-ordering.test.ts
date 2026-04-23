/**
 * Story 58-16: ingestion-server SIGTERM/SIGINT handlers must defer exit
 * so the orchestrator's async `shutdownGracefully` (Story 58-7) can complete.
 *
 * Background: `run.ts` installs signal handlers for the telemetry ingestion
 * server (when enabled) BEFORE the orchestrator installs its own handler via
 * `orchestrator.run()`. Node fires all listeners in registration order. If the
 * ingestion-server handler called `process.exit(143)` synchronously, the
 * orchestrator's async drain would never complete — Dolt
 * `pipeline_runs.status` would stay `running`, the manifest would not be
 * patched, and active `wg_stories` rows would not be cancelled. Exactly the
 * symptom strata `obs_2026-04-21_002` documented before 58-7 shipped.
 *
 * Fix: the ingestion-server handler stops its port, then uses a
 * `setTimeout(() => process.exit(code), 6000).unref()` fallback. Normal
 * termination fires from the orchestrator's handler inside the grace window;
 * the fallback timer never fires. If the orchestrator is absent
 * (telemetry-only invocation) or its drain hangs, the fallback fires at 6s
 * and the process exits.
 *
 * This test reads `run.ts` as text and asserts the handler structure — no
 * synchronous `process.exit` in ingestion-server signal handlers, the
 * setTimeout/unref fallback pattern is present, and the conventional exit
 * codes (130 for SIGINT, 143 for SIGTERM) are preserved.
 *
 * Behavioral-level coverage is already in `sigterm-shutdown.test.ts` — that
 * exercises `process.emit('SIGTERM')` through the orchestrator's drain +
 * exit. This structural test is the belt-and-suspenders ensuring run.ts's
 * pre-installed handlers don't re-introduce the pre-emption bug.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname58_16 = dirname(fileURLToPath(import.meta.url))
const runPath = join(__dirname58_16, '..', 'run.ts')

describe('Story 58-16: ingestion-server SIGTERM handler defers exit to orchestrator', () => {
  let runSource: string

  beforeEach(async () => {
    runSource = await readFile(runPath, 'utf-8')
  })

  it('AC1: ingestion-server SIGTERM/SIGINT handlers use deferred-exit pattern (setTimeout + unref)', () => {
    // Extract all signal handler bodies in run.ts. Ingestion-server handlers
    // are identifiable by a `.stop()` call in their body (stopping either
    // the --stories-mode `ingestionServer` or the full-pipeline
    // `fpIngestionServer`).
    const handlerBlocks = runSource.match(/process\.on\('SIG(?:TERM|INT)'[\s\S]{0,350}?\}\)/g) ?? []
    const ingestionBlocks = handlerBlocks.filter((b) => /\.stop\(\)/.test(b))

    // Two installations (--stories mode + full-pipeline), each with SIGTERM
    // + SIGINT = 4 ingestion-server signal handlers minimum.
    expect(ingestionBlocks.length).toBeGreaterThanOrEqual(4)

    for (const block of ingestionBlocks) {
      // MUST use setTimeout(..., 6000).unref() — the deferred exit pattern.
      expect(block).toMatch(/setTimeout\([\s\S]*?process\.exit[\s\S]*?,\s*6000\)\.unref\(\)/)
      // Ordering sanity: `.stop()` must precede the setTimeout setup.
      const stopIdx = block.indexOf('.stop()')
      const timerIdx = block.indexOf('setTimeout')
      expect(stopIdx).toBeGreaterThanOrEqual(0)
      expect(timerIdx).toBeGreaterThan(stopIdx)
    }
  })

  it('AC2: deferred-exit preserves conventional exit codes (SIGINT=130, SIGTERM=143)', () => {
    const sigintBlocks = runSource.match(/process\.on\('SIGINT'[\s\S]{0,350}?\}\)/g) ?? []
    const sigtermBlocks = runSource.match(/process\.on\('SIGTERM'[\s\S]{0,350}?\}\)/g) ?? []
    const ingestionSigints = sigintBlocks.filter((b) => /\.stop\(\)/.test(b))
    const ingestionSigterms = sigtermBlocks.filter((b) => /\.stop\(\)/.test(b))

    expect(ingestionSigints.length).toBeGreaterThanOrEqual(2)
    expect(ingestionSigterms.length).toBeGreaterThanOrEqual(2)

    for (const block of ingestionSigints) {
      expect(block).toMatch(/process\.exit\(130\)/)
    }
    for (const block of ingestionSigterms) {
      expect(block).toMatch(/process\.exit\(143\)/)
    }
  })

  it('AC3: ingestion-server handlers do NOT call process.exit synchronously (the regression they defend against)', () => {
    // Guard against reintroducing the preemption bug. A synchronous pattern
    // would look like: `{ xyz.stop(); process.exit(143) }` or
    // `=> { xyz.stop(); process.exit(143) }` with no setTimeout wrapper.
    // Match the unwrapped pattern across signal handler bodies.
    const handlerBlocks = runSource.match(/process\.on\('SIG(?:TERM|INT)'[\s\S]{0,350}?\}\)/g) ?? []
    const ingestionBlocks = handlerBlocks.filter((b) => /\.stop\(\)/.test(b))

    for (const block of ingestionBlocks) {
      // The anti-pattern: `.stop(); process.exit(N)` — semicolon, followed by
      // synchronous process.exit. The deferred pattern separates them with
      // setTimeout on a subsequent statement.
      expect(block).not.toMatch(/\.stop\(\)\s*;\s*process\.exit\(\d+\)/)
    }
  })
})
