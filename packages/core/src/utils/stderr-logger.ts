/**
 * Stderr-routed ILogger factory.
 *
 * Use this instead of `console` as the default fallback for any class that
 * accepts an optional ILogger. Node's `console.debug` / `console.info` are
 * aliases for `console.log`, which writes to STDOUT — that contaminates
 * any stdout consumer that expects clean output (e.g. `substrate run --events`
 * NDJSON consumers, `--output-format json` commands, downstream parsers).
 *
 * v0.20.110 fixed the adapter.ts leak. v0.20.111 fixed the
 * git-worktree-manager-impl.ts leak. v0.20.112 centralized the discipline:
 * one shared helper, applied at every `logger ?? console` site, so future
 * callers can't reintroduce the bug.
 *
 * Usage:
 *   import { createStderrLogger } from '@substrate-ai/core'
 *   constructor(..., logger?: ILogger) {
 *     this._logger = logger ?? createStderrLogger('my-module')
 *   }
 *
 * The prefix is included in every line so stderr remains useful for
 * diagnostic correlation across modules — without polluting stdout.
 */

import type { ILogger } from '../dispatch/types.js'

/**
 * Format args the same way `console.*` does — strings stay as-is, everything
 * else serializes to JSON. Single-line output (newline appended by the
 * stderr write).
 */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.message
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

/**
 * Create an ILogger that routes every level to stderr via
 * `process.stderr.write`. Each line is prefixed with `[<prefix>] [<level>]`
 * so operators correlating cross-module diagnostics can tell where a line
 * came from.
 *
 * @param prefix - Module identifier used in the stderr prefix
 *                 (e.g., 'persistence:adapter', 'git-worktree-manager')
 */
export function createStderrLogger(prefix: string): ILogger {
  function emit(level: string, args: unknown[]): void {
    process.stderr.write(`[${prefix}] [${level}] ${formatArgs(args)}\n`)
  }
  return {
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    debug: (...args: unknown[]) => emit('debug', args),
  }
}
