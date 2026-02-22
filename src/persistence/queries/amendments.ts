/**
 * Amendment query functions for the SQLite persistence layer.
 *
 * Provides operations specific to the amendment workflow:
 * - Creating amendment runs (validated against parent run status)
 * - Loading parent run decisions (active decisions only)
 * - Superseding decisions (with 3 error conditions)
 * - Querying active decisions with optional filtering
 * - Traversing the amendment run chain
 * - Finding the latest completed run
 */

import type { Database } from 'better-sqlite3'
import type { Decision, PipelineRun } from '../schemas/decisions.js'

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export interface CreateAmendmentRunInput {
  id: string           // UUID for the new run
  parentRunId: string  // Must reference a completed pipeline_run
  methodology: string
  configJson?: string
}

export interface ActiveDecisionsFilter {
  pipeline_run_id?: string
  phase?: string
  category?: string
  key?: string
}

export interface SupersessionEvent {
  originalDecisionId: string
  supersedingDecisionId: string
  supersededAt: string  // ISO 8601 timestamp
}

export interface AmendmentChainEntry {
  runId: string
  parentRunId: string | null
  status: string
  createdAt: string
  depth: number  // 0 = root, 1 = first amendment, etc.
}

// ---------------------------------------------------------------------------
// createAmendmentRun
// ---------------------------------------------------------------------------

/**
 * Create a new amendment run that references a completed parent run.
 *
 * Validates that the parent run exists and has status = 'completed'.
 * Throws if the parent run is not found or not completed.
 * Returns the new run's ID on success.
 */
export function createAmendmentRun(db: Database, input: CreateAmendmentRunInput): string {
  // Validate parent run exists and is completed
  const parentRun = db
    .prepare('SELECT id, status FROM pipeline_runs WHERE id = ?')
    .get(input.parentRunId) as { id: string; status: string } | undefined

  if (!parentRun) {
    throw new Error(`Parent run not found: ${input.parentRunId}`)
  }

  if (parentRun.status !== 'completed') {
    throw new Error(
      `Parent run is not completed (status: ${parentRun.status}). Only completed runs can be amended.`,
    )
  }

  // Insert new amendment run with parent_run_id set
  db.prepare(`
    INSERT INTO pipeline_runs (id, methodology, current_phase, status, config_json, parent_run_id, created_at, updated_at)
    VALUES (?, ?, NULL, 'running', ?, ?, datetime('now'), datetime('now'))
  `).run(
    input.id,
    input.methodology,
    input.configJson ?? null,
    input.parentRunId,
  )

  return input.id
}

// ---------------------------------------------------------------------------
// loadParentRunDecisions
// ---------------------------------------------------------------------------

/**
 * Load active (non-superseded) decisions for a given parent run.
 *
 * Returns decisions WHERE superseded_by IS NULL for the specified run,
 * ordered by created_at ASC.
 */
export function loadParentRunDecisions(db: Database, parentRunId: string): Decision[] {
  const stmt = db.prepare(`
    SELECT * FROM decisions
    WHERE pipeline_run_id = ? AND superseded_by IS NULL
    ORDER BY created_at ASC
  `)
  return stmt.all(parentRunId) as Decision[]
}

// ---------------------------------------------------------------------------
// supersedeDecision
// ---------------------------------------------------------------------------

/**
 * Mark a decision as superseded by another decision.
 *
 * Error conditions:
 * 1. originalDecisionId does not exist → throws "Decision not found: <id>"
 * 2. supersedingDecisionId does not exist → throws "Superseding decision not found: <id>"
 * 3. originalDecisionId.superseded_by IS NOT NULL → throws "Decision <id> is already superseded"
 *
 * On success, updates the original decision's superseded_by field.
 */
export function supersedeDecision(
  db: Database,
  originalDecisionId: string,
  supersedingDecisionId: string,
): void {
  // Check original decision exists
  const original = db
    .prepare('SELECT id, superseded_by FROM decisions WHERE id = ?')
    .get(originalDecisionId) as { id: string; superseded_by: string | null } | undefined

  if (!original) {
    throw new Error(`Decision not found: ${originalDecisionId}`)
  }

  // Check superseding decision exists
  const superseding = db
    .prepare('SELECT id FROM decisions WHERE id = ?')
    .get(supersedingDecisionId) as { id: string } | undefined

  if (!superseding) {
    throw new Error(`Superseding decision not found: ${supersedingDecisionId}`)
  }

  // Check original is not already superseded
  if (original.superseded_by !== null) {
    throw new Error(`Decision ${originalDecisionId} is already superseded`)
  }

  // Perform the update
  db.prepare(`
    UPDATE decisions SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?
  `).run(supersedingDecisionId, originalDecisionId)
}

// ---------------------------------------------------------------------------
// getActiveDecisions
// ---------------------------------------------------------------------------

/**
 * Get all active (non-superseded) decisions, with optional filtering.
 *
 * Supports filtering by pipeline_run_id, phase, category, and/or key.
 * If no filter is provided, returns all active decisions across all runs.
 * Results are ordered by created_at ASC.
 */
export function getActiveDecisions(db: Database, filter?: ActiveDecisionsFilter): Decision[] {
  const conditions: string[] = ['superseded_by IS NULL']
  const values: unknown[] = []

  if (filter?.pipeline_run_id !== undefined) {
    conditions.push('pipeline_run_id = ?')
    values.push(filter.pipeline_run_id)
  }
  if (filter?.phase !== undefined) {
    conditions.push('phase = ?')
    values.push(filter.phase)
  }
  if (filter?.category !== undefined) {
    conditions.push('category = ?')
    values.push(filter.category)
  }
  if (filter?.key !== undefined) {
    conditions.push('key = ?')
    values.push(filter.key)
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const stmt = db.prepare(`SELECT * FROM decisions ${where} ORDER BY created_at ASC`)
  return stmt.all(...values) as Decision[]
}

// ---------------------------------------------------------------------------
// getAmendmentRunChain
// ---------------------------------------------------------------------------

/**
 * Traverse the parent_run_id chain starting from runId and return the chain
 * from root (oldest ancestor) to the given run.
 *
 * Throws if the chain depth exceeds maxDepth (default: 10) to guard against
 * circular references.
 *
 * Returns an array of AmendmentChainEntry objects ordered root → current,
 * with depth 0 at the root.
 */
export function getAmendmentRunChain(
  db: Database,
  runId: string,
  maxDepth: number = 10,
): AmendmentChainEntry[] {
  const chain: AmendmentChainEntry[] = []
  let currentId: string | null = runId
  let depth = 0

  while (currentId !== null) {
    if (depth > maxDepth) {
      throw new Error(
        `Amendment chain depth exceeded maxDepth (${maxDepth}). Possible circular reference.`,
      )
    }

    const row = db
      .prepare('SELECT id, parent_run_id, status, created_at FROM pipeline_runs WHERE id = ?')
      .get(currentId) as
      | { id: string; parent_run_id: string | null; status: string; created_at: string }
      | undefined

    if (!row) break

    chain.unshift({
      runId: row.id,
      parentRunId: row.parent_run_id,
      status: row.status,
      createdAt: row.created_at,
      depth,
    })

    currentId = row.parent_run_id
    depth++
  }

  // Re-assign depth values so root = 0, working down to the original runId
  // The chain is already in root-first order (unshift builds it that way).
  // But depth was assigned as the traversal depth from the given run,
  // so the last element has depth 0 (the start runId) and the first has
  // the highest depth. We need to reassign so root (index 0) = depth 0.
  for (let i = 0; i < chain.length; i++) {
    chain[i].depth = i
  }

  return chain
}

// ---------------------------------------------------------------------------
// getLatestCompletedRun
// ---------------------------------------------------------------------------

/**
 * Get the most recently created pipeline run with status = 'completed'.
 * Returns undefined if no completed run exists.
 */
export function getLatestCompletedRun(db: Database): PipelineRun | undefined {
  const stmt = db.prepare(`
    SELECT * FROM pipeline_runs
    WHERE status = 'completed'
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `)
  return stmt.get() as PipelineRun | undefined
}
