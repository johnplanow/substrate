# Story 81-6: Production dispatcher wiring for eval harnesses

## Story

As a substrate eval-framework operator,
I want both `scripts/eval-reconstruction/harness.mjs` AND `scripts/eval-pack-upgrade/harness.mjs` to have a real production `deps.dispatch` implementation (replacing the throwing stubs left by Stories 77-8 and 81-2),
so that Epic 77 reconstruction tier AND Epic 81 pack-upgrade tier can actually invoke models, capture real envelopes, and produce non-vacuous regression signals.

This story is the **single-ship unlock** for both eval tiers identified in `docs/2026-05-31-epic-81-first-calibration.md`. As of v0.20.138, both harnesses' `deps.dispatch` is a throwing placeholder:

```javascript
// scripts/eval-pack-upgrade/harness.mjs:469-482
dispatch: async () => {
  throw new Error(
    'Production dispatch wiring is not implemented yet (deferred — Story 81-2). ' +
      'Wire a real dispatcher with pack override into deps.dispatch. ' +
      'See the comment in main() for instructions.',
  )
}
```

```javascript
// scripts/eval-reconstruction/harness.mjs:435-444
// Same stub pattern, deferred at Story 77-8 time.
```

When dispatch throws, every pair returns `dispatch_outcome: 'error'` → harness records `both-incomplete` → grader sees zero gradable pairs → vacuous GREEN. Epic 81's Phase 4 capability validation is blocked on this. Story 81-6 unblocks both tiers.

## Acceptance Criteria

1. **Audit `@substrate-ai/core` for `createDispatcher` API.** Document what's exported (`packages/core/dist/dispatch/index.js`), what `CreateDispatcherOptions` looks like, and whether the dispatcher currently accepts a methodology-pack override at construction time. As of v0.20.138, the audit findings should be recorded in the story's Dev Notes — this informs whether AC2 is needed.

2. **Pack-override path (additive if needed).** If `createDispatcher` does NOT currently expose a way to inject a methodology pack at construction time, add an additive forward-only `methodologyPack?: MethodologyPack` option to `CreateDispatcherOptions` in `packages/core/src/dispatch/types.ts` AND wire it through `DispatcherImpl` so that when set, it overrides the default pack resolution path. Follow the v0.20.115/118/124/130 pattern: optional schema field, no breaking changes to existing callers. If the dispatcher ALREADY supports this (or the eval harness can construct a request with a pre-assembled prompt without needing the dispatcher to know about the pack), document the decision in Dev Notes and skip this AC.

3. **Production `deps.dispatch` implementation in `scripts/eval-pack-upgrade/harness.mjs`.** Replace the throwing stub at lines 469-482 with a real implementation:
   - Loads the pack via `createPackLoader().load(packPath)` from `@substrate-ai/core` (or wherever it's exported)
   - Constructs a `Dispatcher` via `createDispatcher` with the pack override (per AC2 if added)
   - Reuses the same prompt-assembly path the implementation orchestrator uses for `runDevStory` — DO NOT hand-roll a new prompt assembly. Either import + reuse `runDevStory` directly from `src/modules/compiled-workflows/dev-story.ts`, or factor out the prompt-assembly into a pure helper that BOTH the orchestrator AND this harness can call. If extraction is needed, the new shared helper is in scope for this story.
   - Builds the result envelope from the dispatch result (diff via `git diff` in the worktree, total_turns + total_tokens from dispatch result, verdict from code-review parse if available else null)
   - Returns the envelope shape contracted by 81-2's AC4

4. **Production `deps.dispatch` implementation in `scripts/eval-reconstruction/harness.mjs`.** Mirror AC3's implementation for the reconstruction harness (no pack-override needed there — it uses the default pack). Same prompt-assembly source, same dispatcher construction, same result-envelope shape used in Epic 77's grader. The reconstruction grader can now compare a re-dispatched diff against the actual commit's diff.

5. **Auth wiring.** Dispatch needs access to a model (Claude Code OAuth session OR API key). Read auth config from substrate's existing config patterns (`SUBSTRATE_CONFIG` or `.substrate/config.yaml` or env vars). When running locally, default to the operator's existing Claude Code OAuth session. When running in CI (detect via `process.env.GITHUB_ACTIONS`), require `ANTHROPIC_API_KEY` env var per Story 81-5's contract. Throw a clear error message when auth is unavailable.

6. **Per-dispatch budget cap remains enforced.** The existing budget-cap logic (default $2.00 per dispatch, mid-dispatch abort) must continue to work — the real `dispatcher.dispatch()` provides a `cancel()` method on its `DispatchHandle` that the harness can invoke when cost ceiling is exceeded. Wire it.

7. **Integration test** (`scripts/eval-pack-upgrade/__tests__/integration.test.ts`): runs ONE pair end-to-end against a real model with a small budget cap (e.g., max-turns 5, budget $0.50). Test is gated by `process.env.SUBSTRATE_EVAL_INTEGRATION === '1'` so it does NOT fire in regular CI — only when the operator explicitly opts in. The test confirms the wiring works against a real model without crashing.

8. **Unit tests** verify the new wiring without invoking a real model:
   - Mocked `createDispatcher` returns a canned `DispatchHandle` + `result` Promise
   - Mocked `createPackLoader().load()` returns a synthetic pack
   - Harness's `deps.dispatch` is invoked with corpus inputs, returns a normalized envelope
   - Budget exceeded → `cancel()` called, `dispatch_outcome: 'budget-exceeded'`

9. **Backward-compatible**: existing unit tests for both harnesses must continue passing. Synthetic-deps tests (the ones that pass canned envelopes via `deps.dispatch`) MUST still work — the real-dispatch implementation only kicks in when the harness is invoked without injected `dispatch` deps.

10. **Documentation updates:**
    - Update `docs/2026-05-31-epic-81-first-calibration.md`'s "What CAN still ship without 81-6" section to reflect that 81-6 is now landed.
    - Update `docs/eval-pack-upgrade-ci-setup.md` to remove the vacuous-GREEN warning headers.
    - Update `.github/workflows/eval-pack-upgrade.yml`'s header comment block to reflect that the dispatcher is now wired.
    - Update `scripts/eval-pack-upgrade/harness.mjs` header comment (currently says "PRODUCTION DISPATCH WIRING IS DEFERRED") to reflect the new wiring.
    - Same comment-cleanup for `scripts/eval-reconstruction/harness.mjs`.

11. **No behavior change to substrate's production dispatch path.** This story adds new code; it does NOT modify how the implementation orchestrator dispatches stories. If AC2 adds a `methodologyPack?` option to `CreateDispatcherOptions`, all existing call sites that don't pass it continue working unchanged. The eval harnesses are the only new callers that use the option.

12. **Ship gate stays GREEN.** Full `npm run build`, `npm run test:fast` (10000+ tests), and `node scripts/eval-outcomes.mjs --threshold 0.95` must all stay GREEN. No regressions to Epic 77's existing tests, no regressions to Epic 81's 81-1/81-2/81-3/81-4 tests.

## Tasks / Subtasks

- [ ] **Task 1 — Audit + design** (AC1, AC2)
  - [ ] Read `packages/core/src/dispatch/types.ts` and `packages/core/src/dispatch/dispatcher-impl.ts` to understand `Dispatcher`, `DispatchRequest`, `DispatchResult`, and `createDispatcher`
  - [ ] Read `src/modules/compiled-workflows/dev-story.ts` (`runDevStory`) to understand how production substrate assembles dev-story prompts from the pack and dispatches them
  - [ ] Decide between (a) reusing `runDevStory` directly (cleanest, but requires constructing all of WorkflowDeps) or (b) factoring out a shared prompt-assembly helper. Document the decision in Dev Notes.
  - [ ] If pack-override is needed at the dispatcher layer (per AC2), design the additive option (forward-only)

- [ ] **Task 2 — Add pack-override to `CreateDispatcherOptions`** (AC2, only if needed)
  - [ ] If audit determined the option is necessary: add `methodologyPack?: MethodologyPack` to `CreateDispatcherOptions` in `packages/core/src/dispatch/types.ts`
  - [ ] Wire it through `DispatcherImpl` (constructor + dispatch paths) so when set, it overrides the default pack resolution
  - [ ] Update `packages/core/src/dispatch/dispatcher-impl.ts` accordingly
  - [ ] Add unit tests for the override behavior

- [ ] **Task 3 — Extract or reuse prompt-assembly** (AC3, AC4)
  - [ ] If reusing `runDevStory`: build a minimal `WorkflowDeps` factory for the eval harness (in-memory db adapter, minimal contextCompiler, the loaded pack, the constructed dispatcher, etc.)
  - [ ] If factoring out: create `src/modules/compiled-workflows/assemble-dev-story-prompt.ts` exporting a pure function `assembleDevStoryPrompt(pack, storyContent, options) → AssembledPrompt`. Update `runDevStory` to call it. Update the harness to call it too.
  - [ ] Co-locate unit tests for the extracted helper

- [ ] **Task 4 — Wire production `deps.dispatch` in pack-upgrade harness** (AC3, AC5, AC6)
  - [ ] Update `scripts/eval-pack-upgrade/harness.mjs` main() to construct a real dispatcher
  - [ ] Replace the throwing stub with a real implementation per AC3
  - [ ] Wire auth detection (OAuth local / API key CI) per AC5
  - [ ] Wire `cancel()` on budget exceeded per AC6

- [ ] **Task 5 — Wire production `deps.dispatch` in reconstruction harness** (AC4, AC5, AC6)
  - [ ] Mirror Task 4 changes in `scripts/eval-reconstruction/harness.mjs`
  - [ ] Same dispatcher construction, same auth detection, same cancel-on-budget

- [ ] **Task 6 — Unit tests** (AC8, AC9)
  - [ ] Mock-based dispatch tests in `scripts/eval-pack-upgrade/__tests__/harness.test.ts` and `scripts/eval-reconstruction/__tests__/harness.test.ts`
  - [ ] Cover: synthetic envelope return, budget exceeded, dispatcher throws, pack load failure
  - [ ] Ensure existing synthetic-deps tests continue passing

- [ ] **Task 7 — Integration test** (AC7)
  - [ ] Create `scripts/eval-pack-upgrade/__tests__/integration.test.ts`
  - [ ] Gated on `SUBSTRATE_EVAL_INTEGRATION=1` env var
  - [ ] Runs ONE pair against a real model (max-turns 5, budget $0.50)
  - [ ] Asserts: envelope returned, dispatch_outcome 'completed', total_tokens > 0
  - [ ] Documents the command + expected runtime + cost in the test file header

- [ ] **Task 8 — Documentation updates** (AC10)
  - [ ] Update `docs/2026-05-31-epic-81-first-calibration.md`
  - [ ] Update `docs/eval-pack-upgrade-ci-setup.md`
  - [ ] Update `.github/workflows/eval-pack-upgrade.yml` header comment
  - [ ] Update both harness file header comments

- [ ] **Task 9 — Regression validation** (AC11, AC12)
  - [ ] `npm run build`
  - [ ] `npm run test:fast` — all tests pass (10000+, including new ones)
  - [ ] `node scripts/eval-outcomes.mjs --threshold 0.95` — GREEN
  - [ ] Smoke: `node scripts/eval-pack-upgrade.mjs --pack-current packs/bmad --pack-candidate packs/bmad --corpus _bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml --format plain --dry-run` exits 0
  - [ ] Existing Epic 77 + 81 stories continue to pass their dispatched-verification gates

## Dev Notes

### Why this story exists

Epic 81's Phase 4 capability validation (the deliberate-regression test) cannot run while `deps.dispatch` is a stub. Both Story 77-8 (reconstruction) and Story 81-2 (pack-upgrade) chose to defer this wiring as out of scope. This story collects the deferred work into a single dedicated ship.

Per `docs/2026-05-31-epic-81-first-calibration.md`, this story unblocks BOTH eval tiers in one go.

### Design decision: how to call into substrate dispatch

Two viable paths:

**Path A — Reuse `runDevStory` directly.** Pros: production-fidelity prompt assembly, no duplication. Cons: need to construct WorkflowDeps (db, contextCompiler, dispatcher, projectRoot, parentProjectRoot, tokenCeilings, otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId) — most of these can be minimal but it's still meaningful glue.

**Path B — Factor out a shared prompt-assembly helper.** Pros: clean separation, the eval harness can construct a minimal prompt without full orchestrator deps. Cons: requires modifying `runDevStory` to call the new helper (touch-point in production dispatch path); refactor risk.

The dispatched dev agent chooses based on the audit. Both are acceptable. Document the choice + rationale in Dev Notes completion.

### Why an additive `methodologyPack?` option (AC2)

`createDispatcher` in `packages/core/src/dispatch/dispatcher-impl.ts:1089` currently accepts `eventBus`, `adapterRegistry`, `config`, `logger?`, `normalizer?`. It does NOT take a pack — the pack is consumed at prompt-assembly time, before dispatch.

This means AC2 might not be necessary IF the eval harness assembles the prompt itself (Path B above). If it goes via `runDevStory` (Path A), the pack is passed as part of WorkflowDeps and the dispatcher itself doesn't need to know about it.

The dispatched dev agent should determine whether AC2 is necessary based on the chosen Path. If AC2 turns out to be unnecessary, mark it complete with "N/A — pack handled at prompt-assembly layer, not dispatcher layer; see Dev Notes."

### Auth wiring detail

Substrate's Claude Code adapter uses OAuth session by default. The session is cached in `~/.claude/...` and discovered by the adapter automatically. For CI, the path is `ANTHROPIC_API_KEY` env var (per Story 81-5).

The eval harness's auth detection logic:
```javascript
if (process.env.GITHUB_ACTIONS === 'true') {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for CI dispatch — see docs/eval-pack-upgrade-ci-setup.md')
  }
  // pass API key through to adapter
} else {
  // local: rely on Claude Code OAuth session, no explicit wiring needed
}
```

This is similar to how the production orchestrator handles auth — reuse that pattern if possible.

### Canonical Import Paths

| Helper | Import path |
|---|---|
| `createDispatcher`, `Dispatcher`, `DispatchRequest`, `DispatchResult` | `@substrate-ai/core/dispatch/dispatcher-impl.js` (or via `packages/core/dist/dispatch/index.js`) |
| `createPackLoader`, `MethodologyPack` | `src/modules/methodology-pack/pack-loader.ts` |
| `runDevStory` | `src/modules/compiled-workflows/dev-story.ts` |
| `WorkflowDeps`, `DevStoryParams`, `DevStoryResult` | `src/modules/compiled-workflows/types.ts` |
| `IAdapterRegistry` | `packages/core/src/adapters/types.ts` (or registry impl) |
| Event bus | `packages/core/src/events/...` |

### Reference Files (read for context, don't modify unless explicitly in scope)

| File | Purpose |
|---|---|
| `scripts/eval-pack-upgrade/harness.mjs` | Pack-upgrade harness (stub to replace at lines 469-482) |
| `scripts/eval-reconstruction/harness.mjs` | Reconstruction harness (stub to replace at lines 435-444) |
| `packages/core/src/dispatch/dispatcher-impl.ts` | Dispatcher implementation |
| `packages/core/src/dispatch/types.ts` | Dispatcher interfaces |
| `src/modules/compiled-workflows/dev-story.ts` | Production dev-story workflow (~600 LOC) |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts:2920-2950` | Reference for how `runDevStory` is invoked in production with full WorkflowDeps |
| `src/modules/methodology-pack/pack-loader.ts` | Pack loader (path-parameterized) |

### Testing Requirements

- Framework: **vitest**
- Unit tests use mocked dispatcher + pack-loader; NO live model calls
- Integration test (AC7) gated on `SUBSTRATE_EVAL_INTEGRATION=1`; runs against real model with small budget cap
- All non-integration tests must run in `npm run test:fast` (no incremental time impact > 5s)

## Interface Contracts

- **Output envelope shape**: contracted with 81-3's grader (unchanged — `dispatch_outcome | diff | total_turns | total_tokens | verdict | recovery_history | duration_seconds | cost_usd | error_detail`)
- **AC2's `methodologyPack?` option** (if added): forward-only schema addition to `CreateDispatcherOptions` (backward-compat preserved)
- **Auth contract**: API-key auth via `ANTHROPIC_API_KEY` env in CI; OAuth session locally. Document any environment dependencies in the harness file header.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
