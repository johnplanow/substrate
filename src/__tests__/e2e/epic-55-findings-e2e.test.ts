/**
 * End-to-end integration test for Epic 55 (Structured Verification Findings).
 *
 * Exercises the full chain without mocks:
 *
 *   1. Run the three non-shelling Tier A checks (PhantomReviewCheck,
 *      TrivialOutputCheck, AcceptanceCriteriaEvidenceCheck) against
 *      hand-crafted failing contexts. BuildCheck's shape is exercised
 *      via a synthetic summary entry because the real check shells out
 *      to `npm run build` and we do not want this smoke test to depend
 *      on a live build process.
 *   2. Confirm every failing check emits at least one structured
 *      VerificationFinding alongside `details`.
 *   3. Package the results into a VerificationSummary and write it to
 *      a real RunManifest on disk via RunManifest.patchStoryState().
 *   4. Read the manifest back via RunManifest.read() and confirm every
 *      finding (category, severity, message, and the optional
 *      command/exitCode/stdoutTail/stderrTail/durationMs surface)
 *      round-trips losslessly.
 *   5. Render the stored summary through the
 *      renderVerificationFindingsForPrompt helper (the production
 *      retry-prompt injection path) and assert every finding surfaces
 *      with its check-name header.
 *
 * Covers the core data-flow added in stories 55-1, 55-2, and 55-3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  PhantomReviewCheck,
  TrivialOutputCheck,
  AcceptanceCriteriaEvidenceCheck,
  RunManifest,
  renderFindings,
} from '@substrate-ai/sdlc'
import type {
  VerificationCheckResult,
  VerificationSummary,
} from '@substrate-ai/sdlc'
import { renderVerificationFindingsForPrompt } from '../../modules/implementation-orchestrator/verification-integration.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return join(tmpdir(), `epic-55-e2e-${randomUUID()}`)
}

/** Convert a VerificationResult into the Stored check shape (drop the
 * `checkName` prefix; caller supplies it). Preserves optional findings. */
function toStored(r: {
  status: 'pass' | 'warn' | 'fail'
  details: string
  duration_ms: number
  findings?: VerificationSummary['checks'][number]['findings']
}): Omit<VerificationCheckResult, 'checkName'> {
  return {
    status: r.status,
    details: r.details,
    duration_ms: r.duration_ms,
    ...(r.findings !== undefined ? { findings: r.findings } : {}),
  }
}

describe('Epic 55 — structured findings end-to-end', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('runs Tier A checks on failing contexts, persists their findings, and renders them for a retry prompt', async () => {
    const storyKey = '55-e2e'
    const workingDir = tempDir
    const commitSha = 'deadbeef'
    const timeout = 30_000

    // -----------------------------------------------------------------------
    // 1. Run each check against a failing context.
    // -----------------------------------------------------------------------

    const phantomResult = await new PhantomReviewCheck().run({
      storyKey,
      workingDir,
      commitSha,
      timeout,
      reviewResult: { dispatchFailed: true, error: 'Exit code: 2' },
    })
    expect(phantomResult.status).toBe('fail')
    expect(phantomResult.findings).toBeDefined()
    expect(phantomResult.findings?.length).toBeGreaterThan(0)
    expect(phantomResult.findings?.[0]?.category).toBe('phantom-review')
    expect(phantomResult.findings?.[0]?.severity).toBe('error')

    const trivialResult = await new TrivialOutputCheck().run({
      storyKey,
      workingDir,
      commitSha,
      timeout,
      outputTokenCount: 17,
    })
    expect(trivialResult.status).toBe('fail')
    expect(trivialResult.findings?.[0]?.category).toBe('trivial-output')
    expect(trivialResult.findings?.[0]?.message).toContain('17')

    const acResult = await new AcceptanceCriteriaEvidenceCheck().run({
      storyKey,
      workingDir,
      commitSha,
      timeout,
      storyContent: '## Acceptance Criteria\n\n### AC1: foo\n\n### AC2: bar\n',
      devStoryResult: {
        result: 'success',
        ac_met: ['AC1'],
        ac_failures: [],
        files_modified: ['src/a.ts'],
        tests: 'pass',
      },
    })
    expect(acResult.status).toBe('fail')
    expect(acResult.findings?.length).toBe(1) // AC2 missing
    expect(acResult.findings?.[0]?.category).toBe('ac-missing-evidence')
    expect(acResult.findings?.[0]?.message).toContain('AC2')

    // Synthetic BuildCheck entry — covers the full structured-finding
    // surface (command/exitCode/stdoutTail/stderrTail/durationMs) without
    // shelling out.
    const buildCheckResult: VerificationCheckResult = {
      checkName: 'build',
      status: 'fail',
      details: renderFindings([
        {
          category: 'build-error',
          severity: 'error',
          message: 'build failed (exit 2): tsc TS2345 on src/a.ts',
          command: 'npm run build',
          exitCode: 2,
          stdoutTail: 'compiling…\n',
          stderrTail: 'error TS2345: Argument type incompatible\n',
          durationMs: 1243,
        },
      ]),
      duration_ms: 1243,
      findings: [
        {
          category: 'build-error',
          severity: 'error',
          message: 'build failed (exit 2): tsc TS2345 on src/a.ts',
          command: 'npm run build',
          exitCode: 2,
          stdoutTail: 'compiling…\n',
          stderrTail: 'error TS2345: Argument type incompatible\n',
          durationMs: 1243,
        },
      ],
    }

    // -----------------------------------------------------------------------
    // 2. Assemble a VerificationSummary and persist via RunManifest.
    // -----------------------------------------------------------------------

    const summary: VerificationSummary = {
      storyKey,
      status: 'fail',
      duration_ms:
        phantomResult.duration_ms +
        trivialResult.duration_ms +
        acResult.duration_ms +
        buildCheckResult.duration_ms,
      checks: [
        { checkName: 'phantom-review', ...toStored(phantomResult) },
        { checkName: 'trivial-output', ...toStored(trivialResult) },
        { checkName: 'acceptance-criteria-evidence', ...toStored(acResult) },
        buildCheckResult,
      ],
    }

    const runId = randomUUID()
    const manifest = new RunManifest(runId, tempDir)
    await manifest.patchStoryState(storyKey, { verification_result: summary })

    // -----------------------------------------------------------------------
    // 3. Read back via RunManifest.read() — findings must round-trip.
    // -----------------------------------------------------------------------

    const data = await RunManifest.read(runId, tempDir)
    const storedSummary = data.per_story_state[storyKey]?.verification_result
    expect(storedSummary).toBeDefined()
    expect(storedSummary?.status).toBe('fail')
    expect(storedSummary?.checks).toHaveLength(4)

    const storedBuild = storedSummary?.checks.find((c) => c.checkName === 'build')
    expect(storedBuild?.findings).toBeDefined()
    expect(storedBuild?.findings?.[0]?.command).toBe('npm run build')
    expect(storedBuild?.findings?.[0]?.exitCode).toBe(2)
    expect(storedBuild?.findings?.[0]?.stderrTail).toContain('TS2345')
    expect(storedBuild?.findings?.[0]?.durationMs).toBe(1243)

    const storedAc = storedSummary?.checks.find((c) => c.checkName === 'acceptance-criteria-evidence')
    expect(storedAc?.findings?.[0]?.category).toBe('ac-missing-evidence')
    expect(storedAc?.findings?.[0]?.message).toContain('AC2')

    // -----------------------------------------------------------------------
    // 4. Render for retry-prompt injection.
    // -----------------------------------------------------------------------

    const promptText = renderVerificationFindingsForPrompt(
      storedSummary as unknown as VerificationSummary,
    )

    expect(promptText).toContain('- phantom-review:')
    expect(promptText).toContain('- trivial-output:')
    expect(promptText).toContain('- acceptance-criteria-evidence:')
    expect(promptText).toContain('- build:')
    expect(promptText).toMatch(/ERROR \[phantom-review\]/)
    expect(promptText).toMatch(/ERROR \[trivial-output\]/)
    expect(promptText).toMatch(/ERROR \[ac-missing-evidence\]/)
    expect(promptText).toMatch(/ERROR \[build-error\]/)
    // Per-check body is indented four spaces under the check header.
    expect(promptText).toMatch(/- phantom-review:\n\s{4}ERROR \[phantom-review\]/)
  })

  it('renders an empty retry-prompt injection when every check passes', async () => {
    // All three non-shelling checks on passing contexts → empty render.
    const phantomResult = await new PhantomReviewCheck().run({
      storyKey: '55-e2e-pass',
      workingDir: tempDir,
      commitSha: 'deadbeef',
      timeout: 30_000,
      reviewResult: { dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n' },
    })
    const trivialResult = await new TrivialOutputCheck().run({
      storyKey: '55-e2e-pass',
      workingDir: tempDir,
      commitSha: 'deadbeef',
      timeout: 30_000,
      outputTokenCount: 500,
    })
    const acResult = await new AcceptanceCriteriaEvidenceCheck().run({
      storyKey: '55-e2e-pass',
      workingDir: tempDir,
      commitSha: 'deadbeef',
      timeout: 30_000,
      storyContent: '## Acceptance Criteria\n\n### AC1: foo\n',
      devStoryResult: {
        result: 'success',
        ac_met: ['AC1'],
        ac_failures: [],
        files_modified: ['src/a.ts'],
        tests: 'pass',
      },
    })

    for (const r of [phantomResult, trivialResult, acResult]) {
      expect(r.status).toBe('pass')
      expect(r.findings).toEqual([])
    }

    const summary: VerificationSummary = {
      storyKey: '55-e2e-pass',
      status: 'pass',
      duration_ms: 10,
      checks: [
        { checkName: 'phantom-review', ...toStored(phantomResult) },
        { checkName: 'trivial-output', ...toStored(trivialResult) },
        { checkName: 'acceptance-criteria-evidence', ...toStored(acResult) },
      ],
    }
    const out = renderVerificationFindingsForPrompt(summary)
    expect(out).toBe('')
  })
})
