/**
 * RepoMapQueryEngine — filtered, scored, and budget-limited symbol queries.
 */

import { minimatch } from 'minimatch'

import type { Logger } from 'pino'

import type { ISymbolRepository } from './interfaces.js'
import type { RepoMapTelemetry } from './repo-map-telemetry.js'
import type {
  RepoMapQuery,
  RepoMapQueryResult,
  RepoMapSymbol,
  ScoredSymbol,
} from './types.js'

const DEFAULT_MAX_TOKENS = 2000

/** Chars per token heuristic (same as ContextInjector) */
const CHARS_PER_TOKEN = 4

/** Overhead chars per symbol line: `:lineNumber symbolType \n` */
const SYMBOL_OVERHEAD_CHARS = 30

export class RepoMapQueryEngine {
  private readonly repo: ISymbolRepository
  private readonly logger: Logger
  private readonly telemetry?: RepoMapTelemetry

  constructor(repo: ISymbolRepository, logger: Logger, telemetry?: RepoMapTelemetry) {
    this.repo = repo
    this.logger = logger
    this.telemetry = telemetry
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async query(q: RepoMapQuery): Promise<RepoMapQueryResult> {
    const start = Date.now()
    const maxTokens = q.maxTokens ?? DEFAULT_MAX_TOKENS

    const hasFilesFilter = (q.files?.length ?? 0) > 0
    const hasSymbolsFilter = (q.symbols?.length ?? 0) > 0
    const hasTypesFilter = (q.types?.length ?? 0) > 0
    const hasDepedByFilter = q.dependedBy !== undefined && q.dependedBy !== ''
    const hasDependsOnFilter = q.dependsOn !== undefined && q.dependsOn !== ''
    const hasDirectFilters = hasFilesFilter || hasSymbolsFilter || hasTypesFilter
    const hasAnyFilter = hasDirectFilters || hasDepedByFilter || hasDependsOnFilter

    this.logger.debug({ q, hasAnyFilter }, 'RepoMapQueryEngine.query start')

    let result: RepoMapQueryResult
    let didThrow = false

    try {
      let scoredSymbols: ScoredSymbol[]

      if (!hasAnyFilter) {
        // No filters — return all symbols
        const all = await this.repo.findAll()
        scoredSymbols = all.map(s => ({ ...s, relevanceScore: this.scoreSymbol(s, q) }))
      } else {
        // ------------------------------------------------------------------
        // Step 1: Collect and intersect direct-match candidate sets
        // ------------------------------------------------------------------
        const directSets: RepoMapSymbol[][] = []

        if (hasFilesFilter) {
          // TODO: For large repos (10K+ symbols), add SQL-side LIKE prefix filter
          // before client-side minimatch to avoid full table scan. See Epic 28 Known Limitations.
          const all = await this.repo.findAll()
          const matched = all.filter(s =>
            q.files!.some(p => minimatch(s.filePath, p, { dot: false })),
          )
          directSets.push(matched)
        }

        if (hasSymbolsFilter) {
          const found = await this.repo.findBySymbolNames(q.symbols!)
          directSets.push(found)
        }

        if (hasTypesFilter) {
          const found = await this.repo.findByTypes(q.types!)
          directSets.push(found)
        }

        const directCandidates = this.intersect(directSets)

        // ------------------------------------------------------------------
        // Step 2: Collect dependency-traversal candidates
        // ------------------------------------------------------------------
        const depCandidates: RepoMapSymbol[] = []

        if (hasDepedByFilter) {
          const deps = await this.repo.findByDependedBy(q.dependedBy!)
          depCandidates.push(...deps)
        }

        if (hasDependsOnFilter) {
          const targets = await this.repo.findBySymbolNames([q.dependsOn!])
          if (targets.length > 0) {
            const target = targets[0]
            if (target.dependencies.length > 0) {
              const found = await this.repo.findByFilePaths(target.dependencies)
              depCandidates.push(...found)
            }
          }
        }

        // ------------------------------------------------------------------
        // Step 3: Score and merge candidates
        // ------------------------------------------------------------------
        // Score direct candidates at base 50
        const directKey = (s: RepoMapSymbol) => `${s.filePath}:${s.symbolName}`
        const directKeySet = new Set(directCandidates.map(directKey))

        const scoredDirect: ScoredSymbol[] = directCandidates.map(s => ({
          ...s,
          relevanceScore: this.scoreSymbol(s, q, false),
        }))

        // Score dep-traversal candidates at base 30; exclude symbols already in direct set
        const scoredDep: ScoredSymbol[] = depCandidates
          .filter(s => !directKeySet.has(directKey(s)))
          .map(s => ({ ...s, relevanceScore: this.scoreSymbol(s, q, true) }))

        scoredSymbols = [...scoredDirect, ...scoredDep]
      }

      // ------------------------------------------------------------------
      // Step 4: Sort — score desc, then filePath asc, then lineNumber asc
      // ------------------------------------------------------------------
      scoredSymbols.sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath)
        return a.lineNumber - b.lineNumber
      })

      // ------------------------------------------------------------------
      // Step 5: Apply token budget
      // ------------------------------------------------------------------
      const { symbols, truncated } = this.applyBudget(scoredSymbols, maxTokens)

      result = {
        symbols,
        symbolCount: symbols.length,
        truncated,
        queryDurationMs: Date.now() - start,
      }

      this.logger.debug(
        { symbolCount: result.symbolCount, truncated: result.truncated },
        'RepoMapQueryEngine.query complete',
      )
    } catch (err) {
      didThrow = true
      throw err
    } finally {
      if (this.telemetry !== undefined) {
        const queryDurationMs = Date.now() - start
        // Compute filterFields from the query object keys that have non-undefined values
        const filterFields = Object.keys(q).filter(
          k => q[k as keyof RepoMapQuery] !== undefined,
        )
        const symbolCount = didThrow ? 0 : (result!.symbolCount)
        const truncated = didThrow ? false : (result!.truncated)
        this.telemetry.recordQuery({
          queryDurationMs,
          symbolCount,
          truncated,
          filterFields,
          ...(didThrow ? { error: true } : {}),
        })
      }
    }

    return result!
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute a relevance score for a symbol given the query.
   *
   * Base score:
   *   - 50 for direct-match candidates (default)
   *   - 30 for dependency-traversal candidates
   *
   * Bonuses:
   *   - +40 if filePath matches any `files` glob
   *   - +20 if symbolName is in the `symbols` array
   *   - +10 if symbolType is in the `types` array
   */
  private scoreSymbol(
    symbol: RepoMapSymbol,
    q: RepoMapQuery,
    isDependencyTraversal = false,
  ): number {
    let score = isDependencyTraversal ? 30 : 50

    if (q.files?.length) {
      const matchesFiles = q.files.some(p => minimatch(symbol.filePath, p, { dot: false }))
      if (matchesFiles) score += 40
    }

    if (q.symbols?.length && q.symbols.includes(symbol.symbolName)) {
      score += 20
    }

    if (q.types?.length && q.types.includes(symbol.symbolType)) {
      score += 10
    }

    return score
  }

  /**
   * Truncate the symbol list to fit within the token budget.
   * Symbols are processed in score-descending order (already sorted).
   * Uses 4 chars/token heuristic.
   */
  private applyBudget(
    symbols: ScoredSymbol[],
    maxTokens: number,
  ): { symbols: ScoredSymbol[]; truncated: boolean } {
    const budgetChars = maxTokens * CHARS_PER_TOKEN
    let accumulated = 0
    const accepted: ScoredSymbol[] = []

    for (const sym of symbols) {
      const symChars =
        sym.filePath.length + sym.symbolName.length + (sym.signature?.length ?? 0) + SYMBOL_OVERHEAD_CHARS
      if (accumulated + symChars > budgetChars) {
        // Budget exceeded — stop
        return { symbols: accepted, truncated: true }
      }
      accumulated += symChars
      accepted.push(sym)
    }

    return { symbols: accepted, truncated: false }
  }

  /**
   * Intersect multiple candidate arrays by `filePath:symbolName` composite key.
   * Returns symbols in the first set that are present in all subsequent sets.
   */
  private intersect(sets: RepoMapSymbol[][]): RepoMapSymbol[] {
    if (sets.length === 0) return []
    if (sets.length === 1) return sets[0]

    const key = (s: RepoMapSymbol) => `${s.filePath}:${s.symbolName}`

    let result = sets[0]
    for (let i = 1; i < sets.length; i++) {
      const nextKeys = new Set(sets[i].map(key))
      result = result.filter(s => nextKeys.has(key(s)))
    }
    return result
  }
}
