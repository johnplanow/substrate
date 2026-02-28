/**
 * Decision store query functions for the SQLite persistence layer.
 *
 * Provides CRUD operations for the decision store tables:
 * decisions, requirements, constraints, artifacts, pipeline_runs, token_usage.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import {
  CreateDecisionInputSchema,
  CreateRequirementInputSchema,
  CreateConstraintInputSchema,
  RegisterArtifactInputSchema,
  CreatePipelineRunInputSchema,
  AddTokenUsageInputSchema,
} from '../schemas/decisions.js'
import type {
  Decision,
  Requirement,
  Constraint,
  Artifact,
  PipelineRun,
  TokenUsage,
  CreateDecisionInput,
  CreateRequirementInput,
  CreateConstraintInput,
  RegisterArtifactInput,
  CreatePipelineRunInput,
  AddTokenUsageInput,
} from '../schemas/decisions.js'

// Re-export types for consumers
export type {
  Decision,
  Requirement,
  Constraint,
  Artifact,
  PipelineRun,
  TokenUsage,
  CreateDecisionInput,
  CreateRequirementInput,
  CreateConstraintInput,
  RegisterArtifactInput,
  CreatePipelineRunInput,
  AddTokenUsageInput,
}

// ---------------------------------------------------------------------------
// Decision queries
// ---------------------------------------------------------------------------

/**
 * Insert a new decision record with a generated UUID.
 */
export function createDecision(db: BetterSqlite3Database, input: CreateDecisionInput): Decision {
  const validated = CreateDecisionInputSchema.parse(input)
  const id = crypto.randomUUID()

  const stmt = db.prepare(`
    INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    id,
    validated.pipeline_run_id ?? null,
    validated.phase,
    validated.category,
    validated.key,
    validated.value,
    validated.rationale ?? null,
  )

  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Decision
  return row
}

/**
 * Insert or update a decision record.
 * If a decision with the same pipeline_run_id, category, and key already exists,
 * update its value and rationale. Otherwise, insert a new record.
 */
export function upsertDecision(db: BetterSqlite3Database, input: CreateDecisionInput): Decision {
  const validated = CreateDecisionInputSchema.parse(input)

  // Check for existing decision with same pipeline_run_id + category + key
  const existing = db
    .prepare(
      'SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = ? AND key = ? LIMIT 1',
    )
    .get(validated.pipeline_run_id ?? null, validated.category, validated.key) as
    | Decision
    | undefined

  if (existing) {
    updateDecision(db, existing.id, {
      value: validated.value,
      rationale: validated.rationale ?? undefined,
    })
    return db.prepare('SELECT * FROM decisions WHERE id = ?').get(existing.id) as Decision
  }

  return createDecision(db, input)
}

/**
 * Get all decisions for a given phase, ordered by created_at ascending.
 */
export function getDecisionsByPhase(db: BetterSqlite3Database, phase: string): Decision[] {
  const stmt = db.prepare(
    'SELECT * FROM decisions WHERE phase = ? ORDER BY created_at ASC',
  )
  return stmt.all(phase) as Decision[]
}

/**
 * Get all decisions for a given phase scoped to a specific pipeline run,
 * ordered by created_at ascending.
 */
export function getDecisionsByPhaseForRun(
  db: BetterSqlite3Database,
  runId: string,
  phase: string,
): Decision[] {
  const stmt = db.prepare(
    'SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = ? ORDER BY created_at ASC',
  )
  return stmt.all(runId, phase) as Decision[]
}

/**
 * Get a single decision by phase and key. Returns undefined if not found.
 */
export function getDecisionByKey(
  db: BetterSqlite3Database,
  phase: string,
  key: string,
): Decision | undefined {
  const stmt = db.prepare('SELECT * FROM decisions WHERE phase = ? AND key = ? LIMIT 1')
  return stmt.get(phase, key) as Decision | undefined
}

/**
 * Update a decision's value and/or rationale and set updated_at.
 */
export function updateDecision(
  db: BetterSqlite3Database,
  id: string,
  updates: Partial<Pick<Decision, 'value' | 'rationale'>>,
): void {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.value !== undefined) {
    setClauses.push('value = ?')
    values.push(updates.value)
  }
  if (updates.rationale !== undefined) {
    setClauses.push('rationale = ?')
    values.push(updates.rationale)
  }

  if (setClauses.length === 0) return

  setClauses.push("updated_at = datetime('now')")
  values.push(id)

  const stmt = db.prepare(`UPDATE decisions SET ${setClauses.join(', ')} WHERE id = ?`)
  stmt.run(...values)
}

// ---------------------------------------------------------------------------
// Requirement queries
// ---------------------------------------------------------------------------

/**
 * Insert a new requirement with status = 'active'.
 */
export function createRequirement(
  db: BetterSqlite3Database,
  input: CreateRequirementInput,
): Requirement {
  const validated = CreateRequirementInputSchema.parse(input)
  const id = crypto.randomUUID()

  const stmt = db.prepare(`
    INSERT INTO requirements (id, pipeline_run_id, source, type, description, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `)
  stmt.run(
    id,
    validated.pipeline_run_id ?? null,
    validated.source,
    validated.type,
    validated.description,
    validated.priority,
  )

  const row = db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as Requirement
  return row
}

/**
 * List requirements with optional filtering by type, priority, and status.
 */
export function listRequirements(
  db: BetterSqlite3Database,
  filters?: { type?: string; priority?: string; status?: string },
): Requirement[] {
  const conditions: string[] = []
  const values: unknown[] = []

  if (filters?.type !== undefined) {
    conditions.push('type = ?')
    values.push(filters.type)
  }
  if (filters?.priority !== undefined) {
    conditions.push('priority = ?')
    values.push(filters.priority)
  }
  if (filters?.status !== undefined) {
    conditions.push('status = ?')
    values.push(filters.status)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const stmt = db.prepare(`SELECT * FROM requirements ${where} ORDER BY created_at ASC`)
  return stmt.all(...values) as Requirement[]
}

/**
 * Transition a requirement's status.
 */
export function updateRequirementStatus(
  db: BetterSqlite3Database,
  id: string,
  status: string,
): void {
  const stmt = db.prepare('UPDATE requirements SET status = ? WHERE id = ?')
  stmt.run(status, id)
}

// ---------------------------------------------------------------------------
// Constraint queries
// ---------------------------------------------------------------------------

/**
 * Insert a new constraint record.
 */
export function createConstraint(
  db: BetterSqlite3Database,
  input: CreateConstraintInput,
): Constraint {
  const validated = CreateConstraintInputSchema.parse(input)
  const id = crypto.randomUUID()

  const stmt = db.prepare(`
    INSERT INTO constraints (id, pipeline_run_id, category, description, source)
    VALUES (?, ?, ?, ?, ?)
  `)
  stmt.run(
    id,
    validated.pipeline_run_id ?? null,
    validated.category,
    validated.description,
    validated.source,
  )

  const row = db.prepare('SELECT * FROM constraints WHERE id = ?').get(id) as Constraint
  return row
}

/**
 * List constraints with optional category filtering.
 */
export function listConstraints(
  db: BetterSqlite3Database,
  filters?: { category?: string },
): Constraint[] {
  if (filters?.category !== undefined) {
    const stmt = db.prepare(
      'SELECT * FROM constraints WHERE category = ? ORDER BY created_at ASC',
    )
    return stmt.all(filters.category) as Constraint[]
  }
  const stmt = db.prepare('SELECT * FROM constraints ORDER BY created_at ASC')
  return stmt.all() as Constraint[]
}

// ---------------------------------------------------------------------------
// Artifact queries
// ---------------------------------------------------------------------------

/**
 * Register a new artifact record.
 */
export function registerArtifact(
  db: BetterSqlite3Database,
  input: RegisterArtifactInput,
): Artifact {
  const validated = RegisterArtifactInputSchema.parse(input)
  const id = crypto.randomUUID()

  const stmt = db.prepare(`
    INSERT INTO artifacts (id, pipeline_run_id, phase, type, path, content_hash, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    id,
    validated.pipeline_run_id ?? null,
    validated.phase,
    validated.type,
    validated.path,
    validated.content_hash ?? null,
    validated.summary ?? null,
  )

  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Artifact
  return row
}

/**
 * Get all artifacts for a given phase, ordered by created_at ascending.
 */
export function getArtifactsByPhase(db: BetterSqlite3Database, phase: string): Artifact[] {
  const stmt = db.prepare(
    'SELECT * FROM artifacts WHERE phase = ? ORDER BY created_at ASC',
  )
  return stmt.all(phase) as Artifact[]
}

/**
 * Get the latest artifact of a given type for a given phase.
 * Returns undefined if none found.
 */
export function getArtifactByType(
  db: BetterSqlite3Database,
  phase: string,
  type: string,
): Artifact | undefined {
  const stmt = db.prepare(
    'SELECT * FROM artifacts WHERE phase = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )
  return stmt.get(phase, type) as Artifact | undefined
}

/**
 * Get the latest artifact of a given type for a specific pipeline run.
 * Filters by pipeline_run_id, phase, and type.
 * Returns undefined if none found.
 */
export function getArtifactByTypeForRun(
  db: BetterSqlite3Database,
  runId: string,
  phase: string,
  type: string,
): Artifact | undefined {
  const stmt = db.prepare(
    'SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )
  return stmt.get(runId, phase, type) as Artifact | undefined
}

/**
 * Get all artifacts registered for a specific pipeline run, ordered by created_at ascending.
 */
export function getArtifactsByRun(db: BetterSqlite3Database, runId: string): Artifact[] {
  const stmt = db.prepare(
    'SELECT * FROM artifacts WHERE pipeline_run_id = ? ORDER BY created_at ASC',
  )
  return stmt.all(runId) as Artifact[]
}

/**
 * Get a pipeline run by its ID. Returns undefined if not found.
 */
export function getPipelineRunById(
  db: BetterSqlite3Database,
  id: string,
): PipelineRun | undefined {
  const stmt = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?')
  return stmt.get(id) as PipelineRun | undefined
}

/**
 * Update a pipeline run's config_json field.
 */
export function updatePipelineRunConfig(
  db: BetterSqlite3Database,
  id: string,
  configJson: string,
): void {
  const stmt = db.prepare(
    "UPDATE pipeline_runs SET config_json = ?, updated_at = datetime('now') WHERE id = ?",
  )
  stmt.run(configJson, id)
}

// ---------------------------------------------------------------------------
// Pipeline run queries
// ---------------------------------------------------------------------------

/**
 * Create a new pipeline run with status = 'running'.
 */
export function createPipelineRun(
  db: BetterSqlite3Database,
  input: CreatePipelineRunInput,
): PipelineRun {
  const validated = CreatePipelineRunInputSchema.parse(input)
  const id = crypto.randomUUID()

  const stmt = db.prepare(`
    INSERT INTO pipeline_runs (id, methodology, current_phase, status, config_json)
    VALUES (?, ?, ?, 'running', ?)
  `)
  stmt.run(
    id,
    validated.methodology,
    validated.start_phase ?? null,
    validated.config_json ?? null,
  )

  const row = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as PipelineRun
  return row
}

/**
 * Update a pipeline run's current_phase, status, and/or token_usage_json.
 */
export function updatePipelineRun(
  db: BetterSqlite3Database,
  id: string,
  updates: Partial<Pick<PipelineRun, 'current_phase' | 'status' | 'token_usage_json'>>,
): void {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.current_phase !== undefined) {
    setClauses.push('current_phase = ?')
    values.push(updates.current_phase)
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?')
    values.push(updates.status)
  }
  if (updates.token_usage_json !== undefined) {
    setClauses.push('token_usage_json = ?')
    values.push(updates.token_usage_json)
  }

  if (setClauses.length === 0) return

  setClauses.push("updated_at = datetime('now')")
  values.push(id)

  const stmt = db.prepare(`UPDATE pipeline_runs SET ${setClauses.join(', ')} WHERE id = ?`)
  stmt.run(...values)
}

/**
 * Get the most recently created pipeline run. Returns undefined if none found.
 */
export function getLatestRun(db: BetterSqlite3Database): PipelineRun | undefined {
  const stmt = db.prepare(
    'SELECT * FROM pipeline_runs ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )
  return stmt.get() as PipelineRun | undefined
}

// ---------------------------------------------------------------------------
// Token usage queries
// ---------------------------------------------------------------------------

/**
 * Append a token usage record for a pipeline run.
 */
export function addTokenUsage(
  db: BetterSqlite3Database,
  runId: string,
  usage: AddTokenUsageInput,
): void {
  const validated = AddTokenUsageInputSchema.parse(usage)

  const stmt = db.prepare(`
    INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    runId,
    validated.phase,
    validated.agent,
    validated.input_tokens,
    validated.output_tokens,
    validated.cost_usd,
    validated.metadata ?? null,
  )
}

// ---------------------------------------------------------------------------
// Token usage summary type
// ---------------------------------------------------------------------------

export interface TokenUsageSummary {
  phase: string
  agent: string
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
}

/**
 * Aggregate token usage by phase and agent for a given pipeline run.
 */
export function getTokenUsageSummary(
  db: BetterSqlite3Database,
  runId: string,
): TokenUsageSummary[] {
  const stmt = db.prepare(`
    SELECT
      phase,
      agent,
      SUM(input_tokens)  AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      SUM(cost_usd)      AS total_cost_usd
    FROM token_usage
    WHERE pipeline_run_id = ?
    GROUP BY phase, agent
    ORDER BY phase ASC, agent ASC
  `)
  return stmt.all(runId) as TokenUsageSummary[]
}
