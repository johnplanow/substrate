# Story 65-2: probe-author dispatch ramp-DOWN feature flag for state-integrating ACs

## Story

As an operator,
I want a CLI flag and env var to disable probe-author dispatch for state-integrating ACs independently of event-driven dispatch,
so that I can ramp DOWN the Phase 3 state-integrating feature on demand if the catch rate drops below the GREEN threshold without modifying substrate source code.

## Acceptance Criteria

<!-- source-ac-hash: 8020c4646838eb963cdeca4a97078ba771cae3efc68bd2f9411049cc28cd6e7c -->

### AC1: CLI flag `--probe-author-state-integrating=on|off`

New CLI flag `--probe-author-state-integrating=on|off` on `substrate run` (passed through to OrchestratorImpl). Default `on` (matches the GREEN eval verdict — Phase 3 ramp authorized).

### AC2: Env var `SUBSTRATE_PROBE_AUTHOR_STATE_INTEGRATING=on|off`

New env var `SUBSTRATE_PROBE_AUTHOR_STATE_INTEGRATING=on|off` as secondary override. CLI flag takes precedence when both are set. Defaults to `on` when env var is unset and CLI flag absent.

### AC3: Gate behaviour when `off`

When set to `off`, the orchestrator's probe-author dispatch gate skips the `detectsStateIntegratingAC()` branch — only `detectsEventDrivenAC()` is checked. Existing event-driven dispatches MUST be unchanged (regression-test guarded).

### AC4: Tests

Tests: unit test asserting flag/env-var resolution semantics (CLI > env > default), plus an orchestrator-integration test asserting that state-integrating-only ACs do NOT dispatch probe-author when flag is `off` (and DO dispatch when on).

### AC5: Help text

Help text on `substrate run --help` documents the flag's purpose: "Disable probe-author dispatch for state-integrating ACs (Phase 3). Use to ramp DOWN if catch rate drops below the GREEN threshold."

## Tasks / Subtasks

- [ ] Task 1: Add `probeAuthorStateIntegrating` field to `OrchestratorConfig` (AC: #1, #2, #3)
  - [ ] In `src/modules/implementation-orchestrator/types.ts`, add `probeAuthorStateIntegrating?: boolean` to `OrchestratorConfig` with a JSDoc explaining: `true` = dispatch state-integrating ACs (default); `false` = skip `detectsStateIntegratingAC()` branch, only event-driven checked
  - [ ] Field defaults to `undefined` / `true` (enabled) when absent — no breaking change to existing callers

- [ ] Task 2: Add CLI flag and env-var resolution in `run.ts` (AC: #1, #2, #5)
  - [ ] Add `--probe-author-state-integrating <value>` option to the `substrate run` commander definition (line ~2672 near the existing `--probe-author` option), type `'on' | 'off'`, default `'on'`, with help text per AC5
  - [ ] In the run-command options interface (`RunOptions` or equivalent, line ~1939), add `probeAuthorStateIntegrating?: 'on' | 'off'`
  - [ ] Implement precedence resolver (inline or extracted helper): CLI flag (`on`/`off`) > env var `SUBSTRATE_PROBE_AUTHOR_STATE_INTEGRATING` (`on`/`off`) > default `on`; resolve to `boolean` (`true` for `on`, `false` for `off`)
  - [ ] Pass resolved boolean into `OrchestratorConfig` as `probeAuthorStateIntegrating` when constructing config (follow pattern of `probeAuthorMode` at lines ~888, ~1671, ~2369)
  - [ ] Add input validation: reject values other than `on` / `off` with a clear error message (mirror `probeAuthor` validation at line ~593)

- [ ] Task 3: Modify the probe-author dispatch gate in `orchestrator-impl.ts` (AC: #3)
  - [ ] Read `config.probeAuthorStateIntegrating` inside the per-story probe-author gate (line ~2261); when `false`, replace the combined `||` check with `detectsEventDrivenAC(...)` only
  - [ ] Conditional logic shape:
    ```ts
    const stateIntegratingEnabled = config.probeAuthorStateIntegrating !== false
    if (detectsEventDrivenAC(probeAuthorEpicContent) ||
        (stateIntegratingEnabled && detectsStateIntegratingAC(probeAuthorEpicContent))) {
    ```
  - [ ] Verify the same flag propagation in the `RunProbeAuthorParams` call if `probe-author-integration.ts` duplicates the gate (line ~166 in that file); add a `stateIntegratingEnabled?: boolean` parameter to `RunProbeAuthorParams` and honour it in `runProbeAuthor` to keep the two gates in sync

- [ ] Task 4: Write unit and integration tests (AC: #4, #3)
  - [ ] **Unit test — flag/env-var resolution semantics** in a new or existing test file (e.g., `src/cli/commands/__tests__/run-probe-author-state-integrating.test.ts`):
    - CLI `on` with env `off` → resolves `true` (CLI wins)
    - CLI `off` with env `on` → resolves `false` (CLI wins)
    - CLI absent, env `off` → resolves `false`
    - CLI absent, env `on` → resolves `true`
    - CLI absent, env absent → resolves `true` (default)
  - [ ] **Orchestrator-integration test** in `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts` or a new sibling file:
    - State-integrating-only AC (non-event-driven, state-integrating) + flag `off` → probe-author NOT dispatched
    - State-integrating-only AC + flag `on` → probe-author dispatched (positive case)
  - [ ] **Regression test**: event-driven AC + flag `off` → probe-author STILL dispatched (event-driven gate unaffected)

## Dev Notes

### Architecture Constraints

- Follow the existing `--probe-author` flag pattern in `src/cli/commands/run.ts` — option definition, options interface field, validation block, config propagation. The new flag is a *sibling*, not a replacement.
- `OrchestratorConfig` lives in `src/modules/implementation-orchestrator/types.ts` — add the new field there, not inline in `orchestrator-impl.ts`.
- The gate exists in **two places**: `orchestrator-impl.ts` line ~2261 (outer gate) and `probe-author-integration.ts` line ~166 (inner gate in `runProbeAuthor`). Both must be consistent; the inner gate receives its value via `RunProbeAuthorParams`, not by re-reading `config` directly.
- Env var name: `SUBSTRATE_PROBE_AUTHOR_STATE_INTEGRATING` (exact, per AC2).
- Flag name: `--probe-author-state-integrating` (exact, per AC1).
- `detectsStateIntegratingAC` is imported from `@substrate-ai/sdlc` — already imported in `probe-author-integration.ts` at line 21; `orchestrator-impl.ts` also imports it at line 70.

### Testing Requirements

- Test framework: Vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`).
- Flag resolution is pure logic (process.env + parsed CLI arg → boolean); test it without instantiating the full orchestrator.
- For the orchestrator-integration tests, follow the mock pattern in `probe-author-integration.test.ts`: mock `WorkflowDeps`, `Dispatcher`, `MethodologyPack`, `ContextCompiler`, and `DatabaseAdapter`; drive `runProbeAuthor` directly with controlled `epicContent` and the new `stateIntegratingEnabled` param.
- Use `STATE_INTEGRATING_EPIC_CONTENT` (fixture with state-integrating language but no event-driven hooks) to drive the state-integrating gate branch — complement the existing `EVENT_DRIVEN_EPIC_CONTENT` fixture in the same test file.
- After all changes, run `npm run test:fast` to verify no regressions.

### File List (expected changes)

| File | Change |
|---|---|
| `src/modules/implementation-orchestrator/types.ts` | Add `probeAuthorStateIntegrating?: boolean` to `OrchestratorConfig` |
| `src/cli/commands/run.ts` | Add flag, env-var resolution, validation, config propagation |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Modify gate condition (~line 2261) |
| `src/modules/implementation-orchestrator/probe-author-integration.ts` | Add `stateIntegratingEnabled?: boolean` param to `RunProbeAuthorParams`; honour in gate (~line 166) |
| `src/modules/implementation-orchestrator/__tests__/probe-author-integration.test.ts` | Add state-integrating gate tests + regression test |
| `src/cli/commands/__tests__/run-probe-author-state-integrating.test.ts` *(new)* | Unit tests for flag/env-var resolution semantics |

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
