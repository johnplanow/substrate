/**
 * Unit tests for interface-change-detector.ts (Story 24-3)
 *
 * Covers:
 *   AC1: Extract exported interface/type names from modified .ts files
 *   AC2: Cross-reference test files for modified interface names
 *   AC3: Warning event structure (result shape — orchestrator emits event)
 *   AC4: Same-module test files are filtered out (no false positives)
 *   AC5: Graceful degradation on detection errors
 *
 * Mocks node:fs (readFileSync) and node:child_process (execSync) to avoid
 * touching the real filesystem or spawning grep processes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractExportedNames, detectInterfaceChanges } from '../interface-change-detector.js'

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: vi.fn(),
  }
})

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const mockReadFileSync = vi.mocked(readFileSync)
const mockExecSync = vi.mocked(execSync)

// ---------------------------------------------------------------------------
// extractExportedNames() unit tests
// ---------------------------------------------------------------------------

describe('extractExportedNames()', () => {
  it('extracts export interface Foo', () => {
    const content = `
export interface Foo {
  bar: string
}
`
    expect(extractExportedNames(content)).toContain('Foo')
  })

  it('extracts export type Bar', () => {
    const content = `
export type Bar = string | number
`
    expect(extractExportedNames(content)).toContain('Bar')
  })

  it('extracts multiple exported names from the same file', () => {
    const content = `
export interface Foo {}
export type Bar = string
export interface Baz {}
`
    const names = extractExportedNames(content)
    expect(names).toContain('Foo')
    expect(names).toContain('Bar')
    expect(names).toContain('Baz')
    expect(names).toHaveLength(3)
  })

  it('returns empty array when file has no exported interfaces or types', () => {
    const content = `
const x = 5
function foo() {}
class MyClass {}
`
    expect(extractExportedNames(content)).toEqual([])
  })

  it('does not extract non-exported interface declarations', () => {
    const content = `
interface Foo {}
type Bar = string
`
    expect(extractExportedNames(content)).toEqual([])
  })

  it('does not extract export const, export function, export class', () => {
    const content = `
export const FOO = 1
export function bar() {}
export class Baz {}
export default class MyClass {}
`
    expect(extractExportedNames(content)).toEqual([])
  })

  it('handles re-exports without extracting names', () => {
    const content = `
export { Foo, Bar } from './other.js'
export * from './types.js'
`
    expect(extractExportedNames(content)).toEqual([])
  })

  it('extracts names from complex TypeScript file with mixed content', () => {
    const content = `
import { something } from './foo.js'

const internal = 5

export interface DispatcherMemoryState {
  freeMB: number
  thresholdMB: number
  pressureLevel: number
  isPressured: boolean
}

export type StoryPhase = 'PENDING' | 'IN_PROGRESS' | 'COMPLETE' | 'ESCALATED'

export function createDispatcher() {}
`
    const names = extractExportedNames(content)
    expect(names).toContain('DispatcherMemoryState')
    expect(names).toContain('StoryPhase')
    expect(names).not.toContain('createDispatcher')
    expect(names).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// detectInterfaceChanges() unit tests
// ---------------------------------------------------------------------------

describe('detectInterfaceChanges()', () => {
  const projectRoot = '/fake/project'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC1: Detect Interface-Exporting Files in Diff
  // -------------------------------------------------------------------------

  it('AC1: extracts exported interface name from modified .ts file', () => {
    mockReadFileSync.mockReturnValue('export interface MyInterface {\n  field: string\n}\n')
    mockExecSync.mockReturnValue('')

    const result = detectInterfaceChanges({
      filesModified: ['src/foo.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.modifiedInterfaces).toContain('MyInterface')
  })

  it('AC1: extracts exported type name from modified .ts file', () => {
    mockReadFileSync.mockReturnValue('export type MyType = string\n')
    mockExecSync.mockReturnValue('')

    const result = detectInterfaceChanges({
      filesModified: ['src/foo.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.modifiedInterfaces).toContain('MyType')
  })

  it('AC1: returns empty result when filesModified has no .ts files', () => {
    const result = detectInterfaceChanges({
      filesModified: ['README.md', 'package.json', '.gitignore'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.modifiedInterfaces).toEqual([])
    expect(result.potentiallyAffectedTests).toEqual([])
    // Should not attempt to read non-.ts files
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('AC1: returns empty result when modified .ts files have no exported interfaces', () => {
    mockReadFileSync.mockReturnValue('const x = 5\nexport function foo() {}\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/foo.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.modifiedInterfaces).toEqual([])
    expect(result.potentiallyAffectedTests).toEqual([])
    // Should not run grep when no names found
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('AC1: skips .test.ts files in filesModified (only checks source files)', () => {
    const result = detectInterfaceChanges({
      filesModified: ['src/foo.test.ts', 'src/bar.spec.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // Test files should not be processed for interface extraction
    expect(mockReadFileSync).not.toHaveBeenCalled()
    expect(result.modifiedInterfaces).toEqual([])
  })

  // -------------------------------------------------------------------------
  // AC2: Cross-Reference Test Files
  // -------------------------------------------------------------------------

  it('AC2: finds test files referencing modified interface names', () => {
    mockReadFileSync.mockReturnValue('export interface MyInterface {}\n')
    mockExecSync.mockReturnValue('./src/other-module/__tests__/foo.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/mymodule/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.potentiallyAffectedTests).toContain('src/other-module/__tests__/foo.test.ts')
  })

  it('AC2: finds multiple test files referencing the same interface', () => {
    mockReadFileSync.mockReturnValue('export interface Dispatcher {}\n')
    mockExecSync.mockReturnValue(
      './src/module-a/__tests__/a.test.ts\n./src/module-b/__tests__/b.test.ts\n'
    )

    const result = detectInterfaceChanges({
      filesModified: ['src/agent-dispatch/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.potentiallyAffectedTests).toContain('src/module-a/__tests__/a.test.ts')
    expect(result.potentiallyAffectedTests).toContain('src/module-b/__tests__/b.test.ts')
  })

  it('AC2: returns empty potentiallyAffectedTests when no test files reference interfaces', () => {
    mockReadFileSync.mockReturnValue('export interface MyInterface {}\n')
    // grep exits 1 (no matches)
    const grepErr = Object.assign(new Error('no matches'), { status: 1, stdout: '' })
    mockExecSync.mockImplementation(() => {
      throw grepErr
    })

    const result = detectInterfaceChanges({
      filesModified: ['src/foo.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.potentiallyAffectedTests).toEqual([])
    expect(result.modifiedInterfaces).toContain('MyInterface')
  })

  // -------------------------------------------------------------------------
  // AC3: Warning event result structure matches schema
  // -------------------------------------------------------------------------

  it('AC3: result has the expected shape for the warning event payload', () => {
    mockReadFileSync.mockReturnValue('export interface Dispatcher {}\n')
    mockExecSync.mockReturnValue('./src/other/__tests__/something.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/agent-dispatch/types.ts'],
      projectRoot,
      storyKey: '24-3',
    })

    // Fields match the story:interface-change-warning event schema
    expect(Array.isArray(result.modifiedInterfaces)).toBe(true)
    expect(Array.isArray(result.potentiallyAffectedTests)).toBe(true)
    expect(result.modifiedInterfaces.every((x) => typeof x === 'string')).toBe(true)
    expect(result.potentiallyAffectedTests.every((x) => typeof x === 'string')).toBe(true)
    expect(result.modifiedInterfaces).toContain('Dispatcher')
    expect(result.potentiallyAffectedTests.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // AC4: No False Positives on Internal Types
  // -------------------------------------------------------------------------

  it('AC4: filters out test files in the same module directory as the source', () => {
    mockReadFileSync.mockReturnValue('export interface MyInterface {}\n')
    // grep returns a test file in the SAME module (__tests__ is a subdirectory)
    mockExecSync.mockReturnValue('./src/mymodule/__tests__/foo.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/mymodule/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // Same module → filtered out → no warning
    expect(result.potentiallyAffectedTests).toEqual([])
  })

  it('AC4: includes test files outside the same module', () => {
    mockReadFileSync.mockReturnValue('export interface MyInterface {}\n')
    mockExecSync.mockReturnValue('./src/othermodule/__tests__/bar.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/mymodule/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.potentiallyAffectedTests).toContain('src/othermodule/__tests__/bar.test.ts')
  })

  it('AC4: only includes cross-module test files when both same-module and cross-module present', () => {
    mockReadFileSync.mockReturnValue('export interface MyInterface {}\n')
    // Mix: one inside same module, one outside
    mockExecSync.mockReturnValue(
      './src/mymodule/__tests__/foo.test.ts\n./src/othermodule/__tests__/bar.test.ts\n'
    )

    const result = detectInterfaceChanges({
      filesModified: ['src/mymodule/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // Same-module filtered, cross-module included
    expect(result.potentiallyAffectedTests).not.toContain('src/mymodule/__tests__/foo.test.ts')
    expect(result.potentiallyAffectedTests).toContain('src/othermodule/__tests__/bar.test.ts')
  })

  it('AC4: same-directory test files (not __tests__) are also filtered out', () => {
    mockReadFileSync.mockReturnValue('export interface Foo {}\n')
    // Flat test file in the same directory as source
    mockExecSync.mockReturnValue('./src/mymodule/foo.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/mymodule/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    expect(result.potentiallyAffectedTests).toEqual([])
  })

  it('AC4: module prefix matching is exact (does not filter different module with shared prefix)', () => {
    mockReadFileSync.mockReturnValue('export interface Foo {}\n')
    // Module "src/mymodule-extended" should NOT be filtered when source is from "src/mymodule"
    mockExecSync.mockReturnValue('./src/mymodule-extended/__tests__/bar.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/mymodule/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // "src/mymodule-extended" does NOT start with "src/mymodule/" → included
    expect(result.potentiallyAffectedTests).toContain('src/mymodule-extended/__tests__/bar.test.ts')
  })

  // -------------------------------------------------------------------------
  // AC5: Graceful Degradation
  // -------------------------------------------------------------------------

  it('AC5: readFileSync failure does not throw — returns empty result', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory')
    })

    let result: ReturnType<typeof detectInterfaceChanges> | undefined
    expect(() => {
      result = detectInterfaceChanges({
        filesModified: ['src/foo.ts'],
        projectRoot,
        storyKey: 'test-1',
      })
    }).not.toThrow()

    expect(result).toBeDefined()
    expect(result!.modifiedInterfaces).toEqual([])
    expect(result!.potentiallyAffectedTests).toEqual([])
  })

  it('AC5: grep failure does not block — modifiedInterfaces returned, potentiallyAffectedTests empty', () => {
    mockReadFileSync.mockReturnValue('export interface Foo {}\n')
    // grep binary not found or permission error
    mockExecSync.mockImplementation(() => {
      throw new Error('grep: command not found')
    })

    let result: ReturnType<typeof detectInterfaceChanges> | undefined
    expect(() => {
      result = detectInterfaceChanges({
        filesModified: ['src/foo.ts'],
        projectRoot,
        storyKey: 'test-1',
      })
    }).not.toThrow()

    expect(result).toBeDefined()
    // Interface names were extracted (readFileSync succeeded)
    expect(result!.modifiedInterfaces).toContain('Foo')
    // But no test files found (grep failed gracefully)
    expect(result!.potentiallyAffectedTests).toEqual([])
  })

  it('AC5: outer exception (e.g., from join) is caught — returns empty result', () => {
    // Cause a synthetic outer error by making readFileSync succeed but projectRoot null
    mockReadFileSync.mockReturnValue('export interface X {}\n')
    mockExecSync.mockImplementation(() => {
      throw new TypeError('Cannot read properties of null')
    })

    let result: ReturnType<typeof detectInterfaceChanges> | undefined
    expect(() => {
      result = detectInterfaceChanges({
        filesModified: ['src/foo.ts'],
        projectRoot,
        storyKey: 'test-1',
      })
    }).not.toThrow()

    expect(result).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('deduplicates interface names from multiple modified files', () => {
    // Both files export the same interface name
    mockReadFileSync
      .mockReturnValueOnce('export interface Foo {}\n')
      .mockReturnValueOnce('export interface Foo {}\nexport interface Bar {}\n')
    mockExecSync.mockReturnValue('')

    const result = detectInterfaceChanges({
      filesModified: ['src/a.ts', 'src/b.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // Foo should appear only once
    expect(result.modifiedInterfaces.filter((n) => n === 'Foo')).toHaveLength(1)
    expect(result.modifiedInterfaces).toContain('Bar')
  })

  it('deduplicates test file paths that appear from multiple interface grep results', () => {
    // Two different interfaces both found in same test file
    mockReadFileSync.mockReturnValue('export interface Foo {}\nexport interface Bar {}\n')
    // Both greps return the same test file
    mockExecSync.mockReturnValue('./src/other/__tests__/common.test.ts\n')

    const result = detectInterfaceChanges({
      filesModified: ['src/source/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // Should appear only once despite being found twice
    const count = result.potentiallyAffectedTests.filter(
      (t) => t === 'src/other/__tests__/common.test.ts'
    ).length
    expect(count).toBe(1)
  })

  it('normalizes ./ prefix from grep output', () => {
    mockReadFileSync.mockReturnValue('export interface Foo {}\n')
    // grep output with ./ prefix (standard grep behavior)
    mockExecSync.mockReturnValue('./src/other/__tests__/foo.test.ts\n')

    const result = detectInterfaceChanges({
      // Use a module-level path so dirname is 'src/source', not just 'src'
      filesModified: ['src/source/types.ts'],
      projectRoot,
      storyKey: 'test-1',
    })

    // Should NOT have ./ prefix in result
    expect(result.potentiallyAffectedTests).toContain('src/other/__tests__/foo.test.ts')
    expect(result.potentiallyAffectedTests).not.toContain('./src/other/__tests__/foo.test.ts')
  })
})
