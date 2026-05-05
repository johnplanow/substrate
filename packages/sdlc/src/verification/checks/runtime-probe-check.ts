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
 *   - No probes declared                                → pass (skip note finding array is empty)
 *   - Probes declared, YAML invalid                     → fail (one finding per parse error)
 *   - Probe `sandbox: twin`                             → warn (deferred until Phase 3)
 *   - Probe `sandbox: host`, exit 0, no assertions      → pass; no finding emitted for that probe
 *   - Probe `sandbox: host`, exit 0, assertions all met → pass; no finding emitted
 *   - Probe `sandbox: host`, exit 0, assertion missed   → fail (runtime-probe-assertion-fail) [Story 60-4]
 *   - Probe `sandbox: host`, exit ≠ 0                   → fail (exit code + stdout/stderr tails)
 *   - Probe `sandbox: host`, timed out                  → fail (runtime-probe-timeout category)
 *   - No storyContent on context                        → warn (cannot verify without story text)
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
import { parseStoryFrontmatter } from '../../run-model/story-artifact-schema.js'

// ---------------------------------------------------------------------------
// Finding categories
// ---------------------------------------------------------------------------

const CATEGORY_PARSE = 'runtime-probe-parse-error'
const CATEGORY_SKIP = 'runtime-probe-skip'
const CATEGORY_DEFERRED = 'runtime-probe-deferred'
const CATEGORY_FAIL = 'runtime-probe-fail'
const CATEGORY_TIMEOUT = 'runtime-probe-timeout'
/**
 * Story 60-4: command exited 0 but a stdout-shape assertion declared by the
 * author tripped. Distinct from `runtime-probe-fail` (non-zero exit code)
 * so retry prompts and post-run analysis can tell "tool crashed politely"
 * from "tool errored loudly".
 */
const CATEGORY_ASSERTION_FAIL = 'runtime-probe-assertion-fail'
/**
 * Story 63-2: command exited 0 and no author-declared assertion tripped,
 * but the captured stdout contains a canonical error-envelope shape
 * (`"isError": true`, `"status": "error"`). Defense-in-depth against
 * under-test probes that count tool advertisement without checking
 * response shape — the structural fix for obs_2026-04-25_012 (REOPENED).
 * Distinct from CATEGORY_ASSERTION_FAIL because the author DIDN'T declare
 * an assertion; the executor caught the error envelope automatically.
 */
const CATEGORY_ERROR_RESPONSE = 'runtime-probe-error-response'
/**
 * Story 60-11: source AC describes an event-driven mechanism (hook, timer,
 * signal, webhook) but no probe's command invokes a known production-trigger
 * pattern. Strata Run 13 (Story 1-12, 2026-04-26): vault conflict hook
 * shipped SHIP_IT non-functional because the dev's probe ran the hook script
 * directly with `bash .git/hooks/post-merge` — git only fires post-merge on
 * a SUCCESSFUL merge, so under conflict (the hook's actual use case) the
 * production trigger never fires. Direct-invocation probe missed it; only
 * e2e smoke caught it. Sibling to obs_012's success-shape gap.
 *
 * Severity is warn (advisory, non-blocking) until the heuristic is
 * calibrated against several runs. Flip to error once false-positive rate
 * is verified low.
 */
const CATEGORY_MISSING_TRIGGER = 'runtime-probe-missing-production-trigger'
/**
 * Story 64-2: story declares `external_state_dependencies` in its frontmatter
 * but has no `## Runtime Probes` section. The machine-readable declaration
 * confirms the author knows the story interacts with external state, so the
 * missing probes section is a hard gate — not just advisory.
 * Distinct from `runtime-probe-missing-production-trigger` (which fires when
 * probes are present but don't invoke a production trigger for event-driven ACs).
 */
const CATEGORY_MISSING_PROBES_DECLARED = 'runtime-probe-missing-declared-probes'
/**
 * Story 66-7: probe exited non-zero AND stderr/stdout contained a placeholder
 * token that was never substituted before execution (e.g. `<REPO_ROOT>`,
 * `<CONFIG_DIR>`, `<UNKNOWN_VAR>`). Distinct from `runtime-probe-fail`
 * (genuine runtime failure) so operators and probe-author quality dashboards
 * can carve placeholder substitution failures out for cleaner triage and
 * metrics. Severity: `error` (matches `runtime-probe-fail` baseline).
 * Closes obs_2026-05-04_024 fix #3.
 */
const CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED = 'runtime-probe-placeholder-not-substituted'

// ---------------------------------------------------------------------------
// Story 60-11: event-driven trigger heuristic
// ---------------------------------------------------------------------------

/**
 * Source-AC keywords that signal an event-driven implementation. Word-boundary
 * matched, case-insensitive. When any of these appears in source AC text AND
 * no probe's command invokes a known production trigger, the check emits a
 * `runtime-probe-missing-production-trigger` warn finding.
 *
 * Each keyword is paired with the trigger patterns that satisfy it:
 *   - `git hook` / `post-merge` / etc. → satisfied by `git merge|pull|push|commit|rebase`
 *   - `systemd` / `timer` / `unit` → satisfied by `systemctl ... start|enable|trigger`
 *   - `cron` / `crontab` / `schedule` → satisfied by `crontab|run-parts|schedule`
 *   - `signal` / `SIGHUP|SIGTERM|SIGUSR` → satisfied by `kill -<signal>`
 *   - `webhook` / `HTTP POST` / `endpoint` → satisfied by `curl ... -X POST` or wget
 *   - `inotify` / `path watch` → satisfied by `touch|mkdir|rm` (filesystem mutation)
 */
const EVENT_DRIVEN_KEYWORDS = [
  /\b(?:git\s+hook|post-merge|post-commit|post-rewrite|pre-push|pre-commit|pre-merge-commit)\b/i,
  /\b(?:systemd\s+(?:unit|service|timer|path)|systemctl|\.timer\b|\.service\b)\b/i,
  /\b(?:cron\s*(?:job|tab|expression)?|crontab|scheduled\s+task)\b/i,
  /\b(?:signal\s+handler|SIG(?:HUP|TERM|INT|USR1|USR2|KILL))\b/,
  /\b(?:webhook|HTTP\s+(?:POST|GET)\s+endpoint|REST\s+endpoint)\b/i,
  /\b(?:inotify|path\s+watch|file\s+watcher)\b/i,
]

/**
 * Production-trigger command patterns. If ANY probe's command matches one of
 * these, the heuristic considers the trigger covered. Word-boundary matched.
 */
const TRIGGER_COMMAND_PATTERNS = [
  /\bgit\s+(?:merge|pull|push|commit|rebase|cherry-pick)\b/,
  /\bsystemctl\b/,
  /\bcrontab\b|\brun-parts\b/,
  /\bkill\s+-/,
  /\bcurl\s+(?:[^|]*\s)?-X\s+(?:POST|GET|PUT|DELETE)/i,
  /\bwget\s+--method=(?:POST|GET|PUT|DELETE)/i,
  /\b(?:touch|mkdir|rm)\s+/, // filesystem-watch triggers
]

/**
 * Returns true if the source AC text mentions an event-driven mechanism.
 *
 * Exported for use by probe-author-integration.ts (Story 60-13) so the
 * orchestrator can gate probe-author dispatch on the same heuristic.
 */
export function detectsEventDrivenAC(sourceEpicContent: string): boolean {
  for (const pattern of EVENT_DRIVEN_KEYWORDS) {
    if (pattern.test(sourceEpicContent)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Story 65-1: state-integrating AC detection heuristic
// ---------------------------------------------------------------------------

/**
 * Source-AC keywords that signal a state-integrating implementation. The six
 * categories — subprocess, filesystem, git, database, network, registry —
 * mirror the behavioral-signal enumeration in the create-story.md prompt
 * (Phase 1, v0.20.42, obs_2026-05-01_017 hotfix).
 *
 * Code identifiers are case-sensitive (e.g., `execSync(`, `Dolt`).
 * Natural-language phrases are case-insensitive (e.g., "reads from disk").
 *
 * Used by `detectsStateIntegratingAC` to gate probe-author dispatch for
 * state-integrating stories whose ACs do NOT use event-driven phrasing
 * (hooks, timers, signals, webhooks). Coexists with `EVENT_DRIVEN_KEYWORDS`:
 * ACs matching both heuristics trigger a single probe-author dispatch.
 */
const STATE_INTEGRATING_KEYWORDS: RegExp[] = [
  // ---- subprocess (code identifiers: case-sensitive) ----
  /\bexecSync\(/,
  /\bspawn\(/,
  /\bexec\(/,
  /\bchild_process\b/,
  // ---- subprocess (natural-language phrases: case-insensitive) ----
  /\bspawns\b/i,
  /\binvokes?\b/i,

  // ---- filesystem (code identifiers: case-sensitive) ----
  /\bfs\.read/,
  /\bfs\.write/,
  /\breadFile\b/,
  /\bwriteFile\b/,
  /\bpath\.join\b/,
  /\bhomedir\(\)/,
  /\bos\.homedir\(\)/,
  // ---- filesystem (natural-language phrases: case-insensitive) ----
  /\breads?\s+from\s+disk\b/i,
  /\bwrites?\s+to\s+disk\b/i,
  /\bscans?\s+(?:the\s+)?filesystem\b/i,

  // ---- git (commands: case-sensitive for `git log`, etc.) ----
  /\bgit\s+log\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+merge\b/,
  // ---- git (natural-language phrases: case-insensitive) ----
  /\bqueries?\s+git\b/i,
  /\bruns?\s+git\b/i,

  // ---- database (identifiers / technology names) ----
  /\bDolt\b/, // proper noun — case-sensitive
  /\bmysql\b/i,
  /\bpg\b/, // PostgreSQL client library — case-sensitive to reduce noise
  /\bsqlite\b/i,
  /\bINSERT\b/, // SQL DML keyword — uppercase (case-sensitive)
  /\bSELECT\b/, // SQL DML keyword — uppercase (case-sensitive)
  // ---- database (natural-language phrases: case-insensitive) ----
  /\bqueries?\s+the\s+database\b/i,
  /\bwrites?\s+to\s+[Dd]olt\b/,

  // ---- network (code identifiers: case-sensitive) ----
  /\bfetch\(/,
  /\baxios\b/i,
  /\bhttp\.get\(/,
  /\bhttps\.get\(/,
  // ---- network (natural-language phrases: case-insensitive) ----
  /\bfetches?\b/i,
  /\bPOSTs?\s+to\b/i,
  /\bcalls?\s+the\s+API\b/i,

  // ---- registry (natural-language phrases: case-insensitive) ----
  /\bqueries?\s+(?:the\s+)?registry\b/i,
  /\bscans?\s+(?:the\s+)?registry\b/i,
]

/** Phrases that indicate a keyword match is in a mock/stub context (not real state). */
const MOCK_QUALIFIER_PHRASES = ['mocks the', 'stubs the', 'mock ', 'stub '] as const

/**
 * Returns true when a line contains a mock/stub qualifier, indicating the
 * keyword match is in a test-double context rather than production state.
 */
function lineHasMockQualifier(line: string): boolean {
  const lower = line.toLowerCase()
  return MOCK_QUALIFIER_PHRASES.some((phrase) => lower.includes(phrase))
}

/**
 * Returns true if the source AC text mentions a state-integrating operation:
 * subprocess, filesystem, git, database, network, or registry interaction.
 *
 * Exported for use by probe-author-integration.ts (Story 65-1) so the
 * orchestrator can gate probe-author dispatch on the same heuristic.
 *
 * Mock guard (AC #4): scans each matching line for mock/stub qualifiers
 * ("mocks the", "stubs the", "mock ", "stub "). If every match is in a
 * mock context, returns false — ground truth is whether the production
 * code path hits real state. If any match is NOT in a mock context,
 * returns true.
 *
 * Coexists with `detectsEventDrivenAC` (Story 60-11): when an AC matches
 * both heuristics, the orchestrator dispatches probe-author once (dispatch
 * gate uses `||`). No double-dispatch.
 */
export function detectsStateIntegratingAC(sourceContent: string): boolean {
  const lines = sourceContent.split('\n')
  for (const line of lines) {
    const hasKeyword = STATE_INTEGRATING_KEYWORDS.some((p) => p.test(line))
    if (hasKeyword && !lineHasMockQualifier(line)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Story 66-7: placeholder-leakage detection helper
// ---------------------------------------------------------------------------

/**
 * Detects whether a probe's combined output (stderr + stdout) contains an
 * unrecognized placeholder token that was not substituted before execution.
 *
 * Two shapes are handled:
 *
 * Shape 1 — command-line tool "no such file" with placeholder argument:
 *   `grep: <REPO_ROOT>: No such file or directory`
 *   `bash: <CONFIG_DIR>: command not found`
 *   Regex (multiline): `/^[\w]*:\s*(<[A-Z_]+>):?/m`
 *
 * Shape 2 — shell syntax error adjacent to a placeholder token:
 *   Combined output contains `Syntax error: "&&" unexpected` AND a `<TOKEN>`.
 *
 * Returns the captured `<TOKEN>` string if the placeholder leakage pattern
 * fires, or `null` if no placeholder is detected (allowing the existing
 * `CATEGORY_FAIL` path to proceed unmodified).
 *
 * Exported (mirrors the export pattern of `detectNegationContextLines`,
 * `detectDependencyContextLines`, `detectsEventDrivenAC`) so tests and
 * downstream consumers can call it directly.
 */
export function detectPlaceholderLeakage(output: string): string | null {
  // Shape 1: command-line tool error line with placeholder argument
  const shape1Match = /^[\w]*:\s*(<[A-Z_]+>):?/m.exec(output)
  if (shape1Match !== null) {
    return shape1Match[1] ?? null
  }

  // Shape 2: shell syntax error adjacent to a placeholder token
  if (output.includes('Syntax error: "&&" unexpected')) {
    const tokenMatch = /(<[A-Z_]+>)/.exec(output)
    if (tokenMatch !== null) {
      return tokenMatch[1] ?? null
    }
  }

  return null
}

/**
 * Returns true if any probe's command line invokes a known production trigger.
 */
function probesInvokeProductionTrigger(probes: { command: string }[]): boolean {
  for (const probe of probes) {
    for (const pattern of TRIGGER_COMMAND_PATTERNS) {
      if (pattern.test(probe.command)) return true
    }
  }
  return false
}

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
      // Story 64-2: when the story frontmatter declares external_state_dependencies
      // but no ## Runtime Probes section exists, escalate to error and hard-gate
      // SHIP_IT. The frontmatter field is the machine-readable declaration that
      // confirms the author knows this story interacts with external state — a
      // missing probes section is unambiguous non-compliance, not ambiguous.
      // Distinct from the obs_016 detectsEventDrivenAC escalation in
      // source-ac-fidelity-check.ts — different code path, different check.
      const frontmatter = parseStoryFrontmatter(context.storyContent)
      if (frontmatter.external_state_dependencies.length > 0) {
        const findings: VerificationFinding[] = [
          {
            category: CATEGORY_MISSING_PROBES_DECLARED,
            severity: 'error',
            message:
              'story declares external_state_dependencies but has no `## Runtime Probes` section — probes required per obs_2026-05-01_017.',
          },
        ]
        return {
          status: 'fail',
          details: renderFindings(findings),
          duration_ms: Date.now() - start,
          findings,
        }
      }
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

    // Story 60-11: event-driven AC + missing-trigger heuristic. Runs once
    // per check invocation against the parsed probe list and the source AC
    // text. If the source AC describes an event-driven mechanism (hook,
    // timer, signal, webhook) AND no probe's command invokes a known
    // production-trigger pattern, emit an advisory warn finding so the
    // dev-story retry prompt and post-run analysis can flag the gap. Does
    // not block (severity: warn) until calibrated.
    if (context.sourceEpicContent !== undefined) {
      if (
        detectsEventDrivenAC(context.sourceEpicContent) &&
        !probesInvokeProductionTrigger(parsed.probes)
      ) {
        // Story 60-16: severity flipped from `warn` to `error` after Epic 60
        // Phase 2's GREEN eval result (4/4 catch rate, v0.20.39). probe-author
        // is now the recommended path for event-driven stories — when a
        // dev-authored probe set fails to invoke any production trigger AND
        // probe-author didn't run (or its probes also skipped the trigger),
        // that's architectural drift, not advisory. Gate becomes blocking.
        // Guidance: probe-author phase produces probes that exercise the
        // production trigger by design; missing-trigger findings should be
        // exceedingly rare on stories where probe-author dispatched.
        findings.push({
          category: CATEGORY_MISSING_TRIGGER,
          severity: 'error',
          message:
            `source AC describes an event-driven mechanism (hook / timer / signal / webhook) ` +
            `but no probe's command invokes a known production trigger ` +
            `(git merge/pull/push, systemctl, crontab, kill -<sig>, curl -X POST, etc.). ` +
            `Probes that call the implementation directly skip the wiring layer ` +
            `the AC's user-facing event would exercise — see strata Run 13 / Story 1-12 ` +
            `for the canonical case (post-merge hook never fires under git's conflict semantic). ` +
            `Authoring guidance: probes/event-driven section of create-story.md, ` +
            `or invoke probe-author to derive AC-grounded probes automatically (Epic 60 Phase 2).`,
        })
      }
    }

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

      const descriptor = probe.description ? ` (${probe.description})` : ''

      if (result.outcome === 'timeout') {
        findings.push({
          category: CATEGORY_TIMEOUT,
          severity: 'error',
          message: `probe "${probe.name}"${descriptor} timed out after ${result.durationMs}ms`,
          command: result.command,
          stdoutTail: result.stdoutTail,
          stderrTail: result.stderrTail,
          durationMs: result.durationMs,
          _authoredBy: probe._authoredBy ?? 'create-story-ac-transfer',
        })
        continue
      }

      if (result.assertionFailures !== undefined) {
        findings.push({
          category: CATEGORY_ASSERTION_FAIL,
          severity: 'error',
          message:
            `probe "${probe.name}"${descriptor} exit 0 but stdout assertion failed: ` +
            result.assertionFailures.join('; '),
          command: result.command,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          stdoutTail: result.stdoutTail,
          stderrTail: result.stderrTail,
          durationMs: result.durationMs,
          _authoredBy: probe._authoredBy ?? 'create-story-ac-transfer',
        })
        continue
      }

      if (result.errorShapeIndicators !== undefined) {
        findings.push({
          category: CATEGORY_ERROR_RESPONSE,
          severity: 'error',
          message:
            `probe "${probe.name}"${descriptor} exit 0 but response contained error envelope: ` +
            result.errorShapeIndicators.join('; ') +
            ` — the tool returned an error-shaped JSON response despite a clean exit code. ` +
            `This is structural evidence the implementation didn't actually work; ` +
            `add an explicit \`expect_stdout_no_regex\` assertion to make the failure ` +
            `surface earlier in author-controlled form.`,
          command: result.command,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          stdoutTail: result.stdoutTail,
          stderrTail: result.stderrTail,
          durationMs: result.durationMs,
          _authoredBy: probe._authoredBy ?? 'create-story-ac-transfer',
        })
        continue
      }

      // Story 66-7: check for placeholder leakage BEFORE emitting CATEGORY_FAIL.
      // Combine stderrTail and stdoutTail for detection; if a placeholder token
      // is found, emit CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED instead.
      // CATEGORY_ERROR_RESPONSE and CATEGORY_ASSERTION_FAIL are already handled
      // above (exit-0 paths), so placeholder detection only applies here in the
      // exit-non-zero path. Closes obs_2026-05-04_024 fix #3.
      const outputForDetection = `${result.stderrTail ?? ''}\n${result.stdoutTail ?? ''}`
      const placeholderToken = detectPlaceholderLeakage(outputForDetection)
      if (placeholderToken !== null) {
        findings.push({
          category: CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED,
          severity: 'error',
          message: `Probe failed: unrecognized placeholder token "${placeholderToken}" was not substituted before execution`,
          command: result.command,
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          stdoutTail: result.stdoutTail,
          stderrTail: result.stderrTail,
          durationMs: result.durationMs,
          unrecognizedPlaceholder: placeholderToken,
          _authoredBy: probe._authoredBy ?? 'create-story-ac-transfer',
        })
        continue
      }

      // Story 60-15: copy `_authoredBy` from the probe onto the finding so
      // downstream consumers (rollupProbeAuthorMetrics, byAuthor breakdown
      // in status/metrics CLI) can attribute the failure to its author.
      // Probes without the field default to `'create-story-ac-transfer'`
      // — pre-60-15 manifests + the legacy create-story AC-transfer path.
      findings.push({
        category: CATEGORY_FAIL,
        severity: 'error',
        message: `probe "${probe.name}"${descriptor} failed with exit ${result.exitCode ?? 'unknown'}`,
        command: result.command,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        durationMs: result.durationMs,
        _authoredBy: probe._authoredBy ?? 'create-story-ac-transfer',
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
