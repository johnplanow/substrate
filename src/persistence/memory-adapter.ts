/**
 * InMemoryDatabaseAdapter — satisfies the DatabaseAdapter interface using
 * plain in-memory Maps and arrays.  Designed for CI environments and unit
 * tests where no external database is available.
 *
 * SQL support is intentionally limited to the patterns used by
 * `src/persistence/queries/`:
 *   - CREATE TABLE [IF NOT EXISTS] name (col type, ...)
 *   - DROP TABLE [IF EXISTS] name
 *   - INSERT INTO name (cols) VALUES (vals)
 *   - SELECT * / cols FROM name [WHERE simple-conditions]
 *   - SELECT literal-expressions (no FROM clause)
 *   - UPDATE name SET col = val [WHERE simple-conditions]
 *   - DELETE FROM name [WHERE simple-conditions]
 *
 * WHERE clauses support simple equality conditions joined by AND.
 * Transactions use a snapshot-and-restore pattern.
 */

import type { DatabaseAdapter } from './adapter.js'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// InMemoryDatabaseAdapter
// ---------------------------------------------------------------------------

export class InMemoryDatabaseAdapter implements DatabaseAdapter {
  private _tables = new Map<string, Row[]>()

  // -------------------------------------------------------------------------
  // DatabaseAdapter implementation
  // -------------------------------------------------------------------------

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const rows = this._execute(sql.trim(), params)
    return rows as T[]
  }

  async exec(sql: string): Promise<void> {
    this._execute(sql.trim(), undefined)
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    // Snapshot: deep-clone each table's rows
    const snapshot = new Map<string, Row[]>()
    for (const [name, rows] of this._tables) {
      snapshot.set(name, rows.map((r) => ({ ...r })))
    }

    try {
      const result = await fn(this)
      return result
    } catch (err) {
      // Restore snapshot on failure
      this._tables = snapshot
      throw err
    }
  }

  async close(): Promise<void> {
    this._tables.clear()
  }

  // -------------------------------------------------------------------------
  // SQL execution dispatcher
  // -------------------------------------------------------------------------

  private _execute(sql: string, params: unknown[] | undefined): Row[] {
    const resolved = this._substituteParams(sql, params)
    const upper = resolved.trimStart().toUpperCase()

    if (/^CREATE\s+TABLE/i.test(upper)) {
      return this._createTable(resolved)
    }
    if (/^DROP\s+TABLE/i.test(upper)) {
      return this._dropTable(resolved)
    }
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i.test(upper)) {
      // VIEWs are not supported in InMemoryDatabaseAdapter — treat as no-op.
      return []
    }
    if (/^INSERT\s+(?:IGNORE\s+)?INTO/i.test(upper)) {
      return this._insert(resolved, /^INSERT\s+IGNORE\s+INTO/i.test(upper))
    }
    if (/^SELECT/i.test(upper)) {
      return this._select(resolved)
    }
    if (/^UPDATE/i.test(upper)) {
      return this._update(resolved)
    }
    if (/^DELETE\s+FROM/i.test(upper)) {
      return this._delete(resolved)
    }

    // Unknown statement — silently ignore (BEGIN, COMMIT, ROLLBACK, pragmas, etc.)
    return []
  }

  // -------------------------------------------------------------------------
  // Parameter substitution
  // -------------------------------------------------------------------------

  /**
   * Replace each `?` placeholder with an escaped literal value.
   */
  private _substituteParams(sql: string, params: unknown[] | undefined): string {
    if (!params || params.length === 0) return sql
    let idx = 0
    return sql.replace(/\?/g, () => {
      const val = params[idx++]
      if (val === null || val === undefined) return 'NULL'
      if (typeof val === 'number') return String(val)
      if (typeof val === 'boolean') return val ? '1' : '0'
      return `'${String(val).replace(/'/g, "''")}'`
    })
  }

  // -------------------------------------------------------------------------
  // CREATE TABLE
  // -------------------------------------------------------------------------

  private _createTable(sql: string): Row[] {
    // CREATE TABLE [IF NOT EXISTS] tableName (...)
    const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(sql)
    if (m) {
      const name = m[1]!
      if (!this._tables.has(name)) {
        this._tables.set(name, [])
      }
    }
    return []
  }

  // -------------------------------------------------------------------------
  // DROP TABLE
  // -------------------------------------------------------------------------

  private _dropTable(sql: string): Row[] {
    const m = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i.exec(sql)
    if (m) {
      this._tables.delete(m[1]!)
    }
    return []
  }

  // -------------------------------------------------------------------------
  // INSERT
  // -------------------------------------------------------------------------

  private _insert(sql: string, _ignoreConflicts = false): Row[] {
    // INSERT INTO tableName (col1, col2, ...) VALUES (val1, val2, ...)
    const m = /INSERT\s+(?:IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*$/is.exec(sql)
    if (!m) return []

    const tableName = m[1]!
    const cols = m[2]!.split(',').map((c) => c.trim())
    const valStr = m[3]!
    const vals = this._parseValueList(valStr)

    const row: Row = {}
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]!] = vals[i] ?? null
    }

    if (!this._tables.has(tableName)) {
      this._tables.set(tableName, [])
    }
    this._tables.get(tableName)!.push(row)

    return []
  }

  // -------------------------------------------------------------------------
  // SELECT
  // -------------------------------------------------------------------------

  private _select(sql: string): Row[] {
    // SELECT without FROM: evaluate literal expressions
    if (!/FROM/i.test(sql)) {
      const m = /SELECT\s+(.+)$/is.exec(sql)
      if (!m) return []
      return [this._evalSelectExprs(m[1]!.trim())]
    }

    // SELECT cols FROM tableName [WHERE ...]
    const m = /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is.exec(sql)
    if (!m) return []

    const colsStr = m[1]!.trim()
    const tableName = m[2]!
    const whereStr = m[3]

    const table = this._tables.get(tableName) ?? []
    let rows = table.map((r) => ({ ...r }))

    if (whereStr) {
      rows = rows.filter((row) => this._matchWhere(whereStr.trim(), row))
    }

    if (colsStr === '*') {
      return rows
    }

    // Project specific columns
    return rows.map((row) => this._projectCols(colsStr, row))
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  private _update(sql: string): Row[] {
    // UPDATE tableName SET col1 = val1, col2 = val2 [WHERE ...]
    const m = /UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/is.exec(sql)
    if (!m) return []

    const tableName = m[1]!
    const setStr = m[2]!
    const whereStr = m[3]

    const table = this._tables.get(tableName)
    if (!table) return []

    const assignments = this._parseAssignments(setStr)

    for (const row of table) {
      if (!whereStr || this._matchWhere(whereStr.trim(), row)) {
        for (const [col, val] of assignments) {
          row[col] = val
        }
      }
    }

    return []
  }

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  private _delete(sql: string): Row[] {
    // DELETE FROM tableName [WHERE ...]
    const m = /DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is.exec(sql)
    if (!m) return []

    const tableName = m[1]!
    const whereStr = m[2]

    const table = this._tables.get(tableName)
    if (!table) return []

    if (!whereStr) {
      this._tables.set(tableName, [])
      return []
    }

    const kept = table.filter((row) => !this._matchWhere(whereStr.trim(), row))
    this._tables.set(tableName, kept)

    return []
  }

  // -------------------------------------------------------------------------
  // Helpers: WHERE evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate a simple WHERE clause against a row.
   * Supports: `col = val` conditions joined by AND.
   */
  private _matchWhere(whereClause: string, row: Row): boolean {
    // Split by AND (simple case — no OR, no nested parens)
    const conditions = whereClause.split(/\s+AND\s+/i)

    for (const condition of conditions) {
      const trimmed = condition.trim()

      // col = 'string literal'
      const strM = /^(\w+)\s*=\s*'(.*)'$/is.exec(trimmed)
      if (strM) {
        const colVal = String(row[strM[1]!] ?? '')
        const literal = strM[2]!.replace(/''/g, "'")
        if (colVal !== literal) return false
        continue
      }

      // col = numeric literal
      const numM = /^(\w+)\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed)
      if (numM) {
        if (Number(row[numM[1]!]) !== parseFloat(numM[2]!)) return false
        continue
      }

      // col IS NULL
      const nullM = /^(\w+)\s+IS\s+NULL$/i.exec(trimmed)
      if (nullM) {
        if (row[nullM[1]!] !== null && row[nullM[1]!] !== undefined) return false
        continue
      }

      // col IS NOT NULL
      const notNullM = /^(\w+)\s+IS\s+NOT\s+NULL$/i.exec(trimmed)
      if (notNullM) {
        if (row[notNullM[1]!] === null || row[notNullM[1]!] === undefined) return false
        continue
      }

      // Unrecognised condition: skip (treat as matching)
    }

    return true
  }

  // -------------------------------------------------------------------------
  // Helpers: column projection
  // -------------------------------------------------------------------------

  private _projectCols(colsStr: string, row: Row): Row {
    const result: Row = {}
    // Split by comma (simple — assumes no commas inside function calls)
    const cols = colsStr.split(',').map((c) => c.trim())
    for (const col of cols) {
      // Handle "expr AS alias" or plain "col"
      const aliasM = /^(.+?)\s+AS\s+(\w+)$/i.exec(col)
      if (aliasM) {
        result[aliasM[2]!] = this._evalExprAgainstRow(aliasM[1]!.trim(), row)
      } else {
        result[col] = row[col]
      }
    }
    return result
  }

  // -------------------------------------------------------------------------
  // Helpers: literal expression evaluation (for SELECT without FROM)
  // -------------------------------------------------------------------------

  private _evalSelectExprs(exprs: string): Row {
    const result: Row = {}
    const parts = exprs.split(',').map((p) => p.trim())
    for (const part of parts) {
      const aliasM = /^(.+?)\s+AS\s+(\w+)$/i.exec(part)
      if (aliasM) {
        result[aliasM[2]!] = this._evalLiteral(aliasM[1]!.trim())
      } else {
        result[part] = this._evalLiteral(part)
      }
    }
    return result
  }

  private _evalLiteral(expr: string): unknown {
    const trimmed = expr.trim()
    if (trimmed.toUpperCase() === 'NULL') return null
    if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'")
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10)
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed)
    return trimmed
  }

  private _evalExprAgainstRow(expr: string, row: Row): unknown {
    // Try literal first, then column name lookup
    const literal = this._evalLiteral(expr)
    if (typeof literal !== 'string') return literal
    // If it looks like an identifier (word chars only) and exists in row, use it
    if (/^\w+$/.test(expr) && expr in row) return row[expr]
    return literal
  }

  // -------------------------------------------------------------------------
  // Helpers: value list parsing
  // -------------------------------------------------------------------------

  /**
   * Parse a comma-separated list of SQL literal values.
   * Handles: NULL, numbers, single-quoted strings.
   * Simple split by comma (assumes no commas inside string values).
   */
  private _parseValueList(valStr: string): unknown[] {
    // Tokenise respecting single-quoted strings
    const tokens: string[] = []
    let current = ''
    let inStr = false

    for (let i = 0; i < valStr.length; i++) {
      const ch = valStr[i]!
      if (ch === "'" && !inStr) {
        inStr = true
        current += ch
      } else if (ch === "'" && inStr) {
        // Peek ahead for escaped quote ('')
        if (valStr[i + 1] === "'") {
          current += "''"
          i++
        } else {
          inStr = false
          current += ch
        }
      } else if (ch === ',' && !inStr) {
        tokens.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim() !== '') tokens.push(current.trim())

    return tokens.map((t) => this._evalLiteral(t))
  }

  // -------------------------------------------------------------------------
  // Helpers: SET clause parsing
  // -------------------------------------------------------------------------

  /**
   * Parse `col1 = val1, col2 = val2` assignments into an array of [col, val] pairs.
   */
  private _parseAssignments(setStr: string): [string, unknown][] {
    const assignments: [string, unknown][] = []
    // Tokenise respecting single-quoted strings (same approach as _parseValueList)
    const parts: string[] = []
    let current = ''
    let inStr = false

    for (let i = 0; i < setStr.length; i++) {
      const ch = setStr[i]!
      if (ch === "'" && !inStr) {
        inStr = true
        current += ch
      } else if (ch === "'" && inStr) {
        if (setStr[i + 1] === "'") {
          current += "''"
          i++
        } else {
          inStr = false
          current += ch
        }
      } else if (ch === ',' && !inStr) {
        parts.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim() !== '') parts.push(current.trim())

    for (const part of parts) {
      const eqIdx = part.indexOf('=')
      if (eqIdx === -1) continue
      const col = part.slice(0, eqIdx).trim()
      const valStr = part.slice(eqIdx + 1).trim()
      assignments.push([col, this._evalLiteral(valStr)])
    }

    return assignments
  }
}
