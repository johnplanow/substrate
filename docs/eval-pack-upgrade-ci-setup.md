# Eval Pack Upgrade — CI Setup Guide

## Overview

The pack-upgrade eval harness (`scripts/eval-pack-upgrade/harness.mjs`) compares
methodology pack versions A/B by dispatching the same story under both packs and
grading the difference across four axes (code quality, cost, verdict, recovery).

As of Story 81-6, the harness has production dispatch wiring via `createDispatcher`
from `@substrate-ai/core`. Dispatches invoke real models.

## Auth Requirements

### Local Development

The harness uses the operator's Claude Code OAuth session, discovered automatically
by the `ClaudeCodeAdapter` from `~/.claude/`. No additional config needed.

```bash
node scripts/eval-pack-upgrade/harness.mjs \
  --pack-current packs/bmad \
  --pack-candidate packs/bmad-candidate \
  --corpus _bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml
```

### CI (GitHub Actions)

In CI environments (`GITHUB_ACTIONS=true`), the harness requires `ANTHROPIC_API_KEY`:

```yaml
# .github/workflows/eval-pack-upgrade.yml
env:
  ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The harness exits with a clear error if the key is absent:
```
[pack-upgrade-harness] ERROR: ANTHROPIC_API_KEY required for CI dispatch — see docs/eval-pack-upgrade-ci-setup.md
```

## Budget Caps

Per-dispatch budget cap defaults to $2.00 USD. Override with:
```bash
--budget-per-case-usd 0.50
```

Dispatches that exceed the cap record `dispatch_outcome: 'budget-exceeded'` and
do not abort the run (failure-tolerant per-pair design).

## Integration Tests

To run the integration test (one real model dispatch):
```bash
SUBSTRATE_EVAL_INTEGRATION=1 npx vitest run scripts/eval-pack-upgrade/__tests__/integration.test.ts
```

The integration test uses a small budget cap ($0.50) and max-5-turns limit to
bound cost and runtime. Expected cost: $0.10–$0.50.

## Design Notes

- A/B dispatch is SEQUENTIAL (not parallel) to bound cost and avoid worktree conflicts.
- Each dispatch creates a fresh `createDispatcher` instance — no cross-pair state.
- Pack template loading: `packLoader(packPath, taskType)` reads `manifest.yaml` and
  the prompt file, then replaces `{{story_content}}` with the story file content.
  This mirrors the `assemblePrompt` path in `src/modules/compiled-workflows/dev-story.ts`.
- `DispatchHandle.cancel()` is available for mid-dispatch abort when needed.
