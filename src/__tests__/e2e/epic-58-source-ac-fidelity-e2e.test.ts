/**
 * End-to-end validation — Epic 58 (Source AC Fidelity).
 *
 * Exercises the full source-AC-fidelity chain: from a raw epic fixture
 * through `SourceAcFidelityCheck` and the default `VerificationPipeline`,
 * so that any regression in clause extraction, literal matching, or
 * pipeline projection is caught automatically.
 *
 * Tests 1–4 call `SourceAcFidelityCheck.run()` directly (no mocking)
 * to validate each clause type in isolation.
 *
 * Test 5 (pipeline integration) runs through `createDefaultVerificationPipeline()`
 * with the other 5 Tier A checks satisfied via context fields, confirming:
 *   - Aggregate status is `fail` when SourceAcFidelityCheck fails
 *   - Findings flow through the pipeline projection without dropping
 *     (regression guard for the latent Phase-1 projection bug pattern)
 *   - Failure is isolated to the `source-ac-fidelity` check
 *
 * No LLM calls, no shell invocations beyond `buildCommand: 'true'` in Test 5.
 * SourceAcFidelityCheck is pure static in-memory analysis.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { createDefaultVerificationPipeline, SourceAcFidelityCheck } from '@substrate-ai/sdlc'
import type { VerificationContext } from '@substrate-ai/sdlc'
import { createEventBus } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Fixture: minimal in-memory epic declaring one story with three hard clauses
// ---------------------------------------------------------------------------

/**
 * Minimal epic fixture with exactly three hard clauses:
 *   1. Keyword clause (MUST NOT): "MUST NOT retain legacy config"
 *   2. Path clause:               "`src/config/legacy.ts`"
 *   3. Probes-section clause:     "## Runtime Probes" + fenced yaml block
 *
 * The clause lines are written as literal substrings that can appear verbatim
 * in the faithful story content below, enabling exact substring matching.
 */
const EPIC_FIXTURE = [
  '### Story 58-e2e: Legacy Config Removal',
  '',
  'MUST NOT retain legacy config',
  'The file `src/config/legacy.ts` must be removed.',
  '',
  '## Runtime Probes',
  '',
  '```yaml',
  '- name: config-removed',
  '  sandbox: host',
  '  command: test ! -f src/config/legacy.ts',
  '```',
].join('\n')

// ---------------------------------------------------------------------------
// Faithful story content — contains all three hard clauses verbatim
// ---------------------------------------------------------------------------

/**
 * Story content that reproduces all three hard clauses as literal substrings:
 *   - "MUST NOT retain legacy config"   (keyword clause substring)
 *   - "`src/config/legacy.ts`"          (backtick-wrapped path)
 *   - "## Runtime Probes"               (section heading for probes clause)
 *
 * Also includes a `### AC1:` heading so AcceptanceCriteriaEvidenceCheck
 * can extract AC1 when this content is used in pipeline Test 5.
 */
const FAITHFUL_STORY_CONTENT = [
  '## Acceptance Criteria',
  '',
  '### AC1: No legacy config',
  '',
  'MUST NOT retain legacy config. The `src/config/legacy.ts` file must be removed.',
  '',
  '## Runtime Probes',
  '',
  '```yaml',
  '- name: config-removed',
  '  sandbox: host',
  '  command: test ! -f src/config/legacy.ts',
  '```',
].join('\n')

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

/**
 * Construct a minimal VerificationContext for the fixture tests.
 * storyKey '58-e2e' aligns with the `### Story 58-e2e:` heading in EPIC_FIXTURE.
 */
function makeContext(overrides: Partial<VerificationContext>): VerificationContext {
  return {
    storyKey: '58-e2e',
    workingDir: process.cwd(),
    commitSha: 'e2e',
    timeout: 30_000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Epic 58 — SourceAcFidelityCheck e2e: source AC fidelity chain', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `epic-58-e2e-${randomUUID()}`)
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // Test 1 — Positive: all hard clauses present
  // AC3
  // ---------------------------------------------------------------------------

  it('Test 1 (positive): passes when storyContent contains all three hard clauses verbatim', async () => {
    const ctx = makeContext({
      sourceEpicContent: EPIC_FIXTURE,
      storyContent: FAITHFUL_STORY_CONTENT,
    })
    const check = new SourceAcFidelityCheck()
    const result = await check.run(ctx)

    expect(result.status).toBe('pass')
    const errorFindings = result.findings?.filter((f) => f.severity === 'error') ?? []
    expect(errorFindings).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Test 2 — Negative: softened MUST NOT
  // AC4
  // ---------------------------------------------------------------------------

  it('Test 2 (negative — softened MUST NOT): fails with one source-ac-drift error mentioning MUST NOT', async () => {
    // Replace the mandatory keyword phrase with non-mandatory language
    const softenedContent = FAITHFUL_STORY_CONTENT.replace(
      'MUST NOT retain legacy config',
      'Consider deprecating legacy config',
    )

    const ctx = makeContext({
      sourceEpicContent: EPIC_FIXTURE,
      storyContent: softenedContent,
    })
    const check = new SourceAcFidelityCheck()
    const result = await check.run(ctx)

    // Story 58-9: advisory-mode — fidelity findings now emit as warn; status stays pass.
    expect(result.status).toBe('pass')
    const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0].severity).toBe('warn')
    expect(driftFindings[0].message).toContain('MUST NOT')
  })

  // ---------------------------------------------------------------------------
  // Test 3 — Negative: missing enumerated path
  // AC5
  // ---------------------------------------------------------------------------

  it('Test 3 (negative — missing enumerated path): fails with one source-ac-drift error mentioning the path', async () => {
    // Remove the backtick-wrapped path (replace with the plain unquoted path)
    const missingPathContent = FAITHFUL_STORY_CONTENT.replace(
      '`src/config/legacy.ts`',
      'src/config/legacy.ts',
    )

    const ctx = makeContext({
      sourceEpicContent: EPIC_FIXTURE,
      storyContent: missingPathContent,
    })
    const check = new SourceAcFidelityCheck()
    const result = await check.run(ctx)

    // Story 58-9: advisory-mode — fidelity findings now emit as warn; status stays pass.
    expect(result.status).toBe('pass')
    const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0].severity).toBe('warn')
    expect(driftFindings[0].message).toContain('src/config/legacy.ts')
  })

  // ---------------------------------------------------------------------------
  // Test 4 — Negative: dropped Runtime Probes heading
  // AC6
  // ---------------------------------------------------------------------------

  it('Test 4 (negative — dropped Runtime Probes): fails with one source-ac-drift error for the probes section', async () => {
    // Truncate storyContent to exclude everything from ## Runtime Probes onward
    const probesHeadingIdx = FAITHFUL_STORY_CONTENT.indexOf('\n## Runtime Probes')
    const noProbesContent = FAITHFUL_STORY_CONTENT.slice(0, probesHeadingIdx)

    const ctx = makeContext({
      sourceEpicContent: EPIC_FIXTURE,
      storyContent: noProbesContent,
    })
    const check = new SourceAcFidelityCheck()
    const result = await check.run(ctx)

    // Story 58-9: advisory-mode — fidelity findings now emit as warn; status stays pass.
    expect(result.status).toBe('pass')
    const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
    expect(driftFindings).toHaveLength(1)
    expect(driftFindings[0].severity).toBe('warn')
    // The finding must reference the runtime-probes-section clause
    expect(driftFindings[0].message).toContain('runtime-probes-section')
  })

  // ---------------------------------------------------------------------------
  // Test 5 — Pipeline integration round-trip
  // AC7
  // ---------------------------------------------------------------------------

  it('Test 5 (integration): aggregate fail when SourceAcFidelityCheck fails; findings not dropped (no Phase-1 projection bug); first 5 checks pass', async () => {
    // Softened story content: MUST NOT → non-mandatory language; no ## Runtime Probes
    // section so RuntimeProbeCheck (check 5) returns 'pass' (no probes to execute).
    // AcceptanceCriteriaEvidenceCheck needs a `### AC1:` heading and the corresponding
    // devStoryResult.ac_met entry.
    const softenedIntegrationContent = [
      '## Acceptance Criteria',
      '',
      '### AC1: No legacy config',
      '',
      'Consider deprecating legacy config. The `src/config/legacy.ts` file must be removed.',
    ].join('\n')

    const ctx = makeContext({
      sourceEpicContent: EPIC_FIXTURE,
      storyContent: softenedIntegrationContent,
      // Satisfy PhantomReviewCheck (check 1)
      reviewResult: { dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n' },
      // Satisfy TrivialOutputCheck (check 2)
      outputTokenCount: 500,
      // Satisfy AcceptanceCriteriaEvidenceCheck (check 3)
      devStoryResult: {
        result: 'success',
        ac_met: ['AC1'],
        ac_failures: [],
        files_modified: ['src/foo.ts'],
        tests: 'pass',
      },
      // Satisfy BuildCheck (check 4) — 'true' always exits 0
      buildCommand: 'true',
      // RuntimeProbeCheck (check 5) auto-passes when storyContent has no ## Runtime Probes
    })

    const bus = createEventBus()
    const pipeline = createDefaultVerificationPipeline(bus)
    const summary = await pipeline.run(ctx, 'A')

    // Story 58-9: fidelity is advisory — aggregate pipeline status stays pass
    // (or warn) since fidelity drift no longer fails the gate. Drift findings
    // must still flow through so operators see them in verification_findings.
    expect(['pass', 'warn']).toContain(summary.status)

    // SourceAcFidelityCheck must still be in the summary and have emitted findings
    const fidelityCheck = summary.checks.find((c) => c.checkName === 'source-ac-fidelity')
    expect(fidelityCheck).toBeDefined()
    // Advisory: the check itself now reports pass even when drift is detected
    expect(fidelityCheck?.status).toBe('pass')

    // Findings must flow through the pipeline projection without being dropped
    // (regression guard against the latent Phase-1 projection bug). Advisory
    // findings are warn-severity now.
    expect(fidelityCheck?.findings).toBeDefined()
    expect(fidelityCheck?.findings?.length).toBeGreaterThan(0)
    expect(fidelityCheck?.findings?.every((f) => f.severity === 'warn')).toBe(true)

    // All first 5 checks must pass — confirms failure is isolated to SourceAcFidelityCheck
    const firstFiveChecks = summary.checks.slice(0, 5)
    expect(firstFiveChecks).toHaveLength(5)
    for (const c of firstFiveChecks) {
      expect(c.status).toBe('pass')
    }
  })
})
