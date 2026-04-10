/**
 * Unit tests for RepoMapFormatter.
 */

import { describe, it, expect } from 'vitest'

import type { RepoMapQueryResult, ScoredSymbol } from '../types.js'
import { RepoMapFormatter } from '../formatter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScored(overrides: Partial<ScoredSymbol> = {}): ScoredSymbol {
  return {
    filePath: 'src/foo.ts',
    symbolName: 'FooClass',
    symbolType: 'class',
    signature: undefined,
    lineNumber: 10,
    dependencies: [],
    fileHash: 'abc123',
    relevanceScore: 50,
    ...overrides,
  }
}

function makeResult(
  symbols: ScoredSymbol[],
  opts: Partial<Omit<RepoMapQueryResult, 'symbols'>> = {}
): RepoMapQueryResult {
  return {
    symbols,
    symbolCount: symbols.length,
    truncated: false,
    queryDurationMs: 5,
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepoMapFormatter', () => {
  describe('AC6: toText()', () => {
    it('produces a header line with symbol count', () => {
      const result = makeResult([makeScored()])
      const text = RepoMapFormatter.toText(result)
      expect(text).toMatch(/^# repo-map: 1 symbols/)
    })

    it('groups symbols by file with blank line between groups', () => {
      const a1 = makeScored({ filePath: 'src/a.ts', symbolName: 'Alpha', lineNumber: 5 })
      const a2 = makeScored({ filePath: 'src/a.ts', symbolName: 'Beta', lineNumber: 15 })
      const b1 = makeScored({ filePath: 'src/b.ts', symbolName: 'Gamma', lineNumber: 1 })
      const result = makeResult([a1, a2, b1], { symbolCount: 3 })

      const text = RepoMapFormatter.toText(result)
      const lines = text.split('\n')

      // First line: header
      expect(lines[0]).toBe('# repo-map: 3 symbols')

      // Should have blank lines separating file groups
      const blankIndices = lines.map((l, i) => (l === '' ? i : -1)).filter((i) => i !== -1)
      expect(blankIndices.length).toBeGreaterThanOrEqual(2)
    })

    it('formats each symbol as filePath:lineNumber symbolType symbolName(signature)', () => {
      const sym = makeScored({
        filePath: 'src/state/store.ts',
        symbolName: 'StateStore',
        symbolType: 'class',
        lineNumber: 42,
        signature: 'config: AppConfig',
      })
      const result = makeResult([sym])
      const text = RepoMapFormatter.toText(result)

      expect(text).toContain('src/state/store.ts:42 class StateStore(config: AppConfig)')
    })

    it('uses empty parens when signature is undefined', () => {
      const sym = makeScored({
        filePath: 'src/foo.ts',
        symbolName: 'Foo',
        symbolType: 'interface',
        lineNumber: 1,
        signature: undefined,
      })
      const result = makeResult([sym])
      const text = RepoMapFormatter.toText(result)

      expect(text).toContain('src/foo.ts:1 interface Foo()')
    })

    it('produces correct header for empty result', () => {
      const result = makeResult([], { symbolCount: 0 })
      const text = RepoMapFormatter.toText(result)
      expect(text).toBe('# repo-map: 0 symbols')
    })

    it('multiple files get blank line before each file group', () => {
      const fileA = makeScored({ filePath: 'src/a.ts', symbolName: 'A', lineNumber: 1 })
      const fileB = makeScored({ filePath: 'src/b.ts', symbolName: 'B', lineNumber: 1 })
      const result = makeResult([fileA, fileB], { symbolCount: 2 })
      const text = RepoMapFormatter.toText(result)
      const lines = text.split('\n')

      // line 0: header
      // line 1: blank (before src/a.ts group)
      // line 2: src/a.ts:1 class A()
      // line 3: blank (before src/b.ts group)
      // line 4: src/b.ts:1 class B()
      expect(lines[0]).toBe('# repo-map: 2 symbols')
      expect(lines[1]).toBe('')
      expect(lines[2]).toBe('src/a.ts:1 class A()')
      expect(lines[3]).toBe('')
      expect(lines[4]).toBe('src/b.ts:1 class B()')
    })
  })

  describe('AC7: toJson()', () => {
    it('returns a valid JSON string', () => {
      const sym = makeScored({ symbolName: 'Foo', filePath: 'src/foo.ts' })
      const result = makeResult([sym])
      const json = RepoMapFormatter.toJson(result)

      expect(() => JSON.parse(json)).not.toThrow()
    })

    it('parsed JSON matches the original result object', () => {
      const sym = makeScored({
        filePath: 'src/bar.ts',
        symbolName: 'BarClass',
        symbolType: 'class',
        signature: '(x: number)',
        lineNumber: 7,
        dependencies: ['Dep1'],
        fileHash: 'sha256hash',
        relevanceScore: 90,
      })
      const result = makeResult([sym], { truncated: true, queryDurationMs: 42 })
      const parsed = JSON.parse(RepoMapFormatter.toJson(result)) as RepoMapQueryResult

      expect(parsed.symbolCount).toBe(result.symbolCount)
      expect(parsed.truncated).toBe(true)
      expect(parsed.queryDurationMs).toBe(42)
      expect(parsed.symbols).toHaveLength(1)

      const s = parsed.symbols[0]
      expect(s.filePath).toBe('src/bar.ts')
      expect(s.symbolName).toBe('BarClass')
      expect(s.symbolType).toBe('class')
      expect(s.signature).toBe('(x: number)')
      expect(s.lineNumber).toBe(7)
      expect(s.dependencies).toEqual(['Dep1'])
      expect(s.fileHash).toBe('sha256hash')
      expect(s.relevanceScore).toBe(90)
    })

    it('includes all RepoMapSymbol fields in output', () => {
      const sym = makeScored()
      const result = makeResult([sym])
      const parsed = JSON.parse(RepoMapFormatter.toJson(result)) as RepoMapQueryResult
      const s = parsed.symbols[0]

      expect(s).toHaveProperty('filePath')
      expect(s).toHaveProperty('symbolName')
      expect(s).toHaveProperty('symbolType')
      expect(s).toHaveProperty('lineNumber')
      expect(s).toHaveProperty('dependencies')
      expect(s).toHaveProperty('fileHash')
      expect(s).toHaveProperty('relevanceScore')
    })

    it('includes top-level metadata fields', () => {
      const result = makeResult([], { symbolCount: 0, truncated: false, queryDurationMs: 10 })
      const parsed = JSON.parse(RepoMapFormatter.toJson(result)) as RepoMapQueryResult

      expect(parsed).toHaveProperty('symbolCount')
      expect(parsed).toHaveProperty('truncated')
      expect(parsed).toHaveProperty('queryDurationMs')
      expect(parsed).toHaveProperty('symbols')
    })
  })
})
