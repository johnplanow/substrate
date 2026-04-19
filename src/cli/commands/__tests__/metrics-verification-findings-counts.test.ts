/**
 * Tests for Story 55-3b: metrics JSON surfaces per-story verification finding counts.
 *
 * Mirrors the status-side coverage. Seeds real DB decisions + a real
 * RunManifest on tmpdir, then invokes the default
 * `substrate metrics --output-format json` path and asserts the
 * `story_metrics` array carries a `verification_findings` object on
 * every entry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun, createDecision } from '../../../persistence/queries/decisions.js'
import { STORY_METRICS } from '../../../persistence/schemas/operational.js'
import { runMetricsAction } from '../metrics.js'
import { RunManifest } from '@substrate-ai/sdlc'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { StoredVerificationSummary } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mockResolveMainRepoRoot = vi.fn()
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: (...args: unknown[]) => mockResolveMainRepoRoot(...args),
}))

const mockExistsSync = vi.fn()
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>()
  return {
    ...original,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  }
})

let _injectedAdapter: DatabaseAdapter | null = null
vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: () => _injectedAdapter!,
}))
vi.mock('../../../persistence/schema.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../persistence/schema.js')>()
  return {
    ...original,
    initSchema: vi.fn().mockImplementation(async (adapter: DatabaseAdapter) => original.initSchema(adapter)),
  }
})
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `metrics-55-3b-${randomUUID()}`)
}

async function seedRunWithDecisions(
  adapter: InMemoryDatabaseAdapter,
  storyKeys: string[],
): Promise<{ runId: string }> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad' })
  for (const storyKey of storyKeys) {
    await createDecision(adapter, {
      pipeline_run_id: run.id,
      phase: 'implementation',
      category: STORY_METRICS,
      key: `${storyKey}:${run.id}`,
      value: JSON.stringify({
        wall_clock_seconds: 60,
        input_tokens: 1000,
        output_tokens: 500,
        review_cycles: 1,
        stalled: false,
      }),
    })
  }
  return { runId: run.id }
}

function summaryWithCounts(
  storyKey: string,
  counts: { error?: number; warn?: number; info?: number },
): StoredVerificationSummary {
  const findings: StoredVerificationSummary['checks'][number]['findings'] = []
  for (let i = 0; i < (counts.error ?? 0); i += 1) {
    findings.push({ category: 'err', severity: 'error', message: `e${i}` })
  }
  for (let i = 0; i < (counts.warn ?? 0); i += 1) {
    findings.push({ category: 'warn', severity: 'warn', message: `w${i}` })
  }
  for (let i = 0; i < (counts.info ?? 0); i += 1) {
    findings.push({ category: 'info', severity: 'info', message: `i${i}` })
  }
  const status: 'pass' | 'warn' | 'fail' =
    (counts.error ?? 0) > 0 ? 'fail' : (counts.warn ?? 0) > 0 ? 'warn' : 'pass'
  return {
    storyKey,
    status,
    duration_ms: 10,
    checks: [{ checkName: 'synth', status, details: '', duration_ms: 10, findings }],
  }
}

async function writeManifestFixture(
  projectRoot: string,
  runId: string,
  perStory: Record<string, StoredVerificationSummary>,
): Promise<void> {
  await fs.mkdir(join(projectRoot, '.substrate'), { recursive: true })
  await fs.writeFile(join(projectRoot, '.substrate', 'current-run-id'), runId)
  const manifest = new RunManifest(runId, join(projectRoot, '.substrate', 'runs'))
  for (const [storyKey, summary] of Object.entries(perStory)) {
    await manifest.patchStoryState(storyKey, {
      status: 'complete',
      phase: 'verification',
      started_at: '2026-04-19T00:00:00.000Z',
      verification_result: summary,
    })
  }
}

interface MetricsJson {
  success: boolean
  data: {
    story_metrics: Array<{
      story_key: string
      run_id: string
      verification_findings?: { error: number; warn: number; info: number }
    }>
  }
}

function extractMetricsJson(stdoutChunks: string[]): MetricsJson['data'] {
  const full = stdoutChunks.join('')
  const parsed = JSON.parse(full) as MetricsJson
  expect(parsed.success).toBe(true)
  return parsed.data
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Story 55-3b: metrics JSON includes verification_findings per story', () => {
  let adapter: InMemoryDatabaseAdapter
  let stdoutChunks: string[]
  let projectRoot: string

  beforeEach(async () => {
    adapter = new InMemoryDatabaseAdapter()
    await initSchema(adapter)
    _injectedAdapter = adapter

    stdoutChunks = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(chunk.toString())
      return true
    })

    projectRoot = makeTempDir()
    await fs.mkdir(projectRoot, { recursive: true })
    mockExistsSync.mockReturnValue(true)
    mockResolveMainRepoRoot.mockResolvedValue(projectRoot)
  })

  afterEach(async () => {
    await adapter.close()
    await fs.rm(projectRoot, { recursive: true, force: true })
  })

  it('AC2: each story_metrics entry includes a verification_findings object', async () => {
    const { runId } = await seedRunWithDecisions(adapter, ['m-a', 'm-b'])
    await writeManifestFixture(projectRoot, runId, {
      'm-a': summaryWithCounts('m-a', { error: 2, info: 1 }),
      'm-b': summaryWithCounts('m-b', { warn: 3 }),
    })

    const exit = await runMetricsAction({ outputFormat: 'json', projectRoot })
    expect(exit).toBe(0)
    const json = extractMetricsJson(stdoutChunks)
    const byKey = new Map(json.story_metrics.map((sm) => [sm.story_key, sm.verification_findings]))
    expect(byKey.get('m-a')).toEqual({ error: 2, warn: 0, info: 1 })
    expect(byKey.get('m-b')).toEqual({ error: 0, warn: 3, info: 0 })
  })

  it('AC3: story whose manifest record has no findings yields all-zero counts', async () => {
    const { runId } = await seedRunWithDecisions(adapter, ['m-legacy'])
    const legacy: StoredVerificationSummary = {
      storyKey: 'm-legacy',
      status: 'pass',
      duration_ms: 1,
      checks: [{ checkName: 'build', status: 'pass', details: 'ok', duration_ms: 1 }],
    }
    await writeManifestFixture(projectRoot, runId, { 'm-legacy': legacy })

    await runMetricsAction({ outputFormat: 'json', projectRoot })
    const json = extractMetricsJson(stdoutChunks)
    const sm = json.story_metrics.find((x) => x.story_key === 'm-legacy')
    expect(sm?.verification_findings).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('absent manifest (no .substrate/runs/<id>.json) yields zero counts on every story', async () => {
    await seedRunWithDecisions(adapter, ['m-a', 'm-b'])
    // Intentionally skip writing manifest fixture.

    await runMetricsAction({ outputFormat: 'json', projectRoot })
    const json = extractMetricsJson(stdoutChunks)
    expect(json.story_metrics.length).toBeGreaterThan(0)
    for (const sm of json.story_metrics) {
      expect(sm.verification_findings).toEqual({ error: 0, warn: 0, info: 0 })
    }
  })
})
