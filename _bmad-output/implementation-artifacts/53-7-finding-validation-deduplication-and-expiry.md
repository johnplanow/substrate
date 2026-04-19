# Story 53-7: Finding Validation, Deduplication, and Expiry

## Story

As a substrate developer,
I want findings validated before injection, deduplicated across runs, and expired after N runs,
so that the learning loop doesn't poison prompts with stale or incorrect advice.

## Acceptance Criteria

### AC1: File Existence Validation — Demote or Skip
**Given** a `Finding` with a non-empty `affected_files` array
**When** `FindingLifecycleManager.validateFiles(finding, projectRoot)` is called
**Then** it checks each path in `affected_files` using `fs.existsSync(path.join(projectRoot, affectedFile))`
**And** if all affected files are missing, the finding is returned with `confidence: 'low'` and `contradicted_by: 'all-files-deleted'`
**And** if some but not all files are missing, the finding is returned with `confidence: 'low'` (and `contradicted_by` unchanged)
**And** if all files exist, or `affected_files` is empty, the finding is returned unchanged

### AC2: Deduplication by Root Cause + File Fingerprint
**Given** a list of `Finding` objects
**When** `FindingLifecycleManager.deduplicate(findings)` is called
**Then** findings are grouped by the fingerprint `${root_cause}:${affected_files.sort().join(',')}`
**And** for each group of duplicates, only the most recently created finding (highest `created_at` lexicographically) is retained
**And** the returned list contains at most one finding per fingerprint
**And** findings with unique fingerprints are always retained unchanged

### AC3: Expiry Check via Run Count
**Given** a `Finding` with `expires_after_runs: 5` (or a custom value) and a `DatabaseAdapter`
**When** `FindingLifecycleManager.countRunsSinceCreation(finding, db)` is called
**Then** it queries the decisions table for the count of distinct `pipeline_run_id` values where `created_at > finding.created_at AND pipeline_run_id != finding.run_id`
**And** `FindingLifecycleManager.isExpired(finding, runCount)` returns `true` when `runCount >= finding.expires_after_runs`
**And** returns `false` when `runCount < finding.expires_after_runs`
**And** if the DB query throws, `countRunsSinceCreation` returns `0` (non-fatal, never marks as expired on error)

### AC4: Expired Findings Are Excluded and Archived in Dolt
**Given** a finding determined to be expired (`countRunsSinceCreation >= finding.expires_after_runs`)
**When** `FindingLifecycleManager.archiveFinding(finding, currentRunId, db)` is called
**Then** it calls `createDecision(db, { category: LEARNING_FINDING, key: \`\${finding.id}:archived\`, pipeline_run_id: currentRunId, phase: 'implementation', value: JSON.stringify({ ...finding, contradicted_by: 'expired' }) })` to persist a tombstone record
**And** the archive write is non-fatal — any DB error is swallowed silently
**And** expired findings are excluded from the injection candidate set

### AC5: Contradiction Retirement on Story Success
**Given** a story that completes successfully with a known set of modified files (`successContext.modifiedFiles`) and the winning run ID (`successContext.runId`)
**When** `FindingLifecycleManager.retireContradictedFindings(successContext, db)` is called
**Then** it loads all findings from Dolt via `getDecisionsByCategory(db, LEARNING_FINDING)`
**And** for each finding whose `affected_files` has at least one path overlapping `successContext.modifiedFiles` AND whose `contradicted_by` is currently `undefined`
**Then** it calls `createDecision` to persist a tombstone with `key: \`\${finding.id}:archived\`` and `value: JSON.stringify({ ...finding, contradicted_by: successContext.runId })`
**And** the entire function is non-fatal — DB errors or parse failures are swallowed silently

### AC6: FindingsInjector.inject Runs Lifecycle Pipeline Before Scoring
**Given** findings loaded from Dolt in `FindingsInjector.inject`
**When** the lifecycle preprocessing pipeline runs (after loading, before scoring)
**Then** the pipeline executes in this exact order: (1) `deduplicate(parsed findings)`, (2) filter out findings where `contradicted_by !== undefined`, (3) for each remaining finding: `validateFiles(finding, process.cwd())`, (4) for each surviving finding: call `countRunsSinceCreation(finding, db)` and if expired call `archiveFinding` and exclude from the set
**And** all lifecycle operations are wrapped in individual try/catch — a single finding's validation error does not abort the pipeline
**And** lifecycle errors produce no additional log output (fail silently, include the finding unchanged)

### AC7: Unit Tests Cover All Lifecycle Operations
**Given** the test suite at `packages/sdlc/src/learning/__tests__/finding-lifecycle.test.ts`
**When** `npm run test:fast` is executed
**Then** `validateFiles` tests cover: all files exist (finding returned unchanged), some missing (confidence demoted to `'low'`), all missing (confidence `'low'` + `contradicted_by: 'all-files-deleted'`), empty `affected_files` (unchanged)
**And** `deduplicate` tests cover: empty list returns `[]`, single finding returned as-is, two findings with identical fingerprint → only most-recent kept, three findings with two matching + one unique → two unique findings returned
**And** `isExpired` tests cover: count `0` → `false`, count `4` with `expires_after_runs: 5` → `false`, count `5` → `true`, count `10` → `true`, custom `expires_after_runs: 2` with count `2` → `true`
**And** `countRunsSinceCreation` test: mock DB returns `2` distinct run_ids → function returns `2`; DB throws → returns `0`
**And** integration test: `FindingsInjector.inject` with one finding that has `contradicted_by: 'some-run'` already set → finding excluded, returns `''`

## Tasks / Subtasks

- [ ] Task 1: Create `FindingLifecycleManager` class in `packages/sdlc/src/learning/finding-lifecycle.ts` (AC: #1, #2)
  - [ ] Export `SuccessContext` interface: `{ modifiedFiles: string[]; runId: string }`
  - [ ] Export `FindingLifecycleManager` class with all static methods
  - [ ] Implement `static validateFiles(finding: Finding, projectRoot: string): Finding`:
    - Import `fs` from `'node:fs'` and `path` from `'node:path'`
    - If `finding.affected_files.length === 0`, return `finding` unchanged
    - Compute `existingCount = finding.affected_files.filter(f => fs.existsSync(path.join(projectRoot, f))).length`
    - If `existingCount === 0`: return `{ ...finding, confidence: 'low', contradicted_by: 'all-files-deleted' }`
    - If `existingCount < finding.affected_files.length`: return `{ ...finding, confidence: 'low' }`
    - Else: return `finding` unchanged
  - [ ] Implement `static deduplicate(findings: Finding[]): Finding[]`:
    - Fingerprint = `${f.root_cause}:${[...f.affected_files].sort().join(',')}`
    - Group into a `Map<string, Finding[]>` by fingerprint
    - For each group: keep the one with maximum `created_at` (lexicographic comparison works for ISO strings)
    - Return one finding per fingerprint, preserving input order for non-duplicates
  - [ ] Imports: `Finding` from `./types.js`

- [ ] Task 2: Implement expiry methods in `FindingLifecycleManager` (AC: #3, #4)
  - [ ] Implement `static async countRunsSinceCreation(finding: Finding, db: DatabaseAdapter): Promise<number>`:
    - Execute: `db.query('SELECT COUNT(DISTINCT pipeline_run_id) AS cnt FROM decisions WHERE created_at > ? AND pipeline_run_id != ?', [finding.created_at, finding.run_id])`
    - Parse result: `Number(rows[0]?.cnt ?? 0)`
    - Wrap entire body in `try/catch` — on any error return `0`
  - [ ] Implement `static isExpired(finding: Finding, runCount: number): boolean`:
    - Return `runCount >= finding.expires_after_runs`
  - [ ] Implement `static async archiveFinding(finding: Finding, currentRunId: string, db: DatabaseAdapter): Promise<void>`:
    - Call `createDecision(db, { category: LEARNING_FINDING, key: \`\${finding.id}:archived\`, pipeline_run_id: currentRunId, phase: 'implementation', value: JSON.stringify({ ...finding, contradicted_by: 'expired' }) })`
    - Wrap in `try/catch` — DB errors are swallowed silently (non-fatal)
  - [ ] Imports: `DatabaseAdapter` from `@substrate-ai/core`; `createDecision` from `@substrate-ai/core`; `LEARNING_FINDING` from `@substrate-ai/core`

- [ ] Task 3: Implement `retireContradictedFindings` in `FindingLifecycleManager` (AC: #5)
  - [ ] Implement `static async retireContradictedFindings(successContext: SuccessContext, db: DatabaseAdapter): Promise<void>`:
    - Wrap entire body in `try/catch` — on any error return silently
    - Call `getDecisionsByCategory(db, LEARNING_FINDING)` to load all findings
    - For each row: attempt `FindingSchema.safeParse(JSON.parse(row.value))` — skip rows where `safeParse.success === false` or `JSON.parse` throws
    - Check overlap: `finding.contradicted_by === undefined && finding.affected_files.some(f => successContext.modifiedFiles.includes(f))`
    - For each overlapping finding, call `createDecision(db, { category: LEARNING_FINDING, key: \`\${finding.id}:archived\`, pipeline_run_id: successContext.runId, phase: 'implementation', value: JSON.stringify({ ...finding, contradicted_by: successContext.runId }) })` — each write wrapped in individual try/catch (silent)
  - [ ] Imports: `getDecisionsByCategory` from `@substrate-ai/core`; `FindingSchema` from `./types.js`

- [ ] Task 4: Integrate lifecycle pipeline into `FindingsInjector.inject` in `packages/sdlc/src/learning/findings-injector.ts` (AC: #6)
  - [ ] After parsing valid findings (Step 3 in the existing `inject` implementation from story 53-6), insert the lifecycle preprocessing block before scoring:
    ```typescript
    // Story 53-7: Lifecycle preprocessing — dedup, file validation, expiry, contradiction filter
    let lifecycleFindings = FindingLifecycleManager.deduplicate(validFindings)
    lifecycleFindings = lifecycleFindings.filter(f => f.contradicted_by === undefined)
    const projectRoot = process.cwd()
    lifecycleFindings = lifecycleFindings.map(f => {
      try { return FindingLifecycleManager.validateFiles(f, projectRoot) } catch { return f }
    })
    for (const f of [...lifecycleFindings]) {
      try {
        const runCount = await FindingLifecycleManager.countRunsSinceCreation(f, db)
        if (FindingLifecycleManager.isExpired(f, runCount)) {
          await FindingLifecycleManager.archiveFinding(f, context.runId, db)
          lifecycleFindings = lifecycleFindings.filter(lf => lf.id !== f.id)
        }
      } catch { /* non-fatal */ }
    }
    const candidates = lifecycleFindings
    ```
  - [ ] Replace the subsequent `validFindings` reference (used as the input to `scoreRelevance`) with `candidates`
  - [ ] Add `import { FindingLifecycleManager } from './finding-lifecycle.js'` to the file's imports
  - [ ] All other `FindingsInjector.inject` logic (saturation guard, serialization, budget enforcement) remains unchanged

- [ ] Task 5: Update barrel exports in `packages/sdlc/src/learning/index.ts` (AC: #1, #5)
  - [ ] Add `export * from './finding-lifecycle.js'` to the barrel
  - [ ] If the barrel doesn't yet exist (story 53-5 or 53-6 not yet shipped), create it with all upstream learning exports plus this one, and wire `packages/sdlc/src/index.ts` accordingly

- [ ] Task 6: Write unit tests for `validateFiles` and `deduplicate` (AC: #7)
  - [ ] Create `packages/sdlc/src/learning/__tests__/finding-lifecycle.test.ts` using Vitest
  - [ ] Mock `fs.existsSync` via `vi.mock('node:fs')` returning configurable values per test
  - [ ] `validateFiles` test cases:
    - All files exist → finding returned unchanged (`confidence` and `contradicted_by` unmodified)
    - `affected_files: []` → finding returned unchanged
    - One of two files missing → `confidence: 'low'`, `contradicted_by` unchanged
    - Both files missing → `confidence: 'low'`, `contradicted_by: 'all-files-deleted'`
    - Already `confidence: 'low'` from before → remains `'low'` (no regression)
  - [ ] `deduplicate` test cases:
    - `deduplicate([])` → `[]`
    - Single finding → returned as-is
    - Two findings same fingerprint, older created_at first → only newer kept
    - Two findings same fingerprint, newer created_at first → only newer kept
    - Three findings: two share fingerprint, one unique → two findings returned
    - Order independence: `affected_files: ['b.ts', 'a.ts']` vs `['a.ts', 'b.ts']` with same `root_cause` → treated as duplicates

- [ ] Task 7: Write unit tests for expiry, count, and injection integration (AC: #7)
  - [ ] Continue in `packages/sdlc/src/learning/__tests__/finding-lifecycle.test.ts`:
  - [ ] `isExpired` test cases:
    - `isExpired(findingWithExpiry5, 0)` → `false`
    - `isExpired(findingWithExpiry5, 4)` → `false`
    - `isExpired(findingWithExpiry5, 5)` → `true`
    - `isExpired(findingWithExpiry5, 10)` → `true`
    - `isExpired({ ...finding, expires_after_runs: 2 }, 2)` → `true`
    - `isExpired({ ...finding, expires_after_runs: 2 }, 1)` → `false`
  - [ ] `countRunsSinceCreation` test cases:
    - Mock DB returns `[{ cnt: '2' }]` → function returns `2`
    - Mock DB returns `[{ cnt: 0 }]` → returns `0`
    - Mock DB `.query` throws `new Error('DB error')` → returns `0` (non-fatal)
  - [ ] Integration test for `FindingsInjector.inject` filtering `contradicted_by`:
    - Build a finding with `contradicted_by: 'some-prior-run'`; mock DB to return it; call `inject(db, context)` → returns `''` (finding excluded before scoring)
    - Build a finding with `contradicted_by: undefined` and high score → included in output

## Dev Notes

### Architecture Constraints
- All new code lives in `packages/sdlc/src/learning/` — this directory is created by story 53-5
- Import style: `.js` extension on all local ESM imports (e.g., `import { ... } from './types.js'`)
- `validateFiles` is a **pure synchronous function** — uses `fs.existsSync` which is sync; no async, no LLM calls
- `deduplicate` is a **pure synchronous function** — no I/O
- `isExpired` is a **pure synchronous function** — no I/O
- `countRunsSinceCreation`, `archiveFinding`, and `retireContradictedFindings` are **async** — they interact with the DB
- All DB interactions are non-fatal: wrap in try/catch and return safe defaults (`0`, `void`) on error
- `process.cwd()` is used as `projectRoot` default in `inject` — this matches substrate's convention for the target project root
- The `contradicted_by` field on `Finding` acts as a tombstone marker — any finding with `contradicted_by` set is excluded from injection (whether it was retired by success or expired). This is the canonical filtering rule.
- Do NOT delete or modify `getProjectFindings` in `src/modules/implementation-orchestrator/project-findings.ts` — only the `FindingsInjector` integration is changed

### Key File Paths
- **New:** `packages/sdlc/src/learning/finding-lifecycle.ts` — `FindingLifecycleManager`, `SuccessContext`
- **New:** `packages/sdlc/src/learning/__tests__/finding-lifecycle.test.ts`
- **Modify:** `packages/sdlc/src/learning/findings-injector.ts` — add lifecycle preprocessing block in `inject` (story 53-6 file)
- **Modify:** `packages/sdlc/src/learning/index.ts` — add `export * from './finding-lifecycle.js'`

### Lifecycle Pipeline Integration (Canonical Pattern)
The lifecycle block inserts between "parse rows" (Step 3 of the existing `inject`) and "score findings":

```typescript
// === Story 53-7: Lifecycle preprocessing ===
// Step 3a: Deduplicate by root_cause + files fingerprint
let candidates = FindingLifecycleManager.deduplicate(validFindings)
// Step 3b: Exclude tombstoned (contradicted/archived) findings
candidates = candidates.filter(f => f.contradicted_by === undefined)
// Step 3c: File existence validation (demote if missing)
const projectRoot = process.cwd()
candidates = candidates.map(f => {
  try { return FindingLifecycleManager.validateFiles(f, projectRoot) } catch { return f }
})
// Step 3d: Expiry check — archive and exclude expired findings
const survivingCandidates: typeof candidates = []
for (const f of candidates) {
  try {
    const runCount = await FindingLifecycleManager.countRunsSinceCreation(f, db)
    if (FindingLifecycleManager.isExpired(f, runCount)) {
      await FindingLifecycleManager.archiveFinding(f, context.runId, db)
      continue // excluded from injection
    }
  } catch { /* non-fatal: include the finding */ }
  survivingCandidates.push(f)
}
const scoredInput = survivingCandidates
// === End lifecycle preprocessing ===
```

Replace `validFindings` with `scoredInput` in the subsequent `.map(f => ({ finding: f, score: scoreRelevance(f, context) }))` call.

### `countRunsSinceCreation` Query Pattern
```typescript
static async countRunsSinceCreation(finding: Finding, db: DatabaseAdapter): Promise<number> {
  try {
    const result = await db.query(
      `SELECT COUNT(DISTINCT pipeline_run_id) AS cnt
       FROM decisions
       WHERE created_at > ? AND pipeline_run_id != ?`,
      [finding.created_at, finding.run_id]
    )
    return Number(result.rows[0]?.cnt ?? 0)
  } catch {
    return 0
  }
}
```

Note: the `db.query` interface is `(sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>`. Verify this signature against `DatabaseAdapter` in `packages/core/src/persistence/adapter.ts` before implementing.

### Archive Key Convention
Tombstone records use key `${finding.id}:archived` (not the original `${story_key}:${run_id}` key). This avoids key collision with the original finding record and allows both records to coexist in the decisions table. The injector filters by `contradicted_by` at parse time, so having two rows for the same finding is safe — the lifecycle block filters `contradicted_by !== undefined` before scoring, ensuring neither the original nor the tombstone reaches injection if the tombstone is loaded.

However, if `createDecision` uses `INSERT OR REPLACE` / `UPSERT` behavior (check the implementation), you may want to use the original key `${finding.story_key}:${finding.run_id}` for the archive write to avoid table bloat. Use whichever key avoids duplicate injection — verify by checking how `getDecisionsByCategory` returns rows and whether it de-dupes by key.

### Testing Requirements
- Framework: Vitest — `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- Mock `node:fs` for `validateFiles` tests: `vi.mock('node:fs', () => ({ existsSync: vi.fn() }))`; configure return value per test via `(fs.existsSync as vi.Mock).mockReturnValue(true/false)`
- `deduplicate` and `isExpired` are pure functions — no mocks needed
- `countRunsSinceCreation` tests: mock `DatabaseAdapter` as `{ query: vi.fn() }` with pre-configured resolved values
- Build a reusable `makeFinding(overrides?: Partial<Finding>): Finding` helper in the test file to reduce boilerplate
- All new test files go in `packages/sdlc/src/learning/__tests__/`

### Import Verification for @substrate-ai/core
Before writing `finding-lifecycle.ts`, verify these are exported from `@substrate-ai/core`:
- `createDecision` — check `packages/core/src/index.ts` re-exports from `./persistence/queries/decisions.js`
- `getDecisionsByCategory` — same export chain
- `LEARNING_FINDING` — added by story 53-5 to `packages/core/src/persistence/schemas/operational.ts`
- `DatabaseAdapter` — check `packages/core/src/index.ts` re-exports from `./persistence/adapter.js`

If `countRunsSinceCreation` needs a raw SQL query not covered by an existing `@substrate-ai/core` helper, use `db.query(sql, params)` directly (the `DatabaseAdapter` `query` method is the lowest-level escape hatch).

## Interface Contracts

- **Import**: `Finding`, `FindingSchema`, `RootCauseCategory` @ `packages/sdlc/src/learning/types.ts` (from story 53-5)
- **Import**: `LEARNING_FINDING` @ `packages/core/src/persistence/schemas/operational.ts` (from story 53-5)
- **Import**: `createDecision`, `getDecisionsByCategory`, `DatabaseAdapter` @ `@substrate-ai/core` (existing)
- **Import**: `InjectionContext`, `scoreRelevance` @ `packages/sdlc/src/learning/relevance-scorer.ts` (from story 53-6)
- **Import**: `FindingsInjector`, `FindingsInjectorConfig` @ `packages/sdlc/src/learning/findings-injector.ts` (from story 53-6, modified by this story)
- **Export**: `FindingLifecycleManager` @ `packages/sdlc/src/learning/finding-lifecycle.ts` (consumed by story 53-9 dispatch gate for contradiction checking, and Epic 54 RecoveryEngine for retirement on recovery success)
- **Export**: `SuccessContext` @ `packages/sdlc/src/learning/finding-lifecycle.ts` (consumed by Epic 54 orchestrator integration when wiring `retireContradictedFindings` to story success callback)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations)
