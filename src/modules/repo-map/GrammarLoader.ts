/**
 * GrammarLoader — lazy-loads tree-sitter grammar packages.
 *
 * Grammars are loaded on first use and cached. If tree-sitter packages are
 * absent (optional dependencies), the loader degrades gracefully: it sets an
 * internal unavailable flag and returns null for all subsequent calls without
 * throwing.
 */

import type pino from 'pino'
import type { IGrammarLoader } from './interfaces.js'

export class GrammarLoader implements IGrammarLoader {
  private readonly _logger: pino.Logger
  private readonly _extensionMap: Map<string, string>
  private readonly _cache = new Map<string, unknown>()
  private _unavailable = false

  constructor(logger: pino.Logger) {
    this._logger = logger
    this._extensionMap = new Map([
      ['.ts', 'tree-sitter-typescript/typescript'],
      ['.tsx', 'tree-sitter-typescript/tsx'],
      ['.js', 'tree-sitter-javascript'],
      ['.mjs', 'tree-sitter-javascript'],
      ['.cjs', 'tree-sitter-javascript'],
      ['.py', 'tree-sitter-python'],
    ])
  }

  getGrammar(ext: string): unknown | null {
    if (this._unavailable) return null

    const grammarPath = this._extensionMap.get(ext)
    if (!grammarPath) {
      this._logger.debug({ ext, component: 'repo-map' }, 'Unsupported extension')
      return null
    }

    if (this._cache.has(ext)) return this._cache.get(ext)!

    try {
      const grammar = this._loadModule(grammarPath)
      this._cache.set(ext, grammar)
      return grammar
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        this._logger.warn({ component: 'repo-map', reason: 'tree-sitter unavailable' }, 'tree-sitter grammar unavailable')
        this._unavailable = true
        return null
      }
      throw err
    }
  }

  protected _loadModule(path: string): unknown {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(path)
  }
}
