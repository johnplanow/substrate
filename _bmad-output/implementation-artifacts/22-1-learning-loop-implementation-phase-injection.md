# Story 22.1: Learning Loop — Implementation-Phase Injection

Status: ready-for-dev

## Story

As a pipeline user running substrate on the same project across multiple runs,
I want prior run findings (recurring patterns, escalation diagnoses, high-review-cycle stories, advisory notes) injected into the dev-story and code-review prompts,
so that implementation agents avoid repeating the same mistakes and the pipeline improves with each successive run.

## Acceptance Criteria

### AC1: `getProjectFindings()` returns formatted markdown summary
**Given** prior story outcomes with recurring patterns exist in the decision store (STORY_OUTCOME, STORY_METRICS, ESCALATION_DIAGNOSIS, ADVISORY_NOTES categories)
**When** `getProjectFindings(db)` is called
**Then** it returns a markdown summary that includes: recurring patterns appearing in ≥2 stories, up to 3 recent escalation diagnoses, stories with ≥2 review cycles, prior stall count, and up to 3 advisory notes from LGTM_WITH_NOTES reviews — capped at 2000 characters

### AC2: Dev-story prompt includes prior findings when available
**Given** prior run findings exist in the decision store
**When** `runDevStory()` assembles its prompt
**Then** the prompt contains the findings text with the header "Previous pipeline runs encountered these issues — avoid repeating them:" replacing the `{{prior_findings}}` placeholder in `dev-story.md`

### AC3: Code-review prompt includes prior findings when available
**Given** prior run findings exist in the decision store
**When** `runCodeReview()` assembles its prompt
**Then** the prompt contains the findings text replacing the `{{prior_findings}}` placeholder in `code-review.md`

### AC4: Graceful fallback when no findings exist
**Given** the decision store has no prior run records (first-ever run or empty DB)
**When** `runDevStory()` or `runCodeReview()` assembles the prompt
**Then** the `{{prior_findings}}` section renders as empty string with no orphaned placeholder text; dispatch proceeds normally

### AC5: Error resilience — findings query failure does not block dispatch
**Given** the decision store throws an unexpected error during query
**When** `getProjectFindings(db)` is called
**Then** it catches the exception, logs a structured warning via `logger.warn`, and returns an empty string without propagating the exception

### AC6: Findings summary is token-budget-safe
**Given** assembled prior findings text would exceed MAX_CHARS (2000 characters)
**When** `getProjectFindings(db)` formats the summary
**Then** the returned string is truncated to ≤2000 chars with '...' appended, ensuring the injected section never causes a `prompt_too_long` failure

### AC7: STORY_OUTCOME decision records written on story completion
**Given** the implementation orchestrator processes a story reaching COMPLETE or ESCALATED status
**When** the orchestrator finalises the story result
**Then** a STORY_OUTCOME decision is written to the decision store with fields: `outcome` (complete|escalated), `reviewCycles`, `verdictHistory` (array of verdict strings), and `recurringPatterns` (extracted from code-review issue descriptions) — keyed as `{storyKey}:{runId}`

## Tasks / Subtasks

- [ ] Task 1: Add decision-store category constants for the learning loop to `src/persistence/schemas/operational.ts` (AC1, AC7)
  - [ ] Add `export const STORY_OUTCOME = 'story-outcome' as const`
  - [ ] Add `export const STORY_METRICS = 'story-metrics' as const`
  - [ ] Add `export const ESCALATION_DIAGNOSIS = 'escalation-diagnosis' as const`
  - [ ] Add `export const ADVISORY_NOTES = 'advisory-notes' as const`
  - [ ] Add JSDoc comment blocks for each constant describing the key schema and JSON value shape

- [ ] Task 2: Create `src/modules/implementation-orchestrator/project-findings.ts` (AC1, AC4, AC5, AC6)
  - [ ] Import `getDecisionsByCategory` from `'../../persistence/queries/decisions.js'`
  - [ ] Import the four new constants (STORY_OUTCOME, STORY_METRICS, ESCALATION_DIAGNOSIS, ADVISORY_NOTES) and OPERATIONAL_FINDING from `'../../persistence/schemas/operational.js'`
  - [ ] Import `createLogger` from `'../../utils/logger.js'`; set `const logger = createLogger('project-findings')`
  - [ ] Define `const MAX_CHARS = 2000`
  - [ ] Implement `export function getProjectFindings(db: BetterSqlite3Database): string` with try/catch returning `''` on error (AC5)
  - [ ] Inside: query all five categories; return `''` if all are empty (AC4)
  - [ ] Build sections array: recurring patterns (≥2 occurrences across outcomes), recent escalation diagnoses (last 3), high-cycle stories (reviewCycles ≥ 2, last 5), stall count, advisory notes (last 3)
  - [ ] Join sections and truncate to MAX_CHARS with `'...'` suffix (AC6)
  - [ ] Add private helper `extractRecurringPatterns(outcomes)` that counts `val.recurringPatterns` array entries across all outcomes and returns patterns with count ≥ 2

- [ ] Task 3: Update `packs/bmad/prompts/dev-story.md` to add `{{prior_findings}}` placeholder (AC2, AC4)
  - [ ] Add a `### Prior Run Findings\n{{prior_findings}}` section after the story content section
  - [ ] Add one sentence in the Mission: "When Prior Run Findings are provided, treat them as institutional memory — avoid the repeated patterns and flag any that apply to this story's scope."

- [ ] Task 4: Update `packs/bmad/prompts/code-review.md` to add `{{prior_findings}}` placeholder (AC3, AC4)
  - [ ] Add a `### Prior Run Findings\n{{prior_findings}}` section in the context area
  - [ ] Add instruction: "If Prior Run Findings are provided, check whether any recurring patterns are present in the code under review — flag them as major issues."

- [ ] Task 5: Inject prior findings into `runDevStory()` in `src/modules/compiled-workflows/dev-story.ts` (AC2, AC4, AC5)
  - [ ] Import `getProjectFindings` from `'../implementation-orchestrator/project-findings.js'`
  - [ ] After test patterns query, add: call `getProjectFindings(deps.db)` wrapped in try/catch; if non-empty, prepend framing header; assign to `priorFindingsContent`
  - [ ] Add `{ name: 'prior_findings', content: priorFindingsContent, priority: 'optional' }` to the `sections` array passed to `assemblePrompt()`

- [ ] Task 6: Inject prior findings into `runCodeReview()` in `src/modules/compiled-workflows/code-review.ts` (AC3, AC4, AC5)
  - [ ] Import `getProjectFindings` from `'../implementation-orchestrator/project-findings.js'`
  - [ ] Add prior findings query (try/catch, empty string fallback) before prompt assembly
  - [ ] Add `{ name: 'prior_findings', content: priorFindingsContent, priority: 'optional' }` to sections array

- [ ] Task 7: Write STORY_OUTCOME records from the orchestrator on story completion/escalation (AC7)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, after a story reaches COMPLETE or ESCALATED, call `createDecision(db, { pipeline_run_id: runId, phase: 'implementation', category: STORY_OUTCOME, key: \`${storyKey}:${runId}\`, value: JSON.stringify({ outcome, reviewCycles, verdictHistory, recurringPatterns }) })`
  - [ ] Import `STORY_OUTCOME` from `'../../persistence/schemas/operational.js'`
  - [ ] Extract `recurringPatterns` from code-review issues list (strings describing issues from NEEDS_MINOR_FIXES/NEEDS_MAJOR_REWORK verdicts); default to `[]` when unavailable

- [ ] Task 8: Write unit tests for `project-findings.ts` in `src/modules/implementation-orchestrator/__tests__/project-findings.test.ts` (AC1, AC4, AC5, AC6)
  - [ ] Use `vi.mock` to control `getDecisionsByCategory` return values
  - [ ] Test: outcomes with 2+ shared patterns → summary contains those patterns
  - [ ] Test: outcomes with patterns appearing only once → patterns omitted from summary
  - [ ] Test: escalation diagnoses present → summary contains escalation lines
  - [ ] Test: high-cycle stories present (reviewCycles ≥ 2) → summary contains story key and cycle count
  - [ ] Test: all categories empty → returns `''` (AC4)
  - [ ] Test: `getDecisionsByCategory` throws → returns `''` without throwing (AC5)
  - [ ] Test: combined output exceeds 2000 chars → returned string length ≤ 2003 (`2000 + '...'`) (AC6)
  - [ ] Run targeted: `npx vitest run --no-coverage -- "project-findings"`
  - [ ] Full validation: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3`

## Dev Notes

### Architecture Constraints
- All imports use `.js` extension (ESM): `import { getProjectFindings } from '../implementation-orchestrator/project-findings.js'`
- `getProjectFindings(db)` must accept `Database` from `better-sqlite3` — use `import type { Database as BetterSqlite3Database } from 'better-sqlite3'`
- The `prior_findings` section must be `priority: 'optional'` in `assemblePrompt()` so it is the first candidate for truncation when the prompt approaches the token ceiling
- Do NOT call `process.exit` in `project-findings.ts` — it is a pure utility function; all errors are caught and logged

### Key File Paths
- `src/persistence/schemas/operational.ts` — add new category constants here
- `src/modules/implementation-orchestrator/project-findings.ts` — new file
- `src/modules/compiled-workflows/dev-story.ts` — inject prior_findings into sections array
- `src/modules/compiled-workflows/code-review.ts` — inject prior_findings into sections array
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — write STORY_OUTCOME decisions
- `packs/bmad/prompts/dev-story.md` — add `{{prior_findings}}` placeholder
- `packs/bmad/prompts/code-review.md` — add `{{prior_findings}}` placeholder
- `src/modules/implementation-orchestrator/__tests__/project-findings.test.ts` — new test file

### Testing Requirements
- Framework: Vitest (NOT jest — `--testPathPattern` flag does not work; use `-- "pattern"`)
- Use `vi.mock('../../persistence/queries/decisions.js', ...)` to stub `getDecisionsByCategory` — do NOT create a real SQLite DB in unit tests
- Seed recurring patterns by returning multiple outcomes sharing the same string in `val.recurringPatterns`
- Test files co-located in `src/modules/implementation-orchestrator/__tests__/`
- Coverage threshold: 80% enforced by `npm test`; `npm run test:fast` for faster iteration

### Prompt Assembler Integration
- `assemblePrompt(template, sections, TOKEN_CEILING)` handles placeholder substitution automatically — just register `{ name: 'prior_findings', content: ..., priority: 'optional' }`
- Empty content (`''`) for a section is safe: the placeholder is replaced with an empty string leaving no orphaned `{{...}}` text (AC4)
- `prior_findings` is the last section in the array in both dev-story and code-review so it is truncated first under budget pressure

### Decision Store Write Pattern
```typescript
import { createDecision } from '../../persistence/queries/decisions.js'
import { STORY_OUTCOME } from '../../persistence/schemas/operational.js'

createDecision(db, {
  pipeline_run_id: runId,
  phase: 'implementation',
  category: STORY_OUTCOME,
  key: `${storyKey}:${runId}`,
  value: JSON.stringify({
    outcome: 'complete',           // 'complete' | 'escalated'
    reviewCycles: 2,
    verdictHistory: ['NEEDS_MINOR_FIXES', 'SHIP_IT'],
    recurringPatterns: ['missing error handling'],
  }),
})
```

## Interface Contracts

- **Export**: `getProjectFindings` @ `src/modules/implementation-orchestrator/project-findings.ts` (consumed by dev-story, code-review, and analysis phase in story 22-4)
- **Export**: `STORY_OUTCOME`, `STORY_METRICS`, `ESCALATION_DIAGNOSIS`, `ADVISORY_NOTES` @ `src/persistence/schemas/operational.ts` (consumed by orchestrator writes and project-findings queries)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
