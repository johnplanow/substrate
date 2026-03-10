/**
 * SymbolParser — extracts exported symbols from TypeScript, JavaScript, and
 * Python source files using tree-sitter.
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import type pino from 'pino'

import { AppError } from '../../errors/app-error.js'
import { ERR_REPO_MAP_PARSE_TIMEOUT } from '../../errors/index.js'
import type { IGrammarLoader, ISymbolParser, ParsedSymbol, SymbolKind } from './interfaces.js'

export class SymbolParser implements ISymbolParser {
  private readonly _grammarLoader: IGrammarLoader
  private readonly _logger: pino.Logger

  constructor(grammarLoader: IGrammarLoader, logger: pino.Logger) {
    this._grammarLoader = grammarLoader
    this._logger = logger
  }

  async parseFile(filePath: string): Promise<ParsedSymbol[]> {
    const ext = extname(filePath)
    const grammar = this._grammarLoader.getGrammar(ext)
    if (grammar === null) {
      return []
    }

    const parsePromise = this._doParse(filePath, grammar)
    const timeoutPromise: Promise<never> = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, `Parse timeout: ${filePath}`)
          ),
        5000
      )
    )

    return Promise.race([parsePromise, timeoutPromise])
  }

  private async _doParse(filePath: string, grammar: unknown): Promise<ParsedSymbol[]> {
    const source = await readFile(filePath, 'utf-8')
    const parser = this._createParser()
    const parserObj = parser as {
      setLanguage(lang: unknown): void
      parse(src: string): { rootNode: TreeNode }
    }
    parserObj.setLanguage(grammar)
    const tree = parserObj.parse(source)
    return this._extractSymbols(tree.rootNode, filePath)
  }

  protected _createParser(): unknown {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Parser = require('tree-sitter')
    return new Parser()
  }

  private _extractSymbols(root: TreeNode, filePath: string): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = []

    for (const node of root.children) {
      // Handle export statements wrapping declarations
      if (node.type === 'export_statement') {
        const inner = node.children.find(
          (c: TreeNode) =>
            c.type === 'function_declaration' ||
            c.type === 'class_declaration' ||
            c.type === 'interface_declaration' ||
            c.type === 'type_alias_declaration' ||
            c.type === 'enum_declaration' ||
            c.type === 'lexical_declaration' ||
            c.type === 'variable_declaration'
        )
        if (inner) {
          const sym = this._nodeToSymbol(inner, filePath, true)
          if (sym) symbols.push(sym)
        }
      }

      // Handle import statements
      if (node.type === 'import_statement') {
        const sym = this._importToSymbol(node, filePath)
        if (sym) symbols.push(sym)
      }
    }

    return symbols
  }

  private _nodeToSymbol(
    node: TreeNode,
    filePath: string,
    exported: boolean
  ): ParsedSymbol | null {
    let kind: SymbolKind | null = null
    let name = ''
    let signature = ''

    switch (node.type) {
      case 'function_declaration':
        kind = 'function'
        name = this._getChildText(node, 'identifier') ?? ''
        signature = this._getFunctionSignature(node)
        break
      case 'class_declaration':
        kind = 'class'
        name = this._getChildText(node, 'type_identifier') ?? this._getChildText(node, 'identifier') ?? ''
        break
      case 'interface_declaration':
        kind = 'interface'
        name = this._getChildText(node, 'type_identifier') ?? ''
        break
      case 'type_alias_declaration':
        kind = 'type'
        name = this._getChildText(node, 'type_identifier') ?? ''
        break
      case 'enum_declaration':
        kind = 'enum'
        name = this._getChildText(node, 'identifier') ?? ''
        break
      case 'lexical_declaration':
      case 'variable_declaration': {
        // export const foo = ...
        const declarator = node.children.find((c: TreeNode) => c.type === 'variable_declarator')
        if (declarator) {
          kind = 'function'
          name = this._getChildText(declarator, 'identifier') ?? ''
        }
        break
      }
      default:
        return null
    }

    if (!kind || !name) return null

    return {
      name,
      kind,
      filePath,
      lineNumber: node.startPosition?.row ?? 0,
      signature,
      exported,
    }
  }

  private _importToSymbol(node: TreeNode, filePath: string): ParsedSymbol | null {
    // Find the module specifier (string node)
    const specifierNode = node.children.find(
      (c: TreeNode) => c.type === 'string' || c.type === 'string_literal'
    )
    const moduleName = specifierNode ? specifierNode.text.replace(/['"]/g, '') : ''

    // Find import clause / named imports
    const importClause = node.children.find((c: TreeNode) => c.type === 'import_clause')
    let bindings: string[] = []

    if (importClause) {
      // Default import: identifier directly in import_clause
      const defaultId = importClause.children.find((c: TreeNode) => c.type === 'identifier')
      if (defaultId) {
        bindings.push('default')
      }

      // Named imports: named_imports node
      const namedImports = importClause.children.find(
        (c: TreeNode) => c.type === 'named_imports'
      )
      if (namedImports) {
        for (const child of namedImports.children) {
          if (child.type === 'import_specifier') {
            const id = child.children.find((c: TreeNode) => c.type === 'identifier')
            if (id) bindings.push(id.text)
          }
        }
      }
    }

    if (bindings.length === 0) bindings = ['default']

    return {
      name: moduleName,
      kind: 'import',
      filePath,
      lineNumber: node.startPosition?.row ?? 0,
      signature: bindings.join(', '),
      exported: false,
    }
  }

  private _getChildText(node: TreeNode, type: string): string | null {
    const child = node.children.find((c: TreeNode) => c.type === type)
    return child ? child.text : null
  }

  private _getFunctionSignature(node: TreeNode): string {
    const params = node.children.find((c: TreeNode) => c.type === 'formal_parameters')
    return params ? params.text : ''
  }
}

interface TreeNode {
  type: string
  text: string
  children: TreeNode[]
  startPosition?: { row: number; column: number }
}
