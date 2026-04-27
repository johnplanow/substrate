/**
 * Unit tests for AcceptanceCriteriaEvidenceCheck.
 *
 * These tests keep the check deterministic: no filesystem, shell, or LLM calls.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
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

  // -------------------------------------------------------------------------
  // Story 61-7: AC-evidence by code/test inspection
  //
  // Closes the 60-12 round 4 false-positive: dev claimed AC1-AC9 of 10 spec
  // bullets, AC10 work was demonstrably done (probe-author.test.ts with 17
  // passing tests existed), but the gate hard-failed because ac_met didn't
  // include AC10. The fallback inspects code-evidence sources before
  // emitting an error finding.
  // -------------------------------------------------------------------------

  describe('Story 61-7: AC-evidence by code/test inspection', () => {
    let workDir: string

    beforeEach(() => {
      workDir = mkdtempSync(path.join(tmpdir(), 'ac-evidence-61-7-'))
    })

    afterEach(() => {
      rmSync(workDir, { recursive: true, force: true })
    })

    function writeFile(relativePath: string, content: string): void {
      const full = path.join(workDir, relativePath)
      mkdirSync(path.dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf-8')
    }

    it('downgrades error→info when AC text references a file that IS in files_modified (60-12 case)', async () => {
      // Story shape mirrors a per-epic-file convention with bullet ACs
      const story = [
        '### Story 60-12: probe-author task type',
        '',
        '**Acceptance Criteria**:',
        '',
        '- AC1: First',
        '- AC2: Second',
        '- AC3: Third',
        '- AC4: Fourth',
        '- AC5: Fifth',
        '- AC6: Sixth',
        '- AC7: Seventh',
        '- AC8: Eighth',
        '- AC9: Ninth',
        '- AC10: Add `src/modules/compiled-workflows/__tests__/probe-author.test.ts` with 17 unit tests',
      ].join('\n')

      const result = await new AcceptanceCriteriaEvidenceCheck().run({
        storyKey: '60-12',
        workingDir: workDir,
        commitSha: 'abc',
        timeout: 30_000,
        storyContent: story,
        devStoryResult: {
          result: 'success',
          // Dev under-claimed: 9 of 10 ACs
          ac_met: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8', 'AC9'],
          ac_failures: [],
          files_modified: [
            'src/modules/compiled-workflows/probe-author.ts',
            'src/modules/compiled-workflows/__tests__/probe-author.test.ts',
          ],
          tests: 'pass',
        },
      })

      // AC10 has code-evidence → finding emitted as info, not error;
      // overall status is 'warn' (something is anomalous: under-claim) but
      // not 'fail' (so the gate doesn't block ship).
      expect(result.status).toBe('warn')
      expect(result.findings).toHaveLength(1)
      expect(result.findings?.[0]?.category).toBe('ac-missing-evidence-claim')
      expect(result.findings?.[0]?.severity).toBe('info')
      expect(result.findings?.[0]?.message).toContain('AC10')
      expect(result.findings?.[0]?.message).toContain('probe-author.test.ts')
    })

    it('keeps error severity when AC has no code-evidence (real under-delivery)', async () => {
      const story = [
        '## Acceptance Criteria',
        '',
        '### AC1: Build the new module',
        '### AC2: Add `src/never-created.ts` with the new schema',
      ].join('\n')

      const result = await new AcceptanceCriteriaEvidenceCheck().run({
        storyKey: '99-1',
        workingDir: workDir,
        commitSha: 'abc',
        timeout: 30_000,
        storyContent: story,
        devStoryResult: {
          result: 'success',
          ac_met: ['AC1'], // missing AC2; nothing supports AC2
          ac_failures: [],
          files_modified: ['src/some-other.ts'],
          tests: 'pass',
        },
      })

      // No code-evidence anywhere → AC2 stays as error.
      expect(result.status).toBe('fail')
      expect(result.findings).toHaveLength(1)
      expect(result.findings?.[0]?.category).toBe('ac-missing-evidence')
      expect(result.findings?.[0]?.severity).toBe('error')
    })

    it('downgrades error→info when a test file in files_modified mentions the AC by id', async () => {
      // AC text doesn't reference any file path; evidence comes from a
      // test file in files_modified that names AC2 in its content.
      writeFile(
        'src/__tests__/feature.test.ts',
        `import { describe, it, expect } from 'vitest'\n\n` +
          `describe('feature', () => {\n` +
          `  it('AC2: handles edge case', () => {\n` +
          `    expect(true).toBe(true)\n` +
          `  })\n` +
          `})\n`,
      )

      const story = [
        '## Acceptance Criteria',
        '',
        '### AC1: Foo',
        '### AC2: Handle edge cases gracefully',
      ].join('\n')

      const result = await new AcceptanceCriteriaEvidenceCheck().run({
        storyKey: '99-2',
        workingDir: workDir,
        commitSha: 'abc',
        timeout: 30_000,
        storyContent: story,
        devStoryResult: {
          result: 'success',
          ac_met: ['AC1'],
          ac_failures: [],
          files_modified: ['src/__tests__/feature.test.ts'],
          tests: 'pass',
        },
      })

      expect(result.status).toBe('warn')
      expect(result.findings?.[0]?.severity).toBe('info')
      expect(result.findings?.[0]?.message).toContain('AC2')
      expect(result.findings?.[0]?.message).toMatch(/feature\.test\.ts/)
    })

    it('downgrades error→info when AC text references a path that exists in working tree', async () => {
      // The path isn't in files_modified, but it exists on disk — evidence
      // that the deliverable was produced (perhaps in a prior commit).
      writeFile('src/already-existed.ts', 'export const x = 1\n')

      const story = [
        '## Acceptance Criteria',
        '',
        '### AC1: First',
        '### AC2: `src/already-existed.ts` provides the constant',
      ].join('\n')

      const result = await new AcceptanceCriteriaEvidenceCheck().run({
        storyKey: '99-3',
        workingDir: workDir,
        commitSha: 'abc',
        timeout: 30_000,
        storyContent: story,
        devStoryResult: {
          result: 'success',
          ac_met: ['AC1'],
          ac_failures: [],
          // Note: the file is NOT in files_modified; check 2 (working tree
          // existsSync) is the one that fires.
          files_modified: ['src/something-else.ts'],
          tests: 'pass',
        },
      })

      expect(result.status).toBe('warn')
      expect(result.findings?.[0]?.severity).toBe('info')
      expect(result.findings?.[0]?.message).toContain('AC2')
      expect(result.findings?.[0]?.message).toMatch(/exists in working tree/)
    })

    it('mixed missing ACs (one with evidence, one without) → status fail because any error is enough', async () => {
      const story = [
        '## Acceptance Criteria',
        '',
        '### AC1: First',
        '### AC2: Add `src/has-evidence.ts`',
        '### AC3: Add `src/never-built.ts`',
      ].join('\n')

      const result = await new AcceptanceCriteriaEvidenceCheck().run({
        storyKey: '99-4',
        workingDir: workDir,
        commitSha: 'abc',
        timeout: 30_000,
        storyContent: story,
        devStoryResult: {
          result: 'success',
          ac_met: ['AC1'],
          ac_failures: [],
          // AC2 has evidence (path in files_modified); AC3 has nothing
          files_modified: ['src/has-evidence.ts'],
          tests: 'pass',
        },
      })

      expect(result.status).toBe('fail') // because AC3 still errors
      expect(result.findings).toHaveLength(2)
      // Filter by category — both findings contain "AC3" in the message via
      // the formatIds(expectedIds) summary, so substring matching on the AC
      // id alone is ambiguous. Use the finding category to disambiguate.
      const ac2Finding = result.findings?.find(
        (f) => f.category === 'ac-missing-evidence-claim',
      )
      const ac3Finding = result.findings?.find(
        (f) => f.category === 'ac-missing-evidence',
      )
      expect(ac2Finding?.severity).toBe('info')
      expect(ac2Finding?.message).toContain('did not claim AC2')
      expect(ac3Finding?.severity).toBe('error')
      expect(ac3Finding?.message).toContain('AC evidence for AC3')
    })
  })
})
