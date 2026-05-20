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

// DoltQueryError implementation moved to @substrate-ai/core (story 41-10)
export { DoltQueryError } from '@substrate-ai/core'

