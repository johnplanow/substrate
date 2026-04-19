# Story 53-9: Dispatch Pre-Condition Gating

## Story

As a substrate developer,
I want stories blocked from dispatch when known conflicts exist with completed stories,
so that namespace collisions and dependency ordering issues are prevented rather than diagnosed after the fact.

## Acceptance Criteria

### AC1: Completed-Story File Set Extraction
**Given** a pipeline run with one or more completed stories
**When** the dispatch gate runs before dispatching a pending story
**Then** the set of files modified by each completed story is retrieved from the run manifest, and used as the basis for conflict detection

### AC2: File Overlap Warning (Not Block)
**Given** a pending story whose target files overlap with files modified by a completed story
**When** no namespace or export collision is found in the overlapping files
**Then** a `pipeline:dispatch-warn` event is emitted with `{ storyKey, overlappingFiles, completedStoryKey }` and dispatch proceeds normally

### AC3: Namespace Collision Detection and Block
**Given** a pending story that will create a symbol named `X` (class, interface, or exported identifier)
**When** a completed story's modified file contains `export class X`, `export interface X`, `class X`, or `export const X`
**Then** dispatch is blocked with a reason string: `"namespace-collision: X exists in {file} from story {completedStoryKey}"`

### AC4: Auto-Resolution for Namespace Collisions
**Given** a namespace-collision block on symbol `X`
**When** auto-resolution is attempted by appending the note `"${X} already exists in {file}. Extend the existing implementation instead of creating a new class."` to the story prompt
**Then** the story is dispatched with the modified prompt and the block is lifted

### AC5: Non-Resolvable Conflicts Enter Gated State
**Given** auto-resolution fails (e.g., story content cannot be retrieved or modified), or the conflict type is not `namespace-collision`
**When** the gate cannot proceed with dispatch
**Then** the story's phase is set to `gated` in the run manifest, a `pipeline:story-gated` event is emitted with `{ storyKey, conflictType, reason, completedStoryKey }`, and the story is excluded from future dispatch attempts until operator review

### AC6: Learning Loop Pre-Emption
**Given** a pending story whose target files overlap with files referenced in a high-confidence `namespace-collision` finding persisted in the learning store (by stories 53-5 through 53-7)
**When** no completed-story file overlap exists yet (the finding predates the current run)
**Then** the gate preemptively blocks dispatch, includes the finding's description in the block reason, and triggers auto-resolution using the same path as AC4

### AC7: Non-Fatal Error Handling
**Given** any error during conflict detection (file read failure, DB query failure, malformed finding record)
**When** the error occurs
**Then** it is caught and logged at debug level, and dispatch proceeds as if no conflict was detected (the gate degrades gracefully)

## Tasks / Subtasks

- [ ] Task 1: Define gating module types (AC: #2, #3, #5)
  - [ ] Create `packages/sdlc/src/gating/types.ts` with `ConflictType` (`'namespace-collision' | 'file-overlap' | 'learning-preemption'`), `GateDecision` (`'proceed' | 'warn' | 'block' | 'gated'`), and `GateResult` interface (`{ decision: GateDecision; conflictType?: ConflictType; reason?: string; modifiedPrompt?: string; completedStoryKey?: string; overlappingFiles?: string[] }`)
  - [ ] Add `DispatchGateOptions` interface: `{ storyKey: string; storyContent: string; pendingFiles: string[]; completedStories: Array<{ key: string; modifiedFiles: string[] }>; db: DatabaseAdapter; projectRoot: string }`
  - [ ] Add payload types for two new events: `PipelineDispatchWarnPayload` and `PipelineStoryGatedPayload`

- [ ] Task 2: Implement ConflictDetector (AC: #1, #2, #3)
  - [ ] Create `packages/sdlc/src/gating/conflict-detector.ts` with `ConflictDetector` class
  - [ ] `static extractTargetSymbols(storyContent: string): string[]` — extract identifiers using regex `/(export\s+(?:class|interface|const|function)|class|interface)\s+(\w+)/g`; return unique symbol names only
  - [ ] `static findOverlappingFiles(pendingFiles: string[], completedFiles: string[]): string[]` — return set intersection of the two arrays
  - [ ] `static async detectNamespaceCollision(symbol: string, files: string[], projectRoot: string): Promise<{ file: string; symbol: string } | null>` — reads each file via `node:fs/promises` readFile; searches for `class ${symbol}`, `interface ${symbol}`, `export const ${symbol}`, `export class ${symbol}`; returns first match or null; wraps each file read in try-catch

- [ ] Task 3: Implement DispatchGate (AC: #1, #3, #4, #5, #6, #7)
  - [ ] Create `packages/sdlc/src/gating/dispatch-gate.ts` with `DispatchGate` class
  - [ ] `static async check(options: DispatchGateOptions): Promise<GateResult>` — entry point; outer try-catch wraps entire body and returns `{ decision: 'proceed' }` on any unexpected error (AC7)
  - [ ] Step 1 — Learning pre-emption (AC6): call `getDecisionsByCategory(db, LEARNING_FINDING)`, filter for `root_cause === 'namespace-collision'` and `confidence === 'high'`; if any finding's `affected_files` overlaps with `pendingFiles`, proceed to auto-resolution with that finding's description as the reason
  - [ ] Step 2 — File overlap (AC2): iterate `completedStories`, call `ConflictDetector.findOverlappingFiles()`; if overlap with no collision, prepare warn result
  - [ ] Step 3 — Namespace collision (AC3): call `ConflictDetector.extractTargetSymbols(storyContent)` and `ConflictDetector.detectNamespaceCollision()` for each overlapping file set; if collision found, proceed to auto-resolution
  - [ ] Auto-resolution (AC4): append the extension note to `storyContent` and return `{ decision: 'block', modifiedPrompt: <extended content>, ... }`; if `storyContent` is empty or append fails, return `{ decision: 'gated', ... }` (AC5)
  - [ ] Non-overlap result: return `{ decision: 'proceed' }` if no issues found

- [ ] Task 4: Add `gated` phase to story phase type and register new event types (AC: #5)
  - [ ] Search for the story phase union type (pattern: `'pending' | 'dispatching' | 'completed'`) in `packages/core/src/` and `src/`; add `'gated'` to the union
  - [ ] Search for the pipeline event type definitions file (search for `pipeline:story-complete` declaration); add `'pipeline:dispatch-warn'` with `PipelineDispatchWarnPayload` and `'pipeline:story-gated'` with `PipelineStoryGatedPayload`
  - [ ] Ensure the dispatch queue logic that filters by phase excludes `gated` stories (they must not be re-dispatched automatically)

- [ ] Task 5: Create barrel exports (AC: all)
  - [ ] Create `packages/sdlc/src/gating/index.ts` exporting `DispatchGate`, `ConflictDetector`, and all types from `types.ts`

- [ ] Task 6: Integrate gate into dev-story handler (AC: #2, #3, #4, #5)
  - [ ] Modify `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` to call `DispatchGate.check()` immediately before agent dispatch (place after `FindingsInjector.inject()` from story 53-8, using the same `db` reference)
  - [ ] Build `DispatchGateOptions` from handler context: `storyKey`, `storyContent` (the story file text), `pendingFiles` extracted from story content, `completedStories` from the run manifest (`runManifest.stories` filtered to `phase === 'completed'`), `db`, `projectRoot: process.cwd()`
  - [ ] On `decision === 'warn'`: emit `pipeline:dispatch-warn` event with payload and continue dispatch normally
  - [ ] On `decision === 'block'` (auto-resolved): replace story prompt with `result.modifiedPrompt` and continue dispatch
  - [ ] On `decision === 'gated'`: call run manifest update to set story phase to `gated`, emit `pipeline:story-gated` event, return early without dispatching; wrap in try-catch per AC7
  - [ ] Wrap entire gate call block in try-catch; on any error, log at debug and continue with original dispatch

- [ ] Task 7: Unit tests for ConflictDetector (AC: #1, #2, #3)
  - [ ] Create `packages/sdlc/src/gating/__tests__/conflict-detector.test.ts`
  - [ ] Test `findOverlappingFiles()`: returns intersection of two arrays; handles empty arrays and no-overlap cases
  - [ ] Test `extractTargetSymbols()`: extracts class names, interface names, export const names; ignores comments and string literals; returns unique values only
  - [ ] Test `detectNamespaceCollision()`: mock `node:fs/promises` with `vi.mock()`; test hit case (file contains the symbol), miss case (file does not), and file-read error case (returns null)

- [ ] Task 8: Unit tests for DispatchGate (AC: #3, #4, #5, #6, #7)
  - [ ] Create `packages/sdlc/src/gating/__tests__/dispatch-gate.test.ts`
  - [ ] Test: no overlap → `{ decision: 'proceed' }`
  - [ ] Test: file overlap, no collision → `{ decision: 'warn', overlappingFiles: [...] }`
  - [ ] Test: namespace collision, resolvable → `{ decision: 'block', modifiedPrompt: <string containing extension note> }`
  - [ ] Test: namespace collision, empty storyContent → `{ decision: 'gated', conflictType: 'namespace-collision' }`
  - [ ] Test: learning pre-emption with high-confidence finding → `{ decision: 'block', conflictType: 'learning-preemption' }`
  - [ ] Test: DB throws during learning query → `{ decision: 'proceed' }` (AC7 non-fatal)
  - [ ] Mock `DatabaseAdapter` as `{ query: vi.fn(), exec: vi.fn() } as unknown as DatabaseAdapter` and `getDecisionsByCategory` via `vi.mock('@substrate-ai/core', ...)`

## Dev Notes

### Architecture Constraints
- All DB and file I/O in `DispatchGate.check()` MUST be wrapped in try-catch — gate failures must never block the pipeline; the outer catch returns `{ decision: 'proceed' }` unconditionally (AC7)
- Use `node:fs/promises` (not sync) for file reads in `detectNamespaceCollision`; wrap each file read in its own try-catch
- Symbol extraction from story content uses regex only (no AST): primary pattern `/(export\s+(?:class|interface|const|function)|(?:^|\s)class|(?:^|\s)interface)\s+(\w+)/gm`
- The `gated` phase must be added to the same union type used by the dispatch queue filter — verify existing stories by searching for `'pending' | 'dispatching'` pattern in the codebase
- Import `getDecisionsByCategory`, `LEARNING_FINDING` from `@substrate-ai/core` for learning store queries (same pattern used in `packages/sdlc/src/learning/finding-lifecycle.ts`)
- Import `FindingSchema` from `../learning/types.js` to safely parse raw DB rows before accessing `root_cause` and `affected_files`
- All local imports within the sdlc package use relative paths with `.js` extension (ESM)
- The `completedStories` list comes from the run manifest populated by Epic 52; the handler must pass `runManifest.stories.filter(s => s.phase === 'completed')` through to `DispatchGateOptions`
- The gate call is placed **after** `FindingsInjector.inject()` (from story 53-8) but **before** agent dispatch — the injection adds context, the gate may modify or halt the prompt

### Key File Paths

**New files:**
- `packages/sdlc/src/gating/types.ts`
- `packages/sdlc/src/gating/conflict-detector.ts`
- `packages/sdlc/src/gating/dispatch-gate.ts`
- `packages/sdlc/src/gating/index.ts`
- `packages/sdlc/src/gating/__tests__/conflict-detector.test.ts`
- `packages/sdlc/src/gating/__tests__/dispatch-gate.test.ts`

**Modified files:**
- `packages/sdlc/src/handlers/sdlc-dev-story-handler.ts` — pre-dispatch gate integration
- Story phase type definition (search for `'pending' | 'dispatching'` union) — add `'gated'`
- Pipeline event types file (search for `pipeline:story-complete` declaration) — add `pipeline:dispatch-warn` and `pipeline:story-gated`

### Testing Requirements
- Test framework: Vitest with `vi.mock()` for module mocking
- Mock `node:fs/promises` for file reads in `conflict-detector.test.ts`
- Mock `DatabaseAdapter` following the established pattern: `{ query: vi.fn(), exec: vi.fn(), close: vi.fn() } as unknown as DatabaseAdapter`
- Mock `@substrate-ai/core` exports (`getDecisionsByCategory`, `LEARNING_FINDING`) in dispatch-gate tests
- Do NOT call real DB or real file system in unit tests
- Run `npm run test:fast` during iteration; `npm test` before finalizing

### Related Story Context
- **53-5** (complete): `RootCauseCategory` includes `'namespace-collision'`; `FindingSchema` at `packages/sdlc/src/learning/types.ts` — use `FindingSchema.safeParse()` when reading raw DB rows
- **53-6** (complete): `extractTargetFilesFromStoryContent()` at `packages/sdlc/src/learning/findings-injector.ts` — use this same utility to populate `pendingFiles` in `DispatchGateOptions`
- **53-7** (complete): `getDecisionsByCategory(db, LEARNING_FINDING)` returns all learning findings — filter for `root_cause === 'namespace-collision'` and `confidence === 'high'` for AC6
- **53-8** (complete): Established the pre-dispatch hook position in `sdlc-dev-story-handler.ts` — the gate call goes in the same region, immediately after `FindingsInjector.inject()`
- **Epic 52** (complete): Run manifest stores per-story state including `modifiedFiles` for completed stories; gate reads from `runManifest.stories`

## Interface Contracts

- **Export**: `DispatchGate`, `ConflictDetector`, `GateResult`, `GateDecision`, `ConflictType`, `DispatchGateOptions` @ `packages/sdlc/src/gating/index.ts` (consumed by dev-story handler and future Epic 54 Recovery Engine stories)
- **Export**: `pipeline:dispatch-warn` event type @ pipeline event types definition file (consumed by observability and Epic 54)
- **Export**: `pipeline:story-gated` event type @ pipeline event types definition file (consumed by Epic 54 Recovery Engine for operator review queue)
- **Import**: `getDecisionsByCategory`, `LEARNING_FINDING` @ `@substrate-ai/core` (from Epic 43/44 decisions infrastructure)
- **Import**: `FindingSchema` @ `packages/sdlc/src/learning/types.ts` (from story 53-5)
- **Import**: `extractTargetFilesFromStoryContent` @ `packages/sdlc/src/learning/findings-injector.ts` (from story 53-6)
- **Import**: Story phase type union @ (search `'pending' | 'dispatching'`) — modified to include `'gated'` by this story

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
