/**
 * TestSuiteCheck — Tier A verification check that runs the project's REAL test
 * suite in its REAL environment (H1.2, hardening program).
 *
 * Field finding #11 (income-sources, 2026-07-04): a story passed ALL SIX
 * verification checks while `pytest` had a genuinely failing test in the
 * worktree — nothing in the pipeline ever executed the project's tests; the
 * "tests pass" signal was the dev agent's self-report. This check is the
 * ground-truth antidote (the industry-consensus fix: SWE-bench/OpenHands run
 * the real suite in the real toolchain and gate on the result).
 *
 * Command resolution:
 *   1. `context.testCommand` override when provided (plumbed the same way as
 *      `buildCommand`).
 *   2. `project.testCommand` from `.substrate/project-profile.yaml` under the
 *      working dir (the profile reaches worktrees via H1.1's gitignore
 *      negation + createWorktree copy). For a uv project this is
 *      `uv run pytest` — the suite runs INSIDE the project venv.
 *   3. No command found → warn-skip (`test-suite-skip`), never a false fail.
 *
 * Execution mirrors BuildCheck (FR-V9: no LLM; FR-V11: detached process
 * group, hard-killed on timeout). The timeout is longer than the build
 * check's — real suites legitimately take minutes.
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationResult,
  VerificationFinding,
} from '../types.js'
import { renderFindings } from '../findings.js'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Hard ceiling for the suite run (ms). Suites are slower than builds. */
export const TEST_SUITE_CHECK_TIMEOUT_MS = 300_000

/** Cap on captured output embedded in the finding. */
const MAX_OUTPUT_CHARS = 4_000

function tail(s: string, n = 2_000): string {
  return s.length > n ? s.slice(-n) : s
}

/**
 * Read `project.testCommand` from `.substrate/project-profile.yaml` under
 * `workingDir`. Line-based parse (no yaml dependency; same pattern as
 * detectBuildCommand's profile read). Returns undefined when absent.
 */
export function detectTestCommand(workingDir: string): string | undefined {
  const profilePath = join(workingDir, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) return undefined
  try {
    const content = readFileSync(profilePath, 'utf-8')
    const match = content.match(/^\s*testCommand:\s*['"]?(.+?)['"]?\s*$/m)
    if (match?.[1] !== undefined && match[1].length > 0) return match[1]
  } catch {
    // Unreadable profile — treated as no test command (warn-skip).
  }
  return undefined
}

export class TestSuiteCheck implements VerificationCheck {
  readonly name = 'test-suite'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    // Empty-string override means EXPLICIT SKIP (BuildCheck contract parity) —
    // it must NOT fall through to profile detection. Getting this wrong made
    // the check spawn `npm test` recursively inside substrate's own test
    // suite (orphaning 25 vitest processes in one session) despite callers
    // passing testCommand: ''.
    const explicitOverride = context.testCommand !== undefined
    const cmd = explicitOverride ? context.testCommand : detectTestCommand(context.workingDir)

    // GUARDRAIL (workstation protection): never launch an ambient-DETECTED
    // test suite from inside a test runner. Without this, any test that runs
    // the default pipeline against a repo whose profile has a testCommand
    // recursively spawns that repo's ENTIRE suite — one such bug orphaned 25
    // vitest processes and nearly took the operator's workstation down on
    // memory. Vitest sets VITEST in every worker and the env is inherited by
    // spawned children, so this also protects nested substrate-in-tests
    // scenarios. An EXPLICIT context.testCommand bypasses the guard (the
    // caller has taken responsibility — e.g. fixtures passing 'true'); a
    // harness that needs ambient detection under a test runner sets
    // SUBSTRATE_ALLOW_NESTED_TESTS=1.
    if (
      !explicitOverride &&
      process.env.VITEST !== undefined &&
      process.env.SUBSTRATE_ALLOW_NESTED_TESTS !== '1'
    ) {
      const findings: VerificationFinding[] = [
        {
          category: 'test-suite-skip',
          severity: 'warn',
          message:
            'recursion guard: refusing to run an auto-detected test suite from inside a test ' +
            'runner (VITEST is set). Pass an explicit testCommand, or set ' +
            'SUBSTRATE_ALLOW_NESTED_TESTS=1 in a harness that deliberately nests suite execution.',
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    if (cmd === undefined || cmd === '') {
      const findings: VerificationFinding[] = [
        {
          category: 'test-suite-skip',
          severity: 'warn',
          message:
            `no test command configured for project at ${context.workingDir} — ` +
            `set project.testCommand in .substrate/project-profile.yaml (substrate init detects it) ` +
            `so verification runs the real suite`,
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    return new Promise<VerificationResult>((resolve) => {
      // GUARDRAIL (workstation protection): cap the suite's Node heap so a
      // runaway test process cannot exhaust host memory (mirrors the
      // dispatcher's per-agent NODE_OPTIONS cap, sized up for real suites).
      const env: NodeJS.ProcessEnv = { ...process.env }
      const parentNodeOpts = env['NODE_OPTIONS'] ?? ''
      if (!parentNodeOpts.includes('--max-old-space-size')) {
        env['NODE_OPTIONS'] = `${parentNodeOpts} --max-old-space-size=2048`.trim()
      }

      const child = spawn(cmd, [], {
        cwd: context.workingDir,
        detached: true,
        shell: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let output = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        const s = chunk.toString()
        stdout += s
        output += s
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const s = chunk.toString()
        stderr += s
        output += s
      })

      const timeoutHandle = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          // Process already exited between timeout fire and kill call
        }
        const duration = Date.now() - start
        const findings: VerificationFinding[] = [
          {
            category: 'test-suite-timeout',
            severity: 'error',
            message: `test suite exceeded ${TEST_SUITE_CHECK_TIMEOUT_MS}ms`,
            command: cmd,
            stdoutTail: tail(stdout),
            stderrTail: tail(stderr),
            durationMs: duration,
          },
        ]
        resolve({
          status: 'fail',
          details: renderFindings(findings),
          duration_ms: duration,
          findings,
        })
      }, TEST_SUITE_CHECK_TIMEOUT_MS)

      child.on('error', (err) => {
        clearTimeout(timeoutHandle)
        const duration = Date.now() - start
        const findings: VerificationFinding[] = [
          {
            category: 'test-suite-error',
            severity: 'error',
            message: `test command could not be spawned: ${err.message}`,
            command: cmd,
            durationMs: duration,
          },
        ]
        resolve({
          status: 'fail',
          details: renderFindings(findings),
          duration_ms: duration,
          findings,
        })
      })

      child.on('close', (code) => {
        clearTimeout(timeoutHandle)

        const duration = Date.now() - start
        if (code === 0) {
          resolve({
            status: 'pass',
            details: `test suite passed (${cmd})`,
            duration_ms: duration,
            findings: [],
          })
        } else {
          const truncated =
            output.length > MAX_OUTPUT_CHARS
              ? output.slice(0, MAX_OUTPUT_CHARS) + '... (truncated)'
              : output
          const findings: VerificationFinding[] = [
            {
              category: 'test-suite-fail',
              severity: 'error',
              message: `test suite failed (exit ${String(code)}): ${truncated}`,
              command: cmd,
              ...(code !== null ? { exitCode: code } : {}),
              stdoutTail: tail(stdout),
              stderrTail: tail(stderr),
              durationMs: duration,
            },
          ]
          // H1.6 (hardening): the agent's self-reported test outcome is
          // advisory now that ground truth exists — but a CONTRADICTION is
          // its own signal. An agent claiming `tests: pass` over a red suite
          // is the measured reward-hack shape (and the field's finding #11:
          // "tests pass" was self-report, never executed). Name it.
          if (context.devStoryResult?.tests === 'pass') {
            findings.push({
              category: 'tests-claim-mismatch',
              severity: 'error',
              message:
                `dev-story self-reported tests: pass, but the real suite failed (exit ${String(code)}) — ` +
                `the claim is contradicted by ground truth`,
            })
          }
          resolve({
            status: 'fail',
            details: renderFindings(findings),
            duration_ms: duration,
            findings,
          })
        }
      })
    })
  }
}
