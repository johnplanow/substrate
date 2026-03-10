import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type pino from 'pino'
import { SymbolParser } from '../SymbolParser.js'
import type { IGrammarLoader } from '../interfaces.js'
import { ERR_REPO_MAP_PARSE_TIMEOUT } from '../../../errors/index.js'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

import { readFile } from 'node:fs/promises'

const mockReadFile = readFile as ReturnType<typeof vi.fn>

function makeLogger(): pino.Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as pino.Logger
}

function makeGrammarLoader(grammar: unknown | null): IGrammarLoader {
  return {
    getGrammar: vi.fn().mockReturnValue(grammar),
  }
}

// Minimal TreeNode for testing
interface TreeNode {
  type: string
  text: string
  children: TreeNode[]
  startPosition?: { row: number; column: number }
}

function makeNode(type: string, text: string, children: TreeNode[] = [], row = 1): TreeNode {
  return { type, text, children, startPosition: { row, column: 0 } }
}

class TestSymbolParser extends SymbolParser {
  private _fakeTree: { rootNode: TreeNode } | null = null

  setFakeTree(tree: { rootNode: TreeNode }) {
    this._fakeTree = tree
  }

  protected override _createParser(): unknown {
    const self = this
    return {
      setLanguage: vi.fn(),
      parse: vi.fn().mockReturnValue(self._fakeTree ?? { rootNode: makeNode('program', '', []) }),
    }
  }
}

describe('SymbolParser', () => {
  let logger: pino.Logger
  let parser: TestSymbolParser

  beforeEach(() => {
    logger = makeLogger()
    mockReadFile.mockResolvedValue('// source code')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns [] when grammar loader returns null', async () => {
    const loader = makeGrammarLoader(null)
    parser = new TestSymbolParser(loader, logger)
    const result = await parser.parseFile('/foo/bar.ts')
    expect(result).toEqual([])
  })

  it('extracts exported function declaration', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const fnNode = makeNode('function_declaration', 'function foo(x: string)', [
      makeNode('identifier', 'foo'),
      makeNode('formal_parameters', '(x: string)'),
    ])
    const exportNode = makeNode('export_statement', 'export function foo(x: string)', [fnNode])
    const root = makeNode('program', '', [exportNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      name: 'foo',
      kind: 'function',
      exported: true,
      filePath: '/src/foo.ts',
    })
  })

  it('extracts exported class declaration', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const classNode = makeNode('class_declaration', 'class MyClass', [
      makeNode('type_identifier', 'MyClass'),
    ])
    const exportNode = makeNode('export_statement', 'export class MyClass', [classNode])
    const root = makeNode('program', '', [exportNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'MyClass', kind: 'class', exported: true })
  })

  it('extracts exported interface declaration', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const ifaceNode = makeNode('interface_declaration', 'interface IFoo', [
      makeNode('type_identifier', 'IFoo'),
    ])
    const exportNode = makeNode('export_statement', 'export interface IFoo', [ifaceNode])
    const root = makeNode('program', '', [exportNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'IFoo', kind: 'interface', exported: true })
  })

  it('extracts exported type alias', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const typeNode = makeNode('type_alias_declaration', 'type MyType = string', [
      makeNode('type_identifier', 'MyType'),
    ])
    const exportNode = makeNode('export_statement', 'export type MyType = string', [typeNode])
    const root = makeNode('program', '', [exportNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'MyType', kind: 'type', exported: true })
  })

  it('extracts exported enum', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const enumNode = makeNode('enum_declaration', 'enum Status', [
      makeNode('identifier', 'Status'),
    ])
    const exportNode = makeNode('export_statement', 'export enum Status', [enumNode])
    const root = makeNode('program', '', [exportNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'Status', kind: 'enum', exported: true })
  })

  it('extracts import statement with named bindings', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const specifier = makeNode('import_specifier', 'foo', [makeNode('identifier', 'foo')])
    const namedImports = makeNode('named_imports', '{ foo, bar }', [
      specifier,
      makeNode('import_specifier', 'bar', [makeNode('identifier', 'bar')]),
    ])
    const importClause = makeNode('import_clause', '{ foo, bar }', [namedImports])
    const importNode = makeNode('import_statement', "import { foo, bar } from 'mymod'", [
      importClause,
      makeNode('string', "'mymod'"),
    ])
    const root = makeNode('program', '', [importNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'import',
      name: 'mymod',
      exported: false,
    })
    expect(result[0].signature).toContain('foo')
    expect(result[0].signature).toContain('bar')
  })

  it('extracts import statement with default import', async () => {
    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)
    parser = new TestSymbolParser(loader, logger)

    const importClause = makeNode('import_clause', 'React', [makeNode('identifier', 'React')])
    const importNode = makeNode('import_statement', "import React from 'react'", [
      importClause,
      makeNode('string', "'react'"),
    ])
    const root = makeNode('program', '', [importNode])

    parser.setFakeTree({ rootNode: root })
    const result = await parser.parseFile('/src/foo.ts')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'import',
      name: 'react',
      signature: 'default',
      exported: false,
    })
  })

  it('rejects with ERR_REPO_MAP_PARSE_TIMEOUT after 5 seconds', async () => {
    vi.useFakeTimers()

    const grammar = { lang: 'ts' }
    const loader = makeGrammarLoader(grammar)

    // Make readFile hang forever so _doParse never resolves, exercising the real
    // Promise.race timeout in SymbolParser.parseFile() rather than a hand-coded override.
    mockReadFile.mockReturnValue(new Promise<never>(() => {}))

    // Use TestSymbolParser (which only overrides _createParser) so the real
    // parseFile() and its Promise.race timeout mechanism are exercised.
    parser = new TestSymbolParser(loader, logger)
    const promise = parser.parseFile('/src/foo.ts')
    // Attach no-op catch immediately so Node doesn't detect an unhandled rejection
    // before our `await expect(...).rejects` assertion gets to handle it
    promise.catch(() => {})

    await vi.runAllTimersAsync()

    await expect(promise).rejects.toMatchObject({
      code: ERR_REPO_MAP_PARSE_TIMEOUT,
    })

    vi.useRealTimers()
  })
})
