/**
 * Unit tests for RepoMapQueryEngine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { ISymbolRepository } from '../interfaces.js'
import type { RepoMapSymbol } from '../types.js'
import { RepoMapQueryEngine } from '../query.js'
import { RepoMapTelemetry } from '../repo-map-telemetry.js'
import type { ITelemetryPersistence } from '../../telemetry/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSymbol(overrides: Partial<RepoMapSymbol> = {}): RepoMapSymbol {
  return {
    filePath: 'src/foo.ts',
    symbolName: 'FooClass',
    symbolType: 'class',
    signature: undefined,
    lineNumber: 10,
    dependencies: [],
    fileHash: 'abc123',
    ...overrides,
  }
}

function makeRepo(
  overrides: Partial<{
    [K in keyof ISymbolRepository]: ISymbolRepository[K]
  }> = {},
): ISymbolRepository {
  return {
    upsertFileSymbols: vi.fn(),
    getSymbols: vi.fn(),
    getFileHash: vi.fn(),
    findByFilePaths: vi.fn().mockResolvedValue([]),
    findBySymbolNames: vi.fn().mockResolvedValue([]),
    findByTypes: vi.fn().mockResolvedValue([]),
    findByDependedBy: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ISymbolRepository
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as import('pino').Logger

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepoMapQueryEngine', () => {
  describe('AC1: files glob filter', () => {
    it('returns only symbols whose filePath matches the glob', async () => {
      const matching = makeSymbol({ filePath: 'src/modules/state/store.ts', symbolName: 'StateStore' })
      const nonMatching = makeSymbol({ filePath: 'src/utils/logger.ts', symbolName: 'createLogger' })

      const repo = makeRepo({
        findAll: vi.fn().mockResolvedValue([matching, nonMatching]),
      })

      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ files: ['src/modules/state/**'] })

      expect(result.symbols).toHaveLength(1)
      expect(result.symbols[0].symbolName).toBe('StateStore')
      expect(result.truncated).toBe(false)
      expect(result.symbolCount).toBe(1)
    })

    it('excludes non-matching symbols', async () => {
      const sym = makeSymbol({ filePath: 'src/other/foo.ts', symbolName: 'OtherFoo' })
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([sym]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ files: ['src/modules/**'] })

      expect(result.symbols).toHaveLength(0)
      expect(result.symbolCount).toBe(0)
    })

    it('orders results by filePath asc then lineNumber asc when scores are equal', async () => {
      const a = makeSymbol({ filePath: 'src/modules/state/a.ts', symbolName: 'Alpha', lineNumber: 20 })
      const b = makeSymbol({ filePath: 'src/modules/state/a.ts', symbolName: 'Beta', lineNumber: 5 })
      const c = makeSymbol({ filePath: 'src/modules/state/b.ts', symbolName: 'Gamma', lineNumber: 1 })

      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([a, b, c]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ files: ['src/modules/state/**'] })

      expect(result.symbols.map(s => s.symbolName)).toEqual(['Beta', 'Alpha', 'Gamma'])
    })
  })

  describe('AC2: multi-filter AND composition', () => {
    it('returns intersection of symbols and types filters', async () => {
      const doltClass = makeSymbol({ symbolName: 'DoltClient', symbolType: 'class', filePath: 'src/a.ts' })
      const stateInterface = makeSymbol({ symbolName: 'StateStore', symbolType: 'interface', filePath: 'src/b.ts' })
      const doltFn = makeSymbol({ symbolName: 'DoltClient', symbolType: 'function', filePath: 'src/c.ts' })

      const repo = makeRepo({
        findBySymbolNames: vi.fn().mockResolvedValue([doltClass, stateInterface, doltFn]),
        findByTypes: vi.fn().mockResolvedValue([doltClass, stateInterface]),
      })

      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({
        symbols: ['DoltClient', 'StateStore'],
        types: ['class', 'interface'],
      })

      // AND logic: only symbols present in BOTH result sets
      const names = result.symbols.map(s => s.symbolName)
      expect(names).toContain('DoltClient')
      expect(names).toContain('StateStore')
      // doltFn is in findBySymbolNames but NOT in findByTypes (it's a function)
      expect(result.symbols.some(s => s.filePath === 'src/c.ts')).toBe(false)
    })

    it('returns all symbols when no filter fields are specified', async () => {
      const syms = [
        makeSymbol({ symbolName: 'A' }),
        makeSymbol({ symbolName: 'B', filePath: 'src/b.ts' }),
      ]
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue(syms) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({})

      expect(result.symbols).toHaveLength(2)
      expect(repo.findAll).toHaveBeenCalled()
    })
  })

  describe('AC3: relevance ranking', () => {
    it('glob-matched symbols score higher than dep-traversal-only symbols', async () => {
      const directMatch = makeSymbol({
        filePath: 'src/modules/state/store.ts',
        symbolName: 'StateStore',
        symbolType: 'class',
      })
      const depTraversal = makeSymbol({
        filePath: 'src/utils/logger.ts',
        symbolName: 'createLogger',
        symbolType: 'function',
      })

      const repo = makeRepo({
        findAll: vi.fn().mockResolvedValue([directMatch]),
        findByDependedBy: vi.fn().mockResolvedValue([depTraversal]),
      })

      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({
        files: ['src/modules/state/**'],
        dependedBy: 'StateStore',
      })

      expect(result.symbols.length).toBeGreaterThanOrEqual(1)
      const first = result.symbols[0]
      expect(first.symbolName).toBe('StateStore')
      expect(first.relevanceScore).toBeGreaterThan(result.symbols[result.symbols.length - 1].relevanceScore || 0)
    })

    it('results are ordered by score descending', async () => {
      const highScore = makeSymbol({ filePath: 'src/modules/state/store.ts', symbolName: 'StateStore', symbolType: 'class' })
      const lowScore = makeSymbol({ filePath: 'src/utils/other.ts', symbolName: 'Other', symbolType: 'function' })

      const repo = makeRepo({
        findAll: vi.fn().mockResolvedValue([lowScore, highScore]),
        findByDependedBy: vi.fn().mockResolvedValue([lowScore]),
      })

      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({
        files: ['src/modules/state/**'],
        dependedBy: 'Foo',
      })

      // highScore matches files glob (90 points), lowScore is dep-traversal only (30 points)
      expect(result.symbols[0].symbolName).toBe('StateStore')
    })
  })

  describe('AC4: token budget truncation', () => {
    it('truncates result when maxTokens is exceeded', async () => {
      // Each symbol with filePath='src/a.ts' (8), symbolName='Sym' (3), no sig, overhead 30 = 41 chars
      // maxTokens=10 → budget = 40 chars → only 0 or 1 symbols fit
      const syms = Array.from({ length: 5 }, (_, i) =>
        makeSymbol({ symbolName: `Sym${i}`, filePath: 'src/a.ts', lineNumber: i + 1 }),
      )
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue(syms) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ maxTokens: 10 })

      expect(result.truncated).toBe(true)
      expect(result.symbolCount).toBeLessThan(5)
      expect(result.symbolCount).toBe(result.symbols.length)
    })

    it('sets truncated: false when all symbols fit', async () => {
      const syms = [makeSymbol({ symbolName: 'Small', filePath: 'src/a.ts' })]
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue(syms) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ maxTokens: 2000 })

      expect(result.truncated).toBe(false)
      expect(result.symbolCount).toBe(1)
    })

    it('symbolCount reflects returned array length after truncation', async () => {
      const syms = Array.from({ length: 10 }, (_, i) =>
        makeSymbol({ symbolName: `Symbol${i}`, filePath: 'src/very/long/path/to/file.ts', lineNumber: i + 1 }),
      )
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue(syms) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ maxTokens: 5 })

      expect(result.symbolCount).toBe(result.symbols.length)
    })
  })

  describe('AC5: dependency traversal', () => {
    it('dependedBy calls findByDependedBy and returns its results', async () => {
      const sym = makeSymbol({ symbolName: 'Consumer', filePath: 'src/consumer.ts' })
      const repo = makeRepo({
        findByDependedBy: vi.fn().mockResolvedValue([sym]),
      })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ dependedBy: 'StoryState' })

      expect(repo.findByDependedBy).toHaveBeenCalledWith('StoryState')
      expect(result.symbols).toHaveLength(1)
      expect(result.symbols[0].symbolName).toBe('Consumer')
    })

    it('dependsOn calls findBySymbolNames then findByFilePaths', async () => {
      const target = makeSymbol({
        symbolName: 'StoryRunner',
        filePath: 'src/runner.ts',
        dependencies: ['src/dep-a.ts', 'src/dep-b.ts'],
      })
      const depSymA = makeSymbol({ symbolName: 'DepA', filePath: 'src/dep-a.ts' })
      const depSymB = makeSymbol({ symbolName: 'DepB', filePath: 'src/dep-b.ts' })

      const repo = makeRepo({
        findBySymbolNames: vi.fn().mockResolvedValue([target]),
        findByFilePaths: vi.fn().mockResolvedValue([depSymA, depSymB]),
      })

      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ dependsOn: 'StoryRunner' })

      expect(repo.findBySymbolNames).toHaveBeenCalledWith(['StoryRunner'])
      expect(repo.findByFilePaths).toHaveBeenCalledWith(['src/dep-a.ts', 'src/dep-b.ts'])
      expect(result.symbols.map(s => s.symbolName)).toContain('DepA')
      expect(result.symbols.map(s => s.symbolName)).toContain('DepB')
    })

    it('dependsOn with no dependencies returns empty result', async () => {
      const target = makeSymbol({ symbolName: 'Isolated', dependencies: [] })
      const repo = makeRepo({
        findBySymbolNames: vi.fn().mockResolvedValue([target]),
        findByFilePaths: vi.fn().mockResolvedValue([]),
      })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ dependsOn: 'Isolated' })

      expect(repo.findByFilePaths).not.toHaveBeenCalled()
      expect(result.symbols).toHaveLength(0)
    })

    it('dependsOn with unknown symbol returns empty result', async () => {
      const repo = makeRepo({ findBySymbolNames: vi.fn().mockResolvedValue([]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ dependsOn: 'Unknown' })

      expect(result.symbols).toHaveLength(0)
    })
  })

  describe('scoring details', () => {
    it('file match gives base 50 + 40 = 90', async () => {
      const sym = makeSymbol({ filePath: 'src/modules/state/store.ts', symbolName: 'Store' })
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([sym]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ files: ['src/modules/state/**'] })

      expect(result.symbols[0].relevanceScore).toBe(90)
    })

    it('symbol name match gives base 50 + 20 = 70', async () => {
      const sym = makeSymbol({ symbolName: 'DoltClient' })
      const repo = makeRepo({ findBySymbolNames: vi.fn().mockResolvedValue([sym]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ symbols: ['DoltClient'] })

      expect(result.symbols[0].relevanceScore).toBe(70)
    })

    it('type match gives base 50 + 10 = 60', async () => {
      const sym = makeSymbol({ symbolType: 'class' })
      const repo = makeRepo({ findByTypes: vi.fn().mockResolvedValue([sym]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ types: ['class'] })

      expect(result.symbols[0].relevanceScore).toBe(60)
    })

    it('dep traversal gives base 30', async () => {
      const sym = makeSymbol({ symbolName: 'Consumer', filePath: 'src/consumer.ts' })
      const repo = makeRepo({ findByDependedBy: vi.fn().mockResolvedValue([sym]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      const result = await engine.query({ dependedBy: 'StoryState' })

      expect(result.symbols[0].relevanceScore).toBe(30)
    })
  })

  describe('no filter — findAll', () => {
    it('calls findAll when query has no filter fields', async () => {
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      await engine.query({})
      expect(repo.findAll).toHaveBeenCalled()
    })

    it('maxTokens and outputFormat alone do not count as filters', async () => {
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([]) })
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      await engine.query({ maxTokens: 500, outputFormat: 'text' })
      expect(repo.findAll).toHaveBeenCalled()
    })
  })

  describe('AC6: optional telemetry injection — finally block', () => {
    function createMockTelemetryPersistence(): ITelemetryPersistence {
      return {
        recordSpan: vi.fn(),
        persistSpan: vi.fn(),
        getSpans: vi.fn(),
        listSpans: vi.fn(),
      } as unknown as ITelemetryPersistence
    }

    it('calls telemetry.recordQuery on successful query with correct attributes', async () => {
      const sym = makeSymbol({ symbolName: 'Foo', filePath: 'src/foo.ts' })
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([sym]) })
      const telemetryPersistence = createMockTelemetryPersistence()
      const telemetry = new RepoMapTelemetry(telemetryPersistence, silentLogger)
      const recordQuerySpy = vi.spyOn(telemetry, 'recordQuery')

      const engine = new RepoMapQueryEngine(repo, silentLogger, telemetry)
      const result = await engine.query({})

      expect(recordQuerySpy).toHaveBeenCalledOnce()
      const callArgs = recordQuerySpy.mock.calls[0][0]
      expect(callArgs.symbolCount).toBe(result.symbolCount)
      expect(callArgs.truncated).toBe(result.truncated)
      expect(callArgs.queryDurationMs).toBeGreaterThanOrEqual(0)
      expect(callArgs.error).toBeUndefined()
    })

    it('calls telemetry.recordQuery with error: true when repo throws', async () => {
      const repo = makeRepo({
        findAll: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      })
      const telemetryPersistence = createMockTelemetryPersistence()
      const telemetry = new RepoMapTelemetry(telemetryPersistence, silentLogger)
      const recordQuerySpy = vi.spyOn(telemetry, 'recordQuery')

      const engine = new RepoMapQueryEngine(repo, silentLogger, telemetry)
      await expect(engine.query({})).rejects.toThrow('DB connection failed')

      expect(recordQuerySpy).toHaveBeenCalledOnce()
      const callArgs = recordQuerySpy.mock.calls[0][0]
      expect(callArgs.error).toBe(true)
      expect(callArgs.symbolCount).toBe(0)
    })

    it('does not call telemetry when no telemetry instance is provided', async () => {
      const repo = makeRepo({ findAll: vi.fn().mockResolvedValue([]) })
      // construct engine WITHOUT telemetry — third arg omitted
      const engine = new RepoMapQueryEngine(repo, silentLogger)
      // should not throw
      await expect(engine.query({})).resolves.toBeDefined()
    })

    it('passes filterFields derived from query keys with non-undefined values', async () => {
      const sym = makeSymbol({ symbolName: 'Bar' })
      const repo = makeRepo({
        findBySymbolNames: vi.fn().mockResolvedValue([sym]),
      })
      const telemetryPersistence = createMockTelemetryPersistence()
      const telemetry = new RepoMapTelemetry(telemetryPersistence, silentLogger)
      const recordQuerySpy = vi.spyOn(telemetry, 'recordQuery')

      const engine = new RepoMapQueryEngine(repo, silentLogger, telemetry)
      await engine.query({ symbols: ['Bar'] })

      const callArgs = recordQuerySpy.mock.calls[0][0]
      expect(callArgs.filterFields).toContain('symbols')
    })
  })
})
