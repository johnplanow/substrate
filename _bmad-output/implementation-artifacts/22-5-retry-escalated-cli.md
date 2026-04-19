# Story 22-5: `substrate retry-escalated` CLI Command

Status: review

## Story

As a pipeline agent managing implementation runs,
I want a `substrate retry-escalated` command that automatically selects and reruns escalated stories the diagnosis flagged as retry-targeted,
so that I can recover failed stories without manually identifying them or re-running the entire pipeline.

## Acceptance Criteria

### AC1: Retryable Story Discovery
**Given** a pipeline run containing escalation-diagnosis decisions in the decision store
**When** `substrate retry-escalated` is invoked (without `--run-id`, defaulting to the latest run with escalations)
**Then** the command queries `decisions WHERE category = 'escalation-diagnosis'` and returns only story keys whose JSON `value.recommendedAction === 'retry-targeted'`

### AC2: Non-Retryable Stories Are Excluded
**Given** escalated stories whose diagnosis has `recommendedAction = 'human-intervention'` or `recommendedAction = 'split-story'`
**When** `substrate retry-escalated` is invoked
**Then** those stories are excluded from the retry run and listed in the output as "skipped (needs human review)" or "skipped (split story)" respectively

### AC3: Dry-Run Mode
**Given** the `--dry-run` flag is passed
**When** `substrate retry-escalated --dry-run` is invoked
**Then** the command prints the list of retryable story keys (and skipped stories with reasons) without invoking the orchestrator, and exits 0

### AC4: No Retryable Stories Case
**Given** no escalation-diagnosis decisions exist, or all escalated stories have non-retryable actions
**When** `substrate retry-escalated` is invoked
**Then** the command outputs a clear message (`No retry-targeted escalations found.`) and exits 0 without error

### AC5: Run-ID Scoping
**Given** the `--run-id <id>` flag is provided
**When** `substrate retry-escalated --run-id <id>` is invoked
**Then** only escalation-diagnosis decisions whose key contains `:<id>` (key format: `{storyKey}:{runId}`) are queried, scoping the retry to that specific run

### AC6: Orchestrator Invocation with Retryable Keys
**Given** one or more retry-targeted story keys are discovered
**When** `substrate retry-escalated` is invoked without `--dry-run`
**Then** the implementation orchestrator is invoked with exactly those story keys using the same setup as `substrate run --stories <keys>`, and the exit code reflects the orchestrator outcome

### AC7: JSON Output Format
**Given** `--output-format json` is passed
**When** `substrate retry-escalated` runs in any mode (dry-run or live)
**Then** all output follows the standard `{ success: boolean, data: {...}, error?: string }` envelope written to stdout, with `data` containing `{ retryKeys: string[], skippedKeys: { key: string, reason: string }[] }`

## Tasks / Subtasks

- [x] Task 1: Implement `getRetryableEscalations(db, runId?)` query function (AC: #1, #2, #5)
  - [x] Create `src/persistence/queries/retry-escalated.ts`
  - [x] Query `decisions WHERE category = 'escalation-diagnosis'`, JSON-parse each `value`
  - [x] Split key on first `:` to extract `storyKey` and `runId`; filter by `runId` when provided
  - [x] Return `{ retryable: string[], skipped: { key: string, reason: string }[] }` based on `recommendedAction`
  - [x] Export from `src/persistence/queries/retry-escalated.ts`; write corresponding unit tests in `src/persistence/queries/__tests__/retry-escalated.test.ts`

- [x] Task 2: Create `src/cli/commands/retry-escalated.ts` with action function (AC: #1, #2, #4, #6)
  - [x] Import `getRetryableEscalations` from persistence layer
  - [x] Open DB with `DatabaseWrapper` + `resolveMainRepoRoot` (same pattern as `status.ts`)
  - [x] Call `getRetryableEscalations(db, runId)` to get retryable/skipped lists
  - [x] Handle empty result: output `No retry-targeted escalations found.` and return 0

- [x] Task 3: Implement `--dry-run` and human-readable output (AC: #3, #4, #7)
  - [x] When `--dry-run`: print retryable keys and skipped keys with reasons; return 0 without invoking orchestrator
  - [x] When `--output-format json` in dry-run: write JSON envelope with `retryKeys` + `skippedKeys`
  - [x] When human format: write `Retrying: X story/stories — <keys>` and `Skipping: <key> (<reason>)` lines

- [x] Task 4: Wire orchestrator invocation for live retry (AC: #6)
  - [x] Reuse orchestrator setup boilerplate from `run.ts`: `createEventBus`, `AdapterRegistry`, `createDispatcher`, `createContextCompiler`, `createImplementationOrchestrator`
  - [x] Pass retryable keys to `orchestrator.run(retryableKeys)`
  - [x] Create a new `pipeline_runs` row via `createPipelineRun` with `start_phase = 'implementation'`
  - [x] Wire `orchestrator:story-complete` / `orchestrator:story-escalated` event logging to stdout (human mode)

- [x] Task 5: Register command in CLI index (AC: #1)
  - [x] Add `import { registerRetryEscalatedCommand } from './commands/retry-escalated.js'` to `src/cli/index.ts`
  - [x] Call `registerRetryEscalatedCommand(program, version)` in `createProgram()`

- [x] Task 6: Commander registration + option wiring (AC: #3, #5, #7)
  - [x] `.command('retry-escalated').description('Retry escalated stories flagged as retry-targeted by escalation diagnosis')`
  - [x] Options: `--run-id <id>`, `--dry-run`, `--concurrency <n>` (default 3), `--pack <name>` (default `bmad`), `--project-root <path>`, `--output-format <format>`
  - [x] Export `registerRetryEscalatedCommand(program, version, projectRoot)` following the pattern in `resume.ts`

- [x] Task 7: Write CLI-level tests (AC: #1–#7)
  - [x] Create `src/cli/commands/__tests__/retry-escalated.test.ts`
  - [x] Mock `DatabaseWrapper`, `getRetryableEscalations`, and `createImplementationOrchestrator`
  - [x] Test: returns retryable keys from escalation-diagnosis decisions
  - [x] Test: excludes `human-intervention` and `split-story` stories with correct skip reasons
  - [x] Test: `--dry-run` exits 0 and does not invoke orchestrator
  - [x] Test: no retryable escalations → message + exit 0
  - [x] Test: `--run-id` scopes query to that run
  - [x] Test: `--output-format json` produces valid JSON envelope

## Dev Notes

### Architecture Constraints
- **Modular Monolith (ADR-001)**: CLI is a thin wiring layer. All query logic lives in the persistence layer (`src/persistence/queries/retry-escalated.ts`), not in the command file.
- **SQLite WAL (ADR-003)**: Use `DatabaseWrapper` for all DB access; never open `better-sqlite3` directly.
- **Import style**: `.js` extension on all local imports (ESM). E.g., `import { getRetryableEscalations } from '../../persistence/queries/retry-escalated.js'`
- **Test framework**: vitest (not jest). Use `vi.mock(...)`, `vi.fn()`, `describe`/`it`/`expect`.
- **File paths**:
  - `src/persistence/queries/retry-escalated.ts` — query function
  - `src/persistence/queries/__tests__/retry-escalated.test.ts` — query unit tests
  - `src/cli/commands/retry-escalated.ts` — CLI command
  - `src/cli/commands/__tests__/retry-escalated.test.ts` — CLI tests
  - `src/cli/index.ts` — registration (import + call)

### Key Data Shapes

**Escalation-diagnosis decision row** (from `decisions` table):
```
category: 'escalation-diagnosis'
key:      '{storyKey}:{runId}'   e.g. '22-3:abc-123'
value:    JSON string of EscalationDiagnosis (see src/modules/implementation-orchestrator/escalation-diagnosis.ts)
```

**EscalationDiagnosis.recommendedAction** values:
- `'retry-targeted'` → include in retry
- `'human-intervention'` → skip, reason = "needs human review"
- `'split-story'` → skip, reason = "story should be split"

### Query Pattern
Use the existing `getDecisionsByCategory(db, ESCALATION_DIAGNOSIS)` from `src/persistence/queries/decisions.ts` and `ESCALATION_DIAGNOSIS` constant from `src/persistence/schemas/operational.ts`. This avoids a raw SQL query.

To find the "latest run with escalations" when no `--run-id` is provided: take the newest `runId` extracted from the decision keys (sort by `rowid DESC` or by the `runId` string if it contains a timestamp).

### Orchestrator Reuse Pattern
Copy the orchestrator wiring block from `run.ts` lines ~400-455:
```typescript
const eventBus = createEventBus()
const contextCompiler = createContextCompiler({ db })
const adapterRegistry = new AdapterRegistry()
await adapterRegistry.discoverAndRegister()
const dispatcher = createDispatcher({ eventBus, adapterRegistry })
const orchestrator = createImplementationOrchestrator({ db, pack, contextCompiler, dispatcher, eventBus, config: { maxConcurrency: concurrency, maxReviewCycles: 2, pipelineRunId: run.id }, projectRoot })
await orchestrator.run(retryableKeys)
```

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest). Mock DB and orchestrator to avoid SQLite in unit tests.
- Mock `better-sqlite3` via `vi.mock('better-sqlite3', ...)` or mock `DatabaseWrapper` at the module level.
- Use `vi.mock('../../modules/implementation-orchestrator/index.js', ...)` to stub `createImplementationOrchestrator`.
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
