# Story 75-4: Orchestrator + dispatch test updates

## Story

As a pipeline developer,
I want the orchestrator and dispatch test suite updated to expect worktree paths after story 75-1 lands,
so that 75-1 + 75-2 ship CI-green without the existing test suite going red.

## Acceptance Criteria

<!-- source-ac-hash: 1f0bca95b202293fffa898f6aeeb585cc8d5aabe971d38b83b814503ced59732 -->

1. **Audit + update**: every test in `src/modules/implementation-orchestrator/__tests__/` and `src/modules/compiled-workflows/__tests__/` that asserts on `workingDirectory` or `projectRoot` matches in dispatch options. After Story 75-1 lands, those should expect a worktree path matching `<tmpDir>/.substrate-worktrees/story-<key>` (or be agnostic via a regex).

2. **Mock-manager pattern**: introduce a test helper `createMockWorktreeManager(opts?)` that returns a stub matching `GitWorktreeManager` and lets tests assert on createWorktree/cleanupWorktree calls. Lives at `src/modules/implementation-orchestrator/__tests__/test-helpers/mock-worktree-manager.ts`.

3. **e2e fixture update**: `__tests__/integration/non-interactive-run.test.ts` — verify it still passes with worktree mode default-on. The story key `0-1` will create a real worktree dir; ensure the test cleans up the `.substrate-worktrees/` directory in afterEach.

4. **`packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts`**: this cross-project fixture exercises conflictGroups. With worktrees, conflictGroups remain useful for ordering hints but are no longer the safety mechanism. Update fixture comments to reflect reality.

5. **No new tests required** — this is a test-update story, not a new-feature story. The new tests live in 75-1 + 75-2 + 75-3.

6. **Suite must pass at HEAD after this story** with `DOLT_INTEGRATION_TEST=1 npm test`. CI matrix [ubuntu-latest, macos-latest] both green.

## Tasks / Subtasks

- [ ] Task 1: Audit orchestrator tests for workingDirectory / projectRoot assertions (AC: #1)
  - [ ] Grep `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts` for `workingDirectory`, `cwd`, and `projectRoot` field assertions in dispatch option matchers
  - [ ] Replace exact-string matches against the project root with `expect.stringMatching(/\.substrate-worktrees[/\\]story-/)` (cross-platform regex) or make them agnostic using `expect.any(String)` where the specific path is immaterial
  - [ ] Repeat audit across every file in `src/modules/implementation-orchestrator/__tests__/` — scan all `.test.ts` files, not only `orchestrator.test.ts`

- [ ] Task 2: Audit compiled-workflows tests for the same patterns (AC: #1)
  - [ ] Grep every `.test.ts` in `src/modules/compiled-workflows/__tests__/` for `workingDirectory`, `cwd`, and `projectRoot` assertions
  - [ ] Apply the same regex-matcher or agnostic-assertion updates to each file that asserts on dispatch path values

- [ ] Task 3: Create `createMockWorktreeManager` test helper (AC: #2)
  - [ ] Create directory `src/modules/implementation-orchestrator/__tests__/test-helpers/`
  - [ ] Write `mock-worktree-manager.ts` exporting `createMockWorktreeManager(opts?)` that returns a `vi.fn()`-based stub satisfying the `GitWorktreeManager` interface (from story 75-1, likely at `src/modules/git/worktree-manager.ts` or `packages/core/src/git/worktree-manager.ts`)
  - [ ] Stub methods at minimum: `createWorktree` (resolves to a string path) and `cleanupWorktree` (resolves void)
  - [ ] Wire the mock into any orchestrator test that now constructs or injects a real `GitWorktreeManager`

- [ ] Task 4: Add worktree cleanup to non-interactive-run e2e afterEach (AC: #3)
  - [ ] Open `__tests__/integration/non-interactive-run.test.ts` and locate the `afterEach` / teardown block
  - [ ] Add `fs.rmSync(path.join(testProjectRoot, '.substrate-worktrees'), { recursive: true, force: true })` (idempotent) so worktrees created by story key `0-1` are removed after each test
  - [ ] Confirm the integration test passes end-to-end with worktree mode default-on after the cleanup is in place

- [ ] Task 5: Update ynab fixture comments and run full suite (AC: #4, #5, #6)
  - [ ] Open `packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts` and locate `conflictGroups` usage
  - [ ] Update inline comments to clarify that worktrees are now the concurrency-safety mechanism; `conflictGroups` remain useful as ordering hints only
  - [ ] Run `npm run test:fast` to confirm no regressions; then run `DOLT_INTEGRATION_TEST=1 npm test` for full suite validation before marking done

## Dev Notes

### Architecture Constraints
- **Test-update only.** Do NOT introduce new feature code — all changes must be confined to test files, test helpers, and fixture comment updates.
- The `createMockWorktreeManager` helper must be exported from its file so stories 75-1, 75-2, and 75-3 can import it as a shared test utility.
- Import the `GitWorktreeManager` interface (or a compatible duck type) from wherever story 75-1 defines it. Likely candidates: `src/modules/git/worktree-manager.ts` or `packages/core/src/git/worktree-manager.ts`. Do not duplicate the interface — import the type.
- Cross-platform path regex: use `/\.substrate-worktrees[/\\]story-/` (handles both POSIX `/` and Windows `\`) so tests pass on both ubuntu and macOS CI nodes.

### Testing Requirements
- Run `npm run test:fast` during iteration to catch regressions quickly (~50s). Run `DOLT_INTEGRATION_TEST=1 npm test` for final full-suite validation only.
- Never run concurrent vitest instances — verify `pgrep -f vitest` returns nothing before starting.
- The afterEach `fs.rmSync` call must use `{ force: true }` so it is a no-op when the `.substrate-worktrees/` directory does not exist (e.g., in older test runs without worktree mode active).
- The mock stub for `createWorktree` should default to resolving with a synthetic path like `/tmp/mock-worktrees/story-${storyKey}` so tests can assert on the path value passed to dispatch without touching the real filesystem.

### File Paths
- `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts` — primary assertion update target
- `src/modules/implementation-orchestrator/__tests__/test-helpers/mock-worktree-manager.ts` — NEW file
- `src/modules/compiled-workflows/__tests__/*.test.ts` — audit all, update where `workingDirectory`/`cwd`/`projectRoot` appears in dispatch matchers
- `__tests__/integration/non-interactive-run.test.ts` — afterEach worktree cleanup addition
- `packages/sdlc/src/__tests__/fixtures/ynab-cross-project-fixture.ts` — comment update only

### Key Patterns from Codebase
- Existing vitest spy patterns in orchestrator tests: check `orchestrator.test.ts` for `vi.fn()` spy construction patterns to follow in the new mock helper.
- Use `fs.rmSync` (Node ≥ 14 built-in) for cleanup — not `rimraf` or `del` — to avoid adding a new test dependency.
- `afterEach` cleanup must be idempotent and must not throw when the directory is absent.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
