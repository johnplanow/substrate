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
    super(
      'DOLT_NOT_INITIALIZED',
      `Dolt repository not initialized at: ${repoPath}. Run 'dolt init' first.`
    )
    this.name = 'DoltNotInitializedError'
    this.repoPath = repoPath
  }
}

// DoltQueryError implementation moved to @substrate-ai/core (story 41-10)
export { DoltQueryError } from '@substrate-ai/core'

export class DoltMergeConflictError extends StateStoreError {
  table: string
  conflictingKeys: string[]
  rowKey?: string
  ourValue?: string
  theirValue?: string

  constructor(
    table: string,
    conflictingKeys: string[],
    options?: { rowKey?: string; ourValue?: string; theirValue?: string }
  ) {
    super(
      'DOLT_MERGE_CONFLICT',
      `Merge conflict in table '${table}' on keys: ${conflictingKeys.join(', ')}`
    )
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
