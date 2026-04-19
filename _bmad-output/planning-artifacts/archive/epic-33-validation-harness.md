# Epic 33: Validation Harness — Verification-Driven Autonomy Foundation

**Status: DEFERRED — Design complete, not yet scheduled**

## Vision

Build a layered validation cascade that enables the orchestrator to self-correct agent outputs without human intervention. Today, the human operator is the validation oracle — manually running smoke tests, checking CI, performing live runs, and fixing issues. This epic replaces that human loop with a deterministic, structured validation layer that the orchestrator can invoke after every dispatch, retry on failure with surgical remediation context, and escalate only when automated correction is exhausted.

The validation harness is not a test framework. It is the **constraint surface that makes unbounded agent execution safe**. With it, the orchestrator gains a validate-and-retry envelope: dispatch → validate → fail? → re-dispatch with structured failure context → validate again → pass or escalate.

Inspired by the "digital twin" validation stack from modernization literature: discovery → behavior capture → isolation → comparison → confidence gating. Adapted for non-deterministic AI pipeline outputs where exact diffing is meaningless and semantic equivalence is the only useful comparison.

## Rationale

### What we have

- Dolt state layer with per-story branching and rollback (Epic 26, 29)
- Telemetry ingestion with turn-level token breakdowns (Epic 27-28)
- Build verification gate (existing in orchestrator)
- Code review with severity-based verdicts (existing)
- Zod schemas defining structured output contracts for all pipeline phases (DevStoryResult, CodeReviewResult, CreateStoryResult)

### What's missing

1. **No retry-with-context loop**: When build fails or tests fail, the orchestrator escalates to the human. It doesn't feed the compiler error back to the agent and re-dispatch.
2. **No structured remediation contract**: Failures are pass/fail. There's no structured payload telling the agent *exactly* what broke, where, and what scope of fix is needed.
3. **No cascading validation levels**: Build verification exists but there's no ordered cascade of checks from cheap (schema validation) to expensive (test suite), short-circuiting on first failure.
4. **No behavioral invariant checking**: No mechanism to verify that story outputs match expected structural properties (correct files modified, ACs addressed, no unexpected deletions).
5. **No approved-divergence registry**: Every natural LLM output variation would trigger false failures without explicit tolerance configuration.

### Why this matters

The human-in-the-loop validation bottleneck is the primary constraint on pipeline throughput and autonomy. Eliminating it for the 60-70% of failures that are mechanically remediable (type errors, test failures, malformed output) unlocks significantly longer autonomous sessions. The remaining 30-40% (genuine design issues, ambiguous requirements) correctly escalate to human judgment.

### Conceptual grounding

The digital twin validation literature identifies a five-layer stack: discovery, behavior capture, isolation, comparison logic, and confidence gating. For substrate:
- **Discovery** → Work graph + story discovery (existing)
- **Capture** → Telemetry + Zod-structured outputs (existing)
- **Isolation** → Dolt branches per story (existing)
- **Comparison** → This epic: validation cascade + semantic checking
- **Gating** → This epic: retry loop with budget + escalation rules

Key insight from the literature: "exact diffing is adequate only for outputs that are stable, deterministic, and structurally simple." LLM pipeline outputs are none of those. Validation must operate at the semantic/structural level, with an approved-divergence registry to suppress false positives from natural output variation.

## Scope

### In Scope

- `ValidationHarness` interface with cascading level runner
- Level 0: Structural output validation (Zod schema parse, required files exist)
- Level 1: Build verification (`tsc --noEmit` + `npm run build`)
- Level 2: Test suite execution (`npm run test:fast` with vitest output parsing)
- Level 3: Behavioral invariant checking (AC verdicts match spec, files modified match tasks, no unexpected regressions, token/cost within envelope)
- `RemediationContext` structured payload with failure category, location, evidence, and suggested scope
- Retry loop in orchestrator with configurable budget per story
- Scope narrowing: surgical (one file fix) vs partial (multi-file) vs full (re-implementation)
- Approved-divergence registry (YAML config for acceptable variation thresholds)
- `substrate validate <story>` CLI command for manual cascade execution

### Out of Scope

- Level 4: Golden master / semantic diff (Epic 34)
- Level 5: Live shadow run (Epic 34)
- Noise floor calibration (Epic 34)
- Long-running autonomous session mode (Epic 34)
- Cross-version regression (Epic 34)
- Prompt/model change impact analysis (Epic 34)

## Architecture

### Core Loop Change

```
Before:
  dispatch → result → verdict → escalate or ship

After:
  dispatch → result → VALIDATION CASCADE → pass? → ship
                ↑                │
                │          fail + remediable?
                │                │
                └── re-dispatch ←┘ (with RemediationContext)

           retry budget exhausted or non-remediable → escalate
```

### Validation Cascade (Short-Circuiting)

```
┌────────────────────────────────────────────────────────┐
│  Level 0: Structural Output Validation                 │
│  - Zod schema parse on phase result                    │
│  - Required files exist on disk                        │
│  - Story status updated correctly                      │
│  Cost: <100ms │ Retry scope: surgical                  │
├────────────────────────────────────────────────────────┤
│  Level 1: Build Verification                           │
│  - tsc --noEmit                                        │
│  - npm run build                                       │
│  Cost: 1-5s │ Retry scope: surgical                    │
├────────────────────────────────────────────────────────┤
│  Level 2: Test Suite                                   │
│  - npm run test:fast                                   │
│  - Parse vitest output for failing tests               │
│  Cost: 60-90s │ Retry scope: surgical to partial       │
├────────────────────────────────────────────────────────┤
│  Level 3: Behavioral Invariants                        │
│  - AC verdicts match story spec                        │
│  - Files modified match task list                      │
│  - No unexpected file deletions                        │
│  - Token/cost within configured envelope               │
│  Cost: <1s │ Retry scope: partial to full              │
└────────────────────────────────────────────────────────┘
```

Cascade short-circuits: fail at Level 1 → skip Levels 2-3. Cheapest checks first.

### RemediationContext Contract

```typescript
interface RemediationContext {
  level: ValidationLevel                     // which level failed
  failures: {
    category: 'schema' | 'build' | 'test' | 'invariant'
    description: string                      // human-readable summary
    location?: string                        // file:line if applicable
    evidence: string                         // compiler output, test output, diff
    suggestedAction?: string                 // "fix type error" vs "rethink approach"
  }[]
  retryBudget: { spent: number, remaining: number }
  scope: 'surgical' | 'partial' | 'full'    // how much to re-do
  canAutoRemediate: boolean                  // false → escalate immediately
}
```

The `scope` field controls re-dispatch strategy:
- `surgical`: One file, one error. Agent gets a minimal prompt with just the error and the file.
- `partial`: Multiple related failures. Agent gets the full failure list scoped to affected files.
- `full`: Fundamental AC mismatch or structural issue. Full re-implementation dispatch.

### Approved-Divergence Registry

YAML configuration in `.substrate/validation/divergences.yaml`:

```yaml
approved-divergences:
  token-variance:
    level: invariant
    metric: total_tokens
    threshold: 2.0x           # up to 2x baseline is acceptable

  test-count-variance:
    level: invariant
    metric: new_test_count
    threshold: "±3"           # minor test count variation ok

  review-severity:
    level: invariant
    rule: "no new blockers; minor count may vary ±2"
```

### Module Structure

```
src/modules/validation/
  harness.ts                  # ValidationHarness interface + cascade runner
  types.ts                    # ValidationResult, RemediationContext, ValidationLevel
  levels/
    structural.ts             # Level 0: Zod output validation
    build.ts                  # Level 1: tsc + build execution
    test-suite.ts             # Level 2: vitest runner + output parser
    invariants.ts             # Level 3: AC/file/cost checks
  remediation.ts              # RemediationContext builder from failures
  divergence-registry.ts      # Approved-divergence loader + matcher
  index.ts                    # Public exports

src/modules/implementation-orchestrator/
  orchestrator-impl.ts        # Modified: validate-and-retry loop
  retry-strategy.ts           # Budget allocation, scope narrowing, backoff
```

## Story Map

```
Sprint 1 — Harness Foundation + Cheap Checks (P0):
  Story 33-1: ValidationHarness Interface + Cascade Runner (P0, M)
  Story 33-2: Level 0 — Structural Output Validation (P0, S)
  Story 33-3: Level 1 — Build Verification Level (P0, M)
  Story 33-4: RemediationContext Builder + Retry Loop (P0, L)

Sprint 2 — Expensive Checks + Divergence Tolerance (P1):
  Story 33-5: Level 2 — Test Suite Validation Level (P1, M)
  Story 33-6: Level 3 — Behavioral Invariant Checking (P1, M)
  Story 33-7: Approved-Divergence Registry (P1, M)
  Story 33-8: CLI `substrate validate` Command (P2, S)
```

## Story Details

### Story 33-1: ValidationHarness Interface + Cascade Runner (P0, M)

**Problem:** No structured way to run ordered validation checks against a story's outputs. Validation is ad-hoc and baked into the orchestrator's verdict logic.

**Acceptance Criteria:**
- AC1: `ValidationHarness` interface with `runCascade(story, result, attempt): Promise<ValidationResult>`.
- AC2: `ValidationResult` type with `passed`, `level` (highest level reached), `failures`, `canAutoRemediate`, `remediationContext`.
- AC3: Cascade runner executes levels 0→N in order, short-circuits on first failure.
- AC4: Each validation level implements `ValidationLevel` interface: `run(context): Promise<LevelResult>`.
- AC5: Levels are registered via configuration, not hardcoded — new levels can be added without modifying the runner.
- AC6: Cascade respects `maxLevel` config — can run only levels 0-1 for fast feedback or 0-3 for full validation.
- AC7: All level execution is timed and logged at debug level.
- AC8: Full unit test coverage for cascade short-circuit behavior, level ordering, and maxLevel config.

**Tasks:**
- [ ] Define ValidationHarness, ValidationResult, ValidationLevel, LevelResult types
- [ ] Implement CascadeRunner with ordered level execution and short-circuit
- [ ] Implement level registration and maxLevel configuration
- [ ] Add timing and debug logging
- [ ] Tests: cascade ordering, short-circuit on failure, maxLevel, all-pass, mixed results

---

### Story 33-2: Level 0 — Structural Output Validation (P0, S)

**Problem:** Agents sometimes produce malformed output that doesn't parse against the expected Zod schema, or fail to create required files. This is the cheapest possible check.

**Acceptance Criteria:**
- AC1: Validates agent output against the appropriate Zod schema (DevStoryResult, CodeReviewResult, CreateStoryResult) based on task type.
- AC2: Checks that files listed in `files_modified` actually exist on disk.
- AC3: Checks that story file was updated with expected status.
- AC4: Produces remediation context with schema parse errors or missing file paths.
- AC5: Execution time < 100ms.
- AC6: Tests cover valid output, malformed output, missing files, and wrong status.

**Tasks:**
- [ ] Implement StructuralValidator as ValidationLevel
- [ ] Schema selection logic by task type
- [ ] File existence checks
- [ ] Story status verification
- [ ] Remediation context generation with parse error details
- [ ] Tests: valid, malformed, missing files, wrong status

---

### Story 33-3: Level 1 — Build Verification Level (P0, M)

**Problem:** Build verification exists in the orchestrator but it's not a pluggable validation level. It can't participate in the cascade or produce structured remediation context.

**Acceptance Criteria:**
- AC1: Wraps `tsc --noEmit` and `npm run build` as a ValidationLevel.
- AC2: Parses TypeScript compiler output to extract file, line, and error message for each diagnostic.
- AC3: Produces RemediationContext with `category: 'build'`, exact file:line locations, and compiler error text as evidence.
- AC4: `scope` is `surgical` when errors are in ≤2 files, `partial` when >2 files.
- AC5: Timeout of 30s for build step (prevents hangs).
- AC6: Tests: clean build passes, type error produces structured remediation, multi-file errors produce partial scope.

**Tasks:**
- [ ] Implement BuildValidator as ValidationLevel
- [ ] TypeScript diagnostic parser (file, line, message extraction)
- [ ] RemediationContext builder for build failures
- [ ] Scope determination logic (surgical vs partial)
- [ ] Timeout handling
- [ ] Tests: pass, single error, multi-file errors, timeout

---

### Story 33-4: RemediationContext Builder + Retry Loop (P0, L)

**Problem:** The orchestrator has no mechanism to retry a failed dispatch with structured failure context. Failed stories escalate immediately.

**Acceptance Criteria:**
- AC1: `RetryStrategy` class with configurable budget per story (default: 3 attempts).
- AC2: `RetryStrategy.shouldRetry(validation)` returns true when `canAutoRemediate && budget remaining`.
- AC3: Orchestrator's dispatch flow wraps in retry loop: dispatch → validate → retry or escalate.
- AC4: Re-dispatch prompt includes remediation context: which level failed, what specifically broke, evidence text, and suggested fix scope.
- AC5: Retry scope narrows the dispatch: `surgical` retries send only the error + affected file, not the full story prompt.
- AC6: Retry attempts are logged at info level with attempt number and scope.
- AC7: Pipeline events emitted: `story:validation-failed`, `story:retry-dispatch`, `story:retry-exhausted`.
- AC8: When retry budget exhausted, escalation includes all accumulated validation failures across attempts.
- AC9: Tests: successful retry after build failure, retry budget exhaustion, scope narrowing across attempts, escalation with accumulated context.

**Tasks:**
- [ ] Implement RetryStrategy with configurable budget
- [ ] Modify orchestrator dispatch flow to wrap in retry loop
- [ ] Build remediation-aware re-dispatch prompt construction
- [ ] Implement scope-based prompt narrowing (surgical vs partial vs full)
- [ ] Add pipeline events for retry lifecycle
- [ ] Accumulate failures across attempts for escalation context
- [ ] Tests: retry success, budget exhaustion, scope narrowing, event emission

---

### Story 33-5: Level 2 — Test Suite Validation Level (P1, M)

**Problem:** Test suite execution happens outside the validation cascade. Failed tests are discovered by humans, not fed back to agents as structured remediation.

**Acceptance Criteria:**
- AC1: Wraps `npm run test:fast` as a ValidationLevel.
- AC2: Parses vitest output to extract: total tests, passed, failed, failing test names, and failure messages.
- AC3: Produces RemediationContext with `category: 'test'`, failing test file:name, and assertion error as evidence.
- AC4: `scope` is `surgical` when ≤3 tests fail in ≤2 files, `partial` when >3 tests or >2 files, `full` when >50% of new tests fail.
- AC5: Timeout of 300s for test execution.
- AC6: Does not run if Level 1 (build) failed — cascade short-circuit ensures this.
- AC7: Tests: all pass, single failure, multi-file failures, timeout, vitest output parsing.

**Tasks:**
- [ ] Implement TestSuiteValidator as ValidationLevel
- [ ] Vitest output parser (test counts, failure details extraction)
- [ ] RemediationContext builder for test failures
- [ ] Scope determination logic
- [ ] Timeout handling
- [ ] Tests: pass, single failure, multi-file, timeout, parser edge cases

---

### Story 33-6: Level 3 — Behavioral Invariant Checking (P1, M)

**Problem:** Even when build and tests pass, the agent output may violate higher-level behavioral expectations: wrong ACs marked as met, unexpected files deleted, token cost way above baseline.

**Acceptance Criteria:**
- AC1: Checks AC verdicts in agent output match the story spec's acceptance criteria list.
- AC2: Checks files listed as modified exist and were actually changed (git diff check).
- AC3: Checks for unexpected file deletions not listed in the task plan.
- AC4: Checks token usage against configured envelope (default 2x median for task type, from telemetry if available).
- AC5: Consults approved-divergence registry (33-7) to suppress known acceptable variations. If registry not yet available, all invariant checks use hardcoded defaults.
- AC6: Produces RemediationContext with `category: 'invariant'`, specific invariant violated, and evidence.
- AC7: `canAutoRemediate` is false for AC mismatches (requires human judgment), true for file/cost issues.
- AC8: Tests: all invariants pass, AC mismatch, unexpected deletion, token spike, divergence suppression.

**Tasks:**
- [ ] Implement InvariantValidator as ValidationLevel
- [ ] AC verdict matching logic (story spec parser)
- [ ] File modification verification via git diff
- [ ] Unexpected deletion detection
- [ ] Token envelope checking with telemetry integration
- [ ] Divergence registry integration (with fallback defaults)
- [ ] Tests: pass, AC mismatch, deletion, token spike, divergence suppression

---

### Story 33-7: Approved-Divergence Registry (P1, M)

**Problem:** Natural LLM output variation triggers false validation failures. Without explicit tolerance configuration, the retry loop either never converges (too strict) or misses real regressions (too loose).

**Acceptance Criteria:**
- AC1: YAML configuration file at `.substrate/validation/divergences.yaml`.
- AC2: Schema supports metric-based thresholds (e.g., `token_variance: 2.0x`), count-based thresholds (e.g., `±3`), and rule-based suppressions (e.g., "no new blockers").
- AC3: `DivergenceRegistry` class loads and validates the YAML config.
- AC4: `DivergenceRegistry.isAcceptable(check, observed, baseline)` returns whether a divergence falls within approved bounds.
- AC5: Default registry ships with sensible defaults for token variance, test count variance, and review severity tolerance.
- AC6: Registry is hot-loadable — changes to the YAML file take effect on next validation run without restart.
- AC7: Unrecognized divergence entries are logged as warnings (forward compatibility).
- AC8: Tests: threshold matching, count matching, rule matching, default loading, invalid config handling.

**Tasks:**
- [ ] Define divergence YAML schema
- [ ] Implement DivergenceRegistry loader + validator
- [ ] Implement isAcceptable with metric, count, and rule matchers
- [ ] Ship default divergences.yaml
- [ ] Hot-reload support (file mtime check on access)
- [ ] Tests: all matcher types, defaults, invalid config, hot reload

---

### Story 33-8: CLI `substrate validate` Command (P2, S)

**Problem:** No way to manually trigger the validation cascade against a completed story for debugging or calibration.

**Acceptance Criteria:**
- AC1: `substrate validate <story-key>` runs the full validation cascade against the story's current state.
- AC2: `--level <N>` flag limits cascade to levels 0-N.
- AC3: Output shows each level's result (pass/fail), execution time, and failure details if any.
- AC4: `--json` flag outputs structured JSON for programmatic consumption.
- AC5: Exit code 0 on all-pass, 1 on failure.
- AC6: Registered in CLI index.ts.
- AC7: Tests: pass output, failure output, level filtering, JSON output.

**Tasks:**
- [ ] Implement validate command with story-key argument
- [ ] Wire ValidationHarness into command
- [ ] Level filtering via --level flag
- [ ] Formatted and JSON output modes
- [ ] Register in CLI index.ts
- [ ] Tests: pass, fail, level filter, JSON mode

## Dependencies

- **Epic 29** (COMPLETE): Dolt as default persistence — validation results can be stored in versioned state.
- **Epic 27-28** (COMPLETE): Telemetry data for token envelope checking in Level 3.
- **Existing orchestrator infrastructure**: dispatch, verdict, escalation flow in `orchestrator-impl.ts`.
- **Existing Zod schemas**: DevStoryResult, CodeReviewResult, CreateStoryResult in prompt packs.

## Estimated Effort

- **Sprint 1**: 4 stories (33-1 through 33-4), ~1 week. Delivers working retry loop with Levels 0-1.
- **Sprint 2**: 4 stories (33-5 through 33-8), ~1 week. Adds test/invariant levels + divergence tolerance + CLI.
- **Total**: 8 stories, 2 sprints.

## Success Criteria

1. Orchestrator retries a story that fails build verification, feeding compiler errors to the agent, and the retry succeeds without human intervention.
2. A malformed agent output (bad Zod parse) triggers Level 0 failure with structured remediation context and successful retry.
3. A test regression is detected at Level 2, remediation context includes failing test names and assertion errors, and the agent fixes the test on retry.
4. Token usage exceeding 2x envelope triggers Level 3 invariant failure with appropriate warning.
5. Approved-divergence registry suppresses known acceptable variations without false failures.
6. `substrate validate 5-1` runs the full cascade and reports results.

## Risks

- **Retry convergence**: Agents may not fix issues on retry, creating infinite-feeling loops. Mitigation: strict budget (default 3), scope narrowing on each attempt, escalation with accumulated context.
- **Vitest output parsing brittleness**: vitest output format may change across versions. Mitigation: parser tests against captured output samples, version-pinned vitest.
- **Scope determination accuracy**: Classifying failures as surgical/partial/full is heuristic. Mitigation: start conservative (default to partial), tune based on observed retry success rates.
- **Build time in cascade**: Running `npm run test:fast` takes 60-90s per validation. In a 3-retry loop, that's 3-5 minutes of validation alone. Mitigation: Level 2 only runs if Level 1 passes; consider `test:changed` for retry attempts.
