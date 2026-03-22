/**
 * Config-specific error classes for @substrate-ai/core.
 *
 * AdtError is defined here as the canonical base class. ConfigError and
 * ConfigIncompatibleFormatError extend it. The monolith's src/core/errors.ts
 * re-exports AdtError from here so that all error classes share the same
 * base class instance — enabling instanceof checks to work across the
 * monolith/core boundary.
 */

/** Base error class for all Substrate errors */
export class AdtError extends Error {
  public readonly code: string
  public readonly context: Record<string, unknown>

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'AdtError'
    this.code = code
    this.context = context
    // Maintains proper stack trace for V8 (not available in all environments)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AdtError)
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      stack: this.stack,
    }
  }
}

/** Error thrown when configuration is invalid or missing */
export class ConfigError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'CONFIG_ERROR', context)
    this.name = 'ConfigError'
  }
}

/** Error thrown when a config file uses an incompatible format version */
export class ConfigIncompatibleFormatError extends AdtError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'CONFIG_INCOMPATIBLE_FORMAT', context)
    this.name = 'ConfigIncompatibleFormatError'
  }
}
