import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'
import { GrammarLoader } from '../GrammarLoader.js'

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

class TestGrammarLoader extends GrammarLoader {
  private _moduleMap = new Map<string, unknown>()
  private _shouldThrow = false
  private _errorCode: string | null = null

  setModule(path: string, value: unknown) {
    this._moduleMap.set(path, value)
  }

  setThrowModuleNotFound() {
    this._shouldThrow = true
    this._errorCode = 'MODULE_NOT_FOUND'
  }

  protected override _loadModule(path: string): unknown {
    if (this._shouldThrow) {
      const err = new Error(`Cannot find module '${path}'`)
      ;(err as NodeJS.ErrnoException).code = this._errorCode ?? 'MODULE_NOT_FOUND'
      throw err
    }
    if (this._moduleMap.has(path)) return this._moduleMap.get(path)!
    return { mockGrammar: path }
  }
}

describe('GrammarLoader', () => {
  let logger: pino.Logger
  let loader: TestGrammarLoader

  beforeEach(() => {
    logger = makeLogger()
    loader = new TestGrammarLoader(logger)
  })

  it('returns grammar for .ts extension', () => {
    const grammar = { lang: 'typescript' }
    loader.setModule('tree-sitter-typescript/typescript', grammar)
    const result = loader.getGrammar('.ts')
    expect(result).toBe(grammar)
  })

  it('caches grammar — does not call _loadModule twice for same extension', () => {
    const grammar = { lang: 'typescript' }
    loader.setModule('tree-sitter-typescript/typescript', grammar)
    const spy = vi.spyOn(loader as any, '_loadModule')

    loader.getGrammar('.ts')
    loader.getGrammar('.ts')

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('returns grammar for .tsx extension', () => {
    const result = loader.getGrammar('.tsx')
    expect(result).toBeDefined()
  })

  it('returns grammar for .js extension', () => {
    const result = loader.getGrammar('.js')
    expect(result).toBeDefined()
  })

  it('returns grammar for .mjs extension', () => {
    const result = loader.getGrammar('.mjs')
    expect(result).toBeDefined()
  })

  it('returns grammar for .cjs extension', () => {
    const result = loader.getGrammar('.cjs')
    expect(result).toBeDefined()
  })

  it('returns grammar for .py extension', () => {
    const result = loader.getGrammar('.py')
    expect(result).toBeDefined()
  })

  it('returns null and logs debug for unsupported extension', () => {
    const result = loader.getGrammar('.rb')
    expect(result).toBeNull()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ ext: '.rb' }),
      'Unsupported extension'
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns null and logs warn once on MODULE_NOT_FOUND', () => {
    loader.setThrowModuleNotFound()
    const result1 = loader.getGrammar('.ts')
    const result2 = loader.getGrammar('.js')

    expect(result1).toBeNull()
    expect(result2).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'repo-map', reason: 'tree-sitter unavailable' }),
      'tree-sitter grammar unavailable'
    )
  })

  it('does not re-log warn on subsequent calls after MODULE_NOT_FOUND', () => {
    loader.setThrowModuleNotFound()
    loader.getGrammar('.ts')
    loader.getGrammar('.ts')
    loader.getGrammar('.js')
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
