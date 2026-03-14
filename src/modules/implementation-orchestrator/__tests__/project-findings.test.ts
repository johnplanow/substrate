import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { getProjectFindings } from '../project-findings.js'
import { createDecision } from '../../../persistence/queries/decisions.js'
import { STORY_OUTCOME, ESCALATION_DIAGNOSIS, STORY_METRICS, OPERATIONAL_FINDING, ADVISORY_NOTES } from '../../../persistence/schemas/operational.js'

describe('getProjectFindings', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
    adapter.execSync(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        pipeline_run_id TEXT,
        phase TEXT NOT NULL,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        rationale TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns empty string when no findings exist (AC5)', async () => {
    const result = await getProjectFindings(adapter)
    expect(result).toBe('')
  })

  it('includes recurring patterns from story outcomes', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: STORY_OUTCOME,
      key: '1-1:run-1',
      value: JSON.stringify({ storyKey: '1-1', outcome: 'complete', reviewCycles: 2, recurringPatterns: ['missing error handling'] }),
    })
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: STORY_OUTCOME,
      key: '1-2:run-1',
      value: JSON.stringify({ storyKey: '1-2', outcome: 'complete', reviewCycles: 3, recurringPatterns: ['missing error handling'] }),
    })

    const result = await getProjectFindings(adapter)
    expect(result).toContain('missing error handling')
    expect(result).toContain('2 occurrences')
  })

  it('includes escalation diagnoses', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: ESCALATION_DIAGNOSIS,
      key: '1-3:run-1',
      value: JSON.stringify({ recommendedAction: 'split-story', rationale: 'Too many issues' }),
    })

    const result = await getProjectFindings(adapter)
    expect(result).toContain('split-story')
    expect(result).toContain('Too many issues')
  })

  it('includes high review-cycle stories', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: STORY_METRICS,
      key: '1-1:run-1',
      value: JSON.stringify({ review_cycles: 3, wall_clock_seconds: 180 }),
    })

    const result = await getProjectFindings(adapter)
    expect(result).toContain('1-1')
    expect(result).toContain('3 cycles')
  })

  it('includes stall count from operational findings', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: OPERATIONAL_FINDING,
      key: 'stall:1-1:12345',
      value: JSON.stringify({ phase: 'code-review', staleness_secs: 700 }),
    })

    const result = await getProjectFindings(adapter)
    expect(result).toContain('stall')
  })

  it('truncates to 2000 chars', async () => {
    // Create many findings to exceed the limit
    for (let i = 0; i < 50; i++) {
      await createDecision(adapter, {
        pipeline_run_id: 'run-1',
        phase: 'implementation',
        category: STORY_METRICS,
        key: `story-${i}:run-1`,
        value: JSON.stringify({ review_cycles: 3, wall_clock_seconds: 180 }),
      })
    }

    const result = await getProjectFindings(adapter)
    expect(result.length).toBeLessThanOrEqual(2000)
  })

  // ---------------------------------------------------------------------------
  // Advisory notes (AC4)
  // ---------------------------------------------------------------------------

  it('includes advisory notes from LGTM_WITH_NOTES reviews in prior findings (AC4)', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: ADVISORY_NOTES,
      key: '25-3:run-1',
      value: JSON.stringify({ storyKey: '25-3', notes: 'Consider extracting helper to shared module.' }),
    })

    const result = await getProjectFindings(adapter)
    expect(result).toContain('Advisory notes from prior reviews')
    expect(result).toContain('25-3')
    expect(result).toContain('Consider extracting helper to shared module.')
  })

  it('includes multiple advisory notes (limited to last 3) (AC4)', async () => {
    for (let i = 1; i <= 5; i++) {
      await createDecision(adapter, {
        pipeline_run_id: 'run-1',
        phase: 'implementation',
        category: ADVISORY_NOTES,
        key: `25-${i}:run-1`,
        value: JSON.stringify({ storyKey: `25-${i}`, notes: `Advisory note for story 25-${i}` }),
      })
    }

    const result = await getProjectFindings(adapter)
    expect(result).toContain('Advisory notes from prior reviews')
    // Should include the last 3 (25-3, 25-4, 25-5) not the first 2
    expect(result).toContain('25-3')
    expect(result).toContain('25-4')
    expect(result).toContain('25-5')
  })

  it('returns empty string when only advisory notes exist (graceful fallback)', async () => {
    // No data at all — should still return empty
    const result = await getProjectFindings(adapter)
    expect(result).toBe('')
  })

  it('handles malformed advisory notes JSON gracefully (AC4)', async () => {
    await createDecision(adapter, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: ADVISORY_NOTES,
      key: '25-bad:run-1',
      value: 'not-valid-json',
    })

    // Should not throw, returns a fallback string
    const result = await getProjectFindings(adapter)
    expect(result).toContain('advisory notes available')
  })
})
