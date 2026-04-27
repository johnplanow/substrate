/**
 * Unit tests for AcceptanceCriteriaEvidenceCheck.
 *
 * These tests keep the check deterministic: no filesystem, shell, or LLM calls.
 */

import { describe, it, expect } from 'vitest'
import {
  AcceptanceCriteriaEvidenceCheck,
  extractAcceptanceCriteriaIds,
} from '../../verification/checks/acceptance-criteria-evidence-check.js'
import type { VerificationContext } from '../../verification/types.js'

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    storyKey: 'ac-1',
    workingDir: '/tmp/test',
    commitSha: 'abc123',
    timeout: 30_000,
    storyContent: [
      '# Story 1: Example',
      '',
      '## Acceptance Criteria',
      '',
      '### AC1: First behavior',
      '### AC2: Second behavior',
    ].join('\n'),
    devStoryResult: {
      result: 'success',
      ac_met: ['AC1', 'AC2'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: 'pass',
    },
    ...overrides,
  }
}

describe('AcceptanceCriteriaEvidenceCheck', () => {
  it('has name "acceptance-criteria-evidence" and tier "A"', () => {
    const check = new AcceptanceCriteriaEvidenceCheck()
    expect(check.name).toBe('acceptance-criteria-evidence')
    expect(check.tier).toBe('A')
  })

  it('extracts BMAD AC headings and AC: # references from the acceptance section', () => {
    const ids = extractAcceptanceCriteriaIds([
      '## Acceptance Criteria',
      '### AC1: One',
      '- **AC: #2** Two',
      '',
      '## Tasks / Subtasks',
      '- [ ] Task (AC: #9)',
    ].join('\n'))

    expect(ids).toEqual(['AC1', 'AC2'])
  })

  it('extracts numbered criteria from the acceptance section', () => {
    const ids = extractAcceptanceCriteriaIds([
      '## Acceptance Criteria',
      '1. First criterion',
      '2. Second criterion',
    ].join('\n'))

    expect(ids).toEqual(['AC1', 'AC2'])
  })

  it('passes when all declared ACs are claimed and tests pass', async () => {
    const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext())

    expect(result.status).toBe('pass')
    expect(result.details).toContain('AC1, AC2')
    expect(result.details).toContain('tests=pass')
  })

  it('fails when dev-story reported AC failures', async () => {
    const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({
      devStoryResult: {
        result: 'failed',
        ac_met: ['AC1'],
        ac_failures: ['AC2: missing behavior'],
        files_modified: ['src/foo.ts'],
        tests: 'pass',
      },
    }))

    expect(result.status).toBe('fail')
    expect(result.details).toContain('AC2: missing behavior')
  })

  it('fails when a declared AC is not claimed in ac_met', async () => {
    const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({
      devStoryResult: {
        result: 'success',
        ac_met: ['AC1'],
        ac_failures: [],
        files_modified: ['src/foo.ts'],
        tests: 'pass',
      },
    }))

    expect(result.status).toBe('fail')
    expect(result.details).toContain('missing dev-story AC evidence for AC2')
  })

  it('fails when dev-story reports failing tests', async () => {
    const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({
      devStoryResult: {
        result: 'success',
        ac_met: ['AC1', 'AC2'],
        ac_failures: [],
        files_modified: ['src/foo.ts'],
        tests: 'fail',
      },
    }))

    expect(result.status).toBe('fail')
    expect(result.details).toContain('failing tests')
  })

  it('warns when story content is unavailable', async () => {
    const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({ storyContent: undefined }))

    expect(result.status).toBe('warn')
    expect(result.details).toContain('story content unavailable')
  })

  it('warns when dev-story result is unavailable', async () => {
    const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({ devStoryResult: undefined }))

    expect(result.status).toBe('warn')
    expect(result.details).toContain('dev-story result unavailable')
  })

  // Story 55-2 AC3 — structured findings, one per missing/failing AC
  describe('structured findings (story 55-2)', () => {
    it('emits one ac-missing-evidence finding per missing AC', async () => {
      // Story declares AC1, AC2, AC3; dev-story claims only AC1 → 2 missing
      const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({
        storyContent: '## Acceptance Criteria\n\n### AC1: foo\nbody\n\n### AC2: bar\nbody\n\n### AC3: baz\nbody\n',
        devStoryResult: {
          result: 'success',
          ac_met: ['AC1'],
          ac_failures: [],
          files_modified: ['src/foo.ts'],
          tests: 'pass',
        },
      }))
      expect(result.status).toBe('fail')
      expect(result.findings).toHaveLength(2)
      expect(result.findings?.every((f) => f.category === 'ac-missing-evidence')).toBe(true)
      expect(result.findings?.every((f) => f.severity === 'error')).toBe(true)
      expect(result.findings?.[0]?.message).toContain('AC2')
      expect(result.findings?.[1]?.message).toContain('AC3')
    })

    it('emits one ac-explicit-failure finding per declared ac_failure entry', async () => {
      const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({
        devStoryResult: {
          result: 'failed',
          ac_met: [],
          ac_failures: ['AC1: schema mismatch', 'AC2: missing column'],
          files_modified: ['src/foo.ts'],
          tests: 'fail',
        },
      }))
      expect(result.status).toBe('fail')
      expect(result.findings).toHaveLength(2)
      expect(result.findings?.[0]?.category).toBe('ac-explicit-failure')
      expect(result.findings?.[1]?.category).toBe('ac-explicit-failure')
      expect(result.findings?.[0]?.message).toContain('AC1: schema mismatch')
      expect(result.findings?.[1]?.message).toContain('AC2: missing column')
    })

    it('emits empty findings array on full-coverage pass', async () => {
      const result = await new AcceptanceCriteriaEvidenceCheck().run(makeContext({
        devStoryResult: {
          result: 'success',
          ac_met: ['AC1', 'AC2'],
          ac_failures: [],
          files_modified: ['src/foo.ts'],
          tests: 'pass',
        },
      }))
      expect(result.status).toBe('pass')
      expect(result.findings).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Story 61-4: bullet-format AC recognition.
  //
  // Per-epic planning files (substrate's own _bmad-output/planning-artifacts/
  // convention) commonly use the `**Acceptance Criteria**:` paragraph form
  // followed by a bullet list, NOT the `## Acceptance Criteria` heading +
  // numbered/AC1-style form. Without 61-4, these stories produce
  // "ac-context-missing" warns even though the dev claimed all ACs met.
  // Surfaced live by 60-12 redispatch run 4700c6e8 (2026-04-27).
  // -------------------------------------------------------------------------

  describe('Story 61-4: bullet-format AC recognition', () => {
    it('recognizes `**Acceptance Criteria**:` bold-paragraph section (not just `## Acceptance Criteria` heading)', () => {
      const story = [
        '### Story 60-12: probe-author task type + dispatch wiring',
        '',
        '**Priority**: must',
        '',
        '**Description**: Add a new probe-author task type.',
        '',
        '**Acceptance Criteria**:',
        '',
        '- The dev MUST add `probe-author` to taskType union',
        '- File path: `packages/core/src/probe-author.ts`',
        '- 4-6 unit tests at `packages/core/__tests__/probe-author.test.ts`',
        '',
        '**Key File Paths**:',
        '- src/foo.ts',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      // 3 bullets in the AC section → AC1, AC2, AC3
      expect(ids).toEqual(['AC1', 'AC2', 'AC3'])
    })

    it('counts bullet items as AC1/AC2/AC3 by position', () => {
      const story = [
        '## Acceptance Criteria',
        '',
        '- First bullet (AC1)',
        '- Second bullet (AC2)',
        '- Third bullet (AC3)',
        '- Fourth bullet (AC4)',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      expect(ids).toEqual(['AC1', 'AC2', 'AC3', 'AC4'])
    })

    it('prefers explicit AC refs (AC1:, AC2:) over bullet-position inference when both present', () => {
      const story = [
        '## Acceptance Criteria',
        '',
        '- AC1: explicit reference',
        '- AC2: another explicit',
        '- bullet without explicit ref',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      // Explicit AC1+AC2 found → bullet-position inference does NOT fire
      // (so the 3rd bullet doesn't become a phantom AC3).
      expect(ids).toEqual(['AC1', 'AC2'])
    })

    it('prefers numbered criteria (1. ... / 2. ...) over bullet-position inference when both present', () => {
      const story = [
        '## Acceptance Criteria',
        '',
        '1. First numbered',
        '2. Second numbered',
        '- some bullet',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      // Numbered found → bullet-position inference does NOT fire.
      expect(ids).toEqual(['AC1', 'AC2'])
    })

    it('section ends at `### Story` boundary in per-epic-file convention', () => {
      // Epic 61's per-epic-file shape: multiple `### Story X-Y:` sections
      // with their own bold-paragraph AC blocks. Section detection MUST
      // stop at the next `### Story` heading, not bleed into it.
      const story = [
        '### Story 60-12: First story',
        '',
        '**Acceptance Criteria**:',
        '',
        '- AC for 60-12 first',
        '- AC for 60-12 second',
        '',
        '### Story 60-13: Second story',
        '',
        '**Acceptance Criteria**:',
        '',
        '- AC for 60-13 first (must NOT count toward 60-12)',
        '- AC for 60-13 second (must NOT count toward 60-12)',
        '- AC for 60-13 third (must NOT count toward 60-12)',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      // Only 60-12's 2 bullets, not 60-13's 3 — total 2 not 5.
      expect(ids).toEqual(['AC1', 'AC2'])
    })

    it('does not infer bullet ACs outside the Acceptance Criteria section', () => {
      // Bullets in unrelated sections (Description, Key File Paths, etc.)
      // must NOT be treated as ACs.
      const story = [
        '### Story 60-12',
        '',
        '**Description**:',
        '- some description bullet 1',
        '- some description bullet 2',
        '',
        '**Acceptance Criteria**:',
        '',
        '- The actual AC',
        '',
        '**Key File Paths**:',
        '- src/foo.ts',
        '- src/bar.ts',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      // Only 1 bullet in the AC section.
      expect(ids).toEqual(['AC1'])
    })

    it('ignores checkbox-style bullets that are already covered by NUMBERED_CRITERION', () => {
      // The NUMBERED_CRITERION regex catches `- [ ] 1. Foo` style.
      // Bullet inference shouldn't double-count these.
      const story = [
        '## Acceptance Criteria',
        '',
        '- [ ] 1. Numbered checkbox',
        '- [ ] 2. Another',
      ].join('\n')
      const ids = extractAcceptanceCriteriaIds(story)
      expect(ids).toEqual(['AC1', 'AC2'])
    })
  })
})
