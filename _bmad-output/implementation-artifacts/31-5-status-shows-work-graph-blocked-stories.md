# Story 31-5: substrate status Shows Work Graph — Blocked Stories and Why

Status: review

## Story

As a developer using substrate,
I want `substrate status` to show the work graph state — including which stories are blocked, why they are blocked, and which stories are ready to dispatch,
so that I can quickly understand pipeline progress and what's preventing stories from being dispatched without digging through epic docs or MEMORY.md.

## Acceptance Criteria

### AC1: Work Graph Section Appears in Human-Readable Output
**Given** stories are present in `wg_stories` (work graph is populated)
**When** the user runs `substrate status`
**Then** a "Work Graph" section is appended to the human-readable output showing a summary line with counts by status (e.g., `Work Graph: 2 ready · 3 blocked · 1 in-progress · 5 complete`)

### AC2: Blocked Stories Listed with Dependency Explanation
**Given** `planned` or `ready` stories exist in `wg_stories` with unsatisfied `blocks`-type dependencies
**When** the user runs `substrate status`
**Then** each blocked story is listed under a "Blocked" sub-heading with its story key, title, and each unsatisfied blocker's key and current status (e.g., `  31-3  Epic Doc Ingestion  [waiting on: 31-2 (planned)]`)

### AC3: Ready Stories Listed
**Given** `planned` or `ready` stories exist in `wg_stories` with all `blocks` dependencies satisfied
**When** the user runs `substrate status`
**Then** those stories are listed under a "Ready" sub-heading showing story key and title

### AC4: JSON Output Includes workGraph Field
**Given** stories are present in `wg_stories`
**When** the user runs `substrate status --output-format json`
**Then** the JSON output includes a top-level `workGraph` object with:
  - `summary`: `{ ready: number, blocked: number, inProgress: number, complete: number, escalated: number }`
  - `readyStories`: array of `{ key: string, title: string }`
  - `blockedStories`: array of `{ key: string, title: string, blockers: [{ key: string, title: string, status: string }] }`

### AC5: Empty Work Graph Is Silent
**Given** `wg_stories` is empty (work graph not populated — ingestion has not run)
**When** the user runs `substrate status`
**Then** no "Work Graph" section is rendered, the command exits 0, and no error is emitted

### AC6: Work Graph Query Errors Are Non-Fatal
**Given** the work graph query fails (e.g., `wg_stories` table does not exist yet, Dolt unavailable, schema version mismatch)
**When** the user runs `substrate status`
**Then** the error is logged at debug level, the work graph section is omitted, the rest of `substrate status` output is unaffected, and the command exits 0

### AC7: WorkGraphRepository.getBlockedStories() Implemented
**Given** stories and dependencies exist in `wg_stories` and `story_dependencies` tables
**When** `getBlockedStories()` is called on `WorkGraphRepository`
**Then** it returns an array of `BlockedStoryInfo` — one entry per `planned`/`ready` story that has at least one unsatisfied `blocks`-type dependency — where each entry includes the `WgStory` and an array of `{ key, title, status }` for each unsatisfied blocker; stories with all deps satisfied are absent from the result

## Tasks / Subtasks

- [ ] Task 1: Define `BlockedStoryInfo` type and add `getBlockedStories()` to `WorkGraphRepository` (AC: #7)
  - [ ] In `src/modules/state/work-graph-repository.ts`, add export: `export interface BlockedStoryInfo { story: WgStory; blockers: Array<{ key: string; title: string; status: WgStoryStatus }> }`
  - [ ] Add `async getBlockedStories(): Promise<BlockedStoryInfo[]>` method after `getReadyStories()`
  - [ ] Implementation: call `listStories()` to get all stories; filter candidates to `status === 'planned' || status === 'ready'`; early-return `[]` if no candidates
  - [ ] Query `story_dependencies WHERE dep_type = 'blocks'`; early-return `[]` if no deps found
  - [ ] Build `statusMap = new Map(allStories.map(s => [s.story_key, s]))` and `depsMap = Map<string, string[]>` grouping by `story_key`
  - [ ] For each candidate: collect blocker keys from `depsMap`, filter to those whose status is not `'complete'`, map to `{ key, title: statusMap.get(key)?.title ?? key, status }`, push to result if any unsatisfied blockers exist
  - [ ] Export `BlockedStoryInfo` from `src/modules/state/index.ts`

- [ ] Task 2: Write unit tests for `getBlockedStories()` (AC: #7)
  - [ ] In `src/modules/state/__tests__/work-graph-repository.test.ts`, add `describe('getBlockedStories')` block
  - [ ] Reuse existing `beforeEach` DDL pattern (CREATE TABLE wg_stories + story_dependencies with InMemoryDatabaseAdapter)
  - [ ] Test: no stories → returns `[]`
  - [ ] Test: planned story with no deps → not in result (ready, not blocked)
  - [ ] Test: planned story with all `blocks` deps at `complete` → not in result
  - [ ] Test: planned story with one incomplete `blocks` dep → appears in result with correct blocker info
  - [ ] Test: planned story with two deps, one complete, one planned → appears in result with only the incomplete dep as blocker
  - [ ] Test: `in_progress` / `complete` stories are excluded from results (not candidates)

- [ ] Task 3: Define `WorkGraphSummary` type in status.ts and add work graph data collection (AC: #1, #4, #5, #6)
  - [ ] In `src/cli/commands/status.ts`, add near-top type definition:
    ```typescript
    interface WgBlockerInfo { key: string; title: string; status: string }
    interface WgBlockedStory { key: string; title: string; blockers: WgBlockerInfo[] }
    interface WgReadyStory { key: string; title: string }
    interface WorkGraphSummary {
      summary: { ready: number; blocked: number; inProgress: number; complete: number; escalated: number }
      readyStories: WgReadyStory[]
      blockedStories: WgBlockedStory[]
    }
    ```
  - [ ] Add import: `import { WorkGraphRepository } from '../../modules/state/index.js'`
  - [ ] Add import: `import type { BlockedStoryInfo } from '../../modules/state/index.js'`
  - [ ] After `await initSchema(adapter)`, add a `workGraph: WorkGraphSummary | undefined = undefined` variable
  - [ ] Wrap in try/catch: construct `new WorkGraphRepository(adapter)`, call `repo.listStories()` and `repo.getBlockedStories()`, build the `WorkGraphSummary` object; on catch, log at debug level and leave `workGraph` undefined (AC6)
  - [ ] Set `workGraph = undefined` when `listStories()` returns an empty array (AC5)

- [ ] Task 4: Update JSON output to include `workGraph` field (AC: #4, #5)
  - [ ] In the `if (outputFormat === 'json')` branch of `runStatusAction`, add `workGraph` to `enhancedOutput` after the `story_states` field: `...(workGraph !== undefined ? { workGraph } : {})`

- [ ] Task 5: Update human-readable output to show Work Graph section (AC: #1, #2, #3, #5)
  - [ ] In the `else` (human) branch of `runStatusAction`, after the `storeStories` section and before the final `formatTokenTelemetry` line, add:
    ```
    if (workGraph !== undefined) {
      const { summary, readyStories, blockedStories } = workGraph
      // Print summary line
      process.stdout.write(`\nWork Graph: ${summary.ready} ready · ${summary.blocked} blocked · ${summary.inProgress} in-progress · ${summary.complete} complete\n`)
      // Ready sub-section
      if (readyStories.length > 0) {
        process.stdout.write('\nReady:\n')
        for (const s of readyStories) {
          process.stdout.write(`  ${s.key.padEnd(10)} ${s.title}\n`)
        }
      }
      // Blocked sub-section
      if (blockedStories.length > 0) {
        process.stdout.write('\nBlocked:\n')
        for (const s of blockedStories) {
          const blockerText = s.blockers.map(b => `${b.key} (${b.status})`).join(', ')
          process.stdout.write(`  ${s.key.padEnd(10)} ${s.title}  [waiting on: ${blockerText}]\n`)
        }
      }
    }
    ```

- [ ] Task 6: Write unit/integration tests for status command with work graph (AC: #1, #2, #3, #4, #5, #6)
  - [ ] In `src/cli/commands/__tests__/status.test.ts`, add a `describe('work graph section')` block
  - [ ] Mock `WorkGraphRepository` using `vi.mock('../../modules/state/index.js', ...)` or `vi.spyOn` on the constructor prototype
  - [ ] Test: populated work graph with ready + blocked stories → Work Graph section appears in human output with counts and story listings
  - [ ] Test: blocked story entry → shows blocker key and status in human output
  - [ ] Test: `--output-format json` + populated work graph → `workGraph` field present with correct shape
  - [ ] Test: empty `wg_stories` (listStories returns `[]`) → no Work Graph section in human output, no `workGraph` field in JSON
  - [ ] Test: `WorkGraphRepository` constructor/method throws → error swallowed, rest of status output still emitted, exit code 0

- [ ] Task 7: Build and validate (AC: all)
  - [ ] `npm run build` — must exit 0, zero TypeScript errors
  - [ ] `npm run test:fast` — confirm output contains "Test Files" summary line with all tests passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **Files to modify**:
  - `src/modules/state/work-graph-repository.ts` — add `BlockedStoryInfo` interface + `getBlockedStories()` method
  - `src/modules/state/index.ts` — export `BlockedStoryInfo` (and `WorkGraphRepository` if not already exported)
  - `src/cli/commands/status.ts` — add type definitions, work graph query, extend both JSON and human output
  - `src/modules/state/__tests__/work-graph-repository.test.ts` — add `getBlockedStories()` tests
  - `src/cli/commands/__tests__/status.test.ts` — add work graph rendering tests

- **Import style**: All relative imports use `.js` extension (ESM project):
  ```typescript
  import { WorkGraphRepository } from '../../modules/state/index.js'
  import type { BlockedStoryInfo } from '../../modules/state/index.js'
  ```

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.

### getBlockedStories() Implementation Pattern

Follow the same programmatic filtering approach used in `getReadyStories()` (avoids VIEW dependency, works with InMemoryDatabaseAdapter):

```typescript
export interface BlockedStoryInfo {
  story: WgStory
  blockers: Array<{ key: string; title: string; status: WgStoryStatus }>
}

async getBlockedStories(): Promise<BlockedStoryInfo[]> {
  const allStories = await this.db.query<WgStory>(`SELECT * FROM wg_stories`)
  const candidates = allStories.filter((s) => s.status === 'planned' || s.status === 'ready')
  if (candidates.length === 0) return []

  const deps = await this.db.query<{ story_key: string; depends_on: string }>(
    `SELECT story_key, depends_on FROM story_dependencies WHERE dep_type = 'blocks'`
  )
  if (deps.length === 0) return []

  const statusMap = new Map(allStories.map((s) => [s.story_key, s]))

  const depsMap = new Map<string, string[]>()
  for (const d of deps) {
    if (!depsMap.has(d.story_key)) depsMap.set(d.story_key, [])
    depsMap.get(d.story_key)!.push(d.depends_on)
  }

  const result: BlockedStoryInfo[] = []
  for (const story of candidates) {
    const blockerKeys = depsMap.get(story.story_key) ?? []
    const unsatisfied = blockerKeys
      .filter((key) => statusMap.get(key)?.status !== 'complete')
      .map((key) => {
        const s = statusMap.get(key)
        return { key, title: s?.title ?? key, status: (s?.status ?? 'unknown') as WgStoryStatus }
      })
    if (unsatisfied.length > 0) {
      result.push({ story, blockers: unsatisfied })
    }
  }
  return result
}
```

### WorkGraphSummary Construction Pattern

Build the summary in `runStatusAction()` after `initSchema()`:

```typescript
let workGraph: WorkGraphSummary | undefined
try {
  const wgRepo = new WorkGraphRepository(adapter)
  const allStories = await wgRepo.listStories()
  if (allStories.length > 0) {
    const blockedInfos = await wgRepo.getBlockedStories()
    const readyStories = await wgRepo.getReadyStories()
    const blockedKeys = new Set(blockedInfos.map((b) => b.story.story_key))
    const readyKeys = new Set(readyStories.map((s) => s.story_key))

    const summary = {
      ready: allStories.filter((s) => readyKeys.has(s.story_key)).length,
      blocked: blockedInfos.length,
      inProgress: allStories.filter((s) => s.status === 'in_progress').length,
      complete: allStories.filter((s) => s.status === 'complete').length,
      escalated: allStories.filter((s) => s.status === 'escalated').length,
    }
    workGraph = {
      summary,
      readyStories: readyStories.map((s) => ({ key: s.story_key, title: s.title ?? s.story_key })),
      blockedStories: blockedInfos.map((b) => ({
        key: b.story.story_key,
        title: b.story.title ?? b.story.story_key,
        blockers: b.blockers.map((bl) => ({ key: bl.key, title: bl.title, status: bl.status })),
      })),
    }
  }
} catch (err) {
  logger.debug({ err }, 'Work graph query failed, omitting section')
}
```

Note: `readyStories` and `blockedStories` are mutually exclusive by definition — a story cannot be both unblocked (ready) and blocked. The `blockedKeys` set is computed but only used for type safety; `readyStories` comes from `getReadyStories()` which already excludes blocked stories.

### Status Command Location

Work graph query block should be placed in `runStatusAction()` **after** `await initSchema(adapter)` (line ~110) and **before** the `if (outputFormat === 'json')` branch split (line ~159). This ensures `workGraph` is available in both branches.

The `adapter` variable is already in scope — use it directly to construct `WorkGraphRepository`. No new adapter creation needed.

### Non-Fatal Error Pattern

Must never allow work graph failures to propagate to the outer try/catch (which returns exit code 1). Use an inner try/catch:

```typescript
// ✅ Correct — inner try/catch, errors don't propagate
try {
  const wgRepo = new WorkGraphRepository(adapter)
  // ...build workGraph...
} catch (err) {
  logger.debug({ err }, 'Work graph query failed, omitting section')
}
```

### Table DDL for Tests (copy from story 31-4 pattern)

```typescript
beforeEach(async () => {
  db = new InMemoryDatabaseAdapter()
  repo = new WorkGraphRepository(db)
  await db.exec(`CREATE TABLE IF NOT EXISTS wg_stories (
    story_key VARCHAR(20) NOT NULL,
    epic VARCHAR(20) NOT NULL,
    title VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'planned',
    spec_path VARCHAR(500),
    created_at DATETIME,
    updated_at DATETIME,
    completed_at DATETIME,
    PRIMARY KEY (story_key)
  )`)
  await db.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
    story_key VARCHAR(20) NOT NULL,
    depends_on VARCHAR(20) NOT NULL,
    dep_type VARCHAR(20) NOT NULL,
    source VARCHAR(20) NOT NULL,
    created_at DATETIME,
    PRIMARY KEY (story_key, depends_on)
  )`)
})
```

### Testing Requirements

- `getBlockedStories()` tests: use `InMemoryDatabaseAdapter` — no Dolt process required
- Status command tests: mock `WorkGraphRepository` methods using `vi.mock` or `vi.spyOn` on the prototype; test the formatter output using `vi.spyOn(process.stdout, 'write')`
- All new code must stay above the 80% coverage threshold enforced by vitest config
- Run `npm run test:fast` (not `npm test`) during iteration; confirm "Test Files" appears in output

## Interface Contracts

- **Export**: `BlockedStoryInfo` @ `src/modules/state/work-graph-repository.ts` (re-exported via `src/modules/state/index.ts`)
- **Import**: `WorkGraphRepository`, `BlockedStoryInfo` @ `src/modules/state/index.ts` (defined in story 31-1/31-4)
- **Import**: `DatabaseAdapter` @ `src/persistence/adapter.ts` (already in scope in status.ts)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
