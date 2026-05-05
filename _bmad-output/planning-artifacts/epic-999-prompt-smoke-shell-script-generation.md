# Smoke Fixture: Shell-script Generation AC for Prompt-Edit Ships

**Purpose:** Empirical smoke fixture used by `.claude/commands/ship.md`
Step 4.5 (prompt-edit empirical smoke) to validate that substrate's
`create-story` prompt + `probe-author` prompt produce the structural
property targeted by Epic 67 — when an AC describes a shell-script
generator (git hook, install wrapper, lifecycle script), the rendered
story must contain a `## Runtime Probes` section AND that section
must invoke the canonical user trigger (e.g., `git push` for pre-push
hooks) in a fresh fixture project (`mktemp -d`-style), NOT direct-call
the generated script with synthetic inputs.

**Failure shapes covered:**

- **obs_2026-05-03_023** (verification accepts shell-out code without
  end-to-end fixture execution) — rendered story for a shell-script
  generator AC should signal the class via `## Runtime Probes` section
  whose probes use `mktemp -d` + a canonical user trigger (`git push`,
  `npm install`, etc.) and assert observable post-conditions
  (filesystem state, command output) rather than just exit codes from
  direct script invocation.

**Lifecycle:** the smoke step ingests this epic and dispatches Story
999-1, then cleans up both the `wg_stories` row and the rendered
artifact afterward. The fixture file itself is durable.

**Why ONE shell-script generation AC (minimum-viable scope):**

Per the lessons from prior 999-* fixtures (Phase 4 architectural fixture
took >30 min when authored as 7 ACs), this fixture has exactly ONE AC
describing a `pre-push` hook generator that archives findings to a
local `.findings/history.jsonl` file. The structural assertion is on
the rendered story:

1. `## Runtime Probes` section is present
2. The probes section's command body contains `mktemp -d` (fresh fixture)
3. The probes section's command body contains `git push` (canonical user
   trigger for a pre-push hook, NOT `bash hook.sh` direct invocation)
4. The probes section's assertion targets an observable post-condition
   (presence of `history.jsonl` file or its content), NOT just an exit
   code from the script

If a future prompt-edit ship needs to cover other shell-script
generation classes (lifecycle scripts, systemd units, wrapper scripts),
author a sibling fixture (`epic-999-prompt-smoke-shell-script-systemd.md`,
etc.) with the appropriate AC shape.

---

## Story Map

- 999-1: Pre-push hook generator smoke (P0, Small)

## Story 999-1: Pre-push hook generator smoke

**As a** substrate prompt-edit smoke fixture for shell-script generation
signals,
**I want** an acceptance criterion that describes generating a `pre-push`
git hook in the user's project, where the hook runs a finding emitter
and archives the output,
**So that** Epic 67 stories 67-1 (create-story signals) and 67-2
(probe-author shapes) are empirically validated — the rendered story
must contain a `## Runtime Probes` section whose probes invoke the
canonical user trigger (`git push`) in a fresh fixture project
(`mktemp -d`) rather than direct-calling the generated hook with
synthetic inputs.

### Acceptance Criteria

#### AC1: Pre-push hook generator installs and archives findings on real push

**Given** the project's `vg install` command has been run from a fresh
project install (no global packages, no prior `.git/hooks/pre-push`
file),

**When** the user runs `git push origin main` after staging changes
that contain at least one violation eligible for the finding emitter,

**Then** the implementation has generated a `.git/hooks/pre-push`
script that:

- runs `node <absolute-path-to-emitter>` (NOT `npx <package>` and NOT
  bare PATH lookup) against the project's source files
- pipes the emitter's stdout into the archive command via a stable
  contract (e.g., `--output-file` flag or stdin/stdout pipe), NOT via
  parsed prefix lines
- writes findings to `.findings/history.jsonl` (one JSON record per
  line, append-only)
- exits 0 when no violations are found AND when violations are
  archived successfully (so `git push` proceeds)
- the archived `.findings/history.jsonl` file is observable in the
  user's project root after the push (assertion target for the canonical
  invocation runtime probe)

**The rendered story for this AC must include a `## Runtime Probes`
section whose probes:**

- create a fresh fixture project via `mktemp -d` (NOT use substrate's
  own working tree)
- initialize the fixture as a real git repo (`git init`, configure
  `user.email` + `user.name`, `git commit` initial state)
- run the canonical install (`node <REPO_ROOT>/dist/cli.js vg install`
  or equivalent) inside the fresh fixture
- trigger the canonical user-facing event (`git push`, against a local
  bare remote — `git init --bare`)
- assert observable post-condition: `test -f .findings/history.jsonl`
  AND content matches expected finding shape
- NOT direct-call the generated hook (`bash hook.sh`) with synthetic
  inputs

### Tasks / Subtasks

(Smoke fixture — dev-story dispatch is not the assertion target. The
structural assertion is on the rendered story file: presence of `##
Runtime Probes` section, `mktemp -d` in command body, `git push` as
canonical trigger, observable post-condition assertion. Cleanup after
smoke: `dolt sql -q "DELETE FROM wg_stories WHERE epic = '999';"` and
`rm _bmad-output/implementation-artifacts/999-*.md`.)
