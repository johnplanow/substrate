import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

import { RepoMapInjector } from '../repo-map-injector.js'
import type { RepoMapQueryEngine, RepoMapQueryResult } from '../../repo-map/index.js'
import type { Logger } from 'pino'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryResult(overrides: Partial<RepoMapQueryResult> = {}): RepoMapQueryResult {
  return {
    symbols: [],
    symbolCount: 0,
    truncated: false,
    queryDurationMs: 1,
    ...overrides,
  }
}

function makeLogger(): Logger {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger
}

function makeQueryEngine(queryFn: Mock = vi.fn()): RepoMapQueryEngine {
  return { query: queryFn } as unknown as RepoMapQueryEngine
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepoMapInjector', () => {
  let queryMock: Mock
  let logger: Logger
  let injector: RepoMapInjector

  beforeEach(() => {
    queryMock = vi.fn()
    logger = makeLogger()
    injector = new RepoMapInjector(makeQueryEngine(queryMock), logger)
  })

  // -------------------------------------------------------------------------
  // AC1: Happy path
  // -------------------------------------------------------------------------
  describe('AC1 — happy path', () => {
    it('calls query with extracted file paths and default tokenBudget', async () => {
      const storyContent = 'Implement src/modules/foo/bar.ts to do something.'
      const fakeResult = makeQueryResult({
        symbols: [
          {
            filePath: 'src/modules/foo/bar.ts',
            symbolName: 'Bar',
            symbolType: 'class',
            lineNumber: 1,
            dependencies: [],
            fileHash: 'abc',
            relevanceScore: 50,
          },
        ],
        symbolCount: 1,
        truncated: false,
        queryDurationMs: 5,
      })
      queryMock.mockResolvedValue(fakeResult)

      const result = await injector.buildContext(storyContent)

      expect(queryMock).toHaveBeenCalledOnce()
      expect(queryMock).toHaveBeenCalledWith({
        files: ['src/modules/foo/bar.ts'],
        maxTokens: 2000,
      })
      expect(result.symbolCount).toBe(1)
      expect(result.truncated).toBe(false)
      expect(result.text).toContain('# repo-map: 1 symbols')
    })

    it('deduplicates repeated file references', async () => {
      const storyContent = 'See src/modules/foo/bar.ts and also src/modules/foo/bar.ts again.'
      queryMock.mockResolvedValue(makeQueryResult({ symbolCount: 0 }))

      await injector.buildContext(storyContent)

      const callArgs = queryMock.mock.calls[0][0]
      expect(callArgs.files).toHaveLength(1)
      expect(callArgs.files).toContain('src/modules/foo/bar.ts')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Graceful fallback when query throws
  // -------------------------------------------------------------------------
  describe('AC2 — query throws', () => {
    it('returns empty InjectionResult without rethrowing', async () => {
      const storyContent = 'Modify src/modules/thing/thing.ts for this feature.'
      queryMock.mockRejectedValue(new Error('Dolt unavailable'))

      const result = await injector.buildContext(storyContent)

      expect(result).toEqual({ text: '', symbolCount: 0, truncated: false })
      expect(logger.warn as Mock).toHaveBeenCalledOnce()
    })

    it('logs warn with error message and storyContent snippet', async () => {
      const storyContent = 'Fix src/modules/x/y.ts now.'
      queryMock.mockRejectedValue(new Error('connection refused'))

      await injector.buildContext(storyContent)

      const warnCall = (logger.warn as Mock).mock.calls[0]
      expect(warnCall[0]).toMatchObject({ error: 'connection refused' })
      expect(typeof warnCall[0].storyContent).toBe('string')
      expect(warnCall[0].storyContent.length).toBeLessThanOrEqual(100)
    })
  })

  // -------------------------------------------------------------------------
  // AC2 (zero symbols): returns empty text (AC2 contract)
  // -------------------------------------------------------------------------
  describe('AC2 — zero symbols returned', () => {
    it('returns empty text and zero symbolCount when query returns no symbols', async () => {
      const storyContent = 'Modify src/modules/empty/module.ts.'
      queryMock.mockResolvedValue(
        makeQueryResult({ symbols: [], symbolCount: 0, truncated: false })
      )

      const result = await injector.buildContext(storyContent)

      expect(result).toEqual({ text: '', symbolCount: 0, truncated: false })
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Token budget passed to query
  // -------------------------------------------------------------------------
  describe('AC3 — token budget', () => {
    it('passes provided tokenBudget as maxTokens to query', async () => {
      const storyContent = 'Update src/modules/budget/module.ts.'
      queryMock.mockResolvedValue(makeQueryResult())

      await injector.buildContext(storyContent, 100)

      expect(queryMock).toHaveBeenCalledWith({
        files: ['src/modules/budget/module.ts'],
        maxTokens: 100,
      })
    })
  })

  // -------------------------------------------------------------------------
  // No file refs: skip query entirely
  // -------------------------------------------------------------------------
  describe('no file references in story', () => {
    it('returns empty result without calling query', async () => {
      const storyContent = 'This story has no source file references at all.'

      const result = await injector.buildContext(storyContent)

      expect(queryMock).not.toHaveBeenCalled()
      expect(result).toEqual({ text: '', symbolCount: 0, truncated: false })
    })
  })

  // -------------------------------------------------------------------------
  // Test file filtering
  // -------------------------------------------------------------------------
  describe('test file filtering', () => {
    it('excludes .test.ts files from the query files array', async () => {
      const storyContent = 'See src/modules/foo/__tests__/bar.test.ts and src/modules/foo/bar.ts.'
      queryMock.mockResolvedValue(makeQueryResult())

      await injector.buildContext(storyContent)

      const callArgs = queryMock.mock.calls[0][0]
      expect(callArgs.files).not.toContain('src/modules/foo/__tests__/bar.test.ts')
      expect(callArgs.files).toContain('src/modules/foo/bar.ts')
    })

    it('excludes .test.tsx files from the query files array', async () => {
      const storyContent = 'Modify src/components/Button.test.tsx and src/components/Button.tsx.'
      queryMock.mockResolvedValue(makeQueryResult())

      await injector.buildContext(storyContent)

      const callArgs = queryMock.mock.calls[0][0]
      expect(callArgs.files).not.toContain('src/components/Button.test.tsx')
      expect(callArgs.files).toContain('src/components/Button.tsx')
    })

    it('returns empty result (no query) when only test files are referenced', async () => {
      const storyContent = 'Add tests in src/modules/foo/__tests__/bar.test.ts.'

      const result = await injector.buildContext(storyContent)

      expect(queryMock).not.toHaveBeenCalled()
      expect(result).toEqual({ text: '', symbolCount: 0, truncated: false })
    })
  })

  // -------------------------------------------------------------------------
  // Default tokenBudget
  // -------------------------------------------------------------------------
  describe('default tokenBudget', () => {
    it('uses 2000 as default tokenBudget when not provided', async () => {
      const storyContent = 'Modify src/modules/abc/def.ts.'
      queryMock.mockResolvedValue(makeQueryResult())

      await injector.buildContext(storyContent)

      const callArgs = queryMock.mock.calls[0][0]
      expect(callArgs.maxTokens).toBe(2000)
    })
  })

  // -------------------------------------------------------------------------
  // truncated flag
  // -------------------------------------------------------------------------
  describe('truncated flag propagation', () => {
    it('propagates truncated=true from query result', async () => {
      const storyContent = 'See src/modules/large/file.ts for many symbols.'
      queryMock.mockResolvedValue(makeQueryResult({ symbolCount: 5, truncated: true }))

      const result = await injector.buildContext(storyContent)

      expect(result.truncated).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // AC5: .substrate/ path guard — explicit src/ filter
  // -------------------------------------------------------------------------
  describe('AC5 — .substrate/ path exclusion guard', () => {
    it('does not query repo-map engine for .substrate/scenarios/ paths in story content', async () => {
      const storyContent = 'Story references .substrate/scenarios/scenario-login.sh for context.'
      queryMock.mockResolvedValue(makeQueryResult())

      await injector.buildContext(storyContent)

      // The .substrate/ path should not be included — query should not be called
      // (the regex only matches src/ paths, so no query should be made)
      expect(queryMock).not.toHaveBeenCalled()
    })

    it('queries only src/ paths when story content contains both src/ and .substrate/ paths', async () => {
      const storyContent =
        'Modify src/modules/foo/bar.ts and see .substrate/scenarios/x.sh for test data.'
      queryMock.mockResolvedValue(makeQueryResult())

      await injector.buildContext(storyContent)

      expect(queryMock).toHaveBeenCalledOnce()
      const callArgs = queryMock.mock.calls[0][0]
      // Only src/ paths should be queried
      expect(callArgs.files).toContain('src/modules/foo/bar.ts')
      // .substrate/ paths must not be in the files list
      const hasSubstratePath = callArgs.files.some((f: string) => f.includes('.substrate/'))
      expect(hasSubstratePath).toBe(false)
    })
  })
})
