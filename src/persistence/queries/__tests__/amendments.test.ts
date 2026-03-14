/**
 * Unit tests for src/persistence/queries/amendments.ts
 *
 * Uses in-memory SQLite database seeded with all migrations (including 008).
 * Covers all ACs:
 * - AC1: createAmendmentRun() validates parent run is completed
 * - AC2: loadParentRunDecisions() returns only active (non-superseded) decisions
 * - AC3: supersedeDecision() enforces 3 error conditions
 * - AC4: getActiveDecisions() supports optional filter
 * - AC5: getAmendmentRunChain() enforces maxDepth guard
 * - AC6: getLatestCompletedRun() returns most recent completed run
 * - AC7: all functions use parameterized queries (structural verification)
 * - AC8: exported types are correct interfaces
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../wasm-sqlite-adapter.js'
import { initSchema } from '../../schema.js'
import {
  createAmendmentRun,
  loadParentRunDecisions,
  supersedeDecision,
  getActiveDecisions,
  getAmendmentRunChain,
  getLatestCompletedRun,
} from '../amendments.js'
import type {
  CreateAmendmentRunInput,
  ActiveDecisionsFilter,
  SupersessionEvent,
  AmendmentChainEntry,
} from '../amendments.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openMemoryDb() {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  await initSchema(adapter)
  return adapter
}

/**
 * Insert a pipeline run directly with a given status.
 */
function insertRun(
  adapter: WasmSqliteDatabaseAdapter,
  id: string,
  status: string = 'running',
  parentRunId: string | null = null,
): void {
  adapter.querySync(
    `INSERT INTO pipeline_runs (id, methodology, status, parent_run_id, created_at, updated_at)
    VALUES (?, 'bmad', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, status, parentRunId],
  )
}

/**
 * Insert a decision for a given run.
 */
function insertDecision(
  adapter: WasmSqliteDatabaseAdapter,
  id: string,
  runId: string,
  overrides: {
    phase?: string
    category?: string
    key?: string
    value?: string
    supersededBy?: string | null
  } = {},
): void {
  const {
    phase = 'analysis',
    category = 'architecture',
    key = 'default-key',
    value = 'default-value',
    supersededBy = null,
  } = overrides

  adapter.querySync(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, runId, phase, category, key, value, supersededBy],
  )
}

// ---------------------------------------------------------------------------
// AC1: createAmendmentRun()
// ---------------------------------------------------------------------------

describe('createAmendmentRun()', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC1: throws "Parent run not found" when parentRunId does not exist', async () => {
    const input: CreateAmendmentRunInput = {
      id: crypto.randomUUID(),
      parentRunId: 'nonexistent-run-id',
      methodology: 'bmad',
    }
    await expect(createAmendmentRun(adapter, input)).rejects.toThrow('Parent run not found: nonexistent-run-id')
  })

  it('AC1: throws when parent run status is "running" (not completed)', async () => {
    insertRun(adapter, 'run-running', 'running')
    const input: CreateAmendmentRunInput = {
      id: crypto.randomUUID(),
      parentRunId: 'run-running',
      methodology: 'bmad',
    }
    await expect(createAmendmentRun(adapter, input)).rejects.toThrow(
      'Parent run is not completed (status: running). Only completed runs can be amended.',
    )
  })

  it('AC1: throws when parent run status is "failed" (not completed)', async () => {
    insertRun(adapter, 'run-failed', 'failed')
    const input: CreateAmendmentRunInput = {
      id: crypto.randomUUID(),
      parentRunId: 'run-failed',
      methodology: 'bmad',
    }
    await expect(createAmendmentRun(adapter, input)).rejects.toThrow(
      'Parent run is not completed (status: failed). Only completed runs can be amended.',
    )
  })

  it('AC1: throws when parent run status is "paused" (not completed)', async () => {
    insertRun(adapter, 'run-paused', 'paused')
    const input: CreateAmendmentRunInput = {
      id: crypto.randomUUID(),
      parentRunId: 'run-paused',
      methodology: 'bmad',
    }
    await expect(createAmendmentRun(adapter, input)).rejects.toThrow(
      'Parent run is not completed (status: paused). Only completed runs can be amended.',
    )
  })

  it('AC1: throws when parent run status is "stopped" (not completed)', async () => {
    insertRun(adapter, 'run-stopped', 'stopped')
    const input: CreateAmendmentRunInput = {
      id: crypto.randomUUID(),
      parentRunId: 'run-stopped',
      methodology: 'bmad',
    }
    await expect(createAmendmentRun(adapter, input)).rejects.toThrow(
      'Parent run is not completed (status: stopped). Only completed runs can be amended.',
    )
  })

  it('AC1: returns new run ID when parent is completed', async () => {
    insertRun(adapter, 'run-completed', 'completed')
    const newId = crypto.randomUUID()
    const input: CreateAmendmentRunInput = {
      id: newId,
      parentRunId: 'run-completed',
      methodology: 'bmad',
    }
    const result = await createAmendmentRun(adapter, input)
    expect(result).toBe(newId)
  })

  it('AC1: inserts new run with correct parent_run_id and status = running', async () => {
    insertRun(adapter, 'run-completed', 'completed')
    const newId = crypto.randomUUID()
    const input: CreateAmendmentRunInput = {
      id: newId,
      parentRunId: 'run-completed',
      methodology: 'bmad',
    }
    await createAmendmentRun(adapter, input)

    const row = adapter.querySync<{
      id: string
      status: string
      parent_run_id: string
      methodology: string
      config_json: string | null
    }>('SELECT * FROM pipeline_runs WHERE id = ?', [newId])[0]
    expect(row).toBeDefined()
    expect(row?.status).toBe('running')
    expect(row?.parent_run_id).toBe('run-completed')
    expect(row?.methodology).toBe('bmad')
    expect(row?.config_json).toBeNull()
  })

  it('AC1: stores configJson when provided', async () => {
    insertRun(adapter, 'run-completed-cfg', 'completed')
    const newId = crypto.randomUUID()
    const input: CreateAmendmentRunInput = {
      id: newId,
      parentRunId: 'run-completed-cfg',
      methodology: 'bmad',
      configJson: '{"key":"value"}',
    }
    await createAmendmentRun(adapter, input)

    const row = adapter.querySync<{ config_json: string }>(
      'SELECT config_json FROM pipeline_runs WHERE id = ?',
      [newId],
    )[0]
    expect(row?.config_json).toBe('{"key":"value"}')
  })
})

// ---------------------------------------------------------------------------
// AC2: loadParentRunDecisions()
// ---------------------------------------------------------------------------

describe('loadParentRunDecisions()', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
    insertRun(adapter, 'parent-run', 'completed')
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC2: returns empty array when no decisions exist for the run', async () => {
    const result = await loadParentRunDecisions(adapter, 'parent-run')
    expect(result).toEqual([])
  })

  it('AC2: returns only non-superseded decisions (superseded_by IS NULL)', async () => {
    insertDecision(adapter, 'dec-active-1', 'parent-run', { key: 'k1' })
    insertDecision(adapter, 'dec-active-2', 'parent-run', { key: 'k2' })
    insertDecision(adapter, 'dec-superseder', 'parent-run', { key: 'k3' })
    insertDecision(adapter, 'dec-superseded', 'parent-run', {
      key: 'k4',
      supersededBy: 'dec-superseder',
    })

    const result = await loadParentRunDecisions(adapter, 'parent-run')
    const ids = result.map((d) => d.id)
    expect(ids).toContain('dec-active-1')
    expect(ids).toContain('dec-active-2')
    expect(ids).toContain('dec-superseder')
    expect(ids).not.toContain('dec-superseded')
    expect(result).toHaveLength(3)
  })

  it('AC2: superseded decision is excluded, non-superseded superseder is included', async () => {
    // dec-new supersedes dec-old
    // dec-old should be excluded (superseded_by is set)
    // dec-new should be included (superseded_by is NULL — it supersedes dec-old but is not itself superseded)
    insertDecision(adapter, 'dec-new', 'parent-run', { key: 'k-new' })
    insertDecision(adapter, 'dec-old', 'parent-run', { key: 'k-old', supersededBy: 'dec-new' })

    const result = await loadParentRunDecisions(adapter, 'parent-run')
    const ids = result.map((d) => d.id)
    expect(ids).not.toContain('dec-old')
    expect(ids).toContain('dec-new') // dec-new supersedes dec-old but is not itself superseded
    expect(result).toHaveLength(1)
  })

  it('AC2: does not return decisions from other runs', async () => {
    insertRun(adapter, 'other-run', 'completed')
    insertDecision(adapter, 'dec-mine', 'parent-run', { key: 'mine' })
    insertDecision(adapter, 'dec-theirs', 'other-run', { key: 'theirs' })

    const result = await loadParentRunDecisions(adapter, 'parent-run')
    const ids = result.map((d) => d.id)
    expect(ids).toContain('dec-mine')
    expect(ids).not.toContain('dec-theirs')
  })

  it('AC2: returns decisions in created_at ASC order', async () => {
    // Insert with explicit timestamps to ensure ordering
    adapter.querySync(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
      VALUES ('dec-z', 'parent-run', 'analysis', 'cat', 'z', 'v', NULL, '2024-01-03T00:00:00', '2024-01-03T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
      VALUES ('dec-a', 'parent-run', 'analysis', 'cat', 'a', 'v', NULL, '2024-01-01T00:00:00', '2024-01-01T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
      VALUES ('dec-m', 'parent-run', 'analysis', 'cat', 'm', 'v', NULL, '2024-01-02T00:00:00', '2024-01-02T00:00:00')`,
    )

    const result = await loadParentRunDecisions(adapter, 'parent-run')
    expect(result.map((d) => d.id)).toEqual(['dec-a', 'dec-m', 'dec-z'])
  })
})

// ---------------------------------------------------------------------------
// AC3: supersedeDecision()
// ---------------------------------------------------------------------------

describe('supersedeDecision()', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
    insertRun(adapter, 'run-for-supersede', 'running')
    insertDecision(adapter, 'original-dec', 'run-for-supersede', { key: 'original' })
    insertDecision(adapter, 'superseding-dec', 'run-for-supersede', { key: 'superseding' })
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC3: throws "Decision not found" when originalDecisionId does not exist', async () => {
    await expect(
      supersedeDecision(adapter, 'does-not-exist', 'superseding-dec'),
    ).rejects.toThrow('Decision not found: does-not-exist')
  })

  it('AC3: throws "Superseding decision not found" when supersedingDecisionId does not exist', async () => {
    await expect(
      supersedeDecision(adapter, 'original-dec', 'does-not-exist'),
    ).rejects.toThrow('Superseding decision not found: does-not-exist')
  })

  it('AC3: throws "Decision is already superseded" when originalDecisionId already has superseded_by set', async () => {
    // First supersession should succeed
    await supersedeDecision(adapter, 'original-dec', 'superseding-dec')

    // Create another superseder to attempt a second supersession
    insertDecision(adapter, 'another-superseder', 'run-for-supersede', { key: 'another' })
    await expect(
      supersedeDecision(adapter, 'original-dec', 'another-superseder'),
    ).rejects.toThrow('Decision original-dec is already superseded')
  })

  it('AC3: successfully updates superseded_by on the original decision', async () => {
    await supersedeDecision(adapter, 'original-dec', 'superseding-dec')

    const row = adapter.querySync<{ superseded_by: string }>(
      'SELECT superseded_by FROM decisions WHERE id = ?',
      ['original-dec'],
    )[0]
    expect(row?.superseded_by).toBe('superseding-dec')
  })

  it('AC3: returns void on success', async () => {
    const result = await supersedeDecision(adapter, 'original-dec', 'superseding-dec')
    expect(result).toBeUndefined()
  })

  it('AC3: superseding decision itself is not affected', async () => {
    await supersedeDecision(adapter, 'original-dec', 'superseding-dec')

    const row = adapter.querySync<{ superseded_by: string | null }>(
      'SELECT superseded_by FROM decisions WHERE id = ?',
      ['superseding-dec'],
    )[0]
    expect(row?.superseded_by).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC4: getActiveDecisions()
// ---------------------------------------------------------------------------

describe('getActiveDecisions()', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
    insertRun(adapter, 'run-a', 'running')
    insertRun(adapter, 'run-b', 'running')

    // Insert decisions across two runs with various attributes
    insertDecision(adapter, 'dec-a1', 'run-a', { phase: 'analysis', category: 'arch', key: 'key1', value: 'v1' })
    insertDecision(adapter, 'dec-a2', 'run-a', { phase: 'planning', category: 'tech', key: 'key2', value: 'v2' })
    insertDecision(adapter, 'dec-a3', 'run-a', { phase: 'analysis', category: 'arch', key: 'key3', value: 'v3' })
    insertDecision(adapter, 'dec-b1', 'run-b', { phase: 'analysis', category: 'arch', key: 'key1', value: 'v4' })

    // Supersede dec-a1
    insertDecision(adapter, 'dec-a1-new', 'run-a', { phase: 'analysis', category: 'arch', key: 'key1-new', value: 'v5' })
    adapter.querySync('UPDATE decisions SET superseded_by = ? WHERE id = ?', ['dec-a1-new', 'dec-a1'])
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC4: returns all active decisions when no filter provided', async () => {
    const result = await getActiveDecisions(adapter)
    const ids = result.map((d) => d.id)
    // dec-a1 is superseded, all others should be active
    expect(ids).not.toContain('dec-a1')
    expect(ids).toContain('dec-a2')
    expect(ids).toContain('dec-a3')
    expect(ids).toContain('dec-b1')
    expect(ids).toContain('dec-a1-new')
    expect(result).toHaveLength(4)
  })

  it('AC4: filters by pipeline_run_id', async () => {
    const result = await getActiveDecisions(adapter, { pipeline_run_id: 'run-a' })
    const ids = result.map((d) => d.id)
    expect(ids).not.toContain('dec-a1')
    expect(ids).toContain('dec-a2')
    expect(ids).toContain('dec-a3')
    expect(ids).toContain('dec-a1-new')
    expect(ids).not.toContain('dec-b1')
    expect(result).toHaveLength(3)
  })

  it('AC4: filters by phase', async () => {
    const result = await getActiveDecisions(adapter, { phase: 'analysis' })
    const ids = result.map((d) => d.id)
    expect(ids).not.toContain('dec-a1') // superseded
    expect(ids).toContain('dec-a3')
    expect(ids).toContain('dec-b1')
    expect(ids).toContain('dec-a1-new')
    expect(ids).not.toContain('dec-a2') // planning phase
  })

  it('AC4: filters by category', async () => {
    const result = await getActiveDecisions(adapter, { category: 'tech' })
    const ids = result.map((d) => d.id)
    expect(ids).toContain('dec-a2')
    expect(ids).not.toContain('dec-a3') // arch category
    expect(ids).not.toContain('dec-b1') // arch category
    expect(result).toHaveLength(1)
  })

  it('AC4: filters by key', async () => {
    const result = await getActiveDecisions(adapter, { key: 'key2' })
    const ids = result.map((d) => d.id)
    expect(ids).toContain('dec-a2')
    expect(result).toHaveLength(1)
  })

  it('AC4: supports combined filters (pipeline_run_id + phase)', async () => {
    const result = await getActiveDecisions(adapter, { pipeline_run_id: 'run-a', phase: 'analysis' })
    const ids = result.map((d) => d.id)
    expect(ids).not.toContain('dec-a1') // superseded
    expect(ids).toContain('dec-a3')
    expect(ids).toContain('dec-a1-new')
    expect(ids).not.toContain('dec-a2') // planning
    expect(ids).not.toContain('dec-b1') // run-b
    expect(result).toHaveLength(2)
  })

  it('AC4: returns empty array when filter matches no active decisions', async () => {
    const result = await getActiveDecisions(adapter, { phase: 'implementation' })
    expect(result).toEqual([])
  })

  it('AC4: results are ordered by created_at ASC', async () => {
    // Insert with explicit timestamps
    insertRun(adapter, 'run-ordered', 'running')
    adapter.querySync(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
      VALUES ('ord-z', 'run-ordered', 'analysis', 'cat', 'z', 'v', NULL, '2024-03-01T00:00:00', '2024-03-01T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
      VALUES ('ord-a', 'run-ordered', 'analysis', 'cat', 'a', 'v', NULL, '2024-01-01T00:00:00', '2024-01-01T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, superseded_by, created_at, updated_at)
      VALUES ('ord-m', 'run-ordered', 'analysis', 'cat', 'm', 'v', NULL, '2024-02-01T00:00:00', '2024-02-01T00:00:00')`,
    )

    const result = await getActiveDecisions(adapter, { pipeline_run_id: 'run-ordered' })
    expect(result.map((d) => d.id)).toEqual(['ord-a', 'ord-m', 'ord-z'])
  })
})

// ---------------------------------------------------------------------------
// AC5: getAmendmentRunChain()
// ---------------------------------------------------------------------------

describe('getAmendmentRunChain()', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC5: returns single entry for a run with no parent (top-level run)', async () => {
    insertRun(adapter, 'root-run', 'completed')
    const chain = await getAmendmentRunChain(adapter, 'root-run')
    expect(chain).toHaveLength(1)
    expect(chain[0].runId).toBe('root-run')
    expect(chain[0].parentRunId).toBeNull()
    expect(chain[0].depth).toBe(0)
  })

  it('AC5: returns root → child for a 2-level chain', async () => {
    insertRun(adapter, 'root', 'completed')
    insertRun(adapter, 'amend-1', 'running', 'root')

    const chain = await getAmendmentRunChain(adapter, 'amend-1')
    expect(chain).toHaveLength(2)
    expect(chain[0].runId).toBe('root')
    expect(chain[0].depth).toBe(0)
    expect(chain[0].parentRunId).toBeNull()
    expect(chain[1].runId).toBe('amend-1')
    expect(chain[1].depth).toBe(1)
    expect(chain[1].parentRunId).toBe('root')
  })

  it('AC5: returns correct order for a 3-level chain (root → amend1 → amend2)', async () => {
    insertRun(adapter, 'r0', 'completed')
    insertRun(adapter, 'r1', 'completed', 'r0')
    insertRun(adapter, 'r2', 'running', 'r1')

    const chain = await getAmendmentRunChain(adapter, 'r2')
    expect(chain).toHaveLength(3)
    expect(chain[0].runId).toBe('r0')
    expect(chain[0].depth).toBe(0)
    expect(chain[1].runId).toBe('r1')
    expect(chain[1].depth).toBe(1)
    expect(chain[2].runId).toBe('r2')
    expect(chain[2].depth).toBe(2)
  })

  it('AC5: throws "Amendment chain depth exceeded maxDepth" when chain exceeds maxDepth', async () => {
    // Create a chain of 3 runs but set maxDepth to 1
    insertRun(adapter, 'depth-r0', 'completed')
    insertRun(adapter, 'depth-r1', 'completed', 'depth-r0')
    insertRun(adapter, 'depth-r2', 'running', 'depth-r1')

    await expect(getAmendmentRunChain(adapter, 'depth-r2', 1)).rejects.toThrow(
      'Amendment chain depth exceeded maxDepth (1). Possible circular reference.',
    )
  })

  it('AC5: uses default maxDepth of 10 (does not throw for chain of 5)', async () => {
    // Build a chain of 5 levels
    insertRun(adapter, 'chain-0', 'completed')
    insertRun(adapter, 'chain-1', 'completed', 'chain-0')
    insertRun(adapter, 'chain-2', 'completed', 'chain-1')
    insertRun(adapter, 'chain-3', 'completed', 'chain-2')
    insertRun(adapter, 'chain-4', 'running', 'chain-3')

    await expect(getAmendmentRunChain(adapter, 'chain-4')).resolves.not.toThrow()
    const chain = await getAmendmentRunChain(adapter, 'chain-4')
    expect(chain).toHaveLength(5)
  })

  it('AC5: returns empty array for a runId that does not exist', async () => {
    const chain = await getAmendmentRunChain(adapter, 'does-not-exist')
    expect(chain).toEqual([])
  })

  it('AC5: AmendmentChainEntry has all required fields', async () => {
    insertRun(adapter, 'entry-run', 'completed')
    const chain = await getAmendmentRunChain(adapter, 'entry-run')
    expect(chain).toHaveLength(1)

    const entry: AmendmentChainEntry = chain[0]
    expect(entry).toHaveProperty('runId')
    expect(entry).toHaveProperty('parentRunId')
    expect(entry).toHaveProperty('status')
    expect(entry).toHaveProperty('createdAt')
    expect(entry).toHaveProperty('depth')
    expect(entry.status).toBe('completed')
  })

  it('AC5: throws at exactly maxDepth + 1 levels', async () => {
    // maxDepth = 2, chain = 4 levels (0,1,2,3): should throw when traversing beyond 2
    insertRun(adapter, 'md-0', 'completed')
    insertRun(adapter, 'md-1', 'completed', 'md-0')
    insertRun(adapter, 'md-2', 'completed', 'md-1')
    insertRun(adapter, 'md-3', 'running', 'md-2')

    await expect(getAmendmentRunChain(adapter, 'md-3', 2)).rejects.toThrow(
      'Amendment chain depth exceeded maxDepth (2). Possible circular reference.',
    )
  })
})

// ---------------------------------------------------------------------------
// AC6: getLatestCompletedRun()
// ---------------------------------------------------------------------------

describe('getLatestCompletedRun()', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('AC6: returns undefined when no runs exist', async () => {
    const result = await getLatestCompletedRun(adapter)
    expect(result).toBeUndefined()
  })

  it('AC6: returns undefined when only non-completed runs exist', async () => {
    insertRun(adapter, 'running-run', 'running')
    insertRun(adapter, 'failed-run', 'failed')
    insertRun(adapter, 'stopped-run', 'stopped')
    const result = await getLatestCompletedRun(adapter)
    expect(result).toBeUndefined()
  })

  it('AC6: returns the single completed run', async () => {
    insertRun(adapter, 'only-completed', 'completed')
    const result = await getLatestCompletedRun(adapter)
    expect(result).toBeDefined()
    expect(result?.id).toBe('only-completed')
    expect(result?.status).toBe('completed')
  })

  it('AC6: returns the most recently created completed run when multiple exist', async () => {
    adapter.querySync(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES ('old-completed', 'bmad', 'completed', '2024-01-01T00:00:00', '2024-01-01T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES ('new-completed', 'bmad', 'completed', '2024-06-01T00:00:00', '2024-06-01T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES ('mid-completed', 'bmad', 'completed', '2024-03-01T00:00:00', '2024-03-01T00:00:00')`,
    )

    const result = await getLatestCompletedRun(adapter)
    expect(result?.id).toBe('new-completed')
  })

  it('AC6: ignores non-completed runs when selecting most recent', async () => {
    adapter.querySync(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES ('completed-1', 'bmad', 'completed', '2024-01-01T00:00:00', '2024-01-01T00:00:00')`,
    )
    adapter.querySync(
      `INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES ('running-newer', 'bmad', 'running', '2024-12-01T00:00:00', '2024-12-01T00:00:00')`,
    )

    const result = await getLatestCompletedRun(adapter)
    expect(result?.id).toBe('completed-1')
    expect(result?.status).toBe('completed')
  })

  it('AC6: return type has PipelineRun fields', async () => {
    insertRun(adapter, 'type-check-run', 'completed')
    const result = await getLatestCompletedRun(adapter)
    expect(result).toBeDefined()
    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('methodology')
    expect(result).toHaveProperty('status')
    expect(result).toHaveProperty('created_at')
    expect(result).toHaveProperty('updated_at')
  })
})

// ---------------------------------------------------------------------------
// AC7: All queries use parameterized statements
// ---------------------------------------------------------------------------

describe('AC7: Parameterized query safety', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    adapter = await openMemoryDb()
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('createAmendmentRun() handles special characters in IDs safely', async () => {
    insertRun(adapter, 'safe-parent-run', 'completed')
    const newId = "safe'; DROP TABLE pipeline_runs; --"
    // This should throw due to UUID format or FK constraint — not SQL injection
    await expect(
      createAmendmentRun(adapter, {
        id: newId,
        parentRunId: 'safe-parent-run',
        methodology: 'bmad',
      }),
    ).resolves.not.toThrow() // SQLite TEXT can store this string; no injection risk
    // Verify the table still exists
    const count = adapter.querySync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM pipeline_runs')[0]!
    expect(count.cnt).toBeGreaterThanOrEqual(1)
  })

  it('loadParentRunDecisions() with SQL injection attempt returns empty array (not error)', async () => {
    const maliciousId = "' OR '1'='1"
    const result = await loadParentRunDecisions(adapter, maliciousId)
    expect(result).toEqual([])
  })

  it('getActiveDecisions() with SQL injection filter returns empty results (not error)', async () => {
    const result = await getActiveDecisions(adapter, { phase: "'; DROP TABLE decisions; --" })
    expect(result).toEqual([])
    // decisions table still exists
    const count = adapter.querySync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM decisions')[0]!
    expect(count.cnt).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC8: Exported types are correct
// ---------------------------------------------------------------------------

describe('AC8: Exported type shapes', () => {
  it('CreateAmendmentRunInput has required fields', () => {
    const input: CreateAmendmentRunInput = {
      id: 'some-uuid',
      parentRunId: 'parent-uuid',
      methodology: 'bmad',
    }
    expect(input.id).toBe('some-uuid')
    expect(input.parentRunId).toBe('parent-uuid')
    expect(input.methodology).toBe('bmad')
    expect(input.configJson).toBeUndefined()
  })

  it('CreateAmendmentRunInput accepts optional configJson', () => {
    const input: CreateAmendmentRunInput = {
      id: 'some-uuid',
      parentRunId: 'parent-uuid',
      methodology: 'bmad',
      configJson: '{}',
    }
    expect(input.configJson).toBe('{}')
  })

  it('ActiveDecisionsFilter fields are all optional', () => {
    const filterEmpty: ActiveDecisionsFilter = {}
    const filterFull: ActiveDecisionsFilter = {
      pipeline_run_id: 'run-id',
      phase: 'analysis',
      category: 'arch',
      key: 'my-key',
    }
    expect(filterEmpty).toBeDefined()
    expect(filterFull.pipeline_run_id).toBe('run-id')
  })

  it('SupersessionEvent has the correct shape', () => {
    const event: SupersessionEvent = {
      originalDecisionId: 'orig-id',
      supersedingDecisionId: 'new-id',
      supersededAt: new Date().toISOString(),
    }
    expect(event.originalDecisionId).toBe('orig-id')
    expect(event.supersedingDecisionId).toBe('new-id')
    expect(typeof event.supersededAt).toBe('string')
  })

  it('AmendmentChainEntry has the correct shape', () => {
    const entry: AmendmentChainEntry = {
      runId: 'run-id',
      parentRunId: null,
      status: 'completed',
      createdAt: '2024-01-01T00:00:00',
      depth: 0,
    }
    expect(entry.runId).toBe('run-id')
    expect(entry.parentRunId).toBeNull()
    expect(entry.depth).toBe(0)
  })
})
