# Story 72-1: --halt-on flag + Decision Router

## Story

As a pipeline operator,
I want a `--halt-on` CLI flag and a Decision Router module that classifies every halt-able decision by severity and enforces the chosen autonomy policy,
so that I can tune how much human oversight the orchestrator requires — from fully autonomous to always-halt — without modifying code.

## Acceptance Criteria

<!-- source-ac-hash: 1635c51fe12689a11970e56785ec5da8690d9ad6d7a284b90c5a42ac26396a34 -->

1. New module `src/modules/decision-router/index.ts` exporting
   `routeDecision(decision, policy)` (pure function returning
   `{ halt: boolean, defaultAction: string, severity: Severity }`),
   `Severity` type (`'info' | 'warning' | 'critical' | 'fatal'`),
   and `DecisionType` union covering all halt-able decisions.

2. CLI flag `--halt-on <all|critical|none>` registered on
   `substrate run` command at `src/cli/commands/run.ts` (or wherever
   `run` command is defined; consult that file for flag-registration
   pattern). Default value: `critical`.

3. **Decision classification table** (exported constant
   `DECISION_SEVERITY_MAP`):
   - `cost-ceiling-exhausted`: critical
   - `build-verification-failure`: critical
   - `recovery-retry-attempt`: info
   - `re-scope-proposal`: warning
   - `scope-violation`: fatal
   - `cross-story-race-recovered`: info (Epic 70 — log only, no halt)
   - `cross-story-race-still-failed`: critical (Epic 70 — recovery
     exhausted, halt for operator)

4. **Halt policy logic** (in `routeDecision`):
   - `--halt-on all`: halts on `info` AND `warning` AND `critical`
     AND `fatal` decisions
   - `--halt-on critical` (default): halts on `critical` AND `fatal`
   - `--halt-on none`: halts ONLY on `fatal` (scope violations
     bypass the autonomy-gradient policy — they are always halts)

5. **Default-action propagation**: when a decision does NOT halt,
   `routeDecision` returns the `defaultAction` string (e.g.,
   `'retry-with-context'`, `'continue-autonomous'`,
   `'escalate-without-halt'`). Caller invokes the default action.

6. **CRITICAL: use canonical helpers for state access** (per Story
   69-2 / 71-2 lesson — 3 prior incidents from invented manifest
   formats):
   - Read run state via `RunManifest` class from
     `@substrate-ai/sdlc/run-model/run-manifest.js`
   - Run-id resolution via `manifest-read.ts` helpers
     (`resolveRunManifest`, `readCurrentRunId`)
   - Latest-run fallback via `getLatestRun(adapter)` from
     `packages/core/src/persistence/queries/decisions.ts`
   - Persistence via existing `DoltClient` from
     `src/modules/state/index.ts`
   - **Do NOT introduce new aggregate manifest formats.**

7. New event types declared in `packages/core/src/events/core-events.ts`
   AND mirrored in `src/core/event-bus.types.ts` `OrchestratorEvents`
   per Story 66-4 typecheck:gate discipline:
   - `decision:halt` — `{ runId, decisionType, severity, reason }`
   - `decision:autonomous` — `{ runId, decisionType, severity,
     defaultAction, reason }`

8. Orchestrator integration: every existing halt decision in
   `src/modules/implementation-orchestrator/orchestrator-impl.ts`
   replaced with `await routeDecision(...)` invocation. If `halt:
   true` returned, orchestrator yields control to the prompt path
   (existing behavior); else applies `defaultAction`.

9. Tests at `src/modules/decision-router/__tests__/index.test.ts`
   (≥6 cases): (a) `--halt-on critical` halts on cost-ceiling and
   build-failure; (b) `--halt-on none` proceeds autonomously on
   `info` and `warning`; (c) `--halt-on all` halts on every decision;
   (d) scope-violation halts regardless of policy; (e) unknown
   decision type returns severity `critical` (safe default); (f)
   default-action propagation correctness.

10. **Header comment** in implementation file cites Phase D Story
    54-2 (original 2026-04-05 spec) + Epic 70 (`cross-story-race`
    decision types added by Epic 70 motivate the registry pattern)
    + that Epic 73 (Recovery Engine) will register additional
    decision types.

11. **No package additions**: implementation must use existing deps.

**Files involved:**
- `src/modules/decision-router/index.ts` (NEW)
- `src/modules/decision-router/__tests__/index.test.ts` (NEW)
- `src/cli/commands/run.ts` (or equivalent — register `--halt-on` flag)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (consume Decision Router)
- `packages/core/src/events/core-events.ts` (new event types)
- `src/core/event-bus.types.ts` (mirror event types)

## Tasks / Subtasks

- [ ] Task 1: Create Decision Router module with pure-function core (AC: #1, #3, #4, #5, #10, #11)
  - [ ] Create `src/modules/decision-router/index.ts` with header comment citing Story 54-2, Epic 70, Epic 73
  - [ ] Define `Severity` type (`'info' | 'warning' | 'critical' | 'fatal'`)
  - [ ] Define `DecisionType` union covering all 7 halt-able decision keys (cost-ceiling-exhausted, build-verification-failure, recovery-retry-attempt, re-scope-proposal, scope-violation, cross-story-race-recovered, cross-story-race-still-failed)
  - [ ] Export `DECISION_SEVERITY_MAP` constant mapping each `DecisionType` to its `Severity`
  - [ ] Implement `routeDecision(decision, policy)` pure function returning `{ halt: boolean, defaultAction: string, severity: Severity }` with correct policy logic (all/critical/none) and fatal-always-halts invariant
  - [ ] Map default actions per decision type (e.g., `recovery-retry-attempt` → `'continue-autonomous'`, `re-scope-proposal` → `'escalate-without-halt'`)
  - [ ] Handle unknown decision type by defaulting to severity `critical` (safe default)

- [ ] Task 2: Declare new event types in core package and mirror in monolith (AC: #7)
  - [ ] Add `decision:halt` event type (`{ runId: string, decisionType: string, severity: string, reason: string }`) to `packages/core/src/events/core-events.ts`
  - [ ] Add `decision:autonomous` event type (`{ runId: string, decisionType: string, severity: string, defaultAction: string, reason: string }`) to `packages/core/src/events/core-events.ts`
  - [ ] Mirror both event types in `src/core/event-bus.types.ts` `OrchestratorEvents` interface (per Story 66-4 typecheck:gate discipline)

- [ ] Task 3: Update CLI flag registration on `substrate run` (AC: #2)
  - [ ] Locate the existing `--halt-on` option registration in `src/cli/commands/run.ts` (currently line ~2757 with default `'none'`)
  - [ ] Update the flag definition to `--halt-on <all|critical|none>` with description and default value `'critical'` per AC2
  - [ ] Verify the `halt_on` value propagates correctly to `manifest.cli_flags.halt_on` used in the orchestrator

- [ ] Task 4: Integrate Decision Router into orchestrator (AC: #6, #8)
  - [ ] Import `routeDecision`, `DecisionType` from `src/modules/decision-router/index.ts` in `orchestrator-impl.ts`
  - [ ] Identify every existing halt-decision point in `orchestrator-impl.ts` (at minimum: `handleCeilingExceeded`, build verification failure, recovery retry, re-scope/scope-violation paths)
  - [ ] Replace each direct halt check with a `routeDecision(decisionType, policy)` call; read policy from `manifest.cli_flags.halt_on`
  - [ ] Emit `decision:halt` event when `halt: true`; emit `decision:autonomous` event when `halt: false`
  - [ ] When `halt: false`, apply `defaultAction` from the returned object (instead of prompting operator)
  - [ ] Ensure canonical state helpers are used per AC6 (no new manifest formats)

- [ ] Task 5: Write unit tests for Decision Router (AC: #9)
  - [ ] Create `src/modules/decision-router/__tests__/index.test.ts`
  - [ ] Case (a): `--halt-on critical` halts on `cost-ceiling-exhausted` and `build-verification-failure`
  - [ ] Case (b): `--halt-on none` does NOT halt on `info` (`recovery-retry-attempt`) and `warning` (`re-scope-proposal`)
  - [ ] Case (c): `--halt-on all` halts on all severity tiers (info, warning, critical, fatal)
  - [ ] Case (d): `scope-violation` halts regardless of policy (`critical`, `none`, `all`)
  - [ ] Case (e): unknown decision type defaults to severity `critical` and halts on `critical`/`all` policies
  - [ ] Case (f): when `halt: false`, the returned `defaultAction` string matches the expected default for that decision type

## Dev Notes

### Architecture Constraints
- **No new dependencies**: all implementation MUST use existing deps only (AC11)
- **Canonical state access**: read run state via `RunManifest` from `@substrate-ai/sdlc/run-model/run-manifest.js`; run-id via `resolveRunManifest`/`readCurrentRunId` from `manifest-read.ts`; latest-run fallback via `getLatestRun(adapter)` from `packages/core/src/persistence/queries/decisions.ts`; persistence via `DoltClient` from `src/modules/state/index.ts`. Do NOT invent new aggregate manifest formats (AC6)
- **Event dual-declaration discipline (Story 66-4)**: new event types go in BOTH `packages/core/src/events/core-events.ts` AND `src/core/event-bus.types.ts` `OrchestratorEvents`. Missing one causes typecheck:gate failures
- **Pure function first**: `routeDecision` is a pure function — no I/O, no side effects. All orchestrator state interactions remain in `orchestrator-impl.ts`
- **Fatal always halts**: the `scope-violation: fatal` invariant must hold regardless of the `--halt-on` policy value. This is a hard safety invariant, not configurable
- **`--halt-on` default change**: the existing `--halt-on` option in `run.ts` currently defaults to `'none'`. AC2 specifies default `'critical'` — update it; this is a behavioral change for existing users

### Key File Patterns
- **Flag registration pattern** (see `src/cli/commands/run.ts` lines 2727–2760): `.option('--flag-name <value>', 'description', defaultValue)`; commander parses `halt-on` → `haltOn` in opts but the manifest stores it as `halt_on` (snake_case)
- **Event types location**: `packages/core/src/events/core-events.ts` defines `CoreEvents` interface; `src/core/event-bus.types.ts` defines `OrchestratorEvents` interface — new events go in both
- **Orchestrator halt-decision sites**: search `orchestrator-impl.ts` for `haltOn`, `halt_on`, and existing cost-ceiling/build-failure conditional branches — these are the integration points for AC8
- **Test framework**: Vitest — see existing test files in `src/modules/*/___tests__/` for patterns

### Testing Requirements
- **Test file**: `src/modules/decision-router/__tests__/index.test.ts`
- **≥6 test cases** per AC9 covering all policy × severity combinations, the fatal-always-halts invariant, unknown-type safe default, and default-action propagation
- **Pure unit tests only**: `routeDecision` has no I/O; no mocking needed
- Run with `npm run test:fast` during iteration; confirm "Test Files" appears in output

## Interface Contracts

- **Export**: `Severity` type @ `src/modules/decision-router/index.ts` (consumed by orchestrator-impl.ts and future Epic 73 Recovery Engine)
- **Export**: `DecisionType` union @ `src/modules/decision-router/index.ts` (consumed by orchestrator-impl.ts and future Epic 73 Recovery Engine)
- **Export**: `DECISION_SEVERITY_MAP` @ `src/modules/decision-router/index.ts` (consumed by orchestrator-impl.ts; Epic 73 will extend)
- **Export**: `routeDecision` function @ `src/modules/decision-router/index.ts` (consumed by orchestrator-impl.ts; from story 72-1)
- **Export**: `decision:halt` event type @ `packages/core/src/events/core-events.ts` (mirrored in `src/core/event-bus.types.ts`)
- **Export**: `decision:autonomous` event type @ `packages/core/src/events/core-events.ts` (mirrored in `src/core/event-bus.types.ts`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

## Runtime Probes

```yaml
- name: decision-router-built-artifact-exists
  sandbox: host
  command: |
    test -f dist/src/modules/decision-router/index.js && echo "FILE_EXISTS" || { echo "FILE_MISSING"; exit 1; }
  description: compiled decision-router module exists at dist/src/modules/decision-router/index.js after build
  expect_stdout_regex:
    - FILE_EXISTS
  _authoredBy: probe-author
- name: decision-router-exports-required-symbols
  sandbox: host
  command: |
    node --input-type=module --eval "
      const m = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const errors = [];
      if (typeof m.routeDecision !== 'function') errors.push('routeDecision not a function');
      if (typeof m.DECISION_SEVERITY_MAP !== 'object' || m.DECISION_SEVERITY_MAP === null) errors.push('DECISION_SEVERITY_MAP not an object');
      if (errors.length) { console.error('FAIL: ' + errors.join(', ')); process.exit(1); }
      console.log('EXPORTS_OK');
    " 2>&1
  description: decision-router exports routeDecision (function) and DECISION_SEVERITY_MAP (object) per AC1
  expect_stdout_regex:
    - EXPORTS_OK
  _authoredBy: probe-author
- name: severity-map-all-seven-decisions-correct
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { DECISION_SEVERITY_MAP } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const expected = {
        'cost-ceiling-exhausted': 'critical',
        'build-verification-failure': 'critical',
        'recovery-retry-attempt': 'info',
        're-scope-proposal': 'warning',
        'scope-violation': 'fatal',
        'cross-story-race-recovered': 'info',
        'cross-story-race-still-failed': 'critical',
      };
      const errors = [];
      for (const [k, v] of Object.entries(expected)) {
        if (DECISION_SEVERITY_MAP[k] !== v) {
          errors.push(k + ': expected ' + v + ' got ' + DECISION_SEVERITY_MAP[k]);
        }
      }
      if (errors.length) { console.error('MISMATCH:\\n' + errors.join('\\n')); process.exit(1); }
      console.log('SEVERITY_MAP_OK');
    " 2>&1
  description: DECISION_SEVERITY_MAP has all 7 decision types with correct severities per AC3
  expect_stdout_regex:
    - SEVERITY_MAP_OK
  _authoredBy: probe-author
- name: halt-on-flag-registered-with-critical-default
  sandbox: host
  command: |
    npm run --silent substrate:dev -- run --help 2>&1
  timeout_ms: 30000
  description: substrate run --help shows --halt-on flag and critical as default value per AC2
  expect_stdout_regex:
    - '--halt-on'
    - critical
  _authoredBy: probe-author
- name: critical-policy-halts-on-cost-ceiling-exhausted
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const result = routeDecision('cost-ceiling-exhausted', 'critical');
      if (!result.halt) { console.error('FAIL: expected halt=true for cost-ceiling-exhausted under critical policy'); process.exit(1); }
      if (result.severity !== 'critical') { console.error('FAIL: expected severity=critical got ' + result.severity); process.exit(1); }
      console.log('CRITICAL_POLICY_COST_CEILING_HALT_OK');
    " 2>&1
  description: routeDecision('cost-ceiling-exhausted', 'critical') returns halt=true, severity=critical per AC4 / AC9a
  expect_stdout_regex:
    - CRITICAL_POLICY_COST_CEILING_HALT_OK
  _authoredBy: probe-author
- name: critical-policy-halts-on-build-verification-failure
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const result = routeDecision('build-verification-failure', 'critical');
      if (!result.halt) { console.error('FAIL: expected halt=true for build-verification-failure under critical policy'); process.exit(1); }
      if (result.severity !== 'critical') { console.error('FAIL: expected severity=critical got ' + result.severity); process.exit(1); }
      console.log('CRITICAL_POLICY_BUILD_FAIL_HALT_OK');
    " 2>&1
  description: routeDecision('build-verification-failure', 'critical') returns halt=true per AC9a
  expect_stdout_regex:
    - CRITICAL_POLICY_BUILD_FAIL_HALT_OK
  _authoredBy: probe-author
- name: none-policy-no-halt-on-info-and-warning
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const info = routeDecision('recovery-retry-attempt', 'none');
      if (info.halt) { console.error('FAIL: recovery-retry-attempt (info) must NOT halt under none policy'); process.exit(1); }
      const warn = routeDecision('re-scope-proposal', 'none');
      if (warn.halt) { console.error('FAIL: re-scope-proposal (warning) must NOT halt under none policy'); process.exit(1); }
      console.log('NONE_POLICY_NO_HALT_INFO_OK severity=' + info.severity);
      console.log('NONE_POLICY_NO_HALT_WARN_OK severity=' + warn.severity);
    " 2>&1
  description: routeDecision with none policy does not halt on info or warning decisions per AC4 / AC9b
  expect_stdout_regex:
    - NONE_POLICY_NO_HALT_INFO_OK severity=info
    - NONE_POLICY_NO_HALT_WARN_OK severity=warning
  _authoredBy: probe-author
- name: all-policy-halts-on-info-and-warning
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const info = routeDecision('recovery-retry-attempt', 'all');
      if (!info.halt) { console.error('FAIL: recovery-retry-attempt (info) MUST halt under all policy'); process.exit(1); }
      const warn = routeDecision('re-scope-proposal', 'all');
      if (!warn.halt) { console.error('FAIL: re-scope-proposal (warning) MUST halt under all policy'); process.exit(1); }
      const crit = routeDecision('cost-ceiling-exhausted', 'all');
      if (!crit.halt) { console.error('FAIL: cost-ceiling-exhausted (critical) MUST halt under all policy'); process.exit(1); }
      console.log('ALL_POLICY_HALTS_ALL_TIERS_OK');
    " 2>&1
  description: routeDecision with all policy halts on info, warning, and critical decisions per AC4 / AC9c
  expect_stdout_regex:
    - ALL_POLICY_HALTS_ALL_TIERS_OK
  _authoredBy: probe-author
- name: fatal-scope-violation-always-halts-regardless-of-policy
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const policies = ['none', 'critical', 'all'];
      for (const policy of policies) {
        const result = routeDecision('scope-violation', policy);
        if (!result.halt) {
          console.error('FAIL: scope-violation must halt under policy=' + policy + ' (fatal always halts invariant)');
          process.exit(1);
        }
        if (result.severity !== 'fatal') {
          console.error('FAIL: scope-violation must have severity=fatal under policy=' + policy + ', got ' + result.severity);
          process.exit(1);
        }
      }
      console.log('SCOPE_VIOLATION_ALWAYS_HALTS_OK');
    " 2>&1
  description: scope-violation (fatal) halts under all three policies — fatal-always-halts invariant per AC4 / AC9d
  expect_stdout_regex:
    - SCOPE_VIOLATION_ALWAYS_HALTS_OK
  _authoredBy: probe-author
- name: none-policy-still-halts-on-fatal
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const result = routeDecision('scope-violation', 'none');
      if (!result.halt) {
        console.error('FAIL: none policy must still halt on fatal (scope-violation bypasses autonomy-gradient)');
        process.exit(1);
      }
      console.log('NONE_POLICY_HALTS_FATAL_OK');
    " 2>&1
  description: none policy halts ONLY on fatal (scope-violation) — fatal bypasses the autonomy-gradient per AC4
  expect_stdout_regex:
    - NONE_POLICY_HALTS_FATAL_OK
  _authoredBy: probe-author
- name: unknown-decision-type-defaults-to-critical-severity
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      const result = routeDecision('totally-unknown-future-decision-xyz', 'critical');
      if (result.severity !== 'critical') {
        console.error('FAIL: unknown type must default to critical severity (safe default), got ' + result.severity);
        process.exit(1);
      }
      if (!result.halt) {
        console.error('FAIL: unknown type defaults to critical severity, so critical policy should halt');
        process.exit(1);
      }
      console.log('UNKNOWN_TYPE_DEFAULTS_CRITICAL_OK');
    " 2>&1
  description: unknown decision type returns severity=critical (safe default) and halts under critical policy per AC9e
  expect_stdout_regex:
    - UNKNOWN_TYPE_DEFAULTS_CRITICAL_OK
  _authoredBy: probe-author
- name: default-action-propagated-when-no-halt
  sandbox: host
  command: |
    node --input-type=module --eval "
      const { routeDecision } = await import(`${process.cwd()}/dist/src/modules/decision-router/index.js`);
      // recovery-retry-attempt (info) does NOT halt under critical policy — defaultAction must be returned
      const infoResult = routeDecision('recovery-retry-attempt', 'critical');
      if (infoResult.halt) { console.error('FAIL: recovery-retry-attempt should not halt under critical policy'); process.exit(1); }
      if (!infoResult.defaultAction || typeof infoResult.defaultAction !== 'string' || infoResult.defaultAction.trim() === '') {
        console.error('FAIL: defaultAction must be a non-empty string when halt=false, got: ' + JSON.stringify(infoResult.defaultAction));
        process.exit(1);
      }
      // cross-story-race-recovered (info) does NOT halt under critical policy either
      const raceResult = routeDecision('cross-story-race-recovered', 'critical');
      if (raceResult.halt) { console.error('FAIL: cross-story-race-recovered should not halt under critical policy'); process.exit(1); }
      if (!raceResult.defaultAction || typeof raceResult.defaultAction !== 'string' || raceResult.defaultAction.trim() === '') {
        console.error('FAIL: cross-story-race-recovered defaultAction must be non-empty string when halt=false');
        process.exit(1);
      }
      console.log('DEFAULT_ACTION_RETRY: ' + infoResult.defaultAction);
      console.log('DEFAULT_ACTION_RACE: ' + raceResult.defaultAction);
      console.log('DEFAULT_ACTION_PROPAGATION_OK');
    " 2>&1
  description: routeDecision returns non-empty defaultAction string for each non-halting decision per AC5 / AC9f
  expect_stdout_regex:
    - 'DEFAULT_ACTION_RETRY: \S+'
    - 'DEFAULT_ACTION_RACE: \S+'
    - DEFAULT_ACTION_PROPAGATION_OK
  _authoredBy: probe-author
- name: event-types-declared-in-core-events
  sandbox: host
  command: |
    grep -n "decision:halt|decision:autonomous" packages/core/src/events/core-events.ts
    echo "GREP_EXIT:$?"
  description: decision:halt and decision:autonomous event types declared in packages/core/src/events/core-events.ts per AC7
  expect_stdout_regex:
    - decision:halt
    - decision:autonomous
    - GREP_EXIT:0
  _authoredBy: probe-author
- name: event-types-mirrored-in-orchestrator-event-bus
  sandbox: host
  command: |
    grep -n "decision:halt|decision:autonomous" src/core/event-bus.types.ts
    echo "GREP_EXIT:$?"
  description: >-
    decision:halt and decision:autonomous mirrored in src/core/event-bus.types.ts OrchestratorEvents per AC7 Story-66-4
    discipline
  expect_stdout_regex:
    - decision:halt
    - decision:autonomous
    - GREP_EXIT:0
  _authoredBy: probe-author
- name: orchestrator-impl-imports-route-decision
  sandbox: host
  command: |
    grep -n "routeDecision|decision-router" src/modules/implementation-orchestrator/orchestrator-impl.ts
    echo "GREP_EXIT:$?"
  description: orchestrator-impl.ts imports and invokes routeDecision from decision-router module per AC8
  expect_stdout_regex:
    - routeDecision
    - GREP_EXIT:0
  _authoredBy: probe-author
- name: header-comment-cites-story-54-2-and-epic-70-73
  sandbox: host
  command: >
    # AC10: header comment cites 54-2 + Epic 70 + Epic 73

    grep -n "54-2|Story 54" src/modules/decision-router/index.ts && echo "CITE_54_2_OK" || echo "CITE_54_2_MISSING"

    grep -n "Epic 70|70" src/modules/decision-router/index.ts | head -5 && echo "CITE_EPIC_70_OK" || echo
    "CITE_EPIC_70_MISSING"

    grep -n "Epic 73|73" src/modules/decision-router/index.ts | head -5 && echo "CITE_EPIC_73_OK" || echo
    "CITE_EPIC_73_MISSING"
  description: decision-router index.ts header comment cites Story 54-2, Epic 70, and Epic 73 per AC10
  expect_stdout_regex:
    - CITE_54_2_OK
    - CITE_EPIC_70_OK
    - CITE_EPIC_73_OK
  _authoredBy: probe-author
- name: no-new-npm-dependencies-added
  sandbox: host
  command: |
    # Verify no new runtime dependencies were added to package.json
    # AC11: implementation must use existing deps only
    node --input-type=module --eval "
      import { readFileSync } from 'fs';
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      const deps = Object.keys(pkg.dependencies || {});
      // Decision-router should not pull in any new packages — it's a pure function module
      // Check that the decision-router source file only imports from project-relative paths
      const src = readFileSync('src/modules/decision-router/index.ts', 'utf8');
      const importLines = src.split('\\n').filter(l => l.trim().startsWith('import'));
      const externalImports = importLines.filter(l => {
        // allow relative imports and known monorepo packages
        return !l.includes(\"from '.\") &&
               !l.includes('from \"./') &&
               !l.includes('@substrate-ai/') &&
               l.includes('from ');
      });
      if (externalImports.length > 0) {
        console.error('FAIL: unexpected external imports found:');
        externalImports.forEach(l => console.error('  ' + l.trim()));
        process.exit(1);
      }
      console.log('NO_NEW_DEPS_OK');
    " 2>&1
  description: decision-router source imports only relative paths and existing monorepo packages, no new npm deps per AC11
  expect_stdout_regex:
    - NO_NEW_DEPS_OK
  _authoredBy: probe-author
```
