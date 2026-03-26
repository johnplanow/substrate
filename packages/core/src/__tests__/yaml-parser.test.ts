/**
 * Unit tests for packages/core/src/dispatch/yaml-parser.ts
 *
 * Tests the two primary exports:
 * - extractYamlBlock(): extraction of YAML from agent output
 * - parseYamlResult(): parsing and optional Zod schema validation
 *
 * Covers:
 * - Fenced YAML extraction (```yaml...```)
 * - Multiple fenced blocks (takes the last one)
 * - Unfenced YAML extraction via anchor keys
 * - Empty/null input handling
 * - YAML parse errors
 * - Schema validation success/failure
 * - Invalid escape sanitization (\$ -> $)
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { extractYamlBlock, parseYamlResult } from '../dispatch/yaml-parser.js'

// ---------------------------------------------------------------------------
// extractYamlBlock
// ---------------------------------------------------------------------------

describe('extractYamlBlock', () => {
  // -----------------------------------------------------------------------
  // Empty / null input
  // -----------------------------------------------------------------------

  describe('empty / null input', () => {
    it('returns null for empty string', () => {
      expect(extractYamlBlock('')).toBeNull()
    })

    it('returns null for whitespace-only string', () => {
      expect(extractYamlBlock('   \n\n  ')).toBeNull()
    })

    it('returns null for text with no YAML content', () => {
      expect(extractYamlBlock('Just some regular text\nwith no YAML')).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Fenced YAML blocks
  // -----------------------------------------------------------------------

  describe('fenced YAML blocks', () => {
    it('extracts a single fenced yaml block', () => {
      const output = [
        'Here is the analysis:',
        '',
        '```yaml',
        'verdict: pass',
        'score: 95',
        '```',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('verdict: pass\nscore: 95')
    })

    it('extracts from ``` fence without yaml tag', () => {
      const output = [
        'Done.',
        '',
        '```',
        'result: success',
        'files_changed: 3',
        '```',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('result: success\nfiles_changed: 3')
    })

    it('takes the LAST fenced block when multiple exist', () => {
      const output = [
        'First attempt:',
        '```yaml',
        'verdict: fail',
        '```',
        '',
        'After fixing:',
        '```yaml',
        'verdict: pass',
        'score: 100',
        '```',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('verdict: pass\nscore: 100')
    })

    it('ignores fenced blocks that do not contain anchor keys', () => {
      const output = [
        'Here is some code:',
        '```',
        'const x = 42',
        '```',
        '',
        '```yaml',
        'result: done',
        '```',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('result: done')
    })

    it('returns null when fenced block contains no anchor keys', () => {
      const output = [
        '```yaml',
        'name: test',
        'value: 123',
        '```',
      ].join('\n')

      // No anchor key (result:, verdict:, story_file:, expansion_priority:)
      expect(extractYamlBlock(output)).toBeNull()
    })

    it('extracts multiline YAML with nested structure', () => {
      const output = [
        'Analysis complete.',
        '',
        '```yaml',
        'verdict: pass',
        'details:',
        '  tests_passed: 12',
        '  tests_failed: 0',
        '  coverage: 95.2',
        '```',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toContain('verdict: pass')
      expect(result).toContain('  tests_passed: 12')
      expect(result).toContain('  coverage: 95.2')
    })
  })

  // -----------------------------------------------------------------------
  // Unfenced YAML (anchor key fallback)
  // -----------------------------------------------------------------------

  describe('unfenced YAML extraction', () => {
    it('extracts unfenced YAML starting with a verdict: anchor', () => {
      const output = [
        'I have reviewed the code and here is my assessment:',
        '',
        'verdict: pass',
        'confidence: high',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('verdict: pass\nconfidence: high')
    })

    it('extracts unfenced YAML starting with result: anchor', () => {
      const output = [
        'Processing complete.',
        '',
        'result: success',
        'files_modified: 5',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('result: success\nfiles_modified: 5')
    })

    it('extracts unfenced YAML starting with story_file: anchor', () => {
      const output = [
        'Generated story.',
        'story_file: epic-1/stories/1-1.md',
        'status: ready',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('story_file: epic-1/stories/1-1.md\nstatus: ready')
    })

    it('extracts unfenced YAML starting with expansion_priority: anchor', () => {
      const output = [
        'Priority analysis:',
        'expansion_priority: high',
        'reason: critical path',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('expansion_priority: high\nreason: critical path')
    })

    it('uses the LAST anchor key occurrence when multiple exist in unfenced text', () => {
      const output = [
        'First verdict: fail',
        'Some discussion...',
        'verdict: pass',
        'final_score: 90',
      ].join('\n')

      const result = extractYamlBlock(output)

      expect(result).toBe('verdict: pass\nfinal_score: 90')
    })
  })

  // -----------------------------------------------------------------------
  // Trailing fence stripping
  // -----------------------------------------------------------------------

  describe('trailing fence stripping', () => {
    it('strips a wrapping fence and extracts unfenced YAML', () => {
      // This is a case where the YAML is wrapped in fences but the
      // fenced extraction might not match (e.g., fence without anchor key
      // in the regex path). The stripTrailingFence handles it.
      const output = [
        '```yaml',
        'verdict: pass',
        'notes: all good',
        '```',
      ].join('\n')

      const result = extractYamlBlock(output)

      // Should find it via fenced extraction
      expect(result).toBe('verdict: pass\nnotes: all good')
    })
  })
})

// ---------------------------------------------------------------------------
// parseYamlResult
// ---------------------------------------------------------------------------

describe('parseYamlResult', () => {
  // -----------------------------------------------------------------------
  // Successful parsing (no schema)
  // -----------------------------------------------------------------------

  describe('parsing without schema', () => {
    it('parses valid YAML and returns the parsed object', () => {
      const yamlText = 'verdict: pass\nscore: 95'

      const { parsed, error } = parseYamlResult(yamlText)

      expect(error).toBeNull()
      expect(parsed).toEqual({ verdict: 'pass', score: 95 })
    })

    it('parses nested YAML structures', () => {
      const yamlText = [
        'result: success',
        'details:',
        '  tests: 12',
        '  coverage: 95.2',
        'tags:',
        '  - unit',
        '  - integration',
      ].join('\n')

      const { parsed, error } = parseYamlResult(yamlText)

      expect(error).toBeNull()
      expect(parsed).toEqual({
        result: 'success',
        details: { tests: 12, coverage: 95.2 },
        tags: ['unit', 'integration'],
      })
    })

    it('parses a scalar YAML value', () => {
      const { parsed, error } = parseYamlResult('42')

      expect(error).toBeNull()
      expect(parsed).toBe(42)
    })
  })

  // -----------------------------------------------------------------------
  // Parse errors
  // -----------------------------------------------------------------------

  describe('parse errors', () => {
    it('returns an error for invalid YAML syntax', () => {
      const yamlText = '{ invalid: yaml: : :'

      const { parsed, error } = parseYamlResult(yamlText)

      expect(parsed).toBeNull()
      expect(error).toContain('YAML parse error')
    })

    it('returns an error when YAML parses to null', () => {
      const yamlText = '~' // YAML null literal

      const { parsed, error } = parseYamlResult(yamlText)

      expect(parsed).toBeNull()
      expect(error).toBe('YAML parsed to null or undefined')
    })

    it('returns an error when YAML parses to undefined', () => {
      const yamlText = '' // empty string parses to undefined in js-yaml

      const { parsed, error } = parseYamlResult(yamlText)

      expect(parsed).toBeNull()
      expect(error).toBe('YAML parsed to null or undefined')
    })
  })

  // -----------------------------------------------------------------------
  // Schema validation
  // -----------------------------------------------------------------------

  describe('schema validation', () => {
    const VerdictSchema = z.object({
      verdict: z.enum(['pass', 'fail', 'needs_minor_fixes']),
      score: z.number().min(0).max(100).optional(),
      notes: z.string().optional(),
    })

    it('returns parsed result when YAML matches the schema', () => {
      const yamlText = 'verdict: pass\nscore: 95\nnotes: looks great'

      const { parsed, error } = parseYamlResult(yamlText, VerdictSchema)

      expect(error).toBeNull()
      expect(parsed).toEqual({
        verdict: 'pass',
        score: 95,
        notes: 'looks great',
      })
    })

    it('returns schema validation error for invalid values', () => {
      const yamlText = 'verdict: invalid_value\nscore: 95'

      const { parsed, error } = parseYamlResult(yamlText, VerdictSchema)

      expect(parsed).toBeNull()
      expect(error).toContain('Schema validation error')
    })

    it('returns schema validation error for wrong types', () => {
      const yamlText = 'verdict: pass\nscore: not_a_number'

      const { parsed, error } = parseYamlResult(yamlText, VerdictSchema)

      expect(parsed).toBeNull()
      expect(error).toContain('Schema validation error')
    })

    it('returns schema validation error when required field is missing', () => {
      const yamlText = 'score: 95' // missing verdict

      const { parsed, error } = parseYamlResult(yamlText, VerdictSchema)

      expect(parsed).toBeNull()
      expect(error).toContain('Schema validation error')
    })

    it('strips unknown fields when schema is strict', () => {
      const StrictSchema = z.object({
        verdict: z.string(),
      }).strict()

      const yamlText = 'verdict: pass\nextra_field: surprise'

      const { parsed, error } = parseYamlResult(yamlText, StrictSchema)

      // strict schema rejects unknown fields
      expect(parsed).toBeNull()
      expect(error).toContain('Schema validation error')
    })
  })

  // -----------------------------------------------------------------------
  // YAML escape sanitization
  // -----------------------------------------------------------------------

  describe('escape sanitization', () => {
    it('sanitizes invalid \\$ escapes in double-quoted YAML strings', () => {
      const yamlText = 'verdict: pass\npath: "src/\\$lib/types"'

      const { parsed, error } = parseYamlResult(yamlText)

      expect(error).toBeNull()
      expect(parsed).toEqual({
        verdict: 'pass',
        path: 'src/$lib/types',
      })
    })

    it('sanitizes invalid \\# escapes in double-quoted strings', () => {
      const yamlText = 'result: ok\ncomment: "fix \\#123"'

      const { parsed, error } = parseYamlResult(yamlText)

      expect(error).toBeNull()
      expect(parsed).toEqual({
        result: 'ok',
        comment: 'fix #123',
      })
    })

    it('preserves valid escape sequences (\\n, \\t, \\\\)', () => {
      const yamlText = 'verdict: pass\nmessage: "line1\\nline2\\ttab\\\\backslash"'

      const { parsed, error } = parseYamlResult(yamlText)

      expect(error).toBeNull()
      expect(parsed).toEqual({
        verdict: 'pass',
        message: 'line1\nline2\ttab\\backslash',
      })
    })

    it('does not modify single-quoted strings', () => {
      // In YAML, single-quoted strings have no escape processing
      const yamlText = "verdict: pass\npath: 'src/\\$lib'"

      const { parsed, error } = parseYamlResult(yamlText)

      expect(error).toBeNull()
      // single-quoted strings preserve backslashes literally
      expect(parsed).toEqual({
        verdict: 'pass',
        path: 'src/\\$lib',
      })
    })
  })

  // -----------------------------------------------------------------------
  // End-to-end: extractYamlBlock + parseYamlResult
  // -----------------------------------------------------------------------

  describe('extract + parse integration', () => {
    it('extracts and parses a complete agent output', () => {
      const agentOutput = [
        'I have analyzed the code and performed the review.',
        '',
        'The implementation looks correct. All tests pass.',
        '',
        '```yaml',
        'verdict: pass',
        'score: 92',
        'notes: Clean implementation with good test coverage',
        '```',
      ].join('\n')

      const yamlBlock = extractYamlBlock(agentOutput)
      expect(yamlBlock).not.toBeNull()

      const schema = z.object({
        verdict: z.enum(['pass', 'fail']),
        score: z.number(),
        notes: z.string(),
      })

      const { parsed, error } = parseYamlResult(yamlBlock!, schema)

      expect(error).toBeNull()
      expect(parsed).toEqual({
        verdict: 'pass',
        score: 92,
        notes: 'Clean implementation with good test coverage',
      })
    })

    it('handles agent output with no YAML block', () => {
      const agentOutput = 'The agent crashed and produced no structured output.'

      const yamlBlock = extractYamlBlock(agentOutput)
      expect(yamlBlock).toBeNull()
    })
  })
})
