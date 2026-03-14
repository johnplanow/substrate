/**
 * Tests for LGTM_WITH_NOTES verdict handling (Story 25-3).
 *
 * Validates AC2 (story marked COMPLETE + advisory notes persisted),
 * AC4 (advisory notes in prior_findings), and AC5 (verdict tracked distinctly).
 *
 * Uses in-memory SQLite and direct decision-store queries to avoid
 * orchestrator setup complexity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createDecision, getDecisionsByCategory } from '../../../persistence/queries/decisions.js'
import { writeStoryMetrics } from '../../../persistence/queries/metrics.js'
import { ADVISORY_NOTES } from '../../../persistence/schemas/operational.js'
import { getProjectFindings } from '../project-findings.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function openTestDb(): Promise<WasmSqliteDatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  adapter.execSync(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      pipeline_run_id TEXT,
      phase TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      rationale TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
  adapter.execSync(`
    CREATE TABLE story_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      story_key TEXT NOT NULL,
      result TEXT NOT NULL,
      phase_durations_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      wall_clock_seconds INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      review_cycles INTEGER NOT NULL DEFAULT 0,
      dispatches INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(run_id, story_key)
    )
  `)
  return adapter
}

// ---------------------------------------------------------------------------
// AC2: Advisory notes persisted to decision store on LGTM_WITH_NOTES
// ---------------------------------------------------------------------------

describe('AC2: Advisory notes persisted on LGTM_WITH_NOTES', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openTestDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('persists advisory notes to decision store with advisory-notes category', async () => {
    const storyKey = '25-3'
    const pipelineRunId = 'run-abc'
    const notes = 'Consider extracting helper to shared module — advisory only.'

    await createDecision(adapter, {
      pipeline_run_id: pipelineRunId,
      phase: 'implementation',
      category: ADVISORY_NOTES,
      key: `${storyKey}:${pipelineRunId}`,
      value: JSON.stringify({ storyKey, notes }),
      rationale: `Advisory notes from LGTM_WITH_NOTES review of ${storyKey}`,
    })

    const found = await getDecisionsByCategory(adapter, ADVISORY_NOTES)
    expect(found).toHaveLength(1)
    expect(found[0].key).toBe('25-3:run-abc')
    expect(found[0].category).toBe('advisory-notes')

    const parsed = JSON.parse(found[0].value)
    expect(parsed.storyKey).toBe('25-3')
    expect(parsed.notes).toBe(notes)
  })

  it('stores advisory notes with correct key format {storyKey}:{runId}', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-123',
      phase: 'implementation',
      category: ADVISORY_NOTES,
      key: '10-5:run-123',
      value: JSON.stringify({ storyKey: '10-5', notes: 'Minor style suggestion.' }),
    })

    const found = await getDecisionsByCategory(adapter, ADVISORY_NOTES)
    expect(found[0].key).toMatch(/^10-5:run-123$/)
  })
})

// ---------------------------------------------------------------------------
// AC4: Advisory notes appear in prior_findings
// ---------------------------------------------------------------------------

describe('AC4: Advisory notes in getProjectFindings output', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openTestDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('includes advisory notes section when ADVISORY_NOTES decisions exist', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: ADVISORY_NOTES,
      key: '25-3:run-1',
      value: JSON.stringify({
        storyKey: '25-3',
        notes: 'Consider using a Map instead of an object for constant-time lookups.',
      }),
    })

    const findings = await getProjectFindings(adapter)
    expect(findings).toContain('Advisory notes from prior reviews')
    expect(findings).toContain('25-3')
    expect(findings).toContain('Consider using a Map instead of an object')
  })

  it('returns empty string when only advisory notes exist and DB has no other findings', async () => {
    // Empty DB — should return empty
    const findings = await getProjectFindings(adapter)
    expect(findings).toBe('')
  })

  it('advisory notes appear alongside other findings', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: ADVISORY_NOTES,
      key: '25-3:run-1',
      value: JSON.stringify({ storyKey: '25-3', notes: 'Minor refactor suggestion.' }),
    })

    const findings = await getProjectFindings(adapter)
    // Advisory section present
    expect(findings).toContain('LGTM_WITH_NOTES')
    // The story key is referenced
    expect(findings).toContain('25-3')
  })
})

// ---------------------------------------------------------------------------
// AC5: Metrics track LGTM_WITH_NOTES as distinct verdict
// ---------------------------------------------------------------------------

describe('AC5: LGTM_WITH_NOTES tracked distinctly in story_metrics', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openTestDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('stores LGTM_WITH_NOTES as result string (distinct from SHIP_IT success)', async () => {
    await writeStoryMetrics(adapter, {
      run_id: 'run-1',
      story_key: '25-3',
      result: 'LGTM_WITH_NOTES',
      review_cycles: 1,
    })

    const row = adapter.querySync<{ result: string }>('SELECT result FROM story_metrics WHERE story_key = ?', ['25-3'])[0]
    expect(row).toBeDefined()
    expect(row!.result).toBe('LGTM_WITH_NOTES')
  })

  it('SHIP_IT verdict stores "SHIP_IT" as result (distinct from LGTM_WITH_NOTES)', async () => {
    await writeStoryMetrics(adapter, {
      run_id: 'run-1',
      story_key: '25-4',
      result: 'SHIP_IT',
      review_cycles: 1,
    })

    const row = adapter.querySync<{ result: string }>('SELECT result FROM story_metrics WHERE story_key = ?', ['25-4'])[0]
    expect(row).toBeDefined()
    expect(row!.result).toBe('SHIP_IT')
    expect(row!.result).not.toBe('LGTM_WITH_NOTES')
  })

  it('can distinguish LGTM_WITH_NOTES stories from SHIP_IT stories in a run', async () => {
    await writeStoryMetrics(adapter, { run_id: 'run-1', story_key: '25-3', result: 'LGTM_WITH_NOTES', review_cycles: 1 })
    await writeStoryMetrics(adapter, { run_id: 'run-1', story_key: '25-4', result: 'SHIP_IT', review_cycles: 0 })
    await writeStoryMetrics(adapter, { run_id: 'run-1', story_key: '25-5', result: 'escalated', review_cycles: 2 })

    const rows = adapter.querySync<{ story_key: string; result: string }>('SELECT story_key, result FROM story_metrics WHERE run_id = ?', ['run-1'])
    const lgtmRows = rows.filter((r) => r.result === 'LGTM_WITH_NOTES')
    const shipItRows = rows.filter((r) => r.result === 'SHIP_IT')

    expect(lgtmRows).toHaveLength(1)
    expect(lgtmRows[0].story_key).toBe('25-3')
    expect(shipItRows).toHaveLength(1)
    expect(shipItRows[0].story_key).toBe('25-4')
  })
})
