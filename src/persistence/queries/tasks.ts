/**
 * Task query functions for the SQLite persistence layer.
 *
 * All functions accept a raw BetterSqlite3 database instance and use
 * prepared statements — no string interpolation, no ORM.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Task type
// ---------------------------------------------------------------------------

export interface Task {
  id: string
  session_id: string
  name: string
  description?: string | null
  prompt: string
  status: string
  agent?: string | null
  model?: string | null
  billing_mode?: string | null
  worktree_path?: string | null
  worktree_branch?: string | null
  worker_id?: string | null
  budget_usd?: number | null
  cost_usd: number
  input_tokens: number
  output_tokens: number
  result?: string | null
  error?: string | null
  exit_code?: number | null
  retry_count: number
  max_retries: number
  timeout_ms?: number | null
  task_type?: string | null
  metadata?: string | null
  started_at?: string | null
  completed_at?: string | null
  created_at: string
  updated_at: string
}

export type CreateTaskInput = Omit<Task, 'cost_usd' | 'input_tokens' | 'output_tokens' | 'retry_count' | 'max_retries' | 'created_at' | 'updated_at'> & {
  cost_usd?: number
  input_tokens?: number
  output_tokens?: number
  retry_count?: number
  max_retries?: number
}

export interface UpdateTaskStatusExtra {
  result?: string | null
  error?: string | null
  exit_code?: number | null
  started_at?: string | null
  completed_at?: string | null
  cost_usd?: number
  input_tokens?: number
  output_tokens?: number
  worker_id?: string | null
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Insert a new task record.
 */
export function createTask(db: BetterSqlite3Database, task: CreateTaskInput): void {
  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, session_id, name, description, prompt, status, agent, model,
      billing_mode, worktree_path, worktree_branch, worker_id, budget_usd,
      cost_usd, input_tokens, output_tokens, result, error, exit_code,
      retry_count, max_retries, timeout_ms, task_type, metadata,
      started_at, completed_at
    ) VALUES (
      @id, @session_id, @name, @description, @prompt, @status, @agent, @model,
      @billing_mode, @worktree_path, @worktree_branch, @worker_id, @budget_usd,
      @cost_usd, @input_tokens, @output_tokens, @result, @error, @exit_code,
      @retry_count, @max_retries, @timeout_ms, @task_type, @metadata,
      @started_at, @completed_at
    )
  `)

  stmt.run({
    cost_usd: 0.0,
    input_tokens: 0,
    output_tokens: 0,
    retry_count: 0,
    max_retries: 2,
    description: null,
    agent: null,
    model: null,
    billing_mode: null,
    worktree_path: null,
    worktree_branch: null,
    worker_id: null,
    budget_usd: null,
    result: null,
    error: null,
    exit_code: null,
    timeout_ms: null,
    task_type: null,
    metadata: null,
    started_at: null,
    completed_at: null,
    ...task,
  })
}

/**
 * Retrieve a task by its id. Returns undefined if not found.
 */
export function getTask(db: BetterSqlite3Database, taskId: string): Task | undefined {
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?')
  return stmt.get(taskId) as Task | undefined
}

/**
 * Retrieve all tasks for a session with a given status.
 */
export function getTasksByStatus(
  db: BetterSqlite3Database,
  sessionId: string,
  status: string,
): Task[] {
  const stmt = db.prepare('SELECT * FROM tasks WHERE session_id = ? AND status = ? ORDER BY created_at ASC')
  return stmt.all(sessionId, status) as Task[]
}

/**
 * Retrieve tasks that are ready to execute (from the ready_tasks view),
 * filtered to a specific session.
 */
export function getReadyTasks(db: BetterSqlite3Database, sessionId: string): Task[] {
  const stmt = db.prepare('SELECT * FROM ready_tasks WHERE session_id = ? ORDER BY created_at ASC')
  return stmt.all(sessionId) as Task[]
}

/**
 * Retrieve all tasks for a session, ordered by creation time.
 */
export function getAllTasks(db: BetterSqlite3Database, sessionId: string): Task[] {
  const stmt = db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC')
  return stmt.all(sessionId) as Task[]
}

/**
 * Update a task's status and optionally set additional fields.
 */
export function updateTaskStatus(
  db: BetterSqlite3Database,
  taskId: string,
  status: string,
  extra: UpdateTaskStatusExtra = {},
): void {
  const fields: string[] = ['status = @status', "updated_at = datetime('now')"]
  const params: Record<string, unknown> = { taskId, status }

  if (extra.result !== undefined) { fields.push('result = @result'); params.result = extra.result }
  if (extra.error !== undefined) { fields.push('error = @error'); params.error = extra.error }
  if (extra.exit_code !== undefined) { fields.push('exit_code = @exit_code'); params.exit_code = extra.exit_code }
  if (extra.started_at !== undefined) { fields.push('started_at = @started_at'); params.started_at = extra.started_at }
  if (extra.completed_at !== undefined) { fields.push('completed_at = @completed_at'); params.completed_at = extra.completed_at }
  if (extra.cost_usd !== undefined) { fields.push('cost_usd = @cost_usd'); params.cost_usd = extra.cost_usd }
  if (extra.input_tokens !== undefined) { fields.push('input_tokens = @input_tokens'); params.input_tokens = extra.input_tokens }
  if (extra.output_tokens !== undefined) { fields.push('output_tokens = @output_tokens'); params.output_tokens = extra.output_tokens }
  if (extra.worker_id !== undefined) { fields.push('worker_id = @worker_id'); params.worker_id = extra.worker_id }

  const stmt = db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = @taskId`)
  const result = stmt.run(params)
  if (result.changes === 0) {
    throw new Error(`Task "${taskId}" not found`)
  }
}
