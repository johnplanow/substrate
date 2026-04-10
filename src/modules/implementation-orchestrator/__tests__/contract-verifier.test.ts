/**
 * Unit tests for Story 25-6: Contract Verifier module.
 *
 * Covers:
 *   AC2: Exported file existence check
 *   AC3: TypeScript type-check for contract mismatches
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContractDeclaration } from '../conflict-detector.js'

// ---------------------------------------------------------------------------
// Module mocks — must appear before imports that use them
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { verifyContracts } from '../contract-verifier.js'

const mockExistsSync = vi.mocked(existsSync)
const mockExecSync = vi.mocked(execSync)
const mockReadFileSync = vi.mocked(readFileSync)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project'

function makeExportDecl(overrides?: Partial<ContractDeclaration>): ContractDeclaration {
  return {
    storyKey: '25-5',
    contractName: 'JudgeResult',
    direction: 'export',
    filePath: 'src/modules/judge/types.ts',
    ...overrides,
  }
}

function makeImportDecl(overrides?: Partial<ContractDeclaration>): ContractDeclaration {
  return {
    storyKey: '25-6',
    contractName: 'JudgeResult',
    direction: 'import',
    filePath: 'src/modules/publisher/types.ts',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: empty declarations
// ---------------------------------------------------------------------------

describe('verifyContracts: no declarations', () => {
  it('returns empty array when declarations is empty', () => {
    const result = verifyContracts([], PROJECT_ROOT)
    expect(result).toEqual([])
  })

  it('returns empty array when all declarations are imports (no exports)', () => {
    const result = verifyContracts([makeImportDecl()], PROJECT_ROOT)
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tests: AC2 — exported file existence check
// ---------------------------------------------------------------------------

describe('verifyContracts: AC2 exported file existence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: all files missing, no tsconfig
    mockExistsSync.mockReturnValue(false)
  })

  it('AC2: exported file exists → passes (no mismatch)', () => {
    // tsconfig.json and tsc binary don't exist — only file check matters
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // The exported file exists
      if (p === `${PROJECT_ROOT}/src/modules/judge/types.ts`) return true
      // tsconfig.json and tsc binary don't exist (skips TS check)
      return false
    })

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)
    expect(result).toEqual([])
  })

  it('AC2: exported file missing → fails with descriptive message', () => {
    // All files missing including the export target
    mockExistsSync.mockReturnValue(false)

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(result).toHaveLength(1)
    expect(result[0]!.contractName).toBe('JudgeResult')
    expect(result[0]!.exporter).toBe('25-5')
    expect(result[0]!.importer).toBe('25-6')
    expect(result[0]!.mismatchDescription).toContain('Exported file not found')
    expect(result[0]!.mismatchDescription).toContain('src/modules/judge/types.ts')
  })

  it('AC2: exported file missing with no importer → reports mismatch with null importer', () => {
    mockExistsSync.mockReturnValue(false)

    const result = verifyContracts([makeExportDecl()], PROJECT_ROOT) // no importer

    expect(result).toHaveLength(1)
    expect(result[0]!.importer).toBeNull()
    expect(result[0]!.mismatchDescription).toContain('Exported file not found')
  })

  it('AC2: multiple importers of same contract → one mismatch per importer', () => {
    mockExistsSync.mockReturnValue(false)

    const declarations: ContractDeclaration[] = [
      makeExportDecl(),
      makeImportDecl({ storyKey: 'imp-1' }),
      makeImportDecl({ storyKey: 'imp-2' }),
    ]

    const result = verifyContracts(declarations, PROJECT_ROOT)

    expect(result).toHaveLength(2)
    const importers = result.map((r) => r.importer).sort()
    expect(importers).toEqual(['imp-1', 'imp-2'])
  })

  it('AC2: multiple different contracts — only checks matching export/import pairs', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // ContractA file exists; ContractB file does not
      return p === `${PROJECT_ROOT}/src/modules/contractA.ts`
    })

    const declarations: ContractDeclaration[] = [
      {
        storyKey: 'exp-a',
        contractName: 'ContractA',
        direction: 'export',
        filePath: 'src/modules/contractA.ts',
      },
      {
        storyKey: 'imp-a',
        contractName: 'ContractA',
        direction: 'import',
        filePath: 'src/consumer.ts',
      },
      {
        storyKey: 'exp-b',
        contractName: 'ContractB',
        direction: 'export',
        filePath: 'src/modules/contractB.ts',
      },
      {
        storyKey: 'imp-b',
        contractName: 'ContractB',
        direction: 'import',
        filePath: 'src/consumer2.ts',
      },
    ]

    const result = verifyContracts(declarations, PROJECT_ROOT)

    // Only ContractB should fail (file missing)
    expect(result).toHaveLength(1)
    expect(result[0]!.contractName).toBe('ContractB')
  })
})

// ---------------------------------------------------------------------------
// Tests: AC3 — TypeScript type-check
// ---------------------------------------------------------------------------

describe('verifyContracts: AC3 TypeScript type-check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AC3: TypeScript type-check passes → no mismatch from tsc', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // All files exist: export file, tsconfig.json, tsc binary
      return (
        p === `${PROJECT_ROOT}/src/modules/judge/types.ts` ||
        p === `${PROJECT_ROOT}/tsconfig.json` ||
        p === `${PROJECT_ROOT}/node_modules/.bin/tsc`
      )
    })
    // tsc succeeds (does not throw)
    mockExecSync.mockReturnValue('' as unknown as Buffer)

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)
    expect(result).toEqual([])
  })

  it('AC3: TypeScript type-check fails → mismatch reported', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // Export file exists, tsconfig exists, tsc binary exists
      return (
        p === `${PROJECT_ROOT}/src/modules/judge/types.ts` ||
        p === `${PROJECT_ROOT}/tsconfig.json` ||
        p === `${PROJECT_ROOT}/node_modules/.bin/tsc`
      )
    })

    // tsc fails with type errors mentioning the export file
    const tscError = {
      message: 'tsc failed',
      stdout: `src/modules/judge/types.ts(5,3): error TS2345: Argument of type 'string' is not assignable`,
      stderr: '',
    }
    mockExecSync.mockImplementation(() => {
      throw tscError
    })

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(result.length).toBeGreaterThan(0)
    const mismatch = result[0]!
    expect(mismatch.contractName).toBe('JudgeResult')
    expect(mismatch.exporter).toBe('25-5')
    expect(mismatch.mismatchDescription).toContain('TypeScript type-check failed')
  })

  it('AC3: tsc fails with generic error not matching any file → still reports mismatch for each pair', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === `${PROJECT_ROOT}/src/modules/judge/types.ts` ||
        p === `${PROJECT_ROOT}/tsconfig.json` ||
        p === `${PROJECT_ROOT}/node_modules/.bin/tsc`
      )
    })

    // tsc fails with generic error not mentioning any file path
    const tscError = {
      message: 'tsc failed',
      stdout: 'error TS5023: Unknown compiler option',
      stderr: '',
    }
    mockExecSync.mockImplementation(() => {
      throw tscError
    })

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.mismatchDescription).toContain('TypeScript type-check failed')
  })

  it('AC3: skips tsc when tsconfig.json is absent', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // Export file exists but no tsconfig.json
      return p === `${PROJECT_ROOT}/src/modules/judge/types.ts`
    })

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    // No tsc errors reported (tsc was skipped)
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('AC3: skips tsc when tsc binary is absent', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // Export file exists and tsconfig exists, but tsc binary is absent
      return (
        p === `${PROJECT_ROOT}/src/modules/judge/types.ts` || p === `${PROJECT_ROOT}/tsconfig.json`
      )
    })

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    // No tsc invocation
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('AC3: tsc is run from the project root', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === `${PROJECT_ROOT}/src/modules/judge/types.ts` ||
        p === `${PROJECT_ROOT}/tsconfig.json` ||
        p === `${PROJECT_ROOT}/node_modules/.bin/tsc`
      )
    })
    mockExecSync.mockReturnValue('' as unknown as Buffer)

    verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('tsc'),
      expect.objectContaining({ cwd: PROJECT_ROOT })
    )
  })

  it('AC3: tsc uses --noEmit flag', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === `${PROJECT_ROOT}/src/modules/judge/types.ts` ||
        p === `${PROJECT_ROOT}/tsconfig.json` ||
        p === `${PROJECT_ROOT}/node_modules/.bin/tsc`
      )
    })
    mockExecSync.mockReturnValue('' as unknown as Buffer)

    verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--noEmit'),
      expect.any(Object)
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: edge cases
// ---------------------------------------------------------------------------

describe('verifyContracts: edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  it('does not throw when declaration has empty filePath', () => {
    const decl: ContractDeclaration = {
      storyKey: '25-5',
      contractName: 'Empty',
      direction: 'export',
      filePath: '',
    }
    expect(() => verifyContracts([decl], PROJECT_ROOT)).not.toThrow()
  })

  it('combines file-missing and tsc errors in one pass without duplicating', () => {
    // The export file is missing (file check fails) AND tsc would also fail
    // But since the file is missing, tsc should still run and may report additional errors

    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // Export file is MISSING, but tsconfig and tsc binary exist
      return p === `${PROJECT_ROOT}/tsconfig.json` || p === `${PROJECT_ROOT}/node_modules/.bin/tsc`
    })

    const tscError = {
      message: 'tsc failed',
      stdout: 'error: Cannot find module',
      stderr: '',
    }
    mockExecSync.mockImplementation(() => {
      throw tscError
    })

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    // Should report at least one mismatch (file missing + tsc error)
    expect(result.length).toBeGreaterThan(0)
    // All mismatches should have the same contract
    const uniqueContracts = new Set(result.map((r) => r.contractName))
    expect(uniqueContracts.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: AC (Story 37-4) non-TypeScript profile skips tsc
// ---------------------------------------------------------------------------

const PROFILE_PATH = `${PROJECT_ROOT}/.substrate/project-profile.yaml`
const TSCONFIG_PATH = `${PROJECT_ROOT}/tsconfig.json`
const TSC_BIN_PATH = `${PROJECT_ROOT}/node_modules/.bin/tsc`
const EXPORT_FILE_PATH = `${PROJECT_ROOT}/src/modules/judge/types.ts`

describe('verifyContracts: AC (Story 37-4) non-TypeScript profile skips tsc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('AC1: non-TypeScript buildCommand (go build) skips tsc even when tsconfig and tsc binary exist', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === PROFILE_PATH || p === TSCONFIG_PATH || p === TSC_BIN_PATH || p === EXPORT_FILE_PATH
      )
    })
    mockReadFileSync.mockReturnValue(
      "project:\n  type: single\n  buildCommand: 'go build ./...'\n  packages: []\n" as unknown as Buffer
    )

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('AC2: TypeScript buildCommand (npm run build) keeps tsc enabled', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === PROFILE_PATH || p === TSCONFIG_PATH || p === TSC_BIN_PATH || p === EXPORT_FILE_PATH
      )
    })
    mockReadFileSync.mockReturnValue(
      "project:\n  type: single\n  buildCommand: 'npm run build'\n  packages: []\n" as unknown as Buffer
    )
    mockExecSync.mockReturnValue('' as unknown as Buffer)

    verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).toHaveBeenCalled()
  })

  it('AC3: monorepo with mixed packages (typescript + go) keeps tsc enabled', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === PROFILE_PATH || p === TSCONFIG_PATH || p === TSC_BIN_PATH || p === EXPORT_FILE_PATH
      )
    })
    mockReadFileSync.mockReturnValue(
      "project:\n  type: monorepo\n  buildCommand: 'turbo build'\n  packages:\n    - path: apps/web\n      language: typescript\n    - path: apps/lock-service\n      language: go\n" as unknown as Buffer
    )
    mockExecSync.mockReturnValue('' as unknown as Buffer)

    verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).toHaveBeenCalled()
  })

  it('AC4: all-non-TypeScript monorepo (go + rust) skips tsc even when tsconfig and tsc binary exist', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return (
        p === PROFILE_PATH || p === TSCONFIG_PATH || p === TSC_BIN_PATH || p === EXPORT_FILE_PATH
      )
    })
    mockReadFileSync.mockReturnValue(
      'project:\n  type: monorepo\n  packages:\n    - path: apps/service\n      language: go\n    - path: apps/worker\n      language: rust\n' as unknown as Buffer
    )

    verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('AC5: no profile present falls through to existing behavior (tsc runs)', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // Profile does NOT exist, but tsconfig, tsc binary, and export file do
      return p === TSCONFIG_PATH || p === TSC_BIN_PATH || p === EXPORT_FILE_PATH
    })
    mockExecSync.mockReturnValue('' as unknown as Buffer)

    verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(mockExecSync).toHaveBeenCalled()
  })

  it('AC6: malformed YAML in profile does not throw; tsc proceeds conservatively', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      return p === PROFILE_PATH
    })
    mockReadFileSync.mockReturnValue(':::invalid yaml:::' as unknown as Buffer)

    expect(() => verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)).not.toThrow()
  })

  it('AC7: non-TypeScript profile + missing exported file still reports Exported file not found mismatch', () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = path as string
      // Only the profile exists; export file, tsconfig, and tsc binary are all absent
      return p === PROFILE_PATH
    })
    mockReadFileSync.mockReturnValue(
      "project:\n  type: single\n  buildCommand: 'go build ./...'\n  packages: []\n" as unknown as Buffer
    )

    const result = verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)

    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.mismatchDescription).toContain('Exported file not found')
    expect(mockExecSync).not.toHaveBeenCalled()
  })
})
