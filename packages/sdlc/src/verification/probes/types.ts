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
 *
 * Story 60-4: `expect_stdout_no_regex` and `expect_stdout_regex` close the
 * exit-0-with-error-body gap. A probe that calls a tool returning HTTP 200
 * with `{"isError": true}` (MCP convention) or `{"status": "error"}` (REST
 * convention) exits 0 — exit-code-only verification accepts the broken tool
 * as passing. Authors of probes that hit MCP / REST / JSON-RPC / A2A surfaces
 * declare success-shape patterns to assert response payload structure beyond
 * the shell exit code. Driven by strata Run 12 evidence: four MCP tools
 * shipped SHIP_IT while throwing real Python TypeErrors against real data.
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
  /**
   * Optional regex patterns that stdout must NOT match. If any pattern
   * matches stdout, the probe is failed (outcome → 'fail', category →
   * `runtime-probe-assertion-fail`) even when the shell exit code is 0.
   * Use to assert the absence of structured-error payloads in tools that
   * return HTTP 200 with an error body — `'"isError"\\s*:\\s*true'`,
   * `'"status"\\s*:\\s*"error"'`, etc.
   */
  expect_stdout_no_regex: z.array(z.string().min(1)).optional(),
  /**
   * Optional regex patterns that stdout MUST match. Each pattern in the list
   * must match stdout at least once; missing matches fail the probe with
   * category `runtime-probe-assertion-fail`. Use to assert AC-specific
   * success structure (e.g. for a search tool: `'"similarity_score"'` must
   * appear in the response).
   */
  expect_stdout_regex: z.array(z.string().min(1)).optional(),
  /**
   * Story 60-15: discriminator identifying who authored the probe. Set to
   * `'probe-author'` by `runProbeAuthor` when the probe-author phase
   * appended it to the artifact. Absence (or explicit
   * `'create-story-ac-transfer'`) means the probe was carried over from
   * the create-story AC-transfer step (the legacy path before Epic 60
   * Phase 2). Powers per-author breakdowns in `substrate status`/`metrics`
   * JSON output and the cross-run probe-author catch-rate KPI.
   *
   * Backward-compat: pre-60-15 manifests have no `_authoredBy` field on
   * their stored probes. The byAuthor breakdown treats absent as
   * `'create-story-ac-transfer'`.
   */
  _authoredBy: z.enum(['probe-author', 'create-story-ac-transfer']).optional(),
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
  /**
   * Story 60-4: populated when `outcome === 'fail'` because a stdout
   * assertion (`expect_stdout_no_regex` or `expect_stdout_regex`) tripped,
   * not because the shell exit code was non-zero. Each entry is a
   * human-readable description of which pattern failed and why.
   * Distinguishes assertion failures from exit-code failures so the check
   * can route to `runtime-probe-assertion-fail` vs `runtime-probe-fail`.
   */
  assertionFailures?: string[]
  /**
   * Story 63-2: populated when the probe exited 0 but stdout contained a
   * canonical error-envelope shape (`"isError": true`, `"status":
   * "error"`). Defense-in-depth against probes that under-test by
   * asserting presence-of-response without checking shape — the
   * structural fix for obs_2026-04-25_012 (REOPENED). Distinguishes
   * error-envelope failures from author-declared-assertion failures so
   * the check can route to `runtime-probe-error-response` and operators
   * can tell "tool returned an error envelope" from "author assertion
   * tripped on a stylistic concern".
   */
  errorShapeIndicators?: string[]
}
