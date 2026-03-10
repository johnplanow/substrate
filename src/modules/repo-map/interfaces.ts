/**
 * Repo-map module — shared interfaces and types.
 */

import type { RepoMapSymbol, SymbolType } from './types.js'

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'import'

export interface ParsedSymbol {
  name: string
  kind: SymbolKind
  filePath: string
  lineNumber: number
  signature: string
  exported: boolean
}

export interface IGrammarLoader {
  getGrammar(ext: string): unknown | null
}

export interface ISymbolParser {
  parseFile(path: string): Promise<ParsedSymbol[]>
}

// ---------------------------------------------------------------------------
// Story 28-2: Storage and query types
// ---------------------------------------------------------------------------

/**
 * Optional filter criteria for symbol queries.
 */
export interface SymbolFilter {
  /** Restrict results to these file paths */
  filePaths?: string[]
  /** Restrict results to these symbol kinds */
  kinds?: SymbolKind[]
}

/**
 * Metadata about the last repo-map bootstrap/update operation.
 */
export interface RepoMapMeta {
  /** Git commit SHA at the time of the last update */
  commitSha: string
  /** Timestamp of the last update */
  updatedAt: Date
  /** Number of files parsed in the last full bootstrap */
  fileCount: number
}

/**
 * Repository interface for repo_map_symbols table operations.
 */
export interface ISymbolRepository {
  /**
   * Replace all symbols for a given file path with the new symbols array.
   * Deletes existing rows for the file, then inserts the new ones.
   * Passing an empty symbols array deletes all rows for the file (handles deletions).
   */
  upsertFileSymbols(filePath: string, symbols: ParsedSymbol[], fileHash: string): Promise<void>

  /**
   * Query symbols with an optional filter.
   * When no filter is provided, returns all symbols.
   */
  getSymbols(filter?: SymbolFilter): Promise<ParsedSymbol[]>

  /**
   * Get the stored SHA256 hash for a given file path.
   * Returns null if the file has not been indexed yet.
   */
  getFileHash(filePath: string): Promise<string | null>

  // -------------------------------------------------------------------------
  // Read-side query methods (story 28-3)
  // -------------------------------------------------------------------------

  /** Batch lookup by exact file path */
  findByFilePaths(filePaths: string[]): Promise<RepoMapSymbol[]>

  /** Case-sensitive symbol name lookup */
  findBySymbolNames(names: string[]): Promise<RepoMapSymbol[]>

  /** Filter by symbol type */
  findByTypes(types: SymbolType[]): Promise<RepoMapSymbol[]>

  /**
   * Returns symbols from files whose dependencies array contains symbolName.
   * SQL: WHERE JSON_CONTAINS(dependencies, JSON_QUOTE(?), '$')
   */
  findByDependedBy(symbolName: string): Promise<RepoMapSymbol[]>

  /** Full table scan; used when no filter is specified */
  findAll(): Promise<RepoMapSymbol[]>
}

/**
 * Repository interface for repo_map_meta table operations.
 */
export interface IRepoMapMetaRepository {
  /**
   * Upsert the singleton metadata row (id=1).
   */
  updateMeta(meta: RepoMapMeta): Promise<void>

  /**
   * Retrieve the singleton metadata row.
   * Returns null if no metadata exists yet.
   */
  getMeta(): Promise<RepoMapMeta | null>
}

/**
 * Interface for git operations used by repo-map storage.
 */
export interface IGitClient {
  /**
   * Returns the current HEAD commit SHA for the project.
   */
  getCurrentSha(projectRoot: string): Promise<string>

  /**
   * Returns the list of files changed between fromSha and HEAD.
   */
  getChangedFiles(projectRoot: string, fromSha: string): Promise<string[]>

  /**
   * Returns all files tracked by git in the project.
   */
  listTrackedFiles(projectRoot: string): Promise<string[]>
}
