/**
 * Unit tests for ConflictDetector.
 *
 * Story 53-9: Dispatch Pre-Condition Gating (AC1, AC2, AC3)
 *
 * Tests:
 *   - findOverlappingFiles: intersection, empty arrays, no-overlap
 *   - extractTargetSymbols: class names, interface names, export const; deduplication
 *   - detectNamespaceCollision: hit, miss, file-read error (mocked fs)
 */

// Mock node:fs/promises BEFORE imports so the mock is hoisted
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { ConflictDetector } from '../conflict-detector.js'

const mockReadFile = vi.mocked(readFile)

// ---------------------------------------------------------------------------
// findOverlappingFiles
// ---------------------------------------------------------------------------

describe('ConflictDetector.findOverlappingFiles', () => {
  it('returns the intersection of two non-empty arrays', () => {
    const pending = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    const completed = ['src/b.ts', 'src/c.ts', 'src/d.ts']
    expect(ConflictDetector.findOverlappingFiles(pending, completed)).toEqual(['src/b.ts', 'src/c.ts'])
  })

  it('returns empty array when there is no overlap', () => {
    const pending = ['src/a.ts']
    const completed = ['src/b.ts', 'src/c.ts']
    expect(ConflictDetector.findOverlappingFiles(pending, completed)).toEqual([])
  })

  it('returns empty array when pendingFiles is empty', () => {
    expect(ConflictDetector.findOverlappingFiles([], ['src/b.ts'])).toEqual([])
  })

  it('returns empty array when completedFiles is empty', () => {
    expect(ConflictDetector.findOverlappingFiles(['src/a.ts'], [])).toEqual([])
  })

  it('returns empty array when both arrays are empty', () => {
    expect(ConflictDetector.findOverlappingFiles([], [])).toEqual([])
  })

  it('handles duplicate paths in pending files', () => {
    const pending = ['src/a.ts', 'src/a.ts', 'src/b.ts']
    const completed = ['src/a.ts']
    // Both occurrences of src/a.ts match
    expect(ConflictDetector.findOverlappingFiles(pending, completed)).toEqual([
      'src/a.ts',
      'src/a.ts',
    ])
  })
})

// ---------------------------------------------------------------------------
// extractTargetSymbols
// ---------------------------------------------------------------------------

describe('ConflictDetector.extractTargetSymbols', () => {
  it('extracts exported class names', () => {
    const content = 'export class FooService { }'
    expect(ConflictDetector.extractTargetSymbols(content)).toContain('FooService')
  })

  it('extracts exported interface names', () => {
    const content = 'export interface FooOptions { bar: string }'
    expect(ConflictDetector.extractTargetSymbols(content)).toContain('FooOptions')
  })

  it('extracts export const names', () => {
    const content = 'export const FOO_CONSTANT = 42'
    expect(ConflictDetector.extractTargetSymbols(content)).toContain('FOO_CONSTANT')
  })

  it('extracts exported function names', () => {
    const content = 'export function doThing() { }'
    expect(ConflictDetector.extractTargetSymbols(content)).toContain('doThing')
  })

  it('extracts non-exported class declarations', () => {
    const content = 'class InternalClass { }'
    expect(ConflictDetector.extractTargetSymbols(content)).toContain('InternalClass')
  })

  it('extracts non-exported interface declarations', () => {
    const content = 'interface LocalType { x: number }'
    expect(ConflictDetector.extractTargetSymbols(content)).toContain('LocalType')
  })

  it('returns unique values only when the same name appears multiple times', () => {
    const content = `
      export class Duplicate { }
      class Duplicate { }
    `
    const symbols = ConflictDetector.extractTargetSymbols(content)
    expect(symbols.filter((s) => s === 'Duplicate')).toHaveLength(1)
  })

  it('extracts multiple distinct symbols from a story file', () => {
    const content = `
      export class ConflictDetector { }
      export interface GateResult { }
      export const GATE_VERSION = '1'
    `
    const symbols = ConflictDetector.extractTargetSymbols(content)
    expect(symbols).toContain('ConflictDetector')
    expect(symbols).toContain('GateResult')
    expect(symbols).toContain('GATE_VERSION')
  })

  it('returns empty array for content with no declarations', () => {
    const content = 'const x = 1; // no exports'
    expect(ConflictDetector.extractTargetSymbols(content)).toHaveLength(0)
  })

  it('returns empty array for empty string', () => {
    expect(ConflictDetector.extractTargetSymbols('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// detectNamespaceCollision
// ---------------------------------------------------------------------------

describe('ConflictDetector.detectNamespaceCollision', () => {
  const projectRoot = '/project'

  beforeEach(() => {
    mockReadFile.mockReset()
  })

  it('returns collision when file contains "export class Symbol"', async () => {
    mockReadFile.mockResolvedValueOnce('export class FooService { }' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'FooService',
      ['src/foo.ts'],
      projectRoot,
    )

    expect(result).not.toBeNull()
    expect(result?.symbol).toBe('FooService')
    expect(result?.file).toBe('src/foo.ts')
  })

  it('returns collision when file contains "export interface Symbol"', async () => {
    mockReadFile.mockResolvedValueOnce('export interface FooOptions { }' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'FooOptions',
      ['src/options.ts'],
      projectRoot,
    )

    expect(result).not.toBeNull()
    expect(result?.symbol).toBe('FooOptions')
  })

  it('returns collision when file contains "export const Symbol"', async () => {
    mockReadFile.mockResolvedValueOnce('export const FOO = 1' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'FOO',
      ['src/constants.ts'],
      projectRoot,
    )

    expect(result).not.toBeNull()
    expect(result?.symbol).toBe('FOO')
  })

  it('returns collision when file contains bare "class Symbol"', async () => {
    mockReadFile.mockResolvedValueOnce(' class MyClass extends Base { }' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'MyClass',
      ['src/my-class.ts'],
      projectRoot,
    )

    expect(result).not.toBeNull()
    expect(result?.symbol).toBe('MyClass')
  })

  it('returns null when file does not contain the symbol', async () => {
    mockReadFile.mockResolvedValueOnce('export class OtherClass { }' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'FooService',
      ['src/other.ts'],
      projectRoot,
    )

    expect(result).toBeNull()
  })

  it('returns null when files array is empty', async () => {
    const result = await ConflictDetector.detectNamespaceCollision('FooService', [], projectRoot)
    expect(result).toBeNull()
  })

  it('returns null and skips unreadable file (file-read error case)', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))

    const result = await ConflictDetector.detectNamespaceCollision(
      'FooService',
      ['src/missing.ts'],
      projectRoot,
    )

    expect(result).toBeNull()
  })

  it('skips unreadable file and checks next file', async () => {
    mockReadFile
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce('export class FooService { }' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'FooService',
      ['src/missing.ts', 'src/found.ts'],
      projectRoot,
    )

    expect(result).not.toBeNull()
    expect(result?.file).toBe('src/found.ts')
  })

  it('returns first match when multiple files contain the symbol', async () => {
    mockReadFile
      .mockResolvedValueOnce('export class FooService { }' as unknown as Buffer)
      .mockResolvedValueOnce('export class FooService { }' as unknown as Buffer)

    const result = await ConflictDetector.detectNamespaceCollision(
      'FooService',
      ['src/first.ts', 'src/second.ts'],
      projectRoot,
    )

    expect(result?.file).toBe('src/first.ts')
    // Second file should not have been read
    expect(mockReadFile).toHaveBeenCalledTimes(1)
  })
})
