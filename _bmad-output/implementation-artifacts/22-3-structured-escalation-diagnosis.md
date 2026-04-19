# Story 22.3: Structured Escalation Diagnosis

Status: ready-for-dev

## Story

As a pipeline agent managing implementation runs,
I want escalated stories to include structured diagnostic data that classifies the failure type and recommends a recovery action,
so that I can make informed decisions about how to handle each escalation (retry automatically, split the story, or escalate to human review) without manually inspecting raw issue lists.

## Acceptance Criteria

### AC1: EscalationDiagnosis Model
**Given** the escalation-diagnosis module does not yet exist
**When** the story is implemented
**Then** `src/modules/implementation-orchestrator/escalation-diagnosis.ts` exports an `EscalationDiagnosis` interface with fields: `issueDistribution` ('concentrated' | 'widespread'), `severityProfile` ('blocker-present' | 'major-only' | 'minor-only' | 'no-structured-issues'), `totalIssues`, `blockerCount`, `majorCount`, `minorCount`, `affectedFiles` (top-5 string[]), `reviewCycles`, `recommendedAction` ('retry-targeted' | 'split-story' | 'human-intervention'), and `rationale` (string)

### AC2: Diagnosis Generation Logic
**Given** a list of code-review issues and review cycle count
**When** `generateEscalationDiagnosis(issues, reviewCycles, lastVerdict)` is called
**Then** it returns an `EscalationDiagnosis` using these rules:
- Pre-review failure (`lastVerdict` is 'create-story-failed' or 'dev-story-failed') → `recommendedAction: 'human-intervention'`
- No structured issues (empty array or schema-parse failure) → `recommendedAction: 'retry-targeted'` (with rationale noting retry may fix parse failure)
- Any blocker-severity issues present → `recommendedAction: 'human-intervention'`
- Majors only, issues concentrated in ≤ 2 files and total ≤ 5 → `recommendedAction: 'retry-targeted'`
- Majors across > 3 distinct files → `recommendedAction: 'split-story'`
- Default fallthrough → `recommendedAction: 'retry-targeted'`

### AC3: ESCALATION_DIAGNOSIS Constant
**Given** the `src/persistence/schemas/operational.ts` file contains category constants
**When** the story is implemented
**Then** a new exported constant `ESCALATION_DIAGNOSIS = 'escalation-diagnosis'` is added to that file and used in both the orchestrator and any query functions (no magic strings)

### AC4: Event Type Enhancement
**Given** the `orchestrator:story-escalated` event is defined in the event-bus or orchestrator event-types file
**When** the story is implemented
**Then** the event payload type is updated to include an optional `diagnosis?: EscalationDiagnosis` field

### AC5: Orchestrator Emits and Persists Diagnosis
**Given** the implementation orchestrator's `emitEscalation()` function runs when a story exhausts review cycles
**When** `emitEscalation()` is called
**Then**:
- `generateEscalationDiagnosis()` is called with the issues, reviewCycles, and lastVerdict
- The resulting diagnosis is attached to the `orchestrator:story-escalated` event
- The diagnosis is persisted to the decisions table via `createDecision()` with `category: ESCALATION_DIAGNOSIS`, `key: '{storyKey}:{pipelineRunId}'`, `value: JSON.stringify(diagnosis)`, and `rationale: diagnosis.rationale`

### AC6: NDJSON story:escalation Event Includes Diagnosis
**Given** the `story:escalation` NDJSON event is emitted from `run.ts` when `orchestrator:story-escalated` fires
**When** the event is emitted
**Then** the NDJSON payload includes `recommendedAction` and `rationale` fields sourced from `diagnosis` (falling back to `lastVerdict` for rationale if diagnosis is absent)

### AC7: Unit Tests for Diagnosis Generator
**Given** the diagnosis generator module exists
**When** tests run via `npm run test:fast`
**Then** `src/modules/implementation-orchestrator/__tests__/escalation-diagnosis.test.ts` passes, covering all six recommendation branches: pre-review failure, no-structured-issues, blocker-present, concentrated-majors, widespread-majors, and default fallthrough

## Tasks / Subtasks

- [ ] Task 1: Create escalation-diagnosis module (AC: #1, #2)
  - [ ] Create `src/modules/implementation-orchestrator/escalation-diagnosis.ts`
  - [ ] Define and export `EscalationDiagnosis` interface with all fields from AC1
  - [ ] Implement `generateEscalationDiagnosis(issues: unknown[], reviewCycles: number, lastVerdict: string): EscalationDiagnosis`
  - [ ] Apply all six branching rules from AC2 in order (pre-review failure check first, then no-issues, then blockers, then concentration analysis)
  - [ ] Compute `affectedFiles` by grouping issues by file path, sorting by count desc, taking top 5
  - [ ] Write descriptive `rationale` string for each branch (e.g., "Blockers present — fundamental issues require human review")

- [ ] Task 2: Add ESCALATION_DIAGNOSIS constant (AC: #3)
  - [ ] Open `src/persistence/schemas/operational.ts`
  - [ ] Add `export const ESCALATION_DIAGNOSIS = 'escalation-diagnosis'` alongside existing category constants
  - [ ] Verify import path is `.js`-suffixed for ESM compatibility

- [ ] Task 3: Update event type definition (AC: #4)
  - [ ] Locate the event-bus types file where `orchestrator:story-escalated` payload is defined (check `src/core/event-bus.types.ts` or `src/modules/implementation-orchestrator/event-types.ts`)
  - [ ] Add `diagnosis?: EscalationDiagnosis` to the payload type
  - [ ] Add import of `EscalationDiagnosis` from the new module using `.js` extension

- [ ] Task 4: Wire diagnosis into orchestrator emitEscalation() (AC: #5)
  - [ ] Open `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  - [ ] In `emitEscalation()`, call `generateEscalationDiagnosis(issues, reviewCycles, lastVerdict)`
  - [ ] Attach `diagnosis` to the `orchestrator:story-escalated` emit payload
  - [ ] After emitting, call `createDecision(db, { pipeline_run_id: config.pipelineRunId, phase: 'implementation', category: ESCALATION_DIAGNOSIS, key: \`${storyKey}:${config.pipelineRunId}\`, value: JSON.stringify(diagnosis), rationale: diagnosis.rationale })`
  - [ ] Import `ESCALATION_DIAGNOSIS` from `src/persistence/schemas/operational.ts` and `createDecision` from persistence layer

- [ ] Task 5: Enhance NDJSON story:escalation event (AC: #6)
  - [ ] Open `src/cli/commands/run.ts` (or wherever `orchestrator:story-escalated` listener emits NDJSON)
  - [ ] Add `recommendedAction: payload.diagnosis?.recommendedAction` and `rationale: payload.diagnosis?.rationale ?? payload.lastVerdict` to the `story:escalation` NDJSON object
  - [ ] Ensure no TypeScript errors — the new fields are optional in the NDJSON type or typed as `string | undefined`

- [ ] Task 6: Write unit tests for escalation-diagnosis (AC: #7)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/escalation-diagnosis.test.ts`
  - [ ] Test: pre-review failure verdict → `human-intervention` with appropriate rationale
  - [ ] Test: empty issues array → `retry-targeted` with no-structured-issues rationale
  - [ ] Test: single blocker issue → `human-intervention`
  - [ ] Test: 3 major issues in same file → `retry-targeted`, issueDistribution `concentrated`
  - [ ] Test: 8 major issues across 5 files → `split-story`, issueDistribution `widespread`
  - [ ] Test: default fallthrough with minor-only issues → `retry-targeted`
  - [ ] Verify `affectedFiles` is sorted by issue frequency (highest first) and capped at 5

## Dev Notes

### Architecture Constraints
- **File naming**: kebab-case — `escalation-diagnosis.ts`, `escalation-diagnosis.test.ts`
- **Import style**: All internal imports use `.js` extension (ESM). E.g., `import { ESCALATION_DIAGNOSIS } from '../../persistence/schemas/operational.js'`
- **No DI container**: Pass db as a parameter to `createDecision`; no module-level singletons
- **Test framework**: vitest — use `vi.fn()`, `describe`/`it`/`expect`; no jest API
- **No console.log**: use `createLogger('escalation-diagnosis')` if diagnostic logging is needed

### Key File Paths
- `src/modules/implementation-orchestrator/escalation-diagnosis.ts` — new module (diagnosis model + generator)
- `src/modules/implementation-orchestrator/__tests__/escalation-diagnosis.test.ts` — unit tests
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — add `generateEscalationDiagnosis()` call in `emitEscalation()`
- `src/core/event-bus.types.ts` OR `src/modules/implementation-orchestrator/event-types.ts` — add `diagnosis?` to event payload
- `src/persistence/schemas/operational.ts` — add `ESCALATION_DIAGNOSIS` constant
- `src/cli/commands/run.ts` — enhance `story:escalation` NDJSON event with diagnosis fields

### EscalationDiagnosis Interface (authoritative shape for downstream consumers)
```typescript
export interface EscalationDiagnosis {
  issueDistribution: 'concentrated' | 'widespread'
  severityProfile: 'blocker-present' | 'major-only' | 'minor-only' | 'no-structured-issues'
  totalIssues: number
  blockerCount: number
  majorCount: number
  minorCount: number
  affectedFiles: string[]   // top-5 files by issue count, descending
  reviewCycles: number
  recommendedAction: 'retry-targeted' | 'split-story' | 'human-intervention'
  rationale: string         // human-readable explanation for parent agent
}
```

### Decision Persistence Pattern
```typescript
import { createDecision } from '../../persistence/queries/decisions.js'
import { ESCALATION_DIAGNOSIS } from '../../persistence/schemas/operational.js'

// Inside emitEscalation():
const diagnosis = generateEscalationDiagnosis(issues, reviewCycles, lastVerdict)
createDecision(db, {
  pipeline_run_id: config.pipelineRunId,
  phase: 'implementation',
  category: ESCALATION_DIAGNOSIS,
  key: `${storyKey}:${config.pipelineRunId}`,
  value: JSON.stringify(diagnosis),
  rationale: diagnosis.rationale,
})
```

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest). The diagnosis generator is pure logic — no mocking needed.
- Use `npm run test:fast` during development for rapid iteration.
- No SQLite in unit tests — `createDecision` calls are only tested via integration or by mocking in orchestrator-impl tests.
- The diagnosis module itself has no I/O, making it trivially testable.

## Interface Contracts

- **Export**: `EscalationDiagnosis` @ `src/modules/implementation-orchestrator/escalation-diagnosis.ts` (consumed by story 22-5)
- **Export**: `ESCALATION_DIAGNOSIS` @ `src/persistence/schemas/operational.ts` (consumed by story 22-5)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
