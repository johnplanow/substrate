import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { getProjectFindings } from '../project-findings.js'
import { createDecision } from '../../../persistence/queries/decisions.js'
import { STORY_OUTCOME, ESCALATION_DIAGNOSIS, STORY_METRICS, OPERATIONAL_FINDING } from '../../../persistence/schemas/operational.js'

describe('getProjectFindings', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
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

  afterEach(() => {
    db.close()
  })

  it('returns empty string when no findings exist (AC5)', () => {
    const result = getProjectFindings(db)
    expect(result).toBe('')
  })

  it('includes recurring patterns from story outcomes', () => {
    createDecision(db, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: STORY_OUTCOME,
      key: '1-1:run-1',
      value: JSON.stringify({ storyKey: '1-1', outcome: 'complete', reviewCycles: 2, recurringPatterns: ['missing error handling'] }),
    })
    createDecision(db, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: STORY_OUTCOME,
      key: '1-2:run-1',
      value: JSON.stringify({ storyKey: '1-2', outcome: 'complete', reviewCycles: 3, recurringPatterns: ['missing error handling'] }),
    })

    const result = getProjectFindings(db)
    expect(result).toContain('missing error handling')
    expect(result).toContain('2 occurrences')
  })

  it('includes escalation diagnoses', () => {
    createDecision(db, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: ESCALATION_DIAGNOSIS,
      key: '1-3:run-1',
      value: JSON.stringify({ recommendedAction: 'split-story', rationale: 'Too many issues' }),
    })

    const result = getProjectFindings(db)
    expect(result).toContain('split-story')
    expect(result).toContain('Too many issues')
  })

  it('includes high review-cycle stories', () => {
    createDecision(db, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: STORY_METRICS,
      key: '1-1:run-1',
      value: JSON.stringify({ review_cycles: 3, wall_clock_seconds: 180 }),
    })

    const result = getProjectFindings(db)
    expect(result).toContain('1-1')
    expect(result).toContain('3 cycles')
  })

  it('includes stall count from operational findings', () => {
    createDecision(db, {
      pipeline_run_id: 'run-1',
      phase: 'implementation',
      category: OPERATIONAL_FINDING,
      key: 'stall:1-1:12345',
      value: JSON.stringify({ phase: 'code-review', staleness_secs: 700 }),
    })

    const result = getProjectFindings(db)
    expect(result).toContain('stall')
  })

  it('truncates to 2000 chars', () => {
    // Create many findings to exceed the limit
    for (let i = 0; i < 50; i++) {
      createDecision(db, {
        pipeline_run_id: 'run-1',
        phase: 'implementation',
        category: STORY_METRICS,
        key: `story-${i}:run-1`,
        value: JSON.stringify({ review_cycles: 3, wall_clock_seconds: 180 }),
      })
    }

    const result = getProjectFindings(db)
    expect(result.length).toBeLessThanOrEqual(2000)
  })
})
