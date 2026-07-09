# Design brief: Registry Provenance (closing the gate's upstream blind spot)

*2026-07-09. Sibling arc to the Product-Acceptance Gate
(`_planning/2026-07-07-acceptance-gate-design-brief.md`, shipped v0.21.2–
v0.21.12, program DONE). Status: **build-ready design**. Sequencing decision
(operator-ratified 2026-07-09): provenance → GC.1 → A5.4 — a hollow pass on
a real journey is a lesser failure than a perfect gate pointed at an
incomplete vision.*

## The one-sentence case

The acceptance gate's coverage invariant is airtight *downstream* of
`journeys.yaml` — every registered journey ends every run walked, deferred,
or escalated — but the registry itself is hand-transcribed from the PRD,
and **a journey that never makes it into the registry is invisible to the
entire machine**: if UJ-2 had been dropped at transcription time, the gate
built to catch UJ-2 would have stayed green while UJ-2 happened again.

## Where the trust problem actually moved

The gate deliberately converted "do 1,400 tests cover the product vision?"
(unauditable) into "does one small YAML file cover the product vision?"
(auditable in minutes). That was the right trade — but the conversion step
is currently manual and unaccounted:

- **Today:** an operator (or planning-lineage agent) reads the PRD and
  hand-authors `journeys.yaml`. `substrate acceptance validate` checks it
  *structurally* (schema shape, critical journeys declare an epic,
  expectations parse) — it says nothing about whether the journeys are the
  *right* ones or *all* of them.
- **The raw material already exists and is discarded.** The UX phase
  (`ux-step-3-journeys.md`) emits `user_journeys` as a first-class output
  contract field — but as an array of prose strings
  (`schemas.ts:296`), consumed by no downstream phase. The planning-phase
  FR prompt tells stories to "capture a user journey" with no structured
  emission at all. The vision is machine-adjacent at planning time and then
  thrown away; the registry is re-derived by hand days later. Transcription
  across that gap is exactly where fidelity dies.
- The income-sources retro-fit registry was authored this way (manually,
  by reading the PRD). It worked because one person held both documents in
  their head on the same day. That does not scale and is not accounted.

## Design principles (each one paid for)

1. **Derivation is generated; ratification is human.** The machine
   eliminates transcription drift; the operator remains the fidelity
   authority. A generated registry the operator never read is as
   untrustworthy as a hand-typed one — the ratification ack is recorded,
   not assumed. (Same posture as the gate's operator-override discipline:
   human judgment is instrumented, never bypassed.)
2. **Completeness is accounted, not inferred** — the gate's own principle
   1, applied one level up. Every journey identifiable in the PRD is in
   exactly one state: `registered` or `excluded` (with a recorded reason).
   Anything else escalates **at solutioning close** — when a fix costs a
   YAML edit — not at epic close when the build is done.
3. **Provenance is recorded, staleness is detected.** The registry carries
   a `provenance:` block naming the PRD revision and source-content hash it
   was derived from. When the PRD moves and the registry doesn't, that is
   detectable arithmetic, not an operator's memory. This is how registries
   rot in every requirements-traceability system ever shipped; rot must be
   loud.
4. **Lineage separation holds.** Derivation runs in the planning lineage,
   before any implementing agent exists, and the ratified registry is
   frozen + trusted-tree-read exactly as today (A1.x machinery unchanged).
   This arc adds a floor under the registry; it does not touch the walls.
5. **Brownfield-first.** Most consumer projects (income-sources, strata)
   have a PRD as a markdown file, not a substrate planning-phase run. The
   derivation must accept "point me at a document" as a first-class input,
   with the pipeline-integrated path as the zero-friction case on top.

## Architecture: four pieces

### RP.1 — structured journey emission at planning time (stop discarding the signal)

Upgrade the UX phase output contract: `user_journeys` becomes an array of
structured entries (id, title, criticality, surfaces, prose walk) instead
of prose strings, with a schema-versioned fallback (prose entries remain
legal; they derive to `needs-elaboration` candidates). The planning-phase
FR step gains a parallel instruction to tag FRs with the journey ids they
serve. Result: by solutioning time the vision exists in machine shape,
authored by the phase that owns it — no new phase, two prompt/schema edits.

### RP.2 — `substrate acceptance derive` + ratification

```
substrate acceptance derive --prd <path|phase-artifact> [--ux <artifact>]
  → .substrate/acceptance/journeys.candidate.yaml
substrate acceptance ratify [--edit]
  → journeys.yaml with provenance block; candidate deleted
```

- `derive` runs a planning-lineage agent over the PRD (+ UX journeys where
  available) and emits a **candidate** registry: journeys, criticality
  (with one-line rationale), surfaces, end-state seeds phrased
  artifact-grounded per the gate's authoring rules. The candidate is
  explicitly non-authoritative — the gate ignores it.
- `ratify` is the human step: operator reviews/edits the candidate,
  confirms, and the tool writes `journeys.yaml` with:

```yaml
provenance:
  derived_from: docs/prd.md            # or phase-artifact ref
  source_sha256: <content hash>
  prd_revision: 3
  derived_at: 2026-07-09T…
  ratified_by: operator                 # recorded ack, principle 1
  excluded:
    - candidate: "Admin bulk re-import"
      reason: "post-MVP, PRD §7 explicitly defers"
```

- Editing `journeys.yaml` by hand remains legal (the file format is
  unchanged; `provenance:` is additive/optional) — but a registry without
  provenance is flagged by `validate` as `provenance-absent` (advisory),
  so the paved road is visible without breaking existing users.

### RP.3 — the completeness cross-check (the load-bearing piece)

The mirror of the gate's coverage invariant, run at solutioning close (and
on demand via `substrate acceptance validate --against-prd`):

| State | Meaning | On violation |
|---|---|---|
| `registered` | PRD journey has a registry entry | — |
| `excluded` | operator recorded a reason in provenance | — |
| `undispositioned` | PRD journey with no registry disposition | `journey-undispositioned` escalation |

Mechanics: a **separate-lineage checker agent** (same posture as the
acceptance judge — sees the PRD and the registry, never the derivation
conversation) enumerates journey-shaped claims in the PRD and maps each to
a disposition. Evidence rule applies: every `undispositioned` finding must
cite the PRD span it read the journey from. Deterministic pre-pass: any
`user_journeys` entry from RP.1 artifacts missing from registry+excluded is
a guaranteed catch before the agent even runs (pure set arithmetic, nothing
to game).

False-positive posture, learned from F7: PRD prose is fuzzy — the checker
WILL surface aspirational sentences that aren't really journeys. So
`journey-undispositioned` lands **advisory** with a one-command resolution
path (`ratify --exclude <id> --reason …`), and follows the gate's
ADVISORY-UNTIL-PROVEN discipline: blocking only after a retro-fit shows
acceptable precision. An operator who has to argue with the checker weekly
will turn it off (principle 4 of the gate brief; false positives burn
trust).

### RP.4 — staleness detection on PRD revision

`validate` (and the run-start acceptance preflight) re-hashes
`provenance.derived_from`; hash mismatch → `registry-stale` (advisory):
"the PRD moved since this registry was ratified — re-run derive and diff."
`derive` against an existing registry emits a **diff view** (added/
removed/changed journeys) rather than a fresh candidate, so re-ratification
is a review of the delta, not a re-read of the world. Registry `version:`
bumps on re-ratification, and verdicts already cite it (gate machinery,
unchanged).

## What this arc does NOT do

- No change to the gate's runtime: coverage invariant, judge, finalization
  mapping, tamper guards all read the same frozen `journeys.yaml`.
- No auto-ratification, ever. A pipeline that writes its own acceptance
  criteria and then grades itself against them has laundered the vision;
  the human ack is the point.
- No claim of semantic completeness. RP.3 catches *dropped* journeys
  (transcription loss — the demonstrated class); it cannot certify the PRD
  itself expresses the operator's actual intent. That boundary is the
  operator's, permanently.

## Definition of done (counterexample-first, per gate principle 3)

- **Retro-fit derive @ income-sources PRD:** the candidate registry
  contains all 5 founding journeys (UJ-2 above all) with correct surfaces,
  *without operator hint* — measured against the hand-authored retro-fit
  registry as reference.
- **Planted omission:** delete UJ-2 from a registry, run the RP.3 check
  against the PRD → `journey-undispositioned` fires citing the PRD span.
  (The gate analog of the planted never-wired journey in A7.)
- **Planted staleness:** mutate the PRD post-ratification → `registry-stale`
  fires; `derive` diff view shows exactly the mutated journey.
- **0-noise floor:** RP.3 against the income-sources post-fix PRD +
  complete registry produces zero `undispositioned` findings (or each
  finding is operator-adjudicated as a genuine PRD ambiguity, recorded).
- One live pipeline run (analysis→solutioning on a fixture concept) where
  RP.1 structured journeys flow into a derived candidate end-to-end.

## Build order (each independently shippable)

1. **RP.2 derive+ratify, brownfield path** (`--prd <file>`). Highest value
   per line: it serves income-sources/strata *today* and creates the
   provenance block everything else reads. No pipeline-phase coupling.
2. **RP.4 staleness** — trivial once provenance exists (hash compare +
   diff view); ships with or immediately after RP.2.
3. **RP.3 completeness check** — deterministic pre-pass first, checker
   agent second; advisory until the retro-fit precision bar is met.
4. **RP.1 pipeline integration** — schema/prompt upgrade so
   greenfield runs get structured journeys for free. Last because it only
   helps projects born inside the pipeline; the brief's consumers today are
   brownfield.

## Open questions (instrumented, not rhetorical)

- Candidate quality bar: what fraction of derived end-states survive
  ratification unedited? (Measure on the income-sources retro-fit; if
  <half, `derive` should emit journeys-without-end-states and leave
  end-state authoring fully human.)
- RP.3 checker precision on real PRD prose: measured by the retro-fit
  0-noise floor before any blocking consideration.
- Does the diff-view re-ratification actually get used, or do operators
  hand-edit and skip `ratify`? (`provenance-absent` advisory counts tell
  us; if hand-edit wins, meet operators where they are and make `ratify`
  wrap an edited file rather than fight it.)
