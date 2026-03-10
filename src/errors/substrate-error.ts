/**
 * SubstrateError — structured error base class with code and optional context.
 *
 * All substrate module errors should extend this class to provide
 * machine-readable codes and structured context for upstream error handling.
 *
 * Constructor signature: (message: string, code: string, context?: Record<string, unknown>)
 */
export class SubstrateError extends Error {
  /** Machine-readable error code */
  public readonly code: string

  /** Structured context carried alongside the error */
  public readonly context?: Record<string, unknown>

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'SubstrateError'
    this.code = code
    this.context = context
    // Maintain proper prototype chain in transpiled output
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
