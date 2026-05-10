# Story 75-5: README + CLAUDE.md Scaffold + `--help-agent` Docs Alignment

## Story

As a substrate operator or new user,
I want README.md, CLAUDE.md scaffold templates, and `substrate run --help-agent` output to accurately reflect per-story git worktree behavior and the `--no-worktree` opt-out,
so that documentation is truthful about how story dispatch works, how to inspect unmerged branches, and how to disable worktrees on incompatible repos.

## Acceptance Criteria

<!-- source-ac-hash: 26bb7ef72194bdf63fe2a521e897d9985d4733e984e2f5e59f6a4af0acb75c4f -->

### AC1: README.md updates

- Lines 9, 24, 38, 156, 167 are now accurate as-written (just verify, don't rephrase if they're already correct post-implementation).
- Add a new short subsection under "How It Works" explaining: "Each story dispatches into a per-story git worktree at `.substrate-worktrees/story-<key>` on branch `substrate/story-<key>`. After verification SHIP_IT, the branch merges back to main and the worktree is removed. After verification failure, the worktree+branch are preserved for `substrate reconcile-from-disk` inspection."
- Add `--no-worktree` row to the CLI flag table in "CLI Command Reference".
- Note in "State Backend" or similar that `.substrate-worktrees/` is added to the on-disk operator surface.

### AC2: CLAUDE.md scaffold templates

Files `src/cli/templates/{claude,agents,gemini}-md-substrate-section.md`:
- Add a one-paragraph note: "Each dispatched story runs in `.substrate-worktrees/story-<key>` on its own branch. The agent's auto-commit (e.g., `feat(story-N-M): ...`) lands on the branch, not main. Merge to main happens after verification SHIP_IT. Use `--no-worktree` if your project doesn't support worktrees (submodules, bare repos)."
- Add `--no-worktree` row to the "Key Commands Reference" table.

### AC3: Live `/home/jplanow/code/jplanow/substrate/CLAUDE.md`

Same updates as AC2 applied within the `<!-- substrate:start --> ... <!-- substrate:end -->` block of the live in-tree project file.

### AC4: `substrate run --help-agent` (`src/cli/commands/help-agent.ts`)

- Document `--no-worktree` in the substrate run options table.
- Document `pipeline:merge-conflict-detected` event in the event-schema section (auto-generated from PIPELINE_EVENT_METADATA — verify Story 75-2 added the metadata correctly).
- Update the Operator Files section to mention `.substrate-worktrees/`.

### AC5: Tests at `src/cli/commands/__tests__/help-agent.test.ts`

- (a) `--no-worktree` flag appears in the commands section.
- (b) `pipeline:merge-conflict-detected` event appears in the event-schema section.
- (c) `.substrate-worktrees/` is mentioned in the Operator Files section.

### AC6: Token-budget bump in help-agent.test.ts

Token budget bumped in help-agent.test.ts AC5 if needed (currently 5000; this adds ~30 lines of doc, may push past).

## Tasks / Subtasks

- [ ] Task 1: Update README.md (AC1)
  - [ ] Read README.md and verify lines 9, 24, 38, 156, 167 are accurate post-worktree implementation; correct any stale claims.
  - [ ] Add subsection under "How It Works" describing per-story worktree lifecycle (creation, branch naming `.substrate-worktrees/story-<key>`, merge-back on SHIP_IT, preservation on failure).
  - [ ] Add `--no-worktree` row to the CLI flag table in "CLI Command Reference".
  - [ ] Add note about `.substrate-worktrees/` to the State Backend (or equivalent) section describing on-disk operator surface.

- [ ] Task 2: Update CLAUDE.md scaffold templates (AC2)
  - [ ] Read `src/cli/templates/claude-md-substrate-section.md`; add the one-paragraph worktree note and `--no-worktree` row to the Key Commands Reference table.
  - [ ] Read `src/cli/templates/agents-md-substrate-section.md`; apply identical updates.
  - [ ] Read `src/cli/templates/gemini-md-substrate-section.md`; apply identical updates.

- [ ] Task 3: Update live CLAUDE.md in-tree file (AC3)
  - [ ] Read `/home/jplanow/code/jplanow/substrate/CLAUDE.md` and locate the `<!-- substrate:start --> ... <!-- substrate:end -->` block.
  - [ ] Apply the same worktree paragraph and `--no-worktree` row within that block (mirroring AC2 content).

- [ ] Task 4: Update help-agent.ts (AC4)
  - [ ] Read `src/cli/commands/help-agent.ts` and verify `pipeline:merge-conflict-detected` is in PIPELINE_EVENT_METADATA (added by Story 75-2); confirm it auto-appears in the event-schema output or add it explicitly if not driven by metadata.
  - [ ] Add `--no-worktree` row to the substrate run options table in the help-agent text.
  - [ ] Add `.substrate-worktrees/` to the Operator Files section in the help-agent text.

- [ ] Task 5: Update help-agent.test.ts and bump token budget if needed (AC5, AC6)
  - [ ] Read `src/cli/commands/__tests__/help-agent.test.ts` and locate the token budget constant (currently 5000).
  - [ ] Add assertion (a): `--no-worktree` flag appears in the commands/options section output.
  - [ ] Add assertion (b): `pipeline:merge-conflict-detected` appears in the event-schema section output.
  - [ ] Add assertion (c): `.substrate-worktrees/` appears in the Operator Files section output.
  - [ ] Bump the token budget constant if the new assertions reveal the output now exceeds 5000 tokens (increase to 6000 or as needed).

## Dev Notes

### Architecture Constraints

- The three scaffold template files must receive **identical** paragraph and table-row content — any wording difference between `claude-md-substrate-section.md`, `agents-md-substrate-section.md`, and `gemini-md-substrate-section.md` is a defect.
- The live `CLAUDE.md` update (`<!-- substrate:start --> ... <!-- substrate:end -->` block only) must not touch content outside that delimited block; the surrounding project-level instructions must remain intact.
- Help-agent event-schema output MUST be driven by `PIPELINE_EVENT_METADATA` wherever possible; do not hardcode `pipeline:merge-conflict-detected` as a string literal in `help-agent.ts` unless Story 75-2 did not add it to the metadata. Check `PIPELINE_EVENT_METADATA` first.
- Do not change help-agent CLI output format — only add new rows/entries. Existing tests must not break.

### File Paths

| File | Purpose |
|------|---------|
| `README.md` | Top-level project README — AC1 |
| `CLAUDE.md` | Live in-tree project file — AC3 |
| `src/cli/templates/claude-md-substrate-section.md` | Scaffold template — AC2 |
| `src/cli/templates/agents-md-substrate-section.md` | Scaffold template — AC2 |
| `src/cli/templates/gemini-md-substrate-section.md` | Scaffold template — AC2 |
| `src/cli/commands/help-agent.ts` | Help-agent text generation — AC4 |
| `src/cli/commands/__tests__/help-agent.test.ts` | Help-agent assertions + token budget — AC5, AC6 |

### PIPELINE_EVENT_METADATA check (AC4)

Before editing `help-agent.ts`, grep for `pipeline:merge-conflict-detected` in the source tree to confirm Story 75-2 registered it in `PIPELINE_EVENT_METADATA`. If found, the event will auto-appear in event-schema output and no additional code change is needed — only verify the generated text is present. If NOT found, add a manual entry to the event-schema section of help-agent output as a fallback.

```
grep -r "merge-conflict-detected" src/
```

### Token budget guidance (AC6)

The existing token-budget constant in `help-agent.test.ts` is 5000. This story adds approximately:
- `--no-worktree` row: ~10 tokens
- `pipeline:merge-conflict-detected` event entry: ~15–25 tokens (schema + description)
- `.substrate-worktrees/` Operator Files entry: ~10 tokens

Total addition: ~35–45 tokens. Bump to 6000 as a conservative safe margin; exact value can be read from a test run if needed.

### Testing Requirements

- Run `npm run test:fast` after changes — must pass all existing help-agent tests plus the three new assertions.
- Do not run tests concurrently: `pgrep -f vitest` must return nothing before starting.
- The three new assertions in help-agent.test.ts should follow the same pattern as existing content assertions in that file.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
