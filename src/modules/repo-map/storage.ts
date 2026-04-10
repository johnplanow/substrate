/**
 * Repo-map Dolt storage — DoltSymbolRepository, DoltRepoMapMetaRepository, RepoMapStorage.
 *
 * story 28-2: persists parsed symbols in Dolt and provides incremental update logic.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import type pino from 'pino'

import type { DoltClient } from '../state/dolt-client.js'
import {
  AppError,
  ERR_REPO_MAP_STORAGE_WRITE,
  ERR_REPO_MAP_STORAGE_READ,
} from '../../errors/index.js'
import type {
  ParsedSymbol,
  SymbolFilter,
  RepoMapMeta,
  ISymbolRepository,
  IRepoMapMetaRepository,
  IGitClient,
  ISymbolParser,
  SymbolKind,
} from './interfaces.js'
import type { RepoMapSymbol, SymbolType } from './types.js'

// ---------------------------------------------------------------------------
// Supported file extensions for incremental parsing
// ---------------------------------------------------------------------------

export const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py'])

// ---------------------------------------------------------------------------
// File hash helper
// ---------------------------------------------------------------------------

/**
 * Compute SHA256 hash of a file's content.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// Row shapes returned from repo_map_symbols queries
// ---------------------------------------------------------------------------

interface SymbolRow {
  file_path: string
  symbol_name: string
  symbol_kind: string
  signature: string | null
  line_number: number
  exported: number | boolean
  file_hash: string
  dependencies?: string | null
}

interface MetaRow {
  id: number
  commit_sha: string | null
  updated_at: string | null
  file_count: number
}

interface HashRow {
  file_hash: string
}

// ---------------------------------------------------------------------------
// DoltSymbolRepository
// ---------------------------------------------------------------------------

/**
 * Implements ISymbolRepository backed by the repo_map_symbols Dolt table.
 */
export class DoltSymbolRepository implements ISymbolRepository {
  private readonly _client: DoltClient
  private readonly _logger: pino.Logger

  constructor(client: DoltClient, logger: pino.Logger) {
    this._client = client
    this._logger = logger
  }

  /**
   * Atomically replace all symbols for filePath.
   * Deletes first (handles file deletions), then batch-inserts new symbols.
   */
  async upsertFileSymbols(
    filePath: string,
    symbols: ParsedSymbol[],
    fileHash: string
  ): Promise<void> {
    try {
      // Always delete existing symbols for this file (handles both update and deletion)
      await this._client.query('DELETE FROM repo_map_symbols WHERE file_path = ?', [filePath])

      if (symbols.length === 0) {
        this._logger.debug(
          { filePath },
          'upsertFileSymbols: cleared symbols for deleted/empty file'
        )
        return
      }

      // Derive file-level dependencies from import entries
      const deps = symbols.filter((s) => s.kind === 'import').map((s) => s.name)
      const depsJson = JSON.stringify(deps)

      // Build multi-row VALUES clause
      const placeholders = symbols.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
      const params: unknown[] = []
      for (const sym of symbols) {
        params.push(
          filePath,
          sym.name,
          sym.kind,
          sym.signature ?? '',
          sym.lineNumber,
          sym.exported ? 1 : 0,
          fileHash,
          depsJson
        )
      }

      await this._client.query(
        `INSERT INTO repo_map_symbols (file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies) VALUES ${placeholders}`,
        params
      )

      this._logger.debug({ filePath, count: symbols.length }, 'upsertFileSymbols: inserted symbols')
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(
        ERR_REPO_MAP_STORAGE_WRITE,
        2,
        `Failed to upsert symbols for ${filePath}: ${detail}`
      )
    }
  }

  /**
   * Query symbols, optionally filtered by file path and/or symbol kind.
   */
  async getSymbols(filter?: SymbolFilter): Promise<ParsedSymbol[]> {
    try {
      const conditions: string[] = []
      const params: unknown[] = []

      if (filter?.filePaths && filter.filePaths.length > 0) {
        const placeholders = filter.filePaths.map(() => '?').join(', ')
        conditions.push(`file_path IN (${placeholders})`)
        params.push(...filter.filePaths)
      }

      if (filter?.kinds && filter.kinds.length > 0) {
        const placeholders = filter.kinds.map(() => '?').join(', ')
        conditions.push(`symbol_kind IN (${placeholders})`)
        params.push(...filter.kinds)
      }

      const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      const sql = `SELECT file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash FROM repo_map_symbols${whereClause}`

      const rows = await this._client.query<SymbolRow>(sql, params)
      return rows.map((row) => this._rowToSymbol(row))
    } catch (err: unknown) {
      if (err instanceof AppError) throw err
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `Failed to query symbols: ${detail}`)
    }
  }

  /**
   * Get stored file hash for the given path, or null if not indexed.
   */
  async getFileHash(filePath: string): Promise<string | null> {
    try {
      const rows = await this._client.query<HashRow>(
        'SELECT file_hash FROM repo_map_symbols WHERE file_path = ? LIMIT 1',
        [filePath]
      )
      if (rows.length === 0) return null
      return rows[0]!.file_hash
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(
        ERR_REPO_MAP_STORAGE_READ,
        2,
        `Failed to get file hash for ${filePath}: ${detail}`
      )
    }
  }

  private _rowToSymbol(row: SymbolRow): ParsedSymbol {
    return {
      name: row.symbol_name,
      kind: row.symbol_kind as SymbolKind,
      filePath: row.file_path,
      lineNumber: row.line_number,
      signature: row.signature ?? '',
      exported: Boolean(row.exported),
    }
  }

  // -------------------------------------------------------------------------
  // Story 28-3: Read-side query methods
  // -------------------------------------------------------------------------

  async findByFilePaths(filePaths: string[]): Promise<RepoMapSymbol[]> {
    if (filePaths.length === 0) return []
    try {
      const placeholders = filePaths.map(() => '?').join(', ')
      const rows = await this._client.query<SymbolRow>(
        `SELECT file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies FROM repo_map_symbols WHERE file_path IN (${placeholders})`,
        filePaths
      )
      return rows.map((r) => this._rowToRepoMapSymbol(r))
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `findByFilePaths failed: ${detail}`)
    }
  }

  async findBySymbolNames(names: string[]): Promise<RepoMapSymbol[]> {
    if (names.length === 0) return []
    try {
      const placeholders = names.map(() => '?').join(', ')
      const rows = await this._client.query<SymbolRow>(
        `SELECT file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies FROM repo_map_symbols WHERE symbol_name IN (${placeholders})`,
        names
      )
      return rows.map((r) => this._rowToRepoMapSymbol(r))
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `findBySymbolNames failed: ${detail}`)
    }
  }

  async findByTypes(types: SymbolType[]): Promise<RepoMapSymbol[]> {
    if (types.length === 0) return []
    try {
      const placeholders = types.map(() => '?').join(', ')
      const rows = await this._client.query<SymbolRow>(
        `SELECT file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies FROM repo_map_symbols WHERE symbol_kind IN (${placeholders})`,
        types
      )
      return rows.map((r) => this._rowToRepoMapSymbol(r))
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `findByTypes failed: ${detail}`)
    }
  }

  /**
   * Returns symbols from files whose dependencies array contains symbolName.
   */
  async findByDependedBy(symbolName: string): Promise<RepoMapSymbol[]> {
    try {
      const rows = await this._client.query<SymbolRow>(
        `SELECT file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies FROM repo_map_symbols WHERE JSON_CONTAINS(dependencies, JSON_QUOTE(?), '$')`,
        [symbolName]
      )
      return rows.map((r) => this._rowToRepoMapSymbol(r))
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `findByDependedBy failed: ${detail}`)
    }
  }

  async findAll(): Promise<RepoMapSymbol[]> {
    try {
      const rows = await this._client.query<SymbolRow>(
        'SELECT file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash, dependencies FROM repo_map_symbols'
      )
      return rows.map((r) => this._rowToRepoMapSymbol(r))
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `findAll failed: ${detail}`)
    }
  }

  private _rowToRepoMapSymbol(row: SymbolRow): RepoMapSymbol {
    let deps: string[] = []
    if (row.dependencies) {
      try {
        const parsed =
          typeof row.dependencies === 'string' ? JSON.parse(row.dependencies) : row.dependencies
        if (Array.isArray(parsed)) deps = parsed
      } catch {
        /* ignore malformed JSON */
      }
    }
    return {
      filePath: row.file_path,
      symbolName: row.symbol_name,
      symbolType: row.symbol_kind as SymbolType,
      signature: row.signature ?? undefined,
      lineNumber: row.line_number,
      dependencies: deps,
      fileHash: row.file_hash,
    }
  }
}

// ---------------------------------------------------------------------------
// DoltRepoMapMetaRepository
// ---------------------------------------------------------------------------

/**
 * Implements IRepoMapMetaRepository backed by the repo_map_meta Dolt table.
 * Uses a singleton row (id=1).
 */
export class DoltRepoMapMetaRepository implements IRepoMapMetaRepository {
  private readonly _client: DoltClient

  constructor(client: DoltClient) {
    this._client = client
  }

  /**
   * Upsert the singleton meta row.
   */
  async updateMeta(meta: RepoMapMeta): Promise<void> {
    try {
      await this._client.query(
        `INSERT INTO repo_map_meta (id, commit_sha, updated_at, file_count)
         VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           commit_sha = VALUES(commit_sha),
           updated_at = VALUES(updated_at),
           file_count = VALUES(file_count)`,
        [meta.commitSha, meta.updatedAt.toISOString(), meta.fileCount]
      )
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_WRITE, 2, `Failed to update repo_map_meta: ${detail}`)
    }
  }

  /**
   * Retrieve the singleton meta row, or null if not yet seeded.
   */
  async getMeta(): Promise<RepoMapMeta | null> {
    try {
      const rows = await this._client.query<MetaRow>(
        'SELECT id, commit_sha, updated_at, file_count FROM repo_map_meta WHERE id = 1'
      )
      if (rows.length === 0) return null
      const row = rows[0]!
      return {
        commitSha: row.commit_sha ?? '',
        updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(0),
        fileCount: row.file_count,
      }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new AppError(ERR_REPO_MAP_STORAGE_READ, 2, `Failed to read repo_map_meta: ${detail}`)
    }
  }
}

// ---------------------------------------------------------------------------
// RepoMapStorage
// ---------------------------------------------------------------------------

/**
 * Orchestrates repo-map storage operations: staleness checks, incremental
 * updates, and full bootstrap seeding.
 */
export class RepoMapStorage {
  private readonly _symbolRepo: ISymbolRepository
  private readonly _metaRepo: IRepoMapMetaRepository
  private readonly _gitClient: IGitClient
  private readonly _logger: pino.Logger

  constructor(
    symbolRepo: ISymbolRepository,
    metaRepo: IRepoMapMetaRepository,
    gitClient: IGitClient,
    logger: pino.Logger
  ) {
    this._symbolRepo = symbolRepo
    this._metaRepo = metaRepo
    this._gitClient = gitClient
    this._logger = logger
  }

  /**
   * Returns true if the file's current content hash differs from the stored hash.
   */
  async isFileStale(filePath: string): Promise<boolean> {
    const [currentHash, storedHash] = await Promise.all([
      computeFileHash(filePath),
      this._symbolRepo.getFileHash(filePath),
    ])
    if (storedHash === null) return true
    return currentHash !== storedHash
  }

  /**
   * Returns true if the project's current HEAD SHA differs from the stored commit SHA.
   */
  async isStale(projectRoot: string): Promise<boolean> {
    const [meta, currentSha] = await Promise.all([
      this._metaRepo.getMeta(),
      this._gitClient.getCurrentSha(projectRoot),
    ])
    if (meta === null) return true
    return meta.commitSha !== currentSha
  }

  /**
   * Re-parse only the files changed since the last stored commit SHA.
   * Falls back to fullBootstrap if no meta exists.
   */
  async incrementalUpdate(projectRoot: string, parser: ISymbolParser): Promise<void> {
    const meta = await this._metaRepo.getMeta()

    if (meta === null) {
      this._logger.debug('incrementalUpdate: no meta found, running fullBootstrap')
      await this.fullBootstrap(projectRoot, parser)
      return
    }

    const changedFiles = await this._gitClient.getChangedFiles(projectRoot, meta.commitSha)
    this._logger.debug({ count: changedFiles.length }, 'incrementalUpdate: changed files')

    const supported = changedFiles.filter((f) => SUPPORTED_EXTENSIONS.has(extname(f)))

    let parsedCount = 0
    for (const filePath of supported) {
      try {
        const exists = await fileExists(filePath)
        if (!exists) {
          // File was deleted — clear its symbols
          await this._symbolRepo.upsertFileSymbols(filePath, [], '')
          parsedCount++
          continue
        }

        const symbols = await parser.parseFile(filePath)
        const hash = await computeFileHash(filePath)
        await this._symbolRepo.upsertFileSymbols(filePath, symbols, hash)
        parsedCount++
      } catch (err: unknown) {
        this._logger.warn({ filePath, err }, 'incrementalUpdate: parse/upsert failed, skipping')
      }
    }

    const currentSha = await this._gitClient.getCurrentSha(projectRoot)
    await this._metaRepo.updateMeta({
      commitSha: currentSha,
      updatedAt: new Date(),
      fileCount: parsedCount,
    })
  }

  /**
   * Parse all tracked files and seed the symbol index from scratch.
   */
  async fullBootstrap(projectRoot: string, parser: ISymbolParser): Promise<void> {
    const trackedFiles = await this._gitClient.listTrackedFiles(projectRoot)
    const supported = trackedFiles.filter((f) => SUPPORTED_EXTENSIONS.has(extname(f)))

    this._logger.debug(
      { total: trackedFiles.length, supported: supported.length },
      'fullBootstrap: starting'
    )

    let parsedCount = 0
    for (const filePath of supported) {
      try {
        const symbols = await parser.parseFile(filePath)
        const hash = await computeFileHash(filePath)
        await this._symbolRepo.upsertFileSymbols(filePath, symbols, hash)
        parsedCount++
      } catch (err: unknown) {
        this._logger.warn({ filePath, err }, 'fullBootstrap: parse/upsert failed, skipping')
      }
    }

    const currentSha = await this._gitClient.getCurrentSha(projectRoot)
    await this._metaRepo.updateMeta({
      commitSha: currentSha,
      updatedAt: new Date(),
      fileCount: parsedCount,
    })

    this._logger.debug({ parsedCount }, 'fullBootstrap: complete')
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}
