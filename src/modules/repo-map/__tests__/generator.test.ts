import { describe, it, expect } from 'vitest'
import { RepoMapGenerator } from '../generator.js'
import type { ParsedSymbol } from '../interfaces.js'

function makeSymbol(overrides: Partial<ParsedSymbol>): ParsedSymbol {
  return {
    name: 'foo',
    kind: 'function',
    filePath: '/project/src/foo.ts',
    lineNumber: 1,
    signature: '',
    exported: true,
    ...overrides,
  }
}

describe('RepoMapGenerator.formatAsText', () => {
  const gen = new RepoMapGenerator()
  const projectRoot = '/project'

  it('formats single file with one exported function including signature', () => {
    const symbols: ParsedSymbol[] = [
      makeSymbol({ name: 'doWork', kind: 'function', signature: 'x: string' }),
    ]
    const result = gen.formatAsText(symbols, projectRoot)
    expect(result).toContain('src/foo.ts')
    expect(result).toContain('  function doWork(x: string)')
  })

  it('formats symbol with empty signature without parentheses', () => {
    const symbols: ParsedSymbol[] = [makeSymbol({ name: 'MyClass', kind: 'class', signature: '' })]
    const result = gen.formatAsText(symbols, projectRoot)
    expect(result).toContain('  class MyClass')
    expect(result).not.toContain('()')
  })

  it('omits files with zero exported symbols', () => {
    const symbols: ParsedSymbol[] = [
      makeSymbol({
        kind: 'import',
        exported: false,
        name: 'react',
        filePath: '/project/src/bar.ts',
      }),
    ]
    const result = gen.formatAsText(symbols, projectRoot)
    expect(result).toBe('')
  })

  it('handles multiple files in separate blocks', () => {
    const symbols: ParsedSymbol[] = [
      makeSymbol({ filePath: '/project/src/a.ts', name: 'funcA', kind: 'function' }),
      makeSymbol({ filePath: '/project/src/b.ts', name: 'ClassB', kind: 'class' }),
    ]
    const result = gen.formatAsText(symbols, projectRoot)
    expect(result).toContain('src/a.ts')
    expect(result).toContain('  function funcA')
    expect(result).toContain('src/b.ts')
    expect(result).toContain('  class ClassB')
  })

  it('strips projectRoot from file paths in header', () => {
    const symbols: ParsedSymbol[] = [
      makeSymbol({ filePath: '/project/src/deep/file.ts', name: 'deepFn', kind: 'function' }),
    ]
    const result = gen.formatAsText(symbols, projectRoot)
    expect(result).toContain('src/deep/file.ts')
    expect(result).not.toContain('/project/')
  })

  it('excludes import-kind symbols from output', () => {
    const symbols: ParsedSymbol[] = [
      makeSymbol({ kind: 'import', exported: false, name: 'lodash', signature: 'default' }),
      makeSymbol({ kind: 'function', exported: true, name: 'myFunc' }),
    ]
    const result = gen.formatAsText(symbols, projectRoot)
    expect(result).not.toContain('import lodash')
    expect(result).toContain('  function myFunc')
  })
})
