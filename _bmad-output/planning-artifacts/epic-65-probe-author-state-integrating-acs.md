# Epic 65: Probe-Author Phase 3 — State-Integrating ACs

## Vision

Extend the `probe-author` task type (shipped Epic 60 Phase 2,
v0.20.31–v0.20.41) to dispatch on **state-integrating acceptance
criteria** in addition to the current event-driven AC class. The Phase 2
catch-rate evaluation under v0.20.39 demonstrated 4/4 (100%) catch on
the event-driven corpus at $0.06 / 8 minutes wall-clock per dispatch;
Phase 3 generalizes that result to a broader story class where
correctness depends on the implementation observing or mutating
state outside its own process inputs (filesystem, subprocess, git, network,
database, registry).

This epic is a defense-in-depth follow-up to the prompt-side and
gate-side fixes for **obs_2026-05-01_017** (create-story
probe-awareness gap on TypeScript modules with fs/git integration).
Those fixes (Epic 64, planned Sprint 23) widen the create-story
agent's authoring rule and add a frontmatter-driven warn→error
escalation. Epic 65 reduces dependence on create-story-agent
compliance by automatically deriving probes from state-integrating ACs
the same way Phase 2 does for event-driven ACs.

## Root cause it addresses

obs_2026-05-01_017 surfaced the failure mode: strata Story 2-4
("Morning briefing generator") shipped SHIP_IT through every
substrate verification gate with two architectural defects baked
into the create-story-authored story doc itself
(`fetchGitLog` ran `git log` with `cwd=fleetRoot` — a parent of N repos,
not a single repo; substring-match commit attribution
false-positive on common project names). Every defect was prescribed
verbatim by create-story; the dev agent followed the prescription;
mocked unit tests passed; the runtime-probes check skipped because
no `## Runtime Probes` section existed.

Epic 64 (planned) widens create-story's authoring rule and adds a
frontmatter-driven escalation. That closes the gap for stories where
create-story correctly authors state-integration metadata.
**It does not close the gap when the create-story agent itself fails
to recognize a state dependency from the AC text** — for example,
when the AC describes a subprocess invocation in implementation prose
rather than declaring it as an explicit dependency.

Phase 3 dispatches `probe-author` for state-integrating ACs the same
way Phase 2 dispatches for event-driven ACs. The probe-author phase
runs against the AC text directly and authors probes that exercise
the integration against real or near-real state (sandbox: twin or
host as appropriate). probe-author authorship is independent of
whether create-story declared the dependency — the AC text is the
ground truth.

## Why Phase 3 now

Three converging signals:

1. **Phase 2 empirical validation (v0.20.39, 2026-04-28).** The eval
   harness produced GREEN, 4/4 = 100% catch on event-driven defect
   corpus at $0.06 per dispatch. Cost-effectiveness is established
   for the event-driven class. State-integrating ACs are a larger
   population per consumer-project — extending probe-author's reach
   has favorable cost-benefit even at lower catch rates.

2. **obs_017 third-occurrence pattern.** The observation file flags
   this as the third smoke-caught architectural-prescription defect
   class in the strata Phase B arc (alongside tilde-not-expanded in
   2.2 and chat.ts race in 2.3). The first two were strata-side
   authoring issues; obs_017 is the first where create-story's *own
   prescription* encoded the bug — but the underlying class
   (mocked-tests-pass, real-state-execution-fails) recurs across all
   three. Phase 3 closes that class structurally rather than per-bug.

3. **Strata Phase B blast radius.** Phase B 2.5 (briefing
   scheduling = systemd timer) and 2.7 (mesh telemetry queries) both
   have analogous external-state dependencies. Every consumer
   project's roadmap contains state-integrating stories. The cost of
   Phase 3 amortizes faster than Phase 2 did.

## Story Map

- **65-1**: state-integrating AC detection heuristic (P0, Medium)
- **65-2**: probe-author dispatch wiring for state-integrating ACs (P0, Medium)
- **65-3**: corpus + eval harness for state-integrating defect class (P0, Large)
- **65-4**: go/no-go gate — Phase 3 ramp-up decision (P0, Small)
- **65-5**: probe-author prompt extensions for state-integration probe shapes (P1, Medium)
- **65-6**: telemetry events for state-integrating dispatches (P2, Small)

Phase 3 follows the same staged ramp-up Phase 2 used: build the
detection heuristic, wire the dispatch, build a defect corpus and eval
harness, run the eval, then commit (or abort) based on empirical
catch-rate.

## Story 65-1: state-integrating AC detection heuristic

**Priority**: must

**Description**: Add a `detectsStateIntegratingAC(sourceContent: string)`
exported helper to `packages/sdlc/src/verification/runtime-probe-check.ts`
(or a new sibling module). Mirrors the existing
`detectsEventDrivenAC` heuristic (Story 60-11, v0.20.28) but for
state-integration patterns. Returns boolean.

Detection signals (scan for any of):

- subprocess: `execSync(`, `spawn(`, `exec(`, `child_process`,
  `runs <command>`, "spawns", "invokes <binary>"
- filesystem: `fs.read`, `fs.write`, `readFile`, `writeFile`,
  `path.join` against `homedir()` / `os.homedir()` / absolute paths,
  "reads from disk", "writes to disk", "scans filesystem"
- git: `git log`, `git push`, `git pull`, `git merge`,
  "queries git", "runs git", git porcelain output parsing
- database: `Dolt`, `mysql`, `pg`, `sqlite`, `INSERT`, `SELECT`,
  "queries the database", "writes to Dolt"
- network: `fetch(`, `axios`, `http.get`, `https.get`,
  "fetches", "POSTs to", "calls the API"
- registry: registry-name patterns, "queries registry",
  "scans the registry"

The heuristic is intentionally generous — false-positive cost is one
extra probe-author dispatch ($0.06 per Phase 2 eval); false-negative
cost is a SHIP_IT'd broken integration. Tune toward sensitivity.

**Acceptance Criteria**:

1. `detectsStateIntegratingAC` exported from
   `packages/sdlc/src/verification/runtime-probe-check.ts` (or sibling).
2. Returns `true` when source AC content contains any of the
   subprocess / filesystem / git / database / network / registry signals
   listed above.
3. Returns `false` for purely-algorithmic AC text (parse, format,
   sort, transform, score, calculate).
4. Returns `false` when source AC describes only **mock** integration
   ("mocks the database", "stubs the registry") — ground truth is
   whether the production code path hits real state, not whether
   tests exercise it.
5. Coexists with `detectsEventDrivenAC`. ACs matching both heuristics
   dispatch probe-author once (single dispatch covers both classes).
6. Unit tests cover positive, negative, and ambiguous cases. Use
   strata Story 2-4's actual AC text as a positive-case fixture so
   Epic 65 directly exercises the obs_017 reproduction.

## Story 65-2: probe-author dispatch wiring for state-integrating ACs

**Priority**: must

**Description**: Extend the probe-author dispatch decision in
`OrchestratorImpl` (the integration point added in Story 60-13,
v0.20.31) to dispatch when **either** `detectsEventDrivenAC` **or**
`detectsStateIntegratingAC` returns true. Currently it dispatches
only on event-driven detection.

Single dispatch per story (no double-dispatch when both heuristics
fire). The probe-author prompt itself must be able to handle both AC
classes — covered by Story 65-5.

**Acceptance Criteria**:

1. Orchestrator dispatches probe-author when source AC matches
   either heuristic.
2. Single dispatch per story, never double.
3. Telemetry distinguishes `triggered_by: event-driven`,
   `triggered_by: state-integrating`, or `triggered_by: both`
   (Story 65-6).
4. Feature-flagged: `--probe-author-state-integrating=on|off`,
   default `off` until Story 65-4 go/no-go decision flips it.
5. Existing event-driven dispatches unchanged when state-integrating
   detection is off.

## Story 65-3: corpus + eval harness for state-integrating defect class

**Priority**: must

**Description**: Build a defect corpus analogous to the v1 corpus
used by Story 60-14d (event-driven, 4 cases, 100% catch rate).
Phase 3's corpus targets state-integration defect shapes. The corpus
must be seeded with at least one fixture that reproduces the obs_017
failure pattern (cwd-as-parent + substring-match attribution).

Suggested fixture set (target ≥ 8 cases for statistical signal):

1. obs_017 reproduction: `git log` with wrong cwd
2. subprocess with synthesized inputs vs. real-state inputs
3. filesystem read against tilde-not-expanded path
4. database query against mocked vs. real adapter
5. network fetch against mocked vs. real endpoint
6. registry scan against single-repo vs. multi-repo layout
7. git operation that succeeds on empty repo, fails on real repo
8. spawn invocation that swallows non-zero exit silently

Each corpus case provides: AC text, broken implementation, the
real-state condition that breaks it, the expected probe-author probe
shape that catches it.

**Acceptance Criteria**:

1. Corpus persisted at
   `packs/bmad/eval/probe-author-state-integrating-corpus.yaml`.
2. Eval script extends `scripts/probe-author-eval.ts` (or sibling)
   to drive the corpus through probe-author dispatch and assert
   each authored probe catches the defect against real or
   near-real state.
3. Eval is reproducible: pinned model, deterministic prompt, no
   network dependencies beyond probe-author dispatch itself.
4. Eval emits structured per-case results: `caught: bool`,
   `cost_usd`, `wall_clock_ms`, `probe_count`, `failure_reason` (if
   not caught).
5. Aggregate report: catch rate, total cost, total wall clock,
   per-case breakdown.

## Story 65-4: go/no-go gate — Phase 3 ramp-up decision

**Priority**: must

**Description**: Run the Story 65-3 eval. Decision rules mirror
Phase 2 Story 60-14:

- **Catch rate ≥ 75%**: Phase 3 GREEN. Flip
  `--probe-author-state-integrating` default to `on`. Continue to
  Story 65-5 / 65-6 (prompt refinement, telemetry).
- **Catch rate 50–74%**: YELLOW. Examine misses. If misses cluster
  on a fixable shape (prompt gap, dispatch wiring), iterate Story
  65-1/65-2/65-5 and re-run eval. If misses are diffuse, abort
  Phase 3 and pursue an alternative structural shape (frontmatter
  enforcement only, no probe-author dispatch — i.e., lean harder
  on Epic 64).
- **Catch rate < 50%**: RED. Phase 3 aborts. Document findings as
  an observation; rely on Epic 64's prompt-side and gate-side
  defenses.

**Acceptance Criteria**:

1. Eval run report committed to
   `_bmad-output/planning-artifacts/epic-65-eval-report.md`.
2. Decision (GREEN / YELLOW / RED) recorded with rationale.
3. If GREEN: feature flag default flipped in a substrate point
   release; release notes mention catch rate and cost.
4. If YELLOW: at least one iteration attempted before aborting.
5. If RED: epic closed with a "wont-fix at probe-author layer;
   rely on Epic 64" status.

## Story 65-5: probe-author prompt extensions for state-integration probe shapes

**Priority**: should

**Description**: Extend `packs/bmad/prompts/probe-author.md` (added
Story 60-12) with guidance for authoring state-integration probes.
The current prompt is calibrated for event-driven triggers (git hooks,
systemd timers, signal handlers). State-integration probes have
different shape requirements:

- **Real-state context, not synthesized:** for filesystem probes,
  the probe should run against a tmpdir populated with a structure
  matching the production layout (e.g., for fleet-scanning logic,
  populate the tmpdir with N subdirs each containing `.git`).
- **Sandbox choice leans `twin` more often:** state-integration
  probes that touch the user's actual home directory or running
  services should ALWAYS be `twin`. Only `host` for read-only
  registry / config-shape probes.
- **Multi-repo / multi-resource fixtures:** the obs_017 defect
  required a fleet of N repos to reproduce. Single-resource
  fixtures miss the shape.
- **External-binary availability assertions:** if the probe
  invokes `git`, `dolt`, `podman`, etc., the probe (or a sibling
  probe) should first assert the binary exists.

**Acceptance Criteria**:

1. probe-author.md extended with "State-integration probe shapes"
   section.
2. Each shape (filesystem, subprocess, git, database, network,
   registry) has a worked example.
3. Schema-drift guardrail (existing in probe-author test suite)
   passes: every YAML fenced block validates against
   `RuntimeProbeListSchema`.
4. obs_017 reproduction: a state-integration probe authored from
   strata 2-4's AC text catches the cwd-as-parent defect against
   a multi-repo tmpdir fixture.

## Story 65-6: telemetry events for state-integrating dispatches

**Priority**: nice-to-have

**Description**: Extend the Story 60-15 telemetry events
(`probe-author:dispatched`, `probe-author:output-parsed`, etc.) to
carry a `triggered_by: 'event-driven' | 'state-integrating' | 'both'`
discriminator. Add a `--probe-author-class-summary` flag to
`substrate metrics` that breaks down catch rate, cost, and dispatch
count by trigger class.

**Acceptance Criteria**:

1. `probe-author:dispatched` event includes `triggered_by` field.
2. Per-story manifest records `probe_author.triggered_by` alongside
   existing fields.
3. `substrate metrics --probe-author-class-summary` outputs per-class
   aggregates.
4. Backward-compat: legacy events without `triggered_by` default to
   `event-driven` (the only class that existed pre-Phase 3).

## Risks and assumptions

**Assumption 1 (catch rate generalizes)**: probe-author's 4/4 catch
on event-driven ACs generalizes to state-integrating ACs at
≥ 75% rate. State-integration is a broader, fuzzier category than
event-driven. Catch rate may be lower; Story 65-4's gate exists to
catch this empirically.

**Assumption 2 (cost stays favorable)**: per-dispatch cost stays in
the $0.05–$0.10 range. State-integrating ACs are a larger population
than event-driven, so total per-pipeline cost rises proportionally.
Phase 3 stays favorable as long as
`(probability × cost-per-defect) > (dispatch-rate × cost-per-dispatch)`.

**Assumption 3 (no double-dispatch)**: Story 65-2's "single dispatch
even when both heuristics fire" condition holds. Easy to verify in
unit test, but worth flagging.

**Risk: detection over-fires.** State-integration phrases recur in
many ACs ("the dev should write a test that mocks fs.readFile") that
do NOT need probes. Story 65-1 AC4 captures this; Story 65-4's eval
catches the rate empirically.

**Risk: probe-author authors weak probes.** A probe that runs the
implementation against an empty tmpdir would pass the obs_017
defect. probe-author needs to author probes against
production-shaped fixtures, not toy fixtures. Story 65-5 addresses
this prompt-side; Story 65-3's corpus enforces it eval-side.

## Dependencies

- **Epic 64** (Sprint 23, prompt-side + frontmatter fix for obs_017)
  must ship first. Phase 3 is defense-in-depth under Epic 64, not a
  substitute. If Epic 64 itself fails, Phase 3's catch-rate measurement
  is contaminated.
- **Phase 2** (Epic 60, SHIPPED v0.20.41) is the foundation. Phase 3
  reuses the probe-author task type, dispatch wiring, telemetry, and
  eval harness scaffolding. No new infra.

## Out of scope

- Probe-author dispatch for **scope-extension ACs** (where the AC
  text describes scope drift signals) — separate epic if signal emerges.
- Probe-author dispatch for **pure-function ACs** — explicitly
  excluded; probes add no value when correctness is observable from
  inputs/outputs alone.
- Auto-author probe-author probes for **legacy stories** that already
  shipped without probes — Phase 3 affects new dispatches only;
  retrospective re-authoring is a separate decision.

## References

- obs_2026-05-01_017 (this epic's motivating observation):
  `~/code/jplanow/strata/_observations-pending-cpo.md` lines
  1592–1687.
- Epic 60 Phase 2 retrospective: `epic-60-probe-quality.md`.
- Epic 64 (Sprint 23, planned): prompt-side + frontmatter fix.
- Story 60-14 eval harness: `scripts/probe-author-eval.ts`.
- Story 60-15 telemetry: `packages/sdlc/src/run-model/probe-author-metrics.ts`.

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-01 | party-mode session (jplanow + BMad agents) | open | Filed in response to obs_2026-05-01_017. Sequenced after Epic 64 (Sprint 23 prompt-side + frontmatter fix). Phase 3 catch-rate generalization is unproven; Story 65-4 gates ramp-up on empirical eval. |
