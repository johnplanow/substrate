# Story 28-1: SymbolParser — tree-sitter Grammar Foundation

Status: complete

## Story

As a pipeline developer,
I want a SymbolParser module that uses tree-sitter to extract exported symbols (functions, classes, interfaces, types, enums) from TypeScript, JavaScript, and Python source files,
so that downstream modules can generate a compact repo-map and inject relevant structural context into agent prompts instead of requiring agents to re-explore files from scratch each run.

## Acceptance Criteria

### AC1: Module Foundation and Error Codes
**Given** the `src/modules/repo-map/` directory does not yet exist
**When** the implementation is complete
**Then** `src/modules/repo-map/` contains `index.ts`, `interfaces.ts`, `schemas.ts`, `GrammarLoader.ts`, `SymbolParser.ts`, and `generator.ts`; error codes `ERR_REPO_MAP_PARSE_FAILED` and `ERR_REPO_MAP_PARSE_TIMEOUT` are exported from `src/errors/index.ts` as `export const ERR_X = 'ERR_X' as const` string literals following the existing pattern

### AC2: GrammarLoader with Lazy-Load and Extensible Registry
**Given** tree-sitter grammar npm packages for TypeScript, JavaScript, and Python are installed as optional dependencies
**When** `GrammarLoader.getGrammar(extension)` is called for `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, or `.py`
**Then** it returns the corresponding tree-sitter language object on first call (loading the grammar module lazily) and returns the cached instance on subsequent calls; for unsupported extensions it returns `null` and logs a `debug`-level message

### AC3: Symbol Extraction from TypeScript and JavaScript Files
**Given** a `.ts`, `.tsx`, or `.js` source file containing exported functions, classes, interfaces, type aliases, and enums
**When** `SymbolParser.parseFile(filePath)` is called
**Then** it returns a `ParsedSymbol[]` array where each entry has: `name: string`, `kind: SymbolKind` (`'function'|'class'|'interface'|'type'|'enum'|'import'`), `filePath: string`, `lineNumber: number`, `signature: string`, and `exported: boolean`; only declarations with `exported: true` are included in the output (unexported symbols are excluded)

### AC4: Import Statement Extraction
**Given** a source file with `import` statements
**When** `SymbolParser.parseFile(filePath)` is called
**Then** the returned array also includes entries with `kind: 'import'`, `name` set to the imported module specifier, `signature` containing the comma-separated list of imported binding names (or `'default'` for default imports), and `exported: false`

### AC5: Compact Text Format via RepoMapGenerator
**Given** a `ParsedSymbol[]` array covering multiple files and a project root path
**When** `RepoMapGenerator.formatAsText(symbols, projectRoot)` is called
**Then** it returns a multi-line string where each file is preceded by a relative-path header line and followed by one indented line per non-import symbol in the format `  <kind> <name>(<signature>)` when signature is non-empty, or `  <kind> <name>` when empty; files with zero exported symbols are omitted entirely

### AC6: Per-File Parse Timeout Enforcement
**Given** a source file whose tree-sitter parse call does not resolve within 5 seconds
**When** `SymbolParser.parseFile(filePath)` is called
**Then** it rejects with an `AppError` carrying code `ERR_REPO_MAP_PARSE_TIMEOUT` and exit code `2` after exactly 5 seconds via `Promise.race`; subsequent calls on other files are not affected

### AC7: Graceful Degradation When tree-sitter is Unavailable
**Given** the `tree-sitter` or grammar npm packages are not installed (optional dependency absent)
**When** `GrammarLoader.getGrammar(extension)` is called
**Then** it catches the `MODULE_NOT_FOUND` error, emits a `warn`-level structured log with `{ component: 'repo-map', reason: 'tree-sitter unavailable' }` exactly once (not on every call), sets an internal unavailable flag, and returns `null`; subsequent `SymbolParser.parseFile()` calls return `[]` without throwing

## Tasks / Subtasks

- [ ] Task 1: Create module directory structure and foundational types (AC: #1, #3, #4)
  - [ ] Create `src/modules/repo-map/interfaces.ts` exporting: `SymbolKind` union type (`'function'|'class'|'interface'|'type'|'enum'|'import'`), `ParsedSymbol` interface, `IGrammarLoader` interface (`getGrammar(ext: string): unknown | null`), `ISymbolParser` interface (`parseFile(path: string): Promise<ParsedSymbol[]>`)
  - [ ] Create `src/modules/repo-map/schemas.ts` exporting `ParsedSymbolSchema` (Zod object with all `ParsedSymbol` fields) and re-exporting inferred type as the canonical `ParsedSymbol` name
  - [ ] Add `ERR_REPO_MAP_PARSE_FAILED` and `ERR_REPO_MAP_PARSE_TIMEOUT` to `src/errors/index.ts` using the exact `export const ERR_X = 'ERR_X' as const` pattern already present in that file

- [ ] Task 2: Implement `GrammarLoader` with lazy-load and graceful degradation (AC: #2, #7)
  - [ ] Create `src/modules/repo-map/GrammarLoader.ts` implementing `IGrammarLoader`
  - [ ] Constructor accepts `logger: ILogger`; build a private `extensionMap` mapping `.ts`/`.tsx` → `'tree-sitter-typescript/typescript'`, `.js`/`.mjs`/`.cjs` → `'tree-sitter-javascript'`, `.py` → `'tree-sitter-python'`
  - [ ] `getGrammar(ext)`: check `_cache` first; on miss call `_loadModule(grammarPath)` inside try-catch; on `MODULE_NOT_FOUND` set `_unavailable = true`, log warn once, return `null`; on success cache and return
  - [ ] Expose `protected _loadModule(path: string): unknown` as an overridable hook (enables test injection without native binary loading)
  - [ ] Unsupported extensions (not in `extensionMap`) log at `debug` level and return `null` without setting `_unavailable`

- [ ] Task 3: Implement `SymbolParser` with symbol and import extraction (AC: #3, #4, #6)
  - [ ] Create `src/modules/repo-map/SymbolParser.ts` implementing `ISymbolParser`; constructor accepts `grammarLoader: IGrammarLoader` and `logger: ILogger`
  - [ ] `parseFile(filePath)`: read file with `fs.readFile`, call `grammarLoader.getGrammar(extname(filePath))`; if `null` return `[]`
  - [ ] Expose `protected _createParser(): unknown` hook for test injection; in production: instantiate `new Parser()` from `tree-sitter`, call `setLanguage(grammar)`, parse source text
  - [ ] Traverse top-level AST nodes to extract: exported function/class/interface/type-alias/enum declarations → `ParsedSymbol` with `exported: true`; import declarations → `kind: 'import'`, `exported: false`, `name` = module specifier, `signature` = joined binding names or `'default'`
  - [ ] Wrap the full parse-and-traverse in `Promise.race` against a `setTimeout` of 5000ms that rejects with `new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, \`Parse timeout: ${filePath}\`)`

- [ ] Task 4: Implement `RepoMapGenerator.formatAsText()` (AC: #5)
  - [ ] Create `src/modules/repo-map/generator.ts` exporting class `RepoMapGenerator`
  - [ ] `formatAsText(symbols: ParsedSymbol[], projectRoot: string): string`: group non-import symbols by `filePath`; skip files with zero exported symbols
  - [ ] Per file: emit relative-path header (`path.relative(projectRoot, filePath)`) then one indented line per symbol: `  <kind> <name>(<signature>)` when signature non-empty, `  <kind> <name>` when empty
  - [ ] Import-kind entries (`exported: false, kind: 'import'`) are excluded from text output entirely

- [ ] Task 5: Unit tests for `GrammarLoader` (AC: #2, #7)
  - [ ] Create `src/modules/repo-map/__tests__/GrammarLoader.test.ts`
  - [ ] Subclass `GrammarLoader` in tests to override `_loadModule`; inject a mock grammar object
  - [ ] Test: supported extension returns grammar on first call and cached instance on second (no re-load)
  - [ ] Test: unsupported extension returns `null` and logs `debug` (not `warn`)
  - [ ] Test: `MODULE_NOT_FOUND` thrown by `_loadModule` → returns `null`, logs `warn` exactly once, subsequent calls return `null` without re-logging

- [ ] Task 6: Unit tests for `SymbolParser` (AC: #3, #4, #6)
  - [ ] Create `src/modules/repo-map/__tests__/SymbolParser.test.ts`
  - [ ] Inject stub `IGrammarLoader` returning a mock grammar; subclass `SymbolParser` to override `_createParser` with a fake parser that returns a controlled AST
  - [ ] Mock `node:fs/promises` via `vi.mock`
  - [ ] Test: exported function/class/interface/type/enum nodes → correct `ParsedSymbol` fields
  - [ ] Test: import declaration node → `kind: 'import'`, `name` = specifier, `signature` = binding names
  - [ ] Test: `null` grammar from loader → `parseFile()` resolves to `[]`
  - [ ] Test: parse that never resolves → `AppError(ERR_REPO_MAP_PARSE_TIMEOUT)` after 5s using `vi.useFakeTimers()` + `vi.runAllTimersAsync()`

- [ ] Task 7: Unit tests for `RepoMapGenerator.formatAsText()` (AC: #5)
  - [ ] Create `src/modules/repo-map/__tests__/generator.test.ts`
  - [ ] Test: single file with one exported function → header + indented line with signature in parentheses
  - [ ] Test: multiple files → separate header blocks, file-path order preserved
  - [ ] Test: file containing only import-kind symbols → omitted from output
  - [ ] Test: symbol with empty signature → line format without parentheses
  - [ ] Test: `projectRoot` prefix stripped from file paths in header

- [ ] Task 8: Wire public API barrel and verify build (AC: #1)
  - [ ] Create `src/modules/repo-map/index.ts` exporting: `GrammarLoader`, `SymbolParser`, `RepoMapGenerator`, `IGrammarLoader`, `ISymbolParser`, `ParsedSymbol`, `SymbolKind` — do NOT export schemas or internal implementation details
  - [ ] Add `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python` to `optionalDependencies` in `package.json`
  - [ ] Run `npm run build` and confirm zero TypeScript errors

## Dev Notes

### Architecture Constraints
- **Module location**: `src/modules/repo-map/` — mirror the `src/modules/telemetry/` layout (index.ts barrel, interfaces.ts for types, implementation files, `__tests__/` co-located)
- **tree-sitter as optional dependency**: declare under `optionalDependencies` in `package.json`, NOT `dependencies` — prevents `npm install` failures in CI environments without native build toolchain
- **Constructor injection**: `GrammarLoader` and `SymbolParser` accept `ILogger` as a constructor parameter; do NOT call `createLogger()` inside the class — callers inject the logger. Use `createLogger('repo-map:grammar')` and `createLogger('repo-map:parser')` at the composition root or in test setups
- **Protected hooks for testability**: expose `protected _loadModule(path: string): unknown` on `GrammarLoader` and `protected _createParser(): unknown` on `SymbolParser` so tests can subclass and override without touching native binaries — this avoids the fs.watch regression class documented in project memory
- **Error codes**: add to `src/errors/index.ts` following the exact `export const ERR_X = 'ERR_X' as const` pattern. Use `AppError` directly — do NOT create new error subclasses: `new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, message)`
- **No Dolt writes in this story**: `SymbolParser` and `RepoMapGenerator` produce in-memory `ParsedSymbol[]` only. Storage (Dolt migrations 012/013, `ISymbolRepository`) is scoped to story 28-2
- **No CLI command in this story**: the `substrate repo-map` CLI command is deferred to story 28-3. This story delivers only the parsing engine
- **No worker_thread bootstrap**: full worker-thread isolation for large-codebase bootstrap is an optimization deferred to a later story
- **Import order**: Node built-ins (`node:fs/promises`, `node:path`) → third-party (`tree-sitter`, `zod`) → internal (relative) — blank line between each group

### File Paths
```
src/modules/repo-map/
  index.ts                      ← public API barrel
  interfaces.ts                 ← SymbolKind, ParsedSymbol, IGrammarLoader, ISymbolParser
  schemas.ts                    ← ParsedSymbolSchema (Zod)
  GrammarLoader.ts              ← IGrammarLoader implementation
  SymbolParser.ts               ← ISymbolParser implementation
  generator.ts                  ← RepoMapGenerator class
  __tests__/
    GrammarLoader.test.ts
    SymbolParser.test.ts
    generator.test.ts
src/errors/index.ts             ← add ERR_REPO_MAP_PARSE_FAILED, ERR_REPO_MAP_PARSE_TIMEOUT
package.json                    ← add optionalDependencies
```

### tree-sitter Node.js API Pattern
```typescript
import Parser from 'tree-sitter'

// Grammar loaded dynamically in _loadModule():
const grammar = require('tree-sitter-typescript').typescript

const parser = new Parser()
parser.setLanguage(grammar)
const tree = parser.parse(sourceCode)
// tree.rootNode.children[] — traverse for exported declarations
```
Match node types via `node.type`:
- `'export_statement'` (wraps the declaration)
- `'function_declaration'`, `'class_declaration'`, `'interface_declaration'`
- `'type_alias_declaration'`, `'enum_declaration'`
- `'import_statement'` (for import extraction)

### Parse Timeout Pattern
```typescript
const parsePromise: Promise<ParsedSymbol[]> = /* tree-sitter parse + traverse */
const timeoutPromise: Promise<never> = new Promise((_, reject) =>
  setTimeout(
    () => reject(new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, `Parse timeout: ${filePath}`)),
    5000
  )
)
return Promise.race([parsePromise, timeoutPromise])
```
In unit tests, use `vi.useFakeTimers()` before the call and `await vi.runAllTimersAsync()` to advance past the 5-second threshold without real waiting.

### GrammarLoader Graceful Degradation Pattern
```typescript
private _unavailable = false
private _cache = new Map<string, unknown>()

getGrammar(ext: string): unknown | null {
  if (this._unavailable) return null
  const grammarPath = this.extensionMap.get(ext)
  if (!grammarPath) {
    this._logger.debug('Unsupported extension', { ext })
    return null
  }
  if (this._cache.has(ext)) return this._cache.get(ext)!
  try {
    const grammar = this._loadModule(grammarPath)
    this._cache.set(ext, grammar)
    return grammar
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      this._logger.warn('tree-sitter grammar unavailable', { component: 'repo-map', reason: 'tree-sitter unavailable' })
      this._unavailable = true
      return null
    }
    throw err
  }
}

protected _loadModule(path: string): unknown {
  return require(path)
}
```

### ILogger Interface
Use the existing `ILogger` / `createLogger` pattern. Check `src/modules/telemetry/ingestion-server.ts` for the import path. Pass logger instances in constructors — never call `createLogger` inside class methods.

### Testing Requirements
- **All tree-sitter calls must be mocked** — never require real grammar binaries in unit tests; use the protected `_loadModule` / `_createParser` hook subclass pattern
- **`vi.useFakeTimers()`** required for AC6 timeout test in `SymbolParser.test.ts`
- **`vi.mock('node:fs/promises', ...)`** for file read mocking in `SymbolParser.test.ts`
- Coverage target: ≥80% on all new files; co-located `__tests__/` files count toward this threshold
- Run `npm run test:fast` after implementation to confirm no regressions in existing suite

## Interface Contracts

- **Export**: `ParsedSymbol` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-2 Dolt storage layer)
- **Export**: `SymbolKind` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-2)
- **Export**: `IGrammarLoader` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-2 for dependency injection)
- **Export**: `ISymbolParser` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-2 for dependency injection)
- **Export**: `RepoMapGenerator` @ `src/modules/repo-map/generator.ts` (consumed by story 28-3 CLI command)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
