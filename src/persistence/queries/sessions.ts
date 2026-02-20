/**
 * Session query functions for the SQLite persistence layer.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Session type
// ---------------------------------------------------------------------------

export interface Session {
  id: string
  name?: string | null
  graph_file: string
  status: string
  budget_usd?: number | null
  total_cost_usd: number
  planning_cost_usd: number
  config_snapshot?: string | null
  base_branch: string
  plan_source?: string | null
  planning_agent?: string | null
  created_at: string
  updated_at: string
}

export type CreateSessionInput = Omit<Session, 'total_cost_usd' | 'planning_cost_usd' | 'base_branch' | 'created_at' | 'updated_at'> & {
  total_cost_usd?: number
  planning_cost_usd?: number
  base_branch?: string
}

export type UpdateSessionInput = Partial<Omit<Session, 'id' | 'created_at' | 'updated_at'>>

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Insert a new session record.
 */
export function createSession(db: BetterSqlite3Database, session: CreateSessionInput): void {
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, name, graph_file, status, budget_usd, total_cost_usd,
      planning_cost_usd, config_snapshot, base_branch, plan_source, planning_agent
    ) VALUES (
      @id, @name, @graph_file, @status, @budget_usd, @total_cost_usd,
      @planning_cost_usd, @config_snapshot, @base_branch, @plan_source, @planning_agent
    )
  `)

  stmt.run({
    total_cost_usd: 0.0,
    planning_cost_usd: 0.0,
    base_branch: 'main',
    name: null,
    budget_usd: null,
    config_snapshot: null,
    plan_source: null,
    planning_agent: null,
    ...session,
  })
}

/**
 * Retrieve a session by its id. Returns undefined if not found.
 */
export function getSession(db: BetterSqlite3Database, sessionId: string): Session | undefined {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?')
  return stmt.get(sessionId) as Session | undefined
}

/**
 * Update session fields. Only provided fields are updated.
 */
export function updateSession(
  db: BetterSqlite3Database,
  sessionId: string,
  updates: UpdateSessionInput,
): void {
  const fields: string[] = ["updated_at = datetime('now')"]
  const params: Record<string, unknown> = { sessionId }

  const allowedKeys: Array<keyof UpdateSessionInput> = [
    'name', 'graph_file', 'status', 'budget_usd', 'total_cost_usd',
    'planning_cost_usd', 'config_snapshot', 'base_branch', 'plan_source', 'planning_agent',
  ]

  for (const key of allowedKeys) {
    if (key in updates) {
      fields.push(`${key} = @${key}`)
      params[key] = updates[key]
    }
  }

  const stmt = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @sessionId`)
  stmt.run(params)
}

/**
 * List all sessions ordered by creation date descending.
 */
export function listSessions(db: BetterSqlite3Database): Session[] {
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC')
  return stmt.all() as Session[]
}
