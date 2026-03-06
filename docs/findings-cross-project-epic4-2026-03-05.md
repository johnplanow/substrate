# Cross-Project Pipeline Findings

> Source: ticketing-platform/code-review-agent Epic 4 run (2026-03-05)
> Substrate version: v0.2.19
> Run ID: 9ade92d3-0b3b-436f-8162-b5f8b9f9c0f7
> Result: 5/6 stories completed, 2 with wrong content, orchestrator OOM on story 6

## P0 — Data Integrity Bugs

### 1. Stale epic shard seeding (never re-seeds)

**File**: `src/modules/implementation-orchestrator/seed-methodology-context.ts:165-170`

`seedEpicShards()` checks if any `epic-shard` decisions exist and skips entirely if so. When the epics.md source file is updated (e.g., after a re-planning sprint), the decision store retains old shards forever.

**Impact**: Pipeline ran stories for "Comprehensive Test Coverage and CI Integration" (old Epic 4) instead of "Automated AI Code Review Pipeline" (current Epic 4). Required manual DB cleanup to fix.

**Fix**: Compare a content hash of the source file against the stored shards. Re-seed when the hash changes. Consider storing the source file hash as a decision entry for comparison.

### 2. Epic shard truncation at 4000 chars

**File**: `src/modules/implementation-orchestrator/seed-methodology-context.ts:190`

`MAX_EPIC_SHARD_CHARS = 4_000` truncates large epics mid-sentence. Epic 4 had 6 stories but only the first 3 fit within the shard. Stories 4-5 and 4-6 were completely hallucinated by the create-story agent.

**Impact**: 2 of 6 stories implemented wrong functionality. Wasted ~$0.60 in tokens on wrong work.

**Fix options**:
- Extract only the target story's section from the epic (not the entire epic). The `storyKey` is available in `runCreateStory` — use it to grep the story section from the shard.
- Increase `MAX_EPIC_SHARD_CHARS` to 8000 or 12000 (the create-story `TOKEN_CEILING` is only 3000, so the shard is already being truncated by the prompt assembler anyway).
- Shard per-story instead of per-epic in `seedEpicShards`.

### 3. Heading-level mismatch in parseEpicShards

**File**: `src/modules/implementation-orchestrator/seed-methodology-context.ts:302`

```javascript
const epicPattern = /^## (?:Epic\s+)?(\d+)[.:\s]/gm
```

Only matches `## Epic N` (h2). The canonical epics file in the target project used `### Epic N` (h3). The seeder silently returned 0 shards and the file-based fallback also uses `## ` matching.

**Impact**: Zero shards seeded on first run. Required manual heading conversion (`### Epic` → `## Epic`).

**Fix**: Accept variable heading depth: `/^#{2,4}\s+(?:Epic\s+)?(\d+)[.:\s]/gm`

Also update `readEpicShardFromFile()` at line 327-330 to use the same relaxed pattern.

## P1 — Quality Impact Bugs

### 4. Silent code review fallback verdicts

**Files**:
- `src/modules/compiled-workflows/code-review.ts` (dispatch error handling)
- `src/modules/compiled-workflows/git-helpers.ts` (git add --intent-to-add)

When `git add --intent-to-add` fails (e.g., a file path from a previous run no longer exists), the git helper logs a warning and returns an empty diff. The code-review dispatch then fails (exit code 1). The v0.2.19 change causes schema-validation failures to fall back to `NEEDS_MINOR_FIXES` instead of `NEEDS_MAJOR_REWORK`.

**Impact**: All 12 code review cycles across 6 stories were phantom — no code was actually reviewed. Fix agents applied random patches based on non-existent review findings. Wasted tokens on every fix cycle.

**Error observed**:
```
fatal: pathspec '_bmad-output/implementation-artifacts/4-1-testcontainers-...' did not match any files
```

**Fix**:
- Distinguish "review dispatch failed" (error) from "review ran and found issues" (verdict). Failed dispatches should retry or escalate, never produce a fallback verdict.
- Git helper should skip nonexistent files in `--intent-to-add` rather than failing the entire diff.
- Consider: if the diff is empty after git-helper errors, skip code review entirely and mark SHIP_IT (no changes to review).

### 5. False stall detection during dev-story

**Files**:
- `src/modules/implementation-orchestrator/` (watchdog logic)
- `src/modules/supervisor/` (stall detection)

`last_activity` in the pipeline run state only updates on story phase transitions (create-story complete, dev-story complete, etc.). During a 13-minute dev-story run, `staleness_seconds` climbs to 600+ and triggers `story:stall` events even though the child agent is actively working at 5% CPU with 900+ lines of new code.

**Impact**: If supervisor were running with default 600s stall threshold, it would kill actively-working dev agents. The `child_pid: null` in the stall event confirms process detection failure (see #6).

**Fix**:
- Update `last_activity` when heartbeats show `active_dispatches > 0` (proves dispatches are in progress).
- Use child process liveness (PID exists + CPU > 0) as a staleness override.
- Consider raising the default stall threshold for dev-story tasks (which commonly run 10-15 min).

## P2 — Operational Issues

### 6. Process detection always returns null

Health check consistently reports `orchestrator_pid: null, child_pids: [], zombies: []` despite both orchestrator and child agent processes being alive and active.

**Impact**: Stall detection, health monitoring, and supervisor decisions all unreliable. Health verdict `NO_PIPELINE_RUNNING` reported while pipeline was actively processing stories.

### 7. Memory pressure kills orchestrator without recovery

After running 5 stories (~2 hours), macOS memory dropped to 34MB free (threshold: 256MB). The orchestrator entered a dispatch-hold state and the process was killed (likely OOM). Story 4-6 was left incomplete.

**Impact**: Lost the final story's code-review and any remaining pipeline work.

**Fix**: Implement a backoff-retry loop in the dispatch-hold path instead of blocking indefinitely. Add periodic GC hints between stories. Consider tracking cumulative child process memory and warning when approaching limits.

### 8. NEEDS_MAJOR_REWORK treated same as NEEDS_MINOR_FIXES

Story 4-1 received `NEEDS_MAJOR_REWORK` on second review but got the same fix-story treatment as minor fixes. Major rework should trigger a full re-dev with the review findings injected as context, not a patch.

## P3 — Throughput / UX Issues

### 9. Stories execute serially despite concurrency setting

`active_dispatches` was always 1 throughout the entire run despite `concurrency: 3` in config and `max_concurrent_tasks: 4` globally. Stories were strictly serialized: story N completed all phases before story N+1 started.

**Impact**: 6 stories took 2h25m. With concurrency 3, independent stories could have completed in ~50min.

### 10. Create-story reuses stale files without validation

On the second pipeline run (after fixing epic shards), the pipeline instantly "completed" create-story by finding the existing story file on disk from the first failed run. The file was 0 bytes but create-story still reported success.

**Fix**: Validate that the existing story file is non-empty and matches the expected epic context before skipping creation.

### 11. Status endpoint inconsistencies

`substrate status --output-format json` reports `stories_count: 0` throughout the run even as stories complete. The health endpoint correctly tracks completion counts. These should be consistent.

## Metrics

| Metric | Value |
|--------|-------|
| Total runtime | 2h 25min |
| Total cost (API tokens) | $2.03 |
| Stories completed | 5/6 |
| Stories with correct content | 4/6 (4-1 through 4-4) |
| Stories with wrong content | 2/6 (4-5, 4-6 — epic shard truncation) |
| Review cycles (all phantom) | 12 |
| Stall events (all false) | 2 |
| Files changed | 97 |
| Lines added | 6,863 |
| Average time per story | ~24 min |
| Orchestrator deaths | 1 (OOM) |
