// @vitest-environment node
/**
 * Unit tests for the `substrate repo-map` command.
 *
 * Story 28-9: CLI Commands, Full-Stack Wiring, and Staleness Detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/tmp/test-project'),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Story content\nSee src/modules/foo/bar.ts'),
}))

const {
  mockGetMeta,
  mockCheckStaleness,
  mockQuery,
  mockGetSymbols,
  mockBuildContext,
  mockIncrementalUpdate,
} = vi.hoisted(() => ({
  mockGetMeta: vi.fn().mockResolvedValue(null),
  mockCheckStaleness: vi.fn().mockResolvedValue(null),
  mockQuery: vi.fn().mockResolvedValue({ symbols: [], symbolCount: 0, truncated: false, queryDurationMs: 1 }),
  mockGetSymbols: vi.fn().mockResolvedValue([]),
  mockBuildContext: vi.fn().mockResolvedValue({ text: '', symbolCount: 0, truncated: false }),
  mockIncrementalUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../modules/state/index.js', () => ({
  DoltClient: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../../modules/repo-map/index.js', () => ({
  DoltSymbolRepository: vi.fn().mockImplementation(() => ({
    getSymbols: mockGetSymbols,
  })),
  DoltRepoMapMetaRepository: vi.fn().mockImplementation(() => ({
    getMeta: mockGetMeta,
  })),
  RepoMapQueryEngine: vi.fn().mockImplementation(() => ({
    query: mockQuery,
  })),
  RepoMapModule: vi.fn().mockImplementation(() => ({
    checkStaleness: mockCheckStaleness,
  })),
  RepoMapStorage: vi.fn().mockImplementation(() => ({
    incrementalUpdate: mockIncrementalUpdate,
  })),
  GitClient: vi.fn().mockImplementation(() => ({})),
  GrammarLoader: vi.fn().mockImplementation(() => ({})),
  SymbolParser: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../../modules/context-compiler/index.js', () => ({
  RepoMapInjector: vi.fn().mockImplementation(() => ({
    buildContext: mockBuildContext,
  })),
}))

import { Command } from 'commander'
import { registerRepoMapCommand } from '../repo-map.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProgram(): Command {
  const program = new Command()
  program.exitOverride()
  registerRepoMapCommand(program)
  return program
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('repo-map command', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // Default: no Dolt backend
    const { existsSync } = await import('node:fs')
    vi.mocked(existsSync).mockReturnValue(false)
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  describe('no Dolt backend', () => {
    it('emits a hint to stderr when Dolt is not available (--show)', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show'])

      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toMatch(/Dolt/i)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })

    it('emits JSON with unavailable status when Dolt is not available', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.backend).toBe('file')
      expect(parsed.status).toBe('unavailable')
    })

    it('emits error for --update without Dolt', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--update'])

      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toMatch(/Dolt/i)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })
  })

  describe('--query validation', () => {
    it('rejects invalid symbol names with non-identifier characters', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--query', 'invalid-name!'])

      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toMatch(/must match/)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })

    it('rejects symbol names with slashes', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--query', 'src/file.ts'])

      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).toMatch(/must match/)
      expect(process.exitCode).toBe(1)
      process.exitCode = 0
    })

    it('accepts valid alphanumeric symbol names (with Dolt)', async () => {
      const { existsSync } = await import('node:fs')
      vi.mocked(existsSync).mockReturnValue(true)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--query', 'validSymbol123'])

      const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(stderrOutput).not.toMatch(/must match/)
    })
  })

  describe('--show with Dolt backend', () => {
    beforeEach(async () => {
      const { existsSync } = await import('node:fs')
      vi.mocked(existsSync).mockReturnValue(true)
    })

    it('outputs JSON with AC-required shape when meta exists', async () => {
      mockGetMeta.mockResolvedValue({
        commitSha: 'abc123',
        updatedAt: new Date('2026-03-09T12:00:00.000Z'),
        fileCount: 10,
      })
      mockCheckStaleness.mockResolvedValue(null)
      mockGetSymbols.mockResolvedValue(new Array(42))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show', '--output-format', 'json'])

      expect(consoleSpy).toHaveBeenCalledOnce()
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.symbolCount).toBe(42)
      expect(parsed.commitSha).toBe('abc123')
      expect(parsed.fileCount).toBe(10)
      expect(parsed.updatedAt).toBe('2026-03-09T12:00:00.000Z')
      expect(parsed.staleness).toBe('current')
    })

    it('shows staleness as stale when checkStaleness returns non-null', async () => {
      mockGetMeta.mockResolvedValue({
        commitSha: 'abc123',
        updatedAt: new Date('2026-03-09T12:00:00.000Z'),
        fileCount: 10,
      })
      mockCheckStaleness.mockResolvedValue({ storedSha: 'abc123', headSha: 'def456', fileCount: 10 })
      mockGetSymbols.mockResolvedValue(new Array(42))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show', '--output-format', 'json'])

      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.staleness).toBe('stale')
    })

    it('shows staleness as unknown when no meta exists', async () => {
      mockGetMeta.mockResolvedValue(null)

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show', '--output-format', 'json'])

      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.staleness).toBe('unknown')
      expect(parsed.symbolCount).toBe(0)
    })

    it('shows text output with UP TO DATE when current', async () => {
      mockGetMeta.mockResolvedValue({
        commitSha: 'abc123',
        updatedAt: new Date('2026-03-09T12:00:00.000Z'),
        fileCount: 10,
      })
      mockCheckStaleness.mockResolvedValue(null)
      mockGetSymbols.mockResolvedValue(new Array(5))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toMatch(/UP TO DATE/)
      expect(output).toMatch(/5 symbols/)
    })

    it('shows text output with STALE when stale', async () => {
      mockGetMeta.mockResolvedValue({
        commitSha: 'abc123',
        updatedAt: new Date('2026-03-09T12:00:00.000Z'),
        fileCount: 10,
      })
      mockCheckStaleness.mockResolvedValue({ storedSha: 'abc123', headSha: 'def456', fileCount: 10 })
      mockGetSymbols.mockResolvedValue([])

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--show'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toMatch(/STALE/)
    })
  })

  describe('--update with Dolt backend', () => {
    beforeEach(async () => {
      const { existsSync } = await import('node:fs')
      vi.mocked(existsSync).mockReturnValue(true)
    })

    it('calls incrementalUpdate and reports result', async () => {
      mockGetMeta.mockResolvedValue({
        commitSha: 'newsha',
        updatedAt: new Date('2026-03-10T00:00:00.000Z'),
        fileCount: 15,
      })
      mockGetSymbols.mockResolvedValue(new Array(100))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--update'])

      expect(mockIncrementalUpdate).toHaveBeenCalledOnce()
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(output).toMatch(/updated/i)
    })

    it('outputs JSON with result fields', async () => {
      mockGetMeta.mockResolvedValue({
        commitSha: 'newsha',
        updatedAt: new Date('2026-03-10T00:00:00.000Z'),
        fileCount: 15,
      })
      mockGetSymbols.mockResolvedValue(new Array(100))

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--update', '--output-format', 'json'])

      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.result).toBe('updated')
      expect(parsed.symbolCount).toBe(100)
    })
  })

  describe('--query with Dolt backend', () => {
    beforeEach(async () => {
      const { existsSync } = await import('node:fs')
      vi.mocked(existsSync).mockReturnValue(true)
    })

    it('calls queryEngine.query with the symbol name', async () => {
      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--query', 'mySymbol'])

      expect(mockQuery).toHaveBeenCalledWith({ symbols: ['mySymbol'], maxTokens: 4000 })
    })

    it('displays results in text mode', async () => {
      mockQuery.mockResolvedValue({
        symbols: [{ filePath: 'src/foo.ts', lineNumber: 10, symbolType: 'function', symbolName: 'mySymbol', dependencies: [], fileHash: 'abc', relevanceScore: 50 }],
        symbolCount: 1,
        truncated: false,
        queryDurationMs: 5,
      })

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--query', 'mySymbol'])

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(output).toContain('src/foo.ts:10')
      expect(output).toContain('function')
    })
  })

  describe('--dry-run with Dolt backend', () => {
    beforeEach(async () => {
      const { existsSync } = await import('node:fs')
      vi.mocked(existsSync).mockReturnValue(true)
    })

    it('calls buildContext and outputs JSON', async () => {
      mockBuildContext.mockResolvedValue({ text: '# repo-map', symbolCount: 3, truncated: false })

      const program = createProgram()
      await program.parseAsync(['node', 'substrate', 'repo-map', '--dry-run', '/tmp/story.md'])

      expect(mockBuildContext).toHaveBeenCalledWith(expect.any(String), 2000)
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as Record<string, unknown>
      expect(parsed.symbolCount).toBe(3)
      expect(parsed.truncated).toBe(false)
    })
  })
})
