---
external_state_dependencies:
  - subprocess
---

# Story 75-3: `--no-worktree` Opt-Out Flag

## Story

As a substrate operator running projects with incompatible git configurations (submodules, bare repos, or large checkouts where parallel worktrees blow disk),
I want a `--no-worktree` flag and `SUBSTRATE_NO_WORKTREE=1` env var to bypass per-story worktree creation,
so that I can use substrate safely on projects where worktrees aren't suitable, falling back to the legacy single-cwd dispatch behavior.

## Acceptance Criteria

<!-- source-ac-hash: 564a4210a2b14b80faf248fbae0a75db6f8330d50e5f80d35a7a7f7884d58e34 -->

1. New CLI flag `--no-worktree` registered on `substrate run` (in `src/cli/commands/run.ts`'s `registerRunCommand` options block). Boolean. Default false.

2. Env var `SUBSTRATE_NO_WORKTREE=1` honored — same effect as `--no-worktree`. CLI flag takes precedence over env var (consistent with existing `SUBSTRATE_NO_UPDATE_CHECK` pattern).

3. **Config-flow plumbing**: pass `noWorktree: boolean` through `RunActionOptions` → `OrchestratorConfig`. Story 75-1's worktree creation block consumes it; when true, `effectiveProjectRoot` falls back to `projectRoot`.

4. **Manifest captures the choice**: `cli_flags` in the run manifest records `no_worktree: true` when the flag is set, so post-run forensics know whether worktrees were used.

5. **Documentation in `--help` text**: the option's description must explain "use this when worktree mode causes problems (submodules, bare repos, large checkouts) — it's a safety valve, not the recommended path".

6. **Tests** at `src/cli/commands/__tests__/no-worktree-flag.test.ts`:
   - (a) `--no-worktree` parsed from argv produces config with `noWorktree: true`
   - (b) `SUBSTRATE_NO_WORKTREE=1` produces same config
   - (c) CLI flag takes precedence over env var (CLI explicitly false + env var "1" → false)
   - (d) When config.noWorktree is true, the orchestrator does not invoke createWorktree (verify via mock manager)
   - (e) Run manifest persists `cli_flags.no_worktree` correctly

7. **CRITICAL**: do NOT introduce a separate config-format-version bump for this flag. Add it to the existing `cli_flags` field per Stream A+B canonical-helper pattern.

## Tasks / Subtasks

- [ ] Task 1: Register CLI flag and env var in `registerRunCommand` (AC1, AC2, AC5)
  - [ ] Add `.option('--no-worktree', 'Use this when worktree mode causes problems (submodules, bare repos, large checkouts) — it\'s a safety valve, not the recommended path')` to the `registerRunCommand` option block in `src/cli/commands/run.ts` (after the existing `--verify-ac` option, around line 3033)
  - [ ] Add `noWorktree?: boolean` to the opts type destructured in the `.action()` handler (alongside `verifyAc?: boolean`)
  - [ ] In the action handler, resolve effective value honoring CLI-over-env precedence: `const effectiveNoWorktree = opts.noWorktree ?? (process.env['SUBSTRATE_NO_WORKTREE'] === '1')` — CLI flag presence (true) wins; CLI explicitly negated (false via `--no-no-worktree`) also wins; env var is fallback when flag absent
  - [ ] Thread `noWorktree: effectiveNoWorktree` into the `runRunAction()` call object

- [ ] Task 2: Add `noWorktree` to `RunOptions` and `OrchestratorConfig` (AC3)
  - [ ] Add `/** When true, bypass per-story worktree creation (safety valve). Story 75-3. */ noWorktree?: boolean` to `RunOptions` interface in `src/cli/commands/run.ts` (after `verifyAc?: boolean`, around line 621)
  - [ ] Add `/** When true, skip per-story worktree creation; dispatch all phases with cwd: projectRoot (Story 75-3). */ noWorktree?: boolean` to `OrchestratorConfig` in `src/modules/implementation-orchestrator/types.ts` (after `probeAuthorStateIntegrating?: boolean`, around line 146)
  - [ ] In `runRunAction()`, thread `noWorktree: options.noWorktree` into the `OrchestratorConfig` object passed to the orchestrator
  - [ ] In `orchestrator-impl.ts`, at the worktree-creation block (Story 75-1's `effectiveProjectRoot` logic): when `config.noWorktree === true`, skip `createWorktree` and set `effectiveProjectRoot = config.projectRoot` (or equivalent field name used by 75-1)

- [ ] Task 3: Extend `CliFlagsSchema` and record in manifest (AC4, AC7)
  - [ ] Add `/** When true, per-story worktree creation was bypassed (--no-worktree). Story 75-3. */ no_worktree: z.boolean().optional()` to `CliFlagsSchema` in `packages/sdlc/src/run-model/cli-flags.ts` (after `halt_skipped_decisions` field, around line 48) — this is the Zod schema that backs `CliFlags`; the manifest's `cli_flags` field uses this type
  - [ ] In the manifest CLI-flags write path (wherever `patchCLIFlags` is called with the initial flags at run start), include `no_worktree: true` when `noWorktree` is set — `no_worktree: false` should be omitted (use `.optional()` not `false`); only write when explicitly enabled
  - [ ] Do NOT add a config-format-version bump; the `CliFlagsSchema` uses `.optional()` which is forward/backward compatible

- [ ] Task 4: Write tests (AC6a–e)
  - [ ] Create `src/cli/commands/__tests__/no-worktree-flag.test.ts`
  - [ ] Test (a): mock `runRunAction` + call `registerRunCommand` with `['run', '--no-worktree']` → verify `noWorktree: true` passed to `runRunAction`
  - [ ] Test (b): set `process.env.SUBSTRATE_NO_WORKTREE = '1'`, omit CLI flag → verify resolved `noWorktree: true`; restore env after test
  - [ ] Test (c): set `process.env.SUBSTRATE_NO_WORKTREE = '1'` + pass CLI `--no-no-worktree` (explicit negation) → verify resolved `noWorktree: false` (CLI wins); restore env after test
  - [ ] Test (d): construct `OrchestratorConfig` with `noWorktree: true`, mock `createWorktree`; run orchestrator initialization path; assert `createWorktree` was never called and `effectiveProjectRoot === config.projectRoot`
  - [ ] Test (e): construct a minimal `RunManifest`, call `patchCLIFlags({ no_worktree: true })`, read result; assert `cli_flags.no_worktree === true`; also verify `CliFlagsSchema.parse({ no_worktree: true })` passes and `CliFlagsSchema.parse({})` passes (backward compat)

## Dev Notes

### Architecture Constraints

- **CLI flag registration pattern**: follow the existing option block in `registerRunCommand` (around line 3033 in `src/cli/commands/run.ts`). Each `.option()` call chains on the commander Command. Precedence logic goes inside `.action()` before the `runRunAction()` call.
- **Env var precedence pattern**: `SUBSTRATE_NO_UPDATE_CHECK` at line 2924 shows the env var check pattern. For `--no-worktree`, the precedence is the opposite direction (CLI wins over env, not just env): use `opts.noWorktree ?? (process.env['SUBSTRATE_NO_WORKTREE'] === '1')`. When commander parses `--no-worktree`, `opts.noWorktree` is `true`; when `--no-no-worktree` is passed (explicit negation), it is `false`; when absent, it is `undefined` and the env var fallback applies.
- **CliFlags schema file**: the schema lives in `packages/sdlc/src/run-model/cli-flags.ts` (NOT `run-manifest.ts`). The `CliFlagsSchema` Zod object at line 20 is what the dev agent extends. The `run-manifest.ts` imports `CliFlags` from `cli-flags.ts` — adding the field to the Zod schema is sufficient.
- **Manifest write point**: find where `patchCLIFlags(...)` is called with the initial CLI flags (Story 52-3 implementation); include `...(options.noWorktree ? { no_worktree: true } : {})` in the flags object. Do NOT write `no_worktree: false` — only write the field when true.
- **75-1 worktree block**: this story depends on Story 75-1's `effectiveProjectRoot` / `createWorktree` logic being present. Read that code in `orchestrator-impl.ts` before implementing the `noWorktree` conditional. If 75-1 is not yet merged, add a `// TODO: 75-1 dependency — integrate when available` comment at the hook point.
- **No config-format-version bump**: AC7 is explicit. `CliFlagsSchema` uses `.optional()` throughout — adding another `.optional()` field is non-breaking. Do not touch any version field.
- **Test isolation for env vars**: always restore `process.env.SUBSTRATE_NO_WORKTREE` after each test (use `afterEach` or `vi.stubEnv` if available in the test harness); leaked env breaks test (c) which relies on the env var being absent.

### Testing Requirements

- Test file: `src/cli/commands/__tests__/no-worktree-flag.test.ts`
- Framework: Vitest (consistent with the rest of `src/cli/commands/__tests__/`)
- Mock `runRunAction` to capture the `RunOptions` passed to it (tests a–c)
- Mock `createWorktree` or the worktree manager to verify it is not called (test d)
- Use `vi.stubEnv` or manual save/restore for env var tests (b, c)
- `CliFlagsSchema` parse tests require no mocking — import the schema directly from `packages/sdlc/src/run-model/cli-flags.js`
- Run with `npm run test:fast` during iteration; full suite via `npm test` before merge

### File List

- `src/cli/commands/run.ts` — add option registration, opts type, env-var resolution, RunOptions field
- `src/modules/implementation-orchestrator/types.ts` — add `noWorktree?: boolean` to OrchestratorConfig
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — consume `config.noWorktree` in worktree-creation block
- `packages/sdlc/src/run-model/cli-flags.ts` — add `no_worktree: z.boolean().optional()` to CliFlagsSchema
- `src/cli/commands/__tests__/no-worktree-flag.test.ts` — NEW test file (ACs 6a–e)

## Runtime Probes

```yaml
- name: no-worktree-flag-in-help
  sandbox: host
  command: node dist/cli/index.js run --help
  expect_stdout_regex:
    - '--no-worktree'
    - 'safety valve'
  description: >
    Verifies the --no-worktree flag is registered and the help description contains
    "safety valve" as required by AC5. Catches bundler-chunking issues where the
    flag is in source but absent from the dist artifact (v0.20.75 lesson).
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
