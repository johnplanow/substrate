/**
 * Unit tests for src/persistence/queries/retry-escalated.ts
 *
 * Covers:
 *   AC1: Retryable story discovery — default to latest run
 *   AC2: Non-retryable stories are excluded with correct reasons
 *   AC5: Run-ID scoping
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../memory-adapter.js'
import { initSchema } from '../../schema.js'
import { createDecision } from '../decisions.js'
import { getRetryableEscalations } from '../retry-escalated.js'
import type { EscalationDiagnosis } from '../../../modules/implementation-orchestrator/escalation-diagnosis.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openDb() {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
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

async function insertDecision(
  adapter: InMemoryDatabaseAdapter,
  storyKey: string,
  runId: string,
  recommendedAction: EscalationDiagnosis['recommendedAction'],
): Promise<void> {
  await createDecision(adapter, {
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
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns empty result when no escalation-diagnosis decisions exist', async () => {
    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('AC1: returns retry-targeted stories as retryable', async () => {
    await insertDecision(adapter, '22-1', 'run-abc', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toContain('22-1')
    expect(result.skipped).toHaveLength(0)
  })

  it('AC2: excludes human-intervention stories with correct reason', async () => {
    await insertDecision(adapter, '22-2', 'run-abc', 'human-intervention')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toContainEqual({ key: '22-2', reason: 'needs human review' })
  })

  it('AC2: excludes split-story stories with correct reason', async () => {
    await insertDecision(adapter, '22-3', 'run-abc', 'split-story')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toContainEqual({ key: '22-3', reason: 'story should be split' })
  })

  it('AC1/AC2: correctly classifies mixed results', async () => {
    const runId = 'run-mixed'
    await insertDecision(adapter, '22-1', runId, 'retry-targeted')
    await insertDecision(adapter, '22-2', runId, 'human-intervention')
    await insertDecision(adapter, '22-3', runId, 'split-story')
    await insertDecision(adapter, '22-4', runId, 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toEqual(expect.arrayContaining(['22-1', '22-4']))
    expect(result.retryable).toHaveLength(2)
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped).toContainEqual({ key: '22-2', reason: 'needs human review' })
    expect(result.skipped).toContainEqual({ key: '22-3', reason: 'story should be split' })
  })

  it('AC1: defaults to latest run when no runId provided', async () => {
    // Insert decisions for two runs — only latest run's decisions should be returned
    await insertDecision(adapter, '22-1', 'run-old', 'retry-targeted')
    await insertDecision(adapter, '22-2', 'run-new', 'retry-targeted')

    // Latest run is 'run-new' (last inserted = last in created_at ASC order)
    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toContain('22-2')
    expect(result.retryable).not.toContain('22-1')
  })

  it('AC5: scopes to specified run-id when provided', async () => {
    await insertDecision(adapter, '22-1', 'run-old', 'retry-targeted')
    await insertDecision(adapter, '22-2', 'run-new', 'retry-targeted')

    // Scope to old run
    const result = await getRetryableEscalations(adapter, 'run-old')
    expect(result.retryable).toContain('22-1')
    expect(result.retryable).not.toContain('22-2')
  })

  it('AC5: returns empty when specified runId has no matching decisions', async () => {
    await insertDecision(adapter, '22-1', 'run-abc', 'retry-targeted')

    const result = await getRetryableEscalations(adapter, 'run-nonexistent')
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it('skips decisions with malformed keys (no colon)', async () => {
    await createDecision(adapter, {
      phase: 'implementation',
      category: 'escalation-diagnosis',
      key: 'malformed-no-colon',
      value: makeDiagnosis('retry-targeted'),
    })

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toHaveLength(0)
  })

  it('skips decisions with malformed JSON values', async () => {
    await createDecision(adapter, {
      phase: 'implementation',
      category: 'escalation-diagnosis',
      key: '22-1:run-abc',
      value: 'not-valid-json',
    })

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toHaveLength(0)
  })

  it('deduplicates: last decision per storyKey wins (created_at ASC order)', async () => {
    const runId = 'run-dedup'
    // First insert: retry-targeted
    await insertDecision(adapter, '22-1', runId, 'retry-targeted')
    // Second insert for same key: human-intervention (overwrites)
    await insertDecision(adapter, '22-1', runId, 'human-intervention')

    // Since created_at ASC, the last one (human-intervention) wins
    const result = await getRetryableEscalations(adapter, runId)
    expect(result.retryable).toHaveLength(0)
    expect(result.skipped).toContainEqual({ key: '22-1', reason: 'needs human review' })
  })
})

// ---------------------------------------------------------------------------
// Terminal-run status filter — skip escalation-diagnoses belonging to
// pipeline runs whose status is 'failed' or 'stopped' when defaulting.
// ---------------------------------------------------------------------------
//
// Runs in terminal status (failed / stopped) were abandoned; their per-story
// escalations are historical noise and should not surface as retry proposals.
// Caller-supplied runIds bypass the filter so a user can still inspect a
// terminal run explicitly (e.g. for post-mortem).

describe('getRetryableEscalations: terminal-run status filter', () => {
  let adapter: InMemoryDatabaseAdapter

  beforeEach(async () => {
    adapter = await openDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  async function insertRun(
    id: string,
    status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped',
  ) {
    const now = new Date().toISOString()
    await adapter.query(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, 'bmad', status, now, now],
    )
  }

  it('excludes decisions whose referenced run is failed', async () => {
    await insertRun('run-failed', 'failed')
    await insertDecision(adapter, '22-1', 'run-failed', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('excludes decisions whose referenced run is stopped', async () => {
    await insertRun('run-stopped', 'stopped')
    await insertDecision(adapter, '22-1', 'run-stopped', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toEqual([])
  })

  it('includes decisions whose referenced run is completed', async () => {
    await insertRun('run-completed', 'completed')
    await insertDecision(adapter, '22-1', 'run-completed', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toContain('22-1')
  })

  it('includes decisions whose referenced run is running', async () => {
    await insertRun('run-running', 'running')
    await insertDecision(adapter, '22-1', 'run-running', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toContain('22-1')
  })

  it('includes decisions whose referenced run is paused', async () => {
    await insertRun('run-paused', 'paused')
    await insertDecision(adapter, '22-1', 'run-paused', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toContain('22-1')
  })

  it('returns empty when all referenced runs are terminal', async () => {
    await insertRun('run-f1', 'failed')
    await insertRun('run-f2', 'failed')
    await insertRun('run-s1', 'stopped')
    await insertDecision(adapter, '22-1', 'run-f1', 'retry-targeted')
    await insertDecision(adapter, '22-2', 'run-f2', 'retry-targeted')
    await insertDecision(adapter, '22-3', 'run-s1', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toEqual([])
  })

  it('mixed: picks the latest NON-terminal run, skipping newer terminal ones', async () => {
    // Insert oldest first: completed run has 22-1 (retryable)
    await insertRun('run-old-completed', 'completed')
    await insertDecision(adapter, '22-1', 'run-old-completed', 'retry-targeted')
    // Newer: a failed run has 22-2 — should be skipped despite being more recent
    await insertRun('run-new-failed', 'failed')
    await insertDecision(adapter, '22-2', 'run-new-failed', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    // The newer run is failed → falls back to the older completed run
    expect(result.retryable).toContain('22-1')
    expect(result.retryable).not.toContain('22-2')
  })

  it('caller-supplied runId bypasses filter (explicit scoping wins)', async () => {
    // Even a failed run is reachable when the caller names it explicitly —
    // useful for post-mortem inspection.
    await insertRun('run-failed-explicit', 'failed')
    await insertDecision(adapter, '22-1', 'run-failed-explicit', 'retry-targeted')

    const result = await getRetryableEscalations(adapter, 'run-failed-explicit')
    expect(result.retryable).toContain('22-1')
  })

  it('missing pipeline_runs row treated as unknown → included (backward compat)', async () => {
    // No INSERT into pipeline_runs — the existing callers may seed decisions
    // without a run row (e.g. some older tests / migration paths). The filter
    // must not regress that.
    await insertDecision(adapter, '22-1', 'run-orphan', 'retry-targeted')

    const result = await getRetryableEscalations(adapter)
    expect(result.retryable).toContain('22-1')
  })
})
