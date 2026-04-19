# Story 28-7: Repo-Map Prompt Injection

Status: review

## Story

As a pipeline orchestrator,
I want repo-map context automatically injected into dev-story and code-review prompts,
so that agents start with structural knowledge of the codebase without re-exploring it from scratch every dispatch.

## Acceptance Criteria

### AC1: RepoMapInjector Class
**Given** `RepoMapQueryEngine` and `RepoMapFormatter` from story 28-3 are available as constructor dependencies
**When** `RepoMapInjector.buildContext(storyContent, tokenBudget)` is called
**Then** it extracts source file path references from the story content (matching `src/[\w/.-]+\.tsx?`), builds a `RepoMapQuery` with those paths as the `files` filter and `maxTokens: tokenBudget`, calls `queryEngine.query()`, formats the result via `RepoMapFormatter.toText()`, and returns `{ text, symbolCount, truncated }` with the compact text representation

### AC2: Graceful Fallback When Repo-Map Unavailable
**Given** `RepoMapQueryEngine.query()` throws any error, or returns a result with zero symbols
**When** `RepoMapInjector.buildContext(storyContent, tokenBudget)` is called
**Then** it returns `{ text: '', symbolCount: 0, truncated: false }` without throwing, and emits a single `warn`-level structured log with `{ storyContent: storyContent.slice(0, 100), error: err.message }` so the pipeline continues unblocked

### AC3: Token Budget Enforcement via Query
**Given** a story content that references files matching hundreds of symbols in the repo-map
**When** `buildContext(storyContent, tokenBudget)` is called with a small `tokenBudget` (e.g., 500)
**Then** the `RepoMapQuery.maxTokens` field is set to `tokenBudget`, `RepoMapQueryEngine.query()` enforces the budget by dropping lowest-ranked symbols, and the returned `text` fits within `tokenBudget × 4` characters

### AC4: WorkflowDeps Extension and Workflow Integration
**Given** `WorkflowDeps` is extended with optional `repoMapInjector?: RepoMapInjector` and `maxRepoMapTokens?: number` fields
**When** `runDevStory(deps, params)` is called with `deps.repoMapInjector` set
**Then** it calls `deps.repoMapInjector.buildContext(storyContent, deps.maxRepoMapTokens ?? 2000)` and adds an `optional`-priority section `{ name: 'repo_context', content: result.text, priority: 'optional' }` to the `sections` array passed to `assemblePrompt`; when `deps.repoMapInjector` is absent, `repo_context` content is empty string with zero performance cost

### AC5: Prompt Template Updates
**Given** the `dev-story.md` and `code-review.md` prompt templates in `packs/bmad/prompts/`
**When** rendered by `assemblePrompt()` with an empty `repo_context` section content
**Then** each template now contains a `{{repo_context}}` placeholder and the assembled prompt contains no extra blank lines or orphaned headers; when `repo_context` content is non-empty, it appears as a `### Repo Map Context` section between the project context and test patterns sections in dev-story, and after the architecture constraints section in code-review

### AC6: Configurable Token Budget from WorkflowDeps
**Given** `WorkflowDeps.maxRepoMapTokens` is set to a value (e.g., 1500) by the caller (wired from `ModelRoutingConfig.max_repo_map_tokens` or an explicit override)
**When** `runDevStory` or `runCodeReview` calls `buildContext`
**Then** the injector uses the provided value as `tokenBudget`; when the field is absent from `WorkflowDeps`, the injector defaults to `2000` tokens; the same default applies if `buildContext` is called directly without a second argument

### AC7: Injection Telemetry via Structured Logging
**Given** `runDevStory` or `runCodeReview` successfully calls `buildContext` with a non-null `repoMapInjector`
**When** the `repo_context` text is assembled (whether empty or non-empty)
**Then** an `info`-level structured log is emitted before the `assemblePrompt` call with fields `{ storyKey, repoMapTokens: Math.ceil(text.length / 4), symbolCount, truncated }` using the existing module logger; this log is emitted even when `symbolCount === 0` so absence of repo-map context is always visible in the log stream

## Tasks / Subtasks

- [x] Task 1: Create `src/modules/context-compiler/repo-map-injector.ts` — `RepoMapInjector` class (AC: #1, #2, #3, #6)
  - [x] Define `InjectionResult` interface: `{ text: string; symbolCount: number; truncated: boolean }`; export from this file
  - [x] Define `RepoMapInjector` class with constructor `(queryEngine: RepoMapQueryEngine, logger: Logger)` — store both as readonly fields; import `RepoMapQueryEngine`, `RepoMapFormatter`, `RepoMapQuery` from `../../modules/repo-map/index.js`; import `Logger` from `../../utils/logger.js`
  - [x] Implement `async buildContext(storyContent: string, tokenBudget: number = 2000): Promise<InjectionResult>` — extract file references using `storyContent.match(/\bsrc\/[\w/.-]+\.tsx?\b/g) ?? []`, deduplicate with `[...new Set(matches)]`, filter out `*.test.ts` and `*.test.tsx`; build `RepoMapQuery = { files: dedupedPaths, maxTokens: tokenBudget }`; call `await this._queryEngine.query(query)` in try/catch; on success call `RepoMapFormatter.toText(result)` and return `{ text, symbolCount: result.symbolCount, truncated: result.truncated }`
  - [x] In the catch block, log `this._logger.warn({ error: err instanceof Error ? err.message : String(err), snippet: storyContent.slice(0, 100) }, 'repo-map context unavailable')` and return `{ text: '', symbolCount: 0, truncated: false }`
  - [x] When `dedupedPaths.length === 0` (no file refs found in story), skip the query and return `{ text: '', symbolCount: 0, truncated: false }` immediately

- [x] Task 2: Export `RepoMapInjector` and `InjectionResult` from `src/modules/context-compiler/index.ts` (AC: #1)
  - [x] Add `export { RepoMapInjector } from './repo-map-injector.js'`
  - [x] Add `export type { InjectionResult } from './repo-map-injector.js'`

- [x] Task 3: Extend `WorkflowDeps` in `src/modules/compiled-workflows/types.ts` (AC: #4, #6)
  - [x] Add import: `import type { RepoMapInjector } from '../context-compiler/index.js'`
  - [x] Add two optional fields to `WorkflowDeps`:
    ```typescript
    /**
     * Optional repo-map injector for structural context injection (Story 28-7).
     * When set, repo-map symbols relevant to the story are injected into prompts.
     */
    repoMapInjector?: RepoMapInjector
    /**
     * Optional token budget for repo-map context injection (default: 2000).
     * Sourced from ModelRoutingConfig.max_repo_map_tokens or explicit override.
     */
    maxRepoMapTokens?: number
    ```

- [x] Task 4: Integrate `repo_context` section into `runDevStory` (AC: #4, #7)
  - [x] In `src/modules/compiled-workflows/dev-story.ts`, after `const projectContextContent = ...` (around line 216), add:
    ```typescript
    let repoContextContent = ''
    if (deps.repoMapInjector !== undefined) {
      const injection = await deps.repoMapInjector.buildContext(storyContent, deps.maxRepoMapTokens ?? 2000)
      repoContextContent = injection.text
      logger.info(
        { storyKey, repoMapTokens: Math.ceil(injection.text.length / 4), symbolCount: injection.symbolCount, truncated: injection.truncated },
        'Repo-map context assembled',
      )
    }
    ```
  - [x] Add `{ name: 'repo_context', content: repoContextContent, priority: 'optional' }` to the `sections` array (insert after `project_context`, before `test_patterns`)

- [x] Task 5: Integrate `repo_context` section into `runCodeReview` (AC: #4, #7)
  - [x] In `src/modules/compiled-workflows/code-review.ts`, after the story content is read (around the architecture constraints block), add a parallel `repoContextContent` build using the same pattern as Task 4
  - [x] Read `storyContent` from `storyFilePath` (it's already read for other purposes — reuse the existing `storyContent` variable)
  - [x] Add `{ name: 'repo_context', content: repoContextContent, priority: 'optional' }` to the sections array passed to `assemblePrompt`

- [x] Task 6: Update `packs/bmad/prompts/dev-story.md` to include `{{repo_context}}` placeholder (AC: #5)
  - [x] Insert the following block after the `{{project_context}}` line and before the `{{test_patterns}}` section:
    ```
    {{repo_context}}
    ```
  - [x] No header needed — the `RepoMapFormatter.toText()` output already begins with `# repo-map: N symbols`; the placeholder is empty when no repo-map is available so no orphaned whitespace appears

- [x] Task 7: Update `packs/bmad/prompts/code-review.md` to include `{{repo_context}}` placeholder (AC: #5)
  - [x] Insert `{{repo_context}}` after `{{arch_constraints}}` and before the `---` separator
  - [x] Verify that when `repo_context` is empty string the rendered prompt is unchanged relative to the current template (no extra blank lines)

- [x] Task 8: Unit tests for `RepoMapInjector` (AC: #1, #2, #3)
  - [x] Create `src/modules/context-compiler/__tests__/repo-map-injector.test.ts`
  - [x] Stub `RepoMapQueryEngine` by creating a plain object with a single `query: vi.fn()` method; inject via constructor
  - [x] Test AC1 (happy path): story content containing `src/modules/foo/bar.ts` → `query` called with `{ files: ['src/modules/foo/bar.ts'], maxTokens: 2000 }`; stub returns a `RepoMapQueryResult` with 3 symbols; `buildContext` returns `{ text: '# repo-map: 3 symbols\n...', symbolCount: 3, truncated: false }`
  - [x] Test AC2 (query throws): stub `query` rejects with `new Error('Dolt unavailable')` → `buildContext` resolves to `{ text: '', symbolCount: 0, truncated: false }` without rethrowing
  - [x] Test AC2 (zero symbols): stub returns `{ symbols: [], symbolCount: 0, truncated: false, queryDurationMs: 1 }` → `buildContext` returns `{ text: '# repo-map: 0 symbols', symbolCount: 0, truncated: false }` (formatter returns the header line; caller treats empty text as absent context)
  - [x] Test AC3 (budget): call `buildContext(content, 100)` → verify `query` called with `maxTokens: 100` (budget enforcement is the query engine's responsibility; injector just passes the value)
  - [x] Test no-file-refs: story content with no `src/` paths → `query` is NOT called, returns `{ text: '', symbolCount: 0, truncated: false }` immediately
  - [x] Test test-file filtering: story containing `src/foo/__tests__/bar.test.ts` → `dedupedPaths` excludes test files; `query` called with empty `files` array or not called at all
  - [x] Use `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs; no file I/O

## Dev Notes

### Architecture Constraints
- **ESM imports**: all internal imports must use `.js` extension (e.g. `from '../../modules/repo-map/index.js'`)
- **Import order**: Node built-ins → third-party → internal (blank line between groups)
- **No cross-module direct imports**: `RepoMapInjector` imports from `../../modules/repo-map/index.js` only — never from deep paths like `./query.js` or `./formatter.js` within the repo-map module
- **Logging**: use `createLogger('context-compiler:repo-map-injector')` per the architecture; never `console.log`; logger instance created at module top level or in constructor (either pattern is acceptable since the class is injected)
- **Dependency injection**: `RepoMapQueryEngine` passed via constructor, never instantiated inside `RepoMapInjector`; this enables unit testing with a `vi.fn()` stub
- **No fs.watch / no config reload**: the token budget comes in as a parameter, not via a file-watching mechanism; avoids the fs.watch regression class documented in project memory
- **Token heuristic**: 4 characters per token is the established project heuristic (see `context-compiler/token-counter.ts` and architecture constraint `context-injector-token-budget`); do not import tiktoken
- **Template placeholder convention**: `{{repo_context}}` matches the existing `{{story_content}}`, `{{project_context}}` naming pattern in `prompt-assembler.ts:replacePlaceholders`

### File Paths
```
src/modules/context-compiler/
  repo-map-injector.ts          ← NEW: RepoMapInjector class + InjectionResult type
  index.ts                      ← MODIFY: export RepoMapInjector and InjectionResult
  __tests__/
    repo-map-injector.test.ts   ← NEW: unit tests

src/modules/compiled-workflows/
  types.ts                      ← MODIFY: add repoMapInjector? and maxRepoMapTokens? to WorkflowDeps
  dev-story.ts                  ← MODIFY: add repo_context section build + assembly
  code-review.ts                ← MODIFY: add repo_context section build + assembly

packs/bmad/prompts/
  dev-story.md                  ← MODIFY: add {{repo_context}} placeholder
  code-review.md                ← MODIFY: add {{repo_context}} placeholder
```

### Interface Dependency Details

**`RepoMapQueryEngine.query()`** — from story 28-3 (`src/modules/repo-map/query.ts`):
```typescript
// RepoMapQuery (from src/modules/repo-map/types.ts)
interface RepoMapQuery {
  files?: string[]       // glob patterns for file path filtering
  symbols?: string[]
  types?: SymbolType[]
  dependsOn?: string
  dependedBy?: string
  maxTokens?: number     // budget enforcement — 2000 by default
  outputFormat?: 'text' | 'json'
}

// RepoMapQueryResult (from src/modules/repo-map/types.ts)
interface RepoMapQueryResult {
  symbols: ScoredSymbol[]
  symbolCount: number
  truncated: boolean
  queryDurationMs: number
}
```

**`RepoMapFormatter.toText()`** — from story 28-3 (`src/modules/repo-map/formatter.ts`):
```typescript
// Returns a string starting with:
// # repo-map: N symbols
// <blank line>
// <filePath>:<lineNumber> <symbolType> <symbolName>(<signature>)
// ...
static toText(result: RepoMapQueryResult): string
```

### dev-story.ts Integration Pattern
```typescript
// After buildProjectContext() call (around line 216):
let repoContextContent = ''
if (deps.repoMapInjector !== undefined) {
  const injection = await deps.repoMapInjector.buildContext(storyContent, deps.maxRepoMapTokens ?? 2000)
  repoContextContent = injection.text
  logger.info(
    {
      storyKey,
      repoMapTokens: Math.ceil(injection.text.length / 4),
      symbolCount: injection.symbolCount,
      truncated: injection.truncated,
    },
    'Repo-map context assembled',
  )
}

// Then in sections array (after project_context, before test_patterns):
const sections: PromptSection[] = [
  { name: 'story_content',   content: storyContent,        priority: 'required'  },
  { name: 'task_scope',      content: taskScopeContent,    priority: 'optional'  },
  { name: 'prior_files',     content: priorFilesContent,   priority: 'optional'  },
  { name: 'files_in_scope',  content: filesInScopeContent, priority: 'optional'  },
  { name: 'project_context', content: projectContextContent, priority: 'important' },
  { name: 'repo_context',    content: repoContextContent,  priority: 'optional'  },  // NEW
  { name: 'test_patterns',   content: testPatternsContent, priority: 'optional'  },
  { name: 'test_plan',       content: testPlanContent,     priority: 'optional'  },
  { name: 'prior_findings',  content: priorFindingsContent, priority: 'optional' },
]
```

### dev-story.md Template Update
The current `dev-story.md` context header section looks like:
```
{{project_context}}

### Test Patterns
{{test_patterns}}
```
After the update it should look like:
```
{{project_context}}

{{repo_context}}

### Test Patterns
{{test_patterns}}
```
The `RepoMapFormatter.toText()` output already includes its own `# repo-map: N symbols` header, so no additional markdown heading is needed in the template. When `repo_context` is empty, `replacePlaceholders` substitutes an empty string, leaving a single blank line between sections (acceptable).

### Backward Compatibility
- `WorkflowDeps.repoMapInjector` is optional (`?`) — all existing callers that pass `WorkflowDeps` without this field continue to work with zero change
- `WorkflowDeps.maxRepoMapTokens` is optional — absent field means default 2000 tokens
- All existing tests that construct `WorkflowDeps` stubs remain valid without modification
- The `repo_context` placeholder in prompt templates is replaced by an empty string when the section content is absent — `replacePlaceholders` already handles missing keys with `''` per the existing implementation in `prompt-assembler.ts`

### Wiring in run.ts (informational — not part of this story's tasks)
This story delivers the injection layer. Connecting it to a live `DoltSymbolRepository` (from story 28-2) in `run.ts` is deferred to story 28-9 (CLI commands) which also wires up the full stack. For this story, the integration is exercised via unit tests only.

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; NO jest APIs
- **Stub strategy**: inject a plain object `{ query: vi.fn() }` as `RepoMapQueryEngine` — no real Dolt connection
- **No file I/O**: `RepoMapInjector` tests must not touch filesystem, network, or subprocess
- **Coverage gate**: ≥80% line coverage on `repo-map-injector.ts` (enforced by `npm test`)
- **Prompt template tests**: no new template tests required; existing `dev-story.test.ts` and `code-review.test.ts` will catch template regressions if they assert on rendered prompt structure

## Interface Contracts

- **Import**: `RepoMapQueryEngine`, `RepoMapFormatter`, `RepoMapQuery`, `RepoMapQueryResult`, `ScoredSymbol` @ `src/modules/repo-map/index.ts` (from story 28-3)
- **Export**: `RepoMapInjector`, `InjectionResult` @ `src/modules/context-compiler/index.ts` (consumed by run.ts wiring in story 28-9 and by any caller constructing `WorkflowDeps`)
- **Modify**: `WorkflowDeps` @ `src/modules/compiled-workflows/types.ts` — adds `repoMapInjector?` and `maxRepoMapTokens?` fields (consumed by dev-story.ts, code-review.ts, and all callers of these workflows)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Completion Notes List
- All 8 tasks were already fully implemented prior to this agent run; verified all files exist and are correct
- Build passes cleanly (tree-sitter unresolved import warning is expected — it's an optional dependency)
- 5310 tests pass (219 test files)

### File List
- src/modules/context-compiler/repo-map-injector.ts (new)
- src/modules/context-compiler/index.ts (modified)
- src/modules/compiled-workflows/types.ts (modified)
- src/modules/compiled-workflows/dev-story.ts (modified)
- src/modules/compiled-workflows/code-review.ts (modified)
- packs/bmad/prompts/dev-story.md (modified)
- packs/bmad/prompts/code-review.md (modified)
- src/modules/context-compiler/__tests__/repo-map-injector.test.ts (new)

## Change Log
