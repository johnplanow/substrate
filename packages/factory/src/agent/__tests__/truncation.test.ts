// packages/factory/src/agent/__tests__/truncation.test.ts
// Tests for the two-phase truncateToolOutput utility.
// Story 48-9: Output Truncation — Two-Phase Algorithm

import { describe, it, expect } from 'vitest'
import {
  truncateToolOutput,
  DEFAULT_TOOL_LIMITS,
  DEFAULT_FALLBACK_CHAR_LIMIT,
  DEFAULT_LINE_LIMIT,
} from '../truncation.js'
import type { SessionConfig } from '../types.js'
import { DEFAULT_SESSION_CONFIG } from '../types.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    ...DEFAULT_SESSION_CONFIG,
    tool_output_limits: new Map(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Character Truncation (AC1, AC2, AC4, AC6)
// ---------------------------------------------------------------------------

describe('Phase 1 — head_tail character truncation', () => {
  it('AC1: output at exactly the limit is returned unchanged', () => {
    const config = makeConfig()
    const output = 'x'.repeat(10_000)
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toBe(output)
  })

  it('AC1: 100K output with 10K limit produces head + marker + tail', () => {
    const config = makeConfig()
    const output = 'A'.repeat(100_000)
    const result = truncateToolOutput(output, 'unknown_tool', config)

    const removed = 100_000 - 10_000
    const half = Math.floor(10_000 / 2)

    expect(result.startsWith('A'.repeat(half))).toBe(true)
    expect(result.endsWith('A'.repeat(half))).toBe(true)
    expect(result).toContain(
      `[... ${removed} characters truncated from middle. Full output available in event stream.]`
    )
    // Total chars ≈ limit + marker length
    expect(result.length).toBeGreaterThan(10_000)
    expect(result.length).toBeLessThan(10_000 + 200) // marker is under 150 chars
  })

  it('AC1: removed count in marker equals output.length - limit', () => {
    const config = makeConfig()
    const output = 'Z'.repeat(50_000)
    const result = truncateToolOutput(output, 'unknown_tool', config)
    const removed = 50_000 - 10_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })

  it('AC2: tail mode returns only last N chars, no marker', () => {
    const config = makeConfig({ truncation_mode: 'tail' })
    const output = 'A'.repeat(5_000) + 'B'.repeat(5_000) + 'C'.repeat(5_000) // 15K total
    const result = truncateToolOutput(output, 'unknown_tool', config)
    // Last 10K chars are all 'C's — wait no, last 5K are 'C', middle 5K are 'B'
    // output = 5K 'A' + 5K 'B' + 5K 'C', total 15K, limit 10K
    // tail mode: last 10K chars = last 5K 'B' + 5K 'C'
    expect(result).toBe('B'.repeat(5_000) + 'C'.repeat(5_000))
    expect(result).not.toContain('[...')
    expect(result.length).toBe(10_000)
  })

  it('AC2: tail mode output shorter than limit is returned unchanged', () => {
    const config = makeConfig({ truncation_mode: 'tail' })
    const output = 'x'.repeat(500)
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toBe(output)
  })
})

describe('Phase 1 — per-tool character limits (AC4)', () => {
  it('read_file uses 50,000 character limit', () => {
    const config = makeConfig()
    const output = 'R'.repeat(51_000)
    const result = truncateToolOutput(output, 'read_file', config)
    const removed = 51_000 - 50_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })

  it('read_file within 50K limit is returned unchanged', () => {
    const config = makeConfig()
    const output = 'R'.repeat(49_000)
    expect(truncateToolOutput(output, 'read_file', config)).toBe(output)
  })

  it('shell uses 30,000 character limit', () => {
    const config = makeConfig()
    const output = 'S'.repeat(35_000)
    const result = truncateToolOutput(output, 'shell', config)
    const removed = 35_000 - 30_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })

  it('grep uses 20,000 character limit', () => {
    const config = makeConfig()
    const output = 'G'.repeat(25_000)
    const result = truncateToolOutput(output, 'grep', config)
    const removed = 25_000 - 20_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })

  it('grep within 20K limit is returned unchanged', () => {
    const config = makeConfig()
    const output = 'G'.repeat(19_000)
    expect(truncateToolOutput(output, 'grep', config)).toBe(output)
  })

  it('glob uses 20,000 character limit', () => {
    const config = makeConfig()
    const output = 'L'.repeat(25_000)
    const result = truncateToolOutput(output, 'glob', config)
    const removed = 25_000 - 20_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })

  it('unknown tool falls back to 10,000 character limit', () => {
    const config = makeConfig()
    const output = 'U'.repeat(15_000)
    const result = truncateToolOutput(output, 'some_custom_tool', config)
    const removed = 15_000 - 10_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })

  it('config.tool_output_limits.get overrides default when present', () => {
    const limits = new Map([['shell', 5_000]])
    const config = makeConfig({ tool_output_limits: limits })
    const output = 'x'.repeat(10_000)
    const result = truncateToolOutput(output, 'shell', config)
    const removed = 10_000 - 5_000
    expect(result).toContain(`[... ${removed} characters truncated from middle.`)
  })
})

describe('DEFAULT_TOOL_LIMITS exports (AC4)', () => {
  it('DEFAULT_TOOL_LIMITS has correct values', () => {
    expect(DEFAULT_TOOL_LIMITS.read_file).toBe(50_000)
    expect(DEFAULT_TOOL_LIMITS.shell).toBe(30_000)
    expect(DEFAULT_TOOL_LIMITS.grep).toBe(20_000)
    expect(DEFAULT_TOOL_LIMITS.glob).toBe(20_000)
  })

  it('DEFAULT_FALLBACK_CHAR_LIMIT is 10,000', () => {
    expect(DEFAULT_FALLBACK_CHAR_LIMIT).toBe(10_000)
  })
})

// ---------------------------------------------------------------------------
// Phase 2 — Line-Based Truncation (AC3, AC6, AC7)
// ---------------------------------------------------------------------------

describe('Phase 2 — head_tail line truncation (AC3)', () => {
  it('499-line output with max_output_lines: 500 is returned unchanged (no-op)', () => {
    const config = makeConfig({ max_output_lines: 500 })
    // Make output under the char limit too (use 1-char lines)
    const output = Array.from({ length: 499 }, (_, i) => `line${i}`).join('\n')
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toBe(output)
  })

  it('500-line output is returned unchanged (exactly at limit)', () => {
    const config = makeConfig({ max_output_lines: 500 })
    const output = Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n')
    // Total chars: 500 lines of ~3 chars + 499 newlines = ~2000 chars — under 10K limit
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toBe(output)
  })

  it('1000-line output with max_output_lines: 500 keeps first 250 + marker + last 250', () => {
    const config = makeConfig({ max_output_lines: 500 })
    const lines = Array.from({ length: 1_000 }, (_, i) => `line${i}`)
    const output = lines.join('\n')
    const result = truncateToolOutput(output, 'unknown_tool', config)

    const headCount = Math.ceil(500 / 2) // 250
    const tailCount = Math.floor(500 / 2) // 250
    const removed = 1_000 - 500 // 500

    const resultLines = result.split('\n')
    // Head lines
    for (let i = 0; i < headCount; i++) {
      expect(resultLines[i]).toBe(`line${i}`)
    }
    // Marker line
    expect(result).toContain(`[... ${removed} lines truncated from middle ...]`)
    // Tail lines (last 250 of original = lines[750..999])
    const tailStart = 1_000 - tailCount
    for (let i = 0; i < tailCount; i++) {
      expect(result).toContain(`line${tailStart + i}`)
    }
  })

  it('marker reports correct removed line count', () => {
    const config = makeConfig({ max_output_lines: 500 })
    const lines = Array.from({ length: 1_000 }, () => 'a')
    const output = lines.join('\n')
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toContain('[... 500 lines truncated from middle ...]')
  })
})

describe('Phase 2 — tail line truncation (AC3)', () => {
  it('tail mode: 1000-line output with max_output_lines: 500 keeps last 500 lines', () => {
    const config = makeConfig({ truncation_mode: 'tail', max_output_lines: 500 })
    const lines = Array.from({ length: 1_000 }, (_, i) => `line${i}`)
    const output = lines.join('\n')
    const result = truncateToolOutput(output, 'unknown_tool', config)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(500)
    expect(resultLines[0]).toBe('line500')
    expect(resultLines[499]).toBe('line999')
    expect(result).not.toContain('[...')
  })
})

describe('Phase 2 — non-default max_output_lines (AC7)', () => {
  it('max_output_lines: 100 is respected', () => {
    const config = makeConfig({ max_output_lines: 100 })
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`)
    const output = lines.join('\n')
    const result = truncateToolOutput(output, 'unknown_tool', config)

    const removed = 200 - 100
    expect(result).toContain(`[... ${removed} lines truncated from middle ...]`)
  })
})

describe('DEFAULT_LINE_LIMIT export (AC7)', () => {
  it('DEFAULT_LINE_LIMIT is 500', () => {
    expect(DEFAULT_LINE_LIMIT).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Two-phase combined (AC6)
// ---------------------------------------------------------------------------

describe('Two-phase combined (AC6)', () => {
  it('output within both limits is returned unchanged by reference equality', () => {
    const config = makeConfig({ max_output_lines: 500 })
    const output = 'hello world'
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toBe(output)
  })

  it('empty string is returned unchanged', () => {
    const config = makeConfig()
    expect(truncateToolOutput('', 'unknown_tool', config)).toBe('')
  })

  it('two-phase combined: 200K chars and 2K lines with default config', () => {
    const config = makeConfig() // head_tail, 10K char limit, 500 line limit
    // Build 2000 lines, each 100 chars wide → 2000 * 100 + 1999 newlines ≈ 201,999 chars
    const line = 'x'.repeat(100)
    const output = Array.from({ length: 2_000 }, () => line).join('\n')

    expect(output.length).toBeGreaterThan(200_000)
    expect(output.split('\n').length).toBe(2_000)

    const result = truncateToolOutput(output, 'unknown_tool', config)
    const resultLines = result.split('\n')

    // After Phase 1: char limit 10K → ~10K chars, but the 10K chars span far fewer than 500 lines
    // After Phase 2: if Phase 1 result has ≤500 lines, it's a no-op
    // Each 100-char line takes 101 chars (with \n). After Phase 1, head+tail≈10K chars → ~50 lines each side
    // The Phase 1 result will have ~100 lines (head 50 + marker 1-2 + tail 50) — well under 500 line limit
    expect(result.length).toBeLessThan(10_500) // char limit + marker headroom
    expect(resultLines.length).toBeLessThan(500)
    expect(result).toContain('characters truncated from middle.')
  })

  it('Phase 1 marker lines count toward Phase 2 line limit', () => {
    // Use a large char output that will be truncated in Phase 1 (adding 3 marker lines)
    // then verify the Phase 2 result respects max_output_lines
    const config = makeConfig({ max_output_lines: 10 })
    // 20 lines, each 2000 chars → total 40K+ chars > 10K char limit
    const longLine = 'L'.repeat(2_000)
    const lines = Array.from({ length: 20 }, () => longLine)
    const output = lines.join('\n')

    const result = truncateToolOutput(output, 'unknown_tool', config)
    const resultLines = result.split('\n')

    // Phase 1 truncates to ~10K chars head+tail with marker = a few lines
    // Phase 2 then limits to 10 lines
    expect(resultLines.length).toBeLessThanOrEqual(10 + 1) // 10 lines + possible partial marker line
  })
})

// ---------------------------------------------------------------------------
// SessionConfig field wiring (AC5)
// ---------------------------------------------------------------------------

describe('SessionConfig truncation fields (AC5)', () => {
  it('truncation_mode field exists in SessionConfig and defaults to head_tail', () => {
    const config = makeConfig()
    expect(config.truncation_mode).toBe('head_tail')
  })

  it('max_output_lines field exists in SessionConfig and defaults to 500', () => {
    const config = makeConfig()
    expect(config.max_output_lines).toBe(500)
  })

  it('truncation_mode: tail is accepted', () => {
    const config = makeConfig({ truncation_mode: 'tail' })
    expect(config.truncation_mode).toBe('tail')
  })

  it('custom max_output_lines value is used', () => {
    const config = makeConfig({ max_output_lines: 200 })
    const lines = Array.from({ length: 300 }, (_, i) => `line${i}`)
    const output = lines.join('\n')
    const result = truncateToolOutput(output, 'unknown_tool', config)
    expect(result).toContain('[... 100 lines truncated from middle ...]')
  })
})
