/**
 * Tests for Story 55-3b: status JSON surfaces per-story verification finding counts.
 *
 * Covers:
 *   - Every story_metrics entry carries a verification_findings
 *     `{error, warn, info}` triple (AC1)
 *   - Stories with multiple severities report the correct per-severity counts
 *   - Stories whose manifest record has no findings yield `{0, 0, 0}` (AC3)
 *   - Absent-manifest path (no .substrate/runs/<id>.json) yields zero counts
 *     on every story — no throw (backward compat)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import { createPipelineRun } from '../../../persistence/queries/decisions.js'
import { writeStoryMetrics } from '../../../persistence/queries/metrics.js'
import { runStatusAction } from '../status.js'
import { RunManifest } from '@substrate-ai/sdlc'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { StoredVerificationSummary } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Harness boilerplate — mirrors status-metrics-v2.test.ts
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
  return join(tmpdir(), `status-55-3b-${randomUUID()}`)
}

/** Set up an in-memory adapter with a pipeline run and per-story metrics
 * rows for the given story keys. Returns the run id for manifest fixture
 * writes. Mirrors the fixture shape used by status-metrics-v2.test.ts so
 * the status action reaches its primary JSON-output branch. */
async function seedRun(
  adapter: InMemoryDatabaseAdapter,
  storyKeys: string[],
): Promise<{ runId: string }> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad' })
  for (const storyKey of storyKeys) {
    await writeStoryMetrics(adapter, {
      run_id: run.id,
      story_key: storyKey,
      result: 'success',
      phase_durations_json: JSON.stringify({ dev: 60, review: 30 }),
      wall_clock_seconds: 90,
      input_tokens: 5000,
      output_tokens: 2000,
      cost_usd: 0.01,
      review_cycles: 1,
      dispatches: 2,
    })
  }
  // Mark the run completed with realistic timestamps so status treats it
  // as a valid current run (same pattern as the status-metrics-v2 tests).
  adapter.querySync(
    `UPDATE pipeline_runs SET status='completed', created_at=?, updated_at=? WHERE id=?`,
    [new Date(Date.now() - 3600000).toISOString(), new Date().toISOString(), run.id],
  )
  return { runId: run.id }
}

/** Build a StoredVerificationSummary with the given per-severity finding
 * counts distributed across a couple of synthetic checks. */
function summaryWithCounts(
  storyKey: string,
  counts: { error?: number; warn?: number; info?: number },
): StoredVerificationSummary {
  const findings: StoredVerificationSummary['checks'][number]['findings'] = []
  for (let i = 0; i < (counts.error ?? 0); i += 1) {
    findings.push({ category: 'synthetic-err', severity: 'error', message: `err ${i}` })
  }
  for (let i = 0; i < (counts.warn ?? 0); i += 1) {
    findings.push({ category: 'synthetic-warn', severity: 'warn', message: `warn ${i}` })
  }
  for (let i = 0; i < (counts.info ?? 0); i += 1) {
    findings.push({ category: 'synthetic-info', severity: 'info', message: `info ${i}` })
  }
  const status: 'pass' | 'warn' | 'fail' =
    (counts.error ?? 0) > 0 ? 'fail' : (counts.warn ?? 0) > 0 ? 'warn' : 'pass'
  return {
    storyKey,
    status,
    duration_ms: 100,
    checks: [
      {
        checkName: 'synthetic-check',
        status,
        details: '',
        duration_ms: 100,
        findings,
      },
    ],
  }
}

/** Write `.substrate/current-run-id` and `.substrate/runs/<id>.json`
 * containing the supplied per-story verification results. */
async function writeManifestFixture(
  projectRoot: string,
  runId: string,
  perStoryVerifications: Record<string, StoredVerificationSummary | undefined>,
): Promise<void> {
  await fs.mkdir(join(projectRoot, '.substrate'), { recursive: true })
  await fs.writeFile(join(projectRoot, '.substrate', 'current-run-id'), runId)

  const runsDir = join(projectRoot, '.substrate', 'runs')
  const manifest = new RunManifest(runId, runsDir)
  for (const [storyKey, summary] of Object.entries(perStoryVerifications)) {
    await manifest.patchStoryState(storyKey, {
      status: 'complete',
      phase: 'verification',
      started_at: '2026-04-19T00:00:00.000Z',
      ...(summary !== undefined ? { verification_result: summary } : {}),
    })
  }
}

interface StatusJson {
  success: boolean
  data: {
    story_metrics: Array<{
      story_key: string
      verification_findings?: { error: number; warn: number; info: number }
      verification_ran?: boolean
    }>
  }
}

function extractStatusData(stdoutChunks: string[]): StatusJson['data'] {
  const full = stdoutChunks.join('')
  const parsed = JSON.parse(full) as StatusJson
  expect(parsed.success).toBe(true)
  return parsed.data
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Story 55-3b: status JSON includes verification_findings per story', () => {
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

  it('AC1: every story_metrics entry carries a verification_findings object', async () => {
    const { runId } = await seedRun(adapter, ['55-a', '55-b'])
    await writeManifestFixture(projectRoot, runId, {
      '55-a': summaryWithCounts('55-a', { error: 1 }),
      '55-b': summaryWithCounts('55-b', {}),
    })

    const exit = await runStatusAction({
      outputFormat: 'json',
      runId,
      projectRoot,
    })
    expect(exit).toBe(0)

    const json = extractStatusData(stdoutChunks)
    expect(json.story_metrics.length).toBeGreaterThan(0)
    for (const sm of json.story_metrics) {
      expect(sm.verification_findings).toBeDefined()
      expect(sm.verification_findings).toEqual(
        expect.objectContaining({ error: expect.any(Number), warn: expect.any(Number), info: expect.any(Number) }),
      )
    }
  })

  it('reports the correct per-severity counts for each story', async () => {
    const { runId } = await seedRun(adapter, ['55-a', '55-b', '55-c'])
    await writeManifestFixture(projectRoot, runId, {
      '55-a': summaryWithCounts('55-a', { error: 2, warn: 1 }),
      '55-b': summaryWithCounts('55-b', { info: 3 }),
      '55-c': summaryWithCounts('55-c', {}),
    })

    await runStatusAction({ outputFormat: 'json', runId, projectRoot })
    const json = extractStatusData(stdoutChunks)
    const byKey = new Map(json.story_metrics.map((sm) => [sm.story_key, sm.verification_findings]))
    expect(byKey.get('55-a')).toEqual({ error: 2, warn: 1, info: 0 })
    expect(byKey.get('55-b')).toEqual({ error: 0, warn: 0, info: 3 })
    expect(byKey.get('55-c')).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('AC3: a story whose manifest record has verification_result but no findings yields zeros', async () => {
    const { runId } = await seedRun(adapter, ['55-legacy'])
    // Verification result with an empty check — no findings field at all
    const legacy: StoredVerificationSummary = {
      storyKey: '55-legacy',
      status: 'pass',
      duration_ms: 5,
      checks: [{ checkName: 'build', status: 'pass', details: 'ok', duration_ms: 5 }],
    }
    await writeManifestFixture(projectRoot, runId, { '55-legacy': legacy })

    await runStatusAction({ outputFormat: 'json', runId, projectRoot })
    const json = extractStatusData(stdoutChunks)
    const sm = json.story_metrics.find((x) => x.story_key === '55-legacy')
    expect(sm?.verification_findings).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('absent manifest (no .substrate/runs/<id>.json) yields zero counts on every story', async () => {
    const { runId } = await seedRun(adapter, ['55-a', '55-b'])
    // Intentionally DO NOT write a manifest fixture. Also skip writing
    // `current-run-id`, and pass `runId` directly so the command still
    // knows which run to show.
    const exit = await runStatusAction({ outputFormat: 'json', runId, projectRoot })
    expect(exit).toBe(0)

    const json = extractStatusData(stdoutChunks)
    for (const sm of json.story_metrics) {
      expect(sm.verification_findings).toEqual({ error: 0, warn: 0, info: 0 })
    }
  })

  // ---------------------------------------------------------------------------
  // Story 57-3: verification_ran signal
  // ---------------------------------------------------------------------------

  it('57-3 AC1: story with verification_result present reports verification_ran: true', async () => {
    const { runId } = await seedRun(adapter, ['57-a'])
    await writeManifestFixture(projectRoot, runId, {
      '57-a': summaryWithCounts('57-a', { warn: 1 }),
    })

    await runStatusAction({ outputFormat: 'json', runId, projectRoot })
    const json = extractStatusData(stdoutChunks)
    const sm = json.story_metrics.find((x) => x.story_key === '57-a')
    expect(sm?.verification_ran).toBe(true)
    // Existing verification_findings must still be present (no regression)
    expect(sm?.verification_findings).toEqual({ error: 0, warn: 1, info: 0 })
  })

  it('57-3 AC1: story with verification_result absent/undefined reports verification_ran: false', async () => {
    const { runId } = await seedRun(adapter, ['57-b'])
    // Write a manifest fixture but do NOT include a verification_result for '57-b'
    await writeManifestFixture(projectRoot, runId, {
      '57-b': undefined,
    })

    await runStatusAction({ outputFormat: 'json', runId, projectRoot })
    const json = extractStatusData(stdoutChunks)
    const sm = json.story_metrics.find((x) => x.story_key === '57-b')
    expect(sm?.verification_ran).toBe(false)
    expect(sm?.verification_findings).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('57-3 AC4: absent manifest path yields verification_ran: false on every story', async () => {
    const { runId } = await seedRun(adapter, ['57-c', '57-d'])
    // Intentionally DO NOT write any manifest fixture.

    await runStatusAction({ outputFormat: 'json', runId, projectRoot })
    const json = extractStatusData(stdoutChunks)
    expect(json.story_metrics.length).toBeGreaterThan(0)
    for (const sm of json.story_metrics) {
      expect(sm?.verification_ran).toBe(false)
      expect(sm?.verification_findings).toEqual({ error: 0, warn: 0, info: 0 })
    }
  })
})
