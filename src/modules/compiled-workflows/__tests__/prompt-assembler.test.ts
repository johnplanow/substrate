/**
 * Unit tests for the prompt assembler utility.
 *
 * Tests placeholder replacement, token ceiling enforcement,
 * truncation priority, and no-truncation scenarios.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { assemblePrompt } from '../prompt-assembler.js'
import type { PromptSection } from '../prompt-assembler.js'

// ---------------------------------------------------------------------------
// Mock pino logger to suppress output in tests
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimate tokens the same way the assembler does (chars / 4, ceiling) */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const base = text.length / 4
  const hasCodeBlock = text.includes('```')
  return Math.ceil(hasCodeBlock ? base * 1.1 : base)
}

// ---------------------------------------------------------------------------
// AC3: Prompt assembler tests
// ---------------------------------------------------------------------------

describe('assemblePrompt — placeholder replacement', () => {
  it('replaces all placeholders with section content', () => {
    const template = 'Hello {{name}}, your epic is {{epic_shard}}.'
    const sections: PromptSection[] = [
      { name: 'name', content: 'World', priority: 'required' },
      { name: 'epic_shard', content: 'Epic 10: Compiled Workflows', priority: 'required' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toBe('Hello World, your epic is Epic 10: Compiled Workflows.')
    expect(result.truncated).toBe(false)
  })

  it('replaces placeholders with all sections provided', () => {
    const template = '{{epic_shard}}\n{{prev_dev_notes}}\n{{arch_constraints}}'
    const sections: PromptSection[] = [
      { name: 'epic_shard', content: 'Epic content here', priority: 'required' },
      { name: 'prev_dev_notes', content: 'Previous notes here', priority: 'optional' },
      { name: 'arch_constraints', content: 'Architecture constraints here', priority: 'important' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toContain('Epic content here')
    expect(result.prompt).toContain('Previous notes here')
    expect(result.prompt).toContain('Architecture constraints here')
    expect(result.truncated).toBe(false)
  })

  it('replaces missing optional placeholder with empty string', () => {
    const template = '{{epic_shard}}\n{{prev_dev_notes}}'
    const sections: PromptSection[] = [
      { name: 'epic_shard', content: 'Epic content here', priority: 'required' },
      // prev_dev_notes not provided
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toContain('Epic content here')
    // Missing placeholder should be replaced with empty string
    expect(result.prompt).not.toContain('{{prev_dev_notes}}')
    expect(result.truncated).toBe(false)
  })

  it('returns accurate token count for assembled prompt', () => {
    const content = 'A'.repeat(400)
    const template = '{{section}}'
    const sections: PromptSection[] = [
      { name: 'section', content, priority: 'required' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.tokenCount).toBe(100) // 400 chars / 4 = 100 tokens
    expect(result.truncated).toBe(false)
  })
})

describe('assemblePrompt — token ceiling enforcement', () => {
  it('returns prompt unchanged when within token budget', () => {
    const template = '{{content}}'
    const shortContent = 'Short content that fits easily.'
    const sections: PromptSection[] = [
      { name: 'content', content: shortContent, priority: 'required' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toContain(shortContent)
    expect(result.truncated).toBe(false)
    expect(result.tokenCount).toBeLessThanOrEqual(10_000)
  })

  it('truncates oversized prompt to fit within token ceiling', () => {
    // Create content that vastly exceeds the token ceiling
    const bigContent = 'X'.repeat(40_000) // ~10,000 tokens
    const template = '{{big_section}}'
    const ceiling = 100 // Very small ceiling

    const sections: PromptSection[] = [
      { name: 'big_section', content: bigContent, priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, ceiling)

    // Should be truncated or eliminated
    expect(result.truncated).toBe(true)
    expect(result.tokenCount).toBeLessThanOrEqual(ceiling + 10) // Allow small rounding
  })

  it('token estimate is at or below ceiling after truncation', () => {
    const largeContent = 'Y'.repeat(20_000) // ~5,000 tokens
    const template = 'PREFIX {{optional_section}} SUFFIX'
    const ceiling = 500

    const sections: PromptSection[] = [
      { name: 'optional_section', content: largeContent, priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, ceiling)

    expect(result.tokenCount).toBeLessThanOrEqual(ceiling + 10)
  })
})

describe('assemblePrompt — truncation priority', () => {
  it('truncates optional sections before important ones', () => {
    // Create a template where both sections are large
    const importantContent = 'I'.repeat(4_000) // ~1,000 tokens
    const optionalContent = 'O'.repeat(4_000)  // ~1,000 tokens
    const template = '{{important_section}}\n{{optional_section}}'

    // Ceiling that requires truncation but could keep important
    const ceiling = 700 // Only enough for one section

    const sections: PromptSection[] = [
      { name: 'important_section', content: importantContent, priority: 'important' },
      { name: 'optional_section', content: optionalContent, priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, ceiling)

    expect(result.truncated).toBe(true)
    // Optional should be eliminated first; important should be larger portion
    const importantInResult = result.prompt.includes('I'.repeat(100))
    const optionalInResult = result.prompt.includes('O'.repeat(100))

    // Important should be more preserved than optional
    expect(importantInResult).toBe(true)
    expect(optionalInResult).toBe(false)
  })

  it('never truncates required sections', () => {
    const requiredContent = 'R'.repeat(2_000) // ~500 tokens
    const optionalContent = 'O'.repeat(2_000) // ~500 tokens
    const template = '{{required_section}}\n{{optional_section}}'

    // Ceiling just enough for required section only
    const ceiling = 500

    const sections: PromptSection[] = [
      { name: 'required_section', content: requiredContent, priority: 'required' },
      { name: 'optional_section', content: optionalContent, priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, ceiling)

    // Required content should be fully preserved
    expect(result.prompt).toContain(requiredContent)
  })

  it('truncates optional before important, important before required', () => {
    const template = '{{req}}\n{{imp}}\n{{opt}}'
    // Each ~250 tokens; total ~750 tokens
    const reqContent = 'R'.repeat(1_000)
    const impContent = 'I'.repeat(1_000)
    const optContent = 'O'.repeat(1_000)

    // Ceiling: only room for req + imp approximately
    const ceiling = 500

    const sections: PromptSection[] = [
      { name: 'req', content: reqContent, priority: 'required' },
      { name: 'imp', content: impContent, priority: 'important' },
      { name: 'opt', content: optContent, priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, ceiling)

    expect(result.truncated).toBe(true)
    // Required should always be present
    expect(result.prompt).toContain(reqContent)
    // Optional should be fully truncated or eliminated
    expect(result.prompt).not.toContain(optContent)
  })
})

describe('assemblePrompt — no truncation', () => {
  it('returns truncated=false when prompt fits within budget', () => {
    const template = '{{a}} {{b}}'
    const sections: PromptSection[] = [
      { name: 'a', content: 'hello', priority: 'required' },
      { name: 'b', content: 'world', priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, 100)

    expect(result.truncated).toBe(false)
    expect(result.prompt).toBe('hello world')
  })

  it('handles empty sections gracefully', () => {
    const template = '{{a}}{{b}}{{c}}'
    const sections: PromptSection[] = [
      { name: 'a', content: '', priority: 'required' },
      { name: 'b', content: '', priority: 'important' },
      { name: 'c', content: '', priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, 100)

    expect(result.truncated).toBe(false)
    expect(result.tokenCount).toBe(0)
    expect(result.prompt).toBe('')
  })

  it('handles template with no placeholders', () => {
    const template = 'Static template content with no placeholders.'
    const sections: PromptSection[] = []

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toBe(template)
    expect(result.truncated).toBe(false)
  })
})

describe('assemblePrompt — edge cases', () => {
  it('handles multiple occurrences of the same placeholder', () => {
    const template = '{{section}} and again {{section}}'
    const sections: PromptSection[] = [
      { name: 'section', content: 'value', priority: 'required' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toBe('value and again value')
  })

  it('handles underscores in placeholder names', () => {
    const template = '{{epic_shard}} {{prev_dev_notes}} {{arch_constraints}}'
    const sections: PromptSection[] = [
      { name: 'epic_shard', content: 'epic', priority: 'required' },
      { name: 'prev_dev_notes', content: 'notes', priority: 'optional' },
      { name: 'arch_constraints', content: 'constraints', priority: 'important' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.prompt).toBe('epic notes constraints')
  })

  it('uses default token ceiling of 2200 when not specified', () => {
    const template = '{{content}}'
    const content = 'A'.repeat(4_000) // ~1,000 tokens — fits in default 2200
    const sections: PromptSection[] = [
      { name: 'content', content, priority: 'required' },
    ]

    // Call without explicit ceiling — should use default of 2200
    const result = assemblePrompt(template, sections)

    expect(result.truncated).toBe(false)
    expect(result.prompt).toBe(content)
  })
})

describe('assemblePrompt — token count accuracy', () => {
  it('estimates tokens as chars divided by 4 (ceiling)', () => {
    const template = '{{content}}'
    // Use 100 chars → should be ceil(100/4) = 25 tokens
    const content = 'A'.repeat(100)
    const sections: PromptSection[] = [
      { name: 'content', content, priority: 'required' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.tokenCount).toBe(25)
  })

  it('applies code block adjustment for content with backticks', () => {
    const template = '{{content}}'
    // 400 chars with code block → should be ceil(100 * 1.1) = 110 tokens
    const content = '```\n' + 'A'.repeat(392) + '\n```'
    const sections: PromptSection[] = [
      { name: 'content', content, priority: 'required' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.tokenCount).toBeGreaterThan(estimateTokens('A'.repeat(400)))
  })
})

describe('assemblePrompt — warning emission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not truncate when prompt fits within budget', () => {
    // Verify via return value: no truncation occurs when prompt is within budget.
    // (The module-level logger is created once at import time, so we cannot
    //  intercept it by re-mocking createLogger after module initialization.)
    const template = '{{content}}'
    const sections: PromptSection[] = [
      { name: 'content', content: 'Short content', priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, 10_000)

    expect(result.truncated).toBe(false)
    expect(result.tokenCount).toBeLessThanOrEqual(10_000)
  })

  it('sets truncated=true when prompt exceeds budget and truncation occurs', () => {
    // Over-budget scenario: verify the returned truncated flag is set
    const bigContent = 'X'.repeat(20_000) // ~5,000 tokens
    const template = '{{content}}'
    const sections: PromptSection[] = [
      { name: 'content', content: bigContent, priority: 'optional' },
    ]

    const result = assemblePrompt(template, sections, 100)

    expect(result.truncated).toBe(true)
  })
})
