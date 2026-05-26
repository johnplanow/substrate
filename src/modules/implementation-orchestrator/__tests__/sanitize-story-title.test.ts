/**
 * Unit tests for sanitizeStoryTitle (F-commitmsg, 2026-05-26).
 *
 * The dev-story auto-commit subject is `feat(story-N-M): <title>`, where <title>
 * is the create-story-emitted story_title. That field can absorb stray stdout —
 * run 376a3930 / story 78-1 (a story whose domain was `substrate report`) bled the
 * report banner (rows of `═` + "Run: …/Verdict: …") into the title, producing a
 * multi-line, box-drawing-filled commit subject. sanitizeStoryTitle rejects such
 * contamination (→ undefined → commitDevStoryOutput falls back to 'implementation')
 * and otherwise yields a clean single-line, bounded title.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeStoryTitle } from '../orchestrator-impl.js'

describe('sanitizeStoryTitle', () => {
  it('passes a clean single-line title through unchanged', () => {
    expect(sanitizeStoryTitle('Fix report recovery-attempts count for zero review cycles')).toBe(
      'Fix report recovery-attempts count for zero review cycles',
    )
  })

  it('rejects a title contaminated with substrate report banner box-drawing (78-1 regression)', () => {
    const mangled =
      'Fix ══════════════════════════════════════   Run: 376a3930-13d5-4261-9ac9-d5b76f29b195   ' +
      'Duration: 8m59s   Cost: $0.0000   Verdict: ALL PASSED ══════════════════════════════════════'
    // Box-drawing glyphs ⇒ stdout contamination ⇒ undefined (caller → 'implementation').
    expect(sanitizeStoryTitle(mangled)).toBeUndefined()
  })

  it('returns undefined for undefined / non-string / empty input', () => {
    expect(sanitizeStoryTitle(undefined)).toBeUndefined()
    expect(sanitizeStoryTitle('')).toBeUndefined()
    expect(sanitizeStoryTitle('   ')).toBeUndefined()
  })

  it('takes the first non-empty line (discards multi-line contamination)', () => {
    expect(sanitizeStoryTitle('\n\nReal title\nsome table row | x | y')).toBe('Real title')
  })

  it('collapses internal whitespace and trims', () => {
    expect(sanitizeStoryTitle('  Title   with    gaps  ')).toBe('Title with gaps')
  })

  it('strips control characters', () => {
    expect(sanitizeStoryTitle("Title\u0000with\u001Fctrl")).toBe("Title with ctrl")
  })

  it('caps overly long titles', () => {
    const long = 'word '.repeat(60).trim() // ~299 chars
    const result = sanitizeStoryTitle(long)!
    expect(result.length).toBeLessThanOrEqual(120)
    expect(result.endsWith('...')).toBe(true)
  })
})
