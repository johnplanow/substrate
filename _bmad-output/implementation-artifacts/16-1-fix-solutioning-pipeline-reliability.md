# Story 16.1: Fix Solutioning Pipeline Reliability

Status: review

## Story

As a pipeline operator,
I want the solutioning phase to complete reliably through all sub-phases (architecture → story generation → readiness check),
so that pipeline runs don't stall silently at the architecture-to-stories transition.

## Context

The first production solutioning run (nextgen-ticketing, run `b9d39c0f`) generated architecture decisions 3 times but never progressed to story generation. Root causes: missing max turns for solutioning task types, fixed prompt token budgets that overflow when decision counts are high, and decision accumulation across retries. These are engineering bugs that block all solutioning pipeline usage.

## Acceptance Criteria

### AC1: Max Turns for Solutioning Task Types
**Given** the pipeline dispatches a sub-agent for `analysis`, `planning`, `architecture`, or `story-generation`
**When** the agent is created
**Then** it has an explicit max turns limit from `DEFAULT_MAX_TURNS`
**And** the limits are: `analysis: 15`, `planning: 20`, `architecture: 25`, `story-generation: 30`

### AC2: Dynamic Prompt Token Budgets
**Given** the solutioning phase assembles a prompt for story generation
**When** the prompt includes injected requirements and architecture decisions
**Then** the token budget scales dynamically based on actual content size
**And** the budget is calculated as: `base_budget + (decision_count * tokens_per_decision)`
**And** if the assembled prompt exceeds the dynamic budget, decisions are summarized/compressed rather than failing with `prompt_too_long`

### AC3: Architecture-to-Stories Phase Transition
**Given** the architecture sub-phase completes successfully and an `architecture` artifact is registered
**When** the solutioning phase continues
**Then** it proceeds to story generation without re-running architecture
**And** the transition is logged for observability

### AC4: Decision Deduplication on Retry
**Given** the architecture sub-phase runs more than once (due to retry or re-invocation)
**When** new architecture decisions are stored
**Then** existing decisions with the same `category` and `key` are updated (upsert), not duplicated
**And** the decision count after N retries equals the count from a single successful run

### AC5: Phase Failure Reporting
**Given** any solutioning sub-phase fails (timeout, prompt_too_long, schema validation error)
**When** the failure occurs
**Then** the specific failure reason is recorded in the pipeline run status
**And** the failure is surfaced via the NDJSON event stream (if `--events` is active)
**And** the pipeline does not silently stall in `running` state

### AC6: Existing Tests Pass
**Given** the reliability fixes are applied
**When** the full test suite runs
**Then** all existing tests pass
**And** coverage thresholds are maintained

## Dev Notes

### Architecture

- Modified: `src/modules/agent-dispatch/types.ts`
  - Add `analysis: 15`, `planning: 20`, `architecture: 25`, `story-generation: 30` to `DEFAULT_MAX_TURNS`
  - Add `readiness-check: 20`, `elicitation: 15`, `critique: 15` for future story use

- Modified: `src/modules/phase-orchestrator/phases/solutioning.ts`
  - Replace `ARCHITECTURE_MAX_PROMPT_TOKENS` and `STORY_GEN_MAX_PROMPT_TOKENS` constants with dynamic calculation
  - Add decision summarization fallback when prompt exceeds budget (compress verbose decisions to key-value pairs)
  - Fix sub-phase transition: ensure architecture completion advances to story generation
  - Add upsert logic for decision store writes (deduplicate on `category` + `key`)

- Modified: `src/modules/phase-orchestrator/phase-orchestrator-impl.ts`
  - Ensure phase status is updated to `failed` (not left as `running`) when sub-phase errors occur
  - Emit failure events on the event bus

### Decision Summarization Strategy

When the full decision set exceeds the prompt budget:
1. Sort decisions by phase (planning first, then architecture)
2. For each decision, produce a compact `key: value` one-liner (drop rationale)
3. If still over budget, drop lower-priority categories (e.g., keep data/auth/API, drop observability/CI)
4. Log a `story:warn` event noting that decisions were summarized

## Tasks

- [x] Add solutioning task types to `DEFAULT_MAX_TURNS` (AC1)
- [x] Implement dynamic prompt budget calculation (AC2)
- [x] Implement decision summarization fallback (AC2)
- [x] Fix architecture→story-generation sub-phase transition (AC3)
- [x] Implement decision upsert logic (AC4)
- [ ] Add failure state handling and event emission (AC5) — out of scope for T1-T5
- [x] Write unit tests for dynamic budget calculation
- [x] Write unit tests for decision deduplication
- [x] Write integration test for full solutioning phase transition
- [x] Verify full test suite passes (AC6) — 4516 tests passing
