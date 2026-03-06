# Story 22-3: Structured Escalation Diagnosis

Status: done

## User Story

As a parent Claude agent monitoring a pipeline run,
I want ESCALATED stories to include a structured diagnosis with actionable information,
so that I can decide whether to retry, re-scope, or flag for human intervention.

## Background

When code-review exhausts review cycles, the story is marked ESCALATED and the `orchestrator:story-escalated` event fires. The event already includes `issueList` (severity, description, file, line) and `reviewCycles`. But the data isn't formatted as an actionable diagnosis — the parent agent gets raw data without a recommendation.

## Acceptance Criteria

### AC1: Structured Diagnosis in Escalation Event
**Given** a story is escalated due to review cycle exhaustion
**When** the `orchestrator:story-escalated` event fires
**Then** the event payload includes a `diagnosis` field with: root cause classification (concentrated issues vs widespread, blocker vs major-only), affected files, and a recommended action (retry with targeted prompt, split story, or flag for human)

### AC2: Diagnosis in NDJSON Output
**Given** a pipeline is running with `--events` flag
**When** a story is escalated
**Then** the NDJSON `story:escalated` event includes the diagnosis as a structured field consumable by the parent agent

### AC3: Diagnosis Persisted to Decision Store
**Given** a story is escalated with a diagnosis
**When** the escalation is recorded
**Then** the diagnosis is written to the decision store with category `escalation-diagnosis` for future reference by the learning loop (Story 22-1)

## Tasks

- [ ] Task 1: Build diagnosis generator (AC: #1)
  - [ ] Analyze issue list: count by severity, group by file
  - [ ] Classify: "concentrated" (>50% issues in 1-2 files) vs "widespread"
  - [ ] Classify: "blocker-present" vs "major-only"
  - [ ] Generate recommendation based on classification
- [ ] Task 2: Attach diagnosis to escalation event (AC: #1, #2)
  - [ ] Add `diagnosis` field to `orchestrator:story-escalated` event
  - [ ] Ensure NDJSON `story:escalated` type includes diagnosis
- [ ] Task 3: Persist diagnosis to decision store (AC: #3)
  - [ ] Write decision with category `escalation-diagnosis`
  - [ ] Include issue summary, classification, and recommendation

## Dev Notes

### Key Files
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — escalation points at lines ~903, ~1091
- `src/modules/implementation-orchestrator/types.ts` — event type definitions
- `src/persistence/schemas/operational.ts` — decision categories

### Escalation Data Available
At escalation time the orchestrator has:
- `issueList[]` — `{ severity, description, file?, line? }`
- `reviewCycles` — number of completed review attempts
- `lastVerdict` — the final code-review verdict
- `storyFilePath` — path to story markdown
- `devFilesModified` — files touched during dev-story
- Prior review results in decision store (`content_hash` field)
