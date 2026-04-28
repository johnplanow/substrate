# Architecture: Agent Output Recovery

**Version**: 1 (2026-04-28, Sprint 19)
**Substrate version when authored**: v0.20.37
**Status**: documents existing patterns shipped across Sprints 14-18; not a roadmap for new work

## Problem statement

Substrate dispatches LLM agents to produce structured outputs (code reviews,
story artifacts, runtime probes, dev-story signals). Real LLMs don't
reliably emit well-formed structured output. Empirically, across Sprints
12-17 every single substrate observation that triggered a sprint-sized
fix was about agent output that LOOKED correct but tripped a downstream
gate or shipped a broken artifact:

| Observation | What broke |
|---|---|
| obs_011 | create-story silently rewrote source AC scope (4 tools → 2) |
| obs_012 | dev-authored probes asserted presence-of-response, not success-shape |
| obs_013 | source-ac-fidelity over-strict on optional architecture choice |
| obs_014 | dev-authored probes invoked implementation directly, not production trigger |
| obs_015 | code-review YAML output broke parser on shell snippets containing colons |

Each was addressed by a specific fix. The fixes followed a consistent
shape but were never named or documented as a coherent architectural
pattern. This doc names the pattern, catalogs the layers, and identifies
extension points so future bug fixes follow the same structure
intentionally rather than re-inventing each time.

## The Agent Output Recovery Pattern

When substrate dispatches an LLM agent and consumes its output, FIVE
layers of validation + recovery are available. Each layer catches a
specific failure mode the layers above couldn't. Layers are independent
but compose: a single agent dispatch may exercise zero, one, or all
five depending on what the LLM emits.

```
                        +----------------------------+
LLM agent emits ----->  | Layer 1: pre-emit prompt   |  steers what the agent writes
                        | guidance                   |
                        +----------------------------+
                                     |
                                     v
                        +----------------------------+
                        | Layer 2: schema validation |  catches well-formed-but-wrong-shape
                        | (zod / parseYamlResult)    |
                        +----------------------------+
                                     |
                                     v
                        +----------------------------+
                        | Layer 3: parser recovery   |  rewrites recoverable malformed input
                        | transformations            |  and re-parses
                        +----------------------------+
                                     |
                                     v
                        +----------------------------+
                        | Layer 4: defense-in-depth  |  catches semantic errors the
                        | post-parse detection       |  schema can't see
                        +----------------------------+
                                     |
                                     v
                        +----------------------------+
                        | Layer 5: recovery routing  |  decides what to DO with a layer
                        | + verdict downgrades       |  4 finding (escalate? approve?)
                        +----------------------------+
                                     |
                                     v
                        Verified output flows to next pipeline phase
```

### Layer 1: pre-emit prompt guidance

**Purpose**: shape what the agent writes BEFORE it writes anything.

The prompt teaches the agent the contract: what fields to emit, what
shapes are valid, what patterns to avoid. This is the cheapest layer
(no per-dispatch cost) and the highest-leverage when it works (the LLM
just produces correct output the first time).

Limitation: prompt instructions are advisory. LLMs don't always follow
guidance. Layers 2-5 catch the cases where they don't.

**Current instances**:

| Story | Surface | Guidance |
|---|---|---|
| 56-1 | `packs/bmad/prompts/create-story.md` | Author runtime probes for runtime-dependent artifacts |
| 60-10 | `packs/bmad/prompts/create-story.md` | Probes for event-driven mechanisms must invoke the production trigger |
| 60-12 | `packs/bmad/prompts/create-story.md`, `probe-author.md` | Assert success-shape on structured-output probes (forbid `"isError":true`, `"status":"error"`) |
| 60-13 | `packs/bmad/prompts/dev-story.md` | If the story has `## Runtime Probes`, the implementation MUST satisfy every probe |
| 62-1 | `packs/bmad/prompts/code-review.md` | Use block-scalar `description: \|` form for free-form string fields that may contain colons |

**Convention**: Layer 1 changes are prompt-only. They ship without
schema/code changes. A YAML-fitness test (introduced in 56 and 62-1)
extracts every fenced YAML block from the prompt and asserts each
parses cleanly — this protects against the prompt itself shipping
broken examples.

### Layer 2: schema validation

**Purpose**: catch well-formed YAML/JSON that doesn't match the
expected output shape (missing required fields, wrong types, invalid
enum values).

**Current instances**: zod schemas in `packages/core/src/dispatch/`,
`src/modules/compiled-workflows/schemas.ts`,
`packages/sdlc/src/run-model/schemas.ts`. Used by `parseYamlResult` and
each agent-result handler.

**Failure surface**: `result.parsed === null` with
`parseError: 'no_yaml_block'` or `parseError: 'schema_validation_failed'`.
Routed to Layer 5 for handling.

### Layer 3: parser auto-recovery transformations

**Purpose**: when raw parsing fails, attempt structured rewrites of
the malformed input and re-parse. Each transformation targets a
specific known LLM output failure mode. Transformations are opt-in:
they only fire when the parse error matches their trigger pattern, so
they don't risk over-applying to genuinely-broken structure.

**Current instances** (all in
`packages/core/src/dispatch/yaml-parser.ts`):

| Recovery | Trigger | Action |
|---|---|---|
| Duplicate-key merge | `duplicated mapping key` | Merge same-name top-level keys' children |
| Invalid-escape sanitize | `invalid backslash escape` (always-on, before parse) | Strip `\X` for X not in YAML's valid-escape set |
| Block-scalar rewrite (62-2) | `bad indentation of a mapping entry (LINE:COL)` | Rewrite `<allowlisted-field>: <value-with-colon>` line as `<field>: \|-\n  <value>` and re-parse |
| JSON fallback | last resort, after extractYamlBlock fails | Try parsing extracted text as JSON object, convert to YAML |

**Convention**: each recovery is opt-in per error pattern.
Transformations are bounded (the block-scalar rewrite walks back at
most 4 lines from the error position; the JSON fallback only fires
after fenced + unfenced YAML extraction both fail). Recovery never
silently masks a failure mode — if all transformations fail, the
original error surfaces.

### Layer 4: defense-in-depth post-parse detection

**Purpose**: catch semantic errors that pass schema validation but
don't actually represent successful agent output. Each detection
inspects the parsed output for known failure shapes that aren't
schema-checkable.

**Current instances**:

| Story | Surface | What it catches |
|---|---|---|
| 60-3 | `source-ac-fidelity-check` | dev-story under-delivery on AC scope |
| 60-4 | `executor.ts` `evaluateStdoutAssertions` | author-declared `expect_stdout_*` patterns tripped |
| 63-2 | `executor.ts` `detectErrorShapeIndicators` | probe stdout contains `"isError":true` / `"status":"error"` despite exit 0 |
| 60-7 | `source-ac-fidelity-check` | operational-path heuristic |
| 61-5 | `scope-guardrail.ts` `isPureTransitiveReExport` | out-of-scope file is purely re-export of in-scope source |
| 61-7 | `acceptance-criteria-evidence-check` | dev under-claimed AC but code-evidence exists |

**Convention**: each Layer 4 detection produces a structured
`VerificationFinding` with a distinct `category` so Layer 5 routing
can distinguish it from other failure modes. Author-declared
assertions (Layer 1 patterns the agent followed) take precedence over
defense-in-depth detection in finding-category routing — when both
trigger, the author's specific assertion wins (e.g., 60-4 author-declared
assertion before 63-2 auto-detection).

### Layer 5: recovery routing

**Purpose**: decide what HAPPENS in response to a Layer 2-4 finding.
Different findings warrant different actions: escalate, auto-approve
with warning, retry without budget cost, downgrade severity, etc.

**Current instances** (all in
`src/modules/implementation-orchestrator/orchestrator-impl.ts`):

| Story | Routing decision |
|---|---|
| 51-2 | Phantom review detection (dispatch failed OR non-SHIP_IT verdict + empty issue list + error) → retry once |
| 53-4 | retry-budget gate: hard limit on retry attempts per story |
| 53-11 | scope-guardrail flagging is advisory (LLM reviewer treats as info, not error) |
| 60-9 | major-rework escalation defaults to opus-4-7 model |
| 61-5 | scope-guardrail tolerates transitive re-exports when source IS in Key File Paths |
| 61-6 | minor-fixes fix-dispatch timeout → auto-approve as LGTM_WITH_NOTES (NOT escalate) |
| 61-7 | AC code-evidence found → downgrade `ac-missing-evidence` from error to info |
| 61-8 | Shared `runVerificationAndComplete` helper consolidates the verification + COMPLETE transition for SHIP_IT, at-limit auto-approve, and timeout-on-minor auto-approve sites |
| 62-3 | Schema-validation failure routes to distinct `code-review-output-malformed` event (not generic phantom-review) |
| 62-4 | Malformed cycles don't burn standard retry budget (independent counter capped at 3) |

**Convention**: Layer 5 routing is severity-aware. A finding's category
determines whether it escalates, retries, auto-approves, or downgrades.
The category vocabulary should be additive — new failure modes get
their own category rather than being lumped into a generic
"verification-failed" bucket.

## Patterns for adding a new agent-output failure-mode fix

When the next strata observation surfaces a class of agent-output bug
not currently caught, work through the layers in order:

1. **Can Layer 1 fix it?** Add prompt guidance teaching the agent
   what to emit. This is the cheapest fix — no schema/code changes.
   Pin with a YAML-fitness test on the prompt examples.
2. **If Layer 1 isn't sufficient** (the agent still emits wrong shape
   despite guidance), add a Layer 4 detection that catches the wrong
   shape post-parse. Emit a structured finding with a distinct
   `category`. Layer 1 + Layer 4 in combination form
   author-awareness + executor-enforcement (the obs_012 / Story 63-2
   shape).
3. **If the wrong shape is recoverable** (the agent's intent is clear
   but the encoding is broken — e.g., obs_015 unquoted-colon in
   description), add a Layer 3 recovery transformation. Trigger on the
   specific parse error message. Bounded scope (don't apply broadly).
4. **Decide Layer 5 routing.** Should the finding escalate, retry,
   auto-approve, or downgrade? Add a category-specific handler in the
   orchestrator. Keep the category vocabulary additive.
5. **Document in this doc.** Append the new instance to the appropriate
   layer table above. Keep this catalog current as the canonical
   reference for "what failure modes does substrate handle and how".

## Anti-patterns to avoid

- **Don't conflate phantom-review (agent crashed/timed out) with
  malformed-output (agent reviewed but emitted broken YAML).** They
  warrant different operator action (resource constraints vs prompt
  fix). Story 62-3 disambiguated via distinct event categories.
- **Don't make Layer 3 recovery global.** Each transformation must be
  bounded by trigger pattern + allowlist (the block-scalar rewrite
  only applies to known string-content fields like `description`,
  `message`, `error`, `notes`). Global recovery risks masking real
  structural bugs.
- **Don't make Layer 4 detection override Layer 1 patterns.** When the
  author followed the prompt guidance and added an explicit assertion,
  the author's assertion drives the finding category, not the
  defense-in-depth detection. (Story 63-2 / 60-4 precedence rule.)
- **Don't burn retry budget on Layer 3 recoveries.** A successful
  Layer 3 recovery means parsing succeeded — the cycle was a real
  review cycle, not a phantom retry. Story 62-4 introduces an
  independent counter for malformed-output retries.

## Speculative future layers (NOT shipped)

These are extensions discussed during option (c) framing but not
implemented. Listed for completeness, not as roadmap.

- **Pre-emit validator-agent**: insert a separate LLM call between the
  primary agent and emission. The validator checks the draft output
  against the contract; if invalid, the primary agent re-emits.
  Probably not worth the latency + cost — Layer 1 + Layer 2 + Layer 3
  catch most cases without an extra LLM hop. Reconsider only if
  per-dispatch error rates climb past current baseline.
- **LLM-as-judge category routing**: replace heuristic Layer 4
  detection with an LLM that classifies findings. Risks circular logic
  (the same LLM family that produced the bad output evaluates whether
  it's bad). Stick with deterministic detection.
- **Cross-agent contract registry**: factor each agent's output
  contract into a shared declarative registry instead of per-agent
  zod schemas. Larger refactor; only worth doing if a third
  consuming surface emerges (currently it's just orchestrator + post-run
  analysis).

## Versioning + maintenance

This doc is canonical. Future bug fixes that follow the pattern MUST
update the relevant layer's instance table. New layers (if the pattern
expands) MUST be documented here before shipping.

Removing an instance: add a status note (`shipped vN.N.N` →
`reverted vN.N.N because <reason>`). Don't silently remove rows —
historical context matters for understanding why a category exists.
