# Epic 34: Autonomous Execution — Behavioral Baselines & Shadow Validation

**Status: DEFERRED — Design complete, not yet scheduled. Depends on Epic 33.**

## Vision

Graduate from retry-on-failure (Epic 33) to **behavioral regression detection and long-running autonomous sessions**. Epic 33 answers "did the agent break something?" This epic answers "did the agent produce equivalent outcomes to a known-good run?" and "can the orchestrator run for hours without human supervision?"

This is the golden master + shadow run layer of the validation stack. It introduces baseline capture from validated runs, semantic diffing of pipeline outputs, noise floor calibration (the Diffy trick — run twice, measure natural variance), and a live shadow execution mode against a reference project. Together, these enable the orchestrator to detect behavioral drift from prompt changes, model swaps, or configuration updates — and to run extended autonomous sessions with confidence that regression will be caught.

## Rationale

### What Epic 33 provides

- Validation cascade (Levels 0-3): structural, build, test, invariant checks
- Retry loop with structured remediation context
- Approved-divergence registry for tolerance configuration

### What's still missing after Epic 33

1. **No behavioral baselines**: The harness checks "does it work?" but not "does it produce the same kind of output as last time?" Without baselines, prompt regressions and model quality changes are invisible.
2. **No noise floor**: LLM outputs vary naturally. Without measuring baseline variance, any threshold is guesswork — too strict (never converges) or too loose (misses real regressions).
3. **No cross-run comparison**: Each pipeline run is evaluated in isolation. There's no mechanism to compare run N's outcomes against run N-1 for the same story.
4. **No shadow execution**: The only way to validate a substrate change is to run it against a real project and eyeball the results. There's no automated "run against ynab, compare to last validated run."
5. **No autonomous session mode**: Even with retry, the orchestrator still processes one story at a time with human oversight between batches. There's no "run all of Sprint 2 and come back when it's done or stuck."

### Why this matters

This epic is the transition from "substrate as a tool the human operates" to "substrate as an autonomous development system the human supervises." The validation harness (Epic 33) makes individual story execution self-correcting. This epic makes multi-story sessions and cross-version validation self-certifying.

The digital twin validation literature is clear: golden masters are the early rescue harness, replay validates real traffic shapes, parallel run validates sustained equivalence before authority transfer. For substrate, the analogues are: baselines are golden masters, shadow runs are replay, and autonomous sessions are the parallel-run period where the system proves it can operate independently before the human fully delegates.

## Scope

### In Scope

- **Level 4: Semantic Diff / Golden Master** — Compare story outputs against stored baselines using structural/semantic comparison, not textual diff
- **Level 5: Live Shadow Run** — Execute pipeline against reference project (ynab), compare outputs to last validated run
- **Baseline capture**: Record golden master from a validated passing run (`substrate validate --capture-baseline`)
- **Noise floor calibration**: Run same story twice with no changes, measure natural variance (`substrate validate --calibrate`)
- **Semantic comparison engine**: Structural diff of pipeline output properties (AC verdicts, file lists, severity distributions, token envelopes) with divergence tolerance
- **Cross-run regression detection**: Compare run N outputs to run N-1 for the same stories
- **Autonomous session mode**: `substrate run --autonomous` — process multiple stories with full validation cascade, retry, and self-correction; escalate only what can't be auto-resolved; produce a session report at end
- **Session budget controls**: Max retries per story, max total cost, max wall-clock time, max consecutive escalations before pause

### Out of Scope

- Automatic prompt rewriting based on regression detection (future — Epic 30 feedback loop is prerequisite)
- Multi-project shadow validation (start with single reference project)
- Statistical learning across 100+ runs (not enough data yet)
- Performance/latency regression detection (behavioral equivalence only)

## Architecture

### Validation Cascade Extension

Adds Levels 4-5 to the cascade from Epic 33:

```
┌────────────────────────────────────────────────────────┐
│  Levels 0-3: From Epic 33                              │
│  (structural, build, test, invariant)                  │
├────────────────────────────────────────────────────────┤
│  Level 4: Semantic Diff / Golden Master                │
│  "Are outcomes equivalent to known baseline?"          │
│  - Compare against stored baseline run                 │
│  - Structural property diff, not textual diff          │
│  - Approved-divergence registry filters noise          │
│  - Noise floor from calibration suppresses variance    │
│  Cost: <1s, requires baseline to exist                 │
│  Retry scope: partial to full                          │
├────────────────────────────────────────────────────────┤
│  Level 5: Live Shadow Run                              │
│  "Does it work against a real project?"                │
│  - Execute pipeline against reference project          │
│  - Compare outputs to previous validated run           │
│  - Full end-to-end behavioral check                    │
│  Cost: 5-40min, ~$1-5, non-deterministic              │
│  Retry: NO — escalate to human                         │
└────────────────────────────────────────────────────────┘
```

### Baseline Data Model

```typescript
interface StoryBaseline {
  storyKey: string
  capturedAt: string               // ISO timestamp
  substrateVersion: string
  modelConfig: Record<string, string>  // model routing snapshot

  // Structural properties (what we diff)
  acVerdicts: Record<string, boolean>  // AC1: true, AC2: true, ...
  filesModified: string[]
  filesCreated: string[]
  testsAdded: number
  testsPassing: boolean
  buildPassing: boolean
  codeReviewSeverity: { blockers: number, majors: number, minors: number }
  totalTokens: number
  cacheHitRate: number
  dispatchCount: number
}

interface NoiseProfile {
  storyKey: string
  calibratedAt: string
  runs: number                     // how many calibration runs (minimum 2)

  // Variance bounds per property
  tokenVariance: { mean: number, stddev: number, maxObserved: number }
  cacheHitVariance: { mean: number, stddev: number }
  testCountVariance: { min: number, max: number }
  reviewSeverityVariance: { blockerRange: [number, number], majorRange: [number, number] }
}
```

### Semantic Comparison Engine

Not textual diff. Property-level structural comparison with tolerance:

```typescript
interface SemanticDiff {
  property: string                 // e.g., "acVerdicts.AC3", "totalTokens"
  baseline: unknown
  observed: unknown
  withinNoise: boolean             // within calibrated noise floor
  withinDivergence: boolean        // within approved-divergence registry
  verdict: 'match' | 'acceptable' | 'regression'
}
```

Comparison ladder (from the digital twin literature):
1. **Exact match**: Boolean/enum properties (AC verdicts, build pass/fail)
2. **Structural equivalence**: File lists (same set, order irrelevant)
3. **Envelope match**: Numeric properties within noise floor + divergence tolerance
4. **Semantic equivalence**: Severity distributions (no new blockers, minors may vary)

### Autonomous Session Mode

```
substrate run --autonomous --stories 5-1,5-2,5-3,5-4,5-5 \
  --max-retries-per-story 3 \
  --max-cost 20 \
  --max-time 4h \
  --max-consecutive-escalations 2

Flow:
  for each story:
    dispatch → validate (levels 0-3) → retry if needed → pass or escalate
    if passed and baseline exists:
      run level 4 (semantic diff) → warn on regression, don't block
    accumulate session report

  session budget checks after each story:
    total cost exceeded? → pause, report
    wall-clock exceeded? → pause, report
    N consecutive escalations? → pause, report (likely systemic issue)

  on completion:
    produce session report:
      - stories: X passed, Y retried-then-passed, Z escalated
      - total cost, wall-clock time
      - behavioral regressions detected (if baselines exist)
      - retry efficiency (% of retries that succeeded)
      - recommended actions for escalated stories
```

### Module Structure

```
src/modules/validation/
  # From Epic 33:
  harness.ts, types.ts, remediation.ts, divergence-registry.ts
  levels/structural.ts, build.ts, test-suite.ts, invariants.ts

  # New in Epic 34:
  levels/
    semantic-diff.ts            # Level 4: golden master comparison
    shadow-run.ts               # Level 5: live execution + comparison
  baselines/
    capture.ts                  # Record baseline from passing run
    store.ts                    # Baseline storage (Dolt table)
    compare.ts                  # Semantic comparison engine
  calibration/
    noise-profile.ts            # Noise floor measurement + storage
    calibrator.ts               # Run-twice-and-measure orchestration
  session/
    autonomous-runner.ts        # Multi-story autonomous session loop
    budget.ts                   # Cost, time, escalation budget tracking
    report.ts                   # Session report generation
```

## Story Map

```
Sprint 1 — Baselines & Semantic Diff (P1):
  Story 34-1: Baseline Capture + Storage (P1, M)
  Story 34-2: Semantic Comparison Engine (P1, L)
  Story 34-3: Level 4 — Golden Master Validation Level (P1, M)
  Story 34-4: Noise Floor Calibration (P1, L)

Sprint 2 — Shadow Run & Autonomous Sessions (P1):
  Story 34-5: Level 5 — Shadow Run Validation Level (P1, L)
  Story 34-6: Autonomous Session Runner (P1, XL)
  Story 34-7: Session Budget Controls + Reporting (P1, M)
  Story 34-8: CLI Integration — validate, calibrate, autonomous flags (P2, M)
```

## Story Details

### Story 34-1: Baseline Capture + Storage (P1, M)

**Problem:** No mechanism to record a "known-good" run's outputs as a reference point for future comparison.

**Acceptance Criteria:**
- AC1: `substrate validate --capture-baseline <story-key>` captures the current story's output properties as a StoryBaseline.
- AC2: Baseline is stored in Dolt (baselines table) with story key, timestamp, substrate version, and model config snapshot.
- AC3: Baseline captures: AC verdicts, files modified/created, test count, build/test pass status, code review severity distribution, token usage, cache hit rate, dispatch count.
- AC4: Only one active baseline per story key — new capture replaces previous (with Dolt versioning preserving history).
- AC5: Baseline capture fails if the story's current state is not SHIP_IT or COMPLETE (only baseline validated runs).
- AC6: `substrate validate --show-baseline <story-key>` displays the stored baseline.
- AC7: Tests: capture from passing story, reject non-passing, storage/retrieval, replacement.

**Tasks:**
- [ ] Define StoryBaseline type and Dolt schema
- [ ] Implement baseline capture from story state + validation results
- [ ] Implement baseline storage in Dolt
- [ ] Add --capture-baseline and --show-baseline to validate CLI
- [ ] Guard against baselining non-validated stories
- [ ] Tests: capture, reject, store, retrieve, replace

---

### Story 34-2: Semantic Comparison Engine (P1, L)

**Problem:** Comparing LLM pipeline outputs requires structural/semantic comparison, not textual diff. Need a comparison engine that understands property types and applies appropriate comparison strategies.

**Acceptance Criteria:**
- AC1: `SemanticComparator` class with `compare(baseline, observed, noiseProfile?, divergenceRegistry?): SemanticDiff[]`.
- AC2: Comparison strategies by property type: exact match (booleans, enums), set equality (file lists), envelope match (numerics), distribution match (severity counts).
- AC3: Noise profile integration: properties within calibrated variance marked `withinNoise: true`.
- AC4: Divergence registry integration: properties within approved tolerance marked `withinDivergence: true`.
- AC5: Each SemanticDiff has a verdict: `match` (identical), `acceptable` (within noise/tolerance), `regression` (outside bounds).
- AC6: Summary method: `hasRegression()`, `regressionCount()`, `acceptableDivergenceCount()`.
- AC7: Tests: exact property match, set comparison (order-independent), numeric envelope, severity distribution, noise suppression, divergence suppression, regression detection.

**Tasks:**
- [ ] Define SemanticDiff type and comparison strategy interfaces
- [ ] Implement exact match strategy
- [ ] Implement set equality strategy
- [ ] Implement envelope match strategy with noise profile
- [ ] Implement distribution match strategy
- [ ] Implement SemanticComparator with strategy selection per property
- [ ] Integrate noise profile and divergence registry
- [ ] Tests: all strategies, integration, edge cases

---

### Story 34-3: Level 4 — Golden Master Validation Level (P1, M)

**Problem:** Levels 0-3 check "does it work?" but not "does it produce equivalent outcomes to what we've seen before?" Need a validation level that compares against stored baselines.

**Acceptance Criteria:**
- AC1: Implements ValidationLevel from Epic 33 harness.
- AC2: Loads baseline for story key from Dolt. If no baseline exists, level is skipped (not failed).
- AC3: Loads noise profile if calibrated. If not calibrated, uses conservative defaults.
- AC4: Runs SemanticComparator against baseline and current outputs.
- AC5: Level passes if no regressions detected. Acceptable divergences are logged at info level.
- AC6: Level fails if regressions detected. RemediationContext includes regression list with property, expected, observed.
- AC7: `canAutoRemediate` is false for semantic regressions (these indicate behavioral drift, not simple bugs).
- AC8: Tests: no baseline (skip), match, acceptable divergence, regression, noise suppression.

**Tasks:**
- [ ] Implement GoldenMasterValidator as ValidationLevel
- [ ] Baseline loading with graceful skip
- [ ] Noise profile loading with defaults
- [ ] SemanticComparator integration
- [ ] RemediationContext for regressions
- [ ] Tests: skip, match, divergence, regression

---

### Story 34-4: Noise Floor Calibration (P1, L)

**Problem:** Without measuring natural LLM output variance, validation thresholds are guesswork. Need to run the same story twice and measure what varies.

**Acceptance Criteria:**
- AC1: `substrate validate --calibrate <story-key>` runs the story's pipeline phase twice with identical configuration.
- AC2: Captures both runs' output properties and computes variance per property.
- AC3: Stores NoiseProfile in Dolt with story key, calibration timestamp, run count, and per-property variance stats.
- AC4: Variance computation: mean, stddev, min/max observed for numeric properties; range for count properties.
- AC5: Calibration requires minimum 2 runs. Additional `--calibrate-runs N` flag allows more runs for tighter variance estimates.
- AC6: Calibration is per-story-key (different stories may have different variance characteristics).
- AC7: `substrate validate --show-noise <story-key>` displays stored noise profile.
- AC8: Tests: two-run calibration, multi-run calibration, storage/retrieval, variance computation accuracy.

**Tasks:**
- [ ] Define NoiseProfile type and Dolt schema
- [ ] Implement calibration runner (execute pipeline N times)
- [ ] Implement variance computation per property
- [ ] Implement noise profile storage in Dolt
- [ ] Add --calibrate, --calibrate-runs, --show-noise to validate CLI
- [ ] Tests: two-run, multi-run, variance math, storage

---

### Story 34-5: Level 5 — Shadow Run Validation Level (P1, L)

**Problem:** Levels 0-4 validate against the current project. Level 5 validates against a reference project — "does a substrate change break real-world pipeline execution?"

**Acceptance Criteria:**
- AC1: Implements ValidationLevel from Epic 33 harness.
- AC2: Executes pipeline against a configured reference project (default: ynab at a pinned commit).
- AC3: Runs a predefined set of stories against the reference project.
- AC4: Compares results to stored baselines for those stories in the reference project.
- AC5: Reference project config in `.substrate/validation/shadow.yaml`: project path, stories, expected outcomes.
- AC6: Level passes if all reference stories complete with equivalent outcomes to their baselines.
- AC7: Level fails with detailed comparison report. `canAutoRemediate` is always false (escalate to human).
- AC8: Timeout of 30 minutes for shadow execution.
- AC9: Shadow run is opt-in — only runs if explicitly requested via `--level 5` or `--shadow` flag.
- AC10: Tests: mock shadow execution, baseline comparison, timeout handling, opt-in behavior.

**Tasks:**
- [ ] Implement ShadowRunValidator as ValidationLevel
- [ ] Shadow project configuration loader
- [ ] Pipeline execution against external project
- [ ] Baseline comparison for shadow stories
- [ ] Shadow report generation
- [ ] Timeout handling
- [ ] Opt-in gating
- [ ] Tests: mock execution, comparison, timeout, opt-in

---

### Story 34-6: Autonomous Session Runner (P1, XL)

**Problem:** The orchestrator processes stories with human oversight between batches. Need a mode that runs multiple stories autonomously with full validation, retry, and self-correction — only surfacing when stuck.

**Acceptance Criteria:**
- AC1: `substrate run --autonomous` processes all specified stories in sequence with full validation cascade + retry on each.
- AC2: Stories that pass validation (including retries) proceed to SHIP_IT automatically.
- AC3: Stories that exhaust retry budget are marked as ESCALATED and logged, but session continues with remaining stories.
- AC4: Session pauses (not aborts) when budget limits are hit (cost, time, consecutive escalations).
- AC5: On session completion or pause, produces a structured session report.
- AC6: Session state is persisted in Dolt — can be resumed after a pause with `substrate run --autonomous --resume`.
- AC7: Each story dispatch includes context from the session: "Story 3 of 5. Stories 1-2 completed successfully. No systemic issues detected."
- AC8: Pipeline events emitted: `session:started`, `session:story-complete`, `session:story-escalated`, `session:paused`, `session:complete`.
- AC9: Tests: multi-story session, retry within session, escalation continues, budget pause, resume, event emission.

**Tasks:**
- [ ] Implement AutonomousSessionRunner
- [ ] Wire validation cascade + retry loop per story
- [ ] Implement session-level story progression logic
- [ ] Session state persistence in Dolt for resume
- [ ] Session context injection into dispatch prompts
- [ ] Pipeline event emission for session lifecycle
- [ ] Tests: full session, retry, escalation, budget, resume

---

### Story 34-7: Session Budget Controls + Reporting (P1, M)

**Problem:** Autonomous sessions need guardrails to prevent runaway cost, time, or cascading failures.

**Acceptance Criteria:**
- AC1: Configurable budget: `--max-retries-per-story N` (default 3), `--max-cost $N` (default $20), `--max-time Nh` (default 4h), `--max-consecutive-escalations N` (default 2).
- AC2: Budget checks after each story completion. Exceeded → session pauses with reason.
- AC3: Consecutive escalation check: N escalations in a row suggests systemic issue (bad baseline, broken config), not individual story problems. Pause and surface.
- AC4: Session report includes: stories passed/retried/escalated, total cost, wall-clock time, retry efficiency (% retries that succeeded), behavioral regressions detected, recommended actions for escalated stories.
- AC5: Report available as JSON (`--json`) and formatted text.
- AC6: Report persisted in Dolt alongside session state.
- AC7: Tests: each budget trigger, consecutive escalation detection, report generation, JSON output.

**Tasks:**
- [ ] Implement SessionBudget tracker
- [ ] Budget check integration in AutonomousSessionRunner
- [ ] Consecutive escalation detection
- [ ] Session report generator
- [ ] JSON + formatted output
- [ ] Dolt persistence for reports
- [ ] Tests: all budget triggers, report content, JSON format

---

### Story 34-8: CLI Integration — validate, calibrate, autonomous flags (P2, M)

**Problem:** New capabilities need CLI surface: baseline capture, noise calibration, show commands, and autonomous run mode.

**Acceptance Criteria:**
- AC1: `substrate validate --capture-baseline <story>` — capture baseline from validated story.
- AC2: `substrate validate --show-baseline <story>` — display stored baseline.
- AC3: `substrate validate --calibrate <story>` — run noise floor calibration.
- AC4: `substrate validate --calibrate-runs N <story>` — multi-run calibration.
- AC5: `substrate validate --show-noise <story>` — display noise profile.
- AC6: `substrate validate --level N <story>` — run cascade up to level N.
- AC7: `substrate validate --shadow` — include Level 5 shadow run.
- AC8: `substrate run --autonomous` — autonomous session mode with all budget flags.
- AC9: All commands support `--json` / `--output-format json`.
- AC10: Help text documents all new flags with examples.
- AC11: Registered in CLI index.ts.
- AC12: Tests: all command variations, flag parsing, help output.

**Tasks:**
- [ ] Extend validate command with baseline/calibrate/noise subcommands
- [ ] Add --level and --shadow flags
- [ ] Add --autonomous flag to run command
- [ ] Wire budget flags (--max-retries-per-story, --max-cost, --max-time, --max-consecutive-escalations)
- [ ] JSON output for all new commands
- [ ] Help text and examples
- [ ] Register in CLI index.ts
- [ ] Tests: all commands, flags, output formats

## Dependencies

- **Epic 33** (DEFERRED): Validation harness foundation — Levels 0-3, retry loop, divergence registry, `substrate validate` base command.
- **Epic 29** (COMPLETE): Dolt persistence for baselines, noise profiles, and session state.
- **Epic 27-28** (COMPLETE): Telemetry for token/cache metrics used in baselines.
- **Reference project**: ynab at a known-good state for shadow validation.

## Estimated Effort

- **Sprint 1**: 4 stories (34-1 through 34-4), ~1.5 weeks. Delivers baseline capture + semantic diff + noise calibration.
- **Sprint 2**: 4 stories (34-5 through 34-8), ~1.5 weeks. Delivers shadow run + autonomous sessions + CLI.
- **Total**: 8 stories, 2 sprints (~3 weeks).

## Success Criteria

1. `substrate validate --capture-baseline 5-1` records a golden master from a validated story.
2. `substrate validate --calibrate 5-1` runs twice, measures variance, stores noise profile.
3. After a prompt change, `substrate validate 5-1` detects behavioral regression at Level 4 and reports which properties diverged.
4. `substrate validate --shadow` runs against ynab and compares to stored baselines.
5. `substrate run --autonomous --stories 5-1,5-2,5-3` processes all three stories, retries failures, escalates what it can't fix, and produces a session report showing "2 passed, 1 escalated, 4 retries total, 75% retry success rate."
6. Autonomous session pauses after 2 consecutive escalations with a clear "systemic issue suspected" message.

## Risks

- **Calibration cost**: Running stories twice for noise measurement is expensive ($2-10 per story). Mitigation: calibrate only critical stories, share profiles across similar story types.
- **Baseline staleness**: Baselines captured under one model config become stale when models improve. Mitigation: include substrate version and model config in baseline metadata, flag baselines older than configurable threshold.
- **Shadow project maintenance**: ynab at a pinned commit may diverge from substrate's current capabilities. Mitigation: maintain a dedicated validation branch in ynab, update periodically.
- **Autonomous session scope creep**: The temptation to make the autonomous runner handle every edge case. Mitigation: start with the simple sequential loop, add sophistication only when observed failure modes demand it.
- **Non-determinism floor**: LLM variance may be so high for some stories that meaningful regression detection is impossible. Mitigation: noise calibration will reveal this — stories with extreme variance should be excluded from Level 4 golden master validation and rely on Levels 0-3 only.

## Connection to Digital Twin Validation Literature

This epic operationalizes the key findings from the digital twin validation research synthesis:

| Literature Pattern | Substrate Implementation |
|---|---|
| Golden master / snapshot twin | Baseline capture from validated runs |
| Diffy noise estimation | Noise floor calibration (run twice, measure variance) |
| Semantic diffing / normalized comparison | SemanticComparator with property-type-aware strategies |
| Approved-divergence registry | From Epic 33, consumed by Level 4 |
| Parallel run / dual-run validation | Shadow run against reference project |
| Confidence gating | Session budget controls + escalation thresholds |
| Thin-slice modernization twin | Per-story baselines, not whole-estate modeling |
| "AI is accelerator, not authority" | Agents produce, harness validates deterministically |
