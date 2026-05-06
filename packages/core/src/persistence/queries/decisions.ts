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
import {
  CreateDecisionInputSchema,
  CreateRequirementInputSchema,
  CreateConstraintInputSchema,
  RegisterArtifactInputSchema,
  CreatePipelineRunInputSchema,
  AddTokenUsageInputSchema,
} from '../schemas/decisions.js'
import { LEARNING_FINDING } from '../schemas/operational.js'
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
 * Insert or update a decision record.
 * If a decision with the same pipeline_run_id, category, and key already exists,
 * update its value and rationale. Otherwise, insert a new record.
 */
export async function upsertDecision(adapter: DatabaseAdapter, input: CreateDecisionInput): Promise<Decision> {
  const validated = CreateDecisionInputSchema.parse(input)

  // Check for existing decision with same pipeline_run_id + category + key
  const rows = await adapter.query<Decision>(
    'SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = ? AND `key` = ? LIMIT 1',
    [validated.pipeline_run_id ?? null, validated.category, validated.key],
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
// Finding queries (Story 74-2 — verification → learning feedback bridge)
// ---------------------------------------------------------------------------

/**
 * Structural shape required by `appendFinding`.
 *
 * Mirrors the @substrate-ai/sdlc `Finding` interface (root cause taxonomy from
 * Story 53-5) but is defined locally so that core never imports sdlc — that
 * direction would create a package cycle.
 *
 * Findings are persisted as JSON-serialized rows in the `decisions` table under
 * `category = LEARNING_FINDING ('finding')`, the same shape `FindingsInjector`
 * already reads via `getDecisionsByCategory`.
 */
export interface AppendFindingInput {
  /** Stable UUID — generated when omitted. */
  id?: string
  /** Pipeline run that produced the finding. */
  run_id: string
  /** Story key the finding belongs to. */
  story_key: string
  /** Root-cause category (must match the consumer's enum). */
  root_cause: string
  /** Files implicated by the finding (used by relevance scoring). */
  affected_files: string[]
  /** Human-readable summary surfaced in retry prompts. */
  description: string
  /** 'high' for static-analysis-derived findings; 'low' for heuristics. */
  confidence: 'high' | 'low'
  /** ISO timestamp — generated when omitted. */
  created_at?: string
  /** TTL in pipeline-run hops; defaults to 5 (mirrors Finding default). */
  expires_after_runs?: number
}

/**
 * Append a learning Finding to the existing `decisions` table using the
 * `LEARNING_FINDING` category. Reuses the same row layout that
 * `FindingsInjector` queries via `getDecisionsByCategory`, so verification-
 * generated findings appear automatically alongside classifier-generated ones.
 *
 * Adapter pattern mirrors `createDecision` and `addTokenUsage` in this file.
 */
export async function appendFinding(
  adapter: DatabaseAdapter,
  finding: AppendFindingInput,
): Promise<void> {
  const findingId = finding.id ?? crypto.randomUUID()
  const createdAt = finding.created_at ?? new Date().toISOString()
  const expiresAfterRuns = finding.expires_after_runs ?? 5

  const fullFinding = {
    id: findingId,
    run_id: finding.run_id,
    story_key: finding.story_key,
    root_cause: finding.root_cause,
    affected_files: finding.affected_files,
    description: finding.description,
    confidence: finding.confidence,
    created_at: createdAt,
    expires_after_runs: expiresAfterRuns,
  }

  await adapter.query(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, \`key\`, value, rationale)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      finding.run_id,
      'implementation',
      LEARNING_FINDING,
      `${finding.story_key}:${finding.run_id}`,
      JSON.stringify(fullFinding),
      null,
    ],
  )
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
