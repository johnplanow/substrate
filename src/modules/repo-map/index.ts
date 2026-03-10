/**
 * Repo-map module — public API barrel.
 */

export { GrammarLoader } from './GrammarLoader.js'
export { SymbolParser } from './SymbolParser.js'
export { RepoMapGenerator } from './generator.js'
export type { IGrammarLoader, ISymbolParser, ParsedSymbol, SymbolKind } from './interfaces.js'
export type { ISymbolRepository } from './interfaces.js'

// Story 28-2: Dolt storage, git client, and related types
export { DoltSymbolRepository, DoltRepoMapMetaRepository, RepoMapStorage, computeFileHash, SUPPORTED_EXTENSIONS } from './storage.js'
export { GitClient } from './git-client.js'
export type {
  IRepoMapMetaRepository,
  IGitClient,
  SymbolFilter,
  RepoMapMeta,
} from './interfaces.js'

// Story 28-3: query engine, formatter, and types
export { RepoMapQueryEngine } from './query.js'
export { RepoMapFormatter } from './formatter.js'
export type {
  SymbolType,
  RepoMapSymbol,
  RepoMapQuery,
  ScoredSymbol,
  RepoMapQueryResult,
} from './types.js'

// Story 28-6: repo-map telemetry helper
export { RepoMapTelemetry } from './repo-map-telemetry.js'

// Story 28-9: high-level facade for staleness detection
export { RepoMapModule } from './RepoMapModule.js'
