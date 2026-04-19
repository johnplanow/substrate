/**
 * Runtime probe types — Epic 55 / Phase 2.
 *
 * A "runtime probe" is an author-declared executable command that the
 * verification pipeline runs against a real or ephemeral target environment
 * to answer the question "does the artifact this story produced actually
 * work?". Runtime probes exist specifically to catch the class of bugs that
 * static shape-gates (phantom-review, trivial-output, ac-evidence, build)
 * cannot — runtime misconfiguration, wrong image paths, systemd semantics,
 * credential issues, and so on.
 *
 * This file defines the data shape; parsing lives in ./parser.ts, execution
 * lives in ./executor.ts, and the VerificationCheck implementation lives in
 * ../checks/runtime-probe-check.ts.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Sandbox — where the probe runs
// ---------------------------------------------------------------------------

/**
 * Execution sandbox for a runtime probe.
 *
 * - `host`: probe runs directly on the operator's machine. Explicit opt-in.
 *   Cheapest; most dangerous. Authors choosing `host` acknowledge the probe
 *   may touch host state (ports, systemd units, filesystem) and take
 *   responsibility for cleanup.
 * - `twin`: probe runs inside an ephemeral sandbox brokered by the Digital
 *   Twin subsystem (Epic 47). Twin integration is **deferred to Phase 3** —
 *   probes with `sandbox: twin` currently emit a `probe-deferred` warn
 *   finding rather than executing. Authors can declare twin-scoped probes
 *   today and they will execute transparently once Phase 3 lands.
 */
export const RuntimeProbeSandboxSchema = z.enum(['host', 'twin'])
export type RuntimeProbeSandbox = z.infer<typeof RuntimeProbeSandboxSchema>

// ---------------------------------------------------------------------------
// RuntimeProbe — one author-declared probe
// ---------------------------------------------------------------------------

/**
 * Default per-probe timeout in milliseconds. Matches the existing
 * BuildCheck ceiling (60 s) — deliberate, so probe timeouts are bounded
 * by the same policy the pipeline already uses for long-running checks.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000

/** Hard upper bound on per-probe stdout/stderr retention (≤ 4 KiB — the
 *  same convention as VerificationFinding.{stdoutTail,stderrTail}). */
export const PROBE_TAIL_BYTES = 4 * 1024

/**
 * Zod schema for one runtime probe declared in a story's
 * `## Runtime Probes` section.
 *
 * Required fields (`name`, `sandbox`, `command`) force authors to make
 * intent explicit — no silent defaults that could mask a miswritten probe.
 * Optional fields cover operational knobs with sensible fallbacks.
 */
export const RuntimeProbeSchema = z.object({
  /** Stable, unique-within-story identifier used in finding messages and logs. */
  name: z.string().min(1, 'probe name is required'),
  /** Where the probe runs. See RuntimeProbeSandboxSchema. */
  sandbox: RuntimeProbeSandboxSchema,
  /** Shell command line(s). Passed to a detached `sh -c` wrapper on host execution. */
  command: z.string().min(1, 'probe command is required'),
  /** Optional per-probe timeout in ms. Defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  timeout_ms: z.number().int().positive().optional(),
  /** Optional human-readable description. Surfaced in finding messages. */
  description: z.string().optional(),
})

export type RuntimeProbe = z.infer<typeof RuntimeProbeSchema>

/** Zod schema for the full list (wrapping the per-probe schema). */
export const RuntimeProbeListSchema = z.array(RuntimeProbeSchema)

// ---------------------------------------------------------------------------
// Parse outcomes
// ---------------------------------------------------------------------------

/**
 * Result of parsing the `## Runtime Probes` section from story markdown.
 *
 * Parsing never throws — instead it returns one of three variants so the
 * VerificationCheck can distinguish and emit appropriate findings:
 *
 * - `absent`:  section missing entirely. Treat as "no probes declared" →
 *              check emits pass with skip note. Backward compat for every
 *              story authored before Phase 2.
 * - `parsed`:  section present, YAML valid, all entries match
 *              RuntimeProbeSchema. `probes` is the parsed array (may be
 *              empty if the YAML list was intentionally `[]`).
 * - `invalid`: section present but YAML is malformed, the root value is
 *              not a list, or at least one entry fails schema validation.
 *              The check surfaces `invalid` as a fail finding with the
 *              original parse error so authors see the exact problem.
 */
export type RuntimeProbeParseResult =
  | { kind: 'absent' }
  | { kind: 'parsed'; probes: RuntimeProbe[] }
  | { kind: 'invalid'; error: string }

// ---------------------------------------------------------------------------
// Probe execution result
// ---------------------------------------------------------------------------

/**
 * Outcome of one probe execution.
 *
 * Mirrors the optional `{command, exitCode, stdoutTail, stderrTail,
 * durationMs}` surface on VerificationFinding so the RuntimeProbeCheck can
 * lift ProbeResult fields into a finding with minimal translation.
 *
 * `outcome` disambiguates the three terminal states the check cares about:
 *
 * - `pass`:    command exited 0 within its timeout.
 * - `fail`:    command exited non-zero within its timeout.
 * - `timeout`: probe exceeded its timeout and was killed. `exitCode` is
 *              undefined (the process never reported one).
 */
export interface ProbeResult {
  outcome: 'pass' | 'fail' | 'timeout'
  command: string
  exitCode?: number
  stdoutTail: string
  stderrTail: string
  durationMs: number
}
