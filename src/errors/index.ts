/**
 * Errors catalogue — exports AppError base class and all ERR_* error code constants.
 *
 * Add new error code constants here following the pattern:
 *   export const ERR_SOMETHING = 'ERR_SOMETHING' as const
 */

export { AppError } from './app-error.js'

// ---------------------------------------------------------------------------
// Telemetry error codes
// ---------------------------------------------------------------------------

/** Thrown when getOtlpEnvVars() is called before IngestionServer.start() */
export const ERR_TELEMETRY_NOT_STARTED = 'ERR_TELEMETRY_NOT_STARTED' as const

// ---------------------------------------------------------------------------
// Repo-map error codes
// ---------------------------------------------------------------------------

/** Thrown when tree-sitter parse fails for a source file */
export const ERR_REPO_MAP_PARSE_FAILED = 'ERR_REPO_MAP_PARSE_FAILED' as const

/** Thrown when tree-sitter parse exceeds the 5-second timeout */
export const ERR_REPO_MAP_PARSE_TIMEOUT = 'ERR_REPO_MAP_PARSE_TIMEOUT' as const

/** Thrown when a repo-map storage write operation fails */
export const ERR_REPO_MAP_STORAGE_WRITE = 'ERR_REPO_MAP_STORAGE_WRITE' as const

/** Thrown when a repo-map storage read operation fails */
export const ERR_REPO_MAP_STORAGE_READ = 'ERR_REPO_MAP_STORAGE_READ' as const

/** Thrown when a git subprocess invoked by repo-map fails */
export const ERR_REPO_MAP_GIT_FAILED = 'ERR_REPO_MAP_GIT_FAILED' as const
