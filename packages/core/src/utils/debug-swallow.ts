/**
 * Debug-mode unmasking for `.catch()` wrappers that silently swallow errors.
 *
 * Background: many substrate code paths use `.catch(() => {})` to make a
 * background or non-critical operation non-blocking — version checks,
 * telemetry outbox drains, manifest updates after a process exits. The
 * pattern is correct (these failures must NOT block the user-facing flow)
 * but it hides ship-blocking bugs. v0.20.74's pre-dispatch version advisory
 * silently failed to fire in production for 4 CI-green ships because tsdown
 * bundled a broken lazy-chunk; the chunk's SyntaxError on instantiation was
 * swallowed by the advisory's `.catch(() => {})`. Caught only by user-driven
 * e2e smoke against the published bundle.
 *
 * **The discipline (codified here):** every `.catch(() => {})` should be
 * replaced with `.catch(swallowDebug('label'))`. When `SUBSTRATE_DEBUG`
 * contains the label (or `*`), the swallowed error surfaces to stderr.
 * Otherwise the original silent-failure semantic is preserved.
 *
 * Usage:
 *   import { swallowDebug } from '@substrate-ai/core'
 *   await fooThatMayFail().catch(swallowDebug('advisory'))
 *
 *   # In production: silent
 *   substrate run --stories 1-1
 *
 *   # When investigating silent failure:
 *   SUBSTRATE_DEBUG=advisory substrate run --stories 1-1
 *   SUBSTRATE_DEBUG=* substrate run --stories 1-1   # all swallow sites
 *   SUBSTRATE_DEBUG=advisory,mesh substrate run --stories 1-1
 */

/**
 * Build an error handler that silently swallows errors in normal operation
 * but writes them to stderr when `SUBSTRATE_DEBUG` enables the given label.
 *
 * Match rules: `SUBSTRATE_DEBUG=*` enables every label; otherwise the env
 * var is parsed as a comma-separated list (whitespace-tolerant) and matches
 * by exact label string.
 */
export function swallowDebug(label: string): (err: unknown) => void {
  return (err: unknown): void => {
    const debugEnv = process.env['SUBSTRATE_DEBUG']
    if (debugEnv === undefined || debugEnv === '') return
    const enabled =
      debugEnv === '*' ||
      debugEnv
        .split(',')
        .map((s) => s.trim())
        .includes(label)
    if (!enabled) return
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    const stack = err instanceof Error && err.stack ? `\n${err.stack}` : ''
    process.stderr.write(`[debug:${label}] swallowed: ${message}${stack}\n`)
  }
}
