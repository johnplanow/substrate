# Cross-Project Pipeline Findings — Sprint 2

> Source: ticketing-platform/code-review-agent Epic 4, stories 4-5 & 4-6
> Substrate version: v0.2.29
> Run ID: ce5bedd4-2d3c-4b30-af39-f50a063c6480
> Result: 2/2 stories completed, both passed code review, cross-module schema mismatch detected post-pipeline

## Summary

| Metric | 4-5 (Judge Agent) | 4-6 (Check-Run Publisher) |
|---|---|---|
| Wall clock | 22.5 min | 17.5 min |
| Phases | create-story (6.7m) → dev (8.5m) → review x2 (7.2m) | dev (7.25m) → review x2 (10.2m) |
| Tokens (input) | 111,344 | 120,008 |
| Tokens (output) | 1,545 | 1,860 |
| Review cycles | 2 | 2 |
| Dispatches | 5 | 4 |
| Tests created | 22 (3 files) | 31 (3 files) |
| Build | PASS | PASS |
| Regressions | None | None |

Total wall-clock: ~23 minutes (parallel). Both stories ran concurrently and completed successfully.

## Finding 1: Cross-Module Schema Incoherence (CRITICAL)

**Category**: Pipeline architectural gap
**Severity**: P0 — runtime integration will fail silently

### Problem

Stories 4-5 (judge-agent) and 4-6 (github-check-publisher) ran in parallel and independently designed their message contract for the `judge-result-queue` RabbitMQ topic.

**judge-agent publishes** (consumer.ts:144-157):
```typescript
{
  correlationId, prId, teamId,
  verdict, blockingFindings, advisoryFindings, summary,
  postedToGitHub, repoOwner, repoName, headSha, prNumber
}
```

**github-check-publisher expects** (via `JudgeResultSchema` from shared-types/check-run.ts):
```typescript
{
  correlationId, prId, teamId, repoOwner, repoName, headSha,
  installationId, teamThreshold, findings: ValidatedFinding[]
}
```

Messages from judge-agent will fail Zod validation in the publisher's consumer and get nacked to the DLQ.

### Root Cause

Both agents had the `JudgeResult` schema in their architecture constraints, but:
1. Story 4-6's spec defined `JudgeResultSchema` in `shared-types/src/check-run.ts` as a new type
2. Story 4-5's dev agent implemented its own result structure in `consumer.ts` without importing or conforming to the schema
3. The code-review agent for each story only reviewed that story's diff — it cannot detect cross-story contract violations

### Why the pipeline can't catch this today

- Build verification passes because both packages compile independently — they don't import from each other at build time
- Interface change detection flagged warnings about modified exports, but it doesn't validate that a publisher's output matches a consumer's input schema
- Code review is scoped to single-story diffs

### Proposed fix (substrate)

**Contract handshake gate**: When two stories in the same sprint declare the same queue/topic/interface in their specs, the pipeline should:
1. Detect the shared contract during story creation (parse queue names from Dev Notes)
2. Either serialize those stories (so the second one sees the first's output) or
3. Run a post-implementation "contract verification" step that validates producer output schemas match consumer input schemas

Alternatively: **shared interface lock** — if story A creates `JudgeResultSchema`, story B should import it, not redefine it. The pipeline could enforce "no duplicate schema definitions" as a build gate.

## Finding 2: Token Ceiling Truncation (RECURRING)

**Category**: Configuration gap
**Severity**: P1 — agent gets degraded context

### Problem

Story 4-6's dev-story prompt was 17,416 tokens. The token ceiling is 3,000. The prompt assembler truncated `arch_constraints` to fit:

```
{"level":"warn","name":"compiled-workflows:prompt-assembler","tokenCount":17416,"ceiling":3000,"msg":"Prompt exceeds token ceiling — truncating optional sections"}
{"level":"warn","name":"compiled-workflows:prompt-assembler","sectionName":"arch_constraints","targetSectionTokens":398,"msg":"Section truncated to fit token budget"}
```

Architecture constraints (Kubernetes, RabbitMQ topology, Vault secrets, Flyway migrations) were cut to 398 tokens — losing critical implementation guidance.

### Status — RESOLVED (2026-03-07)

**Investigation revealed the default dev-story TOKEN_CEILING is 24,000 (not 3,000).** The 24K ceiling has been in place since commit `78a5988`. The 3,000 figure in the logs above was from a globally installed substrate version predating v0.2.28, when the token-ceiling.ts module was extracted and the 24K default was centralized.

The **actual gap** was that `run.ts` never wired `token_ceilings` from project config to the orchestrator — Story 24-7 built the infrastructure but the CLI entry point was never connected. **Fixed in Story 25-1** (token ceiling CLI wiring).

### Original proposed fix (superseded)

- ~~Raise the default `TOKEN_CEILING` from 3,000 to 10,000 for dev-story prompts~~ — not needed, default is already 24K
- ~~Make the ceiling auto-scale~~ — not needed at current defaults
- Config overrides now properly propagate via Story 25-1

## Finding 3: Missing test-plan Prompt Template

**Category**: Pack gap
**Severity**: P2 — feature silently skipped

### Problem

The bmad methodology pack has no `test-plan` prompt template. The pipeline logs a warning and skips test planning entirely for every story:

```
Methodology pack "bmad" has no prompt for task type "test-plan".
Test planning returned failed result — proceeding to dev-story without test plan
```

### Impact

Dev agents write tests ad-hoc rather than following a structured test plan. This contributes to low coverage in some areas (judge-agent has 40% statement coverage) and tests that mock too aggressively.

### Proposed fix

Either:
1. Add a `test-plan` prompt to the bmad pack that generates a test strategy before dev-story
2. Or remove the test-plan phase from the implementation orchestrator to eliminate the misleading warning

## Finding 4: Review-Fix Cycle Inflation

**Category**: Pipeline efficiency
**Severity**: P2 — adds latency, no quality gain

### Problem

Both stories went through exactly 2 review-fix cycles. In both cases, the first review verdict was `NEEDS_MINOR_FIXES`, the fix was applied, and the second review also returned `NEEDS_MINOR_FIXES`. The second fix was then applied and the pipeline completed (likely hitting the max review cycles cap).

### Observation

The code-review agent may be too granular on first pass — flagging style issues or minor patterns that don't affect correctness. Each review cycle costs ~2-4 minutes of wall-clock time (dispatch → review → dispatch → fix).

For story 4-6: review took 610 seconds (10.2 minutes) out of 1,051 seconds total — **58% of wall-clock was review/fix cycles**.

### Proposed investigation

- Audit code-review prompts to differentiate between "must fix" and "nice to have" findings
- Consider a `LGTM_WITH_NOTES` verdict that completes the story but logs suggestions for future reference
- Alternatively, cap review cycles at 1 for stories that pass build verification

## Finding 5: Pre-existing Build Failures Go Undetected

**Category**: Pipeline gap
**Severity**: P2 — agents build on broken foundation

### Problem

The target project had build failures before the pipeline ran:
1. `packages/llm-gateway` referenced non-existent `packages/team-config`
2. `packages/agent-orchestrator` had type mismatches (`severity: 'advisory'` vs `'error' | 'warning' | 'info'`)

These were pre-existing from the previous sprint. The pipeline dispatched agents into a broken build environment.

### Impact

- Dev agents may produce code that "works" in isolation but breaks in ways masked by the existing failures
- The pipeline's build verification gate only runs post-dev — it doesn't verify the project builds before starting

### Proposed fix

Add a **pre-flight build check** to the implementation orchestrator. Before dispatching any story:
1. Run the project's build command
2. If it fails, emit a `pipeline:pre-flight-failure` event and abort with actionable error
3. Alternatively, attempt auto-repair (run a fix agent) then re-check

## Finding 6: Missing `installationId` / `teamThreshold` Passthrough

**Category**: Implementation gap (caused by Finding 1)
**Severity**: P1 — part of the schema mismatch

### Problem

The judge-agent consumer receives `JudgeDispatchPayload` which contains `installationId` and `teamThreshold` in the schema, but the implementation doesn't forward these fields to the published result. Even if the schema mismatch (Finding 1) were fixed, these fields would be undefined.

### File

`packages/judge-agent/src/consumer.ts:144-157`

## Finding 7: Vitest Workspace Config Misuse

**Category**: Pre-existing project issue
**Severity**: P3 — affects test runner UX

### Problem

The root `vitest.config.ts` used `defineWorkspace()` which is meant for `vitest.workspace.ts`. Packages without their own vitest config inherited this and crashed with "config must export or return an object."

Fixed during this run by renaming to `vitest.workspace.ts`.

---

## Metrics Comparison with Previous Run

| Metric | v0.2.19 run (2026-03-05) | v0.2.29 run (2026-03-07) |
|---|---|---|
| Stories attempted | 6 | 2 |
| Completed | 5 | 2 |
| Escalated/Failed | 1 (OOM) | 0 |
| Avg wall-clock/story | ~15 min | ~20 min |
| Review cycles/story | 0-1 | 2 |
| Cross-module coherence issues | 2 (wrong story content) | 1 (schema mismatch) |
| Build verification | N/A (pre-v0.2.26) | PASS (both stories) |
| Interface change detection | N/A (pre-v0.2.27) | Triggered (both stories) |

### Progress since v0.2.19

- No OOM crashes (memory backoff works)
- No stale epic shard issues (re-seeding works)
- No wrong-story-content issues (shard truncation fixed)
- Build verification and interface change detection both working
- Heartbeat/staleness tracking functional

### Remaining gaps

1. **Cross-module schema coherence** — the #1 recurring issue across all pipeline runs
2. **Token ceiling defaults too low** — recurring since v0.2.21
3. **Review cycle efficiency** — new observation, may be inherent to the review-fix loop design
