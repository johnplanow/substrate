/**
 * CI smoke-test gate: every flag substrate's claude-adapter passes must be
 * accepted by the installed Claude Code CLI.
 *
 * Closes the deferred fix from obs_2026-05-05_025 (claude CLI v2.1.126 dropped
 * --max-context-tokens; substrate kept passing it; 100% dispatch failure for
 * any consumer running CLI v2.x). Runtime hot-fix shipped as v0.20.56 (drop
 * the flag); this test is the forward-compat hardening — catches the NEXT
 * removed-flag issue at CI time, before consumers hit it.
 *
 * Strategy (BEHAVIORAL — not help-parse):
 *   1. Spawn `claude` with all substrate-passed flags at once + a tiny prompt
 *   2. Read stderr/stdout for the literal "error: unknown option '<flag>'"
 *      pattern that claude emits when commander.js rejects an unknown flag
 *   3. ANY match → some flag substrate passes is no longer accepted; fail
 *
 * Why behavioral instead of help-parse:
 *   `--max-turns` is functional in claude CLI 2.1.x but NOT registered in
 *   `claude --help` output (hidden flag, accepted by commander). Help-parse
 *   would false-positive on it. Behavioral probe ("does claude reject this
 *   flag with `unknown option`?") is the actual production signal.
 *
 * Why claude exit code is not the assertion:
 *   `claude -p --some-fake-flag "hi"` exits 0 even when commander rejects
 *   the flag (claude's -p mode swallows the nonzero from invalid args).
 *   The unambiguous signal is the `error: unknown option` literal in
 *   stderr/stdout.
 *
 * Skip behavior:
 *   When `claude` is not on PATH (CI without claude installed), test is
 *   skipped via `it.skipIf` — registered but not executed. Prevents false
 *   pass via 0-assertions.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

/**
 * Probe: is `claude` installed and runnable? Test is skipped when false.
 *
 * `claude --version` is the cheap probe — exits ~50ms with version string
 * when installed, ENOENT when not.
 */
function claudeIsInstalled(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return result.status === 0
  } catch {
    return false
  }
}

const CLAUDE_INSTALLED = claudeIsInstalled()

/**
 * Static surface of flags substrate's claude-adapter passes. Source of truth:
 *   packages/core/src/adapters/claude-adapter.ts:buildCommand
 *
 * When that file changes, this list MUST update in lockstep — that's the
 * point of this test (catch drift between adapter expectations and CLI
 * registered flags).
 *
 * Each entry is a flag + value pair (or just a flag for boolean flags).
 * Concatenated into a single argv when the test invokes claude.
 */
const SUBSTRATE_FLAG_ARGS: readonly string[] = [
  '-p',
  '--model', 'claude-sonnet-4-6',
  '--dangerously-skip-permissions',
  '--max-turns', '1',
  '--system-prompt', 'noop-system-prompt-for-flag-compat-probe',
  // Tiny user prompt as positional (claude needs this in -p mode)
  'hi',
]

describe('claude-adapter flag forward-compat (obs_025)', () => {
  it.skipIf(!CLAUDE_INSTALLED)(
    'claude accepts all flags substrate-adapter passes (no "unknown option" rejections)',
    () => {
      const result = spawnSync('claude', SUBSTRATE_FLAG_ARGS, {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Strip ANTHROPIC_API_KEY so an inherited bad key doesn't change the
        // failure surface — the assertion only cares about flag-rejection,
        // and claude will hit auth-error path which produces NO unknown-option
        // text in stderr.
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          USER: process.env['USER'] ?? '',
          SHELL: process.env['SHELL'] ?? '',
        },
      })

      const combined = (result.stdout ?? '') + '\n' + (result.stderr ?? '')

      // commander.js error format: "error: unknown option '<flag>'"
      // (claude CLI uses commander internally for arg parsing).
      const unknownOptionPattern = /error:\s+unknown option\s+'([^']+)'/g
      const matches: string[] = []
      let m: RegExpExecArray | null
      while ((m = unknownOptionPattern.exec(combined)) !== null) {
        matches.push(m[1] ?? '<unknown>')
      }

      expect(
        matches,
        `Claude CLI rejected flags substrate-adapter passes: ${matches.join(', ') || 'none'}. ` +
          `Update packages/core/src/adapters/claude-adapter.ts to drop the rejected flag(s) ` +
          `(see obs_2026-05-05_025 + Story v0.20.56 for the prior --max-context-tokens precedent).`,
      ).toEqual([])
    },
  )

  it.skipIf(!CLAUDE_INSTALLED)(
    'sanity: claude rejects an obviously-fake flag (test infrastructure proof)',
    () => {
      // Defensive: ensure the regex + invocation pattern actually CAN detect a
      // rejected flag. If this test ever passes when it should fail, the main
      // test above is producing a false-pass.
      const result = spawnSync(
        'claude',
        ['-p', '--dangerously-skip-permissions', '--this-flag-does-not-exist-x9', 'hi'],
        {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: process.env['HOME'] ?? '',
            USER: process.env['USER'] ?? '',
            SHELL: process.env['SHELL'] ?? '',
          },
        },
      )

      const combined = (result.stdout ?? '') + '\n' + (result.stderr ?? '')
      expect(combined).toMatch(/error:\s+unknown option\s+'--this-flag-does-not-exist-x9'/)
    },
  )
})
