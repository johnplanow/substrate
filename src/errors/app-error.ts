/**
 * AppError — base error class for substrate with machine-readable error codes.
 *
 * Architecture decision: AppError base class with numeric exit codes
 * (process.exit codes: 0 success, 1 user error, 2 internal error).
 * All structured errors in substrate should extend this class.
 */

/**
 * Base error class for substrate with machine-readable error codes and exit codes.
 *
 * @example
 *   throw new AppError('ERR_TELEMETRY_NOT_STARTED', 2, 'IngestionServer is not started')
 */
export class AppError extends Error {
  /** Machine-readable error code (e.g. ERR_DB_LOCKED, ERR_INVALID_INPUT) */
  public readonly code: string
  /** Process exit code: 0 success, 1 user error, 2 internal error */
  public readonly exitCode: number

  constructor(code: string, exitCode: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.exitCode = exitCode
  }
}
