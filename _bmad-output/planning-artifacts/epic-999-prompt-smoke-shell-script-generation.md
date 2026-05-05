# Smoke Fixture: Shell-script Generation AC for Prompt-Edit Ships

**Purpose:** Empirical smoke fixture used by `.claude/commands/ship.md`
Step 4.5 (prompt-edit empirical smoke) to validate that substrate's
`create-story` prompt produces the structural property targeted by
Epic 67 — when an AC describes a shell-script generator (git hook,
install wrapper, lifecycle script), the rendered story must contain
a `## Runtime Probes` section whose probes invoke the canonical user
trigger (e.g., `git push` for pre-push hooks, `npm install` for
postinstall scripts) in a fresh fixture project (`mktemp -d`-style),
NOT direct-call the generated script with synthetic inputs.

**Failure shapes covered:**

- **obs_2026-05-03_023** (verification accepts shell-out code without
  end-to-end fixture execution) — rendered story for a shell-script
  generator AC should signal the class via `## Runtime Probes` section
  whose probes use `mktemp -d` + a canonical user trigger and assert
  observable post-conditions.

**Lifecycle:** the smoke step ingests this epic and dispatches Story
999-1, then cleans up both the `wg_stories` row and the rendered
artifact afterward. The fixture file itself is durable.

**Why a Phase B-shaped rich story spec** (per obs_2026-05-05_026 fix
direction 1): thin fixtures (1-2 abstract ACs) escalate
`create-story-no-file` under v0.20.58+ prompts. The agent needs
concrete code-level identifiers (file paths, function names,
specific commands) and 4+ ACs with explicit Given/When/Then to render
a valid story file. This fixture matches the density of real
production stories like Epic 67 Story 67-1.

---

## Story Map

- 999-1: Pre-push hook generator with finding archive (P0, Medium)

## Story 999-1: Pre-push hook generator with finding archive

**Priority**: must

**Description**: Implement a `vg install` command in
`packages/vision-guardian/src/commands/install-hook.ts` that
**writes a `.git/hooks/pre-push` shell script** to the user's project.
The hook, when triggered by `git push`, runs the vision-guardian
finding emitter against the user's source files and archives any
emitted findings to `.findings/history.jsonl` (one JSON record per
line, append-only). The hook must:

- bake an absolute path to the emitter binary at install time (NOT
  `npx <package>` fallback that triggers npm-registry fetch on first
  use; NOT bare PATH lookup that can fail when binary isn't installed
  globally)
- use `node` to invoke the emitter (don't rely on +x bit, which `tsc`
  doesn't preserve through builds and CI may strip)
- pipe the emitter's stdout to the archive command via a stable
  contract (`--output-file` flag pointing at `.findings/history.jsonl`,
  not parsed-prefix lines that fragment the protocol)
- exit 0 when no violations found AND when violations archived
  successfully (so `git push` proceeds)

This is a shell-script generation pattern: the implementation produces
a shell script consumed by `git`'s hook subsystem on `git push`. The
story MUST include a `## Runtime Probes` section because the
correctness of the hook can only be confirmed by triggering the
canonical user event (`git push`) in a fresh fixture project (`mktemp
-d`) — not by direct-calling `bash hook.sh` with synthetic inputs,
which doesn't exercise the install/PATH/permissions surface.

The implementation closes the failure mode of strata Stories 3-3+3-4
(obs_2026-05-03_023): hook generator that emitted `npx strata` /
`npx depcruise` fallbacks shipped LGTM_WITH_NOTES through every
substrate verification gate but immediately failed in fresh user
environments where global packages weren't installed.

**Acceptance Criteria**:

1. `packages/vision-guardian/src/commands/install-hook.ts` exports
   `installPrePushHook(projectRoot: string)` that:
   - resolves the absolute path to the emitter at
     `<vision-guardian-root>/dist/emit-findings.js` via `import.meta.url`
   - writes `.git/hooks/pre-push` containing the resolved absolute path
     (NO `npx`, NO bare PATH lookup — verified by grep against the
     written file content)
   - sets the file's executable bit via `fs.chmod(path, 0o755)`

2. The written hook script invokes the emitter as
   `node "${ABSOLUTE_EMITTER_PATH}" --output-file "$PROJECT_ROOT/.findings/history.jsonl"`
   where `$PROJECT_ROOT` is the git toplevel resolved at hook runtime
   via `git rev-parse --show-toplevel`.

3. The hook ensures `.findings/` directory exists (creates with
   `mkdir -p` if absent) before invoking the emitter so the
   `--output-file` path resolves successfully.

4. `.findings/history.jsonl` is append-only (one JSON record per line);
   the hook never truncates or rewrites existing content.

5. The hook's last command is `exit 0` so `git push` proceeds when
   findings were archived successfully (separate from violation policy
   — even hooks that find violations should not block push, archive is
   the deliverable).

6. Tests in
   `packages/vision-guardian/src/__tests__/install-hook.test.ts`
   validate: (a) the written hook contains the absolute emitter path;
   (b) the written hook does NOT contain `npx ` or bare `strata` /
   `depcruise` invocations; (c) `.git/hooks/pre-push` has executable
   permission after install; (d) `.findings/` directory created on
   first hook invocation.

7. The rendered story for this AC must include a `## Runtime Probes`
   section whose probes:
   - create a fresh fixture project via `mktemp -d` (NOT use substrate's
     own working tree)
   - initialize the fixture as a real git repo (`git init`, configure
     `user.email` + `user.name`, `git commit` initial state)
   - run the canonical install (`node <REPO_ROOT>/dist/cli.js vg install`
     or equivalent absolute-path invocation)
   - trigger the canonical user-facing event (`git push` against a
     local bare remote initialized via `git init --bare`)
   - assert observable post-condition: `test -f .findings/history.jsonl`
     AND content matches expected finding shape (one line per finding,
     valid JSON per line)
   - NOT direct-call the generated hook (`bash hook.sh`) with
     synthetic inputs

**Files involved**:

- `packages/vision-guardian/src/commands/install-hook.ts` (new module —
  install logic and hook script generation)
- `packages/vision-guardian/src/__tests__/install-hook.test.ts` (new
  test file — 4 unit test cases per AC6)
- `packages/vision-guardian/src/cli.ts` (modify — register `vg install`
  subcommand wired to `installPrePushHook`)
- `packages/vision-guardian/package.json` (modify — bump version, add
  `vg` bin entry pointing to `dist/cli.js`)

**Tasks / Subtasks**:

- [ ] AC1: implement `installPrePushHook(projectRoot)` with absolute
      path resolution via `import.meta.url`
- [ ] AC2: hook script invokes emitter via `node "${ABS_PATH}"
      --output-file "$PROJECT_ROOT/.findings/history.jsonl"`
- [ ] AC3: hook ensures `.findings/` directory exists via `mkdir -p`
- [ ] AC4: history.jsonl append-only invariant verified by AC6 tests
- [ ] AC5: hook exits 0 unconditionally
- [ ] AC6: 4 unit tests in install-hook.test.ts covering ACs above
- [ ] AC7: fresh-fixture canonical-invocation runtime probes section
      authored
