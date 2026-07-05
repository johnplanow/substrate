# Substrate remediation audit — harden vs. rebuild (2026-07-05)

**Method.** Source-level audit of substrate at HEAD `d095d14` (v0.20.138), read against the 19 findings in `_planning/2026-07-04-income-sources-field-feedback.md` (ground truth) and the two 2026-07-05 research reports (context). Four parallel source traces (verification, isolation, finalization, cross-cutting) plus direct verification of every load-bearing anchor cited below. All paths repo-relative; `orchestrator-impl.ts` = `src/modules/implementation-orchestrator/orchestrator-impl.ts` unless prefixed.

---

## Verdict (up front)

**The architecture is sound. Harden in place. Nothing found requires a structural rebuild.**

Every fix identified in this audit is CONFIG or WIRING — zero REWRITEs. That is not a hopeful gloss; it's a consequence of three concrete facts about the code:

1. **The seams are where you'd want them.** One spawn point for all agents (`packages/core/src/dispatch/dispatcher-impl.ts:644`), one env construction (`:626`), one merge choke point (`enqueueMerge` → `merge-to-main.ts:91`), one commit helper (`git-helpers.ts:55`), a 7-method `GitWorktreeManager` interface (`packages/core/src/git/git-worktree-manager.ts:80-149`), and a pluggable verification-check registry (`packages/sdlc/src/verification/verification-pipeline.ts:197-212`). Every remediation below lands at one of these seams.
2. **The failures are not architectural — they cluster into three defect shapes**: (a) *Node-centric defaults* sprayed across ~8 sites (`npm run build` / `npx turbo build` / TypeScript fallbacks); (b) *one lexical control-flow bug* — the entire commit+merge finalization block lives inside the `SHIP_IT || LGTM_WITH_NOTES` branch, so every other exit path silently skips it; (c) *missing enforcement* where a convention was assumed (agent stays in cwd, project has a `.gitignore`, verdict text is trustworthy).
3. **Half the machinery for the fixes already exists, unwired.** `context.buildCommand` override plumbing exists on both ends but is never populated; `.substrate/project-profile.yaml` carries `language`/`buildCommand`/`testCommand` but is gitignored out of worktrees and unread by the verification BuildCheck; `baselineHeadSha` is captured but not persisted; the API-key scrub exists but misses the planning path; a Codex-specific error-signature classifier exists as a pattern to copy for auth.

The one genuinely structural limit to be honest about: substrate spawns `claude` with `--dangerously-skip-permissions` (`packages/core/src/adapters/claude-adapter.ts:198`), so **no worktree-layer fix can *confine* a misbehaving agent** — git-state scoping removes the breadcrumbs and fixes the accident class (which is what the field hit), but hard confinement needs an OS sandbox or scoped permissions. That's a known trade-off to schedule, not a reason to rebuild the orchestrator: the worktree layer is swappable for a container backend behind the existing interface **provided the container bind-mounts a host path** (the orchestrator's contract with "the worktree" is a local fs path string at ~15 call sites plus branch-name semantics; a no-shared-fs backend would be a rewrite of phase plumbing).

The research reports' three non-negotiables all land as WIRING here: real-suite-in-real-env (§A), leak-proof isolation (§B), never-self-merge (§C). Their claim that substrate "under-uses BMAD v6 `bmad-dev-auto` finalization primitives" verified as directionally correct: **zero references to `dev-auto`/`commit-local` exist anywhere in the repo** — substrate dispatches its own compiled prompt (`packs/bmad/prompts/dev-story.md`) which explicitly *forbids* the agent from committing (`dev-story.md:76`), reimplements block-on-verify-fail itself (`orchestrator-impl.ts:4012-4033`), captures a baseline SHA but never persists the bracket, and has no commit-local step. Adopting those primitives is WIRING (§C.4).

---

## A. Verification — the six stages, traced

Pipeline: `packages/sdlc/src/verification/verification-pipeline.ts:62-169`; default registration at `:197-212` is actually **8 checks** (the named six + `source-ac-shellout` + Tier-B `cross-story-consistency`). Design constraint FR-V9: **no LLM calls anywhere in the pipeline** (`:7`) — it is deterministic heuristics end-to-end. Aggregate verdict is worst-of fail>warn>pass (`:40-49`). The orchestrator constructs it with `undefined` config (`orchestrator-impl.ts:902-905`), so the `trivialOutputThreshold` config key (`packages/core/src/config/types.ts:211,245`) is dead — default 100 always applies.

| Stage | What it actually executes |
|---|---|
| phantom-review | In-memory inspection of review dispatch signals. Fails on `dispatchFailed` or empty `rawOutput` (`checks/phantom-review-check.ts:55-93`); **passes when there's no review result at all** (`:44-52`). |
| trivial-output | Arithmetic: `outputTokenCount < 100` (`checks/trivial-output-check.ts:31,72-163`). Measures words emitted, not work done — a chatty do-nothing agent passes. |
| acceptance-criteria-evidence | Regex AC-id extraction from the story (`:117-154`) compared against the dev agent's **self-reported** `ac_met`/`tests` claims (`checks/acceptance-criteria-evidence-check.ts:272-326`). No independent execution of anything. |
| build | `spawn(cmd, {shell:true})`, 60s timeout (`checks/build-check.ts:145-239`). Command from its own inline detector (below). |
| runtime-probes | Parses `## Runtime Probes` YAML from the story md (`probes/parser.ts:130-200`); each `sandbox: host` probe is `spawn(command, {shell:true, cwd: worktree, env: process.env})` (`probes/executor.ts:199-224`). `sandbox: twin` probes all skip (`checks/runtime-probe-check.ts:502-511`) — finding #9. |
| source-AC-fidelity | Regex hard-clause cross-reference (MUST/SHALL lines, backticked paths) from epic → story artifact + bounded path-existence checks (`source-ac-fidelity-check.ts:738-1014`). **Empty `files_modified` → benefit-of-the-doubt pass** (`:184`). |

### Why `npm run build` ran on a uv project, and why pure-Python gets "build-skip" (#11, #12)

There are **two independent build detectors that disagree**:

- **Verification BuildCheck** (`build-check.ts:67-97`, verified directly): priority is turbo → pnpm → yarn → bun → **`package.json` → `npm run build` (`:85-87`) → only then the non-Node markers `pyproject.toml`/`Cargo.toml`/etc. → `''` skip (`:89-94`)**. So: story 2-2's scaffolded `package.json` flipped it to `npm run build` (#12 — the trigger is the scaffolded `package.json`, not the stray `.ts` files per se), and a clean uv project returns `''` → the literal `build-skip: no build command detected` (`:127-141`) (#11). **It never runs any Python command; `uv` appears nowhere in the codebase.** The file's own header admits it "mirrors dispatcher-impl.ts logic without importing from the monolith" — the mirror inverted the priority order.
- **Pre-review build gate** (Story 24-2, `src/modules/agent-dispatch/dispatcher-impl.ts:267-433`): its `detectPackageManager` (`:133-195`) is correctly ordered — `.substrate/project-profile.yaml` `project.buildCommand` override **first** (`:134-147`), non-Node markers **before** Node lockfiles (`:166-181`, with an explicit comment about not flipping to Node), plus a "Missing script → skip (greenfield)" exemption (`:379-388`) that BuildCheck lacks. But its default is still `npm run build` (`DEFAULT_VERIFY_COMMAND`, `:102`), and it too never runs Python tests.

**The `context.buildCommand` override exists but is never populated**: `build-check.ts:121-124` honors it; `assembleVerificationContext` (`src/modules/implementation-orchestrator/verification-integration.ts:33-95`) never sets it. Pure dead plumbing.

**Classification for "run the project's real test command in its real env":**
- Gate (B) honoring a hand-written profile: **CONFIG today** (`.substrate/project-profile.yaml` → `project.buildCommand: "uv run pytest"` works now via `dispatcher-impl.ts:134-147`) — *except* the profile is gitignored and therefore absent from worktrees (§D.1), so even this is broken in practice until the one-line gitignore fix lands.
- BuildCheck reading the profile / the override: **WIRING** (~2 small changes).
- A real *test-suite* verification stage (the profile schema already has `testCommand`, `src/modules/project-profile/schema.ts:43-44`, and the detector already emits `pytest`/venv-prefixed variants, `detect.ts:313-337`): **WIRING**, ~1–2 days including a new check class. Not a rewrite — the check registry, spawn harness, and findings schema all exist in `build-check.ts` to copy.
- `uv` support in the detector (uv.lock → `uv run pytest`): **WIRING**, ~1–2h (`detect.ts:82-89` + `install-command.ts:42-54`).

### Why probes ran bare `python` outside the venv (#6)

`probes/executor.ts:204-205` (verified): `cwd = options.cwd ?? process.cwd()`, **`env = options.env ?? process.env`** — the orchestrator's env verbatim, no venv activation, no `uv run` wrapping, no PATH shaping. The interpreter is whatever string the probe-authoring agent wrote in the story's `command:` field, resolved by `/bin/sh` from the inherited PATH. The only rewriting is `<REPO_ROOT>` substitution (`:211`). Fix = wrap/prefix probe commands from the project profile (or shape `env.PATH`/`VIRTUAL_ENV`): **WIRING** at one function.

### Why a zero-implementation story passed "complete" (#13) and a parallel-DB impl self-merged (#16)

"Complete" is decided in `runVerificationAndComplete` (`orchestrator-impl.ts:3729-4096`): LLM review verdict SHIP_IT/LGTM → Tier-A pipeline → COMPLETE (`:4054-4071`). The gates that should have caught these:

1. **Zero-diff gate** (`orchestrator-impl.ts:3239-3339` via `checkGitDiffFiles`, `src/modules/agent-dispatch/dispatcher-impl.ts:462-505`) fires only on a **completely empty** diff — and the story-spec `.md` that create-story wrote onto the branch is itself a diff entry. One markdown file defeats it. Same for the merge-time no-changes/branch-advanced gates (`:4636-4660`, `:4752-4789`).
2. **"239 tests pass" was never executed by anything** — it's the dev agent's self-reported `tests: pass` consumed by the AC-evidence check (`acceptance-criteria-evidence-check.ts:255-270`). True (the pre-existing suite passes) and vacuous.
3. **No check anywhere asks "did this story add source/test files?"** Self-reported `files_modified` is only ever used to *soften* other checks (trivial-output downgrade `:110-137`; AC fallback; fidelity benefit-of-doubt `source-ac-fidelity-check.ts:184`). The ground-truth git diff is captured (`:3247`) but only tested for emptiness.
4. **No structure-vs-architecture conformance signal exists.** Fidelity only verifies paths *named in the epic* exist (`pathSatisfiedByCode`, `:133-155`) — it cannot flag *extra* structure (a parallel `src/actions/` package, a second DB layer). Cross-story-consistency only inspects concurrent-story collisions.

Both a **net-new-implementation gate** (fail non-trivial stories whose ground-truth diff contains no non-markdown source/test change — data already in hand at `:3247`) and a **new-toplevel-root / new-language contamination check** are **WIRING**: new check classes beside the existing eight, ~0.5–1 day each.

### Gherkin ACs (#8)

`extractAcceptanceCriteriaIds` recognizes only `AC: #N` refs, numbered items, and bullet fallback (`acceptance-criteria-evidence-check.ts:24-25,117-154`). Given/When/Then paragraphs match nothing → `[]` → warn `ac-context-missing` (`:206-219`). Note it's a **warn** — so on Gherkin projects the AC stage isn't blocking, it's *silently vacuous*, which is worse than failing. Parser extension: **WIRING**, ~0.5 day.

---

## B. Isolation — the leak, mechanically

### Where worktrees come from

`GitWorktreeManagerImpl.createWorktree` (`packages/core/src/git/git-worktree-manager-impl.ts:166-198`) → `git worktree add {root}/.substrate-worktrees/{key} -b substrate/story-{key} main` (`git-utils.ts:241-343`; base `main` hardcoded default, orchestrator passes no base at `orchestrator-impl.ts:1704`). Latent bug: `git-utils.ts:248` hardcodes `.substrate-worktrees` while `getWorktreePath` honors a configurable `_baseDirectory` (`:422-424`) — a non-default base would create in one place and clean another. Cleanup is `git worktree remove --force` **unconditionally** (`git-utils.ts:402-414`) + `git branch -D`; the only uncommitted-work guard exists at *re-create* time (`decideWorktreeReclaim`, `git-utils.ts:224-239`), not at removal.

### How agents are executed

Single spawn point, verified: `packages/core/src/dispatch/dispatcher-impl.ts:644-648` — `spawn(cmd.binary, cmd.args, { cwd: cmd.cwd, env })` where:
- `cwd` = the worktree (every adapter returns `cwd: options.worktreePath`; Claude `claude-adapter.ts:294`) — **but with a fallback to `process.cwd()`, i.e. the parent repo, when `workingDirectory` is omitted** (`:585`).
- `env = { ...process.env }` (`:626`, verified) — inherited wholesale. **`PWD`, `OLDPWD`, `INIT_CWD` (pointing at the parent root) and every `GIT_*` var pass through.** `GIT_DIR` / `GIT_WORK_TREE` / `GIT_CEILING_DIRECTORIES` are never set anywhere (zero grep hits repo-wide).
- Claude args (`claude-adapter.ts:194-244`): `-p --model … --dangerously-skip-permissions --output-format stream-json --verbose --system-prompt …`. **No `--worktree`, no sandbox, no `--allowedTools`, no settings scoping.** Substrate uses none of Claude Code's own isolation features. (Codex at least gets `--sandbox workspace-write`; Gemini gets nothing.)
- cwd is therefore the **only** scoping mechanism — exactly the filesystem-only isolation documented in Anthropic tracker #57847/#55708.

### The leak vector (#15), and why the parent copy became the only copy (#17)

No `--add-dir`/`additionalDirectories` grant exists — the leak is the *absence of enforcement*, amplified by three parent-path breadcrumbs handed to the agent:

1. The worktree is **nested inside the parent repo** — `../..` from the agent's cwd *is* the parent working tree; the worktree's `.git` *file* literally contains the parent's absolute path; Claude Code's ancestor CLAUDE.md discovery walks up into the parent.
2. Inherited `PWD`/`INIT_CWD` point at the parent root.
3. `--dangerously-skip-permissions` disables the one mechanism (directory-scoped permissions) that would stop an absolute-path write.

Substrate has *already diagnosed this class itself*: `detectWorkOutsideWorktree` (`orchestrator-impl.ts:344-357`, wired at `:3296-3327`, obs_028) checks whether dev output "landed in the MAIN checkout instead of the story worktree (a cwd misroute)", and the probe-cwd variant was fixed in v0.20.113 (`runtime-probe-check.ts:350-356`). The diagnostic exists; the prevention doesn't.

**The #17 destruction mechanism, verified**: the auto-commit stages `getGitChangedFiles(worktree)` — all dirty files *in the worktree* (`orchestrator-impl.ts:4629`) — and `commitDevStoryOutput` **silently filters out any path outside the worktree boundary** (`git-helpers.ts:65-77`: "Outside the worktree boundary — skip silently"). Files the agent wrote to the parent are never staged, never committed, never merged, and invisible to `reconcile-from-disk` (which greps for `feat(story-` *commits*, `reconcile-from-disk.ts:209-227`). If the worktree ended up clean, the story escalates `dev-story-no-commit` and the parent-tree leak holds the **sole** copy — then any `git clean` / `worktree remove --force` recovery destroys it. Exactly findings #17/#19.

### Fixable in place? Container swap?

- **Git-state scoping is WIRING**: at the single env construction (`dispatcher-impl.ts:626-642`), scrub `PWD`/`OLDPWD`/`INIT_CWD`/`GIT_*` and set `GIT_CEILING_DIRECTORIES` to the worktree parent; optionally move the worktree base *outside* the parent tree (fix the `git-utils.ts:248` hardcode). ~3 files, zero orchestrator changes, ~0.5–1 day. This removes the breadcrumbs and makes stray git operations land in the right repo. **It does not confine a skip-permissions agent** — that requires an OS sandbox or dropping `--dangerously-skip-permissions` for a scoped permission config (worth a follow-up experiment: `--add-dir`-less default permissions with the worktree as the only writable root).
- **Container-per-agent is a bounded swap, with one condition**: the orchestrator's contract with "the worktree" is (a) a local filesystem path (`effectiveProjectRoot`) consumed directly by `readFile`/`execSync` at ~15 sites (artifacts `:1734`, diffs, build gate `:3353-3378`, probes) and (b) branch semantics (`substrate/story-<key>`, `feat(story-` commits) relied on by merge, reconcile, and race-recovery. A container that **bind-mounts the worktree path** and preserves branch semantics slots in behind `GitWorktreeManager` + an adapter exec-transport extension without touching the supervisor. A fully remote/no-shared-fs backend (pure container-use/Dagger) invalidates every direct-fs site — that *would* be a rewrite. Recommendation: do the WIRING scope-fix now; prototype bind-mount containers later; don't block on it.

---

## C. Finalization — one path commits, three don't

### The control flow (verified at the branch points)

After review cycles, exactly **four terminal paths** exist, and **commit+merge lives lexically inside only one**:

- **Path A — SHIP_IT / LGTM_WITH_NOTES** (`orchestrator-impl.ts:4475`): verification → gate `:4615` (`!noWorktree && _worktreeManager && _orchestratorStartBranch && projectRoot`) → **auto-commit** `commitDevStoryOutput` (`:4629-4635`; `feat(story-…)` at `git-helpers.ts:117-124`, hooks honored) → no-changes/hook-fail escalations (`:4636-4681`) → branch-advanced gate (`:4752-4789`) → **`enqueueMerge`** (`:4803-4810`) → worktree+branch removal only after successful merge (`merge-to-main.ts:232-256`).
- **Path B — auto-approve at cycle limit** (finding #1; `:4859` → `:4976-4984`): after the last minor-fix dispatch, calls the same `runVerificationAndComplete` with `autoApprove` set, then **`keepReviewing = false; return` (`:4988-4989`, verified) — never reaching the commit/merge block**, which sits inside Path A's `if`. Story marked COMPLETE, `story:auto-approved` emitted, `substrate report` labels it `recovered` (`report.ts:301,307-326`) — with the worktree dirty and the branch at base. This is finding #1's exact signature.
- **Path C — minor-fix dispatch timeout** (`:5193-5224`): auto-approve with `downgradeLastVerdict: 'LGTM_WITH_NOTES'`, same early return (`:5223-5224`). Same bypass — even though the *recorded* verdict is LGTM_WITH_NOTES.
- **Path D — escalation / VERIFICATION_FAILED** (`:4012-4033` and ~6 sibling sites): **no git action of any kind.** No WIP commit, no checkpoint. The branch ref still equals main's HEAD, so "worktree and branch are preserved" (CLAUDE.md) is passively true but the branch preserves *nothing* — root cause of #17.

**Finding #14's "non-determinism" is deterministic routing on a nondeterministic input**: the merge-gate conditions at `:4615` are run-constants; the per-story variable is the reviewer's verdict trajectory. 2-5 got SHIP_IT within `maxReviewCycles` → full cycle. 1-1..2-4 each hit auto-approve (B/C) or escalation (D) → no commit, no merge. (Secondary whole-run variant: if start-branch capture fails at `:5794-5805`, merge silently disables for the entire run with only a log warn.)

The CLAUDE.md contract ("substrate auto-commits… merge to main happens after SHIP_IT") is accurate **only for Path A** — and the dev prompt makes B/C/D worse by instructing the agent *not* to commit (`packs/bmad/prompts/dev-story.md:76`), so on those paths nobody commits.

### The merge itself (#16)

`merge-to-main.ts:91-144` (verified): try `git merge --ff-only` (`:157-167`), **fall back to a full 3-way `git merge --no-edit`** (`:180-218`), both in the **parent** `projectRoot` on the captured start branch; conflict → abort + escalate. Serialized via a promise-chain queue. **There is no self-merge gate of any kind**: no merge/PR/finalize config key exists (`config-schema.ts:128-160` is `.strict()`; `OrchestratorConfig` has only `worktreeCopyFiles`/`maxReviewCycles`/`skipVerification`/`noWorktree`). The only lever, `--no-worktree`, also disables isolation and the auto-commit. SHIP_IT + Tier-A pass ⇒ unconditional local merge — findings #16/#18 merged precisely because every deterministic check was green (the checks just don't check the right things, §A).

### BMAD dev-auto primitives — verified against code

- `bmad-dev-auto` / `commit-local`: **zero references repo-wide.** The pipeline dispatches substrate's own compiled prompts (`dev-story.ts:114` → `packs/bmad/prompts/dev-story.md`); the `.claude/skills/bmad-*` scaffold is for interactive operator use only.
- Revision bracketing: **half-exists.** `baselineHeadSha` is captured pre-dispatch (`orchestrator-impl.ts:2754-2765`) and used for the zero-diff gate and review-diff scoping (`:4186,:4236`) but never persisted; `commit_sha` is persisted (`:4699`) **only on the commit path** — so the bracket is one-ended precisely on the failure paths where you'd need it.
- Block-on-verification-failed: **exists** (`:4012-4033`). What's missing is the *commit-first* discipline, not the block.

**Adopting commit-local + full bracketing + checkpoint-on-fail = WIRING**: `commitDevStoryOutput` is already imported in the orchestrator; move/duplicate the call to fire right after dev-story returns (near the zero-diff gate `:3249`), persist `baselineHeadSha` alongside `commit_sha` in `per_story_state`, and add a `wip(story-…): verification-failed snapshot` commit on Path D.

### Enforcing "never self-merge"

**CONFIG+WIRING, ~1–2 days**: add a `finalization.mode: merge | branch | pr` key (schema is strict — extend `config-schema.ts` + `types.ts`), branch at the single merge call site (`:4800`): `branch` mode stops after auto-commit (branch is the deliverable, emit `story:finalized {branch, sha}`), `pr` mode adds `git push` + `gh pr create`, `merge` keeps today's behavior for greenfield runs. Also emit the explicit `story:merged {sha}` event finding #14 asks for. All primitives (per-story branch, auto-commit, one choke point) already exist.

---

## D. Cross-cutting

### JS/TS/node contamination (#12, #16, #18) — where it originates

Four compounding sources, all traced:

1. **The dev prompt orders a Node build on every project.** `dev-story.ts:305` (verified): `verify_command = pack.manifest.verifyCommand ?? 'npx turbo build'` — the bundled pack manifest sets no `verifyCommand`, so every dev prompt on the Python project said *"Run the project build to verify type checking: `npx turbo build`"* (`dev-story.md:53`). An obedient agent scaffolds a JS toolchain **to satisfy its own instructions**. This is the single most direct cause of #12/#16/#18.
2. **No stack declaration anywhere in the prompts.** The dev prompt never states the project's language; the create-story prompt is TS-flavored (`create-story.md:85-93` "TypeScript interfaces, Zod schemas", `:137` npm scripts, `:162` tsconfig). Story artifacts inherit TS vocabulary on any project.
3. **The project-type lock exists but is disconnected.** `.substrate/project-profile.yaml` carries `language`/`buildTool`/`buildCommand`/`testCommand` (written by init with a real detector that even orders `pyproject.toml` *above* `package.json` and handles `.venv` activation — `detect.ts:40-99,313-337`). Three gaps neuter it: the verification BuildCheck never reads it (§A); **it's gitignored** (`substrate-gitignore.ts:24-25` negates only `config.yaml`) so it's absent from every worktree where dispatch/verification actually run — all consumers silently fall back to Node-leaning defaults there; staleness is a post-run advisory only (`:6190-6204`). Related Node-default strays: `shouldRunTscCheck` returns true when no profile (`contract-verifier.ts:39`); `package-snapshot.ts:118-122` defaults to `npm install`; `DEFAULT_VERIFY_COMMAND = 'npm run build'` (`agent-dispatch/dispatcher-impl.ts:102`).
4. **The commit trusts `.gitignore` that doesn't exist.** `commitDevStoryOutput` stages the changed-file list with no denylist — the comment at `git-helpers.ts:61-64` explicitly delegates node_modules/dist exclusion to `.gitignore`. On a Python repo there's no `node_modules/` gitignore entry, `git status --porcelain` reports the untracked `node_modules/` directory (via the fallback `getGitChangedFiles`, `git-helpers.ts:325-339`), `git add` stages the whole tree, and merge lands 1,885 files on main. The single protective layer is exactly the layer cross-language contamination removes.

**Minimal guard set (all WIRING)**: fix the `verify_command` fallback (1 line); negate `project-profile.yaml` in the gitignore writer (or copy it into worktrees at creation); add a denylist (`node_modules/`, `dist/`, `.venv/`, `__pycache__/`) in the commit filter; add a `{{project_stack}}` prompt section from the profile; add a deterministic contamination check (fail on source files in a language outside the profile, or on denylisted paths in the diff).

### Auth misclassification (#10) and the fast-fail cascade (#7)

- **Classification**: the literal field string "create-story succeeded but returned no story_file path" is `orchestrator-impl.ts:1953`. **No auth-signature scanning exists anywhere** — but the pattern to copy does: `detectCodexSandboxBlock` (`:1941`) + `CODEX_SANDBOX_BLOCK_HINT` (`:1960-1966`). An auth failure falls into whichever generic bucket its shape lands in: non-zero exit → `create-story-failed` with raw stderr; exit-0 short refusal → schema-validation / no-file; hang → the create-story default timeout, which is exactly `600_000` ms (`packages/core/src/dispatch/types.ts:182`). qualityScore 40 = the failed-story score cap (`mesh-reporter.ts:636-640`). Every #10 symptom is a generic-path artifact.
- **The env-scrub half of the ask already ships**: `claude-adapter.ts:282-287` unsets `ANTHROPIC_API_KEY` whenever `billingMode !== 'api'`, and the dispatcher hardcodes `billingMode: 'subscription'` (`dispatcher-impl.ts:603`) — since v0.10.0. Residual leak paths: **`buildPlanningCommand` returns no `unsetEnvKeys` at all** (`claude-adapter.ts:365-393`); keys configured inside Claude Code's own settings (outside substrate's control); and note the routing engine's api-billing decisions (`routing-engine-impl.ts:339-368`) are never plumbed into `buildCommand` — the hardcoded literal makes them dead on this path.
- **#7 (first create-story succeeds, rest fail in ~15s/~350 tokens)** — best code-grounded hypothesis: a **shared `~/.claude` OAuth-state race under uncoordinated concurrent spawns**. Substrate deliberately scrubs the API key, forcing every spawned CLI onto the shared OAuth credential file; if a token refresh happens at run start, the first instance rotates the refresh token and subsequent instances fail auth fast with a short error — which, with no auth classifier (#10), surfaces as exactly `create-story-no-file`. This also explains the field's "auth onset mid-run" wrinkle. Anchors: uncoordinated spawns `dispatcher-impl.ts:645` with concurrency batching `orchestrator-impl.ts:6075-6084`; no stderr classification `:922-949`. Secondary suspect: substrate injects `NODE_OPTIONS --max-old-space-size=512` into the spawned `claude` CLI itself (`dispatcher-impl.ts:628-633`) — worth ruling out. **First diagnostic step**: persist `stderrTail` on non-timeout dispatch failures (the `spawnsync-timeout` path already does, `:758-771`).
- Interaction with leaked/uncommitted work: an auth-failed dev dispatch is indistinguishable from a lazy agent today, so operators (or Tier-A retry) re-dispatch into worktrees that may hold prior partial work — the `decideWorktreeReclaim` guard (`git-utils.ts:224-239`) is what stands between that and silent loss; commit-first (C-1) removes the risk class entirely.

---

## Prioritized remediation table

Effort: S = ≤half-day, M = 0.5–1.5 days, L = 2–4 days. Every item is CONFIG or WIRING; none is a rewrite.

| # | Fix | Closes | Class | Effort | Anchors |
|---|---|---|---|---|---|
| **P0-1** | **Commit-first discipline**: auto-commit dev output to the story branch immediately after dev-story returns (before review/verify); `wip(…)` checkpoint commit on every escalation/VERIFICATION_FAILED path; persist `baselineHeadSha`+`commit_sha` bracket | #17, #19, #1 (partial); adopts BMAD commit-local + bracketing | WIRING | M | `orchestrator-impl.ts:3249` (insertion), `:4012-4033` (Path D), `:4629-4635` (existing call to relocate), `git-helpers.ts:55` |
| **P0-2** | **Unify finalization across verdict paths**: extract the commit/merge block (`:4615-4852`) into a helper called from Path A *and* both auto-approve sites | #1, #14 | WIRING | M | `orchestrator-impl.ts:4475`, `:4988-4989`, `:5223-5224` |
| **P0-3** | **`finalization.mode: merge\|branch\|pr` config** — never-self-merge enforcement; emit `story:merged`/`story:finalized` events | #14, #16 (blast radius), non-negotiable 3 | CONFIG+WIRING | M–L | `merge-to-main.ts:91`, `orchestrator-impl.ts:4800-4810`, `config-schema.ts:128-160` |
| **P0-4** | **Git-state scoping at spawn**: scrub `PWD`/`OLDPWD`/`INIT_CWD`/`GIT_*`, set `GIT_CEILING_DIRECTORIES`; optionally move worktree base outside the repo (fix `git-utils.ts:248` hardcode) | #15, #17 (root), tracker #57847/#55708 class | WIRING | M | `packages/core/src/dispatch/dispatcher-impl.ts:626-648`, `git-utils.ts:248` |
| **P1-5** | **Real test-suite verification stage**: new Tier-A check running profile `testCommand` (e.g. `uv run pytest`) in the worktree; fail on red | #11, #13 (partial), non-negotiable 1 | WIRING | M–L | new check beside `build-check.ts`; `project-profile/schema.ts:43-44`; registration `verification-pipeline.ts:197-212` |
| **P1-6** | **Probe env**: wrap/prefix probe commands from the project profile (venv activation / `uv run`), or shape `env.PATH`/`VIRTUAL_ENV` | #6 | WIRING | S | `probes/executor.ts:204-224`, `runtime-probe-check.ts:350-358` |
| **P1-7** | **BuildCheck**: read project profile first; reorder `pyproject.toml` above `package.json`; add missing-script exemption (mirror gate B) | #12 | WIRING | S | `build-check.ts:67-97,121-124`; `verification-integration.ts:69-95` |
| **P1-8** | **Ship the profile into worktrees**: negate `project-profile.yaml` in gitignore writer (or copy at `createWorktree`) | enabler for 5–7; #12/#18 (partial) | WIRING | S | `substrate-gitignore.ts:24-25`; `git-worktree-manager-impl.ts:166-198` |
| **P1-9** | **Kill the `npx turbo build` prompt fallback**: derive `verify_command` from profile; add `{{project_stack}}` section to dev prompt | #12, #16, #18 (root cause) | CONFIG now (`verifyCommand: false` in manifest) + 1-line WIRING | S | `dev-story.ts:305`; `dev-story.md:53`; `manifest.yaml` |
| **P1-10** | **Commit denylist**: filter `node_modules/`, `dist/`, `.venv/`, `__pycache__/` in the commit path regardless of `.gitignore` | #18 | WIRING | S | `git-helpers.ts:65-77,325-339` |
| **P1-11** | **Net-new-implementation gate**: fail non-trivial stories whose ground-truth diff has no non-markdown source/test change | #13 | WIRING | M | `orchestrator-impl.ts:3239-3339`; diff already at `:3247` |
| **P1-12** | **Language/scope contamination check**: fail on new source files in a language outside the profile, or denylisted paths in the diff | #12, #16, #18 (detection), project-type lock | WIRING | M | new check; profile `language`; `checks/index.ts` |
| **P1-13** | **Auth classifier + halt**: `detectClaudeAuthFailure` over dispatch output (mirror `detectCodexSandboxBlock`); route as critical through Decision Router; add `unsetEnvKeys` to `buildPlanningCommand` | #10, #7 (surfacing) | WIRING | M | `orchestrator-impl.ts:1941-1975`; `claude-adapter.ts:365-393`; `decision-router/index.ts:40` |
| **P2-14** | **#7 diagnostics**: persist `stderrTail` on all dispatch failures; then serialize first-dispatch-per-run or mutex CLI auth refresh if H1 confirms | #7 | WIRING | S (diag) | `dispatcher-impl.ts:758-771,922-949` |
| **P2-15** | Gherkin AC parser (G/W/T scenarios → AC ids); make `ac-context-missing` louder | #8 | WIRING | S–M | `acceptance-criteria-evidence-check.ts:24-25,117-154,206-219` |
| **P2-16** | Structure-vs-architecture conformance check (new top-level roots / second persistence layer vs. declared architecture doc) | #16 (deeper), field 1-1 notes | WIRING+design | L | new check; `source-ac-fidelity-check.ts` as substrate |
| **P2-17** | Dirty-guard before `git worktree remove --force`; wire `trivialOutputThreshold` config; `uv` detection in profile detector | #19 belt-and-braces; hygiene | WIRING | S each | `git-utils.ts:402-414`; `orchestrator-impl.ts:902-905`; `detect.ts:82-89` |

Suggested sequencing: **P0-1 → P0-2 → P1-9+P1-8+P1-7 (one afternoon together) → P1-5+P1-6 → P0-3 → P0-4 → the rest.** P0-1/2 stop the bleeding (work loss, silent no-commit success); the P1 cluster restores verification trust; P0-3/4 make unattended runs safe.

---

## The single highest-leverage change

**P0-1: commit dev output to the story branch the moment dev-story returns — and checkpoint-commit on every failure path.**

Rationale over the alternatives: the verification fixes (P1-5..12) improve *judgment*; commit-first changes the *physics*. It converts every failure mode in the field report from destructive to recoverable — #17 and #19 (work permanently destroyed) become impossible, #1 degrades from "operator hand-lands from a dirty worktree" to "operator merges a committed branch", the #15 leak loses its data-loss sting (the branch is always the source of truth, so leak cleanup is always safe), and re-dispatch/reclaim logic gets a reliable substrate. It is also the smallest of the P0s (~relocating one existing call + one new call site + persisting one SHA), it's exactly the BMAD `commit-local` primitive the research flagged, and it makes every subsequent fix safer to develop against. If only one change ships this week, ship this one.

(If the question is instead "which change most improves *output quality*": P1-5, real-suite execution — it's the industry-consensus fix and the direct antidote to #11/#13.)

---

## Trivial patches (proposed)

### Patch 1 — BuildCheck ordering + missing-script parity (#12)

```diff
--- a/packages/sdlc/src/verification/checks/build-check.ts
+++ b/packages/sdlc/src/verification/checks/build-check.ts
@@ export function detectBuildCommand(workingDir: string): string {
   // Priority 1: turbo.json
   if (existsSync(join(workingDir, 'turbo.json'))) {
     return 'turbo build'
   }
+  // Priority 2: non-Node root manifests. Checked BEFORE any Node marker so a
+  // stray package.json scaffolded into a Python/Rust/Go repo cannot flip the
+  // project to `npm run build` (field finding #12; mirrors the ordering that
+  // agent-dispatch/dispatcher-impl.ts detectPackageManager already uses).
+  const nonNodeMarkers = ['pyproject.toml', 'poetry.lock', 'setup.py', 'Cargo.toml', 'go.mod']
+  for (const marker of nonNodeMarkers) {
+    if (existsSync(join(workingDir, marker))) {
+      return ''
+    }
+  }
   // Priority 2: pnpm-lock.yaml
   if (existsSync(join(workingDir, 'pnpm-lock.yaml'))) {
     return 'pnpm run build'
@@
   // Priority 5: package.json (no turbo/lockfile match above)
   if (existsSync(join(workingDir, 'package.json'))) {
     return 'npm run build'
   }
-  // Non-Node build markers: no universal build step, skip
-  const nonNodeMarkers = ['pyproject.toml', 'poetry.lock', 'setup.py', 'Cargo.toml', 'go.mod']
-  for (const marker of nonNodeMarkers) {
-    if (existsSync(join(workingDir, marker))) {
-      return ''
-    }
-  }
   // Nothing found
   return ''
 }
```

(Full fix also plumbs `pack.manifest.verifyCommand` / project-profile `buildCommand` into `context.buildCommand` via `assembleVerificationContext` — the override at `build-check.ts:121-124` already honors it.)

### Patch 2 — kill the Node prompt fallback (#12/#16/#18 root)

```diff
--- a/src/modules/compiled-workflows/dev-story.ts
+++ b/src/modules/compiled-workflows/dev-story.ts
@@
-    { name: 'verify_command', content: deps.pack.manifest.verifyCommand !== false ? (deps.pack.manifest.verifyCommand ?? 'npx turbo build') : '', priority: 'optional' },
+    // No hardcoded Node fallback: on non-Node projects `npx turbo build` in the
+    // prompt instructs the agent to scaffold a JS toolchain (field #12/#16/#18).
+    // Resolution: pack manifest verifyCommand, else the project profile's
+    // buildCommand, else omit the verify step entirely.
+    { name: 'verify_command', content: deps.pack.manifest.verifyCommand !== false ? (deps.pack.manifest.verifyCommand ?? resolveVerifyCommand(deps.projectRoot)) : '', priority: 'optional' },
```

with `resolveVerifyCommand` reading `.substrate/project-profile.yaml` `project.buildCommand` (same pattern as `resolveInstallCommand` in `install-command.ts:19-61`), returning `''` when absent. Interim zero-code mitigation: set `verifyCommand: false` in `packs/bmad/manifest.yaml` for non-Node consumers.

### Patch 3 — commit denylist (#18)

```diff
--- a/src/modules/compiled-workflows/git-helpers.ts
+++ b/src/modules/compiled-workflows/git-helpers.ts
@@ export async function commitDevStoryOutput(
+  // Paths substrate never commits, regardless of the project's .gitignore —
+  // the .gitignore-based protection assumed below does not exist on projects
+  // where a cross-language toolchain was scaffolded (field finding #18:
+  // 1,885 node_modules/dist files merged to main on a Python repo).
+  const COMMIT_DENYLIST = /(^|\/)(node_modules|dist|build|\.venv|__pycache__|\.substrate-worktrees)(\/|$)/
   const insideWorktree: string[] = []
   for (const p of filesModified) {
     const abs = isAbsolute(p) ? p : resolvePath(workingDir, p)
     const rel = relativePath(workingDir, abs)
     if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
       logger.debug({ path: p, abs, workingDir }, 'commitDevStoryOutput: filtered out path outside worktree')
       continue
     }
+    if (COMMIT_DENYLIST.test(rel)) {
+      logger.warn({ path: rel }, 'commitDevStoryOutput: denylisted artifact path excluded from substrate commit')
+      continue
+    }
     insideWorktree.push(rel)
   }
```

(`dist/` may be legitimate in some stacks — gate the denylist on the profile language, or make it configurable, in the real PR.)

### Patch 4 — ship the profile into worktrees (enabler)

```diff
--- a/src/cli/commands/substrate-gitignore.ts
+++ b/src/cli/commands/substrate-gitignore.ts
@@
 .substrate/*
 !.substrate/config.yaml
+!.substrate/project-profile.yaml
```

(Plus `substrate init` messaging to commit it. Alternative if the profile should stay untracked: copy it into the worktree in `createWorktree` alongside the existing `worktreeCopyFiles` mechanism.)

### Patch 5 — checkpoint commit on verification failure (#17, sketch)

At `orchestrator-impl.ts` immediately before the VERIFICATION_FAILED state write (`:4012`) and each escalation `updateStory(… ESCALATED …)` on the dev path:

```ts
// #17: the branch must always be the recoverable source of truth. Without
// this, verification-failed work exists only as a dirty worktree and any
// force-cleanup destroys the sole copy.
if (effectiveProjectRoot !== undefined) {
  const dirty = await getGitChangedFiles(effectiveProjectRoot)
  if (dirty.length > 0) {
    await commitDevStoryOutput(storyKey, `wip: ${escalationKind} snapshot`, dirty, effectiveProjectRoot)
  }
}
```

(Real PR: distinct `wip(story-…)` message prefix so reconcile-from-disk and merge tooling can tell checkpoints from `feat(…)` deliverables.)

---

## Research-claims scorecard (verified against source)

| Claim | Verdict |
|---|---|
| "Verification runs the wrong toolchain / never the real suite" | **Confirmed** — two divergent detectors, no test execution anywhere, probes in parent env (§A) |
| "Worktree isolation is filesystem-only; cwd/GIT_DIR unscoped" | **Confirmed** — cwd is the only scoping; zero `GIT_*` handling; nested worktrees; `--dangerously-skip-permissions` (§B) |
| "Finalization non-deterministic; self-merge ungated" | **Confirmed, refined** — deterministic routing on the reviewer verdict; commit+merge exists on exactly 1 of 4 paths; no merge config key (§C) |
| "Substrate under-uses BMAD v6 bmad-dev-auto primitives (commit-local, bracketing, block-on-fail)" | **Confirmed with nuance** — zero dev-auto references; block-on-fail is reimplemented and present; bracketing half-built; commit-local absent. Adoption = WIRING, not architecture (§C.4) |
| "Fixable by configuration vs rewrite?" (report's open question) | **Answered**: ~2 items are CONFIG today (profile `buildCommand`; pack `verifyCommand: false`), everything else WIRING; no rewrites (table above) |
| "Container isolation strictly dominates; swap without rewriting supervisor?" | **Qualified yes** — bounded swap behind `GitWorktreeManager` + adapter transport *iff* bind-mounted path; no-shared-fs backend would be a rewrite of ~15 direct-fs call sites (§B) |
