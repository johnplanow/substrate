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
