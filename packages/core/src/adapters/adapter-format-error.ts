/**
 * AdapterFormatError — raised when all normalization strategies are exhausted.
 *
 * Carries structured context for downstream classifiers and observability.
 * The `rootCause` literal enables story 53-5's classifyFailure() to detect
 * adapter-format failures without duplicating the string constant.
 *
 * Always use the constructor — do not construct via object spread. The
 * constructor auto-truncates rawOutput to 500 chars for the snippet field.
 */
export class AdapterFormatError extends Error {
  /** The adapter identifier that produced the unrecognizable output */
  readonly adapter_id: string

  /**
   * First 500 chars of the raw output.
   * Capped at 500 chars — never log full raw output (can be 100K+ chars).
   */
  readonly raw_output_snippet: string

  /** Labels for each strategy that was attempted before giving up */
  readonly tried_strategies: readonly string[]

  /** The last parse error message encountered */
  readonly extraction_error: string

  /**
   * Root cause literal for downstream classifier integration (story 53-5).
   * Downstream classifiers reference this literal without duplicating the string.
   */
  readonly rootCause = 'adapter-format' as const

  constructor(opts: {
    adapter_id: string
    rawOutput: string
    tried_strategies: string[]
    extraction_error: string
  }) {
    super(
      `AdapterFormatError [${opts.adapter_id}]: exhausted all normalization strategies. ` +
        `Tried: ${opts.tried_strategies.join(', ')}. Last error: ${opts.extraction_error}`
    )
    this.name = 'AdapterFormatError'
    this.adapter_id = opts.adapter_id
    this.raw_output_snippet = opts.rawOutput.slice(0, 500)
    this.tried_strategies = [...opts.tried_strategies]
    this.extraction_error = opts.extraction_error
  }
}
