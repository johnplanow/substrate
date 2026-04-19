# Story 17.4: Automated Experimentation Framework

Status: ready
Blocked-by: 17-3

## Story

As a pipeline operator,
I want the supervisor to act on its own optimization recommendations by creating branches, modifying prompts, running controlled experiments, and opening PRs with evidence,
so that the pipeline self-improves with human approval as the only gate.

## Context

Story 17-3 produces machine-readable recommendations like "prompt X uses 61% more tokens than baseline." This story gives the supervisor the authority to *fix* those recommendations: branch, modify, test, measure, and present results for human approval.

This is Winston's "automated experimentation with human merge authority" — the agent does the grunt work, you approve the evidence.

## Acceptance Criteria

### AC1: Experiment Mode Flag
**Given** the supervisor is running
**When** started with `--experiment` flag
**Then** after post-run analysis (17-3), the supervisor enters experiment mode
**And** without `--experiment`, it only produces reports (Tier 2 behavior)

### AC2: Branch Creation
**Given** the supervisor has a recommendation to test
**When** it enters experiment mode
**Then** it creates a git branch: `supervisor/experiment/<run-id>-<short-desc>`
**And** applies the recommended modification (prompt edit, config change, etc.)
**And** commits the change with a message referencing the recommendation

### AC3: Controlled Single-Story Run
**Given** an experiment branch exists with a modification
**When** the supervisor runs the experiment
**Then** it executes `substrate auto run --stories <story-key>` for a single representative story
**And** the story is chosen based on the recommendation (e.g., the story that had the regression)
**And** the experiment run uses the same methodology pack and config as the baseline

### AC4: Results Comparison
**Given** an experiment run completes
**When** the supervisor compares results
**Then** it queries `run_metrics` and `story_metrics` for both the experiment run and the baseline
**And** it computes deltas for: tokens, cost, review cycles, wall-clock time
**And** it determines a verdict: `IMPROVED` (target metric improved, no regressions), `MIXED` (some better, some worse), `REGRESSED` (target metric worsened)

### AC5: Pull Request with Evidence
**Given** an experiment produces an IMPROVED or MIXED verdict
**When** the supervisor generates results
**Then** it opens a GitHub PR via `gh pr create` with:
  - Title: `[supervisor] <recommendation summary>`
  - Body: metrics comparison table, verdict, raw data
  - Labels: `supervisor`, `automated-experiment`
**And** if verdict is REGRESSED, the branch is deleted without a PR
**And** the supervisor logs the outcome either way

### AC6: Experiment Safety Limits
**Given** the supervisor is in experiment mode
**When** running experiments
**Then** it runs at most `--max-experiments <n>` per analysis cycle (default: 2)
**And** each experiment has a token budget cap of 2x the baseline story cost
**And** experiments are run sequentially, never in parallel
**And** the supervisor never modifies main/master directly — all changes are on branches

### AC7: Experiment Audit Trail
**Given** experiments are run
**When** the experiment cycle completes
**Then** an experiment log is written to `_bmad-output/supervisor-reports/<run-id>-experiments.md`
**And** it includes: hypothesis, modification, results, verdict, PR link (if created)
**And** the log is append-only across experiment cycles

### AC8: Existing Tests Pass
**Given** the experimentation framework is implemented
**When** the full test suite runs
**Then** all existing tests pass and coverage thresholds are maintained

## Dev Notes

### Architecture

- Experiment logic in `src/modules/supervisor/experimenter.ts` (new)
- Uses `simple-git` or shell `git` commands for branch management
- Single-story run via programmatic invocation of pipeline (not shelling out to CLI)
- PR creation via `gh pr create` (requires gh CLI installed — degrade gracefully if missing)
- Experiment state machine: `SELECTING → BRANCHING → MODIFYING → RUNNING → COMPARING → REPORTING`

### Recommendation → Modification Mapping

The experimenter needs to translate machine-readable recommendations into concrete code changes:

| Recommendation Type | Modification |
|---|---|
| `token_regression` in a prompt phase | Reduce context injection size, compress summaries |
| `review_cycles` excessive | Adjust acceptance criteria strictness in review prompt |
| `timing_bottleneck` in a phase | Adjust `max_turns` or token budget for that phase |

Initially, modifications are template-based (predefined strategies per recommendation type). Future iterations could use an LLM to generate novel modifications.

### Safety

- All experiments on isolated branches — never touches main
- Token budget cap prevents runaway costs
- Max experiments per cycle prevents infinite loops
- Sequential execution prevents resource contention
- REGRESSED experiments auto-clean (branch deleted)

## Tasks

- [ ] Create `src/modules/supervisor/experimenter.ts` (AC2, AC3)
- [ ] Implement `--experiment` flag on supervisor command (AC1)
- [ ] Implement git branch creation and modification application (AC2)
- [ ] Implement single-story controlled run (AC3)
- [ ] Implement results comparison with verdict derivation (AC4)
- [ ] Implement PR creation via `gh` CLI with metrics body (AC5)
- [ ] Implement safety limits: max experiments, token cap, sequential execution (AC6)
- [ ] Implement experiment audit trail (AC7)
- [ ] Define recommendation → modification templates for initial strategy set
- [ ] Write unit tests for experiment state machine
- [ ] Write unit tests for results comparison and verdict
- [ ] Write integration test for branch→run→compare→PR cycle (mocked)
- [ ] Verify full test suite passes (AC8)
