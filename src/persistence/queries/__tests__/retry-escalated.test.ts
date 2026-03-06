/**
 * Unit tests for src/persistence/queries/retry-escalated.ts
 *
 * Covers:
 *   AC1: Retryable story discovery — default to latest run
 *   AC2: Non-retryable stories are excluded with correct reasons
 *   AC5: Run-ID scoping
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../migrations/index.js'
import { createDecision } from '../decisions.js'
import { getRetryableEscalations } from '../retry-escalated.js'
import type { EscalationDiagnosis } from '../../../modules/implementation-orchestrator/escalation-diagnosis.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function makeDiagnosis(recommendedAction: EscalationDiagnosis['recommendedAction']): string {
  const diagnosis: EscalationDiagnosis = {
    issueDistribution: 'concentrated',
    severityProfile: 'major-only',
    totalIssues: 2,
    blockerCount: 0,
    majorCount: 2,
    minorCount: 0,
    affectedFiles: ['src/foo.ts'],
    reviewCycles: 3,
    recommendedAction,
    rationale: 'Test rationale.',
  }
  return JSON.stringify(diagnosis)
}

function insertDecision(
  db: BetterSqlite3Database,
  storyKey: string,
  runId: string,
  recommendedAction: EscalationDiagnosis['recommendedAction'],
): void {
  createDecision(db, {
    phase: 'implementation',
    category: 'escalation-diagnosis',
    key: `${storyKey}:${runId}`,
    value: makeDiagnosis(recommendedAction),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getRetryableEscalations', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  afterEach(() => {
    db.close()
  })

  it('returns empty result when no escalation-diagnosis decisions exist', () => {
    const result = getRetryableEscalations(db)
    expect(result.retryable).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('AC1: returns retry-targeted stories as retryable', () => {
    insertDecision(db, '22-1', 'run-abc', 'retry-targeted')

    const result = getRetryableEscalations(db)
    expect(result.retryable).toContain('22-1')
    expect(result.skipped).toHaveLength(0)
  })

  it('AC2: excludes human-intervention stories with correct reason', () => {
    insertDecision(db, '22-2', 'run-abc', 'human-intervention')

    const result = getRetryableEscalations(db)
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toContainEqual({ key: '22-2', reason: 'needs human review' })
  })

  it('AC2: excludes split-story stories with correct reason', () => {
    insertDecision(db, '22-3', 'run-abc', 'split-story')

    const result = getRetryableEscalations(db)
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toContainEqual({ key: '22-3', reason: 'story should be split' })
  })

  it('AC1/AC2: correctly classifies mixed results', () => {
    const runId = 'run-mixed'
    insertDecision(db, '22-1', runId, 'retry-targeted')
    insertDecision(db, '22-2', runId, 'human-intervention')
    insertDecision(db, '22-3', runId, 'split-story')
    insertDecision(db, '22-4', runId, 'retry-targeted')

    const result = getRetryableEscalations(db)
    expect(result.retryable).toEqual(expect.arrayContaining(['22-1', '22-4']))
    expect(result.retryable).toHaveLength(2)
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped).toContainEqual({ key: '22-2', reason: 'needs human review' })
    expect(result.skipped).toContainEqual({ key: '22-3', reason: 'story should be split' })
  })

  it('AC1: defaults to latest run when no runId provided', () => {
    // Insert decisions for two runs — only latest run's decisions should be returned
    insertDecision(db, '22-1', 'run-old', 'retry-targeted')
    insertDecision(db, '22-2', 'run-new', 'retry-targeted')

    // Latest run is 'run-new' (last inserted = last in created_at ASC order)
    const result = getRetryableEscalations(db)
    expect(result.retryable).toContain('22-2')
    expect(result.retryable).not.toContain('22-1')
  })

  it('AC5: scopes to specified run-id when provided', () => {
    insertDecision(db, '22-1', 'run-old', 'retry-targeted')
    insertDecision(db, '22-2', 'run-new', 'retry-targeted')

    // Scope to old run
    const result = getRetryableEscalations(db, 'run-old')
    expect(result.retryable).toContain('22-1')
    expect(result.retryable).not.toContain('22-2')
  })

  it('AC5: returns empty when specified runId has no matching decisions', () => {
    insertDecision(db, '22-1', 'run-abc', 'retry-targeted')

    const result = getRetryableEscalations(db, 'run-nonexistent')
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it('skips decisions with malformed keys (no colon)', () => {
    createDecision(db, {
      phase: 'implementation',
      category: 'escalation-diagnosis',
      key: 'malformed-no-colon',
      value: makeDiagnosis('retry-targeted'),
    })

    const result = getRetryableEscalations(db)
    expect(result.retryable).toHaveLength(0)
  })

  it('skips decisions with malformed JSON values', () => {
    createDecision(db, {
      phase: 'implementation',
      category: 'escalation-diagnosis',
      key: '22-1:run-abc',
      value: 'not-valid-json',
    })

    const result = getRetryableEscalations(db)
    expect(result.retryable).toHaveLength(0)
  })

  it('deduplicates: last decision per storyKey wins (created_at ASC order)', () => {
    const runId = 'run-dedup'
    // First insert: retry-targeted
    insertDecision(db, '22-1', runId, 'retry-targeted')
    // Second insert for same key: human-intervention (overwrites)
    insertDecision(db, '22-1', runId, 'human-intervention')

    // Since created_at ASC, the last one (human-intervention) wins
    const result = getRetryableEscalations(db, runId)
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toContainEqual({ key: '22-1', reason: 'needs human review' })
  })
})
