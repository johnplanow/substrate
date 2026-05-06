# Epic 71: Structured Completion Report — `substrate report`

## Vision

Codify the **operator overnight-run review experience** into a single
CLI command. Today, after a substrate run completes, operators must
run `substrate metrics`, `substrate status`, manually inspect rendered
story files, and grep dispatch logs to understand what shipped vs
escalated. Story 54-5's original spec promised an "escalated story
resolvable in <15 minutes from report alone" — Epic 71 ships that.

`substrate report` reads the run manifest + Dolt + verification finding
stores and produces a structured summary: per-story table, verified vs
recovered vs escalated breakdown, cost vs ceiling, escalation root
cause + suggested operator action, and machine-readable JSON for
CI/CD integration.

Independent of dispatch flow — additive command that reads existing
state, no new gates, no orchestrator changes. Highest-leverage Phase D
extraction (zero risk, immediate operator value).

## Root cause it addresses

Operators reviewing overnight runs face fragmented information:

1. **`substrate metrics`** shows run-level cost + token totals but not
   per-story outcomes
2. **`substrate status`** shows current state but is ephemeral — gone
   once the run terminates
3. **Rendered story files** at
   `_bmad-output/implementation-artifacts/<story>.md` show the spec
   but not the verification outcome or escalation reason
4. **Dolt `wg_stories`** has status (complete/escalated) but no
   diagnostic context
5. **Run manifest** at `.substrate/runs/<run-id>.json` has phase
   breakdown + token usage but is JSON, not human-readable

The operator must mentally join all five sources to understand a run.
For overnight runs with 10+ stories, this is 30-60 minutes of joining
state across stores. Epic 71 does the join in code.

## Why now

Three signals:

1. **Stream A+B sprint plan capstone (Epic 73 Recovery Engine) needs
   programmatic access to the report shape.** Recovery Engine reads
   the structured report to determine which stories are recoverable
   vs need re-scope. Building Epic 71 first hands Epic 73 a ready
   data contract.

2. **Phase D's autonomy story depends on legible run outcomes.** The
   `--halt-on` flag (Epic 72), Recovery Engine (Epic 73), and
   AC-to-Test Traceability (Epic 74) all assume operators can review
   runs efficiently. Epic 71 is the visibility primitive; everything
   downstream consumes its output.

3. **Today's 5 ships** (v0.20.55-v0.20.60) all required manual
   joining of `substrate metrics` + `git log` + Dolt SELECT + dispatch
   logs to produce the final commit message + memory entry. Each ship
   spent 5-10 minutes on this. `substrate report` reduces to one
   command.

## Story Map

- 71-1: substrate report CLI command — structured completion report (P0, Medium)

Single story, focused implementation. AC-to-Test Traceability
(`--verify-ac` flag, Story 54-7) explicitly deferred to Epic 74 to
keep 71 surface area minimal.

## Story 71-1: substrate report CLI command

**Priority**: must

**Description**: Implement the Phase D Story 54-5 Structured Completion
Report as a focused single-story extraction. New
`substrate report` command at `src/cli/commands/report.ts` that reads
the run manifest + Dolt + verification finding stores and produces a
human-readable or JSON-structured report.

The command operates in three phases:

**Phase 1 — Data assembly:**
- Resolve target run via `--run <id>` (default: most recent run from
  `.substrate/runs/manifest.json`); `--run latest` is sugar for the
  same default
- Load run manifest: stories, phases, token totals, cost, started_at,
  completed_at
- Query Dolt `wg_stories` for status + completed_at per story
- Read per-story metrics from manifest's `story_metrics` array:
  wall_clock_ms, phase_breakdown, tokens, review_cycles, dispatches,
  verification_findings, verification_ran, probe_author summary
- Compute per-story outcome classification:
  - `verified` — status='complete' AND verification_ran=true AND no
    error-severity findings
  - `recovered` — status='complete' AND verification_ran=false (Path A
    reconciled) OR verification_ran=true AND review_cycles>0
  - `escalated` — status='escalated'
  - `failed` — status='failed' (rare; orchestrator-side)

**Phase 2 — Diagnostic enrichment (escalated only):**
- For each escalated story, derive: root_cause (from escalation
  reason: `checkpoint-retry-timeout`, `verification-fail-after-cycles`,
  `dispatch:spawnsync-timeout`, etc.), recovery_attempts (review_cycles
  count), suggested_operator_action (string heuristic from root_cause),
  blast_radius (per-story `affected_files` from verification findings,
  if any)
- For checkpoint-retry-timeout: suggested_action="Run `substrate
  reconcile-from-disk --run <id>` (Epic 69) — implementation may have
  shipped before timeout; gates will validate."
- For verification-fail-after-cycles: suggested_action="Read findings
  via `substrate metrics --run <id> --findings`; consider --max-review-cycles
  3 retry."

**Phase 3 — Rendering:**
- **Human format** (default): banner with run-id + duration + cost +
  ceiling status + verdict; story count summary line
  (`X verified, Y recovered, Z escalated, W failed of N total`);
  per-story table (story_key | outcome | wall-clock | review-cycles |
  cost | findings | verified-tag); for each escalated, a detail block
  (root_cause, recovery_attempts, suggested_action, blast_radius)
- **JSON format** (`--output-format json`): structured object with
  `{ runId, summary: {...}, stories: [...], escalations: [...],
  cost: {...}, duration: {...} }` — schema documented in JSDoc on the
  TypeScript export

**Acceptance Criteria:**

1. New command file `src/cli/commands/report.ts` exporting
   `registerReportCommand(program, version, projectRoot, registry)`
   matching the existing CLI registration shape (consult
   `reconcile-from-disk.ts` from Epic 69 for the contract).

2. Command shape: `substrate report [--run <id|latest>]
   [--output-format <human|json>]`. `--run` defaults to most recent
   run from `.substrate/runs/manifest.json`. When no runs exist, exit
   1 with friendly error.

3. **Outcome classification**: each story classified as one of
   `verified | recovered | escalated | failed` per the rules above.
   Logic isolated in pure helper `classifyStoryOutcome(story,
   manifest)` so it's unit-testable independent of CLI plumbing.

4. **Diagnostic enrichment**: escalated stories enriched with
   `root_cause`, `recovery_attempts`, `suggested_operator_action`,
   `blast_radius`. Suggested-action heuristic mapping for at least
   these escalation reasons: `checkpoint-retry-timeout`,
   `verification-fail-after-cycles`, `dispatch:spawnsync-timeout`,
   `cost-ceiling-exceeded`, `unknown`.

5. **Human rendering**: banner + summary line + per-story table +
   per-escalation detail blocks. Table aligned (use a small helper,
   no need for a heavy library). Color (chalk) optional but consistent
   with other commands.

6. **JSON rendering**: structured output. Top-level keys: `runId`,
   `summary`, `stories`, `escalations`, `cost`, `duration`. JSDoc
   types exported alongside command for downstream Epic 73 consumption.

7. **`--run latest`**: explicit sugar for "most recent run" — same
   resolution as omitting `--run`. Both forms must produce identical
   output.

8. **Cost vs ceiling**: surface manifest's `cost.ceiling` (if set)
   and `cost.spent`; report cost utilization percentage and "OVER
   CEILING" tag if exceeded.

9. **Verification findings surfaces**: per-story
   `verification_findings: { error: N, warn: N, info: N, byAuthor:
   {...} }` shown in the table's findings column as `E:0 W:1 I:2`
   format; full breakdown available in JSON output under
   `stories[].verification_findings`.

10. **Tests** at `src/__tests__/cli/report.test.ts` (≥6 cases):
    (a) classification — verified/recovered/escalated/failed
    edge cases, (b) `--run latest` resolves correctly, (c) human
    output stable for golden-master fixture, (d) JSON output
    well-formed for golden-master fixture, (e) escalation diagnostic
    enrichment for checkpoint-retry-timeout, (f) escalation
    diagnostic for unknown reason (graceful fallback), (g) no-runs-
    exist friendly error.

11. **Integration test** at `__tests__/integration/report.test.ts`
    (≥1 case): real fixture run manifest with mixed outcomes
    (verified + recovered + escalated), invokes `substrate report
    --run <fixture-id>` and asserts output shape.

12. **Header comment** in implementation file cites Phase D Story
    54-5 (original 2026-04-05 spec) + Epic 69 Story 69-1 (Path A
    primitive that produces "recovered" outcomes this report classifies)
    + that Recovery Engine (Epic 73) will programmatically consume
    this command's JSON output.

13. **Commit message** references Phase D 54-5 extraction + Stream
    A+B sprint plan + that Epic 71 is independent and additive
    (zero gate changes, zero orchestrator changes).

14. **No package additions**: implementation must use existing deps
    (manifest reader from Story 52-3+, Dolt client from existing
    DoltClient, no new chalk/cli-table dependencies — keep small).

**Files involved:**
- `src/cli/commands/report.ts` (NEW)
- `src/cli/index.ts` (register subcommand)
- `src/__tests__/cli/report.test.ts` (NEW)
- `__tests__/integration/report.test.ts` (NEW)

**Tasks / Subtasks:**

- [ ] AC1: implement `registerReportCommand` Commander subcommand
- [ ] AC2: command shape + flag parsing + run-id resolution
- [ ] AC3: pure `classifyStoryOutcome` helper with unit-testable
      logic
- [ ] AC4: diagnostic enrichment heuristic mapping for escalations
- [ ] AC5: human-format renderer (banner + summary + table +
      escalation detail blocks)
- [ ] AC6: JSON-format renderer with documented exported types
- [ ] AC7: `--run latest` sugar resolves identically to default
- [ ] AC8: cost vs ceiling surfacing with OVER-CEILING tag
- [ ] AC9: verification findings column rendering
- [ ] AC10: unit tests (≥6 cases) covering classification +
      rendering + edge cases
- [ ] AC11: integration test with real fixture run manifest
- [ ] AC12: header comment citations
- [ ] AC13: commit message follows convention
- [ ] AC14: zero new package dependencies

## Risks and assumptions

**Assumption 1 (manifest format stable)**: relies on
`.substrate/runs/<run-id>.json` schema as documented by Story 52-3+.
If manifest schema evolves, report parser must update. Mitigation:
treat unknown fields as additive; surface only fields the parser
recognizes.

**Assumption 2 (escalation reasons enumerable)**: the heuristic
suggested-action mapping covers at least 5 known reasons. New
escalation reasons added by future epics may not have tailored
suggested-actions. Mitigation: graceful fallback — `suggested_action:
"See substrate metrics --findings for diagnostic context."` for unknown
reasons.

**Risk: golden-master test brittleness.** Human-format output is
naturally stable but small format tweaks break golden tests.
Mitigation: golden tests strip dynamic content (timestamps, durations)
to focused property assertions; full output stability checked only
in integration test.

**Risk: report output overflow on large runs.** A 30-story run
produces a wide table. Mitigation: human format truncates story_key
title to 50 chars; full title available in JSON output.

**Self-applying validation note**: Epic 71 itself is a single-story
epic. If 71-1 escalates with checkpoint-retry-timeout (same shape as
Epic 69's 69-1), Epic 71 ships the very command that summarizes its
own escalation. Epic 69 ships the command that recovers it. Beautiful
fix.

## Dependencies

- **Story 52-3+** (v0.19.30+) — Run manifest format
  (`.substrate/runs/<run-id>.json`) with story_metrics array,
  cost/ceiling fields, phase breakdown. 71-1 reads this format.
- **Story 53-3** (v0.19.31) — Cost ceiling tracking. 71-1 consumes
  cost.ceiling + cost.spent fields from manifest.
- **Story 60-15** (v0.20.41) — verification_findings telemetry shape
  (`{ error, warn, info, byAuthor }`). 71-1 reads this shape from
  manifest's story_metrics.
- **Epic 69 Story 69-1** (v0.20.60) — Path A primitive that produces
  the "recovered" outcome. 71-1's classification logic recognizes
  Path-A-reconciled stories as `recovered`, not `verified`.

## Out of scope

- **AC-to-Test Traceability check** (Story 54-7): Epic 74 scope.
  Mention in 71's "future" notes but do NOT implement
  `--verify-ac` flag here.
- **Integration with Recovery Engine** (Epic 73): Recovery Engine
  consumes 71's JSON output programmatically; that integration is
  Epic 73's scope, not 71.
- **Real-time / streaming report**: report is a snapshot of completed
  runs only. For active-run inspection, operator continues to use
  `substrate status`.
- **Cross-run comparison**: report is per-run only. Multi-run
  trending defers to potential future epic.
- **HTML/Markdown export**: human + JSON only.

## References

- Phase D Plan 2026-04-05 — original Story 54-5 scoping
  (Structured Completion Report) which Epic 71 extracts as a
  single-story epic
- Epic 69 (v0.20.60) — Path A reconciliation primitive that
  produces "recovered" outcomes Epic 71 classifies
- Epic 70 (planned) — Pipeline-verdict accuracy; Epic 70's
  retry-with-fresh-fix-context logic produces "verified" outcomes
  that Epic 71 surfaces
- Epic 73 (planned) — Recovery Engine; programmatically consumes
  Epic 71's JSON output to determine recoverable vs unrecoverable
  escalations

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-05 | post-Epic 69 sprint progress | open | Filed as next epic in Stream A+B post-v0.20.60. Single-story extraction from Phase D Story 54-5. Independent additive command (zero gate changes, zero orchestrator changes); lowest risk Phase D extraction. Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
