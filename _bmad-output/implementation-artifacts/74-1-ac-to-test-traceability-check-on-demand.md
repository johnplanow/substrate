---
external_state_dependencies:
  - filesystem
---

# Story 74-1: AC-to-Test Traceability Check (on-demand)

## Story

As a pipeline operator,
I want an on-demand `--verify-ac` flag on `substrate report` and `substrate run`
that produces a heuristic AC-to-test traceability matrix for completed stories,
so that I can get extra confidence on critical stories without paying the cost of
an LLM call on every run.

## Acceptance Criteria

<!-- source-ac-hash: 43041788b79099dd767c7ef94270324cca80642c14a153c483000131b48c12c9 -->

### AC1: New ac-traceability-check module
New module `packages/sdlc/src/verification/checks/ac-traceability-check.ts`
exporting `runAcTraceabilityCheck(input)` matching existing check
shape (consult
`packages/sdlc/src/verification/checks/runtime-probe-check.ts`
from existing checks for the contract).

### AC2: Heuristic matching algorithm
**Heuristic matching algorithm**:
- Read AC list from story spec (parse `**Acceptance Criteria:**`
  section + numbered ACs)
- Read test files from story's `files_modified` (filter to
  `*.test.ts`, `*.test.js`, `*test*` patterns)
- For each AC text and each test description, compute fuzzy match
  score (use existing string-distance helper if present; else
  simple word-overlap percentage)
- Threshold ≥0.4 word-overlap → "matched"; below → "not matched"
- Acknowledge approximate matching in output: include `confidence:
  'approximate'` in the JSON output

### AC3: `--verify-ac` flag on both commands
**`--verify-ac` flag**: registered on BOTH `substrate report` AND
`substrate run`:
- `substrate report --verify-ac` re-runs the check for the latest
  run's stories and re-outputs the report
- `substrate run --verify-ac` runs the check after the run
  completes (additive verification step)

### AC4: Output format
**Output format**: extend Epic 71's `substrate report` output:
- Human format: new "AC Traceability" section with per-story
  matrix (table: AC | matched | test name)
- JSON format: top-level `ac_traceability` object keyed by
  storyKey with `{ matrix: [...], confidence: 'approximate' }`

### AC5: LLM call optionality
**LLM call optionality**: heuristic matching is the default; if
`--verify-ac-llm` flag is also passed, augment with LLM-based
matching. LLM call optional, NOT required. Out of scope for
initial implementation if too complex (feasible: defer to Epic 75
if LLM integration is non-trivial).

### AC6: CRITICAL — use canonical helpers
**CRITICAL: use canonical helpers** (per Story 69-2 / 71-2 / 72-x
/ 73-x lesson — 5 prior epics where this prevented invented
manifest formats):
- Read run state via `RunManifest` class from
  `@substrate-ai/sdlc/run-model/run-manifest.js`
- Run-id resolution via `manifest-read.ts` helpers
  (`resolveRunManifest`, `readCurrentRunId`)
- Latest-run fallback via `getLatestRun(adapter)` from
  `packages/core/src/persistence/queries/decisions.ts`
- **Do NOT introduce new aggregate manifest formats.**

### AC7: Tests (≥5 cases)
**Tests** at
`packages/sdlc/src/__tests__/verification/ac-traceability-check.test.ts`
(≥5 cases): (a) matched: AC text and test description share ≥0.4
word overlap → matched; (b) not matched: ≥0.4 below → not matched;
(c) edge case: empty AC list → empty matrix; (d) edge case: no
test files in modified files → all unmatched + warning;
(e) confidence flag always 'approximate' in output.

### AC8: Header comment
**Header comment** cites Phase D Story 54-7 (original spec) +
Epic 71 (substrate report; 74-1 extends).

### AC9: No package additions
**No package additions**.

## Tasks / Subtasks

- [ ] Task 1: Implement `ac-traceability-check.ts` core module (AC: #1, #2, #8, #9)
  - [ ] Define `AcTraceabilityInput` and `AcTraceabilityOutput` types matching existing check shape (consult `runtime-probe-check.ts` contract)
  - [ ] Implement AC section parser: extract numbered items from `**Acceptance Criteria:**` block in story content string
  - [ ] Implement word-overlap scorer: tokenize text to lowercase words, compute `|intersection| / |union|` (Jaccard-like), threshold ≥0.4 → matched
  - [ ] Implement test-file filter: from `files_modified` array, keep entries matching `*.test.ts`, `*.test.js`, `*test*` patterns
  - [ ] Export `runAcTraceabilityCheck(input)` that reads AC list, reads test descriptions (parse `describe(` / `it(` / `test(` strings from file content), scores pairs, returns `{ matrix, confidence: 'approximate' }`
  - [ ] Add header comment citing Phase D Story 54-7 + Epic 71

- [ ] Task 2: Write unit tests for the check module (AC: #7)
  - [ ] Test (a): AC text and test description share ≥0.4 word overlap → `matched: true`
  - [ ] Test (b): overlap below 0.4 → `matched: false`
  - [ ] Test (c): empty AC list → empty matrix `[]`
  - [ ] Test (d): no test files in `files_modified` → all ACs unmatched + `warnings` array with at least one entry
  - [ ] Test (e): `confidence` field is always `'approximate'` regardless of input

- [ ] Task 3: Extend `src/cli/commands/report.ts` with `--verify-ac` flag (AC: #3, #4, #6)
  - [ ] Register `.option('--verify-ac', '...')` on the `report` command
  - [ ] When flag is set: load run manifest via canonical chain (`resolveRunManifest` → `readCurrentRunId` → `getLatestRun(adapter)`); call `runAcTraceabilityCheck` per story using `files_modified` and `storyContent` from manifest
  - [ ] Human format: append "AC Traceability" section (Markdown table: `AC | Matched | Test Name`) after existing report body
  - [ ] JSON format: add top-level `ac_traceability` object keyed by storyKey: `{ matrix: [...], confidence: 'approximate' }`

- [ ] Task 4: Extend `src/cli/commands/run.ts` with `--verify-ac` flag (AC: #3, #6)
  - [ ] Register `.option('--verify-ac', '...')` on the `run` command
  - [ ] After the run completes, if `--verify-ac` was set: invoke `runAcTraceabilityCheck` for each completed story using the same canonical manifest helpers
  - [ ] Emit traceability results in events stream (NDJSON) and/or append to final summary output

- [ ] Task 5: Register optional check in `packages/sdlc/src/verification/verification-pipeline.ts` (AC: #1)
  - [ ] Import `AcTraceabilityCheck` (if the class-based wrapper pattern is warranted) or document that `runAcTraceabilityCheck` is invoked as a standalone on-demand function rather than inside the automatic pipeline
  - [ ] Ensure the check is NOT added to the default Tier A or Tier B pipeline (on-demand only per AC3)

## Dev Notes

### Architecture Constraints

- **No package additions** (AC9): use only existing dependencies.
- **Canonical helpers ONLY** (AC6): run-id resolution must go through `resolveRunManifest` / `readCurrentRunId` from `src/cli/commands/manifest-read.ts` and `getLatestRun(adapter)` from `packages/core/src/persistence/queries/decisions.ts`. Do NOT invent new manifest files.
- **Check shape contract**: consult `packages/sdlc/src/verification/checks/runtime-probe-check.ts` for the `VerificationCheck` / `VerificationContext` / `VerificationResult` interface. The `runAcTraceabilityCheck` function is the standalone export; it does NOT need to implement `VerificationCheck` if it is invoked only on-demand from CLI, but the output shape should be analogous.
- **On-demand only**: do NOT register in the default Tier A/B pipeline. The check is invoked manually by CLI flags.
- **LLM call**: defer `--verify-ac-llm` to Epic 75 if integration is non-trivial (AC5 explicitly permits this).

### File Paths

- `packages/sdlc/src/verification/checks/ac-traceability-check.ts` — NEW: core check logic
- `packages/sdlc/src/__tests__/verification/ac-traceability-check.test.ts` — NEW: ≥5 unit tests
- `src/cli/commands/report.ts` — EXTEND: register `--verify-ac` flag, AC traceability output
- `src/cli/commands/run.ts` — EXTEND: register `--verify-ac` flag, post-run invocation
- `packages/sdlc/src/verification/verification-pipeline.ts` — EXTEND (minimally): ensure optional check does not pollute default pipeline

### Import Patterns

```typescript
// Canonical run-id resolution (never invent a new manifest path)
import { resolveRunManifest } from './manifest-read.js'
import { getLatestRun } from '../../persistence/queries/decisions.js'
// OR for core package path:
import { getLatestRun } from '@substrate-ai/core/persistence/queries/decisions.js'
```

### Word-Overlap Algorithm (AC2)

Simple Jaccard-based word overlap, sufficient for threshold ≥0.4:

```typescript
function wordOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  const intersection = [...setA].filter(w => setB.has(w)).length
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}
```

### Test File Pattern Filter (AC2)

```typescript
const TEST_FILE_PATTERNS = [/\.test\.ts$/, /\.test\.js$/, /test/i]
function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(path))
}
```

### Test Description Extraction

Parse `describe(`, `it(`, `test(` call strings from file content using a simple regex:

```typescript
const TEST_DESC_RE = /(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g
```

### Testing Requirements

- Vitest (existing test framework) — do NOT change test runner
- Tests must be at `packages/sdlc/src/__tests__/verification/ac-traceability-check.test.ts`
- ≥5 test cases per AC7 (a through e)
- Tests are pure unit tests — no filesystem reads, no manifest reads; inject pre-read content as strings

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

---

## Runtime Probes

```yaml
- name: report-verify-ac-help-registered
  sandbox: host
  command: |
    cd /home/jplanow/code/jplanow/substrate
    npm run substrate:dev -- report --help 2>&1
  description: --verify-ac flag appears in substrate report --help output
  expect_stdout_regex:
    - '--verify-ac'

- name: run-verify-ac-help-registered
  sandbox: host
  command: |
    cd /home/jplanow/code/jplanow/substrate
    npm run substrate:dev -- run --help 2>&1
  description: --verify-ac flag appears in substrate run --help output
  expect_stdout_regex:
    - '--verify-ac'

- name: report-verify-ac-json-output-shape
  sandbox: host
  command: |
    cd /home/jplanow/code/jplanow/substrate
    npm run substrate:dev -- report --verify-ac --output-format json 2>&1
  description: substrate report --verify-ac produces JSON with ac_traceability key (may be empty if no run data)
  expect_stdout_no_regex:
    - "error: unknown option '--verify-ac'"
    - 'Unknown option'
```
