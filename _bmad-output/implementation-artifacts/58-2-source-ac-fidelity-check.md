# Story 58-2: SourceAcFidelityCheck as 6th Tier A Verification Check

## Story

As a pipeline maintainer,
I want a Tier A verification check that cross-references the rendered story artifact against the source epic's hard clauses,
so that AC rewrites introduced by the create-story agent are hard-gated before the story can reach COMPLETE.

## Acceptance Criteria

### AC1: New SourceAcFidelityCheck file
New file `packages/sdlc/src/verification/source-ac-fidelity-check.ts` exporting `SourceAcFidelityCheck` class implementing the `VerificationCheck` interface (same shape as the existing 5 Tier A checks in that directory)

### AC2: Graceful no-source handling
The check takes `VerificationContext` with a new optional field `sourceEpicContent: string | undefined` — when undefined or empty, the check emits a `warn`-severity finding with category `source-ac-source-unavailable` and PASSES (non-fatal for projects that don't use `_bmad-output/planning-artifacts/` or have no epic file for the story)

### AC3: Hard-clause extractor
Hard-clause extractor finds: (a) lines containing `MUST NOT`, `MUST`, `SHALL NOT`, `SHALL` as standalone keywords (word boundaries, case-sensitive to match spec convention); (b) backtick-wrapped paths matching `/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*/` (at least one `/` — excludes bare filenames); (c) the presence of a `## Runtime Probes` heading followed by a fenced `yaml` block — represented as a single "runtime-probes-section" clause

### AC4: Per-clause findings on mismatch
For each hard clause found in the source, the check performs a literal substring match against `context.storyContent`. Missing clauses produce one `VerificationFinding` per clause with:
- `category: 'source-ac-drift'`
- `severity: 'error'`
- `message: '<clause type>: "<truncated clause>" present in epics source but absent in story artifact'`

### AC5: Pass/fail return status
`SourceAcFidelityCheck.run()` returns `status: 'fail'` when any error-severity finding is emitted, else `'pass'`

### AC6: Registered as 6th Tier A check
Registered in `createDefaultVerificationPipeline()` as the 6th check, after the existing 5 (phantom-review, trivial-output, ac-evidence, build, runtime-probes). Placement ensures it runs against the final rendered story artifact after all prior checks

### AC7: Orchestrator wiring
Orchestrator wiring: `assembleVerificationContext()` in `src/modules/implementation-orchestrator/verification-integration.ts` gains a `sourceEpicContent` opt; call sites in `orchestrator-impl.ts` populate it by reading the epics file (same `findEpicsFile` helper used by `isImplicitlyCovered`) and returning `undefined` on missing/unreadable — non-fatal

### AC8: Unit tests
Unit tests at `packages/sdlc/src/verification/__tests__/source-ac-fidelity-check.test.ts` cover: (a) all MUST clauses present → pass; (b) one MUST NOT clause missing → fail with single finding; (c) multiple missing clauses → multiple findings, one per clause; (d) `sourceEpicContent` undefined → warn finding with `source-ac-source-unavailable` category, status pass; (e) `## Runtime Probes` block in source but absent in artifact → fail with `source-ac-drift` finding for the probes section

### AC9: Existing checks unaffected
No change to existing 5 Tier A checks — their tests still pass

## Tasks / Subtasks

- [ ] Task 1: Add `sourceEpicContent` to `VerificationContext` and wire orchestrator (AC2, AC7)
  - [ ] Subtask 1a: In `packages/sdlc/src/verification/types.ts`, add optional field `sourceEpicContent?: string` to the `VerificationContext` interface with a JSDoc comment explaining its purpose (populated from source epic for SourceAcFidelityCheck; `undefined` when epic file is absent or unreadable)
  - [ ] Subtask 1b: In `src/modules/implementation-orchestrator/verification-integration.ts`, add `sourceEpicContent?: string` to `AssembleVerificationContextOpts` and pass it through into the returned `VerificationContext` object
  - [ ] Subtask 1c: In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, at both `assembleVerificationContext` call sites (lines ~3013 and ~3308), read the epics file using the existing `findEpicsFile` helper (already imported at line ~379) and pass the result as `sourceEpicContent`; wrap the file read in a try/catch returning `undefined` on any error — non-fatal

- [ ] Task 2: Implement `SourceAcFidelityCheck` (AC1, AC3, AC4, AC5)
  - [ ] Subtask 2a: Create `packages/sdlc/src/verification/source-ac-fidelity-check.ts` with a class `SourceAcFidelityCheck` that has `readonly name = 'source-ac-fidelity'` and `readonly tier = 'A' as const`; implement the `VerificationCheck` interface
  - [ ] Subtask 2b: Implement the hard-clause extractor as a private helper: extract MUST NOT / MUST / SHALL NOT / SHALL lines using word-boundary regex (case-sensitive); extract backtick-wrapped paths with at least one `/`; detect `## Runtime Probes` heading followed by a fenced yaml block as a single "runtime-probes-section" clause
  - [ ] Subtask 2c: Implement `run()`: when `context.sourceEpicContent` is undefined or empty, return `status: 'pass'` with a `warn`-severity finding `{category: 'source-ac-source-unavailable', severity: 'warn', message: 'source epic content unavailable — skipping fidelity check'}`; otherwise extract hard clauses and perform literal substring match against `context.storyContent`
  - [ ] Subtask 2d: For each missing clause, push one `VerificationFinding` with `category: 'source-ac-drift'`, `severity: 'error'`, `message: '<clause type>: "<truncated clause>" present in epics source but absent in story artifact'` (truncate clause at 120 chars); compute `status: 'fail'` if any error findings exist, else `'pass'`; return `VerificationResult` with `status`, `details: renderFindings(findings)`, `duration_ms`, `findings`

- [ ] Task 3: Register check in the default pipeline and export (AC6, AC9)
  - [ ] Subtask 3a: In `packages/sdlc/src/verification/verification-pipeline.ts`, import `SourceAcFidelityCheck` from `'./source-ac-fidelity-check.js'` and add it as the 6th entry in `createDefaultVerificationPipeline()`'s `checks` array, after `new RuntimeProbeCheck()`; update the function's JSDoc comment to include step 6
  - [ ] Subtask 3b: In `packages/sdlc/src/verification/index.ts`, add `SourceAcFidelityCheck` to the exports (following the same pattern as the existing check exports)

- [ ] Task 4: Write unit tests (AC8, AC9)
  - [ ] Subtask 4a: Create `packages/sdlc/src/verification/__tests__/source-ac-fidelity-check.test.ts` with vitest tests; build a minimal `VerificationContext` helper (stub `storyKey`, `workingDir`, `commitSha: 'abc'`, `timeout: 60000`)
  - [ ] Subtask 4b: Test (a) — all MUST clauses present in `storyContent` → `status: 'pass'`, zero error findings
  - [ ] Subtask 4c: Test (b) — one MUST NOT clause absent → `status: 'fail'`, exactly one finding with `category: 'source-ac-drift'` and `severity: 'error'`
  - [ ] Subtask 4d: Test (c) — multiple missing clauses → one `source-ac-drift` finding per missing clause
  - [ ] Subtask 4e: Test (d) — `sourceEpicContent: undefined` → `status: 'pass'`, one `warn` finding with `category: 'source-ac-source-unavailable'`
  - [ ] Subtask 4f: Test (e) — `## Runtime Probes` block in source but absent in `storyContent` → `status: 'fail'`, one `source-ac-drift` finding mentioning the probes section
  - [ ] Subtask 4g: Run `npm run test:fast` and confirm all pre-existing tests still pass (AC9)

## Dev Notes

### Architecture Constraints

- **Package placement**: New check lives in `packages/sdlc/src/verification/source-ac-fidelity-check.ts` — not in the monolith `src/`. This matches the placement of all other Tier A checks (phantom-review-check.ts, trivial-output-check.ts, acceptance-criteria-evidence-check.ts, build-check.ts, runtime-probe-check.ts).
- **No LLM calls**: The check uses literal substring matching only. No async shell execution, no LLM inference.
- **Import style**: Use `.js` extension on all relative imports within `packages/sdlc/src/` (ESM). Import `VerificationCheck`, `VerificationContext`, `VerificationFinding`, `VerificationResult` from `'../types.js'`; import `renderFindings` from `'../findings.js'`.
- **`findEpicsFile` helper**: Already imported in `orchestrator-impl.ts` at line ~379 from `'./story-discovery.js'`. The function returns `string | undefined`. Read the file content with `readFileSync(path, 'utf-8')` wrapped in try/catch.
- **Story section extraction**: When extracting the story's section from the source epic file, use the same heading pattern as `isImplicitlyCovered`: `new RegExp('^###\\s+Story\\s+${escapedStoryKey}[:\\s]', 'm')`. Extract from the heading match through to the next `\n### Story ` heading or end of file. Pass the extracted section (not the full epic file) to the hard-clause extractor so findings are scoped to the correct story.

### Hard-Clause Extraction Details

The extractor operates on the story's section extracted from `sourceEpicContent`:

**MUST/SHALL keyword lines**:
```typescript
// Word-boundary match, case-sensitive, capture the whole line
const mustPattern = /\b(MUST NOT|MUST|SHALL NOT|SHALL)\b/
```
Extract every line that matches. Each matching line is one clause. Emit one finding per missing line.

**Backtick-wrapped paths**:
```typescript
// Match `path/with/at-least-one-slash` — excludes bare `filename.ts`
const pathPattern = /`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_./-]+)`/g
```
Extract all backtick-wrapped path strings (the inner text). Each is one clause. Match against `storyContent` as a literal substring (the backtick wrapper + inner path).

**Runtime Probes section**:
```typescript
// Detect ## Runtime Probes heading followed by a fenced yaml block
const probesPattern = /^##\s+Runtime Probes[\s\S]*?```yaml/m
```
If this pattern matches in the source section, treat the probes presence as a single clause. If `storyContent` does not contain `## Runtime Probes`, emit one `source-ac-drift` error finding.

**Clause truncation**: Truncate clause text to 120 characters in the finding message to keep log output readable.

### Finding Message Format

```
MUST NOT: "MUST NOT retain legacy config" present in epics source but absent in story artifact
path: "`src/config/legacy.ts`" present in epics source but absent in story artifact
runtime-probes-section: "## Runtime Probes" present in epics source but absent in story artifact
```

Prefix by clause type: `MUST NOT`, `MUST`, `SHALL NOT`, `SHALL`, `path`, or `runtime-probes-section`.

### Test File Location and Pattern

Follow the vitest pattern from adjacent check tests:
- `packages/sdlc/src/verification/__tests__/source-ac-fidelity-check.test.ts`
- Use `describe` / `it` blocks; no mocking of Node internals needed since the check is pure in-memory
- Construct a minimal `VerificationContext` stub for each test; only `storyContent` and `sourceEpicContent` need to vary

### Orchestrator Call Site Pattern

Both `assembleVerificationContext` call sites in `orchestrator-impl.ts` follow this pattern — add `sourceEpicContent` consistently to both:

```typescript
let sourceEpicContent: string | undefined
const epicsPath = findEpicsFile(projectRoot ?? process.cwd())
if (epicsPath) {
  try {
    sourceEpicContent = readFileSync(epicsPath, 'utf-8')
  } catch {
    // non-fatal — check will emit warn finding
  }
}
const verifContext = assembleVerificationContext({
  storyKey,
  workingDir: projectRoot ?? process.cwd(),
  reviewResult: latestReviewSignals,
  storyContent: storyContentForVerification,
  devStoryResult: devStorySignals,
  outputTokenCount: devOutputTokenCount,
  sourceEpicContent,
})
```

Note: `findEpicsFile` and `readFileSync` are already imported in `orchestrator-impl.ts`; no new imports needed beyond what's already there.

### Testing Requirements

- **Test framework**: vitest (matching the rest of the codebase)
- **Run during development**: `npm run test:fast` (unit tests only, ~50s)
- **Never run tests concurrently**: verify `pgrep -f vitest` returns nothing before running
- **Do NOT pipe test output** through head/tail/grep — read the vitest summary line directly

## Interface Contracts

- **Export**: `SourceAcFidelityCheck` @ `packages/sdlc/src/verification/source-ac-fidelity-check.ts`
- **Import**: `VerificationContext.sourceEpicContent` field (added to `packages/sdlc/src/verification/types.ts` by this story — consumed by `SourceAcFidelityCheck` and populated by `verification-integration.ts`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
