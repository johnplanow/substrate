/**
 * Repo-map module — storage-layer types for RepoMapSymbol and query interfaces.
 */

// ---------------------------------------------------------------------------
// Core symbol types (defined by story 28-1, extended here)
// ---------------------------------------------------------------------------

export type SymbolType = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'export'

export interface RepoMapSymbol {
  /** Relative path from project root */
  filePath: string
  symbolName: string
  symbolType: SymbolType
  /** e.g. "(config: AppConfig): void" */
  signature?: string
  lineNumber: number
  /** File paths this symbol's file imports (empty until schema adds dependencies column) */
  dependencies: string[]
  /** SHA-256 of file content at parse time */
  fileHash: string
}

// ---------------------------------------------------------------------------
// Query types (defined by story 28-3)
// ---------------------------------------------------------------------------

/** Query filter + options for RepoMapQueryEngine.query() */
export interface RepoMapQuery {
  /** Glob patterns matched against RepoMapSymbol.filePath */
  files?: string[]
  /** Case-sensitive symbol names to filter by */
  symbols?: string[]
  /** Symbol types to filter by */
  types?: SymbolType[]
  /** Return symbols from files that list this symbol name in their dependencies */
  dependedBy?: string
  /** Return symbols from files that the named symbol's file depends on */
  dependsOn?: string
  /** Token budget; defaults to 2000 */
  maxTokens?: number
  /** Output format hint (used by CLI callers) */
  outputFormat?: 'text' | 'json'
}

/** RepoMapSymbol extended with a computed relevance score */
export interface ScoredSymbol extends RepoMapSymbol {
  /** 0–120 relevance score; higher = more relevant */
  relevanceScore: number
}

/** Result returned by RepoMapQueryEngine.query() */
export interface RepoMapQueryResult {
  symbols: ScoredSymbol[]
  /** Number of symbols in this result (equals symbols.length after truncation) */
  symbolCount: number
  /** True when the result was cut to stay within the token budget */
  truncated: boolean
  /** Wall-clock time for the query in milliseconds */
  queryDurationMs: number
}
