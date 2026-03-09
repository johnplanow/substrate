/**
 * Typed error classes for the Dolt state store.
 */

export class StateStoreError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StateStoreError'
    this.code = code
  }
}

export class DoltNotInitializedError extends StateStoreError {
  repoPath: string

  constructor(repoPath: string) {
    super('DOLT_NOT_INITIALIZED', `Dolt repository not initialized at: ${repoPath}. Run 'dolt init' first.`)
    this.name = 'DoltNotInitializedError'
    this.repoPath = repoPath
  }
}

export class DoltQueryError extends StateStoreError {
  sql: string
  detail: string

  constructor(sql: string, detail: string) {
    super('DOLT_QUERY_ERROR', `Dolt query failed: ${detail}`)
    this.name = 'DoltQueryError'
    this.sql = sql
    this.detail = detail
  }
}

export class DoltMergeConflictError extends StateStoreError {
  table: string
  conflictingKeys: string[]
  rowKey?: string
  ourValue?: string
  theirValue?: string

  constructor(table: string, conflictingKeys: string[], options?: { rowKey?: string; ourValue?: string; theirValue?: string }) {
    super('DOLT_MERGE_CONFLICT', `Merge conflict in table '${table}' on keys: ${conflictingKeys.join(', ')}`)
    this.name = 'DoltMergeConflictError'
    this.table = table
    this.conflictingKeys = conflictingKeys
    if (options) {
      this.rowKey = options.rowKey
      this.ourValue = options.ourValue
      this.theirValue = options.theirValue
    }
  }
}

/** Alias for DoltMergeConflictError — used by orchestrator branch lifecycle. */
export const DoltMergeConflict = DoltMergeConflictError
