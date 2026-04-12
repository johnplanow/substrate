/**
 * Decision store query functions for the persistence layer.
 *
 * Provides CRUD operations for the decision store tables:
 * decisions, requirements, constraints, artifacts, pipeline_runs, token_usage.
 *
 * All functions are async and accept a DatabaseAdapter, making them
 * compatible with both the SqliteDatabaseAdapter and DoltDatabaseAdapter.
 */

import type { DatabaseAdapter } from '../types.js'
import { isUniqueConstraintViolation } from '../upsert-errors.js'
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

// ---------------------------------------------------------------------------
// Decision queries
// ---------------------------------------------------------------------------

/**
 * Insert a new decision record with a generated UUID.
 */
export async function createDecision(adapter: DatabaseAdapter, input: CreateDecisionInput): Promise<Decision> {
  const validated = CreateDecisionInputSchema.parse(input)
  const id = crypto.randomUUID()

  await adapter.query(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, \`key\`, value, rationale)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      validated.pipeline_run_id ?? null,
      validated.phase,
      validated.category,
      validated.key,
      validated.value,
      validated.rationale ?? null,
    ],
  )

  const rows = await adapter.query<Decision>('SELECT * FROM decisions WHERE id = ?', [id])
  return rows[0]!
}

/**
 * Insert or update a decision record, keyed on
 * `(pipeline_run_id, category, key)`.
 *
 * G10: Uses an atomic INSERT-catch-UPDATE pattern backed by the
 * `uniq_decisions_composite` UNIQUE index. Pre-G10 this was a
 * SELECT-then-write pattern that raced under concurrent writers:
 * two callers could both SELECT empty and both INSERT, producing
 * duplicate rows that violated the upsert contract. The schema-level
 * constraint now rejects the duplicate INSERT, and this function catches
 * the violation and recovers via UPDATE — last-writer-wins semantics
 * preserved, no duplicate rows possible.
 *
 * The `pipeline_run_id IS NULL` branch retains the legacy SELECT-first
 * path because standard SQL treats NULLs as distinct in UNIQUE indexes,
 * so the DB-level constraint cannot help orphan captures. The null-run
 * usage is lower-concurrency in practice (see deferred-work G10).
 */
export async function upsertDecision(adapter: DatabaseAdapter, input: CreateDecisionInput): Promise<Decision> {
  const validated = CreateDecisionInputSchema.parse(input)

  if (validated.pipeline_run_id == null) {
    // Null run_id: UNIQUE index treats NULLs as distinct, so the
    // constraint does not fire. Fall back to application-level dedup
    // via SELECT-then-write (same as pre-G10).
    const rows = await adapter.query<Decision>(
      'SELECT * FROM decisions WHERE pipeline_run_id IS NULL AND category = ? AND `key` = ? LIMIT 1',
      [validated.category, validated.key],
    )
    const existing = rows[0]
    if (existing) {
      await updateDecision(adapter, existing.id, {
        value: validated.value,
        rationale: validated.rationale ?? undefined,
      })
      const updated = await adapter.query<Decision>('SELECT * FROM decisions WHERE id = ?', [existing.id])
      return updated[0]!
    }
    return createDecision(adapter, input)
  }

  // Non-null run_id: atomic INSERT-catch-UPDATE. The UNIQUE index backing
  // (pipeline_run_id, category, `key`) rejects duplicate INSERTs, so a
  // concurrent writer that lost the race catches the violation and
  // recovers via UPDATE without producing a second row.
  const id = crypto.randomUUID()
  try {
    await adapter.query(
      `INSERT INTO decisions (id, pipeline_run_id, phase, category, \`key\`, value, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        validated.pipeline_run_id,
        validated.phase,
        validated.category,
        validated.key,
        validated.value,
        validated.rationale ?? null,
      ],
    )
    const [row] = await adapter.query<Decision>('SELECT * FROM decisions WHERE id = ?', [id])
    return row!
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err
    // A row with the same composite key already exists. UPDATE it by
    // composite key (the UPDATE is a single atomic statement at the
    // adapter level — no read-modify-write race).
    await adapter.query(
      `UPDATE decisions SET value = ?, rationale = ?, updated_at = ?
       WHERE pipeline_run_id = ? AND category = ? AND \`key\` = ?`,
      [
        validated.value,
        validated.rationale ?? null,
        new Date().toISOString(),
        validated.pipeline_run_id,
        validated.category,
        validated.key,
      ],
    )
    const [row] = await adapter.query<Decision>(
      'SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = ? AND `key` = ? LIMIT 1',
      [validated.pipeline_run_id, validated.category, validated.key],
    )
    return row!
  }
}

/**
 * Get all decisions for a given phase, ordered by created_at ascending.
 */
export async function getDecisionsByPhase(adapter: DatabaseAdapter, phase: string): Promise<Decision[]> {
  return adapter.query<Decision>(
    'SELECT * FROM decisions WHERE phase = ? ORDER BY created_at ASC',
    [phase],
  )
}

/**
 * Get all decisions for a given phase scoped to a specific pipeline run,
 * ordered by created_at ascending.
 */
export async function getDecisionsByPhaseForRun(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
): Promise<Decision[]> {
  return adapter.query<Decision>(
    'SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = ? ORDER BY created_at ASC',
    [runId, phase],
  )
}

/**
 * Get all decisions for a given category, ordered by created_at ascending.
 */
export async function getDecisionsByCategory(adapter: DatabaseAdapter, category: string): Promise<Decision[]> {
  return adapter.query<Decision>(
    'SELECT * FROM decisions WHERE category = ? ORDER BY created_at ASC',
    [category],
  )
}

/**
 * Get a single decision by phase and key. Returns undefined if not found.
 */
export async function getDecisionByKey(
  adapter: DatabaseAdapter,
  phase: string,
  key: string,
): Promise<Decision | undefined> {
  const rows = await adapter.query<Decision>(
    'SELECT * FROM decisions WHERE phase = ? AND `key` = ? LIMIT 1',
    [phase, key],
  )
  return rows[0]
}

/**
 * Update a decision's value and/or rationale and set updated_at.
 */
export async function updateDecision(
  adapter: DatabaseAdapter,
  id: string,
  updates: Partial<Pick<Decision, 'value' | 'rationale'>>,
): Promise<void> {
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

  setClauses.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  await adapter.query(`UPDATE decisions SET ${setClauses.join(', ')} WHERE id = ?`, values)
}

// ---------------------------------------------------------------------------
// Requirement queries
// ---------------------------------------------------------------------------

/**
 * Insert a new requirement with status = 'active'.
 */
export async function createRequirement(
  adapter: DatabaseAdapter,
  input: CreateRequirementInput,
): Promise<Requirement> {
  const validated = CreateRequirementInputSchema.parse(input)
  const id = crypto.randomUUID()

  await adapter.query(
    `INSERT INTO requirements (id, pipeline_run_id, source, type, description, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    [
      id,
      validated.pipeline_run_id ?? null,
      validated.source,
      validated.type,
      validated.description,
      validated.priority,
    ],
  )

  const rows = await adapter.query<Requirement>('SELECT * FROM requirements WHERE id = ?', [id])
  return rows[0]!
}

/**
 * List requirements with optional filtering by type, priority, and status.
 */
export async function listRequirements(
  adapter: DatabaseAdapter,
  filters?: { type?: string; priority?: string; status?: string },
): Promise<Requirement[]> {
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
  return adapter.query<Requirement>(
    `SELECT * FROM requirements ${where} ORDER BY created_at ASC`,
    values,
  )
}

/**
 * Transition a requirement's status.
 */
export async function updateRequirementStatus(
  adapter: DatabaseAdapter,
  id: string,
  status: string,
): Promise<void> {
  await adapter.query('UPDATE requirements SET status = ? WHERE id = ?', [status, id])
}

// ---------------------------------------------------------------------------
// Constraint queries
// ---------------------------------------------------------------------------

/**
 * Insert a new constraint record.
 */
export async function createConstraint(
  adapter: DatabaseAdapter,
  input: CreateConstraintInput,
): Promise<Constraint> {
  const validated = CreateConstraintInputSchema.parse(input)
  const id = crypto.randomUUID()

  await adapter.query(
    `INSERT INTO constraints (id, pipeline_run_id, category, description, source)
     VALUES (?, ?, ?, ?, ?)`,
    [
      id,
      validated.pipeline_run_id ?? null,
      validated.category,
      validated.description,
      validated.source,
    ],
  )

  const rows = await adapter.query<Constraint>('SELECT * FROM constraints WHERE id = ?', [id])
  return rows[0]!
}

/**
 * List constraints with optional category filtering.
 */
export async function listConstraints(
  adapter: DatabaseAdapter,
  filters?: { category?: string },
): Promise<Constraint[]> {
  if (filters?.category !== undefined) {
    return adapter.query<Constraint>(
      'SELECT * FROM constraints WHERE category = ? ORDER BY created_at ASC',
      [filters.category],
    )
  }
  return adapter.query<Constraint>('SELECT * FROM constraints ORDER BY created_at ASC')
}

// ---------------------------------------------------------------------------
// Artifact queries
// ---------------------------------------------------------------------------

/**
 * Register a new artifact record.
 */
export async function registerArtifact(
  adapter: DatabaseAdapter,
  input: RegisterArtifactInput,
): Promise<Artifact> {
  const validated = RegisterArtifactInputSchema.parse(input)
  const id = crypto.randomUUID()

  await adapter.query(
    `INSERT INTO artifacts (id, pipeline_run_id, phase, type, path, content_hash, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      validated.pipeline_run_id ?? null,
      validated.phase,
      validated.type,
      validated.path,
      validated.content_hash ?? null,
      validated.summary ?? null,
    ],
  )

  const rows = await adapter.query<Artifact>('SELECT * FROM artifacts WHERE id = ?', [id])
  return rows[0]!
}

/**
 * Get all artifacts for a given phase, ordered by created_at ascending.
 */
export async function getArtifactsByPhase(adapter: DatabaseAdapter, phase: string): Promise<Artifact[]> {
  return adapter.query<Artifact>(
    'SELECT * FROM artifacts WHERE phase = ? ORDER BY created_at ASC',
    [phase],
  )
}

/**
 * Get the latest artifact of a given type for a given phase.
 * Returns undefined if none found.
 */
export async function getArtifactByType(
  adapter: DatabaseAdapter,
  phase: string,
  type: string,
): Promise<Artifact | undefined> {
  const rows = await adapter.query<Artifact>(
    'SELECT * FROM artifacts WHERE phase = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [phase, type],
  )
  return rows[0]
}

/**
 * Get the latest artifact of a given type for a specific pipeline run.
 * Filters by pipeline_run_id, phase, and type.
 * Returns undefined if none found.
 */
export async function getArtifactByTypeForRun(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
  type: string,
): Promise<Artifact | undefined> {
  const rows = await adapter.query<Artifact>(
    'SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [runId, phase, type],
  )
  return rows[0]
}

/**
 * Get all artifacts registered for a specific pipeline run, ordered by created_at ascending.
 */
export async function getArtifactsByRun(adapter: DatabaseAdapter, runId: string): Promise<Artifact[]> {
  return adapter.query<Artifact>(
    'SELECT * FROM artifacts WHERE pipeline_run_id = ? ORDER BY created_at ASC',
    [runId],
  )
}

/**
 * Get a pipeline run by its ID. Returns undefined if not found.
 */
export async function getPipelineRunById(
  adapter: DatabaseAdapter,
  id: string,
): Promise<PipelineRun | undefined> {
  const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [id])
  return rows[0]
}

/**
 * Update a pipeline run's config_json field.
 */
export async function updatePipelineRunConfig(
  adapter: DatabaseAdapter,
  id: string,
  configJson: string,
): Promise<void> {
  await adapter.query(
    'UPDATE pipeline_runs SET config_json = ?, updated_at = ? WHERE id = ?',
    [configJson, new Date().toISOString(), id],
  )
}

// ---------------------------------------------------------------------------
// Pipeline run queries
// ---------------------------------------------------------------------------

/**
 * Create a new pipeline run with status = 'running'.
 */
export async function createPipelineRun(
  adapter: DatabaseAdapter,
  input: CreatePipelineRunInput,
): Promise<PipelineRun> {
  const validated = CreatePipelineRunInputSchema.parse(input)
  const id = crypto.randomUUID()
  // Explicitly set timestamps as UTC ISO strings. Dolt's CURRENT_TIMESTAMP
  // returns local time (unlike SQLite which returns UTC), causing
  // parseDbTimestampAsUtc to misinterpret freshly created rows as hours-old
  // when the machine is not in UTC. This fix ensures all timestamps are UTC.
  const nowUtc = new Date().toISOString()

  await adapter.query(
    `INSERT INTO pipeline_runs (id, methodology, current_phase, status, config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    [
      id,
      validated.methodology,
      validated.start_phase ?? null,
      validated.config_json ?? null,
      nowUtc,
      nowUtc,
    ],
  )

  const rows = await adapter.query<PipelineRun>('SELECT * FROM pipeline_runs WHERE id = ?', [id])
  return rows[0]!
}

/**
 * Update a pipeline run's current_phase, status, and/or token_usage_json.
 */
export async function updatePipelineRun(
  adapter: DatabaseAdapter,
  id: string,
  updates: Partial<Pick<PipelineRun, 'current_phase' | 'status' | 'token_usage_json'>>,
): Promise<void> {
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

  setClauses.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  await adapter.query(`UPDATE pipeline_runs SET ${setClauses.join(', ')} WHERE id = ?`, values)
}

/**
 * Get all pipeline runs with status = 'running'.
 */
export async function getRunningPipelineRuns(adapter: DatabaseAdapter): Promise<PipelineRun[]> {
  return adapter.query<PipelineRun>("SELECT * FROM pipeline_runs WHERE status = 'running'")
}

/**
 * Get the most recently created pipeline run. Returns undefined if none found.
 */
export async function getLatestRun(adapter: DatabaseAdapter): Promise<PipelineRun | undefined> {
  const rows = await adapter.query<PipelineRun>(
    'SELECT * FROM pipeline_runs ORDER BY created_at DESC, id DESC LIMIT 1',
  )
  return rows[0]
}

// ---------------------------------------------------------------------------
// Token usage queries
// ---------------------------------------------------------------------------

/**
 * Append a token usage record for a pipeline run.
 */
export async function addTokenUsage(
  adapter: DatabaseAdapter,
  runId: string,
  usage: AddTokenUsageInput,
): Promise<void> {
  const validated = AddTokenUsageInputSchema.parse(usage)

  await adapter.query(
    `INSERT INTO token_usage (pipeline_run_id, phase, agent, input_tokens, output_tokens, cost_usd, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      validated.phase,
      validated.agent,
      validated.input_tokens,
      validated.output_tokens,
      validated.cost_usd,
      validated.metadata ?? null,
    ],
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
export async function getTokenUsageSummary(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<TokenUsageSummary[]> {
  return adapter.query<TokenUsageSummary>(
    `SELECT
      phase,
      agent,
      SUM(input_tokens)  AS total_input_tokens,
      SUM(output_tokens) AS total_output_tokens,
      SUM(cost_usd)      AS total_cost_usd
    FROM token_usage
    WHERE pipeline_run_id = ?
    GROUP BY phase, agent
    ORDER BY phase ASC, agent ASC`,
    [runId],
  )
}
