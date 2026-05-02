# Epic 64: State-Integrating AC Frontmatter and Gate Escalation

## Vision

Add a structural gate-side defense for **obs_2026-05-01_017** (create-story
probe-awareness gap on TypeScript modules with fs/git integration) on top of
the prompt-side fix shipped in **v0.20.42** (Story 64-1, this epic).

The prompt-side fix relies on the create-story agent reading the new
behavioral-signal guidance and authoring a `## Runtime Probes` section for
state-integrating ACs. That defense is best-effort: an LLM, even with the
corrected prompt, will occasionally miss a state-integration signal in AC
text and ship a story without probes.

Epic 64 closes the residual gap with a structural escalation analogous to
**obs_2026-04-27_016** (event-driven-AC missing-probes warn→error in
v0.20.40). The story frontmatter gains an `external_state_dependencies`
field; when the field is non-empty AND the story artifact has no
`## Runtime Probes` section, the missing-probes finding's severity
escalates from `warn` to `error` and the story cannot SHIP_IT.

This is the second of three layers in the obs_017 fix:

- **Phase 1** — prompt-side rewrite (Story 64-1, **SHIPPED v0.20.42**)
- **Phase 2** — frontmatter + gate (Stories 64-2, 64-3, this epic, target Sprint 23)
- **Phase 3** — probe-author state-integrating dispatch (Epic 65, deferred)

## Root cause it addresses

obs_2026-05-01_017 surfaced via strata Run 17 / Story 2-4. A TypeScript
module that ran `git log` against a fleet root and used substring-match
commit attribution shipped SHIP_IT through every substrate verification
gate because no `## Runtime Probes` section was authored. The defects only
surfaced during strata's binding-rule e2e smoke pass.

Story 64-1 (v0.20.42) replaced the prompt's artifact-shape omit clause
(`TypeScript code → omit probes`) with a behavioral-signal section that
prescribes probes when AC text contains subprocess / fs / git / database /
network / registry interaction patterns. With the prompt-side fix in place,
the create-story agent SHOULD author probes for state-integrating ACs.

The residual gap: agent compliance is non-deterministic. Even with correct
prompt guidance, the agent can:

- Miss a state-integration phrase ("scans the registry") that doesn't
  match the prompt's enumerated pattern (`registry / configuration source`).
- Be persuaded by a hedging AC (e.g., "the dev MAY mock the registry for
  initial implementation") that the integration is not real.
- Drift in an unusual prompt context that downweights the new section.

The structural fix is to introduce a frontmatter field the agent must
populate explicitly, then escalate verification severity when the field
indicates state-integration but no probes were authored. The
obs_2026-04-27_016 precedent (event-driven AC missing-probes
warn→error) demonstrates the pattern is sound: a non-empty
escalation-condition field AND missing section together hard-gate.

## Story Map

- **64-1**: prompt-side rewrite (P0, Small) — **SHIPPED v0.20.42**
- **64-2**: `external_state_dependencies` story frontmatter + escalation (P0, Medium)
- **64-3**: create-story regression-coverage gap closure (P1, Small)

## Story 64-1: prompt-side rewrite

**Priority**: must

**Status**: SHIPPED v0.20.42 (commits `074951a` feat + `7901b90` chore).

**Description**: Replaced `packs/bmad/prompts/create-story.md` line 109's
artifact-shape omit clause with a behavioral-signal section. The decision
between authoring `## Runtime Probes` or omitting it now turns on the AC's
behavioral content (subprocess / fs / git / database / network / registry
interactions), not on the artifact's file extension.

Documented for completeness so Epic 64's three-story arc is traceable.

## Story 64-2: `external_state_dependencies` story frontmatter + escalation

**Priority**: must

**Description**: Add an optional `external_state_dependencies` field to the
story-artifact frontmatter schema. When non-empty AND the story artifact
has no `## Runtime Probes` section, the existing
`source-ac-fidelity-check` (or equivalent missing-probes detector)
escalates the missing-section finding severity from `warn` to `error`.
Mirrors the obs_2026-04-27_016 / event-driven escalation pattern in
`packages/sdlc/src/verification/source-ac-fidelity-check.ts`.

Field shape:

```yaml
external_state_dependencies:
  - subprocess
  - filesystem
  - git
```

Open enum (per obs_017 party-mode design call). The gate cares only about
non-empty vs. empty; future-us can tighten to a closed enum if patterns
emerge. Suggested seed values, documented in `create-story.md` for the
agent: `subprocess`, `filesystem`, `git`, `database`, `network`,
`registry`, `os` (catch-all for system-level state).

Update `packs/bmad/prompts/create-story.md` (under the same Runtime
Verification Guidance section Story 64-1 rewrote) to instruct the agent to
populate this field whenever the AC describes any of the behavioral
signals enumerated in Story 64-1's prompt, in addition to authoring the
`## Runtime Probes` section. The two outputs reinforce each other: the
section is the operational artifact; the frontmatter is the
machine-readable declaration.

**Acceptance Criteria**:

1. `external_state_dependencies` added to the story-artifact frontmatter
   Zod schema (`packages/sdlc/src/run-model/story-artifact-schema.ts` or
   equivalent). Optional, default empty array.
2. `create-story.md` Runtime Verification Guidance section instructs the
   agent to populate the field when the AC matches any behavioral signal.
   Suggested values documented: `subprocess`, `filesystem`, `git`,
   `database`, `network`, `registry`, `os`.
3. Verification check (`runtime-probe-check.ts` or
   `source-ac-fidelity-check.ts`) reads the frontmatter field. When
   non-empty AND no `## Runtime Probes` section, severity escalates from
   `warn` to `error` with explicit message: "story declares
   external_state_dependencies but has no `## Runtime Probes` section —
   probes required per obs_2026-05-01_017."
4. Empty/absent `external_state_dependencies` preserves current behavior:
   missing section emits `warn` (or, if the AC is event-driven per
   `detectsEventDrivenAC`, `error` per the obs_016 escalation — unchanged).
5. Backward-compat: stories without the field continue to dispatch
   normally; old stories without frontmatter declarations don't
   retroactively fail verification.
6. Round-trip test: a story artifact with `external_state_dependencies:
   [git, subprocess]` and a `## Runtime Probes` section passes
   verification cleanly.
7. Negative test: a story with `external_state_dependencies: [git]` and
   NO `## Runtime Probes` section produces an `error`-severity finding,
   blocks SHIP_IT.

**Key File Paths**:

- `packs/bmad/prompts/create-story.md` (Runtime Verification Guidance
  section — Story 64-1 already rewrote this; 64-2 adds the
  frontmatter-population instruction)
- `packages/sdlc/src/run-model/story-artifact-schema.ts` (or wherever
  the Zod schema for story frontmatter lives)
- `packages/sdlc/src/verification/source-ac-fidelity-check.ts` (the
  obs_016 escalation logic precedent)
- `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (the
  natural site for the new escalation, or alongside source-ac-fidelity)
- New tests in `packages/sdlc/src/__tests__/verification/`

## Story 64-3: create-story regression-coverage gap closure

**Priority**: should

**Description**: Story 56's create-story test suite (10 tests in
`src/modules/compiled-workflows/__tests__/create-story.test.ts`,
v0.20.7) had no positive-coverage cases for state-integration AC
phrasing. obs_017 directly traces to that gap: had the suite included a
fixture asserting that an AC mentioning `execSync` produced a
probe-bearing artifact, the prompt's artifact-shape contradiction would
have surfaced before strata caught it.

Story 64-1 added 7 prompt-text-assertion tests in v0.20.42 that pin the
new behavioral-signal guidance is present in the prompt. Those are
necessary but not sufficient — they assert prompt content, not LLM
behavior given the prompt.

Story 64-3 closes the remaining gap with **fixture-based AC pattern
tests**: prompt fixtures containing each behavioral-signal phrase
(`execSync`, `spawn`, `git log`, `Dolt`, `fs.read*`, `fetch`,
`path.join(homedir())`) should be runnable through a static template
analysis (no LLM dispatch) that asserts the rendered prompt instructs
probe-section authoring.

The static analysis surface: `runCreateStory` template substitution +
the Runtime Verification Guidance section + the matching behavioral
signal. No LLM call; no dispatch. The test is: given AC text X, does
the rendered prompt contain a guidance path that an agent following
the prompt would interpret as "author probes for X"?

This is intentionally weaker than full eval-style validation (Story
65-3 corpus). 64-3 closes the deterministic test surface; 65-3 closes
the behavioral surface.

**Acceptance Criteria**:

1. New test suite (or extension of `create-story.test.ts`):
   `behavioral-signal-coverage.test.ts` or similar.
2. Positive cases: AC text fixtures containing each phrase trigger the
   prompt's behavioral-signal section. Phrases: `execSync`, `spawn`,
   `child_process`, `git log`, `git push`, `git merge`,
   `path.join(homedir(), ...)`, `fs.readFile`, `fs.writeFile`,
   `fetch(`, `axios`, `Dolt`, `mysql`, `INSERT`, `SELECT`.
3. Negative cases: AC text fixtures with pure-function phrasing
   (`parse the input`, `format as JSON`, `sort by score`,
   `transform the array`) do NOT trigger probe-authoring guidance.
4. Each behavioral-signal phrase from Story 64-1's enumeration appears
   in at least one positive-case fixture.
5. obs_017 reproduction fixture: strata Story 2-4's actual AC text
   (paraphrased to avoid coupling) is a positive-case fixture.
6. Test methodology: static analysis (regex / substring assertion on
   rendered prompt + guidance section). No LLM dispatch.

**Key File Paths**:

- `src/modules/compiled-workflows/__tests__/create-story.test.ts`
  (extend, or sibling test file)
- New test fixtures (small, inline) covering each behavioral signal

## Risks and assumptions

**Assumption 1 (open enum is sufficient)**: `external_state_dependencies`
as an open enum (free-form strings) is acceptable. The gate cares only
about non-empty vs. empty. Closed enum maintenance overhead is
disproportionate to the value at this stage.

**Assumption 2 (the agent will populate the field)**: Story 64-2's
prompt-side instruction to populate the frontmatter field is followed
reliably enough that the gate is meaningful. If agent compliance is
poor, the gate fires on the wrong stories (false positive) or never
fires (false negative). Story 64-3's fixture tests reduce — but don't
eliminate — this risk; eval-style validation lives in Epic 65.

**Risk: backward-compat regression on existing stories.** Existing
stories don't have `external_state_dependencies` in their frontmatter,
so AC4 (empty/absent → no escalation) is load-bearing. A bug that
treats absent-field as non-empty would retroactively fail verification
on already-shipped stories. Test AC5 specifically guards against this.

**Risk: gate fires on false-positive frontmatter declarations.** If
the agent over-enthusiastically populates `external_state_dependencies:
[fs]` for a story that only reads test fixtures inside a tmpdir
(legitimate "fs" interaction but not state-integrating per the spirit
of obs_017), the gate will demand probes the story doesn't need. The
ergonomic cost is low (agent emits a trivial test-tmpdir probe), but
it's worth flagging — Story 64-2's prompt-side guidance should
explicitly say "test-tmpdir filesystem access does NOT count."

## Dependencies

- **Story 64-1** (v0.20.42, SHIPPED) — prompt-side foundation. Story
  64-2's prompt edits build on the Runtime Verification Guidance
  section 64-1 rewrote.
- **obs_2026-04-27_016 fix in v0.20.40** — the structural precedent.
  64-2's escalation pattern reuses the implementation shape from
  `source-ac-fidelity-check.ts`'s missing-Runtime-Probes severity
  escalation when the AC is event-driven. Same mechanism, different
  trigger condition.

## Out of scope

- **Probe-author dispatch for state-integrating ACs** — Epic 65, deferred.
  Independent track; ramp-up gated on Story 65-4 catch-rate eval.
- **Probe-quality concern (obs_2026-05-02_018)** — orthogonal. obs_018
  surfaces *probe-quality* (production-shaped fixtures) as a separate
  concern from obs_017's *probe-presence* concern. The fix lives in
  Epic 65 Story 65-5 (probe-author prompt extensions).
- **Closed enum for `external_state_dependencies`** — open enum
  shipped in 64-2; closed enum is a follow-up if usage patterns
  emerge that warrant it.

## Empirical validation

Closes obs_017's structural defense layer. Validation lives in:

1. **Unit / integration tests** (Stories 64-2, 64-3) — deterministic
   coverage of the gate behavior and prompt-fixture coverage.
2. **Strata's next Phase B dispatch** under Epic 64 — natural smoke. If
   strata Story 2-5 (briefing scheduling) is dispatched after Epic 64
   ships, the create-story agent should populate
   `external_state_dependencies: [systemd, subprocess]` (or similar)
   and author probes. If it omits the section, the gate fires `error`
   and SHIP_IT is blocked. Both outcomes are valid signals.
3. **Epic 65 Story 65-3 corpus** — eval-style validation of the
   behavioral surface (LLM produces probes given prompt). Sequenced
   after Epic 64.

## Versions

- v0.20.42 (2026-05-02, SHIPPED) — Epic 64 Phase 1 (Story 64-1)
- v0.20.4x (target) — Epic 64 Phase 2 (Stories 64-2, 64-3, Sprint 23)

## References

- obs_2026-05-01_017 — motivating observation:
  `~/code/jplanow/strata/_observations-pending-cpo.md` lines 1592–1687.
- obs_2026-05-02_018 — probe-quality concern (orthogonal, deferred to
  Epic 65 Story 65-5).
- Epic 65 — probe-author Phase 3, state-integrating dispatch.
- v0.20.40 / Story-equivalent of 64-2 for event-driven ACs:
  `packages/sdlc/src/verification/source-ac-fidelity-check.ts`
  missing-Runtime-Probes severity escalation.

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-01 | party-mode session (jplanow + BMad agents) | planned | Drafted in obs_017 fix design alongside Epic 65. Story 64-1 sequenced as urgent hotfix; 64-2 + 64-3 deferred to Sprint 23. |
| 2026-05-02 | substrate session (post-v0.20.42 ship) | partial-ship | Story 64-1 SHIPPED in v0.20.42 (commits `074951a` + `7901b90`). Stories 64-2 and 64-3 remain pending; expected via Sprint 23 normal flow. |
