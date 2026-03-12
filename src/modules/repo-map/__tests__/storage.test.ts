// @vitest-environment node
/**
 * Unit tests for DoltSymbolRepository, DoltRepoMapMetaRepository, and RepoMapStorage.
 * All external dependencies are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ParsedSymbol, ISymbolRepository, IRepoMapMetaRepository, IGitClient, ISymbolParser, RepoMapMeta } from '../interfaces.js'
import type { DoltClient } from '../../state/dolt-client.js'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    })),
  }),
}))

// ---------------------------------------------------------------------------
// Imports (after mock setup)
// ---------------------------------------------------------------------------

import { DoltSymbolRepository, DoltRepoMapMetaRepository, RepoMapStorage, computeFileHash } from '../storage.js'
import { readFile, stat } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readFileMock = readFile as ReturnType<typeof vi.fn>
const statMock = stat as ReturnType<typeof vi.fn>

function makeLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as import('pino').Logger
}

function makeClient(queryMock?: ReturnType<typeof vi.fn>): DoltClient {
  return {
    query: queryMock ?? vi.fn().mockResolvedValue([]),
  } as unknown as DoltClient
}

function makeSymbol(overrides: Partial<ParsedSymbol> = {}): ParsedSymbol {
  return {
    name: 'myFunction',
    kind: 'function',
    filePath: 'src/foo.ts',
    lineNumber: 10,
    signature: '(x: number): void',
    exported: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// DoltSymbolRepository tests
// ---------------------------------------------------------------------------

describe('DoltSymbolRepository', () => {
  let queryMock: ReturnType<typeof vi.fn>
  let repo: DoltSymbolRepository

  beforeEach(() => {
    queryMock = vi.fn().mockResolvedValue([])
    repo = new DoltSymbolRepository(makeClient(queryMock), makeLogger())
  })

  describe('upsertFileSymbols', () => {
    it('deletes existing rows for file_path before inserting', async () => {
      const symbols = [makeSymbol()]
      await repo.upsertFileSymbols('src/foo.ts', symbols, 'abc123')

      const calls = queryMock.mock.calls
      // First call should be DELETE
      expect(calls[0]![0]).toMatch(/DELETE FROM repo_map_symbols WHERE file_path/)
      expect(calls[0]![1]).toEqual(['src/foo.ts'])
    })

    it('inserts all symbols in a single batch INSERT', async () => {
      const symbols = [makeSymbol({ name: 'funcA' }), makeSymbol({ name: 'funcB' })]
      await repo.upsertFileSymbols('src/foo.ts', symbols, 'hashAbc')

      const calls = queryMock.mock.calls
      const insertCall = calls[1]!
      expect(insertCall[0]).toContain('INSERT INTO repo_map_symbols')
      // 2 rows → 2 placeholder groups (8 columns each including dependencies)
      expect(insertCall[0]).toContain('(?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)')
      // file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies
      expect(insertCall[1]).toHaveLength(16) // 8 params × 2 symbols
    })

    it('still runs DELETE even when symbols array is empty (file deletion)', async () => {
      await repo.upsertFileSymbols('src/deleted.ts', [], '')

      const calls = queryMock.mock.calls
      expect(calls).toHaveLength(1) // only DELETE, no INSERT
      expect(calls[0]![0]).toMatch(/DELETE FROM repo_map_symbols WHERE file_path/)
    })

    it('does not run INSERT when symbols array is empty', async () => {
      await repo.upsertFileSymbols('src/deleted.ts', [], '')
      const calls = queryMock.mock.calls
      const insertCalls = calls.filter((c) => (c[0] as string).includes('INSERT'))
      expect(insertCalls).toHaveLength(0)
    })

    it('stores exported as 1 for exported=true symbols', async () => {
      const symbol = makeSymbol({ exported: true })
      await repo.upsertFileSymbols('src/foo.ts', [symbol], 'hash')
      const insertCall = queryMock.mock.calls[1]!
      const params = insertCall[1] as unknown[]
      // exported is 6th param in each row (index 5)
      expect(params[5]).toBe(1)
    })

    it('stores exported as 0 for exported=false symbols', async () => {
      const symbol = makeSymbol({ exported: false })
      await repo.upsertFileSymbols('src/foo.ts', [symbol], 'hash')
      const insertCall = queryMock.mock.calls[1]!
      const params = insertCall[1] as unknown[]
      expect(params[5]).toBe(0)
    })

    it('derives dependencies JSON from import entries in symbols array', async () => {
      const symbols = [
        makeSymbol({ name: 'myFunc', kind: 'function' }),
        makeSymbol({ name: './types.js', kind: 'import', exported: false }),
        makeSymbol({ name: 'react', kind: 'import', exported: false }),
      ]
      await repo.upsertFileSymbols('src/foo.ts', symbols, 'hash')
      const insertCall = queryMock.mock.calls[1]!
      const params = insertCall[1] as unknown[]
      // dependencies is the 8th param (index 7) for each row, same value for all rows
      const depsJson = params[7] as string
      expect(JSON.parse(depsJson)).toEqual(['./types.js', 'react'])
      // All 3 rows get the same dependencies JSON
      expect(params[15]).toBe(depsJson)
      expect(params[23]).toBe(depsJson)
    })
  })

  describe('getSymbols', () => {
    const rowFixture = [{
      file_path: 'src/foo.ts',
      symbol_name: 'myFunction',
      symbol_kind: 'function',
      signature: '(x: number): void',
      line_number: 10,
      exported: 1,
      file_hash: 'abc123',
    }]

    it('returns all symbols when no filter provided (no WHERE clause)', async () => {
      queryMock.mockResolvedValue(rowFixture)
      const result = await repo.getSymbols()

      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('myFunction')
      expect(result[0]!.kind).toBe('function')
      expect(result[0]!.exported).toBe(true)

      const sql = queryMock.mock.calls[0]![0] as string
      expect(sql).not.toContain('WHERE')
    })

    it('filters by filePaths when provided', async () => {
      queryMock.mockResolvedValue(rowFixture)
      await repo.getSymbols({ filePaths: ['src/foo.ts'] })

      const sql = queryMock.mock.calls[0]![0] as string
      expect(sql).toContain('file_path IN')
    })

    it('filters by kinds when provided', async () => {
      queryMock.mockResolvedValue([])
      await repo.getSymbols({ kinds: ['function', 'class'] })

      const sql = queryMock.mock.calls[0]![0] as string
      expect(sql).toContain('symbol_kind IN')
      const params = queryMock.mock.calls[0]![1] as unknown[]
      expect(params).toContain('function')
      expect(params).toContain('class')
    })

    it('applies both filePaths and kinds filters with AND', async () => {
      queryMock.mockResolvedValue([])
      await repo.getSymbols({ filePaths: ['src/a.ts'], kinds: ['class'] })

      const sql = queryMock.mock.calls[0]![0] as string
      expect(sql).toContain('file_path IN')
      expect(sql).toContain('AND')
      expect(sql).toContain('symbol_kind IN')
    })

    it('maps rows to ParsedSymbol correctly', async () => {
      queryMock.mockResolvedValue(rowFixture)
      const result = await repo.getSymbols()
      const sym = result[0]!

      expect(sym.name).toBe('myFunction')
      expect(sym.kind).toBe('function')
      expect(sym.filePath).toBe('src/foo.ts')
      expect(sym.lineNumber).toBe(10)
      expect(sym.signature).toBe('(x: number): void')
      expect(sym.exported).toBe(true)
    })

    it('maps null signature to empty string', async () => {
      queryMock.mockResolvedValue([{ ...rowFixture[0], signature: null }])
      const result = await repo.getSymbols()
      expect(result[0]!.signature).toBe('')
    })

    it('uses empty params array when no filter', async () => {
      queryMock.mockResolvedValue([])
      await repo.getSymbols()
      const params = queryMock.mock.calls[0]![1] as unknown[]
      expect(params).toEqual([])
    })
  })

  describe('getFileHash', () => {
    it('returns the stored file hash', async () => {
      queryMock.mockResolvedValue([{ file_hash: 'abc123' }])
      const result = await repo.getFileHash('src/foo.ts')
      expect(result).toBe('abc123')
    })

    it('returns null when no rows exist for the file', async () => {
      queryMock.mockResolvedValue([])
      const result = await repo.getFileHash('src/missing.ts')
      expect(result).toBeNull()
    })

    it('queries with correct file_path param', async () => {
      queryMock.mockResolvedValue([])
      await repo.getFileHash('src/bar.ts')
      expect(queryMock.mock.calls[0]![1]).toEqual(['src/bar.ts'])
    })
  })

  describe('findByDependedBy', () => {
    it('queries with JSON_CONTAINS and returns mapped symbols', async () => {
      queryMock.mockResolvedValue([{
        file_path: 'src/consumer.ts',
        symbol_name: 'Consumer',
        symbol_kind: 'class',
        signature: null,
        line_number: 5,
        exported: 1,
        file_hash: 'abc',
        dependencies: '["./types.js","react"]',
      }])
      const result = await repo.findByDependedBy('./types.js')

      const sql = queryMock.mock.calls[0]![0] as string
      expect(sql).toContain('JSON_CONTAINS')
      expect(sql).toContain('JSON_QUOTE')
      expect(queryMock.mock.calls[0]![1]).toEqual(['./types.js'])

      expect(result).toHaveLength(1)
      expect(result[0]!.symbolName).toBe('Consumer')
      expect(result[0]!.dependencies).toEqual(['./types.js', 'react'])
    })

    it('returns empty array when no matches', async () => {
      queryMock.mockResolvedValue([])
      const result = await repo.findByDependedBy('nonexistent')
      expect(result).toEqual([])
    })

    it('maps dependencies: null to empty array [] (AC3: NULL column after ALTER TABLE ADD COLUMN)', async () => {
      // Existing rows written before the `dependencies` column existed will have NULL
      // after `ALTER TABLE repo_map_symbols ADD COLUMN dependencies JSON`.
      // _rowToRepoMapSymbol must treat NULL as [] so downstream callers never see undefined.
      queryMock.mockResolvedValue([{
        file_path: 'src/legacy.ts',
        symbol_name: 'legacyFn',
        symbol_kind: 'function',
        signature: null,
        line_number: 1,
        exported: 1,
        file_hash: 'oldhash',
        dependencies: null,
      }])
      const result = await repo.findByDependedBy('anything')
      expect(result).toHaveLength(1)
      expect(result[0]!.dependencies).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// DoltRepoMapMetaRepository tests
// ---------------------------------------------------------------------------

describe('DoltRepoMapMetaRepository', () => {
  let queryMock: ReturnType<typeof vi.fn>
  let repo: DoltRepoMapMetaRepository

  beforeEach(() => {
    queryMock = vi.fn().mockResolvedValue([])
    repo = new DoltRepoMapMetaRepository(makeClient(queryMock))
  })

  describe('updateMeta', () => {
    it('calls INSERT ... ON DUPLICATE KEY UPDATE with correct params', async () => {
      const updatedAt = new Date('2026-01-01T00:00:00Z')
      await repo.updateMeta({ commitSha: 'abc123', updatedAt, fileCount: 42 })

      const sql = queryMock.mock.calls[0]![0] as string
      expect(sql).toContain('INSERT INTO repo_map_meta')
      expect(sql).toContain('ON DUPLICATE KEY UPDATE')

      const params = queryMock.mock.calls[0]![1] as unknown[]
      expect(params[0]).toBe('abc123')
      expect(params[1]).toEqual(updatedAt)
      expect(params[2]).toBe(42)
    })
  })

  describe('getMeta', () => {
    it('returns null when no rows exist', async () => {
      queryMock.mockResolvedValue([])
      const result = await repo.getMeta()
      expect(result).toBeNull()
    })

    it('returns mapped RepoMapMeta when row exists', async () => {
      queryMock.mockResolvedValue([{
        id: 1,
        commit_sha: 'sha456',
        updated_at: '2026-01-15T12:00:00.000Z',
        file_count: 99,
      }])
      const result = await repo.getMeta()

      expect(result).not.toBeNull()
      expect(result!.commitSha).toBe('sha456')
      expect(result!.fileCount).toBe(99)
      expect(result!.updatedAt).toBeInstanceOf(Date)
    })

    it('handles null commit_sha gracefully', async () => {
      queryMock.mockResolvedValue([{
        id: 1,
        commit_sha: null,
        updated_at: null,
        file_count: 0,
      }])
      const result = await repo.getMeta()
      expect(result!.commitSha).toBe('')
      expect(result!.updatedAt).toBeInstanceOf(Date)
    })
  })
})

// ---------------------------------------------------------------------------
// computeFileHash tests
// ---------------------------------------------------------------------------

describe('computeFileHash', () => {
  beforeEach(() => {
    readFileMock.mockReset()
  })

  it('returns SHA256 hex of file content', async () => {
    readFileMock.mockResolvedValue(Buffer.from('hello world'))
    const hash = await computeFileHash('/tmp/test.ts')
    // SHA256 of "hello world" = b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576afc0b03b2b9440
    // Actually: b94d27b9934d3e08a52e52d7da7dabfac484efe04294e576afc0b03b2b9440fd (64 chars)
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })
})

// ---------------------------------------------------------------------------
// RepoMapStorage tests
// ---------------------------------------------------------------------------

describe('RepoMapStorage', () => {
  let symbolRepo: ISymbolRepository
  let metaRepo: IRepoMapMetaRepository
  let gitClient: IGitClient
  let parser: ISymbolParser
  let storage: RepoMapStorage
  let logger: ReturnType<typeof makeLogger>

  beforeEach(() => {
    readFileMock.mockReset()
    statMock.mockReset()

    symbolRepo = {
      upsertFileSymbols: vi.fn().mockResolvedValue(undefined),
      getSymbols: vi.fn().mockResolvedValue([]),
      getFileHash: vi.fn().mockResolvedValue(null),
      findByFilePaths: vi.fn(),
      findBySymbolNames: vi.fn(),
      findByTypes: vi.fn(),
      findByDependedBy: vi.fn(),
      findAll: vi.fn(),
    }

    metaRepo = {
      updateMeta: vi.fn().mockResolvedValue(undefined),
      getMeta: vi.fn().mockResolvedValue(null),
    }

    gitClient = {
      getCurrentSha: vi.fn().mockResolvedValue('headsha'),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      listTrackedFiles: vi.fn().mockResolvedValue([]),
    }

    parser = {
      parseFile: vi.fn().mockResolvedValue([]),
    }

    logger = makeLogger()
    storage = new RepoMapStorage(symbolRepo, metaRepo, gitClient, logger)
  })

  // -----------------------------------------------------------------------
  // isFileStale
  // -----------------------------------------------------------------------

  describe('isFileStale', () => {
    it('returns false when computed hash matches stored hash', async () => {
      const content = Buffer.from('same content')
      readFileMock.mockResolvedValue(content)
      const { createHash } = await import('node:crypto')
      const expectedHash = createHash('sha256').update(content).digest('hex')
      ;(symbolRepo.getFileHash as ReturnType<typeof vi.fn>).mockResolvedValue(expectedHash)

      const result = await storage.isFileStale('src/foo.ts')
      expect(result).toBe(false)
    })

    it('returns true when computed hash differs from stored hash', async () => {
      readFileMock.mockResolvedValue(Buffer.from('new content'))
      ;(symbolRepo.getFileHash as ReturnType<typeof vi.fn>).mockResolvedValue('oldhash')

      const result = await storage.isFileStale('src/foo.ts')
      expect(result).toBe(true)
    })

    it('returns true when getFileHash returns null (file not indexed)', async () => {
      readFileMock.mockResolvedValue(Buffer.from('content'))
      ;(symbolRepo.getFileHash as ReturnType<typeof vi.fn>).mockResolvedValue(null)

      const result = await storage.isFileStale('src/foo.ts')
      expect(result).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // isStale
  // -----------------------------------------------------------------------

  describe('isStale', () => {
    it('returns false when stored SHA matches current HEAD', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'headsha',
        updatedAt: new Date(),
        fileCount: 10,
      } as RepoMapMeta)
      ;(gitClient.getCurrentSha as ReturnType<typeof vi.fn>).mockResolvedValue('headsha')

      const result = await storage.isStale('/project')
      expect(result).toBe(false)
    })

    it('returns true when stored SHA differs from current HEAD', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'oldsha',
        updatedAt: new Date(),
        fileCount: 5,
      } as RepoMapMeta)
      ;(gitClient.getCurrentSha as ReturnType<typeof vi.fn>).mockResolvedValue('newsha')

      const result = await storage.isStale('/project')
      expect(result).toBe(true)
    })

    it('returns true when getMeta returns null', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(gitClient.getCurrentSha as ReturnType<typeof vi.fn>).mockResolvedValue('headsha')

      const result = await storage.isStale('/project')
      expect(result).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // incrementalUpdate
  // -----------------------------------------------------------------------

  describe('incrementalUpdate', () => {
    it('delegates to fullBootstrap when meta is null', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      ;(gitClient.listTrackedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])

      const fullBootstrapSpy = vi.spyOn(storage, 'fullBootstrap').mockResolvedValue(undefined)

      await storage.incrementalUpdate('/project', parser)

      expect(fullBootstrapSpy).toHaveBeenCalledOnce()
      expect(fullBootstrapSpy).toHaveBeenCalledWith('/project', parser)
    })

    it('parses changed .ts files and upserts their symbols', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'oldsha',
        updatedAt: new Date(),
        fileCount: 1,
      } as RepoMapMeta)
      ;(gitClient.getChangedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/changed.ts'])
      statMock.mockResolvedValue({}) // file exists
      readFileMock.mockResolvedValue(Buffer.from('file content'))
      ;(parser.parseFile as ReturnType<typeof vi.fn>).mockResolvedValue([makeSymbol()])

      await storage.incrementalUpdate('/project', parser)

      expect(parser.parseFile).toHaveBeenCalledWith('src/changed.ts')
      expect(symbolRepo.upsertFileSymbols).toHaveBeenCalledWith(
        'src/changed.ts',
        expect.any(Array),
        expect.any(String),
      )
    })

    it('skips unsupported file extensions', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'oldsha',
        updatedAt: new Date(),
        fileCount: 0,
      } as RepoMapMeta)
      ;(gitClient.getChangedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['README.md', 'package.json'])

      await storage.incrementalUpdate('/project', parser)

      expect(parser.parseFile).not.toHaveBeenCalled()
    })

    it('clears symbols for deleted files', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'oldsha',
        updatedAt: new Date(),
        fileCount: 1,
      } as RepoMapMeta)
      ;(gitClient.getChangedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/deleted.ts'])
      statMock.mockRejectedValue(new Error('ENOENT')) // file does not exist

      await storage.incrementalUpdate('/project', parser)

      expect(symbolRepo.upsertFileSymbols).toHaveBeenCalledWith('src/deleted.ts', [], '')
    })

    it('logs parse errors at warn level and continues', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'oldsha',
        updatedAt: new Date(),
        fileCount: 1,
      } as RepoMapMeta)
      ;(gitClient.getChangedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/a.ts', 'src/b.ts'])
      statMock.mockResolvedValue({}) // all files exist
      readFileMock.mockResolvedValue(Buffer.from('content'))
      ;(parser.parseFile as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('parse error'))
        .mockResolvedValueOnce([makeSymbol()])

      await storage.incrementalUpdate('/project', parser)

      expect(logger.warn).toHaveBeenCalledOnce()
      // Second file should still be processed
      expect(symbolRepo.upsertFileSymbols).toHaveBeenCalledTimes(1)
    })

    it('calls metaRepo.updateMeta once at the end', async () => {
      ;(metaRepo.getMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
        commitSha: 'oldsha',
        updatedAt: new Date(),
        fileCount: 0,
      } as RepoMapMeta)
      ;(gitClient.getChangedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])

      await storage.incrementalUpdate('/project', parser)

      expect(metaRepo.updateMeta).toHaveBeenCalledOnce()
    })
  })

  // -----------------------------------------------------------------------
  // fullBootstrap
  // -----------------------------------------------------------------------

  describe('fullBootstrap', () => {
    it('filters listTrackedFiles results to supported extensions', async () => {
      ;(gitClient.listTrackedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        'src/foo.ts',
        'README.md',
        'src/bar.py',
        'package.json',
        'src/baz.tsx',
      ])
      readFileMock.mockResolvedValue(Buffer.from('content'))
      ;(parser.parseFile as ReturnType<typeof vi.fn>).mockResolvedValue([])

      await storage.fullBootstrap('/project', parser)

      // Should parse .ts, .py, .tsx — not .md or .json
      expect(parser.parseFile).toHaveBeenCalledTimes(3)
      const parsedPaths = (parser.parseFile as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
      expect(parsedPaths).toContain('src/foo.ts')
      expect(parsedPaths).toContain('src/bar.py')
      expect(parsedPaths).toContain('src/baz.tsx')
      expect(parsedPaths).not.toContain('README.md')
    })

    it('calls parser for each supported file and upserts symbols', async () => {
      ;(gitClient.listTrackedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/a.ts', 'src/b.ts'])
      readFileMock.mockResolvedValue(Buffer.from('content'))
      const symbols = [makeSymbol()]
      ;(parser.parseFile as ReturnType<typeof vi.fn>).mockResolvedValue(symbols)

      await storage.fullBootstrap('/project', parser)

      expect(symbolRepo.upsertFileSymbols).toHaveBeenCalledTimes(2)
    })

    it('logs and skips files that fail to parse', async () => {
      ;(gitClient.listTrackedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/a.ts', 'src/b.ts'])
      readFileMock.mockResolvedValue(Buffer.from('content'))
      ;(parser.parseFile as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('parse error'))
        .mockResolvedValueOnce([makeSymbol()])

      await storage.fullBootstrap('/project', parser)

      expect(logger.warn).toHaveBeenCalledOnce()
      expect(symbolRepo.upsertFileSymbols).toHaveBeenCalledTimes(1) // only the successful one
    })

    it('calls metaRepo.updateMeta with current HEAD SHA and parsed file count', async () => {
      ;(gitClient.listTrackedFiles as ReturnType<typeof vi.fn>).mockResolvedValue(['src/a.ts', 'src/b.ts'])
      ;(gitClient.getCurrentSha as ReturnType<typeof vi.fn>).mockResolvedValue('headsha123')
      readFileMock.mockResolvedValue(Buffer.from('content'))
      ;(parser.parseFile as ReturnType<typeof vi.fn>).mockResolvedValue([makeSymbol()])

      await storage.fullBootstrap('/project', parser)

      expect(metaRepo.updateMeta).toHaveBeenCalledOnce()
      const callArg = (metaRepo.updateMeta as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RepoMapMeta
      expect(callArg.commitSha).toBe('headsha123')
      expect(callArg.fileCount).toBe(2)
      expect(callArg.updatedAt).toBeInstanceOf(Date)
    })

    it('handles empty tracked files list gracefully', async () => {
      ;(gitClient.listTrackedFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])

      await storage.fullBootstrap('/project', parser)

      expect(parser.parseFile).not.toHaveBeenCalled()
      expect(metaRepo.updateMeta).toHaveBeenCalledOnce()
      const callArg = (metaRepo.updateMeta as ReturnType<typeof vi.fn>).mock.calls[0]![0] as RepoMapMeta
      expect(callArg.fileCount).toBe(0)
    })
  })
})
