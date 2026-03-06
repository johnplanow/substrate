import { describe, it, expect } from 'vitest'
import { generateEscalationDiagnosis } from '../escalation-diagnosis.js'

describe('generateEscalationDiagnosis', () => {
  it('classifies concentrated issues in few files', () => {
    const issues = [
      { severity: 'major', description: 'Missing error handling', file: 'src/foo.ts', line: 10 },
      { severity: 'major', description: 'Missing validation', file: 'src/foo.ts', line: 20 },
      { severity: 'minor', description: 'Naming issue', file: 'src/bar.ts' },
    ]
    const result = generateEscalationDiagnosis(issues, 3, 'NEEDS_MAJOR_REWORK')

    expect(result.issueDistribution).toBe('concentrated')
    expect(result.severityProfile).toBe('major-only')
    expect(result.totalIssues).toBe(3)
    expect(result.majorCount).toBe(2)
    expect(result.minorCount).toBe(1)
    expect(result.affectedFiles).toContain('src/foo.ts')
    expect(result.recommendedAction).toBe('retry-targeted')
  })

  it('classifies widespread issues across many files', () => {
    const issues = [
      { severity: 'major', description: 'Issue 1', file: 'src/a.ts' },
      { severity: 'major', description: 'Issue 2', file: 'src/b.ts' },
      { severity: 'major', description: 'Issue 3', file: 'src/c.ts' },
      { severity: 'major', description: 'Issue 4', file: 'src/d.ts' },
    ]
    const result = generateEscalationDiagnosis(issues, 3, 'NEEDS_MAJOR_REWORK')

    expect(result.issueDistribution).toBe('widespread')
    expect(result.recommendedAction).toBe('split-story')
  })

  it('recommends human intervention for blockers', () => {
    const issues = [
      { severity: 'blocker', description: 'Security vulnerability', file: 'src/auth.ts' },
      { severity: 'major', description: 'Missing validation', file: 'src/input.ts' },
    ]
    const result = generateEscalationDiagnosis(issues, 3, 'NEEDS_MAJOR_REWORK')

    expect(result.severityProfile).toBe('blocker-present')
    expect(result.blockerCount).toBe(1)
    expect(result.recommendedAction).toBe('human-intervention')
  })

  it('handles create-story failures with string issues', () => {
    const issues = ['create-story failed: template not found']
    const result = generateEscalationDiagnosis(issues, 0, 'create-story-failed')

    expect(result.severityProfile).toBe('major-only')
    expect(result.recommendedAction).toBe('human-intervention')
    expect(result.rationale).toContain('create story')
  })

  it('handles empty issue list', () => {
    const result = generateEscalationDiagnosis([], 3, 'NEEDS_MAJOR_REWORK')

    expect(result.severityProfile).toBe('no-structured-issues')
    expect(result.totalIssues).toBe(0)
    expect(result.recommendedAction).toBe('retry-targeted')
  })

  it('handles fix dispatch timeout', () => {
    const issues = [
      { severity: 'major', description: 'AC2 not implemented', file: 'src/foo.ts' },
    ]
    const result = generateEscalationDiagnosis(issues, 2, 'fix-dispatch-timeout')

    expect(result.recommendedAction).toBe('retry-targeted')
    expect(result.rationale).toContain('timed out')
  })

  it('limits affected files to 5', () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      severity: 'major',
      description: `Issue ${i}`,
      file: `src/file-${i}.ts`,
    }))
    const result = generateEscalationDiagnosis(issues, 3, 'NEEDS_MAJOR_REWORK')

    expect(result.affectedFiles.length).toBeLessThanOrEqual(5)
  })
})
