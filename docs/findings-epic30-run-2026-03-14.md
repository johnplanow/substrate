# Pipeline Findings — Epic 30 Run (2026-03-14)

> Source: substrate self-hosting, Epic 30 (Telemetry-Driven Optimization)
> Substrate version: v0.5.3 (published)
> Run ID: 482ffc1d-caf8-4dd4-8a2a-9d1cd743e066 (and prior runs same day)
> Result: 7/8 Epic 30 stories complete, 1 escalated (30-6), supervisor interference observed

## Summary

Six pipeline runs executed against Epic 30 on 2026-03-14, totaling ~$1.90 and completing 14 stories. The final run (`482ffc1d`) was disrupted when a supervisor attached from a separate Claude Code session killed a healthy dispatch and restarted the pipeline without preserving the original `--stories` scope.

---

## Finding 1: Supervisor Restart Drops `--stories` Scope (P0)

**Category**: Supervisor logic gap
**Severity**: P0 — causes unscoped pipeline execution, potential unauthorized code changes

### Problem

When the supervisor detects a stall and restarts the pipeline, it does not preserve the original CLI flags (`--stories`, `--epic`, etc.). The restart invokes `substrate run` without scope constraints, causing `resolveStoryKeys()` to fall through to Level 1.5 (`ready_stories` SQL view), which returns ALL ready stories across ALL epics.

### What happened

1. Other session ran: `substrate run --events --stories 30-3,30-6,30-8`
2. This session attached a supervisor to run `482ffc1d`
3. Story 30-8 entered `IN_REVIEW` — review agent was mid-flight
4. At 618s staleness, supervisor declared stall, killed pids `[3817882, 3939548]`
5. Supervisor restarted with bare `substrate run` (no `--stories` flag)
6. New run discovered 17 stories from Epics 31/33/34 via `ready_stories` view
7. Started dispatching Epic 31 work (hit schema error, which stopped it)

### Expected behavior

Supervisor restart must replay the original CLI flags. When the user asked for `--stories 30-3,30-6,30-8`, the restart should scope to those same stories.

### Fix options

1. **Record original CLI flags in pipeline_runs table** — supervisor reads them back on restart
2. **Supervisor uses `substrate resume` instead of `substrate run`** — resume should inherit the original run's story set from persisted state
3. **Add `--stories-from-run <run_id>` flag** — supervisor passes the original run ID, resolver reads story keys from the run's persisted state

### Files involved

- Supervisor restart logic (published binary)
- `src/modules/implementation-orchestrator/story-discovery.ts` — `resolveStoryKeys()` Level 1.5 has no scoping when `explicit` is absent

---

## Finding 2: Supervisor Stall Threshold Too Aggressive for Code Review (P1)

**Category**: Supervisor tuning
**Severity**: P1 — kills healthy dispatches, wastes work

### Problem

The supervisor declared a stall at 618 seconds (10.3 minutes) of staleness. Story 30-8 was in `IN_REVIEW` — code review dispatches routinely take 10-30 minutes. The review agent was likely mid-flight when killed.

### Evidence

Supervisor polls showed stable token counts (119,116 input / 6,620 output) from 00:10:19 to 00:13:52. The review agent may have been reading files, which doesn't produce output tokens. This is normal behavior, not a stall.

### Recommendation

- Phase-aware stall thresholds: `create-story` (5 min), `dev-story` (15 min), `code-review` (15 min), `test-plan` (10 min)
- Or: supervisor should check if child process CPU > 0% before declaring stall (it already has `child_count` — add CPU sampling)

---

## Finding 3: Story 30-6 Namespace Collision — Repeated Escalation (P1)

**Category**: Story spec / dependency ordering
**Severity**: P1 — story permanently blocked without manual intervention

### Problem

Story 30-6 ("Recommendation-to-Prompt Injection") specifies AC1: "New `TelemetryAdvisor` service." But `TelemetryAdvisor` already exists in `src/modules/telemetry/telemetry-advisor.ts` — created by story 30-8 ("Efficiency-Gated Retry Decisions") with a different API surface.

| Method | 30-6 spec expects | 30-8 actually built |
|---|---|---|
| `getRecommendationsForRun(runId)` | Yes (AC2) | No |
| `formatOptimizationDirectives(recs)` | Yes (AC3) | No |
| `getEfficiencyProfile(storyKey)` | No | Yes |

The create-story agent bails immediately (16 output tokens) because it can't reconcile "create new class" with an existing class of the same name. This happened twice across two separate runs.

### Root cause

Stories 30-6 and 30-8 have an undeclared dependency (30-8 depends on 30-6's class). The pipeline executed 30-8 first in a prior run, and 30-8 created a minimal version of the class for its own needs. Now 30-6's spec is stale.

### Fix

Manually implement 30-6 by extending the existing `TelemetryAdvisor` with the two missing methods (`getRecommendationsForRun`, `formatOptimizationDirectives`) and adding orchestrator integration. The class is 99 lines — adding two methods keeps it under 150.

### Long-term prevention

Epic 31 (stories 31-2, 31-6) adds dependency DAG ingestion and contract detection. Once shipped, the pipeline will infer that 30-8 depends on 30-6 (create/use pattern) and enforce correct ordering.

---

## Finding 4: `story_dependencies` Schema Mismatch — Missing `created_at` Column (P1)

**Category**: Schema drift
**Severity**: P1 — contract dependency tracking silently broken

### Problem

After the supervisor restart, the new pipeline attempted to write contract dependencies:

```sql
INSERT INTO story_dependencies (story_key, depends_on, dependency_type, source, created_at)
VALUES ('31-4', '31-1', 'blocks', 'contract', '2026-03-15T00:14:18.127Z')
```

Error: `Unknown column 'created_at' in 'story_dependencies'`

The published substrate code (`WorkGraphRepository.addContractDependencies()`) expects a `created_at` column that doesn't exist in the Dolt `story_dependencies` table schema.

### Root cause

The `story_dependencies` table was created by a prior pipeline run (or manually), but with a schema that doesn't include `created_at`. The code in `WorkGraphRepository` was updated (likely in Epic 31 development) to include `created_at`, but the table wasn't migrated.

### Fix

Either:
1. Add `created_at DATETIME` column to the `story_dependencies` table in `src/modules/state/schema.sql`
2. Or remove `created_at` from the INSERT in `WorkGraphRepository.addContractDependencies()`

The error is logged as best-effort (non-fatal), so no data loss occurred.

### Files involved

- `src/modules/state/schema.sql` — table definition
- Published binary: `WorkGraphRepository.addContractDependencies()` at `run-D7a-qzk9.js:7341`

---

## Finding 5: Cross-Session Supervisor Interference (P2, Process)

**Category**: Operational discipline
**Severity**: P2 — human process issue, not a code bug

### Problem

A supervisor was attached to an active pipeline run from a *different* Claude Code session than the one that started the run. The supervisor had no awareness of the original session's intent, flags, or progress context. It applied default stall thresholds and killed what was likely a healthy dispatch.

### Recommendation

- Document in CLAUDE.md: only attach supervisors to runs you started, or coordinate with the originating session first
- Consider: supervisor could check if another supervisor is already attached (mutex/lock file)
- Consider: supervisor attach should warn if the run was started by a different process (compare PIDs or session IDs)
