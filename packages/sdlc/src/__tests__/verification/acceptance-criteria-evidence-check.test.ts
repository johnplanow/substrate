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
})
