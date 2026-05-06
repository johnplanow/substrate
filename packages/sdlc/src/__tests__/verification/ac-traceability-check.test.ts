/**
 * Unit tests for ac-traceability-check — Story 74-1.
 *
 * Tests are pure unit tests: no filesystem reads, no manifest reads.
 * Pre-read content is injected via the `_readFile` dependency-injection
 * field on AcTraceabilityInput — tests never touch the real filesystem.
 *
 * Covers AC7 cases (a) through (e):
 *   (a) matched: AC text and test description share ≥0.4 word overlap → matched: true
 *   (b) not matched: overlap below 0.4 → matched: false
 *   (c) edge case: empty AC list → empty matrix []
 *   (d) edge case: no test files in filesModified → all unmatched + warning
 *   (e) confidence field is always 'approximate' regardless of input
 */

import { describe, it, expect } from 'vitest'
import {
  runAcTraceabilityCheck,
  wordOverlap,
  parseAcList,
  extractTestDescriptions,
  isTestFile,
  type AcTraceabilityInput,
} from '../../verification/checks/ac-traceability-check.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a stub AcTraceabilityInput that injects `source` as the content of
 * every test file read, without touching the real filesystem.
 */
function makeInput(
  overrides: Partial<AcTraceabilityInput> & { testFileContent?: string } = {},
): AcTraceabilityInput {
  const { testFileContent, ...rest } = overrides
  const base: AcTraceabilityInput = {
    storyKey: '74-1',
    storyContent:
      '# Story\n\n## Acceptance Criteria\n\n1. Register the flag on the report command\n',
    filesModified: ['src/cli/commands/report.test.ts'],
    _readFile: testFileContent !== undefined
      ? async () => testFileContent
      : async () => "it('register flag on report command', () => {})\n",
    ...rest,
  }
  return base
}

// ---------------------------------------------------------------------------
// wordOverlap unit tests
// ---------------------------------------------------------------------------

describe('wordOverlap', () => {
  it('returns 1.0 for identical strings', () => {
    expect(wordOverlap('register flag report command', 'register flag report command')).toBe(1.0)
  })

  it('returns 0 when either string is empty', () => {
    expect(wordOverlap('', 'hello world')).toBe(0)
    expect(wordOverlap('hello world', '')).toBe(0)
    expect(wordOverlap('', '')).toBe(0)
  })

  it('returns a value between 0 and 1 for partial overlaps', () => {
    const score = wordOverlap('register the flag on the command', 'flag command register')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('is case-insensitive', () => {
    const s1 = wordOverlap('Register Flag', 'register flag')
    const s2 = wordOverlap('register flag', 'register flag')
    expect(s1).toBe(s2)
  })

  it('ignores non-alphanumeric characters in tokenization', () => {
    // Punctuation should not affect tokenization
    const score = wordOverlap('register-flag (report)', 'register flag report')
    expect(score).toBe(1.0)
  })
})

// ---------------------------------------------------------------------------
// parseAcList unit tests
// ---------------------------------------------------------------------------

describe('parseAcList', () => {
  it('extracts numbered AC items from ## Acceptance Criteria section', () => {
    const content =
      '# Story\n\n## Acceptance Criteria\n\n1. Register the flag\n2. Output JSON format\n\n## Dev Notes\n\nsome notes\n'
    const acs = parseAcList(content)
    expect(acs).toHaveLength(2)
    expect(acs[0]).toBe('Register the flag')
    expect(acs[1]).toBe('Output JSON format')
  })

  it('stops at the next ## heading', () => {
    const content = '## Acceptance Criteria\n\n1. AC one\n\n## Tasks\n\n1. Task one\n'
    const acs = parseAcList(content)
    expect(acs).toHaveLength(1)
    expect(acs[0]).toBe('AC one')
  })

  it('returns empty array when no AC section present', () => {
    const content = '# Story\n\nNo AC section here.\n'
    const acs = parseAcList(content)
    expect(acs).toHaveLength(0)
  })

  it('handles **Acceptance Criteria:** bold-wrapped variant', () => {
    const content = '# Story\n\n**Acceptance Criteria:**\n\n1. AC one\n2. AC two\n'
    const acs = parseAcList(content)
    expect(acs).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// isTestFile unit tests
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it('returns true for .test.ts files', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true)
  })

  it('returns true for .test.js files', () => {
    expect(isTestFile('src/foo.test.js')).toBe(true)
  })

  it('returns true for paths containing "test" (case insensitive)', () => {
    expect(isTestFile('src/__tests__/foo.ts')).toBe(true)
  })

  it('returns false for non-test TypeScript files', () => {
    expect(isTestFile('src/cli/commands/report.ts')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractTestDescriptions unit tests
// ---------------------------------------------------------------------------

describe('extractTestDescriptions', () => {
  it('extracts string literals from describe(, it(, and test( calls', () => {
    const source = `
describe('my suite', () => {
  it('does something useful', () => {})
  test('handles edge cases', () => {})
})
`
    const descs = extractTestDescriptions(source)
    expect(descs).toContain('my suite')
    expect(descs).toContain('does something useful')
    expect(descs).toContain('handles edge cases')
  })

  it('handles backtick template literals', () => {
    const source = "it(`registers the flag`, () => {})"
    const descs = extractTestDescriptions(source)
    expect(descs).toContain('registers the flag')
  })

  it('returns empty array for source with no test calls', () => {
    const descs = extractTestDescriptions('const x = 1')
    expect(descs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC7 (a): matched — AC text and test description share ≥0.4 word overlap
// ---------------------------------------------------------------------------

describe('runAcTraceabilityCheck — AC7(a): matched case', () => {
  it('marks AC as matched when test description has ≥0.4 word overlap', async () => {
    const input = makeInput({
      storyContent:
        '# Story\n\n## Acceptance Criteria\n\n1. Register the verify-ac flag on the report command\n',
      filesModified: ['src/cli/commands/report.test.ts'],
      testFileContent:
        "it('register verify-ac flag on report command', () => {})\n",
    })

    const output = await runAcTraceabilityCheck(input)

    expect(output.matrix).toHaveLength(1)
    expect(output.matrix[0]?.matched).toBe(true)
    expect(output.matrix[0]?.testName).not.toBeNull()
    expect(output.confidence).toBe('approximate')
  })

  it('picks the best-scoring test description as testName', async () => {
    const input = makeInput({
      storyContent:
        '# Story\n\n## Acceptance Criteria\n\n1. Register verify-ac flag on the report command\n',
      filesModified: ['src/__tests__/foo.test.ts'],
      // Two descriptions: one matches well, one doesn't
      testFileContent: [
        "it('register verify-ac flag report command', () => {})",
        "it('completely unrelated bananas', () => {})",
      ].join('\n'),
    })

    const output = await runAcTraceabilityCheck(input)
    expect(output.matrix[0]?.matched).toBe(true)
    expect(output.matrix[0]?.testName).toBe('register verify-ac flag report command')
  })
})

// ---------------------------------------------------------------------------
// AC7 (b): not matched — overlap below 0.4
// ---------------------------------------------------------------------------

describe('runAcTraceabilityCheck — AC7(b): not matched case', () => {
  it('marks AC as not matched when test description has <0.4 word overlap', async () => {
    const input = makeInput({
      storyContent:
        '# Story\n\n## Acceptance Criteria\n\n1. Register the verify-ac flag on the substrate run command\n',
      filesModified: ['src/__tests__/run.test.ts'],
      testFileContent:
        "it('completely unrelated test about bananas and oranges and other fruits', () => {})\n",
    })

    const output = await runAcTraceabilityCheck(input)

    expect(output.matrix).toHaveLength(1)
    expect(output.matrix[0]?.matched).toBe(false)
    expect(output.matrix[0]?.testName).toBeNull()
    expect(output.confidence).toBe('approximate')
  })
})

// ---------------------------------------------------------------------------
// AC7 (c): empty AC list → empty matrix
// ---------------------------------------------------------------------------

describe('runAcTraceabilityCheck — AC7(c): empty AC list', () => {
  it('returns empty matrix when story has no AC section', async () => {
    const input = makeInput({
      storyContent: '# Story\n\nNo acceptance criteria here.\n',
      filesModified: ['src/foo.test.ts'],
    })

    const output = await runAcTraceabilityCheck(input)

    expect(output.matrix).toEqual([])
    expect(output.confidence).toBe('approximate')
    expect(output.warnings).toHaveLength(0) // no warning for empty AC — only for no test files
  })
})

// ---------------------------------------------------------------------------
// AC7 (d): no test files in filesModified → all unmatched + warning
// ---------------------------------------------------------------------------

describe('runAcTraceabilityCheck — AC7(d): no test files', () => {
  it('returns all ACs as unmatched and emits a warning when no test files present', async () => {
    const input: AcTraceabilityInput = {
      storyKey: '74-1',
      storyContent:
        '# Story\n\n## Acceptance Criteria\n\n1. Register the flag\n2. Output JSON\n',
      // No test files — only production source files
      filesModified: ['src/cli/commands/report.ts', 'src/cli/commands/run.ts'],
    }

    const output = await runAcTraceabilityCheck(input)

    // All ACs unmatched
    expect(output.matrix).toHaveLength(2)
    expect(output.matrix.every((r) => r.matched === false)).toBe(true)
    expect(output.matrix.every((r) => r.testName === null)).toBe(true)
    expect(output.matrix.every((r) => r.score === 0)).toBe(true)

    // At least one warning about missing test files
    expect(output.warnings.length).toBeGreaterThanOrEqual(1)
    expect(output.warnings[0]).toMatch(/no test files/i)
  })
})

// ---------------------------------------------------------------------------
// AC7 (e): confidence is always 'approximate'
// ---------------------------------------------------------------------------

describe('runAcTraceabilityCheck — AC7(e): confidence always approximate', () => {
  it('always sets confidence to "approximate" even with empty content', async () => {
    const output = await runAcTraceabilityCheck(
      makeInput({ storyContent: '', filesModified: [] }),
    )
    expect(output.confidence).toBe('approximate')
  })

  it('always sets confidence to "approximate" with matched content', async () => {
    const input = makeInput({
      storyContent:
        '# Story\n\n## Acceptance Criteria\n\n1. Register flag report command\n',
      filesModified: ['src/foo.test.ts'],
      testFileContent: "describe('register flag report command', () => {})\n",
    })
    const output = await runAcTraceabilityCheck(input)
    expect(output.confidence).toBe('approximate')
  })

  it('always sets confidence to "approximate" with no test files', async () => {
    const output = await runAcTraceabilityCheck(
      makeInput({ filesModified: ['src/report.ts'] }),
    )
    expect(output.confidence).toBe('approximate')
  })
})

// ---------------------------------------------------------------------------
// Word-overlap threshold boundary tests
// ---------------------------------------------------------------------------

describe('wordOverlap — threshold boundary', () => {
  it('score exactly at 3/8 is below 0.4 (not matched)', () => {
    // "a b c d e" vs "a b c f g h" → intersection=3, union=8, jaccard=3/8=0.375 < 0.4
    const score = wordOverlap('a b c d e', 'a b c f g h')
    expect(score).toBeCloseTo(3 / 8)
    expect(score).toBeLessThan(0.4)
  })

  it('score of 3/6 = 0.5 is above 0.4 (matched)', () => {
    // "a b c d" vs "a b c e f" → intersection=3, union=6, jaccard=0.5
    const score = wordOverlap('a b c d', 'a b c e f')
    expect(score).toBeCloseTo(3 / 6)
    expect(score).toBeGreaterThanOrEqual(0.4)
  })
})

// ---------------------------------------------------------------------------
// Additional edge case: file read errors are silently skipped
// ---------------------------------------------------------------------------

describe('runAcTraceabilityCheck — file read error handling', () => {
  it('silently skips files that throw on read and returns unmatched AC', async () => {
    const input: AcTraceabilityInput = {
      storyKey: '74-1',
      storyContent:
        '# Story\n\n## Acceptance Criteria\n\n1. Register the flag on the run command\n',
      filesModified: ['src/__tests__/run.test.ts'],
      _readFile: async () => {
        throw new Error('ENOENT: file not found')
      },
    }

    const output = await runAcTraceabilityCheck(input)
    // No error thrown — just unmatched (no test descriptions loaded)
    expect(output.matrix).toHaveLength(1)
    expect(output.matrix[0]?.matched).toBe(false)
    expect(output.confidence).toBe('approximate')
  })
})
