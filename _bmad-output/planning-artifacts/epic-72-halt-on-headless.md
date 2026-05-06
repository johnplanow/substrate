# Epic 72: Decision Router (`--halt-on`) + Headless Invocation

## Vision

Stream A+B sprint plan continuation: ship the Decision Router with
`--halt-on <all|critical|none>` for autonomy gradation (Phase D Story
54-2) and headless invocation support with machine-readable exit codes
(Phase D Story 54-6). Together these enable substrate to operate in
three modes: attended (`--halt-on all`), supervised (`--halt-on critical`,
default), and autonomous (`--halt-on none --non-interactive`) — with
the latter being CI/CD-ready for unattended automation.

This epic is the **autonomy-gradation foundation** for Epic 73 (Recovery
Engine), which consumes the halt-on policy to decide whether to
auto-recover or prompt the operator. Without 72, Epic 73 has nowhere
to express "this is non-recoverable, halt for operator decision."

## Root cause it addresses

Today, substrate's run loop has implicit halt behavior:
- Cost ceiling exhaustion: hard halt with operator prompt
- Verification failure: silent escalation, no operator input
- Cross-story race recovery (Epic 70): autonomous re-run, no
  operator notice
- Build failure: hard halt
- Recovery retry (future Epic 73): would need a halt decision

There's no unified policy for **which decisions halt** vs **which
decisions proceed autonomously**. Operators can't tune the autonomy
level, and CI/CD pipelines can't run substrate non-interactively
because some halt paths read stdin.

Epic 72 introduces a Decision Router that classifies every halt-able
decision by severity (`info | warning | critical | fatal`) and
consults the `--halt-on` policy to decide whether to halt. It also
adds `--non-interactive` for full headless support: stdin prompts are
replaced by configured default actions, and the process exits with
machine-readable codes.

## Why now

Three signals:

1. **Epic 73 (Recovery Engine) blocks on this.** Recovery Engine's
   tier-A auto-retry needs a way to express "auto-recover unless
   --halt-on requires operator input."

2. **Strata + agent-mesh integrations want CI/CD invocation.**
   Cross-project validation pipelines (the strata factory; agent-mesh
   nightly builds) need exit-code-driven failure signaling. Today
   they parse `substrate run` stdout heuristically.

3. **Operator trust gradient.** New operators want supervised mode
   (default); experienced operators want full autonomy for overnight
   runs. A unified `--halt-on` flag is the right primitive for this
   gradient.

## Story Map

- 72-1: --halt-on flag + Decision Router with severity-based policy enforcement (P0, Medium)
- 72-2: --non-interactive flag + machine-readable exit codes (0|1|2) for CI/CD invocation (P0, Small)

Two focused stories. 72-1 introduces the Decision Router primitive;
72-2 builds the headless wrapper on top.

## Story 72-1: --halt-on flag + Decision Router

**Priority**: must

**Description**: Add a `--halt-on <all|critical|none>` CLI flag to
`substrate run` that controls which severity tiers cause the
orchestrator to halt for operator input. Implement a Decision Router
module that classifies every halt-able decision in the run loop by
severity (`info | warning | critical | fatal`) and consults the
`--halt-on` policy.

The Decision Router is invoked at every halt-decision point:
- Cost ceiling exhaustion (severity: critical)
- Build verification failure (severity: critical)
- Recovery retry attempt (severity: info — proceeds autonomously
  unless `--halt-on all`)
- Re-scope proposal (severity: warning)
- Scope violation (severity: fatal — always halts regardless of policy)

Severity classification table is exported as a constant from the
Decision Router module so future epic dispatches (e.g., Epic 73's
Recovery Engine) can register additional decision types with explicit
severity.

**Acceptance Criteria:**

1. New module `src/modules/decision-router/index.ts` exporting
   `routeDecision(decision, policy)` (pure function returning
   `{ halt: boolean, defaultAction: string, severity: Severity }`),
   `Severity` type (`'info' | 'warning' | 'critical' | 'fatal'`),
   and `DecisionType` union covering all halt-able decisions.

2. CLI flag `--halt-on <all|critical|none>` registered on
   `substrate run` command at `src/cli/commands/run.ts` (or wherever
   `run` command is defined; consult that file for flag-registration
   pattern). Default value: `critical`.

3. **Decision classification table** (exported constant
   `DECISION_SEVERITY_MAP`):
   - `cost-ceiling-exhausted`: critical
   - `build-verification-failure`: critical
   - `recovery-retry-attempt`: info
   - `re-scope-proposal`: warning
   - `scope-violation`: fatal
   - `cross-story-race-recovered`: info (Epic 70 — log only, no halt)
   - `cross-story-race-still-failed`: critical (Epic 70 — recovery
     exhausted, halt for operator)

4. **Halt policy logic** (in `routeDecision`):
   - `--halt-on all`: halts on `info` AND `warning` AND `critical`
     AND `fatal` decisions
   - `--halt-on critical` (default): halts on `critical` AND `fatal`
   - `--halt-on none`: halts ONLY on `fatal` (scope violations
     bypass the autonomy-gradient policy — they are always halts)

5. **Default-action propagation**: when a decision does NOT halt,
   `routeDecision` returns the `defaultAction` string (e.g.,
   `'retry-with-context'`, `'continue-autonomous'`,
   `'escalate-without-halt'`). Caller invokes the default action.

6. **CRITICAL: use canonical helpers for state access** (per Story
   69-2 / 71-2 lesson — 3 prior incidents from invented manifest
   formats):
   - Read run state via `RunManifest` class from
     `@substrate-ai/sdlc/run-model/run-manifest.js`
   - Run-id resolution via `manifest-read.ts` helpers
     (`resolveRunManifest`, `readCurrentRunId`)
   - Latest-run fallback via `getLatestRun(adapter)` from
     `packages/core/src/persistence/queries/decisions.ts`
   - Persistence via existing `DoltClient` from
     `src/modules/state/index.ts`
   - **Do NOT introduce new aggregate manifest formats.**

7. New event types declared in `packages/core/src/events/core-events.ts`
   AND mirrored in `src/core/event-bus.types.ts` `OrchestratorEvents`
   per Story 66-4 typecheck:gate discipline:
   - `decision:halt` — `{ runId, decisionType, severity, reason }`
   - `decision:autonomous` — `{ runId, decisionType, severity,
     defaultAction, reason }`

8. Orchestrator integration: every existing halt decision in
   `src/modules/implementation-orchestrator/orchestrator-impl.ts`
   replaced with `await routeDecision(...)` invocation. If `halt:
   true` returned, orchestrator yields control to the prompt path
   (existing behavior); else applies `defaultAction`.

9. Tests at `src/modules/decision-router/__tests__/index.test.ts`
   (≥6 cases): (a) `--halt-on critical` halts on cost-ceiling and
   build-failure; (b) `--halt-on none` proceeds autonomously on
   `info` and `warning`; (c) `--halt-on all` halts on every decision;
   (d) scope-violation halts regardless of policy; (e) unknown
   decision type returns severity `critical` (safe default); (f)
   default-action propagation correctness.

10. **Header comment** in implementation file cites Phase D Story
    54-2 (original 2026-04-05 spec) + Epic 70 (`cross-story-race`
    decision types added by Epic 70 motivate the registry pattern)
    + that Epic 73 (Recovery Engine) will register additional
    decision types.

11. **No package additions**: implementation must use existing deps.

**Files involved:**
- `src/modules/decision-router/index.ts` (NEW)
- `src/modules/decision-router/__tests__/index.test.ts` (NEW)
- `src/cli/commands/run.ts` (or equivalent — register `--halt-on` flag)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (consume Decision Router)
- `packages/core/src/events/core-events.ts` (new event types)
- `src/core/event-bus.types.ts` (mirror event types)

## Story 72-2: --non-interactive + machine-readable exit codes

**Priority**: must

**Description**: Add `--non-interactive` CLI flag to `substrate run`
that suppresses all stdin prompts and applies configured default
actions. Pair with machine-readable exit codes so CI/CD pipelines can
determine run outcome programmatically.

When `--non-interactive` is passed, every halt-decision point that
would normally prompt operator input is replaced with the configured
`defaultAction` from Story 72-1's Decision Router. The run completes
without operator interaction.

Exit code semantics (matches Phase D Story 54-6):
- `0`: all stories succeeded (or recovered cleanly)
- `1`: some stories escalated (no run-level failure)
- `2`: run-level failure (cost ceiling exhausted, fatal halt
  reached, orchestrator died, etc.)

**Acceptance Criteria:**

1. New CLI flag `--non-interactive` registered on `substrate run` at
   `src/cli/commands/run.ts`. Default value: `false`.

2. **Stdin prompt suppression**: when `--non-interactive` is true,
   any operator prompt path (existing `readline`/`process.stdin`
   reads in the orchestrator) is replaced with the configured
   `defaultAction` from `routeDecision` (Story 72-1). No stdin
   reads occur during a non-interactive run.

3. **Exit code derivation** at run completion in
   `src/modules/implementation-orchestrator/orchestrator-impl.ts`
   (or wherever pipeline completion is handled):
   - Exit `0` when `succeeded.length === total` AND `failed.length
     === 0` AND `escalated.length === 0`
   - Exit `0` when `succeeded.length + recovered.length === total`
     AND `failed.length === 0` AND `escalated.length === 0`
     (recovery counts as success)
   - Exit `1` when `escalated.length > 0` AND `failed.length === 0`
     (some stories escalated but run completed)
   - Exit `2` when `failed.length > 0` OR cost-ceiling-exhausted OR
     fatal halt reached OR orchestrator died (run-level failure)

4. **Combined flag behavior**: `--non-interactive --halt-on none
   --events --output-format json` is the canonical CI/CD invocation.
   This combination MUST:
   - Produce zero stdin reads
   - Emit NDJSON event stream to stdout (via `--events`)
   - Exit with codes 0/1/2 per AC3
   - Never block

5. **`--non-interactive` without `--halt-on`**: defaults to
   `--halt-on critical`. If a critical halt is reached, log a
   structured `decision:halt-skipped-non-interactive` event AND
   apply the default action AND mark the decision in the run
   manifest as `halt-skipped`. This is so operators reviewing the
   run via Epic 71's `substrate report` see what halts were skipped.

6. **Use canonical helpers** (per Story 69-2 / 71-2 lesson):
   - Use existing `RunManifest` for state writes (no new format)
   - Use `DoltClient` for persistence
   - Run-id resolution via `manifest-read.ts` helpers

7. New event type declared + mirrored:
   - `decision:halt-skipped-non-interactive` — `{ runId,
     decisionType, severity, defaultAction, reason }`

8. Tests at
   `src/modules/decision-router/__tests__/non-interactive.test.ts`
   (≥4 cases): (a) `--non-interactive` suppresses stdin reads;
   (b) exit code 0 when all stories succeed; (c) exit code 1 when
   any story escalates; (d) exit code 2 when run-level failure.

9. Integration test at
   `__tests__/integration/non-interactive-run.test.ts` (≥1 case):
   spawn `substrate run --non-interactive --halt-on none --events
   --stories <test-fixture>` as child process; assert no stdin
   reads occur (use a closed stdin pipe); assert exit code matches
   AC3 semantics.

10. **Header comment** in implementation file cites Phase D Story
    54-6 (original 2026-04-05 spec) + Story 72-1 (Decision Router
    that 72-2 consumes) + that this enables strata + agent-mesh
    cross-project CI/CD invocation.

11. **Help text update** on `substrate run --help`: document
    `--non-interactive` semantics + canonical CI/CD invocation
    combo + exit code table.

12. **No package additions**.

**Files involved:**
- `src/cli/commands/run.ts` (register `--non-interactive` flag)
- `src/modules/decision-router/index.ts` (extend with non-interactive
  default-action mode — Story 72-2 may need to extend Story 72-1's
  module; if so, both stories ship together as a single dispatch)
- `src/modules/decision-router/__tests__/non-interactive.test.ts` (NEW)
- `__tests__/integration/non-interactive-run.test.ts` (NEW)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (exit code derivation + stdin suppression)
- `packages/core/src/events/core-events.ts` (new event type)
- `src/core/event-bus.types.ts` (mirror event type)

## Risks and assumptions

**Assumption 1 (Decision Router can be wired into all existing halt
points)**: orchestrator's halt decisions are scattered across multiple
modules (cost ceiling, verification, recovery). Story 72-1's wiring
must locate all of them. Mitigation: integration test asserts every
known halt-able decision goes through `routeDecision`; unit tests
assert the correct event fires.

**Assumption 2 (existing prompt paths use readline/stdin)**: prompt
suppression in 72-2 assumes operator input arrives via stdin. If any
prompt is via subprocess or other mechanism, suppression must
generalize. Mitigation: unit test asserts stdin pipe is never read
in non-interactive mode.

**Risk: `--halt-on none` + `--non-interactive` could mask legitimate
errors.** Operators running this combo lose visibility into critical
halts that were skipped. Mitigation: AC5's `decision:halt-skipped-
non-interactive` event surfaces what was skipped; Epic 71's
`substrate report` will display these in the run summary.

**Risk: exit code 2 (run-level failure) is overloaded.** Multiple
distinct failure modes (cost ceiling, fatal halt, orchestrator
death) all map to exit 2. CI/CD pipelines can't distinguish them
from exit code alone. Mitigation: structured JSON output via
`--output-format json` provides full context; exit code is the
trigger, JSON is the detail. Document this in help text.

**Self-applying validation**: Epic 72 itself uses Decision Router
during dev-story dispatch (recovery retry decisions, build
verification halts). After 72 ships, those decisions go through the
new code path, so the substrate-on-substrate dispatch validates the
new code on first use.

## Dependencies

- **Phase D Story 54-2** (2026-04-05) — original Decision Router
  spec; Epic 72 Story 72-1 is single-story extraction.
- **Phase D Story 54-6** (2026-04-05) — original Headless spec;
  Epic 72 Story 72-2 is single-story extraction.
- **Epic 70** (v0.20.63) — cross-story-race recovery emits decision
  types Epic 72 classifies (`cross-story-race-recovered`,
  `cross-story-race-still-failed`).
- **Epic 71** (v0.20.62) — `substrate report` will display
  `decision:halt-skipped-non-interactive` events.
- **Story 53-3** (v0.19.31) — Cost ceiling tracking; emits the
  cost-ceiling-exhausted decision Epic 72 classifies.

## Out of scope

- **Recovery Engine logic** (Phase D Story 54-1 → Epic 73): Decision
  Router classifies and routes recovery decisions but does NOT
  implement the recovery actions themselves. Epic 73 owns retry-
  with-context, re-scope proposals, etc.
- **Interactive prompt UX** (Phase D Story 54-3 → Epic 73): when a
  halt fires, the prompt UX (numbered choices, default selection)
  is Epic 73 scope. Epic 72 just signals "halt for operator input"
  and yields control.
- **Notification signal in tethered mode** (Phase D Story 54-3):
  Epic 73 scope.
- **Per-story cost ceilings**: Story 53-9 scope; Epic 72 only
  consumes the existing run-level ceiling signal.

## References

- Phase D Plan 2026-04-05 — Stories 54-2 + 54-6 original specs
- Epic 70 (v0.20.63) — cross-story-race recovery decisions consumed
  by Decision Router
- Epic 71 (v0.20.62) — `substrate report` will display halt-skipped
  events
- Epic 73 (planned) — Recovery Engine; consumes Decision Router for
  tier-A halt decisions

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-05 | post-Epic 70 sprint progress | open | Filed as Stream A+B sprint plan continuation. 2-story epic (single-story extraction of Phase D 54-2 + 54-6, mirroring Epic 68 / 69 / 71 pattern). ACs explicitly cite canonical helpers (RunManifest / DoltClient / getLatestRun / manifest-read) per Story 69-2 / 71-2 / 70-1 lesson. Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
