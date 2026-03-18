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

import type { DatabaseAdapter, SyncAdapter } from './adapter.js'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// InMemoryDatabaseAdapter
// ---------------------------------------------------------------------------

export class InMemoryDatabaseAdapter implements DatabaseAdapter, SyncAdapter {
  private _tables = new Map<string, Row[]>()
  private _indexes: Array<{ name: string; tbl_name: string; type: string }> = []
  /** Maps table name → auto-increment column name */
  private _autoIncrementCols = new Map<string, string>()
  /** Maps table name → last assigned auto-increment value */
  private _autoIncrementCounters = new Map<string, number>()
  /** Maps "tableName.colName" → default value expression ('CURRENT_TIMESTAMP' → ISO string, else literal) */
  private _columnDefaults = new Map<string, string>()
  /** Maps table name → array of primary key column names */
  private _primaryKeys = new Map<string, string[]>()
  /** Maps table name → ordered list of column names (from CREATE TABLE) */
  private _tableColumns = new Map<string, string[]>()

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

  // -------------------------------------------------------------------------
  // SyncAdapter implementation
  // -------------------------------------------------------------------------

  querySync<T = unknown>(sql: string, params?: unknown[]): T[] {
    const rows = this._execute(sql.trim(), params)
    return rows as T[]
  }

  execSync(sql: string): void {
    this._execute(sql.trim(), undefined)
  }

  async transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    // Snapshot: deep-clone each table's rows and auto-increment counters
    const snapshot = new Map<string, Row[]>()
    for (const [name, rows] of this._tables) {
      snapshot.set(name, rows.map((r) => ({ ...r })))
    }
    const counterSnapshot = new Map(this._autoIncrementCounters)

    try {
      const result = await fn(this)
      return result
    } catch (err) {
      // Restore snapshot on failure (data + counters; schema/defaults are immutable per-table)
      this._tables = snapshot
      this._autoIncrementCounters = counterSnapshot
      throw err
    }
  }

  async close(): Promise<void> {
    this._tables.clear()
  }

  /**
   * Work graph not supported in InMemoryDatabaseAdapter.
   * Returns `[]` to signal the caller to use the legacy discovery path.
   */
  async queryReadyStories(): Promise<string[]> {
    return []
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
    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(upper)) {
      return this._createIndex(resolved)
    }
    if (/^DROP\s+INDEX/i.test(upper)) {
      return this._dropIndex(resolved)
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

    // PRAGMA table_info(tableName) — return column metadata
    if (/^PRAGMA\s+table_info\s*\(/i.test(upper)) {
      return this._pragmaTableInfo(resolved)
    }

    // Unknown statement — silently ignore (BEGIN, COMMIT, ROLLBACK, other pragmas, etc.)
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
      // Detect AUTO_INCREMENT / AUTOINCREMENT column and DEFAULT values
      const colDefsM = /\((.+)\)\s*$/is.exec(sql)
      if (colDefsM) {
        const colDefs = colDefsM[1]!
        // Find column with AUTO_INCREMENT
        const aiMatch = /^\s*(\w+)\s+\w+.*?(?:AUTO_INCREMENT|AUTOINCREMENT)/im.exec(colDefs)
        if (aiMatch) {
          this._autoIncrementCols.set(name, aiMatch[1]!)
          if (!this._autoIncrementCounters.has(name)) {
            this._autoIncrementCounters.set(name, 0)
          }
        }
        // Find columns with DEFAULT values and PRIMARY KEY constraints
        const colLines = this._splitTopLevelCommas(colDefs)
        const pkCols: string[] = []

        for (const colLine of colLines) {
          const trimmedLine = colLine.trim()

          // Table-level PRIMARY KEY constraint: PRIMARY KEY (col1, col2, ...)
          const tablePkM = /^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(trimmedLine)
          if (tablePkM) {
            const cols = tablePkM[1]!.split(',').map((c) => c.trim().replace(/^[`"](.+)[`"]$/, '$1'))
            pkCols.push(...cols)
            continue
          }

          // Column-level DEFAULT value
          const defaultM = /^\s*(\w+)\s+\S+.*?\bDEFAULT\s+(.+?)(?:\s*,?\s*$)/i.exec(trimmedLine)
          if (defaultM) {
            const colName = defaultM[1]!
            const defaultVal = defaultM[2]!.trim()
            this._columnDefaults.set(`${name}.${colName}`, defaultVal)
          }

          // Column-level PRIMARY KEY: colName TYPE ... PRIMARY KEY
          const colPkM = /^(\w+)\s+\w+.*?\bPRIMARY\s+KEY\b/i.exec(trimmedLine)
          if (colPkM && !/^PRIMARY\s+KEY\b/i.test(trimmedLine)) {
            pkCols.push(colPkM[1]!)
          }
        }

        if (pkCols.length > 0 && !this._primaryKeys.has(name)) {
          this._primaryKeys.set(name, pkCols)
        }

        // Track column names in definition order (skip table-level constraints)
        if (!this._tableColumns.has(name)) {
          const colNames: string[] = []
          for (const colLine of colLines) {
            const trimmedLine = colLine.trim()
            // Skip table-level constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK)
            if (/^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\s*[\s(]/i.test(trimmedLine)) continue
            // Extract column name: first identifier (bare word or backtick/double-quote quoted)
            const quotedM = /^[`"](\w+)[`"]\s+\S/i.exec(trimmedLine)
            if (quotedM) {
              colNames.push(quotedM[1]!)
              continue
            }
            const bareM = /^(\w+)\s+\S/i.exec(trimmedLine)
            if (bareM) colNames.push(bareM[1]!)
          }
          if (colNames.length > 0) this._tableColumns.set(name, colNames)
        }
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
  // CREATE INDEX
  // -------------------------------------------------------------------------

  private _createIndex(sql: string): Row[] {
    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] indexName ON tableName (...)
    const m = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)/i.exec(sql)
    if (m) {
      const name = m[1]!
      const tbl_name = m[2]!
      // Don't add duplicates
      if (!this._indexes.some((idx) => idx.name === name)) {
        this._indexes.push({ name, tbl_name, type: 'index' })
      }
    }
    return []
  }

  // -------------------------------------------------------------------------
  // DROP INDEX
  // -------------------------------------------------------------------------

  private _dropIndex(sql: string): Row[] {
    const m = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)/i.exec(sql)
    if (m) {
      const name = m[1]!
      this._indexes = this._indexes.filter((idx) => idx.name !== name)
    }
    return []
  }

  // -------------------------------------------------------------------------
  // PRAGMA table_info
  // -------------------------------------------------------------------------

  /**
   * Emulate PRAGMA table_info(tableName) — returns one row per column with
   * {cid, name, type, notnull, dflt_value, pk} shape.
   * Column names are derived from the CREATE TABLE definition order.
   * This is sufficient for schema compatibility checks.
   */
  private _pragmaTableInfo(sql: string): Row[] {
    const m = /PRAGMA\s+table_info\s*\(\s*[`'"]?(\w+)[`'"]?\s*\)/i.exec(sql)
    if (!m) return []
    const tableName = m[1]!
    const colNames = this._tableColumns.get(tableName)
    if (!colNames || colNames.length === 0) return []
    const pkCols = this._primaryKeys.get(tableName) ?? []
    return colNames.map((name, cid) => ({
      cid,
      name,
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
      pk: pkCols.includes(name) ? 1 : 0,
    }))
  }

  // -------------------------------------------------------------------------
  // sqlite_master virtual table
  // -------------------------------------------------------------------------

  private _selectFromSqliteMaster(sql: string): Row[] {
    // Build virtual rows: tables + indexes
    const masterRows: Row[] = []
    for (const name of this._tables.keys()) {
      masterRows.push({ type: 'table', name, tbl_name: name, rootpage: 0, sql: null })
    }
    for (const idx of this._indexes) {
      masterRows.push({ type: 'index', name: idx.name, tbl_name: idx.tbl_name, rootpage: 0, sql: null })
    }

    // Extract WHERE clause conditions manually
    const whereM = /WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s*$)/is.exec(sql)
    let rows = masterRows
    if (whereM) {
      rows = rows.filter((row) => this._matchWhere(whereM[1]!.trim(), row))
    }

    // Extract SELECT columns
    const colsM = /SELECT\s+(.+?)\s+FROM\s+sqlite_master/is.exec(sql)
    if (!colsM) return rows
    const colsStr = colsM[1]!.trim()
    if (colsStr === '*') return rows
    return rows.map((row) => this._projectCols(colsStr, row))
  }

  // -------------------------------------------------------------------------
  // INSERT
  // -------------------------------------------------------------------------

  private _insert(sql: string, _ignoreConflicts = false): Row[] {
    // INSERT INTO tableName (col1, col2, ...) VALUES (val1, val2, ...)
    const m = /INSERT\s+(?:IGNORE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)\s*$/is.exec(sql)
    if (!m) return []

    const tableName = m[1]!
    // Strip backtick and double-quote quoting from column names
    const cols = m[2]!.split(',').map((c) => c.trim().replace(/^[`"](.+)[`"]$/, '$1'))
    const valStr = m[3]!
    const vals = this._parseValueList(valStr)

    const row: Row = {}
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]!] = vals[i] ?? null
    }

    // Auto-assign auto-increment ID if the column is missing from INSERT
    const aiCol = this._autoIncrementCols.get(tableName)
    if (aiCol && !(aiCol in row)) {
      const next = (this._autoIncrementCounters.get(tableName) ?? 0) + 1
      this._autoIncrementCounters.set(tableName, next)
      row[aiCol] = next
    }

    // Apply DEFAULT values for columns not present in INSERT
    for (const [key, defaultExpr] of this._columnDefaults) {
      const [tbl, col] = key.split('.') as [string, string]
      if (tbl === tableName && !(col in row)) {
        if (/^CURRENT_TIMESTAMP$/i.test(defaultExpr)) {
          row[col] = new Date().toISOString()
        } else {
          row[col] = this._evalLiteral(defaultExpr)
        }
      }
    }

    if (!this._tables.has(tableName)) {
      this._tables.set(tableName, [])
    }

    // Enforce PRIMARY KEY uniqueness (throw to support INSERT OR IGNORE via try/catch)
    const pkCols = this._primaryKeys.get(tableName)
    if (pkCols && pkCols.length > 0 && !_ignoreConflicts) {
      const table = this._tables.get(tableName)!
      const isDuplicate = table.some((existingRow) =>
        pkCols.every((col) => existingRow[col] !== undefined && String(existingRow[col]) === String(row[col]))
      )
      if (isDuplicate) {
        throw new Error(`UNIQUE constraint failed: ${tableName} (${pkCols.join(', ')})`)
      }
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

    // Handle sqlite_master virtual table queries (for index/schema inspection)
    if (/FROM\s+sqlite_master/i.test(sql)) {
      return this._selectFromSqliteMaster(sql)
    }

    // Extract LIMIT before stripping
    let limitValue: number | undefined
    const limitMatch = /\s+LIMIT\s+(\d+)\s*$/is.exec(sql)
    if (limitMatch) {
      limitValue = parseInt(limitMatch[1]!, 10)
    }

    // Extract ORDER BY clause before stripping
    let orderByExprs: Array<{ expr: string; dir: 'ASC' | 'DESC' }> | undefined
    const orderByMatch = /\s+ORDER\s+BY\s+(.+?)(?:\s+LIMIT\s+\d+\s*)?$/is.exec(sql)
    if (orderByMatch) {
      orderByExprs = this._parseOrderBy(orderByMatch[1]!.trim())
    }

    // Strip ORDER BY and LIMIT clauses
    let stripped = sql.replace(/\s+ORDER\s+BY\s+.+?(?=\s+LIMIT\s|\s*$)/is, '')
      .replace(/\s+LIMIT\s+\d+\s*$/is, '')

    // Extract GROUP BY clause (present before ORDER BY, after WHERE)
    let groupByCols: string[] | null = null
    const groupByMatch = /\s+GROUP\s+BY\s+(.+?)(?:\s+HAVING\s+.+?)?$/is.exec(stripped)
    if (groupByMatch) {
      groupByCols = groupByMatch[1]!.split(',').map((c) => c.trim())
      stripped = stripped.replace(/\s+GROUP\s+BY\s+.+$/is, '')
    }

    // SELECT cols FROM tableName [WHERE ...]
    const m = /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/is.exec(stripped)
    if (!m) return []

    const colsStr = m[1]!.trim()
    const tableName = m[2]!
    const whereStr = m[3]

    const table = this._tables.get(tableName) ?? []
    let rows = table.map((r) => ({ ...r }))

    if (whereStr) {
      rows = rows.filter((row) => this._matchWhere(whereStr.trim(), row))
    }

    // Apply GROUP BY when present
    if (groupByCols !== null) {
      const grouped = this._applyGroupBy(colsStr, rows, groupByCols)
      const sorted = orderByExprs ? this._applyOrderBy(grouped, orderByExprs) : grouped
      return limitValue !== undefined ? sorted.slice(0, limitValue) : sorted
    }

    // Apply ORDER BY
    if (orderByExprs) {
      rows = this._applyOrderBy(rows, orderByExprs)
    }

    // Apply LIMIT
    if (limitValue !== undefined) {
      rows = rows.slice(0, limitValue)
    }

    if (colsStr === '*') {
      return rows
    }

    // Detect aggregate functions (SUM, COALESCE, COUNT, etc.)
    if (/\b(?:SUM|COALESCE|COUNT|AVG|MIN|MAX)\s*\(/i.test(colsStr)) {
      return [this._evalAggregate(colsStr, rows)]
    }

    // Project specific columns
    return rows.map((row) => this._projectCols(colsStr, row))
  }

  // -------------------------------------------------------------------------
  // GROUP BY helpers
  // -------------------------------------------------------------------------

  /**
   * Apply GROUP BY: bucket rows by the group-by columns, then evaluate
   * aggregate expressions for each bucket. Plain column references in the
   * SELECT list that are also GROUP BY columns return the group value from
   * the first row in the bucket (all rows in a group share the same value).
   */
  private _applyGroupBy(colsStr: string, rows: Row[], groupByCols: string[]): Row[] {
    // Bucket rows by the GROUP BY key
    const groups = new Map<string, Row[]>()
    for (const row of rows) {
      const key = groupByCols.map((col) => String(row[col] ?? '')).join('\0')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    const result: Row[] = []
    for (const [, groupRows] of groups) {
      result.push(this._evalAggregateGroup(colsStr, groupRows))
    }
    return result
  }

  // -------------------------------------------------------------------------
  // ORDER BY helpers
  // -------------------------------------------------------------------------

  /**
   * Parse ORDER BY expression list into sort keys.
   * Handles: simple columns, COALESCE(col, default) DESC, CASE...END expressions.
   */
  private _parseOrderBy(orderByStr: string): Array<{ expr: string; dir: 'ASC' | 'DESC' }> {
    // Split by top-level commas
    const parts = this._splitTopLevelCommas(orderByStr)
    return parts.map((part) => {
      const trimmed = part.trim()
      // Check for trailing ASC/DESC
      const dirMatch = /^(.*?)\s+(ASC|DESC)\s*$/i.exec(trimmed)
      if (dirMatch) {
        return { expr: dirMatch[1]!.trim(), dir: dirMatch[2]!.toUpperCase() as 'ASC' | 'DESC' }
      }
      return { expr: trimmed, dir: 'ASC' }
    })
  }

  /**
   * Sort rows according to ORDER BY expression list.
   */
  private _applyOrderBy(rows: Row[], orderBy: Array<{ expr: string; dir: 'ASC' | 'DESC' }>): Row[] {
    return [...rows].sort((a, b) => {
      for (const { expr, dir } of orderBy) {
        const aVal = this._evalOrderByExpr(expr, a)
        const bVal = this._evalOrderByExpr(expr, b)
        const cmp = this._compareValues(aVal, bVal)
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp
      }
      return 0
    })
  }

  /**
   * Evaluate an ORDER BY expression for a single row.
   */
  private _evalOrderByExpr(expr: string, row: Row): unknown {
    const trimmed = expr.trim()

    // Simple CASE: CASE col WHEN val1 THEN r1 [WHEN val2 THEN r2]... [ELSE default] END
    const simpleCaseM = /^CASE\s+(\w+)\s+(.+?)\s+END$/is.exec(trimmed)
    if (simpleCaseM) {
      const col = simpleCaseM[1]!
      const colVal = String(row[col] ?? '')
      const body = simpleCaseM[2]!.trim()
      // Match WHEN 'val' THEN result pairs
      const whenMatches = [...body.matchAll(/WHEN\s+'([^']*)'\s+THEN\s+(\S+)/gi)]
      for (const wm of whenMatches) {
        if (colVal === wm[1]) return this._evalLiteral(wm[2]!)
      }
      // ELSE clause
      const elseM = /ELSE\s+(\S+)\s*$/i.exec(body)
      if (elseM) return this._evalLiteral(elseM[1]!)
      return null
    }

    // Fall through to row expression evaluator
    return this._evalRowExpr(trimmed, row)
  }

  /**
   * Compare two values for sorting (handles null, numbers, strings).
   * Returns negative if a < b, 0 if equal, positive if a > b.
   */
  private _compareValues(a: unknown, b: unknown): number {
    if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1
    if (b === null || b === undefined) return -1
    if (typeof a === 'number' && typeof b === 'number') return a - b
    return String(a).localeCompare(String(b))
  }

  /**
   * Evaluate SELECT expressions against a single GROUP BY bucket.
   * Handles both aggregate expressions (SUM, COUNT, COALESCE) and plain
   * column references (for GROUP BY projected columns).
   */
  private _evalAggregateGroup(colsStr: string, rows: Row[]): Row {
    const result: Row = {}
    const cols = this._splitTopLevelCommas(colsStr)
    for (const col of cols) {
      const aliasM = /^(.+?)\s+AS\s+(\w+)$/i.exec(col)
      const expr = aliasM ? aliasM[1]!.trim() : col.trim()
      const alias = aliasM ? aliasM[2]! : col.trim()
      result[alias] = this._evalAggregateExprGrouped(expr, rows)
    }
    return result
  }

  /**
   * Evaluate a single aggregate expression against a GROUP BY bucket.
   * Extends _evalAggregateExpr with:
   *   - SUM(expr)       where expr may be CASE WHEN ... END
   *   - Plain column references (returns first-row value, for GROUP BY cols)
   */
  private _evalAggregateExprGrouped(expr: string, rows: Row[]): unknown {
    const trimmed = expr.trim()

    // COALESCE(expr, default)
    const coalesceM = /^COALESCE\((.+)\)$/i.exec(trimmed)
    if (coalesceM) {
      const args = this._splitTopLevelCommas(coalesceM[1]!)
      for (const arg of args) {
        const val = this._evalAggregateExprGrouped(arg.trim(), rows)
        if (val !== null && val !== undefined) return val
      }
      return null
    }

    // SUM(expr) — expr may be CASE WHEN ... or a plain column name
    const sumM = /^SUM\((.+)\)$/i.exec(trimmed)
    if (sumM) {
      if (rows.length === 0) return null
      let total = 0
      for (const row of rows) {
        total += Number(this._evalRowExpr(sumM[1]!.trim(), row) ?? 0)
      }
      return total
    }

    // COUNT(*)
    if (/^COUNT\(\*\)$/i.test(trimmed)) {
      return rows.length
    }

    // COUNT(col)
    const countColM = /^COUNT\((\w+)\)$/i.exec(trimmed)
    if (countColM) {
      const col = countColM[1]!
      return rows.filter((r) => r[col] !== null && r[col] !== undefined).length
    }

    // MAX(col)
    const maxColM = /^MAX\((\w+)\)$/i.exec(trimmed)
    if (maxColM) {
      const col = maxColM[1]!
      const values = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined)
      if (values.length === 0) return null
      return values.reduce((a, b) => (String(a) >= String(b) ? a : b))
    }

    // MIN(col)
    const minColM = /^MIN\((\w+)\)$/i.exec(trimmed)
    if (minColM) {
      const col = minColM[1]!
      const values = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined)
      if (values.length === 0) return null
      return values.reduce((a, b) => (String(a) <= String(b) ? a : b))
    }

    // Plain column reference — GROUP BY projected columns share the same value
    if (/^\w+$/.test(trimmed) && rows.length > 0 && trimmed in rows[0]!) {
      return rows[0]![trimmed]
    }

    // Literal value (e.g. the 0 in COALESCE(SUM(x), 0))
    return this._evalLiteral(trimmed)
  }

  /**
   * Evaluate an expression for a single row.
   * Supports CASE WHEN conditions, COALESCE, column references, and literals.
   * Used by _evalAggregateExprGrouped to evaluate the argument of SUM().
   */
  private _evalRowExpr(expr: string, row: Row): unknown {
    const trimmed = expr.trim()

    // COALESCE(expr1, expr2, ...)
    const coalesceM = /^COALESCE\((.+)\)$/i.exec(trimmed)
    if (coalesceM) {
      const args = this._splitTopLevelCommas(coalesceM[1]!)
      for (const arg of args) {
        const val = this._evalRowExpr(arg.trim(), row)
        if (val !== null && val !== undefined) return val
      }
      return null
    }

    // CASE WHEN condition THEN thenExpr ELSE elseExpr END
    const caseM = /^CASE\s+WHEN\s+(.+?)\s+THEN\s+(.+?)\s+ELSE\s+(.+?)\s+END$/is.exec(trimmed)
    if (caseM) {
      const matches = this._evalRowCondition(caseM[1]!.trim(), row)
      return this._evalRowExpr(matches ? caseM[2]!.trim() : caseM[3]!.trim(), row)
    }

    // Plain column reference (identifier starting with a letter or underscore)
    if (/^\w+$/.test(trimmed) && /^[a-zA-Z_]/.test(trimmed)) {
      if (trimmed in row) return row[trimmed]
      // Column not in row — SQL NULL semantics (avoid treating as string literal)
      return null
    }

    // Literal (number, quoted string, etc.)
    return this._evalLiteral(trimmed)
  }

  /**
   * Evaluate a simple condition (col = 'str', col = num) for a single row.
   * Returns true if the condition holds.
   */
  private _evalRowCondition(condition: string, row: Row): boolean {
    const trimmed = condition.trim()

    // col = 'string'
    const strM = /^(\w+)\s*=\s*'(.*)'$/is.exec(trimmed)
    if (strM) {
      const colVal = String(row[strM[1]!] ?? '')
      const literal = strM[2]!.replace(/''/g, "'")
      return colVal === literal
    }

    // col = numeric
    const numM = /^(\w+)\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed)
    if (numM) {
      return Number(row[numM[1]!]) === parseFloat(numM[2]!)
    }

    return false
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

    for (const row of table) {
      if (!whereStr || this._matchWhere(whereStr.trim(), row)) {
        const assignments = this._parseAssignmentsForRow(setStr, row)
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

      // col = 'string literal' (col may be backtick or double-quote quoted)
      const strM = /^[`"]?(\w+)[`"]?\s*=\s*'(.*)'$/is.exec(trimmed)
      if (strM) {
        const colVal = String(row[strM[1]!] ?? '')
        const literal = strM[2]!.replace(/''/g, "'")
        if (colVal !== literal) return false
        continue
      }

      // col != 'string literal' (inequality)
      const strNeqM = /^[`"]?(\w+)[`"]?\s*!=\s*'(.*)'$/is.exec(trimmed)
      if (strNeqM) {
        const colVal = String(row[strNeqM[1]!] ?? '')
        const literal = strNeqM[2]!.replace(/''/g, "'")
        if (colVal === literal) return false
        continue
      }

      // col = numeric literal
      const numM = /^[`"]?(\w+)[`"]?\s*=\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed)
      if (numM) {
        if (Number(row[numM[1]!]) !== parseFloat(numM[2]!)) return false
        continue
      }

      // col != numeric literal (inequality)
      const numNeqM = /^[`"]?(\w+)[`"]?\s*!=\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed)
      if (numNeqM) {
        if (Number(row[numNeqM[1]!]) === parseFloat(numNeqM[2]!)) return false
        continue
      }

      // col < / > / <= / >= 'string literal' (handles ISO date comparisons)
      const strCmpM = /^[`"]?(\w+)[`"]?\s*(>=|<=|>|<)\s*'(.*)'$/s.exec(trimmed)
      if (strCmpM) {
        const colVal = row[strCmpM[1]!]
        if (colVal === null || colVal === undefined) return false
        const lhs = String(colVal)
        const rhs = strCmpM[3]!.replace(/''/g, "'")
        const op = strCmpM[2]!
        if (op === '<' && !(lhs < rhs)) return false
        if (op === '<=' && !(lhs <= rhs)) return false
        if (op === '>' && !(lhs > rhs)) return false
        if (op === '>=' && !(lhs >= rhs)) return false
        continue
      }

      // col < / > / <= / >= numeric literal
      const numCmpM = /^[`"]?(\w+)[`"]?\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed)
      if (numCmpM) {
        const colVal = Number(row[numCmpM[1]!] ?? 0)
        const rhs = parseFloat(numCmpM[3]!)
        const op = numCmpM[2]!
        if (op === '<' && !(colVal < rhs)) return false
        if (op === '<=' && !(colVal <= rhs)) return false
        if (op === '>' && !(colVal > rhs)) return false
        if (op === '>=' && !(colVal >= rhs)) return false
        continue
      }

      // col IS NULL
      const nullM = /^[`"]?(\w+)[`"]?\s+IS\s+NULL$/i.exec(trimmed)
      if (nullM) {
        if (row[nullM[1]!] !== null && row[nullM[1]!] !== undefined) return false
        continue
      }

      // col IS NOT NULL
      const notNullM = /^[`"]?(\w+)[`"]?\s+IS\s+NOT\s+NULL$/i.exec(trimmed)
      if (notNullM) {
        if (row[notNullM[1]!] === null || row[notNullM[1]!] === undefined) return false
        continue
      }

      // col LIKE 'pattern' (supports % wildcard)
      const likeM = /^[`"]?(\w+)[`"]?\s+LIKE\s+'(.*)'$/is.exec(trimmed)
      if (likeM) {
        const colVal = row[likeM[1]!]
        if (colVal === null || colVal === undefined) return false
        const pattern = likeM[2]!.replace(/''/g, "'")
        // Convert SQL LIKE pattern to regex: % → .*, _ → .
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => ch === '%' || ch === '_' ? ch : '\\' + ch)
        const regex = new RegExp('^' + escaped.replace(/%/g, '.*').replace(/_/g, '.') + '$', 's')
        if (!regex.test(String(colVal))) return false
        continue
      }

      // col IN ('val1', 'val2', ...)
      const inM = /^[`"]?(\w+)[`"]?\s+IN\s*\((.+)\)$/is.exec(trimmed)
      if (inM) {
        const colVal = row[inM[1]!]
        const inValues = this._parseValueList(inM[2]!)
        const colStr = colVal === null || colVal === undefined ? null : typeof colVal === 'number' ? colVal : String(colVal)
        if (!inValues.some((v) => v === colStr || String(v) === String(colStr))) return false
        continue
      }

      // col NOT IN ('val1', 'val2', ...)
      const notInM = /^[`"]?(\w+)[`"]?\s+NOT\s+IN\s*\((.+)\)$/is.exec(trimmed)
      if (notInM) {
        const colVal = row[notInM[1]!]
        const notInValues = this._parseValueList(notInM[2]!)
        const colStr = colVal === null || colVal === undefined ? null : typeof colVal === 'number' ? colVal : String(colVal)
        if (notInValues.some((v) => v === colStr || String(v) === String(colStr))) return false
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
    const cols = this._splitTopLevelCommas(colsStr)
    for (const col of cols) {
      // Handle "expr AS alias" or plain "col"
      const aliasM = /^(.+?)\s+AS\s+(\w+)$/i.exec(col)
      if (aliasM) {
        result[aliasM[2]!] = this._evalExprAgainstRow(aliasM[1]!.trim(), row)
      } else {
        // Return null for columns not present in the row (matches SQLite NULL behavior)
        result[col] = col in row ? row[col] : null
      }
    }
    return result
  }

  // -------------------------------------------------------------------------
  // Helpers: literal expression evaluation (for SELECT without FROM)
  // -------------------------------------------------------------------------

  private _evalSelectExprs(exprs: string): Row {
    const result: Row = {}
    const parts = this._splitTopLevelCommas(exprs)
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
  // Helpers: parenthesis-aware comma splitting
  // -------------------------------------------------------------------------

  /**
   * Split a string by commas that are NOT inside parentheses.
   * E.g. "COALESCE(SUM(x), 0) as a, y" → ["COALESCE(SUM(x), 0) as a", "y"]
   */
  private _splitTopLevelCommas(str: string): string[] {
    const parts: string[] = []
    let current = ''
    let depth = 0
    let inStr = false

    for (let i = 0; i < str.length; i++) {
      const ch = str[i]!
      if (ch === "'" && !inStr) {
        inStr = true
        current += ch
      } else if (ch === "'" && inStr) {
        if (str[i + 1] === "'") {
          current += "''"
          i++
        } else {
          inStr = false
          current += ch
        }
      } else if (!inStr && ch === '(') {
        depth++
        current += ch
      } else if (!inStr && ch === ')') {
        depth--
        current += ch
      } else if (!inStr && ch === ',' && depth === 0) {
        parts.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    if (current.trim() !== '') parts.push(current.trim())
    return parts
  }

  // -------------------------------------------------------------------------
  // Helpers: aggregate evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate aggregate SELECT expressions (SUM, COALESCE, COUNT) across
   * a set of filtered rows, returning a single result row.
   */
  private _evalAggregate(colsStr: string, rows: Row[]): Row {
    const result: Row = {}
    const cols = this._splitTopLevelCommas(colsStr)

    for (const col of cols) {
      const aliasM = /^(.+?)\s+AS\s+(\w+)$/i.exec(col)
      const expr = aliasM ? aliasM[1]!.trim() : col.trim()
      const alias = aliasM ? aliasM[2]! : col.trim()
      result[alias] = this._evalAggregateExpr(expr, rows)
    }

    return result
  }

  /**
   * Evaluate a single aggregate expression against a set of rows.
   * Supports: SUM(expr), COALESCE(expr, default), COUNT(*), MAX(col), MIN(col).
   */
  private _evalAggregateExpr(expr: string, rows: Row[]): unknown {
    const trimmed = expr.trim()

    // COALESCE(expr, default)
    const coalesceM = /^COALESCE\((.+)\)$/i.exec(trimmed)
    if (coalesceM) {
      const args = this._splitTopLevelCommas(coalesceM[1]!)
      for (const arg of args) {
        const val = this._evalAggregateExpr(arg.trim(), rows)
        if (val !== null && val !== undefined) return val
      }
      return null
    }

    // SUM(expr) — expr may be a plain column name or CASE WHEN ... expression
    const sumM = /^SUM\((.+)\)$/i.exec(trimmed)
    if (sumM) {
      if (rows.length === 0) return null
      let total = 0
      for (const row of rows) {
        total += Number(this._evalRowExpr(sumM[1]!.trim(), row) ?? 0)
      }
      return total
    }

    // COUNT(*)
    if (/^COUNT\(\*\)$/i.test(trimmed)) {
      return rows.length
    }

    // COUNT(DISTINCT col)
    const countDistinctM = /^COUNT\(\s*DISTINCT\s+(\w+)\s*\)$/i.exec(trimmed)
    if (countDistinctM) {
      const col = countDistinctM[1]!
      const distinct = new Set(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined))
      return distinct.size
    }

    // COUNT(col)
    const countM = /^COUNT\((\w+)\)$/i.exec(trimmed)
    if (countM) {
      const col = countM[1]!
      return rows.filter((r) => r[col] !== null && r[col] !== undefined).length
    }

    // MAX(col)
    const maxM = /^MAX\((\w+)\)$/i.exec(trimmed)
    if (maxM) {
      const col = maxM[1]!
      const values = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined)
      if (values.length === 0) return null
      return values.reduce((a, b) => (String(a) >= String(b) ? a : b))
    }

    // MIN(col)
    const minM = /^MIN\((\w+)\)$/i.exec(trimmed)
    if (minM) {
      const col = minM[1]!
      const values = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined)
      if (values.length === 0) return null
      return values.reduce((a, b) => (String(a) <= String(b) ? a : b))
    }

    // Literal value (e.g. the 0 in COALESCE(SUM(x), 0))
    return this._evalLiteral(trimmed)
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
   * Evaluates each RHS expression against the provided row for arithmetic support.
   */
  private _parseAssignmentsForRow(setStr: string, row: Row): [string, unknown][] {
    const assignments: [string, unknown][] = []
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
      assignments.push([col, this._evalAssignmentExpr(valStr, row)])
    }

    return assignments
  }

  /**
   * Evaluate a SET assignment RHS expression against the current row.
   * Handles: simple literals, column arithmetic (col +/- val), COALESCE, CURRENT_TIMESTAMP.
   */
  private _evalAssignmentExpr(expr: string, row: Row): unknown {
    const trimmed = expr.trim()

    // CURRENT_TIMESTAMP
    if (/^CURRENT_TIMESTAMP$/i.test(trimmed)) {
      return new Date().toISOString()
    }

    // COALESCE(expr, default)
    const coalesceM = /^COALESCE\((.+)\)$/i.exec(trimmed)
    if (coalesceM) {
      const args = this._splitTopLevelCommas(coalesceM[1]!)
      for (const arg of args) {
        const val = this._evalAssignmentExpr(arg.trim(), row)
        if (val !== null && val !== undefined) return val
      }
      return null
    }

    // Arithmetic: col +/- numeric (e.g. cost_usd + 0.0105)
    const arithM = /^(\w+)\s*([+\-*\/])\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed)
    if (arithM) {
      const colName = arithM[1]!
      const op = arithM[2]!
      const num = parseFloat(arithM[3]!)
      const colVal = Number(row[colName] ?? 0)
      switch (op) {
        case '+': return colVal + num
        case '-': return colVal - num
        case '*': return colVal * num
        case '/': return num !== 0 ? colVal / num : null
      }
    }

    // Plain literal
    return this._evalLiteral(trimmed)
  }

  /**
   * @deprecated Use _parseAssignmentsForRow instead.
   * Kept for internal compatibility — evaluates without row context.
   */
  private _parseAssignments(setStr: string): [string, unknown][] {
    return this._parseAssignmentsForRow(setStr, {})
  }
}
