/**
 * Integration test for Story 74-2: verification → learning feedback bridge.
 *
 * Uses a real (in-memory) DatabaseAdapter wired through the core schema, so
 * `appendFinding` writes actual rows to the `decisions` table and
 * `FindingsInjector.inject` reads them back via the same query path it uses
 * for classifier-generated findings. This proves the feedback circuit (AC8)
 * end-to-end: verification result → decisions row → FindingsInjector context
 * for the next dispatch.
 *
 * AC10 (≥1 case): real fixture VerificationSummary with at least one `fail`
 * and one `warn` check; assert Dolt decisions table contains expected Finding
 * rows; assert findings are queryable via existing FindingsInjector.
 *
 * Note on backend: we exercise InMemoryDatabaseAdapter rather than a live Dolt
 * connection so the test runs in CI without external state. The schema and
 * row layout are identical between the two adapters (Dolt is just the
 * persistent backend) — what we're verifying is the wiring contract, not
 * Dolt-specific behaviour.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  InMemoryDatabaseAdapter,
  initSchema,
  getDecisionsByCategory,
  LEARNING_FINDING,
} from '@substrate-ai/core'
import {
  injectVerificationFindings,
  FindingsInjector,
  type StoryContext,
  type VerificationSummary,
} from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Fixture: verification summary with fail + warn
// ---------------------------------------------------------------------------

function buildFixtureSummary(): VerificationSummary {
  return {
    storyKey: '74-2-it',
    checks: [
      {
        checkName: 'build',
        status: 'fail',
        details: 'tsc error TS2304: cannot find name "Foo"',
        duration_ms: 100,
      },
      {
        checkName: 'source-ac-fidelity',
        status: 'warn',
        details: 'epic file unreadable; check skipped',
        duration_ms: 5,
      },
      {
        checkName: 'phantom-review',
        status: 'pass',
        details: 'review present',
        duration_ms: 2,
      },
    ],
    status: 'fail',
    duration_ms: 110,
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let adapter: InMemoryDatabaseAdapter

beforeEach(async () => {
  adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
})

afterEach(async () => {
  await adapter.close()
})

// ---------------------------------------------------------------------------
// AC10: end-to-end injection round-trip
// ---------------------------------------------------------------------------

describe('Story 74-2 — verification → learning bridge integration', () => {
  it('writes Finding rows for each fail/warn check and they are queryable via FindingsInjector', async () => {
    const summary = buildFixtureSummary()
    const storyContext: StoryContext = {
      runId: 'integration-run-74-2',
      filesModified: ['packages/sdlc/src/foo.ts', 'packages/sdlc/src/bar.ts'],
    }

    // Inject findings via the bridge.
    await injectVerificationFindings(summary, storyContext, adapter)

    // -----------------------------------------------------------------------
    // Direct query: prove rows landed in the decisions table under
    // category = 'finding' (the same category FindingsInjector reads).
    // -----------------------------------------------------------------------
    const rows = await getDecisionsByCategory(adapter, LEARNING_FINDING)
    // Two findings: build fail + source-ac-fidelity warn. Phantom-review pass
    // produces nothing.
    expect(rows.length).toBe(2)

    const parsed = rows.map((row) => JSON.parse(row.value as unknown as string))
    const rootCauses = parsed.map((p) => p.root_cause).sort()
    expect(rootCauses).toEqual(['build-failure', 'source-ac-drift'])

    // Every row carries the correct story key and run id.
    for (const finding of parsed) {
      expect(finding.story_key).toBe('74-2-it')
      expect(finding.run_id).toBe('integration-run-74-2')
      expect(finding.confidence).toBe('high')
      expect(finding.affected_files).toEqual(storyContext.filesModified)
    }

    // -----------------------------------------------------------------------
    // Round-trip: prove FindingsInjector reads them back as injection text.
    // -----------------------------------------------------------------------
    const prompt = await FindingsInjector.inject(adapter, {
      runId: 'next-run-after-74-2',
      storyKey: 'next-story',
      // targetFiles overlap with affected_files so the relevance scorer keeps
      // both findings above the default threshold.
      targetFiles: storyContext.filesModified,
    })

    expect(prompt).toContain('Prior run findings')
    // The injector reads the same rows we just wrote — both root causes show up
    // tagged with the verification check's category. (FindingsInjector may
    // demote confidence to "low" when affected_files don't exist on disk; both
    // "Directive: ..." and "Note (low confidence): ..." render formats are
    // acceptable here — what matters is the row was found and serialized.)
    expect(prompt).toContain('[build-failure]')
    expect(prompt).toContain('[source-ac-drift]')
    expect(prompt).toMatch(/Directive:|Note \(low confidence\):/)
  })

  it('produces zero rows when verification summary has only passing checks', async () => {
    const summary: VerificationSummary = {
      storyKey: '74-2-pass',
      checks: [
        {
          checkName: 'build',
          status: 'pass',
          details: 'ok',
          duration_ms: 1,
        },
      ],
      status: 'pass',
      duration_ms: 1,
    }
    await injectVerificationFindings(
      summary,
      { runId: 'integration-run-pass', filesModified: [] },
      adapter,
    )

    const rows = await getDecisionsByCategory(adapter, LEARNING_FINDING)
    expect(rows).toEqual([])
  })
})
