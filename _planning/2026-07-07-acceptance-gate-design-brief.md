# Design brief: the Product-Acceptance Gate (the missing sprint demo)

*2026-07-07 (rev 2). Synthesis of (a) the income-sources field incident, (b)
the post-hoc product-acceptance review that caught it, and (c) the 2026-07-06
deep research run (`nanoclaw .../2026-07-06-product-acceptance-checkpoints-
agentic-dev.md` — 40 verified sources). Companion to the field-feedback and
remediation-audit docs. Status: **build-ready design** for substrate
hardening. Rev 2 restructures rev 1 around three findings from design
review: (1) the story-tag trigger recursed the original blind spot —
journey-coverage accounting is now the spine; (2) environment bring-up is
now an explicit per-project contract, not an assumption; (3) merge policy
now compiles onto the existing finalization modes instead of inventing a
new one.*

## The one-sentence case

Verification checks the changes an agent **made**; nothing in substrate — or
any of the nine products/frameworks surveyed — checks the journeys that were
**supposed to exist**. A capability that is never wired into the
user-facing artifact produces no diff to review, no failing test, and no
screenshot the implementing agent thinks to take.

## Field evidence (first-hand, income-sources build)

The PRD's central user journey (UJ-2: operator taps yes/no/defer on an
emailed Dossier) was structurally impossible through:
6 adversarial epic gates, ~1,400 tests incl. an independently-authored
hidden-test suite, live-fire e2e, and CI. Found only by accident (an email-
transport test), then systematically by a one-off **product-acceptance
review**: render the real artifacts, walk the PRD journeys against them.
That review found the same class 3 more times (grade loop unreachable,
Pre-Claim contract absent, absence-handling half-wired) plus a renderer
that withheld 6 of 13 computed conviction fields — all invisible to
code-scoped review, all obvious the moment a rendered Packet was read
against UJ-2. Fix cost after the fact: one agent-day. Detection cost had a
gate existed: minutes, at the story that owned the journey.

External corroboration: METR — ~50% of SWE-bench-passing agent PRs would be
human-rejected, automated grading ~24pp above human merge decisions;
SWE-Bench+ — ~31% weak-test passes; ImpossibleBench — 46-93% reward-hacking.
"All tests green" is measurably weak evidence of intent-met. No published
post-mortem names this gap — the framing is unclaimed. No surveyed product
ships the ceremony (BMAD's `checkpoint-preview` is explicitly a code-diff
reading guide).

**A critical reading of the evidence** (drives Phase 1 scoping below): every
one of the five catches was made by *reading a rendered artifact against a
journey spec*. None required interactively driving a UI. Render-and-judge
is the demonstrated-value core; the interactive walkthrough is the
speculative (and expensive) extension. The build order reflects this.

## Design principles (each one paid for)

1. **Coverage is accounted, not inferred.** A gate that fires only when a
   story is tagged with a journey can be evaded by the exact failure it
   exists to catch: a journey *nobody claimed*. UJ-2 failed because nobody
   wired it; if no story tags UJ-2, a per-story trigger never fires either.
   The spine of this design is therefore a closed-loop ledger — every PRD
   journey is claimed, walked, or explicitly deferred, and anything else
   escalates. Per-story gating is an early-detection optimization on top,
   never the primary defense.
2. **Specs are frozen before implementation and read from the trusted
   tree.** H7 posture, verbatim: worktree isolation is accident-mitigation,
   not a security boundary, and verification inputs must come from the
   trusted main tree, never the agent-writable worktree copy. Journey
   specs, end-states, and the acceptance recipe are authored at
   planning/solutioning time, immutable during implementation, and the gate
   reads them from the main tree at dispatch snapshot. Same lineage-
   separation logic as the hidden-test suite.
3. **A gate is distrusted until it catches a planted failure.** v0.21.1
   lesson: the H7 disclosure gate false-escalated every real story for
   three versions while its stub matrix stayed green, because the stub
   didn't mirror real output shape. Every gate this program ships gets a
   live counterexample before release confidence, and acceptance canaries
   keep it honest afterward.
4. **False positives are tracked as first-class as false negatives.**
   Also v0.21.1: a gate that blocks correct work burns operator trust in
   days. Every FAIL carries adjudicable evidence; operator overrides are
   recorded; gate precision is a standing metric next to canary recall.
5. **Silent skip is forbidden.** Probe-skip discipline: an acceptance
   environment that won't come up escalates `acceptance-unrunnable` —
   it never quietly passes. A skipped gate is indistinguishable from the
   blind spot it was built to close.
6. **Language-agnostic via declared contract, not detection.** Substrate
   cannot know how to boot arbitrary products. The project declares how its
   surfaces render (like `testCommand`); substrate orchestrates, it never
   guesses.

## Architecture: three layers

### Layer 1 — the Journey Registry and coverage invariant (the spine)

A machine-readable registry derived from the PRD at planning time, versioned
with the PRD, living in the trusted tree:

```yaml
# .substrate/acceptance/journeys.yaml  (trusted tree; frozen per PRD rev)
version: 3                    # bumps with PRD revisions; verdicts cite it
journeys:
  - id: UJ-2
    title: Operator decides on an emailed Dossier
    criticality: critical     # critical | standard
    surfaces: [email]
    end_states:
      - id: UJ-2.a
        given: "Dossier rendered from fixture run 2026-06-01"
        walk:  "open email; locate yes/no/defer affordance for top rec"
        then:  "affordance present and actionable in rendered HTML+text"
      - id: UJ-2.b
        given: "operator taps Yes"
        walk:  "follow the Yes affordance end-to-end"
        then:  "a decision row exists with verdict=yes"
```

End-states are **concrete and artifact-grounded** — a thing that exists or
doesn't in a rendered surface — never "does this look good?". They are
authored at solutioning time by the planning lineage, before any
implementing agent exists.

**The coverage invariant, enforced at epic close:** every journey whose
epic is complete is in exactly one state —

| State | Meaning | On violation |
|---|---|---|
| `walked-pass` | gate ran, all end-states pass | — |
| `walked-fail` | gate ran, ≥1 end-state fails | `acceptance-fail` escalation |
| `deferred` | operator explicitly deferred, ack recorded on manifest | — |
| `unclaimed` | no story owns it | `journey-unclaimed` escalation — **this is the UJ-2 class, caught structurally** |
| `unwalked` | claimed but gate never ran | `journey-unwalked` escalation |

`create-story` writes `journeys: [UJ-x]` tags onto story artifacts (tag
*recall* no longer needs to be perfect — the invariant catches misses at
epic close; tags only buy earlier detection). The epic-close audit is pure
ledger arithmetic — no LLM in the loop, nothing to game.

### Layer 2 — the `acceptance` stage (render → walk → judge → emit)

Sits beside verification, not inside it. Runs pre-merge for tagged
stories; runs as a full pass at epic close.

1. **RENDER.** Bring the built product up per the project's declared
   acceptance contract (below) in the story worktree + fixture data. Real
   compose/render path — no mocks on the render side. Surfaces include the
   out-of-band artifacts every existing tool stops at: email HTML+text,
   PDFs, CLI output, generated files. This boundary is exactly where the
   field failure lived.
2. **WALK** (surface-typed drivers, external to the implementing agent):
   - `file`/`email`/`cli` surfaces: headless render + artifact-reader
     (vision/LLM read of the rendered output). **Phase 1 — this alone
     catches the entire demonstrated class.**
   - `web` surfaces: browser driver (Midscene.js `aiAct`/`aiAssert` on
     what the user sees, Playwright MCP as glue). **Phase 3 — gated on
     cost data.**
3. **JUDGE** (Agent-as-a-Judge, arXiv:2410.10934). Separate agent, separate
   prompt lineage; receives the rendered artifacts, the walk trace, and the
   end-state list **from the trusted tree** — never the story diff, never
   the implementer's conversation or framing. Emits a per-end-state verdict:
   - `PASS` — end-state present in the rendered artifact, evidence cited
   - `FAIL` — end-state absent/wrong, evidence cited
   - `UNREACHABLE` — the walk could not even be attempted (the affordance
     doesn't exist). First-class verdict, not an error: **UNREACHABLE is
     what UJ-2 was.**
   Naive prose judging is banned by construction — the judge must cite a
   region of a rendered artifact for every verdict (12 documented LLM-judge
   biases; polished-but-broken output is the factory's natural failure
   mode).
4. **EMIT** a minutes-scale human artifact: one HTML page per story/epic —
   per-journey verdict table, rendered surfaces inline, annotated
   screenshots, each FAIL linked to its evidence region. Target: operator
   verdicts it in <1 minute. Surfaced through `substrate report` and the
   existing `.substrate/notifications/` path — no new operator surface.

Retry policy: **retry-once on driver/judge flake; never on render.** A
render that differs run-to-run is itself a finding.

### Layer 3 — merge policy compiled onto finalization modes

No new merge machinery. The risk tiers map to the existing
`merge`/`branch`/`pr` finalization seam (v0.20.147) as per-story overrides,
which preserves fully-autonomous overnight runs:

| Tier | Gate verdict | Attended run | Autonomous run (`--halt-on none`) |
|---|---|---|---|
| journey-critical | FAIL / UNREACHABLE | hard block, operator prompt | escalate; worktree + branch preserved (existing failure-path behavior) |
| journey-critical | PASS | human watches artifact, triggers merge | **finalize as `branch`/`pr`** — deliverable branch + verdict artifact for morning review; run keeps moving |
| standard | FAIL | auto-file fix story, continue | auto-file fix story, continue |
| standard | PASS | normal `merge` path | normal `merge` path |
| untagged story | n/a | normal path | normal path (epic-close invariant is the backstop) |

Morning review of an autonomous run: `substrate report --run latest` now
includes the acceptance verdict table; journey-critical PASSes are sitting
on branches awaiting a one-look human merge — the sprint demo, delivered to
your inbox instead of scheduled in a room.

## The acceptance contract (per-project, declared, trusted-tree)

Extension to the project profile — authored at solutioning time, exactly
like `testCommand`:

```yaml
# .substrate/project-profile.yaml (addition)
acceptance:
  fixtures: eval/fixtures/acceptance     # seeded data the render consumes
  surfaces:
    email:
      render: "uv run python -m dossier.render --fixtures {fixtures} --out {artifacts}"
    cli:
      render: "uv run python -m dossier.cli report --fixtures {fixtures}"
    web:                                  # Phase 3
      serve: "npm run preview -- --port {port}"
      ready: "http://localhost:{port}/healthz"
```

Rules:
- Contract absent but registry has journeys → `acceptance-unrunnable` at
  epic close (principle 5: no silent skip).
- The gate reads the contract and the registry **from the main tree at the
  dispatch snapshot**, never the worktree copy. If the worktree copy
  diverges from the trusted copy, escalate `acceptance-spec-tampered` —
  cheap to check, and it converts a known H7-class evasion into a tripwire.
- Render commands run under the same env scrub + scoped permission profile
  as dispatch (v0.20.150/151); same accident-mitigation caveats apply until
  the container backend lands.

## Anti-gaming guardrails (all five, deliberately)

(a) judge grounded in rendered artifact + concrete end-state, evidence
    citation mandatory;
(b) acceptance signal EXTERNAL to the implementing agent — separate agent,
    separate prompt lineage, no access to the implementer's framing, specs
    frozen pre-implementation and read from the trusted tree;
(c) risk-tiering so scarce human attention lands on journey-critical
    increments (automation-complacency literature: reliable systems erode
    monitoring, and instruction doesn't fix it — design must);
(d) **acceptance canaries with real regressions**: periodically pick a
    `walked-pass` journey, revert its wiring commit in a scratch worktree,
    re-run the gate — verdict must flip to FAIL/UNREACHABLE. A synthetic
    fixture canary would repeat the v0.21.1 stub mistake (a stub that
    doesn't mirror real output shape shares the operator's blind spot);
    reverting a real commit *is* the real shape. Missed canary →
    `acceptance-canary-missed`, hard escalation; the gate is distrusted
    (verdicts advisory-only) until the miss is diagnosed;
(e) **precision instrumentation**: every operator override of a FAIL is
    recorded on the manifest; standing metrics are canary recall (misses
    caught / planted) AND verdict precision (confirmed fails / total
    fails), persisted alongside existing run metrics (Dolt-backed where
    available). A gate below precision floor gets the same advisory-only
    demotion as a canary miss.

## Event and escalation surface (implementation checklist)

NDJSON events: `acceptance:started`, `acceptance:rendered {surface,
artifact_path}`, `acceptance:verdict {journey, end_state, verdict,
evidence_path}`, `acceptance:coverage {claimed, walked_pass, walked_fail,
deferred, unclaimed, unwalked}`, `acceptance:canary {journey, caught}`.

Escalation types: `acceptance-fail`, `journey-unclaimed`,
`journey-unwalked`, `acceptance-unrunnable`, `acceptance-spec-tampered`,
`acceptance-canary-missed`. All flow through the existing Recovery Engine
tiers (Tier A retry-with-context applies to driver flake; Tier B re-scope
proposals apply to `acceptance-fail` on standard-tier journeys).

Manifest additions: `journeys[]` state ledger per run;
`acceptance_overrides[]`; canary/precision counters.

## Definition of done for the gate itself (counterexample-first)

Before the gate ships as blocking, it must pass the retro-fit test —
pointed at income-sources:

- **@ pre-fix SHA: detects 5/5 known misses** (UJ-2 unreachable, grade
  loop unreachable, Pre-Claim contract absent, absence-handling
  half-wired, 6/13 conviction fields withheld) with correct verdicts and
  cited evidence.
- **@ post-fix SHA: 0 false FAILs** across the same registry.
- One live real-agent story run end-to-end through the gate (v0.21.1
  lesson: stub/e2e green is not release confidence for a gate).

This doubles as the first entry in the eval-framework regression tier —
the income-sources pre-fix tree is a permanent, real-world graded corpus
for never-wired-journey detection.

## Build order (each phase independently shippable)

1. **Registry + coverage invariant.** `journeys.yaml` schema, create-story
   tag emission, epic-close ledger audit + `journey-unclaimed`/
   `journey-unwalked` escalations. No renderer, no judge, no new runtime —
   pure accounting, and it already closes the UJ-2 class structurally
   (the failure becomes loud instead of silent).
2. **Acceptance contract + render-and-judge** for `file`/`email`/`cli`
   surfaces at epic close. Trusted-tree reads, spec-tamper tripwire,
   verdict artifact into `substrate report`. Ships behind
   `acceptance.enabled` config; verdicts advisory-only until the
   definition-of-done retro-fit passes.
3. **Per-story gating + finalization tier mapping.** Journey-critical
   stories gate pre-merge; tier table above compiles to finalization
   overrides. Track per-story gate cost from day one (answers the
   affordability question with data, not opinion).
4. **Interactive web walkthrough** (Midscene/Playwright driver). Gated on
   Phase 3 cost data and on an actual web-surface consumer project needing
   it — do not build ahead of demand.
5. **Canaries + precision demotion.** Requires a baseline of real verdicts
   to keep honest; last for a reason.

## Why substrate specifically

Substrate already owns the story artifact, the worktree, the trusted-tree
verification posture, the finalization seam, the escalation/recovery
engine, and the eval framework — all six integration points this gate
needs, all hardened within the last month. Per the landscape research, NO
factory ships this; the framing ("the missing sprint demo") appears to be
publishable/claimable, and the income-sources retro-fit gives the claim a
verifiable, real-world benchmark rather than a demo reel.

## Open questions (now instrumented, not rhetorical)

- Rendered-artifact judge vs code-grounded judge on never-wired-journey
  detection: A/B on the income-sources pre-fix corpus (Phase 2 exit
  criterion supplies the harness).
- Per-story affordability at factory throughput: answered by Phase 3 cost
  telemetry before Phase 4 is considered.
- Minimum artifact a human can verdict in <1 minute: measure time-to-merge
  on journey-critical branches from morning reports.
- Do canaries preserve vigilance over months: canary recall + override
  latency trends in the standing metrics (Phase 5).
