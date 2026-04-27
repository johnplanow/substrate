# Epic 60: Probe Quality

## Vision

Close the structural gap where dev-authored runtime probes co-evolve
with the dev's mental model of the implementation rather than with the
source AC's user-facing intent. The current Tier A `runtime-probes`
check executes whatever probe the dev authored and reports `pass` if
the probe exits 0 — but the probe itself can be (a) the wrong assertion
shape (accepting an error envelope as success), (b) the wrong invocation
shape (calling the implementation directly rather than firing the
production trigger), or (c) any future shape we haven't yet observed.
All five Tier A checks pass; the implementation is non-functional in
production; only the strata operator's manual e2e smoke pass catches it.

After 5 consecutive strata dispatches surfaced 5 distinct shapes of this
failure mode (Run 9, 11, 12, 12-followup, 13 — see below for the
catalogue), the pattern is no longer anecdotal. Heuristic accretion
(Phase 1) narrowed the gap per shape but never closed it. Phase 2
introduces a structural decoupling: probes are authored by a separate
agent dispatch that sees the source AC but not the implementation.

## Root cause

Two coupled biases produce the failure mode:

1. **Same agent writes both the probe and the implementation.** The
   probe is generated in the same context window as the implementation,
   biased toward "what I built" rather than "what the AC asked for."
   Surfaced as: dev probe asserts the four MCP tools are advertised by
   name (Run 11) but accepts `{"isError": true}` payloads as valid
   responses (Run 12). Probe was written from the implementation's
   surface, not the AC's behavioral intent.

2. **Probe runs against synthesized inputs, not production triggers.**
   Event-driven implementations (hooks, timers, signals, webhooks) have
   wiring layers between the production event and the implementation
   logic. Direct-invocation probes verify implementation correctness
   given pre-existing inputs but skip the wiring layer entirely.
   Surfaced as: dev probe runs `bash .git/hooks/post-merge` directly
   (Run 13) — verifies the resolver works given conflict markers, but
   `git`'s `post-merge` hook is not executed when a merge fails due to
   conflicts (per `githooks(5)`). The hook never fires for the AC's
   actual use case (conflict resolution). Direct invocation hid this
   entirely.

Substrate's previous triage (2026-04-26 session, recorded in
`_observations-pending-cpo.md` line 1203) explicitly rejected
"separate probe-author phase from dev phase" based on the reasoning:
*"Probes co-evolve with the implementation BECAUSE the rendered
artifact instructed the dev to test what the artifact described."* That
triage was empirically refuted by Runs 12 and 13 — co-evolution
preserves the dev's misreading of the AC, not the AC itself.

## Phase 1 — Heuristic accretion (SHIPPED)

Phase 1 added narrow heuristics that catch known shapes mechanically.
Each heuristic addresses one specific failure mode but does not address
the root cause; new shapes continue to slip through.

| Story | Shipped | Closes | Mechanism |
|---|---|---|---|
| **60-1** | v0.20.22 | obs_011 (clause-fidelity) | Pre-dev clause-fidelity gate: extract source-AC `### AC<N>` clauses, retry create-story when artifact drops them |
| **60-2** | v0.20.22 | obs_011 retry surface | Clause-aware retry-correction prompt + escape hatch |
| **60-3** | v0.20.23 | obs_011 deeper class | Story-scoped under-delivery detection: when path exists in repo AND modified-files list reported, scan story's modified files for kebab/snake-tolerant import-style references |
| **60-4** | v0.20.24 | obs_012 (refined) — assertion shape | Runtime-probe `expect_stdout_no_regex` / `expect_stdout_regex` schema fields; new `runtime-probe-assertion-fail` finding category |
| **60-5** | v0.20.24 | obs_013 — alternative-option false-positive | Source-ac-fidelity detects `**(a)**`/`**(b)**` markdown alternative groups; un-taken option emits `source-ac-alternative-not-taken` info, not architectural-drift error |
| **60-6** | v0.20.25 | latent extraction bug | Separator-tolerant story-section extraction (`1-10c` matches `### Story 1.10c:`); loud `source-ac-section-not-found` warn instead of silent return-full-epic fallback |
| **60-7** | v0.20.27 | strata 1-12 false-positive | Operational-path heuristic: `.git/hooks/...`, `/usr/`, `/etc/`, `~/`, etc. emit info, not architectural-drift error |
| **60-8** | v0.20.27 | Epic 52 source-of-truth gap | `dev_story_signals` persisted to manifest so Story 60-3's under-delivery check works on resume / retry-escalated / post-mortem (not just same-run in-memory) |
| **60-9** | v0.20.27 | model-defaults staleness | Major-rework escalation default bumped `claude-opus-4-6` → `claude-opus-4-7`; added to `token-rates.ts` |
| **60-10** | v0.20.28 | obs_014 author-side | Production-trigger guidance in create-story prompt: hooks/timers/signals/webhooks must invoke real trigger (`git merge`, `systemctl`, `kill -SIG`, `curl -X POST`), NOT direct invocation |
| **60-11** | v0.20.28 | obs_014 mechanical sibling | Runtime-probes-check scans source AC for event-driven keywords; if no probe invokes a known trigger pattern, emits `runtime-probe-missing-production-trigger` warn |

**Phase 1 outcome (empirical)**: each heuristic demonstrably closed
its target failure mode (60-7 validated by re-dispatching strata 1-12:
VERIFICATION_FAILED → LGTM_WITH_NOTES, $0.57 → $0.23, 28min → 10min,
2 → 1 cycles). But the pattern of "n dispatches → n heuristics →
n+1th defect class" continued: obs_014 emerged immediately after
60-4/60-5/60-6 shipped, and 60-10/60-11 closed obs_014 only to set
up the obvious question — *what's the obs_015 we haven't seen yet?*

## Critical risks and assumptions

Phase 2 rests on assumptions that have not been empirically validated.
Story 60-14 is structured as a **go/no-go gate** for the rest of the
phase: if probe-author probes are demonstrably useless or worse than
dev-authored probes, Stories 60-15 and 60-16 do not get built;
Phase 2 aborts and Phase 3 (alternative structural shapes — see
out-of-scope) is reconsidered.

**Assumption 1 (load-bearing)**: an agent with access to source AC but
NOT implementation context will author probes that exercise the AC's
user-facing intent rather than abstractions ("verify the binary works").
This is unproven. The opposite outcome — probe-author authors generic
probes that don't actually catch real bugs — is the failure mode 60-14
must rule out.

**Assumption 2 (load-bearing)**: 60-11's keyword list (`git\s+hook`,
`systemd`, `cron`, etc.) catches the event-driven AC patterns the
project will encounter. Anything outside that list (AWS Lambda
triggers, SNS, GitHub Actions workflow events, Kubernetes operators,
Kafka consumers) silently bypasses probe-author. Severity: probe-author
narrowly covers strata's vocabulary; broadens as evidence accumulates.
Mitigation tracked in out-of-scope follow-ups.

**Assumption 3 (calibration)**: probe-author catches ≥ 50% of the
defect classes strata's e2e smoke historically caught. This number is
provisional — set in 60-16 as the threshold for flipping 60-11's warn
to error. If real catch rate is meaningfully lower (< 30%), 60-16
doesn't ship and we reconsider the architecture.

## Version expectation

Sprint 13 ships as **v0.20.29** (or sequential patch versions if
batches ship independently). The new `probe-author` task type added in
60-12 is internal API surface — no consumer of `substrate-ai` reaches
into `agent-dispatch/types.ts` taskType union directly. Patch bump
appropriate; no minor-version semver concern.

## Cost projection

Per-dispatch cost estimate for the probe-author phase:
- **Input tokens**: ~5K (source AC ~2K + rendered AC ~2K + prompt ~1K
  inherited guidance from 60-4/60-10 minus implementation context)
- **Output tokens**: ~1K (probe yaml block — tight scope)
- **Per-call cost** at sonnet-4-6 rates ($3/$15 per 1M): ~$0.030

**Per-sprint cost projection**:
- Strata Phase A (the heaviest current user): 7 stories remaining
  (1-13 through 1-21 minus already-shipped). Of those, conservative
  estimate ~3 are event-driven (1-13 systemd timer, 1-14 systemd unit,
  1-15 systemd boot sequence). 3 × $0.030 = ~$0.09 incremental cost.
- Substrate self-development pipeline: stories like the 60-X ones
  shipped this session are TypeScript/test stories — zero event-driven
  AC, zero probe-author dispatches, zero added cost.
- Strata Phase B onward: rough projection ~5 event-driven stories per
  10-story phase = $0.15/phase incremental.

Cost tradeoff justifies the architectural change at any defect-catch
rate above ~10% (cost of probe-author phase < cost of one re-dispatch
+ smoke discovery + manual re-implementation).

## Story Map

Phase 2 stories ingested into the work graph for dispatch:

- 60-12: probe-author task type + dispatch wiring (P0, Medium)
- 60-13: orchestrator integration of probe-author phase (P0, Medium)
- 60-14: A/B validation harness — Phase 2 go/no-go gate (P0, Large)
- 60-15: probe-author telemetry events (P1, Medium)
- 60-16: flip 60-11 missing-trigger heuristic from warn to error (P1, Small)

**Dependency chain**: 60-12 → 60-13 → 60-14 → 60-15 → 60-16

(60-15 + 60-16 are gated on 60-14's go/no-go decision per Critical
Risks above. Phase 1 stories 60-1 through 60-11 are SHIPPED and not
in this story map; their retrospective lives in the Phase 1 table.)

## Phase 2 — Structural decoupling (PLANNED)

Phase 2 introduces a `probe-author` task type as a separate agent
dispatch, between `create-story` (artifact rendering) and `dev-story`
(implementation). The probe-author agent receives the rendered story
artifact's AC + the source epic AC but **does NOT receive the
implementation context**. It authors `## Runtime Probes` derived from
AC intent, not from implementation shape. Dev-story then implements
against the authored probes (TDD framing). Probes become a contract
between AC and implementation, not a self-test of what the dev built.

This addresses both Phase 1 root causes structurally:

1. The probe is no longer biased toward implementation surface
   (probe-author has not seen the implementation) → closes the
   "wrong assertion shape" family (obs_012).
2. The probe-author prompt inherits the production-trigger guidance
   from 60-10 explicitly. With no implementation to defer to, the
   only reasonable probe shape IS the production-trigger invocation
   → closes the "wrong invocation shape" family (obs_014).
3. Future shapes we haven't yet observed are addressed by the same
   structural property: probes derived from AC intent rather than
   implementation surface have no path to mirror an implementation
   misreading of AC.

### Story 60-12: probe-author task type + dispatch wiring

**Priority**: must

**Description**: Add a new `probe-author` task type to the agent
dispatch surface, mirroring the existing `test-plan` task type's
shape. The probe-author agent receives the rendered story artifact's
AC section + the source epic AC for the same story, but no
implementation context (no Dev Notes, no architecture constraints
beyond what's in the AC, no prior dev-story output). Output:
a `## Runtime Probes` yaml block conforming to `RuntimeProbeListSchema`,
authored from AC intent. Reuses 60-4's success-shape and 60-10's
production-trigger guidance verbatim in the prompt — those are the
patterns the AC-derived probe author needs.

**Acceptance Criteria**:
- New entry in `src/modules/agent-dispatch/types.ts` adds `'probe-author'`
  to the `taskType` union literal
- New file `packs/bmad/prompts/probe-author.md` with the probe-author
  prompt template. The prompt receives `{{rendered_ac_section}}` and
  `{{source_epic_ac_section}}` as context, NOT `{{implementation_files}}`
  or `{{architecture_constraints}}` (deliberately scope-limited)
- The probe-author prompt explicitly inherits 60-4's success-shape
  guidance (`expect_stdout_no_regex` / `expect_stdout_regex` patterns
  for structured-output probes) and 60-10's production-trigger guidance
  (event-driven mechanisms must invoke the real trigger). Both subsections
  copied / linked from `create-story.md`'s current 60-4 and 60-10 sections
  so the probe-author has the same calibration as the create-story agent
- **BDD-clause-driven probe requirement** (mitigates Hole 7 / Mary's
  Assumption 1): the prompt MUST include the directive: "For each
  `Given X / When Y / Then Z` scenario in the AC section, you MUST
  author at least one probe whose `command:` makes Y happen and whose
  `expect_stdout_regex` / `expect_stdout_no_regex` (or shell exit code
  for natively-exiting commands) asserts Z. Probes that only verify
  the implementation produces correct outputs given pre-existing
  inputs do NOT satisfy this requirement — those probes skip the
  wiring layer that the AC's user-facing event would exercise." This
  directive is the spec-level countermeasure to "probe-author authors
  generic abstractions that don't catch real bugs"; 60-14's go/no-go
  gate measures whether the directive actually translates to better
  probe quality in practice
- The probe-author prompt's Output Contract requires a single yaml block
  conforming to `RuntimeProbeListSchema` (re-uses the existing parser
  from `packages/sdlc/src/verification/probes/parser.ts`)
- New compiled-workflow definition in `src/modules/compiled-workflows/`
  for the probe-author phase (`probe-author.ts` mirroring `test-plan.ts`'s
  shape) — input validation, prompt rendering, output parsing into
  `{ probes: RuntimeProbe[] }` shape
- Token ceiling for probe-author registered in
  `src/modules/compiled-workflows/token-ceiling.ts` — start at **50000**
  (between create-story's 50000 and test-plan's 100000; probe-author's
  prompt inherits 60-4 + 60-10 guidance so it's larger than test-plan's
  but its OUTPUT is small — only the probes yaml block, not a full
  story spec or test plan). Re-calibrate after first 5 dispatches
  if real input+output usage runs > 80% of ceiling
- **Probe-author prompt size budget**: hard cap of **22000 chars**
  (~5500 tokens) on the prompt template at
  `packs/bmad/prompts/probe-author.md`. The prompt inherits the bulk
  of create-story.md's 60-4 and 60-10 subsections (~4000 chars combined)
  + AC-rendering instructions + output contract + BDD-clause directive.
  Budget enforced by a test mirroring `methodology-pack.test.ts`'s
  `BMAD pack create-story prompt exists and is within token budget`
  pattern. Bump with same justification-comment discipline if growth
  is needed
- Default model: `claude-sonnet-4-6` (same as test-plan / create-story).
  No 1M-context dependency for v1.
- 4-6 unit tests at `src/modules/compiled-workflows/__tests__/probe-author.test.ts`
  covering: prompt template renders with AC inputs, output parser handles
  valid yaml block, parser rejects schema-invalid output, missing AC
  input fails loudly, schema-drift guardrail validates every yaml fence
  in the prompt against `RuntimeProbeListSchema`, prompt budget cap test
  in `methodology-pack.test.ts` pattern

**Key File Paths**:
- `src/modules/agent-dispatch/types.ts` (modify — add 'probe-author' to taskType union)
- `packs/bmad/prompts/probe-author.md` (new — prompt template)
- `src/modules/compiled-workflows/probe-author.ts` (new — workflow def)
- `src/modules/compiled-workflows/token-ceiling.ts` (modify — add probe-author entry)
- `src/modules/compiled-workflows/__tests__/probe-author.test.ts` (new — unit tests)

---

### Story 60-13: orchestrator integration of probe-author phase

**Priority**: must

**Description**: Wire `probe-author` into the orchestrator dispatch
flow between `create-story` and `dev-story`. The probe-author runs
ONLY when the source AC contains 60-11's event-driven keywords AND
the create-story output didn't already include a `## Runtime Probes`
section authored from a source-AC-declared probes block. When it
runs, its output yaml is appended to the story artifact's
`## Runtime Probes` section (creating the section if absent). Dev-story
then receives the enriched artifact with probes pre-authored.

**Acceptance Criteria**:
- New helper `src/modules/implementation-orchestrator/probe-author-integration.ts`
  exporting `runProbeAuthor(deps, params): Promise<ProbeAuthorResult>`
  mirroring `runTestPlan` shape
- Integration in `orchestrator-impl.ts` between the existing `runCreateStory`
  call and `runTestPlan` call: call `runProbeAuthor` when the
  event-driven-keyword detector (extracted from 60-11's `detectsEventDrivenAC`
  helper, exported from `runtime-probe-check.ts`) returns true AND the
  story artifact does NOT already contain a `## Runtime Probes` section
- When probe-author runs, its yaml output is appended to the story
  artifact file (`_bmad-output/implementation-artifacts/<story_key>-<title>.md`)
  in a new `## Runtime Probes` section. The append is atomic
  (write-temp-then-rename) and idempotent (subsequent re-renders of
  the same story do not duplicate the section)
- Dev-story prompt at `packs/bmad/prompts/dev-story.md` gains a one-line
  TDD framing: "If the story artifact contains a `## Runtime Probes`
  section, your implementation MUST satisfy every probe in that section.
  Run probes locally before declaring success." Existing dev-story
  guidance unchanged otherwise
- Telemetry event `probe-author:dispatched` emitted on each invocation
  with `{storyKey, runId, probesAuthoredCount, dispatchDurationMs,
  costUsd}` payload (paired with 60-15's KPI tracking)
- Skip path: when source AC is not event-driven OR story artifact already
  has author-declared probes from create-story, no probe-author dispatch
  fires (no cost, no event)
- Backward-compat: existing strata stories (1-1 through 1-11) re-verifiable
  without probe-author firing because they don't have event-driven ACs
  (or already have author-declared probes from prior runs)
- **Failure mode recovery (mitigates Hole 6)**: probe-author dispatch
  failures are categorized and handled distinctly:
  1. **Dispatch error** (process crash, network failure, adapter
     exception): log `probe-author:dispatch-error` event, fall through
     to dev-story without authored probes. Non-fatal. Story still ships
     with whatever probes (if any) the source-AC-transfer / dev-authored
     path produces — same as pre-Sprint-13 behavior.
  2. **Timeout** (probe-author dispatch exceeds timeout): log
     `probe-author:timeout` event with elapsed ms. Single retry with
     extended timeout (1.5×). If retry also times out, fall through
     to dev-story (same as dispatch error). No more retries.
  3. **Invalid YAML** (probe-author returned output that doesn't parse):
     log `probe-author:invalid-output` event with parse error + first
     500 chars of output. Single retry with augmented prompt
     ("previous output failed parsing with: <error>; produce a single
     yaml block conforming to RuntimeProbeListSchema"). If retry also
     fails, fall through.
  4. **Empty probes list** (parsed valid yaml but list is empty): not
     a failure — author may legitimately decide no probes are needed.
     Log `probe-author:no-probes-authored` info event for telemetry;
     fall through to dev-story without authored probes. No retry.
  All failure paths are non-fatal — substrate falls through to existing
  dev-story behavior so probe-author NEVER worsens the pre-Sprint-13
  outcome
- 8-10 unit tests at
  `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts`
  covering: event-driven AC + no probes → probe-author runs; non-event AC
  → skip; AC has probes already → skip; story artifact mutation is
  idempotent across multiple runs; telemetry event emitted with correct
  shape; **the four failure paths above** (dispatch error, timeout +
  retry, invalid YAML + retry, empty probes list); end-to-end smoke
  test that a probe-author run for a synthetic event-driven AC
  produces an artifact-augmented story file with probes invoking the
  expected trigger

**Key File Paths**:
- `src/modules/implementation-orchestrator/probe-author-integration.ts` (new)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify — wire probe-author call)
- `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts` (new)
- `packs/bmad/prompts/dev-story.md` (modify — add TDD framing line)
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (modify — export `detectsEventDrivenAC`)

**Depends on**: 60-12

---

### Story 60-14: A/B validation harness — Phase 2 go/no-go gate

**Priority**: must (blocking — Phase 2 abort condition runs through this)

**Description**: This is the **go/no-go gate for the rest of Phase 2.**
Before 60-15 (telemetry) and 60-16 (gate flip) ship, 60-14 produces
empirical evidence on whether probe-author actually catches the
defect classes strata's smoke pass historically caught. If the
evidence is positive (catch rate ≥ 50%), Phase 2 continues. If the
evidence is mixed (30-50%), iteration on the probe-author prompt
before 60-15/60-16 ship. If the evidence is negative (< 30%), Phase 2
**aborts** and substrate considers Phase 3 alternatives
(adversarial probe-reviewer agent, AC-derived probe stubs, etc. — see
out-of-scope).

The validation harness includes (a) a feature flag for per-dispatch
mode selection, (b) a CLI to diff probe sets across runs, and (c) a
**defect-replay corpus** as the oracle: a curated set of
already-shipped strata stories whose smoke-discovered defects are
documented in `_observations-pending-cpo.md` (obs_011, obs_012,
obs_014, plus any new observations through Sprint 13 kickoff).
Probe-author is dispatched against each story in the corpus; the
authored probes are evaluated for whether they would have caught
the historically-known defect.

**Acceptance Criteria**:
- `SUBSTRATE_PROBE_AUTHOR_ENABLED` env var read by orchestrator;
  defaults to `true` when absent. When `false`, probe-author phase
  skipped (legacy dev-authored probes path)
- `--probe-author=enabled|disabled|auto` CLI flag on `substrate run`
  command provides per-run override (auto = read env var)
- Telemetry: `probe-author:enabled` event emitted at orchestrator start
  with `{runId, mode: 'enabled'|'disabled'|'auto', source: 'env'|'cli'|'default'}`
- New CLI subcommand `substrate probes diff <story_key> --run-a <run_id_a> --run-b <run_id_b>`
  outputs a structured diff of the `## Runtime Probes` sections from
  the two runs' story artifacts: probes-only-in-a, probes-only-in-b,
  probes-in-both. Output format: human (default) or json
- **Defect-replay corpus** at
  `_bmad-output/planning-artifacts/probe-author-defect-corpus.md`
  enumerates each historical defect with three fields:
  1. `story_key` and original run_id (where the defect shipped)
  2. `defect_description` (what strata smoke caught — paraphrased
     from the obs entry)
  3. `expected_probe_signature` — a deterministic, machine-checkable
     pattern the probe-author probe MUST produce to count as "caught"
     (e.g., for obs_014: probe's `command:` must contain
     `git\s+merge` AND `expect_stdout_no_regex` must include a
     conflict-marker pattern). Authored manually for each corpus
     entry, version-controlled, peer-reviewable
- **Oracle evaluation script** at `scripts/eval-probe-author.mjs`
  reads the corpus + dispatches probe-author against each story's
  source AC + checks each authored probe against the
  `expected_probe_signature`. Outputs a structured report:
  `{ totalDefects, defectsCaught, catchRate, perDefect: [{ storyKey,
  defectDescription, caught: bool, authoredProbes: [...] }] }`
- Validation methodology documented at
  `_bmad-output/planning-artifacts/probe-author-validation-protocol.md`:
  procedure for running the oracle eval, interpreting catch rate,
  decision tree per the three-band rubric (≥ 50% green / 30-50%
  iterate / < 30% abort)
- **Go/no-go decision is recorded** in the protocol doc as a
  signed-off decision after the first eval run completes — explicit
  "Phase 2 continues to 60-15/60-16" or "Phase 2 paused for
  prompt iteration" or "Phase 2 aborted; Phase 3 considered"
- 4 unit tests at `src/cli/commands/__tests__/probes-diff.test.ts`
  covering the diff CLI: identical artifacts → empty diff; one missing
  probe → reported in diff; both runs missing the artifact file → clear
  error message
- 3 unit tests at `scripts/__tests__/eval-probe-author.test.ts`
  covering the oracle eval: corpus parses cleanly; signature-matching
  predicate works on synthetic probe sets; catch rate math is correct
  on synthetic defect catalogs

**Key File Paths**:
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify — read env var, gate probe-author call)
- `src/cli/commands/run.ts` (modify — add `--probe-author` flag)
- `src/cli/commands/probes-diff.ts` (new)
- `src/cli/commands/__tests__/probes-diff.test.ts` (new)
- `_bmad-output/planning-artifacts/probe-author-validation-protocol.md` (new — methodology + decision record)
- `_bmad-output/planning-artifacts/probe-author-defect-corpus.md` (new — oracle)
- `scripts/eval-probe-author.mjs` (new)
- `scripts/__tests__/eval-probe-author.test.ts` (new)

**Depends on**: 60-13

**Phase 2 abort criterion**: if catch rate < 30% after one prompt
iteration cycle (i.e., adjusted prompt + second eval run), 60-15 and
60-16 are NOT built. Substrate considers Phase 3 alternatives in a
follow-up epic. Decision recorded in
`probe-author-validation-protocol.md`.

---

### Story 60-15: probe-author telemetry events

**Priority**: must

**Description**: Telemetry that closes the KPI tracking loop defined
in this epic's "Success metric" section. Emits structured events at
each probe-author lifecycle point (dispatched, output-parsed,
appended-to-artifact, skipped-non-event-driven, skipped-author-declared),
and a derived metric in `substrate metrics --output-format json`:
`probe_author_phase_dispatched_pct` (% of stories where probe-author
fired) + `probe_author_caught_defects_count` (counted via downstream
verification findings whose probe came from probe-author specifically,
distinguished by an injected probe metadata marker).

This is the smallest of the Sprint 13 stories and is the candidate for
the dogfooding pilot dispatch via substrate itself.

**Acceptance Criteria**:
- Five new event types in `src/core/event-bus.types.ts`:
  - `probe-author:dispatched` (already added by 60-13; this story formalizes the schema)
  - `probe-author:output-parsed`
  - `probe-author:appended-to-artifact`
  - `probe-author:skipped` with reason: `'non-event-driven'` | `'author-declared-probes-present'`
  - `probe-author:authored-probe-failed` — emitted by runtime-probe-check
    when a probe's metadata indicates it came from probe-author and the
    probe failed (note: probe-failure is NOT the same as defect-caught;
    see catch-rate refinement below)
- Probe metadata: `RuntimeProbe` schema in
  `packages/sdlc/src/verification/probes/types.ts` gains an optional
  `_authoredBy: 'probe-author' | 'create-story-ac-transfer'` discriminator
  field. Backward-compat: absent field treated as 'create-story-ac-transfer'.
  Set by 60-13's append logic to 'probe-author' for newly-authored probes
- **Manifest round-trip (mitigates Hole 8 / closes the same gap class
  60-8 just closed for `dev_story_signals`)**: the `_authoredBy` field
  must round-trip through:
  1. `RuntimeProbeListSchema` parser in
     `packages/sdlc/src/verification/probes/parser.ts` — accepts
     and preserves the field on parse
  2. `StoredVerificationFindingSchema` in
     `packages/sdlc/src/run-model/verification-result.ts` — when a
     finding's source probe carries `_authoredBy`, that metadata
     persists alongside `command`/`exitCode`/`stdoutTail` etc. via a
     new optional `_authoredBy` field on the stored finding
  3. `substrate status --output-format json` and `metrics --output-format
     json` projections — `verification_findings` per-story shape gains
     an optional breakdown `byAuthor: { 'probe-author': N,
     'create-story-ac-transfer': N }`
  4. Backward-compat regression test: pre-60-15 manifest entries
     (no `_authoredBy` field) deserialize cleanly; the `byAuthor`
     breakdown shows all findings under 'create-story-ac-transfer' or
     omits the field entirely
- `substrate metrics --output-format json` per-story payload gains
  `probe_author: { dispatched: bool, probesAuthoredCount: number,
  authoredProbesFailedCount: number, authoredProbesCaughtConfirmedDefectCount: number }`
  (populated from telemetry events)
- `substrate status --output-format json` per-story payload gains the
  same `probe_author` shape
- **Catch-rate metric refinement (mitigates Hole 2)**: the KPI
  distinguishes `authoredProbesFailed` (any probe failure for any
  reason — could be a real defect catch OR a probe-author bug OR a
  flaky probe) from `authoredProbesCaughtConfirmedDefects` (a probe
  failure that was subsequently confirmed as catching a real defect).
  Confirmation mechanism: post-hoc strata-side annotation. When a
  probe fails, the strata operator (or downstream automation) reviews
  the failure and tags it via a CLI command:
  `substrate annotate --story <key> --finding-category runtime-probe-* --confirmed-defect|--false-positive|--probe-bug`
  The annotation persists in the run manifest under
  `per_story_state[storyKey].verification_result.annotations[]`.
  Without annotation, the failure stays in the `authoredProbesFailed`
  bucket but does NOT count toward `authoredProbesCaughtConfirmedDefects`
- New rollup helper `rollupProbeAuthorMetrics(summary, annotations)` in
  `packages/sdlc/src/run-model/probe-author-metrics.ts` mirroring
  `rollupFindingCounts` shape; reads annotations to populate the
  `confirmed-defect` count
- Cross-run aggregate: `substrate metrics --probe-author-summary` flag
  prints `{ totalStoriesDispatched, probeAuthorDispatchedCount,
  probeAuthorDispatchedPct, totalAuthoredProbes,
  totalAuthoredProbesFailed, totalConfirmedDefectsCaught,
  catchRateByCount, catchRateByConfirmedDefect }` — the latter is the
  load-bearing KPI for this epic
- 7 unit tests covering: event emission shape; rollup helper math
  (with and without annotations); probe metadata round-trip through
  manifest (4 backward-compat cases per Hole 8 mitigation); CLI flag
  parsing; aggregate computation correctness; annotate CLI subcommand
  basic flow

**Key File Paths**:
- `src/core/event-bus.types.ts` (modify — add 5 new event types)
- `packages/sdlc/src/verification/probes/types.ts` (modify — add `_authoredBy` field)
- `packages/sdlc/src/verification/probes/parser.ts` (modify — preserve `_authoredBy` on parse)
- `packages/sdlc/src/run-model/verification-result.ts` (modify — `_authoredBy` on `StoredVerificationFindingSchema`)
- `packages/sdlc/src/run-model/probe-author-metrics.ts` (new)
- `packages/sdlc/src/run-model/index.ts` (modify — export new helper)
- `src/cli/commands/status.ts` (modify — surface probe_author shape + byAuthor breakdown)
- `src/cli/commands/metrics.ts` (modify — surface probe_author shape + --probe-author-summary flag)
- `src/cli/commands/annotate.ts` (new — `substrate annotate` subcommand for confirmed-defect tagging)
- `src/cli/commands/__tests__/annotate.test.ts` (new)
- `packages/sdlc/src/run-model/__tests__/probe-author-metrics.test.ts` (new)
- `src/cli/commands/__tests__/probe-author-summary.test.ts` (new)

**Depends on**: 60-13, 60-14 (60-14's go/no-go decision must be GREEN
before 60-15 starts; per the abort criterion, 60-15 doesn't ship if
catch rate < 30%)

---

### Story 60-16: flip 60-11 missing-trigger heuristic from warn to error

**Priority**: should

**Description**: Once probe-author exists as the recommended path for
event-driven stories (post-60-13), the 60-11 missing-production-trigger
heuristic shifts from "advisory until calibrated" to "you bypassed the
recommended path AND missed the trigger" — which IS hard architectural
drift, not advisory. Flip severity from `warn` to `error`. Story
SHIP_IT becomes blocked when both conditions hold:
(a) source AC is event-driven and (b) the dev's resulting probes don't
invoke the production trigger AND (c) probe-author didn't run for some
reason (skipped via flag, dispatch error, or test scenario).

**Acceptance Criteria**:
- `runtime-probe-check.ts` `CATEGORY_MISSING_TRIGGER` finding severity
  changes from `'warn'` to `'error'` — gate becomes blocking
- Existing 60-11 tests updated to expect error severity (8 tests)
- New test: when probe-author DID run for an event-driven story
  (probes carry `_authoredBy: 'probe-author'` metadata) AND those probes
  invoke a known trigger pattern, no missing-trigger finding emitted
  (probe-author satisfies the gate)
- Failure-mode test: probe-author was skipped (e.g., feature flag off
  via `SUBSTRATE_PROBE_AUTHOR_ENABLED=false`) AND dev probes don't
  invoke trigger AND AC is event-driven → error-severity finding emits
  AND verification status becomes `fail`
- Documentation update at `packs/bmad/prompts/create-story.md` (60-10's
  subsection): note that the missing-trigger heuristic is now a gate,
  not advisory, and that probe-author is the recommended way to satisfy
  it
- **Calibration threshold decision tree (mitigates Hole 3)**: 60-16
  ships only after 60-14's eval run records one of three decisions:
  1. **Catch rate ≥ 50%**: 60-16 ships as written. Severity flips
     warn → error.
  2. **Catch rate 30-50%**: 60-16 ships in **soft mode** — severity
     stays at `warn` but the finding's `message` is augmented with
     "this would gate Phase 3" framing to set expectations. 60-14
     prompt-iteration cycle re-runs; if next eval reaches ≥ 50%,
     ship the hard flip in v0.20.30+ as a follow-up.
  3. **Catch rate < 30%**: 60-16 does NOT ship. Phase 2 abort
     condition triggers per 60-14's protocol. The 60-11 heuristic
     stays as warn-severity advisory; a follow-up epic considers
     Phase 3 alternatives.
  The decision is recorded in
  `_bmad-output/planning-artifacts/probe-author-validation-protocol.md`
  with the eval-run output, the decision rationale, and (if
  applicable) the iteration plan
- **Annotation requirement**: catch rate is computed from
  `authoredProbesCaughtConfirmedDefects` (annotated) NOT raw
  `authoredProbesFailed`. Calibration is not valid until ≥ 5
  event-driven stories have been annotated. If fewer than 5 are
  annotated when 60-14 eval first runs, hold 60-16 and continue
  collecting annotations

**Key File Paths**:
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (modify — severity flip OR message-augment depending on decision tree band)
- `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts` (modify — 8 tests + 2 new)
- `packs/bmad/prompts/create-story.md` (modify — note gate transition in 60-10's subsection, conditional on which decision tree band shipped)
- `_bmad-output/planning-artifacts/probe-author-validation-protocol.md` (modify — record final decision)

**Depends on**: 60-15 (annotations infrastructure required for valid
calibration), and 60-14 reaching at least its first decision-record
event with ≥ 5 annotated stories

---

## Success metric (KPI)

**% of strata stories shipped without strata-side e2e smoke catching
defects substrate's gates passed.**

- **Baseline (Phase 1, v0.20.28)**: 0/5 of recent strata dispatches
  shipped without a smoke-caught defect. Runs 9, 11, 12, 12-followup,
  13 each surfaced a distinct shape that all five Tier A checks passed.
- **Phase 2 target**: ≥ 90% of strata stories ship without a smoke-caught
  defect. Measured over a sliding window of the last 10 strata
  dispatches post-60-16 ship.
- **Tracking**: 60-15's telemetry emits the events; 60-14's validation
  protocol provides the methodology to measure; strata team's
  post-batch smoke pass continues per `feedback_strata_e2e_smoke_after_batch.md`
  and reports any caught defects via observation file. Failures inform
  the next epic.

## Dispatch scoping per `feedback_strata_dispatch_rule.md`

Stories 60-12, 60-13, 60-14, 60-15, 60-16 share a substantial code
surface (orchestrator, runtime-probes-check, telemetry events) AND
have a strict dependency chain. Per the "max 3 stories same surface"
rule + the dispatch-can't-parallelize-dependents rule, dispatch in
**four sequential batches** (no parallelism within Sprint 13):

- **Batch A (foundation)**: 60-12 alone (probe-author task type
  creation — zero dependencies). Lands first; commits before Batch B
  starts.
- **Batch B (integration)**: 60-13 alone (orchestrator wiring).
  Depends on 60-12. Lands second; commits before Batch C starts.
- **Batch C (validation gate)**: 60-14 alone (A/B harness + oracle +
  go/no-go decision). Depends on 60-13. Decision recorded in
  validation-protocol doc determines whether Batch D ships.
- **Batch D (telemetry + gate flip)**: 60-15 + 60-16 together IF
  60-14's decision was GREEN (catch rate ≥ 50%). 60-15 (telemetry +
  annotation) and 60-16 (gate flip) are disjoint surfaces (telemetry
  + cli vs. one-line severity flip in runtime-probe-check) and 60-16
  depends on 60-15's annotation infrastructure being committed before
  it dispatches — so 60-15 lands first within Batch D, then 60-16.
  IF 60-14's decision was YELLOW (30-50%): Batch D delays for prompt
  iteration cycle. IF RED (< 30%): Batch D does NOT ship; Phase 2
  aborts per the protocol.

Each batch passes through `--max-review-cycles 3` per the standard
strata dispatch rule.

## Realistic sprint sizing

The team's initial 2-3 day estimate (Sprint 13 = 1 week) was
optimistic — it accounted for implementation but not for prompt
iteration, calibration cycles, or the validation evidence loop.

**Honest sizing: 1-2 sprints (1-2 weeks)** broken down:

- **Batch A (60-12)**: 1-2 days. Mostly file scaffolding mirroring
  test-plan; the load-bearing work is the probe-author prompt itself
  (which often takes 2-3 iteration passes to get right).
- **Batch B (60-13)**: 1-2 days. Orchestrator wiring + 4 failure-mode
  handling paths + 8-10 tests.
- **Batch C (60-14)**: 2-3 days. Defect corpus authoring (the oracle)
  is non-trivial — each entry needs a manually-curated
  `expected_probe_signature` + peer review for correctness. Plus the
  eval script + protocol doc.
- **Calibration window**: 1-3 days for the eval run + (if YELLOW)
  prompt iteration + re-eval.
- **Batch D (60-15 + 60-16)**: 1-2 days IF Batch D ships. Largely
  mechanical at that point.

Total: optimistic ~6 days, realistic ~10 days, with a Phase 2 abort
branch that exits earlier if 60-14 lands RED. Honest sizing also
includes one full strata-dispatch validation cycle after Batch D ships
(per `feedback_strata_e2e_smoke_after_batch.md`).

## Out-of-scope follow-ups

- **Probe-author for non-event-driven stories**: structural argument
  ("decouple probe authorship from implementation") applies to all
  story types, but evidence so far concentrates the failure mode on
  event-driven stories. Phase 2 scoped via 60-11's heuristic to
  control cost; broaden if/when post-60-16 evidence shows the same
  failure mode in non-event-driven stories.
- **60-11 keyword list extensibility (Hole 5)**: 60-11's regex list
  in `runtime-probe-check.ts` (`EVENT_DRIVEN_KEYWORDS`,
  `TRIGGER_COMMAND_PATTERNS`) is the load-bearing gate for whether
  probe-author runs at all. Anything outside the list silently
  bypasses Phase 2's whole architecture. Three follow-ups worth
  tracking:
  1. Telemetry on the heuristic's skip rate
     (`probe-author:skipped` event with reason `non-event-driven`)
     so we can see what we're missing.
  2. Periodic review of `_observations-pending-cpo.md` for new
     defect classes; if a defect class is event-driven by some
     vocabulary not in the keyword list, that's a signal to expand.
  3. Author-declared opt-in escape hatch: a story's source AC could
     declare `<!-- substrate:probe-author=force -->` to force-run
     probe-author regardless of keyword detection. Cheap, gives
     authors control. Add if at least one observation calls for it.
- **Phase 3 alternatives** (if Phase 2 aborts at 60-14's RED decision):
  - **C2: Adversarial probe-reviewer agent.** Dev authors probes;
    separate agent reviews them with one question: "would this probe
    pass if the implementation were a no-op?"
  - **C3: AC-derived probe stubs (deterministic, no LLM).** Substrate
    generates probe templates from AC patterns; dev fills in details.
    Eliminates "dev invented the probe" entirely.
  Both require their own epic if Phase 2 doesn't deliver.
- **HTTP-route detection in 60-7's operational-path heuristic**: deferred
  per the original 60-7 scope; revisit if a story trips on a `/api/...`
  route URL flagged as architectural drift.
- **1M-context model variant**: 60-9 punted on `[1m]` suffix support
  until empirical Claude Code CLI verification. Not blocking Phase 2.
- **MEMORY.md hygiene**: at 27KB, over the 24.4KB soft limit. Migrate
  per-version one-liners to a `project_version_history.md` topic file.
  Not blocking; quality-of-life cleanup.
