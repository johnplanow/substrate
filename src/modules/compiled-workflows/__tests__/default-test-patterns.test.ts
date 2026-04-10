/**
 * Unit tests for resolveDefaultTestPatterns() — Story 37-6
 *
 * Verifies stack-aware test pattern resolution from .substrate/project-profile.yaml.
 * Mocks node:fs to prevent real file I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock node:fs (synchronous — resolver uses readFileSync/existsSync)
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs'
import { resolveDefaultTestPatterns, VITEST_DEFAULT_PATTERNS } from '../default-test-patterns.js'

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)

// ---------------------------------------------------------------------------
// Helper: build a profile YAML string
// ---------------------------------------------------------------------------

function makeProfile(project: Record<string, unknown>): string {
  const entries = Object.entries(project)
    .map(([k, v]) => `  ${k}: '${v}'`)
    .join('\n')
  return `project:\n${entries}\n`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveDefaultTestPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC7: Vitest fallback cases
  // -------------------------------------------------------------------------

  describe('Vitest fallback (backward compat)', () => {
    it('returns Vitest patterns when projectRoot is undefined', () => {
      const result = resolveDefaultTestPatterns(undefined)
      expect(result).toContain('vitest')
      expect(result).not.toContain('go test')
      // No file I/O should be attempted
      expect(mockExistsSync).not.toHaveBeenCalled()
      expect(mockReadFileSync).not.toHaveBeenCalled()
    })

    it('returns Vitest patterns when projectRoot is empty string', () => {
      const result = resolveDefaultTestPatterns('')
      expect(result).toContain('vitest')
      expect(mockExistsSync).not.toHaveBeenCalled()
    })

    it('returns Vitest patterns when profile file does not exist', () => {
      mockExistsSync.mockReturnValue(false)
      const result = resolveDefaultTestPatterns('/some/project')
      expect(result).toContain('vitest')
      expect(mockReadFileSync).not.toHaveBeenCalled()
    })

    it('returns Vitest patterns when profile YAML is invalid', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        '::: invalid yaml :::' as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/some/project')
      expect(result).toContain('vitest')
    })

    it('returns Vitest patterns for unrecognized testCommand (bazel test)', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ testCommand: 'bazel test //...' }) as unknown as ReturnType<
          typeof readFileSync
        >
      )
      const result = resolveDefaultTestPatterns('/some/project')
      expect(result).toContain('vitest')
    })

    it('returns Vitest patterns when profile YAML parses to null', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('null\n' as unknown as ReturnType<typeof readFileSync>)
      const result = resolveDefaultTestPatterns('/some/project')
      expect(result).toContain('vitest')
    })

    it('returns the VITEST_DEFAULT_PATTERNS export when falling back', () => {
      const result = resolveDefaultTestPatterns(undefined)
      expect(result).toBe(VITEST_DEFAULT_PATTERNS)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Go stack
  // -------------------------------------------------------------------------

  describe('Go stack', () => {
    it('returns Go patterns when testCommand contains "go test ./..."', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ testCommand: 'go test ./...' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/go/project')
      expect(result).toContain('go test')
      expect(result).not.toContain('vitest')
    })

    it('returns Go patterns via language field when testCommand absent', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ language: 'go' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/go/project')
      expect(result).toContain('go test')
      expect(result).not.toContain('vitest')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Gradle stack
  // -------------------------------------------------------------------------

  describe('Gradle (JVM) stack', () => {
    it('returns Gradle patterns when testCommand contains "./gradlew test"', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ testCommand: './gradlew test' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/java/project')
      expect(result).toContain('./gradlew test')
      expect(result).toContain('@Test')
      expect(result).not.toContain('vitest')
    })

    it('returns Gradle patterns via language=kotlin', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ language: 'kotlin' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/kotlin/project')
      expect(result).toContain('./gradlew test')
    })

    it('returns Gradle patterns via language=java', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ language: 'java' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/java/project')
      expect(result).toContain('./gradlew test')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Maven stack
  // -------------------------------------------------------------------------

  describe('Maven stack', () => {
    it('returns Maven patterns when testCommand contains "mvn test"', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ testCommand: 'mvn test' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/maven/project')
      expect(result).toContain('mvn test')
      expect(result).not.toContain('vitest')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Cargo (Rust) stack
  // -------------------------------------------------------------------------

  describe('Cargo (Rust) stack', () => {
    it('returns Cargo patterns when testCommand contains "cargo test"', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ testCommand: 'cargo test' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/rust/project')
      expect(result).toContain('cargo test')
      expect(result).toContain('#[test]')
      expect(result).not.toContain('vitest')
    })

    it('returns Cargo patterns via language=rust', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ language: 'rust' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/rust/project')
      expect(result).toContain('cargo test')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: pytest (Python) stack
  // -------------------------------------------------------------------------

  describe('pytest (Python) stack', () => {
    it('returns pytest patterns when testCommand contains "pytest"', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ testCommand: 'pytest' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/py/project')
      expect(result).toContain('pytest')
      expect(result).not.toContain('vitest')
    })

    it('returns pytest patterns via language=python', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        makeProfile({ language: 'python' }) as unknown as ReturnType<typeof readFileSync>
      )
      const result = resolveDefaultTestPatterns('/py/project')
      expect(result).toContain('pytest')
    })
  })

  // -------------------------------------------------------------------------
  // Profile path resolution
  // -------------------------------------------------------------------------

  it('reads profile from .substrate/project-profile.yaml relative to projectRoot', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      makeProfile({ testCommand: 'go test ./...' }) as unknown as ReturnType<typeof readFileSync>
    )
    resolveDefaultTestPatterns('/my/project')
    expect(mockExistsSync).toHaveBeenCalledWith('/my/project/.substrate/project-profile.yaml')
    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/my/project/.substrate/project-profile.yaml',
      'utf-8'
    )
  })
})
