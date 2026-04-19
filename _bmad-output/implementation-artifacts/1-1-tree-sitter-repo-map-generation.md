# Story 1-1: Tree-Sitter Integration and Repo-Map Generation

Status: review

## Story

As a pipeline developer,
I want substrate to parse the project codebase using tree-sitter and extract a structural symbol index,
so that agents receive compact structural context about the codebase instead of re-exploring files from scratch each run.

## Acceptance Criteria

### AC1: Module Foundation and Error Codes
**Given** the repo-map module directory does not yet exist
**When** the implementation is complete
**Then** `src/modules/repo-map/` contains `index.ts`, `interfaces.ts`, `schemas.ts`, `GrammarLoader.ts`, `SymbolParser.ts`, and `generator.ts`; error codes `ERR_REPO_MAP_PARSE_FAILED` and `ERR_REPO_MAP_PARSE_TIMEOUT` are exported from `src/errors/index.ts` as `const` string literals following the existing pattern

### AC2: Grammar Loader with Lazy-Load and Extensible Registry
**Given** tree-sitter grammar npm packages for TypeScript, JavaScript, and Python are installed as optional dependencies
**When** `GrammarLoader.getGrammar(extension)` is called for `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, or `.py`
**Then** it returns the corresponding tree-sitter language object on first call (loading the grammar module) and returns the cached instance on subsequent calls; for unsupported extensions it returns `null` and logs a `debug`-level message

### AC3: Symbol Extraction from Source Files
**Given** a TypeScript or JavaScript source file containing exported functions, classes, interfaces, type aliases, and enums
**When** `SymbolParser.parseFile(filePath)` is called
**Then** it returns a `ParsedSymbol[]` array where each entry has: `name: string`, `kind: SymbolKind` (`'function'|'class'|'interface'|'type'|'enum'|'export'`), `filePath: string`, `lineNumber: number`, `signature: string`, and `exported: boolean`; only symbols with `exported: true` are included in the output

### AC4: Import Statement Extraction
**Given** a source file with `import` statements
**When** `SymbolParser.parseFile(filePath)` is called
**Then** the returned array also contains entries with `kind: 'import'`, `name` set to the imported module path, `signature` containing the comma-separated list of imported names (or `'default'` for default imports), and `exported: false`

### AC5: Compact Text Format Output
**Given** a `ParsedSymbol[]` array covering multiple files and a project root path
**When** `RepoMapGenerator.formatAsText(symbols, projectRoot)` is called
**Then** it returns a multi-line string where each file is preceded by a relative-path header line and followed by one indented line per non-import symbol in the format `  <kind> <name>(<signature>)` (or `  <kind> <name>` for types/enums); files with no exported symbols are omitted

### AC6: Per-File Parse Timeout
**Given** a source file whose tree-sitter parse call does not resolve within 5 seconds
**When** `SymbolParser.parseFile(filePath)` is called
**Then** it throws an `AppError` with code `ERR_REPO_MAP_PARSE_TIMEOUT` and exit code 2 after 5 seconds; subsequent calls to other files are not affected

### AC7: Graceful Degradation When tree-sitter is Unavailable
**Given** the `tree-sitter` and grammar npm packages are not installed (optional dependency absent)
**When** `GrammarLoader.getGrammar(extension)` is called
**Then** it catches the `MODULE_NOT_FOUND` error, emits a `warn`-level structured log with `{ component: 'repo-map', reason: 'tree-sitter unavailable' }` exactly once (not on every call), and returns `null`; `SymbolParser.parseFile()` calls on any file return `[]` without throwing

## Tasks / Subtasks

- [x] Task 1: Create module directory structure and foundational types (AC: #1, #3, #4)
  - [x] Create `src/modules/repo-map/interfaces.ts` exporting: `SymbolKind` union type, `ParsedSymbol` interface, `IGrammarLoader` interface (`getGrammar(ext: string): unknown | null`), `ISymbolParser` interface (`parseFile(path: string): Promise<ParsedSymbol[]>`)
  - [x] Create `src/modules/repo-map/schemas.ts` exporting `ParsedSymbolSchema` (Zod) and re-export inferred `ParsedSymbol` type from `interfaces.ts` as the canonical name
  - [x] Add `ERR_REPO_MAP_PARSE_FAILED` and `ERR_REPO_MAP_PARSE_TIMEOUT` to `src/errors/index.ts` as `as const` string literal exports, following the `ERR_TELEMETRY_NOT_STARTED` pattern already present

- [x] Task 2: Implement `GrammarLoader` with lazy-load and extensibility (AC: #2, #7)
  - [x] Create `src/modules/repo-map/GrammarLoader.ts` implementing `IGrammarLoader`
  - [x] Constructor accepts a `logger: ILogger` parameter; create child logger with `{ component: 'repo-map' }`
  - [x] Build a private `extensionMap` mapping `.ts/.tsx` → `tree-sitter-typescript/typescript`, `.js/.mjs/.cjs` → `tree-sitter-javascript`, `.py` → `tree-sitter-python`
  - [x] `getGrammar(ext)`: check `_cache` first; on miss, dynamically `require(grammarModule)` inside a try-catch; on `MODULE_NOT_FOUND` set a `_unavailable` flag, log warn once, return `null`; on success cache and return the grammar
  - [x] Unsupported extensions log at `debug` level and return `null` without setting `_unavailable`

- [x] Task 3: Implement `SymbolParser` with symbol and import extraction (AC: #3, #4)
  - [x] Create `src/modules/repo-map/SymbolParser.ts` implementing `ISymbolParser`; constructor accepts `grammarLoader: IGrammarLoader` and `logger: ILogger`
  - [x] `parseFile(filePath)`: read file with `fs.readFile`, call `grammarLoader.getGrammar(extname(filePath))`; if `null`, return `[]`
  - [x] Use tree-sitter `Parser` + grammar to produce an AST; traverse top-level nodes to extract exported declarations (function, class, interface, type alias, enum)
  - [x] For each extracted symbol, build a `ParsedSymbol` with `name`, `kind`, `filePath`, `lineNumber` (1-based), `signature` (parameter list for functions, empty string for others), `exported: true`
  - [x] Also traverse `ImportDeclaration` nodes; for each, emit a `ParsedSymbol` with `kind: 'import'`, `name` = module specifier string, `signature` = joined imported binding names or `'default'`, `exported: false`
  - [x] Wrap the parse and traverse in a `Promise.race` against a 5-second `setTimeout` that rejects with `new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, \`Parse timeout for ${filePath}\`)`

- [x] Task 4: Implement `RepoMapGenerator.formatAsText()` (AC: #5)
  - [x] Create `src/modules/repo-map/generator.ts` exporting class `RepoMapGenerator`
  - [x] `formatAsText(symbols: ParsedSymbol[], projectRoot: string): string`: group non-import symbols by `filePath`; for each file with at least one exported symbol, emit a relative-path header then one indented line per symbol
  - [x] Line format: `  <kind> <name>(<signature>)` when signature is non-empty; `  <kind> <name>` when empty
  - [x] Files with zero exported symbols are skipped entirely; import entries are excluded from the text output

- [x] Task 5: Unit tests for `GrammarLoader` (AC: #2, #7)
  - [x] Create `src/modules/repo-map/__tests__/GrammarLoader.test.ts`
  - [x] Mock `require` / dynamic import for grammar modules via `vi.mock` or a test-injected factory
  - [x] Test: supported extension returns grammar on first call and cached instance on second call
  - [x] Test: unsupported extension returns `null` and logs debug (no warn)
  - [x] Test: `MODULE_NOT_FOUND` on require → returns `null`, logs warn exactly once across multiple calls, subsequent calls return `null` without re-logging

- [x] Task 6: Unit tests for `SymbolParser` (AC: #3, #4, #6)
  - [x] Create `src/modules/repo-map/__tests__/SymbolParser.test.ts`
  - [x] Inject a stub `IGrammarLoader` that returns a mock tree-sitter grammar object; mock `fs.readFile` via `vi.mock('node:fs/promises', ...)`
  - [x] Test: exported function node → `ParsedSymbol` with correct `name`, `kind: 'function'`, `lineNumber`, `exported: true`
  - [x] Test: exported class, interface, type alias, enum each produce correct `kind` values
  - [x] Test: import declaration → `kind: 'import'`, `name` = module specifier, `signature` = imported names
  - [x] Test: `null` grammar from loader → `parseFile()` resolves to `[]`
  - [x] Test: parse that never resolves → `AppError(ERR_REPO_MAP_PARSE_TIMEOUT)` thrown after 5s (use `vi.useFakeTimers()` + `vi.runAllTimersAsync()`)

- [x] Task 7: Unit tests for `RepoMapGenerator.formatAsText()` (AC: #5)
  - [x] Create `src/modules/repo-map/__tests__/generator.test.ts`
  - [x] Test: single file with exported function → header line + one indented line with signature
  - [x] Test: multiple files → separate header blocks in file-path order
  - [x] Test: file containing only import symbols → omitted from output
  - [x] Test: symbol with empty signature → line format without parentheses
  - [x] Test: `projectRoot` stripped from file paths → header shows relative path

- [x] Task 8: Export public API from `index.ts` and verify build (AC: #1)
  - [x] Create `src/modules/repo-map/index.ts` exporting: `GrammarLoader`, `SymbolParser`, `RepoMapGenerator`, `IGrammarLoader`, `ISymbolParser`, `ParsedSymbol`, `SymbolKind`
  - [x] Do NOT export internal schemas or private implementation details
  - [x] Run `npm run build` and confirm zero TypeScript errors

## Dev Notes

### Architecture Constraints
- **Module location**: `src/modules/repo-map/` — mirrors `src/modules/telemetry/` layout exactly
- **tree-sitter as optional dependency**: declare `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python` under `optionalDependencies` in `package.json`; do NOT add to `dependencies` — allows `npm install` to succeed in CI environments without native build tools
- **Constructor injection**: `GrammarLoader` and `SymbolParser` accept `ILogger` as a constructor parameter; never call `createLogger()` inside — caller injects the logger. Use `createLogger('repo-map:grammar')` and `createLogger('repo-map:parser')` at the composition root / in tests.
- **Error codes**: Add to `src/errors/index.ts` using the exact `export const ERR_X = 'ERR_X' as const` pattern. Do NOT create a new error subclass — use `AppError` directly: `new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, message)`
- **No Dolt writes in this story**: `SymbolParser` and `RepoMapGenerator` produce in-memory `ParsedSymbol[]` only. Storage is story 1-2's concern.
- **No CLI command in this story**: CLI (`substrate repo-map --generate`) is deferred to story 1-9. This story provides the parsing engine that the CLI will invoke.
- **No worker_thread in this story**: Full bootstrap in a worker thread (to avoid blocking the event loop) is an optimization deferred to later. This story implements the core parsing logic synchronously.
- **Import order**: Node built-ins (`node:fs/promises`, `node:path`) first, then third-party (`tree-sitter`, `zod`), then internal modules — blank line between each group
- **File naming**: all kebab-case (files), PascalCase (exported classes), `I`-prefix for interfaces (`IGrammarLoader`, `ISymbolParser`)

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
```

### tree-sitter Node.js API Pattern
```typescript
import Parser from 'tree-sitter'
// Grammar loaded dynamically:
const TypeScript = require('tree-sitter-typescript').typescript
const parser = new Parser()
parser.setLanguage(TypeScript)
const tree = parser.parse(sourceCode)
// tree.rootNode.children[] — traverse to find exported declarations
```
Use `node.type` to match declaration kinds (e.g. `'export_statement'`, `'function_declaration'`, `'class_declaration'`, `'interface_declaration'`, `'type_alias_declaration'`, `'enum_declaration'`, `'import_statement'`).

### Parse Timeout Pattern
```typescript
const parsePromise: Promise<ParsedSymbol[]> = /* ... tree-sitter work ... */
const timeoutPromise: Promise<never> = new Promise((_, reject) =>
  setTimeout(() => reject(new AppError(ERR_REPO_MAP_PARSE_TIMEOUT, 2, `Parse timeout: ${filePath}`)), 5000)
)
return Promise.race([parsePromise, timeoutPromise])
```
In unit tests, use `vi.useFakeTimers()` before the test and `vi.runAllTimersAsync()` to advance past the 5-second threshold without real waiting.

### GrammarLoader Graceful Degradation Pattern
```typescript
private _unavailable = false

getGrammar(ext: string): unknown | null {
  if (this._unavailable) return null
  // ...
  try {
    const grammar = require(grammarModulePath)
    this._cache.set(ext, grammar)
    return grammar
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      if (!this._unavailable) {
        this._logger.warn('tree-sitter grammar unavailable', { component: 'repo-map', reason: 'tree-sitter unavailable' })
        this._unavailable = true
      }
      return null
    }
    throw err
  }
}
```

### Testing Requirements
- **All tree-sitter calls must be mocked** — never require real grammar binaries in unit tests. Inject a stub `IGrammarLoader` that returns a pre-built mock AST node tree.
- **`vi.useFakeTimers()`** required for AC6 timeout test in `SymbolParser.test.ts`
- **`vi.mock('node:fs/promises', ...)`** for file read mocking in `SymbolParser.test.ts`
- Coverage target: ≥80% on all new files; co-located tests count toward this threshold
- Run with `npm run test:fast` after implementation; confirm no regressions in existing test files

### ILogger Interface
Use the existing `ILogger` / `createLogger` pattern (see `src/modules/telemetry/ingestion-server.ts` for the import path and usage pattern). Pass `createLogger('repo-map:grammar')` and `createLogger('repo-map:parser')` in tests.

## Interface Contracts

- **Export**: `ParsedSymbol` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-2 Dolt storage)
- **Export**: `SymbolKind` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-2)
- **Export**: `IGrammarLoader` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-2 for dependency injection)
- **Export**: `ISymbolParser` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-2 for dependency injection)
- **Export**: `RepoMapGenerator` @ `src/modules/repo-map/generator.ts` (consumed by story 1-2 and story 1-9 CLI)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 8 tasks completed. 33 new tests added (GrammarLoader: 15, SymbolParser: 9, generator: 9).
- GrammarLoader and SymbolParser use protected `_loadModule` / `_createParser` hooks for test injection (avoids native binary loading in tests).
- tree-sitter added as optionalDependencies in package.json.
- Full test suite: 5085 tests passing, 0 failures, 204 test files.

### File List
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/interfaces.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/schemas.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/GrammarLoader.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/SymbolParser.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/generator.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/index.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/__tests__/GrammarLoader.test.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/__tests__/SymbolParser.test.ts
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/__tests__/generator.test.ts
- /home/jplanow/code/jplanow/substrate/src/errors/index.ts
- /home/jplanow/code/jplanow/substrate/package.json

## Change Log
