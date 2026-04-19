# Story 28-3: Repo-Map Query Interface

Status: complete

## Story

As a pipeline orchestrator,
I want to query the repo-map for symbols filtered by file pattern, name, type, or dependency relationship with token-budget truncation,
so that agents receive focused structural context about the codebase without consuming excessive prompt tokens.

## Acceptance Criteria

### AC1: Filtered Symbol Query
**Given** symbols stored in the repo-map by stories 28-1 and 28-2
**When** `RepoMapQueryEngine.query({ files: ['src/modules/state/**'] })` is called
**Then** only symbols whose `filePath` matches the provided glob pattern(s) are returned, ordered by `filePath` ascending then `lineNumber` ascending

### AC2: Multi-Filter Composition
**Given** stored symbols across multiple files and types
**When** `query({ symbols: ['DoltClient', 'StateStore'], types: ['class', 'interface'] })` is called with multiple filter fields
**Then** only symbols satisfying ALL specified filters (AND logic) are returned; an empty filter object returns all stored symbols up to the token budget

### AC3: Relevance Ranking
**Given** a query that matches symbols both by direct file-glob and via dependency traversal
**When** results are assembled and ordered
**Then** symbols from files that directly match the `files` glob receive a higher relevance score than symbols matched only through dependency chains, and the final result set is ordered by score descending

### AC4: Token Budget Truncation
**Given** a query result set whose combined text representation exceeds the requested budget
**When** `query({ maxTokens: 2000 })` is called
**Then** the result is truncated to fit within `maxTokens × 4` characters using the 4-chars-per-token heuristic, lowest-ranked symbols are dropped first, and the returned `RepoMapQueryResult` includes `truncated: true` and `symbolCount` reflecting only the returned subset

### AC5: Dependency Traversal
**Given** stored symbols whose `dependencies` JSON array records which symbol names each file imports
**When** `query({ dependedBy: 'StoryState' })` is called
**Then** all symbols from files that list `StoryState` in their `dependencies` array are returned (files that depend on / import `StoryState`); when `query({ dependsOn: 'StoryRunner' })` is called, all symbols from files that are listed as dependencies of the `StoryRunner` symbol's file are returned

### AC6: Compact Text Output Format
**Given** a populated `RepoMapQueryResult`
**When** `RepoMapFormatter.toText(result)` is called
**Then** output groups symbols by file, printing one `<filePath>:<lineNumber> <symbolType> <symbolName>(<signature>)` line per symbol, with a blank line between file groups and a leading comment `# repo-map: <symbolCount> symbols` as the first line

### AC7: JSON Output Format
**Given** a populated `RepoMapQueryResult`
**When** `RepoMapFormatter.toJson(result)` is called
**Then** output is a JSON string of the full `RepoMapQueryResult` object including all `RepoMapSymbol` fields (`filePath`, `symbolName`, `symbolType`, `signature`, `lineNumber`, `dependencies`, `relevanceScore`) plus the top-level `truncated` and `symbolCount` metadata fields

## Tasks / Subtasks

- [ ] Task 1: Extend `src/modules/repo-map/types.ts` with query types (AC: #1, #2, #3, #4, #5)
  - [ ] Add `RepoMapQuery` interface: `{ files?: string[]; symbols?: string[]; types?: SymbolType[]; dependsOn?: string; dependedBy?: string; maxTokens?: number; outputFormat?: 'text' | 'json' }` — all fields optional; `maxTokens` defaults to 2000
  - [ ] Add `ScoredSymbol` interface extending `RepoMapSymbol`: `{ relevanceScore: number }` — `relevanceScore` is a number in 0–100 range
  - [ ] Add `RepoMapQueryResult` interface: `{ symbols: ScoredSymbol[]; symbolCount: number; truncated: boolean; queryDurationMs: number }`
  - [ ] Export all new types from `src/modules/repo-map/index.ts`

- [ ] Task 2: Extend `ISymbolRepository` in `src/modules/repo-map/interfaces.ts` with query methods (AC: #1, #2, #5)
  - [ ] Add `findByFilePaths(filePaths: string[]): Promise<RepoMapSymbol[]>` — batch lookup by exact file path
  - [ ] Add `findBySymbolNames(names: string[]): Promise<RepoMapSymbol[]>` — case-sensitive symbol name lookup
  - [ ] Add `findByTypes(types: SymbolType[]): Promise<RepoMapSymbol[]>` — filter by symbol type
  - [ ] Add `findByDependedBy(symbolName: string): Promise<RepoMapSymbol[]>` — returns symbols from files whose `dependencies` JSON array contains `symbolName`
  - [ ] Add `findAll(): Promise<RepoMapSymbol[]>` — full table scan, used when no filter is specified
  - [ ] These methods extend (do not replace) the write-side interface defined in story 28-2

- [ ] Task 3: Implement `RepoMapQueryEngine` class in `src/modules/repo-map/query.ts` — filter dispatch and AND-composition (AC: #1, #2)
  - [ ] Constructor: `new RepoMapQueryEngine(repo: ISymbolRepository, logger: Logger)` — store injected dependencies; logger created via `createLogger('repo-map:query')` at the call site
  - [ ] Implement `async query(q: RepoMapQuery): Promise<RepoMapQueryResult>` — record start time for `queryDurationMs`
  - [ ] Dispatch to the appropriate repository method(s) based on which filter fields are populated; when multiple filter fields are present, fetch candidates for each and intersect (AND logic) by `filePath + symbolName` composite key
  - [ ] When `q` has no filter fields, call `repo.findAll()` as the candidate set
  - [ ] Glob matching for `files` filter: use the `minimatch` package (already in project deps) to match `filePath` against each pattern; a symbol matches if any pattern matches

- [ ] Task 4: Implement relevance ranking and dependency traversal in `RepoMapQueryEngine` (AC: #3, #5)
  - [ ] Define private `scoreSymbol(symbol: RepoMapSymbol, q: RepoMapQuery): number` — base score 50; +40 if symbol's `filePath` matches any `files` glob; +20 if `symbolName` matches any `symbols` entry; +10 if `symbolType` is in `types`; dependency-traversal hits receive base score of 30
  - [ ] For `dependedBy: string` queries, call `repo.findByDependedBy(q.dependedBy)` to fetch the candidate set, then score each symbol with the base score 30 plus any additional filter bonuses
  - [ ] For `dependsOn: string` queries: look up the target symbol by name to get its `filePath`, then find all symbols from files listed in that symbol's `dependencies` array via `repo.findByFilePaths(deps)` — score those at base 30
  - [ ] Sort final candidate set by `relevanceScore` descending, then `filePath` + `lineNumber` ascending as tie-breakers

- [ ] Task 5: Implement token budget truncation in `RepoMapQueryEngine` (AC: #4)
  - [ ] Implement private `applyBudget(symbols: ScoredSymbol[], maxTokens: number): { symbols: ScoredSymbol[]; truncated: boolean }` — default `maxTokens` is 2000
  - [ ] Estimate each symbol's text size as `filePath.length + symbolName.length + (signature?.length ?? 0) + 30` characters (constant 30 covers `:lineNumber symbolType ` overhead and newlines)
  - [ ] Accumulate symbols in score-descending order; stop adding once cumulative char count exceeds `maxTokens × 4`
  - [ ] Return `{ symbols: accepted, truncated: accepted.length < original.length }`

- [ ] Task 6: Implement `RepoMapFormatter` class in `src/modules/repo-map/formatter.ts` (AC: #6, #7)
  - [ ] Implement static `toText(result: RepoMapQueryResult): string` — first line: `# repo-map: ${result.symbolCount} symbols`; then for each file group (group by `filePath`), print a blank line then `${filePath}:${lineNumber} ${symbolType} ${symbolName}(${signature ?? ''})` per symbol
  - [ ] Implement static `toJson(result: RepoMapQueryResult): string` — `JSON.stringify(result, null, 2)`
  - [ ] Export `RepoMapFormatter` from `src/modules/repo-map/index.ts`

- [ ] Task 7: Update `src/modules/repo-map/index.ts` barrel exports (AC: all)
  - [ ] Export `RepoMapQueryEngine` from `./query.js`
  - [ ] Export `RepoMapFormatter` from `./formatter.js`
  - [ ] Export all new types: `RepoMapQuery`, `ScoredSymbol`, `RepoMapQueryResult`

- [ ] Task 8: Unit tests for `RepoMapQueryEngine` and `RepoMapFormatter` (AC: all)
  - [ ] Create `src/modules/repo-map/__tests__/query.test.ts`
  - [ ] Stub `ISymbolRepository` via `vi.fn()` injected implementations (no Dolt required)
  - [ ] Test AC1: `files` glob filter returns only matching symbols; non-matching symbols are excluded
  - [ ] Test AC2: combined `symbols` + `types` filter returns intersection (AND) of both; empty query returns all symbols
  - [ ] Test AC3: symbols from glob-matched files score higher than dependency-traversal matches; output is score-descending
  - [ ] Test AC4: result with `maxTokens: 10` truncates to budget; `truncated: true` when cut; `truncated: false` when all fit; `symbolCount` equals returned array length
  - [ ] Test AC5: `dependedBy` query calls `repo.findByDependedBy` and returns its results; `dependsOn` query calls symbol lookup then `findByFilePaths`
  - [ ] Test AC6: `RepoMapFormatter.toText()` produces `# repo-map:` header, groups by file, one line per symbol with correct format
  - [ ] Test AC7: `RepoMapFormatter.toJson()` produces valid JSON string parseable back to `RepoMapQueryResult` with all fields
  - [ ] Create `src/modules/repo-map/__tests__/formatter.test.ts` with snapshot-style string assertions for both formatters

## Dev Notes

### Architecture Constraints
- **ESM imports**: All internal imports must use `.js` extension suffix (e.g., `import { RepoMapSymbol } from './types.js'`).
- **Import order**: Node built-ins first, then third-party (`minimatch`), then internal relative imports — blank line between groups.
- **No cross-module direct imports**: This module imports only from `./types.js`, `./interfaces.js`, `./query.js`, `./formatter.js` within the repo-map module. No imports from `src/modules/state/` or `src/modules/telemetry/`.
- **Glob matching**: Use `minimatch` for file glob pattern matching (already in project deps for existing pipeline work). Import as `import { minimatch } from 'minimatch'`.
- **Logging**: Create per-call-site logger via `createLogger('repo-map:query')`. Import from `../../utils/logger.js`. Never use `console.log`.
- **Dependency injection**: `RepoMapQueryEngine` takes `ISymbolRepository` via constructor — allows in-memory stubs in unit tests without any Dolt dependency. No factory function required for this class.
- **Token heuristic**: 4 characters per token is the same heuristic used by `ContextInjector` (architecture constraint `context-injector-token-budget`). Do not import `tiktoken` — the character heuristic is intentional.
- **minimatch glob patterns**: Patterns like `src/modules/state/**` require `{ dot: false }` option for standard behavior. Pass `{ dot: false }` as the third arg to `minimatch()`.

### File Paths
```
src/modules/repo-map/
  types.ts           ← MODIFY (created by 28-1): add RepoMapQuery, ScoredSymbol, RepoMapQueryResult
  interfaces.ts      ← MODIFY (created by 28-2): add read-side query methods to ISymbolRepository
  query.ts           ← NEW: RepoMapQueryEngine class
  formatter.ts       ← NEW: RepoMapFormatter class
  index.ts           ← MODIFY (created by 28-1/28-2): export new classes and types
  __tests__/
    query.test.ts    ← NEW: unit tests for RepoMapQueryEngine
    formatter.test.ts ← NEW: unit tests for RepoMapFormatter
```

### Types Provided by Prior Stories (do not redefine)
Story 28-1 defines in `src/modules/repo-map/types.ts`:
```typescript
export type SymbolType = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'export'

export interface RepoMapSymbol {
  filePath: string       // relative to project root
  symbolName: string
  symbolType: SymbolType
  signature?: string     // e.g. "(config: AppConfig): void"
  lineNumber: number
  dependencies: string[] // symbol names this file imports
  fileHash: string       // SHA-256 of file content at parse time
}
```

Story 28-2 defines in `src/modules/repo-map/interfaces.ts`:
```typescript
export interface ISymbolRepository {
  upsertSymbols(filePath: string, symbols: RepoMapSymbol[]): Promise<void>
  deleteByFilePath(filePath: string): Promise<void>
  getFileMeta(filePath: string): Promise<{ fileHash: string } | null>
}
```

Task 2 above adds read-side query methods to this interface — add them, do not replace the write-side methods.

### Relevance Score Design
The `scoreSymbol` function is intentionally simple — no ML or fuzzy scoring:
- Base score: 50 for all candidates
- +40 if `filePath` matches any `files` glob
- +20 if `symbolName` is in the `symbols` array
- +10 if `symbolType` is in the `types` array
- Dependency traversal candidates (from `dependedBy` / `dependsOn` queries) start at 30 instead of 50, then accumulate bonuses the same way

Maximum possible score: 50 + 40 + 20 + 10 = 120 (direct file + name + type match).

### SQL Pattern for `findByDependedBy`
The `dependencies` column is stored as a JSON array of symbol name strings. In Dolt (MySQL-wire), use `JSON_CONTAINS` to query it:
```sql
SELECT * FROM repo_map_symbols
WHERE JSON_CONTAINS(dependencies, JSON_QUOTE(?), '$')
```
Where `?` is the target symbol name string. This is the query `DoltSymbolRepository.findByDependedBy()` will implement (defined in story 28-2 but the interface is extended here).

### Testing Requirements
- **Test framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; NO jest APIs
- **Mock strategy**: Stub `ISymbolRepository` by creating a plain object with `vi.fn()` methods injected into `RepoMapQueryEngine` constructor — no real Dolt connection
- **Coverage**: ≥80% line coverage on `query.ts` and `formatter.ts`
- **No I/O in unit tests**: `RepoMapQueryEngine` tests must not touch the filesystem, network, or any subprocess

## Interface Contracts

- **Import**: `RepoMapSymbol`, `SymbolType` @ `src/modules/repo-map/types.ts` (from story 28-1 — tree-sitter parser defines these)
- **Import**: `ISymbolRepository` (write-side) @ `src/modules/repo-map/interfaces.ts` (from story 28-2 — extended here with read-side methods)
- **Export**: `RepoMapQuery`, `ScoredSymbol`, `RepoMapQueryResult` @ `src/modules/repo-map/types.ts` (consumed by story 28-7 prompt injection and story 28-9 CLI commands)
- **Export**: `RepoMapQueryEngine` @ `src/modules/repo-map/query.ts` (consumed by story 28-7 ContextInjector, story 28-9 CLI)
- **Export**: `RepoMapFormatter` @ `src/modules/repo-map/formatter.ts` (consumed by story 28-9 CLI output formatting)
- **Export**: `ISymbolRepository` (read+write) @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-9 and any future story needing direct repo access)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
