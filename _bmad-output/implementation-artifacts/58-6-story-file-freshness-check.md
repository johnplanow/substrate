# Story 58-6: Story-file freshness check against source epic

## Story

As a pipeline operator,
I want substrate to detect when an existing story artifact is stale relative to the source epic,
so that edits to `epics.md` trigger a fresh create-story run instead of silently reusing a pre-fix artifact indefinitely.

## Acceptance Criteria

### AC1: `hashSourceAcSection` helper
New exported helper in `src/modules/compiled-workflows/create-story.ts`:
`hashSourceAcSection(section: string): string` — returns a hex SHA-256 of the trimmed section bytes. Pure function; no I/O.

### AC2: Orchestrator freshness check in reuse path
Orchestrator reuse path in `src/modules/implementation-orchestrator/orchestrator-impl.ts` (around line 1477-1505): after `isValidStoryFile` passes, additionally:
- Call the existing `findEpicsFile` + `extractStorySection` helpers to obtain the current source AC section for the story (uses 58-5's separator normalization)
- If source section is available: compute the current hash; read the existing artifact; look for the literal substring `<!-- source-ac-hash: ` followed by hex chars through `-->`
- If stored hash differs from current OR is absent from the artifact: set `storyFilePath = undefined` so the create-story dispatch fires; emit `eventBus.emit('story:ac-source-drift', { storyKey, storedHash, currentHash })`; log an info line
- If hashes match: reuse as today (backwards-compatible for BMAD-authored artifacts that carry the current hash, and for stories with no source epic section)

### AC3: Prompt update to emit hash comment
`packs/bmad/prompts/create-story.md` gains an instruction: after rendering the AC section verbatim per Story 58-1, emit an HTML comment `<!-- source-ac-hash: <hex> -->` on its own line immediately after the `## Acceptance Criteria` heading. The hash is provided in the prompt context as `{{source_ac_hash}}`.

### AC4: `story:ac-source-drift` event declaration
`OrchestratorEvents` in `src/core/event-bus.types.ts` declares the new `story:ac-source-drift` event with payload `{ storyKey: string; storedHash: string | null; currentHash: string }`.

### AC5: Hash helper unit tests
Unit tests: the hash helper is stable (same input → same output), minor whitespace normalization (trimmed, trailing-whitespace stripped per line) so trivial editor noise does not trigger regen.

### AC6: Integration tests for drift / no-drift / legacy cases
Integration test: dispatch a story where the existing artifact has hash `A`, current source hashes to `B` → assert create-story IS invoked. Converse case (hashes match) → assert create-story is skipped. Legacy case (no hash in existing artifact) → assert create-story IS invoked (treats absent hash as drift, forcing a one-time regen on the first upgrade).

### AC7: No regression to BMAD auto-implement flow
No regression to BMAD auto-implement flow: when the source epic isn't findable (no epics.md), the reuse path stays as today — any valid artifact is accepted.

## Tasks / Subtasks

- [ ] Task 1: Add `hashSourceAcSection` export and event declaration (AC1, AC4)
  - [ ] Subtask 1a: In `src/modules/compiled-workflows/create-story.ts`, add `import { createHash } from 'crypto'` (Node built-in, no new deps). Implement and export `hashSourceAcSection(section: string): string` — trims the input, strips trailing whitespace per line, then returns `createHash('sha256').update(normalized, 'utf8').digest('hex')`. Pure function; no side effects.
  - [ ] Subtask 1b: In `src/core/event-bus.types.ts`, add `'story:ac-source-drift': { storyKey: string; storedHash: string | null; currentHash: string }` to the `OrchestratorEvents` interface (or equivalent event map type). Follow the existing event declaration pattern in that file.

- [ ] Task 2: Implement freshness check in the orchestrator reuse path (AC2, AC7)
  - [ ] Subtask 2a: Locate the existing story-file reuse block in `src/modules/implementation-orchestrator/orchestrator-impl.ts` (~lines 1477-1505). Identify where `isValidStoryFile` is called and `storyFilePath` is conditionally set.
  - [ ] Subtask 2b: After the `isValidStoryFile` guard, add a call to `findEpicsFile()` (already imported or accessible) and `extractStorySection(epicContent, storyKey)` to obtain the current source AC text. Wrap in try/catch; on any error or missing file, skip freshness check and preserve existing reuse behavior (AC7).
  - [ ] Subtask 2c: When source section is available, call `hashSourceAcSection(sourceSection)` to get `currentHash`. Use a regex `/<!--\s*source-ac-hash:\s*([0-9a-f]{64})\s*-->/` to extract `storedHash` from the existing artifact file content. If `storedHash` is absent or differs from `currentHash`, set `storyFilePath = undefined`, emit `eventBus.emit('story:ac-source-drift', { storyKey, storedHash: storedHash ?? null, currentHash })`, and log an info-level message: `[orchestrator] story ${storyKey}: source AC hash mismatch, regenerating story artifact`.
  - [ ] Subtask 2d: If `storedHash === currentHash`, continue reuse as before (no event emitted, no log).

- [ ] Task 3: Update create-story prompt to emit hash comment (AC3)
  - [ ] Subtask 3a: In `packs/bmad/prompts/create-story.md`, locate the `## Acceptance Criteria` output section in the story template guidance. Add a directive instructing the agent: "Immediately after the `## Acceptance Criteria` heading in the rendered story file, emit the line `<!-- source-ac-hash: {{source_ac_hash}} -->` (substituting the actual hash value provided in the prompt context). When `source_ac_hash` is not provided, omit the comment."
  - [ ] Subtask 3b: Verify the directive is placed where create-story agents will encounter it when writing the AC section — in the story-file writing instructions, not in background context.

- [ ] Task 4: Hash helper unit tests in create-story test file (AC5)
  - [ ] Subtask 4a: In `src/modules/compiled-workflows/__tests__/create-story.test.ts`, add a `describe('hashSourceAcSection')` block with:
    - Test: same input string produces identical hex output (idempotency/stability)
    - Test: leading/trailing whitespace on the whole section is trimmed before hashing (same section with extra surrounding newlines → same hash)
    - Test: trailing whitespace stripped per line (line ending in spaces vs. not → same hash)
    - Test: different content produces different hash (basic collision avoidance sanity check)
    - Test: empty string after trimming produces a deterministic non-empty hex string (not a throw)

- [ ] Task 5: Integration tests for reuse-path freshness check (AC6, AC7)
  - [ ] Subtask 5a: In `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts`, add a `describe('story-file freshness check')` block. Use the existing test infrastructure (mocked `findEpicsFile`, `extractStorySection`, `fs.readFile`, `eventBus`) to set up scenarios:
    - **Drift case**: existing artifact contains `<!-- source-ac-hash: aaa...aaa -->`, `hashSourceAcSection` would return `bbb...bbb` → assert create-story IS dispatched; assert `story:ac-source-drift` event emitted with correct `storedHash`/`currentHash`
    - **No-drift case**: existing artifact hash matches current source hash → assert create-story is skipped; assert `story:ac-source-drift` event NOT emitted
    - **Legacy case (no hash)**: existing artifact has no hash comment → assert create-story IS dispatched; assert `story:ac-source-drift` emitted with `storedHash: null`
    - **No-epic case**: `findEpicsFile` returns `undefined`/throws → assert create-story is skipped (reuse preserved, no event emitted)

## Dev Notes

### Architecture Constraints
- `hashSourceAcSection` MUST be a pure function — no file I/O, no side effects. Importable from test code with zero setup.
- Use Node's built-in `crypto` module (`createHash('sha256')`). Do NOT add a third-party hashing dependency.
- The hash regex in the orchestrator must match the exact HTML comment format: `<!-- source-ac-hash: <64 hex chars> -->`. Allow optional whitespace around the hex value in the regex for robustness.
- The freshness check must be **non-fatal** when the source epic is unavailable — wrap all `findEpicsFile` + `extractStorySection` + `fs.readFile` calls in try/catch and treat any error as "source unavailable → skip freshness check → reuse artifact."
- The `story:ac-source-drift` event MUST be declared in `src/core/event-bus.types.ts` with the exact payload shape `{ storyKey: string; storedHash: string | null; currentHash: string }`. Follow the existing event map pattern in that file.
- The orchestrator already imports `findEpicsFile` for the `isImplicitlyCovered` helper — reuse that import. Do NOT add a second copy of the file-discovery logic.

### Whitespace Normalization in `hashSourceAcSection`
The normalization must be minimal but sufficient to avoid spurious regen from editor-induced whitespace noise:
1. Split on `\n`
2. Strip trailing whitespace from each line (`.trimEnd()`)
3. Rejoin with `\n`
4. Trim the whole result (`.trim()`)
Then hash the result. Do NOT normalize internal spacing or collapse blank lines — that would hide real content changes.

### Testing Requirements
- Tests must be in Vitest (existing test framework for this project).
- Mock `fs.readFile` / `fs.promises.readFile` carefully — the orchestrator test file likely already has fs mocking infrastructure; extend it.
- The hash helper tests do NOT need any mocks — they call the pure function directly.
- The integration test MUST cover the no-epic case (AC7) to prevent regression of BMAD auto-implement projects that have no `epics.md`.
- Follow the existing test patterns in `orchestrator.test.ts` — check which mocking style is used before adding new tests.

### Related Files for Context
- Existing reuse path: `src/modules/implementation-orchestrator/orchestrator-impl.ts` ~lines 1477-1505 — `isValidStoryFile` function and the block that calls it
- `findEpicsFile` and `extractStorySection` helpers — already used in the same file; check import location
- Epic 58-5 fix in `extractStorySection` — ensures storyKey `1-7` matches `### Story 1.7:` headings; the freshness check builds on this fix
- Event bus pattern: `src/core/event-bus.types.ts` — look at how existing `story:*` events are declared to match the pattern exactly

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
