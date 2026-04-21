# Epic 58: Source AC Fidelity

## Vision

Close the capability gap where the create-story phase silently rewrites
acceptance criteria from `epics.md` into the implementation artifact,
softening hard clauses (MUST / MUST NOT / enumerated file paths /
explicit storage choices / mandatory `## Runtime Probes` sections).
The dev-story phase consumes the rewritten AC, the code-review phase
validates against the rewritten AC, and the source epic's hard
requirements never reach implementation — the pipeline ships code that
violates its own spec while reporting SHIP_IT.

Source: strata agent report 2026-04-20 — run
`19d14a3b-511a-4fce-92d5-7750ea53511b` shipped Stories 1-7 and 1-9
where "MUST remove X" became "keep X for backward compatibility",
"plain JSON file" became "LanceDB table", and mandatory `## Runtime
Probes` sections were dropped with the rationale "No integration probe
needed for this story".

## Root cause

`packs/bmad/prompts/create-story.md` actively instructs the agent to
transform and condense ACs:

- **Line 39** prescribes BDD Given/When/Then as the mandatory output
  format. Source ACs authored in imperative form ("MUST NOT retain
  legacy X") do not fit BDD cleanly; the agent complies by reshaping,
  and in reshaping softens hard clauses.
- **Line 159** caps at 6-7 ACs; when the source has more, the agent
  condenses, dropping specifics.
- **Line 73** grants the agent discretion to decide whether the story
  is "runtime-dependent" and omit `## Runtime Probes` accordingly —
  even when the epic author explicitly authored probes in the source.

No clause in the prompt protects hard-clause text. No downstream check
cross-references `epics.md`: `code-review.md` line 33 treats the
rendered story file content as the authoritative AC source, and the
Tier A `AcceptanceCriteriaEvidenceCheck` validates implementation
against the rendered AC — not against the source epic. The rewrite
therefore never surfaces.

## Scope

### Sprint 1 — Prompt guardrail + verification gate

Three stories. Same-surface? No — `create-story.md` is
prompt/methodology, the Tier A check is `@substrate-ai/sdlc`
verification pipeline, the e2e fixture is tests. Three disjoint
surfaces; safe to dispatch together under the strata dispatch rule.

---

### Story 58-1: Create-Story Prompt — AC Preservation Directive

**Priority**: must

**Description**: Update `packs/bmad/prompts/create-story.md` to treat
AC text from the Story Definition as **read-only input**. Any clause
containing `MUST`, `MUST NOT`, `SHALL`, `SHALL NOT`, enumerated file
paths, or explicit technology/storage choices must appear in the
rendered story artifact's Acceptance Criteria section verbatim. The
BDD Given/When/Then format is demoted from mandatory to optional — a
tool the agent MAY use for behavior-oriented ACs where the rewrite
adds clarity, never for hard clauses. When the Story Definition
contains a `## Runtime Probes` section, the agent MUST transfer it
verbatim; it does NOT independently judge whether the story is
runtime-dependent. Directly eliminates the AC-rewrite bug observed
on strata 1-7 and 1-9.

**Acceptance Criteria**:
- The `Instructions` section of `create-story.md` contains an explicit
  directive declaring AC text from the Story Definition as "read-only
  input" — the exact phrase "read-only input" MUST appear in the prompt
- The prompt enumerates the hard-clause keywords (MUST, MUST NOT,
  SHALL, SHALL NOT) and declares they must appear "verbatim" in the
  rendered artifact — the exact phrase "verbatim" MUST appear at least
  once in the AC preservation section
- The prompt explicitly forbids softening, abstracting, or paraphrasing
  a hard clause — the phrase "Never soften, abstract, or paraphrase a
  hard clause" (or semantically equivalent — the test checks for the
  words "soften" AND "paraphrase" in the same paragraph) MUST appear
- The prompt's Runtime Probes section gains a directive: "If the Story
  Definition contains a `## Runtime Probes` section, transfer it
  verbatim" — the exact phrase "transfer it verbatim" MUST appear
- The existing BDD Given/When/Then requirement (line 39, "minimum 3,
  maximum 8") is softened from mandatory to "permitted for behavior-
  oriented criteria where it adds clarity" — the word "mandatory" MUST
  NOT appear in reference to BDD format, and the new language MUST
  include the word "optional" in reference to BDD
- `src/modules/compiled-workflows/__tests__/create-story.test.ts` gains
  5 new tests asserting each of the above directives is present in the
  rendered prompt file — follows the same schema-drift guardrail
  pattern established in Story 56-create-story-probe-awareness
- All pre-existing tests in `create-story.test.ts` still pass — the
  prompt's other guidance (scope cap, interface contracts, runtime
  probes framing, sandbox choice, output contract) is preserved
- No runtime code changes — prompt-template-only story

**Key File Paths**:
- `packs/bmad/prompts/create-story.md` (modify)
- `src/modules/compiled-workflows/__tests__/create-story.test.ts` (extend)

**FRs:** MO-3 (spec-to-implementation fidelity)

---

### Story 58-2: SourceAcFidelityCheck as 6th Tier A Verification Check

**Priority**: must

**Description**: Add a new Tier A verification check,
`SourceAcFidelityCheck`, registered as the 6th check in
`createDefaultVerificationPipeline` (after RuntimeProbeCheck). It
reads the source epic spec (resolved via the same `findEpicsFile`
logic used by `orchestrator-impl.ts:isImplicitlyCovered`), extracts
the story's section, identifies hard clauses (MUST / MUST NOT /
SHALL / SHALL NOT / enumerated `path/to/file.ext` / presence of a
`## Runtime Probes` fenced YAML block), and asserts each clause is
present in the rendered story artifact's content. Missing clauses
emit `error`-severity `VerificationFinding` entries with category
`source-ac-drift`, causing the Tier A gate to fail — hard-gates
because a dropped MUST clause is pipeline integrity failure, not a
style issue.

**Acceptance Criteria**:
- New file `packages/sdlc/src/verification/source-ac-fidelity-check.ts`
  exporting `SourceAcFidelityCheck` class implementing the
  `VerificationCheck` interface (same shape as the existing 5 Tier A
  checks in that directory)
- The check takes `VerificationContext` with a new optional field
  `sourceEpicContent: string | undefined` — when undefined or empty,
  the check emits a `warn`-severity finding with category
  `source-ac-source-unavailable` and PASSES (non-fatal for projects
  that don't use `_bmad-output/planning-artifacts/` or have no epic
  file for the story)
- Hard-clause extractor finds: (a) lines containing `MUST NOT`, `MUST`,
  `SHALL NOT`, `SHALL` as standalone keywords (word boundaries, case-
  sensitive to match spec convention); (b) backtick-wrapped paths
  matching `/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*/`
  (at least one `/` — excludes bare filenames); (c) the presence of a
  `## Runtime Probes` heading followed by a fenced `yaml` block —
  represented as a single "runtime-probes-section" clause
- For each hard clause found in the source, the check performs a
  literal substring match against `context.storyContent`. Missing
  clauses produce one `VerificationFinding` per clause with:
  - `category: 'source-ac-drift'`
  - `severity: 'error'`
  - `message: '<clause type>: "<truncated clause>" present in epics source but absent in story artifact'`
- `SourceAcFidelityCheck.run()` returns `status: 'fail'` when any
  error-severity finding is emitted, else `'pass'`
- Registered in `createDefaultVerificationPipeline()` as the 6th check,
  after the existing 5 (phantom-review, trivial-output, ac-evidence,
  build, runtime-probes). Placement ensures it runs against the final
  rendered story artifact after all prior checks
- Orchestrator wiring: `assembleVerificationContext()` in
  `src/modules/implementation-orchestrator/verification-integration.ts`
  gains a `sourceEpicContent` opt; call sites in
  `orchestrator-impl.ts` populate it by reading the epics file (same
  `findEpicsFile` helper used by `isImplicitlyCovered`) and returning
  `undefined` on missing/unreadable — non-fatal
- Unit tests at
  `packages/sdlc/src/verification/__tests__/source-ac-fidelity-check.test.ts`
  cover: (a) all MUST clauses present → pass; (b) one MUST NOT clause
  missing → fail with single finding; (c) multiple missing clauses →
  multiple findings, one per clause; (d) `sourceEpicContent` undefined
  → warn finding with `source-ac-source-unavailable` category, status
  pass; (e) `## Runtime Probes` block in source but absent in artifact
  → fail with `source-ac-drift` finding for the probes section
- No change to existing 5 Tier A checks — their tests still pass

**Key File Paths**:
- `packages/sdlc/src/verification/source-ac-fidelity-check.ts` (new)
- `packages/sdlc/src/verification/__tests__/source-ac-fidelity-check.test.ts` (new)
- `packages/sdlc/src/verification/verification-pipeline.ts` (modify — register the check)
- `packages/sdlc/src/verification/types.ts` (modify — add `sourceEpicContent` to `VerificationContext`)
- `src/modules/implementation-orchestrator/verification-integration.ts` (modify — populate `sourceEpicContent` in `assembleVerificationContext`)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify — pass `sourceEpicContent` at the two `assembleVerificationContext` call sites)
- `packages/sdlc/src/verification/index.ts` (modify — export the new check)

**FRs:** MO-3 (spec-to-implementation fidelity)

---

### Story 58-3: Regression E2E Fixture for Source AC Fidelity

**Priority**: must

**Description**: End-to-end integration test that exercises the Epic
58 chain with a real epic fixture containing hard clauses and a
`## Runtime Probes` section. Validates both the positive case
(faithful artifact → verification passes) and the negative case
(softened artifact → verification fails with `source-ac-drift`
findings). Modeled after `src/__tests__/e2e/epic-55-findings-e2e.test.ts`
and `src/__tests__/e2e/epic-56-runtime-probes-e2e.test.ts`.

**Acceptance Criteria**:
- New test file `src/__tests__/e2e/epic-58-source-ac-fidelity-e2e.test.ts`
- Fixture: a minimal in-memory epic markdown string declaring one
  story with ACs containing `MUST NOT retain legacy config`, an
  enumerated path `src/config/legacy.ts`, and a `## Runtime Probes`
  fenced yaml block with one probe named `config-removed`
- Test 1 (positive): feed the epic as `sourceEpicContent` and a
  `storyContent` that contains all three hard clauses verbatim; run
  `SourceAcFidelityCheck` → asserts `status: 'pass'`, zero findings
- Test 2 (negative — softened MUST NOT): feed same epic; feed a
  `storyContent` where `MUST NOT retain legacy config` is rewritten as
  `Consider deprecating legacy config` → asserts `status: 'fail'`,
  one finding with `category: 'source-ac-drift'`, severity `error`,
  message mentions `MUST NOT`
- Test 3 (negative — missing enumerated path): `storyContent` drops
  the backtick-wrapped `src/config/legacy.ts` → asserts one error
  finding with `source-ac-drift` mentioning the path
- Test 4 (negative — dropped Runtime Probes): `storyContent` omits
  the `## Runtime Probes` heading entirely → asserts one error
  finding for the probes section
- Test 5 (integration): round-trip through
  `createDefaultVerificationPipeline().run()` with a full
  `VerificationContext` including all the other 5 Tier A checks
  mocked to pass — asserts the pipeline's aggregate status is `fail`
  when SourceAcFidelityCheck fails, and the findings flow through
  the pipeline's projection to the final `VerificationSummary` (no
  latent-Phase-1 projection bug regression)

**Key File Paths**:
- `src/__tests__/e2e/epic-58-source-ac-fidelity-e2e.test.ts` (new)

**FRs:** MO-3 (spec-to-implementation fidelity)

---

## Out of Scope

- **Code-review cross-referencing `epics.md`**: The code-review prompt
  currently treats the rendered story artifact as authoritative. 58-1
  and 58-2 together catch 95% of cases before code-review runs; adding
  a second independent cross-reference compounds prompt cost for
  marginal additional coverage. Defer as a potential follow-up only if
  58-2 misses meaningful cases in production.
- **Semantic paraphrase detection**: Checking whether "prefer X over
  Y" semantically equals "MUST NOT retain Y" requires an LLM judge;
  out of scope. 58-2 relies on literal substring matching, which
  catches the mechanical-transformation cases strata reported. Agents
  that deliberately rewrite while preserving substrings are not a
  realistic failure mode.
- **Strata's `verification_result: undefined` recurrence on 1-7/1-9**:
  Already fixed on `main` via Epic 57's race-fix (v0.20.9). Pending
  npm publish. No additional substrate code work.

## Bootstrap Protocol

**Story 58-1 is implemented directly in the Claude Code session, not
dispatched via substrate**, because substrate's own create-story phase
contains the bug 58-1 fixes. Dispatching 58-1 against the broken
prompt risks the agent softening 58-1's own "MUST preserve verbatim"
AC — a meta-failure.

Stories 58-2 and 58-3 are safely dispatchable via substrate after
58-1 lands and v0.20.9 + 58-1 is published to npm, because (a) they
do not themselves depend on the create-story prompt's AC-handling
behavior and (b) 58-1's AC-preservation directives will guard their
dispatch.

---

## Addendum — Sprint 2 (2026-04-21)

After v0.20.12 shipped with 58-1 through 58-5, strata retested stories
1-7 and 1-9 on the updated substrate and reported byte-identical AC
drift across three substrate versions (v0.20.8, v0.20.10, v0.20.12).
Investigation revealed the persistence had nothing to do with the
create-story prompt or the verification chain — it was a **story-file
reuse** behavior in `src/modules/implementation-orchestrator/orchestrator-impl.ts`
lines 1477-1505 that skips the create-story phase entirely when a
`_bmad-output/implementation-artifacts/${storyKey}-*.md` file already
exists and passes the minimal `isValidStoryFile` check (non-empty +
has a heading + mentions "Acceptance Criteria").

Hard evidence: strata's Run 2 (run_id `90869c22-…`) story_metrics
phase_durations_json shows `"create-story": 0` for both 1-7 and 1-9
— zero seconds spent in the phase. For comparison, Epic 58's own
dispatch saw 160-190 seconds per story. The phase was being skipped,
not re-executed. Runs 2 and 3 therefore reused Run 1's stale
artifact (which predated every Epic 58 fix) and every downstream
check (58-1 preservation, 58-2 SourceAcFidelityCheck, 58-4 parser,
58-5 extraction) was operating on a file that no current-version
code had ever produced.

This addendum adds two stories closing that gap and a related
operator-friction issue reported alongside it.

---

### Story 58-6: Story-file freshness check against source epic

**Priority**: must

**Description**: The orchestrator currently reuses any existing
`${storyKey}-*.md` implementation artifact that passes a minimal
structural check, skipping the create-story phase entirely. The
reuse path was written to accommodate BMAD auto-implement projects
where story files are authored externally before substrate runs.
It has NO freshness check against the source epic — when the author
edits `epics.md` between runs, substrate continues to use the prior
artifact indefinitely. Strata confirmed this behavior three times
over with three substrate versions on the same stale artifact.

Add a content-hash freshness check. When the source epic section
for this story exists, compute a stable SHA-256 of the AC section
text. Compare against a `<!-- source-ac-hash: <hex> -->` comment in
the existing artifact. On mismatch or absent hash, fall through to
create-story. Emit a `story:ac-source-drift` event so operators see
why the regen happened. On create-story completion, have the agent
emit the current hash in the artifact's HTML comment frontmatter —
the prompt instructs this.

**Acceptance Criteria**:
- New exported helper in `src/modules/compiled-workflows/create-story.ts`:
  `hashSourceAcSection(section: string): string` — returns a hex
  SHA-256 of the trimmed section bytes. Pure function; no I/O.
- Orchestrator reuse path in
  `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  (around line 1477-1505): after `isValidStoryFile` passes, additionally:
  - Call the existing `findEpicsFile` + `extractStorySection` helpers
    to obtain the current source AC section for the story (uses
    58-5's separator normalization)
  - If source section is available: compute the current hash; read
    the existing artifact; look for the literal substring
    `<!-- source-ac-hash: ` followed by hex chars through `-->`
  - If stored hash differs from current OR is absent from the
    artifact: set `storyFilePath = undefined` so the create-story
    dispatch fires; emit
    `eventBus.emit('story:ac-source-drift', { storyKey, storedHash,
    currentHash })`; log an info line
  - If hashes match: reuse as today (backwards-compatible for
    BMAD-authored artifacts that carry the current hash, and for
    stories with no source epic section)
- `packs/bmad/prompts/create-story.md` gains an instruction: after
  rendering the AC section verbatim per Story 58-1, emit an HTML
  comment `<!-- source-ac-hash: <hex> -->` on its own line
  immediately after the `## Acceptance Criteria` heading. The hash
  is provided in the prompt context as `{{source_ac_hash}}`.
- `OrchestratorEvents` in `src/core/event-bus.types.ts` declares the
  new `story:ac-source-drift` event with payload `{ storyKey: string;
  storedHash: string | null; currentHash: string }`.
- Unit tests: the hash helper is stable (same input → same output),
  minor whitespace normalization (trimmed, trailing-whitespace
  stripped per line) so trivial editor noise does not trigger regen.
- Integration test: dispatch a story where the existing artifact
  has hash `A`, current source hashes to `B` → assert create-story
  IS invoked. Converse case (hashes match) → assert create-story
  is skipped. Legacy case (no hash in existing artifact) → assert
  create-story IS invoked (treats absent hash as drift, forcing a
  one-time regen on the first upgrade).
- No regression to BMAD auto-implement flow: when the source epic
  isn't findable (no epics.md), the reuse path stays as today —
  any valid artifact is accepted.

**Key File Paths**:
- `src/modules/compiled-workflows/create-story.ts` (modify — new
  `hashSourceAcSection` export)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  (modify — freshness check in the reuse block at ~line 1480)
- `src/core/event-bus.types.ts` (modify — new event declaration)
- `packs/bmad/prompts/create-story.md` (modify — emit hash comment)
- `src/modules/compiled-workflows/__tests__/create-story.test.ts`
  (extend — hash helper tests)
- `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts`
  (extend — freshness drift / no-drift / legacy cases)

**FRs:** MO-3 (spec-to-implementation fidelity); MO-4 (iteration
safety — source drift must not ship stale artifacts)

---

### Story 58-7: SIGTERM / SIGINT graceful shutdown handler

**Priority**: should

**Description**: User-initiated `kill <pid>` on a running substrate
process leaves `pipeline_runs.status = 'running'` in Dolt and the
run manifest's per-story state in whatever phase it was in at the
moment of kill. Three abandoned-run reconciliations have happened
via manual Dolt UPDATE in the past two weeks (`b9287567`, `70db62cd`,
`d80d5202`), each with a similar chore commit. A structural fix
installs signal handlers that flush state cleanly before exit.

Strata observation obs_2026-04-21_002 describes the pattern:
killing the `substrate run` process (v0.20.12) while stories are
IN_DEV exited cleanly but left the run indefinitely "running" in
Dolt. `substrate status` continued to report the dead run as active,
blocking retry flows. This is distinct from Epic 57-4's
unhandled-rejection fix (which addressed crashes, not user kills).

**Acceptance Criteria**:
- Orchestrator startup in
  `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  (or a new signal-handler module if the scope warrants it) installs
  `process.on('SIGTERM', handler)` and `process.on('SIGINT',
  handler)` at the first `orchestrator.run()` invocation. Handlers
  are removed on `orchestrator.run()` completion (clean exit path)
  to avoid leaking between orchestrator instances in tests.
- Handler (`shutdownGracefully(reason: string)`):
  - Sets an in-memory shutdown flag checked by the dispatch loop
    so no new story phases are scheduled
  - Awaits any in-flight dispatches for up to 5 seconds (new
    `config.shutdownGracePeriodMs` with default 5000)
  - Calls `runManifest.patchRunStatus({ status: 'stopped',
    stopped_reason: reason, stopped_at: new Date().toISOString() })`
    using Epic 57-1's serialized write chain (requires a new
    `patchRunStatus` method on RunManifest; partner story
    surface)
  - Updates Dolt `pipeline_runs.status = 'stopped'` with
    `updatePipelineRun(db, runId, { status: 'stopped', ... })`
    (best-effort; wrapped in try/catch)
  - Transitions any `wg_stories` rows still in active-state
    (`planned`, `in_progress`) to `cancelled` via the work-graph
    repo's existing `updateStoryStatus` — best-effort
  - Calls `process.exit(130)` for SIGINT convention; SIGTERM
    exits 143 (128 + 15) to match the POSIX convention
- New optional CLI: `substrate stop [--run-id <id>]` finds the
  running orchestrator PID (via
  `pipeline_runs.orchestrator_pid` or an on-disk pidfile) and
  sends SIGTERM, then polls until the PID exits or a 30s timeout.
  Cleaner than `pgrep -f substrate | xargs kill`. This sub-story
  may be deferred to a separate story if scope grows; the
  SIGTERM handler itself is in scope for 58-7.
- `OrchestratorConfig` in
  `src/modules/implementation-orchestrator/types.ts` gains
  `shutdownGracePeriodMs?: number` (default 5000) with a JSDoc
  comment describing SIGTERM behavior.
- `RunManifestData` type in
  `packages/sdlc/src/run-model/types.ts` gains an optional
  `stopped_reason?: string` and `stopped_at?: string` field on
  the top level. Schema is backward-compatible (both optional,
  absent on pre-58-7 manifests).
- Unit tests: signal handler calls `shutdownGracefully` on
  SIGTERM; shutdownGracefully flips the shutdown flag, awaits
  in-flight dispatches, and writes the expected manifest state;
  dispatch loop respects the flag and stops scheduling; exit
  code is 143 for SIGTERM / 130 for SIGINT.
- Integration test: orchestrator running with a blocked
  dispatch mock; send SIGTERM to the test's own process; assert
  the manifest's `stopped_reason` is `killed_by_user` within the
  grace period; assert exit code 143.

**Key File Paths**:
- `src/modules/implementation-orchestrator/orchestrator-impl.ts`
  (modify — signal handler installation + shutdownGracefully)
- `src/modules/implementation-orchestrator/types.ts` (modify — add
  `shutdownGracePeriodMs`)
- `packages/sdlc/src/run-model/types.ts` (modify — add
  `stopped_reason`, `stopped_at`)
- `packages/sdlc/src/run-model/schemas.ts` (modify — schema
  update for the new optional fields)
- `packages/sdlc/src/run-model/run-manifest.ts` (modify — new
  `patchRunStatus` method on the serialized write chain)
- `src/modules/implementation-orchestrator/__tests__/sigterm-shutdown.test.ts`
  (new)

**FRs:** MO-5 (operator ergonomics — user-kill leaves no stale state)

---

### Chore: reconcile abandoned run `d80d5202-…`

One-off SQL update on strata's Dolt + run manifest to mark the
abandoned v0.20.12 run as stopped. Same pattern as the v0.20.8
/ v0.20.10 reconciliations. Not a story — direct chore committed
after 58-6 and 58-7 ship.

---

## Revised out-of-scope

The following items stay out of Epic 58 scope; any of them could
become its own epic if the three-layer defense (58-1 + 58-2 +
58-5) plus freshness-check (58-6) doesn't fully close the gap in
practice:

- **Code-review cross-referencing `epics.md`** (strata observer
  suggestion #3). 58-6 forces a fresh create-story on source drift
  and 58-2 hard-gates drift at verification; the code-review
  phase is now operating on a fresh artifact that was either
  faithfully rendered by 58-1 or hard-failed at verification by
  58-2. Cross-referencing at code-review time is redundant in this
  architecture.
- **Semantic paraphrase detection**. 58-2 uses literal substring
  matching; an adversarial rewriter that kept all substrings while
  altering meaning is not a realistic failure mode for the current
  agents.
- **`substrate stop` CLI subcommand** (half of 58-7's spec). If
  scope proves tight, split into 58-7a (signal handler) and 58-7b
  (CLI command) rather than cramming both into one story.
