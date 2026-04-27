# Epic 62: Code-Review Output Recovery

## Vision

Close the structural blind spot in substrate's code-review output
handling that produces false-positive escalations whenever a reviewer
quotes a colon-bearing string (shell snippet, `key: value` text, file
path, etc.) in a finding description. Surfaced live by strata Run 14
(2026-04-27, run_id `974378ef-56a7-4321-841f-ec1168256b30`): Story 1-14
escalated `retry_budget_exhausted` after the YAML parser broke on a
finding description that quoted `cp "${QUADLET_SRC}" "${QUADLET_DEST}"`
as part of a Quadlet review. Independent strata-side smoke pass
confirmed the underlying code had no real blockers — the escalation
was a pure substrate-side false positive.

Filed strata-side as obs_2026-04-27_015 (severity: high, recurrence:
high — any infra/ops story with shell scripts will trigger).

## Root cause

The code-review agent emits YAML output containing finding-description
strings. When a description contains an unescaped colon (typically a
shell command quoted from the reviewed code), `js-yaml` interprets the
colon as a key-value separator and rejects the document with
`bad indentation of a mapping entry (LINE:COL)`.

Substrate's response chain has four layers, each contributing to the
false-positive verdict:

1. **Prompt** (`packs/bmad/prompts/code-review.md`) doesn't tell the
   agent how to format string content that may contain colons. The
   agent emits free-form strings that may or may not be YAML-safe.
2. **Parser** (`packages/core/src/dispatch/yaml-parser.ts`) attempts
   strict `yaml.load`. Already has heuristic recovery for duplicate
   keys and invalid backslash escapes, but no recovery for
   unquoted-colon-in-value parse failures.
3. **Phantom-review classification** (`orchestrator-impl.ts:3421`)
   conflates schema-validation failure with "agent reviewed and found
   nothing" — both manifest as `dispatchFailed=true` with the same
   downstream handling. Operators can't distinguish "agent didn't
   review" from "agent did but emission was malformed".
4. **Cycle budget** (`orchestrator-impl.ts:3277`) increments retry
   count regardless of cause. A schema-validation failure burns
   budget that genuine review failures need.

These four layers form a chain: a prompt update at the top reduces
the trigger frequency, but the lower layers remain blind to the
distinction between "no review work produced" and "review work
produced but unrecoverable as YAML". Fixing only one layer leaves
operational risk in the others.

## Why this slips past every existing gate

- **Code-review schema validation is the ONLY gate that consumes the
  agent's YAML.** If validation fails, no other gate gets to weigh
  in — the orchestrator treats schema failure as phantom-review
  without further analysis.
- **No fallback parser:** `parseYamlResult` doesn't try block-scalar
  conversion, doesn't try escape-correction beyond the existing
  duplicate-key + invalid-escape recovery.
- **Dev-authored output structure:** the code-review agent decides
  line-by-line how to format its YAML. The agent is "encouraged" to
  emit valid YAML by prompt but isn't given a YAML-fitness
  validator before emitting (validation runs server-side after).

## Story Map

- **62-1**: code-review prompt — block-scalar form for finding descriptions (P0, Small)
- **62-2**: yaml-parser block-scalar recovery on parse failure (P0, Medium)
- **62-3**: distinct event for `code-review-output-malformed` vs `phantom-review` (P0, Small)
- **62-4**: schema-validation failures don't burn review-cycle budget (P0, Small)

**Dependency chain**: 62-1 reduces trigger frequency at the source;
62-2 catches the residual cases (any prompt change has imperfect LLM
adherence); 62-3 makes the phantom-vs-malformed distinction visible
in events and findings; 62-4 prevents budget burn on a non-review
failure mode. All four ship together — partial fixes leave one of
the four layers as a residual false-positive surface.

## Story 62-1: code-review prompt — block-scalar form for finding descriptions

**Priority**: must

**Description**: Update `packs/bmad/prompts/code-review.md` to require
finding-description strings be emitted as YAML block scalars
(`description: |\n  ...content...`) when content may contain colons,
quotes, or shell snippets. Block scalars don't interpret `:` specially.

**Acceptance Criteria**:

- The prompt's output-format section explicitly states: "When a
  finding's `description`, `message`, `command`, or any free-form
  string field may contain a colon, a quoted shell snippet, or a
  multi-line value, ALWAYS use YAML block-scalar form (`field: |`)
  followed by indented content. Do not use single-quoted or
  double-quoted scalars for content that includes colons."
- The prompt includes a worked example of a shell-snippet-bearing
  finding emitted as a block scalar (e.g., the strata 1-14 case
  shape).
- A test extracts every fenced YAML block from the rendered
  `code-review.md` prompt and asserts each parses cleanly. This
  guards against future prompt edits that ship malformed YAML
  examples.

**Key File Paths**:
- `packs/bmad/prompts/code-review.md`
- `src/modules/compiled-workflows/__tests__/code-review.test.ts` (or new test for prompt-template YAML examples)

## Story 62-2: yaml-parser block-scalar recovery on parse failure

**Priority**: must

**Description**: When `js-yaml` rejects a document with
`bad indentation of a mapping entry (LINE:COL)`, attempt automatic
recovery. The most common case is a `<field>: <value>` line where the
value contains an unescaped colon. Recovery rewrites the line as
block-scalar form (`<field>: |-\n  <value>`) and re-parses.

Recovery applies only to known string-content fields where free-form
text is expected (`description`, `message`, `error`, `notes`,
`comment`, `finding`). Other fields stay strict.

**Acceptance Criteria**:

- `parseYamlResult` recognizes the `bad indentation of a mapping entry`
  error and routes through a new `attemptBlockScalarRecovery` step
  before giving up.
- The recovery step inspects the offending line; if it matches
  `^(<known-field>):\s+(.*)$` and the value contains characters that
  would break YAML parsing (unescaped colons in unquoted context),
  the line is rewritten as block-scalar form and the document
  re-parsed.
- Recovery is opt-in per field name (allowlist) — substrate doesn't
  blanket-rewrite arbitrary fields.
- Test: a real shell-command-bearing description that breaks vanilla
  parser parses cleanly via recovery. Real fixture from obs_015's
  artifacts (or a synthesized equivalent).
- Test: a parse failure NOT caused by a string-field colon (e.g.,
  malformed YAML with broken indentation in actual structure) still
  fails — recovery is bounded to the specific failure mode.
- Test: recovery preserves multi-quoted-segment content faithfully
  (no double-escaping, no character loss).

**Key File Paths**:
- `packages/core/src/dispatch/yaml-parser.ts`
- `packages/core/src/__tests__/yaml-parser.test.ts`
- `src/modules/agent-dispatch/__tests__/yaml-parser.test.ts` (re-export shim test, may not need new tests)

## Story 62-3: distinct event for `code-review-output-malformed` vs `phantom-review`

**Priority**: must

**Description**: Phantom-review currently fires on two conceptually
distinct conditions:
1. Dispatch failed (crash, timeout, non-zero exit) — agent didn't
   produce a review at all
2. Agent produced output that failed schema validation — agent
   reviewed but emitted malformed YAML

The orchestrator currently conflates these. Operators can't tell from
the escalation reason whether to debug "why didn't the agent review"
vs "why was the agent's output malformed". The malformed case is
actionable (prompt edit, parser fix); the genuine empty-review case
is structural (likely diff too large or environment-constrained).

**Acceptance Criteria**:

- The code-review workflow function distinguishes "dispatch failed"
  from "schema validation failed" in `defaultFailResult` (or a new
  `defaultMalformedResult`). The malformed result carries a distinct
  `error` string that the orchestrator can pattern-match.
- The orchestrator's phantom-review detection path emits a new
  finding category `code-review-output-malformed` (with severity
  `error`) when the cause was schema validation, separate from the
  generic phantom-review path.
- The story's escalation event (when escalation eventually fires)
  includes the distinction in its `lastVerdict` field
  (`code-review-output-malformed` instead of generic
  `consecutive-review-timeouts` or `retry_budget_exhausted`).
- Test: schema-validation-failure path produces a malformed finding;
  genuine dispatch-failure (crash/timeout) still produces the
  classic phantom-review path.

**Key File Paths**:
- `src/modules/compiled-workflows/code-review.ts`
- `src/modules/implementation-orchestrator/orchestrator-impl.ts`
- `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts`

## Story 62-4: schema-validation failures don't burn review-cycle budget

**Priority**: must

**Description**: The retry-budget gate at `orchestrator-impl.ts:3277`
increments `_storyRetryCount` on every retry attempt regardless of
cause. When phantom-review fires due to schema validation
(`code-review-output-malformed` from 62-3), the cycle didn't produce
review work — it produced formatting failure. Burning a retry budget
slot on a non-review failure mode means the next genuine review
defect can't be retried.

Per obs_015's belt-and-suspenders fix direction: schema-validation
failures should NOT count toward the review-cycle budget.

**Acceptance Criteria**:

- The retry-budget increment in the loop body is conditional on the
  cycle's outcome being a real review failure (genuine
  NEEDS_MINOR_FIXES / NEEDS_MAJOR_REWORK or dispatch failure
  unrelated to schema validation). Schema-validation phantoms skip
  the increment.
- Test: a story whose first review cycle produces malformed output
  followed by a clean review cycle ships without retry budget being
  consumed by the malformed cycle.
- Test: a story whose first review cycle produces a genuine
  NEEDS_MAJOR_REWORK followed by malformed output cycle still ships
  cleanly — the genuine cycle consumes one slot, the malformed
  doesn't, leaving budget for a third real cycle if needed.
- Test: a story with consecutive malformed-output cycles eventually
  escalates (we don't loop forever) — escalation reason is
  `code-review-output-malformed-budget-exceeded` or similar, not
  `retry_budget_exhausted`.

**Key File Paths**:
- `src/modules/implementation-orchestrator/orchestrator-impl.ts`
- `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts`

## Empirical validation

Closing this epic completes the obs_015 fix surface. Validation lives
in the next strata dispatch (any infra/ops story whose code review
likely quotes shell commands). Expected behavior under post-Sprint-15
substrate:

- Code review's malformed YAML output is recoverable via 62-2's
  block-scalar fallback in most cases — story progresses normally.
- Where 62-2 can't recover, 62-3's distinct `code-review-output-malformed`
  finding surfaces in events; 62-4's exemption keeps cycle budget
  available for a re-review.
- The `retry_budget_exhausted` escalation class (driven by
  schema-validation phantoms) is eliminated.

## Out-of-scope follow-ups

- **Output-validation-as-a-shared-step** (per obs_015 Related): a
  unified pre-emit YAML-fitness validator that all agent invocations
  go through. Larger architectural change; defer to a future epic.
- **obs_012 (REOPENED)** — runtime-probe success-shape assertions.
  Distinct surface (probe schema, not review schema). Sprint 16
  candidate.
- **obs_002** — SIGTERM cleanup. Open since 2026-04-21, untested.
  Sprint 16 candidate alongside obs_012.

## Versions

- v0.20.32 (2026-04-27, current) — Epic 61 Phase 3 (recovery-path
  calibration). All four Phase 3 stories shipped.
- v0.20.33 (target) — Epic 62 (this epic). All four obs_015 fix
  layers ship together.
