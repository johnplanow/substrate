# Story 53-1: StallDetector with Phase-Aware Thresholds

## Story

As a substrate operator,
I want the supervisor to use phase-aware staleness thresholds that are multiplied by the backend's timeout multiplier,
so that healthy long-running dispatches are not killed as stalls.

## Acceptance Criteria

### AC1: Phase-Aware Threshold Configuration
**Given** a `StallDetector` is constructed with a threshold configuration
**When** the configuration specifies phase thresholds: `create-story` (300s), `dev-story` (900s), `code-review` (900s), `test-plan` (600s)
**Then** the detector returns the correct per-phase threshold when `getThreshold(phase)` is called with any of those phase names

### AC2: Backend Timeout Multiplier Applied
**Given** a `StallDetector` configured with the default phase thresholds
**When** the active backend reports `timeoutMultiplier: 3.0` (e.g., Codex)
**Then** `getEffectiveThreshold('code-review', 3.0)` returns `2700` (900 × 3.0), and `getEffectiveThreshold('create-story', 3.0)` returns `900` (300 × 3.0)

### AC3: Stall Evaluation Returns Correct Verdict
**Given** a `StallDetector` with default phase thresholds and a `timeoutMultiplier` of 1.0
**When** `evaluate({ phase: 'dev-story', staleness_seconds: 800, timeoutMultiplier: 1.0 })` is called
**Then** `isStalled` is `false` (800 < 900)
**And** when called with `staleness_seconds: 950`, `isStalled` is `true` with `effectiveThreshold: 900` in the result

### AC4: Thresholds Stored in Run Manifest Config
**Given** a new pipeline run is started
**When** the supervisor writes the initial run manifest
**Then** the manifest's `cli_flags.stall_thresholds` field contains the default phase-threshold map `{ "create-story": 300, "dev-story": 900, "code-review": 900, "test-plan": 600 }` persisted as a JSON-serialisable object — not hardcoded inside the `StallDetector` class itself

### AC5: StallDetector Replaces Inline handleStallRecovery Logic
**Given** the existing `handleStallRecovery` function in `src/cli/commands/supervisor.ts`
**When** it checks whether the staleness threshold is exceeded
**Then** it calls `StallDetector.evaluate()` to compute the effective threshold, replacing the current inline phase-doubling heuristic (`inReviewPhase ? threshold * 2 : threshold`), so the entire threshold-computation path is delegated to the `StallDetector`

### AC6: Poll Interval Configurable via SubstrateConfig
**Given** a `SubstrateConfig` with a new optional field `supervisor_poll_interval_seconds`
**When** the supervisor starts and reads config
**Then** it uses `supervisor_poll_interval_seconds` as the poll interval (default: `30` if the field is absent)

### AC7: Adaptive Polling Under High-Multiplier Backends
**Given** a `StallDetector` constructed with a `timeoutMultiplier` of 3.0 (or any multiplier that causes all effective thresholds to exceed 600s)
**When** `getAdaptivePollInterval(basePollIntervalSeconds, timeoutMultiplier)` is called with `basePollIntervalSeconds: 30`
**Then** it returns `60` (doubled), reducing polling overhead; for `timeoutMultiplier: 1.0`, it returns `30` (unchanged)

## Tasks / Subtasks

- [ ] Task 1: Define `StallThresholdConfig` type and `StallDetector` class (AC: #1, #2, #3, #7)
  - [ ] Create `src/modules/supervisor/stall-detector.ts` exporting:
    - `StallThresholdConfig`: `Record<string, number>` (phase name → seconds)
    - `StallEvaluateInput`: `{ phase: string; staleness_seconds: number; timeoutMultiplier: number }`
    - `StallEvaluateResult`: `{ isStalled: boolean; effectiveThreshold: number; phase: string; timeoutMultiplier: number }`
    - `DEFAULT_STALL_THRESHOLDS: StallThresholdConfig` with `{ 'create-story': 300, 'dev-story': 900, 'code-review': 900, 'test-plan': 600 }`
    - `StallDetector` class: constructor takes `StallThresholdConfig`; exposes `getThreshold(phase: string): number`, `getEffectiveThreshold(phase: string, multiplier: number): number`, `evaluate(input: StallEvaluateInput): StallEvaluateResult`, and `getAdaptivePollInterval(baseSeconds: number, multiplier: number): number`
  - [ ] Fallback in `getThreshold`: for unknown phases, return the maximum value in the config (safest default)
  - [ ] `getAdaptivePollInterval`: if `Math.min(...Object.values(config).map(v => v * multiplier)) > 600`, return `baseSeconds * 2`, else return `baseSeconds`

- [ ] Task 2: Persist default thresholds in run manifest config (AC: #4)
  - [ ] In the supervisor startup flow (before the poll loop), after the run manifest is opened/created, call `manifest.update({ cli_flags: { ...existing_cli_flags, stall_thresholds: DEFAULT_STALL_THRESHOLDS } })` if `cli_flags.stall_thresholds` is not already set (idempotent)
  - [ ] When reading thresholds at runtime, prefer `manifest.read().cli_flags.stall_thresholds` over the hardcoded constant so that custom user overrides persist across restarts

- [ ] Task 3: Integrate `StallDetector` into `handleStallRecovery` (AC: #5)
  - [ ] In `src/cli/commands/supervisor.ts`, import `StallDetector` and `DEFAULT_STALL_THRESHOLDS`
  - [ ] At the start of `handleStallRecovery`, construct `const detector = new StallDetector(config.stallThresholds ?? DEFAULT_STALL_THRESHOLDS)`
  - [ ] Retrieve `timeoutMultiplier` from the adapter registry (already done at line ~534 via `getRegistry()`) and pass it into `detector.evaluate({ phase: activePhase, staleness_seconds: health.staleness_seconds, timeoutMultiplier })`
  - [ ] Replace the existing inline `effectiveThreshold` computation (lines ~396–400, the `inReviewPhase ? stallThreshold * 2 : stallThreshold` heuristic) with `const { isStalled, effectiveThreshold } = detector.evaluate(...)` — return `null` (no stall) when `!isStalled`
  - [ ] Determine `activePhase` from the per-story state in `health.stories.details`: if any story is in a review phase (`IN_REVIEW` / `code-review`), use `'code-review'`; else use the phase of the most recently active story, defaulting to `'dev-story'`

- [ ] Task 4: Add configurable poll interval to SubstrateConfig and apply adaptive polling (AC: #6, #7)
  - [ ] In `src/modules/config/config-schema.ts`, add optional field `supervisor_poll_interval_seconds: z.number().int().positive().optional()` to the schema (inside the existing `.passthrough()` section or as a named field)
  - [ ] In `runSupervisorAction`, after resolving `pollInterval` from CLI options, if `supervisorConfig.supervisor_poll_interval_seconds` is defined and no explicit `--poll-interval` flag was passed, use the config value
  - [ ] Instantiate a `StallDetector` once at the top of `runSupervisorAction` (using manifest thresholds if available) and call `detector.getAdaptivePollInterval(resolvedPollInterval, timeoutMultiplier)` to compute the effective poll interval before the poll loop begins

- [ ] Task 5: Write unit tests (AC: #1, #2, #3, #7)
  - [ ] Create `src/modules/supervisor/__tests__/stall-detector.test.ts` using Vitest
  - [ ] Test `getThreshold`: known phases return correct seconds; unknown phase returns max value
  - [ ] Test `getEffectiveThreshold`: multiplier 1.0 is identity; multiplier 3.0 triples the threshold
  - [ ] Test `evaluate`: returns `isStalled: false` when staleness < threshold; `isStalled: true` with correct `effectiveThreshold` when staleness ≥ threshold; handles unknown phase via fallback
  - [ ] Test `getAdaptivePollInterval`: with multiplier 1.0, returns base interval unchanged; with multiplier 3.0 (causes all effective thresholds > 600s), returns base × 2
  - [ ] Test with custom `StallThresholdConfig` to confirm no hardcoded values bleed through

## Dev Notes

### Architecture Constraints
- `StallDetector` lives in `src/modules/supervisor/stall-detector.ts` — do not place it in `packages/sdlc` or `packages/core`; this is a supervisor-level concern
- No new Dolt tables; thresholds are stored in the run manifest `cli_flags` JSON object
- The `StallDetector` class must be pure (no I/O, no side effects) — all I/O stays in `handleStallRecovery`
- Import style: use `import { ... } from '../../modules/supervisor/stall-detector.js'` (`.js` extension for ESM compatibility)
- Do not change the `handleStallRecovery` function signature — caller sites depend on it

### Key File Paths
- **New file:** `src/modules/supervisor/stall-detector.ts`
- **New test:** `src/modules/supervisor/__tests__/stall-detector.test.ts`
- **Modify:** `src/cli/commands/supervisor.ts` — `handleStallRecovery` (lines ~377–571) and `runSupervisorAction` (line ~588+)
- **Modify:** `src/modules/config/config-schema.ts` — add `supervisor_poll_interval_seconds` field
- **Run manifest types (reference only, do not modify):** `packages/sdlc/src/run-model/types.ts`, `packages/sdlc/src/run-model/run-manifest.ts`

### RunManifest Usage Pattern
```typescript
// Open existing manifest (Epic 52 API)
const manifest = RunManifest.open(runId, join(projectRoot, '.substrate', 'runs'))
const data = await manifest.read()
const existingFlags = data.cli_flags ?? {}
if (!existingFlags.stall_thresholds) {
  await manifest.update({ cli_flags: { ...existingFlags, stall_thresholds: DEFAULT_STALL_THRESHOLDS } }).catch(() => {})
}
```

### StallDetector Class Sketch
```typescript
export class StallDetector {
  constructor(private readonly thresholds: StallThresholdConfig) {}

  getThreshold(phase: string): number {
    return this.thresholds[phase] ?? Math.max(...Object.values(this.thresholds))
  }

  getEffectiveThreshold(phase: string, multiplier: number): number {
    return this.getThreshold(phase) * multiplier
  }

  evaluate(input: StallEvaluateInput): StallEvaluateResult {
    const effectiveThreshold = this.getEffectiveThreshold(input.phase, input.timeoutMultiplier)
    return {
      isStalled: input.staleness_seconds >= effectiveThreshold,
      effectiveThreshold,
      phase: input.phase,
      timeoutMultiplier: input.timeoutMultiplier,
    }
  }

  getAdaptivePollInterval(baseSeconds: number, multiplier: number): number {
    const minEffective = Math.min(...Object.values(this.thresholds).map(v => v * multiplier))
    return minEffective > 600 ? baseSeconds * 2 : baseSeconds
  }
}
```

### Determining `activePhase` for evaluate()
The `handleStallRecovery` function receives `health.stories.details` (from `PipelineHealthOutput`). Use this to determine the dominant phase:
```typescript
const REVIEW_PHASES = new Set(['IN_REVIEW', 'code-review'])
const activePhases = Object.values(health.stories.details ?? {}).map((s: any) => s.phase)
const activePhase = activePhases.some(p => REVIEW_PHASES.has(p)) ? 'code-review' : 'dev-story'
```

### Testing Requirements
- Framework: Vitest (not Jest) — `import { describe, it, expect, beforeEach } from 'vitest'`
- No I/O needed in StallDetector tests — pure unit tests, no temp directories required
- Tests must cover the boundary condition: `staleness_seconds === effectiveThreshold` is stalled (≥ not >)
- Test file name must end with `.test.ts`

## Interface Contracts

- **Export**: `StallDetector`, `StallThresholdConfig`, `StallEvaluateInput`, `StallEvaluateResult`, `DEFAULT_STALL_THRESHOLDS` @ `src/modules/supervisor/stall-detector.ts` (consumed by story 53-2: Multi-Signal Stall Detection, which extends the evaluate pipeline)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations)
