/**
 * RuntimeProbeCheck — Epic 55 / Phase 2.
 *
 * Tier A verification check that parses and executes the author-declared
 * runtime probes in a story's `## Runtime Probes` section. Each probe's
 * outcome becomes a structured VerificationFinding, leveraging the
 * Phase 1 persistence surface to flow through retry prompts, the run
 * manifest, and post-run analysis without string-parsing.
 *
 * Architecture / scoring contract:
 *
 *   - No probes declared                  → pass (skip note finding array is empty)
 *   - Probes declared, YAML invalid       → fail (one finding per parse error)
 *   - Probe `sandbox: twin`               → warn (deferred until Phase 3)
 *   - Probe `sandbox: host`, exit 0       → pass; no finding emitted for that probe
 *   - Probe `sandbox: host`, exit ≠ 0     → fail (exit code + stdout/stderr tails)
 *   - Probe `sandbox: host`, timed out    → fail (runtime-probe-timeout category)
 *   - No storyContent on context          → warn (cannot verify without story text)
 *
 * Registered last in the canonical Tier A pipeline, after BuildCheck,
 * because probes may depend on a successful build's output.
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'
import { renderFindings } from '../findings.js'
import {
  parseRuntimeProbes,
  executeProbeOnHost,
  type ProbeResult,
  type RuntimeProbe,
} from '../probes/index.js'

// ---------------------------------------------------------------------------
// Finding categories
// ---------------------------------------------------------------------------

const CATEGORY_PARSE = 'runtime-probe-parse-error'
const CATEGORY_SKIP = 'runtime-probe-skip'
const CATEGORY_DEFERRED = 'runtime-probe-deferred'
const CATEGORY_FAIL = 'runtime-probe-fail'
const CATEGORY_TIMEOUT = 'runtime-probe-timeout'

// ---------------------------------------------------------------------------
// Execution wiring
// ---------------------------------------------------------------------------

/**
 * Per-sandbox executors, injected via constructor so tests (and future
 * twin integration in Phase 3) can swap implementations without touching
 * the check's dispatch logic.
 */
export interface RuntimeProbeExecutors {
  host: (probe: RuntimeProbe) => Promise<ProbeResult>
  /** Twin execution is deferred; the default returns undefined so the check
   *  emits a `probe-deferred` warn finding. Phase 3 replaces this. */
  twin?: (probe: RuntimeProbe) => Promise<ProbeResult> | undefined
}

const defaultExecutors: RuntimeProbeExecutors = {
  host: (probe) => executeProbeOnHost(probe, { cwd: process.cwd() }),
  // twin intentionally omitted → RuntimeProbeCheck emits a warn finding
}

// ---------------------------------------------------------------------------
// RuntimeProbeCheck
// ---------------------------------------------------------------------------

export class RuntimeProbeCheck implements VerificationCheck {
  readonly name = 'runtime-probes'
  readonly tier = 'A' as const

  private readonly _executors: RuntimeProbeExecutors

  constructor(executors?: Partial<RuntimeProbeExecutors>) {
    this._executors = {
      ...defaultExecutors,
      ...(executors ?? {}),
    }
  }

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    // Story content is required to locate the `## Runtime Probes` section.
    // Absence is treated as a warn so reviewers know the check could not
    // make a decision, distinct from "present but no probes declared".
    if (context.storyContent === undefined) {
      const findings: VerificationFinding[] = [
        {
          category: CATEGORY_SKIP,
          severity: 'warn',
          message: 'story content unavailable — skipping runtime probe check',
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const parsed = parseRuntimeProbes(context.storyContent)

    if (parsed.kind === 'absent') {
      return {
        status: 'pass',
        details: 'runtime-probes: no ## Runtime Probes section declared — skipping',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }

    if (parsed.kind === 'invalid') {
      const findings: VerificationFinding[] = [
        {
          category: CATEGORY_PARSE,
          severity: 'error',
          message: parsed.error,
        },
      ]
      return {
        status: 'fail',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // kind === 'parsed'. Empty list is a valid author-declared state
    // (e.g. they declared the section but intentionally zero probes yet);
    // treat identically to `absent` for the verdict.
    if (parsed.probes.length === 0) {
      return {
        status: 'pass',
        details: 'runtime-probes: 0 probes declared — skipping',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }

    const findings: VerificationFinding[] = []
    for (const probe of parsed.probes) {
      if (probe.sandbox === 'twin') {
        findings.push({
          category: CATEGORY_DEFERRED,
          severity: 'warn',
          message:
            `probe "${probe.name}" uses sandbox=twin which is deferred until ` +
            `Phase 3 (Digital Twin integration); skipping`,
        })
        continue
      }

      // sandbox === 'host'
      const result = await this._executors.host(probe)
      if (result.outcome === 'pass') {
        continue
      }

      const category = result.outcome === 'timeout' ? CATEGORY_TIMEOUT : CATEGORY_FAIL
      const descriptor = probe.description ? ` (${probe.description})` : ''
      const message =
        result.outcome === 'timeout'
          ? `probe "${probe.name}"${descriptor} timed out after ${result.durationMs}ms`
          : `probe "${probe.name}"${descriptor} failed with exit ${result.exitCode ?? 'unknown'}`

      findings.push({
        category,
        severity: 'error',
        message,
        command: result.command,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        durationMs: result.durationMs,
      })
    }

    const status = findings.some((f) => f.severity === 'error')
      ? 'fail'
      : findings.some((f) => f.severity === 'warn')
        ? 'warn'
        : 'pass'

    return {
      status,
      details:
        findings.length > 0
          ? renderFindings(findings)
          : `runtime-probes: ${parsed.probes.length} probe(s) passed`,
      duration_ms: Date.now() - start,
      findings,
    }
  }
}
