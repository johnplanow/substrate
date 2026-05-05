# Epic 67: Shell-script Generation Canonical-Invocation Coverage

## Vision

Close **obs_2026-05-03_023** by extending substrate's authoring-time
prompts and verification-time heuristics to recognize **shell-script
generation** as a distinct AC class requiring a canonical-invocation
runtime probe. Currently, ACs whose deliverable is a generated shell
script (git hook, install wrapper, npm-publish script) ship through
every verification gate even when the script contains real defects
(dependency-confusion attack vectors, bare PATH lookups, missing
recursion flags) because:

1. Unit tests mock filesystem operations and never observe the
   generated script's content
2. Existing probes direct-call the implementation rather than
   triggering the canonical user invocation (e.g., `bash hook.sh
   <fixture>` rather than `git push` against a real fixture project)
3. No verification heuristic detects shell-out anti-patterns
   (`npx <package>` without `--no-install`, bare PATH lookups)
   in modified files

Epic 67 closes the class structurally via three coordinated layers:
- **create-story prompt** signals the class so probes are required
- **probe-author prompt** teaches the canonical-invocation probe shape
- **source-ac-fidelity heuristic** catches the most common shell-out
  anti-pattern (`npx <name>` dependency-confusion vector) at
  verification time as a safety net

## Root cause it addresses

obs_2026-05-03_023 surfaced the failure mode: strata Stories 3-3 + 3-4
(pre-push hook generator + history.jsonl archive) shipped LGTM_WITH_NOTES
through every substrate verification gate (build, AC-evidence,
source-ac-fidelity, runtime-probes) with **four distinct defects** in
the generated `pre-push` hook:

1. **Security**: `npx strata` and `npx depcruise` fallbacks. On a fresh
   project install with no global binary, npm fetches a package literally
   named `strata` from the public registry (an unrelated, possibly
   squatter package) and executes it during `git push`. Confirmed
   empirically: `npx strata` pulled a remote squatter that started a
   web server on port 1982.
2. **Functional**: bare `strata` binary invocation (assuming PATH lookup),
   not absolute path. Without `npm install -g`, the hook never ran the
   real emitter.
3. **Functional**: depcruise invoked with `.` source-set — depcruise 17.x
   doesn't recurse from a bare directory. `totalCruised: 0` on every push.
4. **Architectural**: hook called only `emit-findings` (stdout output);
   the archive (Story 3.4's deliverable) was never invoked. AC4 ("findings
   archived") could not be satisfied by the as-shipped hook.

All four would have been caught by a probe that ran:
```bash
mktemp -d $TMP
cd $TMP && npm init -y && git init && git remote add origin <fixture>
# install canonical user-facing way
node /path/to/strata/dist/cli.js vg install
# trigger canonical user invocation
git push origin main
# assert observable post-condition
test -f .findings/history.jsonl
```

The probe ran **none of this**. Or no probe was authored at all. The
probe section, if any, called the implementation directly with synthetic
inputs.

This is structurally similar to **obs_2026-04-26_014** (post-merge git
hook direct-called rather than triggered via `git merge`) which shipped
`runtime-probe-missing-production-trigger` warn→error. obs_023's facet
adds a layer: the production trigger is `git push` (not `bash hook.sh`),
AND the probe must run in a fresh fixture project (not in substrate's
own working tree where global packages may exist).

## Why now

Three converging signals:

1. **obs_023 is the highest-severity remaining open obs** in the queue.
   The dependency-confusion vector (`npx <package>`) is a real security
   issue, not just a correctness bug. Every consumer dispatch of a
   shell-script-generating AC carries this risk until the gate is in
   place.

2. **Pattern-recognition argument**. Three observations in the same
   family closed in three weeks (obs_017 trigger-class, obs_018
   fixture-shape, obs_023 transport-layer). Each closes a different
   blind spot in substrate's "the LLM said it works" trust budget.
   obs_023 is the natural completion of the arc.

3. **Strata Phase D coming up**. Future strata stories that generate
   shell scripts (CI/CD wrappers, deployment hooks, cron jobs) will
   ship with the same blind spot until Epic 67 closes it. Every shipped
   defect of this class costs ~30 min of manual smoke-fix-forward
   (strata 3-3 + 3-4 cost exactly that).

## Story Map

- 67-1: create-story prompt extension for shell-script generation signals (P0, Medium)
- 67-2: probe-author prompt extension for canonical-invocation probe shapes (P0, Medium)
- 67-3: source-ac-fidelity npx-fallback static-analysis heuristic (P0, Small)

Three stories, single sprint, dispatched concurrently (substrate
concurrency=3 fits exactly). Total expected wall-clock 30-60 min.

## Story 67-1: create-story prompt extension for shell-script generation signals

**Priority**: must

**Description**: Extend `packs/bmad/prompts/create-story.md`'s
"Behavioral signals" section (added Story 60-4 / v0.20.42, extended
v0.20.44) with a new **Shell-script generation signals** subsection.
The current signals (subprocess execSync/spawn, filesystem fs.read*,
git, database, network, registry) cover modules that *invoke* external
state. Shell-script generation is the inverse: modules that *emit*
shell scripts to be invoked by external tools (git's hook subsystem,
npm's lifecycle scripts, systemd's unit machinery, podman build).

Detection signals (scan for any of):

- **Hook generators**: `pre-push`, `post-merge`, `pre-commit`, `post-commit`,
  `post-rewrite` git hooks; `husky` configurations; `.git/hooks/*` writes
- **Install scripts**: `vg install`, `<binary> install`, "installs the X
  hook", "writes the X script", "generates a wrapper for"
- **Lifecycle scripts**: npm `prepublish`, `postinstall`, `prepare` script
  generation; package.json scripts written by code
- **Service generators**: systemd `.service` / `.timer` unit file
  generation, podman/docker image build scripts
- **Wrapper scripts**: shell wrappers around binaries
  (`#!/bin/sh\nexec node $@`-shape generators)

Phrase patterns: "writes a hook", "generates a script", "installs a
pre-push hook", "creates a wrapper", "emits a shell script", "writes
to .git/hooks/", "creates a systemd unit".

When any of these signals fires, the story MUST include a `## Runtime
Probes` section. The probes must invoke the **canonical user trigger**
(e.g., `git push` for pre-push hooks, `npm install` for postinstall
scripts) in a fresh fixture project, not direct-call the script with
synthetic inputs.

**Acceptance Criteria**:

1. `packs/bmad/prompts/create-story.md` extended with "Shell-script
   generation signals" subsection in the "Behavioral signals" area
   (after the existing 6 state-integration signal categories).
2. The subsection enumerates ≥5 signal types (hook generators, install
   scripts, lifecycle scripts, service generators, wrapper scripts) and
   ≥6 phrase patterns.
3. The subsection cites obs_2026-05-03_023 + strata 3-3+3-4 incident
   inline as motivation, mirroring Story 60-4 / 60-10's convention for
   citing motivating incidents.
4. The subsection ends with a clear rule: "if any shell-script generation
   signal fires, the story MUST include a `## Runtime Probes` section
   that invokes the canonical user trigger in a fresh fixture project,
   not direct-call the script."
5. Tests in `src/modules/compiled-workflows/__tests__/create-story.test.ts`:
   (a) prompt content includes the new subsection heading + the 5 signal
   types + the rule; (b) methodology-pack token-budget assertion bumped
   to accommodate the new content.
6. Step 4.5 prompt-edit smoke validated empirically: dispatch fixture
   epic-999-prompt-smoke-shell-script-generation.md story 999-1 (provided
   by Story 67-2 alongside its own probe-author smoke), inspect rendered
   story file, assert `## Runtime Probes` section is present AND mentions
   `mktemp -d` AND a canonical user trigger pattern.
7. Commit message references obs_2026-05-03_023 fix #2 (create-story
   prompt enforce probe section for shell-out boundaries).

**Files involved**:
- `packs/bmad/prompts/create-story.md` (subsection added)
- `src/modules/compiled-workflows/__tests__/create-story.test.ts` (tests)
- (Smoke fixture authored by Story 67-2 — see below)

## Story 67-2: probe-author prompt extension for canonical-invocation probe shapes

**Priority**: must

**Description**: Extend `packs/bmad/prompts/probe-author.md` with a new
**Shell-script generation probe shapes** subsection (parallel to the
existing state-integration probe shapes added Story 65-5 / v0.20.53).
The existing prompt has production-trigger guidance (Story 60-10) that
enumerates `post-merge` / `pre-push` / webhook trigger mappings, but
doesn't capture the structural requirement: shell-script-generation
probes must run in a **fresh fixture project**, not the orchestrator's
own working tree.

The fresh fixture is critical because: (1) the orchestrator's working
tree may have global state (installed binaries, config files) that
the production user environment doesn't; (2) the canonical user invocation
runs in their project root, not substrate's; (3) defects like
dependency-confusion (`npx <name>`) only manifest when no local binary
exists.

The probe shape:

```yaml
- name: pre-push-hook-fires-on-real-push-and-archives-findings
  sandbox: twin
  command: |
    set -e
    FIXTURE=$(mktemp -d)
    cd "$FIXTURE"
    npm init -y >/dev/null
    git init -q
    git config user.email t@example.com && git config user.name test
    # install via canonical user invocation (no global packages)
    node <REPO_ROOT>/dist/cli.js vg install
    # produce a finding-eligible change
    echo "import x from 'lodash';" > src/bad.ts
    git add . && git commit -qm "initial"
    # trigger canonical user-facing event
    git remote add origin "$(mktemp -d -u)"
    git init --bare -q "$(git remote get-url origin)"
    git push origin main 2>&1 || true  # push fails (no upstream); hook still runs
    # assert observable post-condition
    test -f .findings/history.jsonl && echo "ARCHIVE_PRESENT" || echo "ARCHIVE_MISSING"
  expect_stdout_regex: ARCHIVE_PRESENT
```

Three rules to enforce:

1. **Fresh fixture in `mktemp -d`** — never run against substrate's
   own project tree
2. **Canonical user trigger** — `git push` for pre-push hook, `npm
   install` for postinstall, NOT direct script invocation
3. **Observable post-condition** — assert filesystem / process state
   the user would observe, not just exit code

**Acceptance Criteria**:

1. `packs/bmad/prompts/probe-author.md` extended with "Shell-script
   generation probe shapes" subsection (parallel to existing
   state-integration shapes).
2. Subsection includes ≥1 worked example showing fresh-fixture setup
   + canonical trigger + observable post-condition (the strata 3-3
   pre-push hook scenario above is the canonical example).
3. Subsection enumerates the three rules (fresh fixture, canonical
   trigger, observable post-condition) with rationale for each.
4. Subsection cites obs_2026-05-03_023 + strata 3-3+3-4 incident
   inline as motivation per Story 60-10/65-5 convention.
5. Tests in `src/modules/compiled-workflows/__tests__/probe-author.test.ts`:
   prompt content includes the new subsection + the three rules; budget
   assertion bumped if needed.
6. Smoke fixture authored at `_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md`
   with story 999-1: AC describes a pre-push hook generator that
   archives findings to `.findings/history.jsonl`. Story 67-1's smoke
   step (AC6) consumes this fixture.
7. Commit message references obs_2026-05-03_023 fix #1 (verification
   gate fresh-fixture canonical-invocation probe class — partial; the
   structural primitive is deferred but the prompt-side guidance ships).

**Files involved**:
- `packs/bmad/prompts/probe-author.md` (subsection added)
- `src/modules/compiled-workflows/__tests__/probe-author.test.ts` (tests)
- `_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md` (smoke fixture, NEW)

## Story 67-3: source-ac-fidelity npx-fallback static-analysis heuristic

**Priority**: must

**Description**: Add a static-analysis heuristic to substrate's
verification phase that catches the most common shell-out anti-pattern
(`npx <package>` without `--no-install`) in modified files. This is
the safety net for cases where 67-1 + 67-2 prompt-side guidance fails
to fire (or is misapplied).

The heuristic scans **only the dev-story's modified files** (not the
whole tree) for shell-string-context occurrences of `npx <name>` patterns
where `<name>` is not preceded by `--no-install`. Emits a new finding
category `source-ac-shellout-npx-fallback` at severity `warn` with a
clear message naming the file + line + the matched `<name>`.

Severity is `warn` (not `error`) initially per defensive-rollout
discipline: this is a new heuristic with unknown false-positive shape
in real consumer dispatches. Escalation to `error` follows the
Story 60-16 pattern (post-eval-confidence promotion). A future story
could add eval coverage and flip severity if false-positive rate stays
low.

**Detection rules:**

- Pattern: `/npx\s+(?!--no-install)([a-zA-Z0-9_@\-/]+)/`
- Context filter: only fires when match is in a string-literal context
  (single-quoted string, double-quoted string, template literal, or
  inside a `#!/bin/sh`-shape script — i.e., shell-string-context)
- Modified-files filter: only scans paths returned by `git diff --name-only`
  for the dispatch's working state
- Skip: matches inside `.md` files (documentation references to `npx`
  are not exploitable)
- Skip: matches preceded by `# ` or `// ` (commented out)

**Acceptance Criteria**:

1. New file `packages/sdlc/src/verification/checks/source-ac-shellout-check.ts`
   exporting `runShelloutCheck(input)` matching the existing check shape
   (consult `runtime-probe-check.ts` or `source-ac-fidelity-check.ts`
   for the contract).
2. Check registered in the verification pipeline (likely
   `packages/sdlc/src/verification/checks/index.ts` or wherever the
   check registry lives).
3. New finding category `source-ac-shellout-npx-fallback` declared in
   `packages/sdlc/src/verification/findings.ts`. Severity `warn`.
4. Detection rules implemented per spec above:
   - `npx <name>` matches fire (positive test)
   - `npx --no-install <name>` does NOT fire (negative test)
   - `npx <name>` in `.md` file does NOT fire (skip rule test)
   - `npx <name>` in commented-out line does NOT fire (skip rule test)
   - Match outside string-literal context does NOT fire (e.g., bare
     prose in code comment) (skip rule test)
5. Tests in `packages/sdlc/src/__tests__/verification/source-ac-shellout-check.test.ts`
   covering ≥6 cases (the 5 above + 1 obs_023 reproduction case using
   the strata 3-3 hook content as fixture).
6. Finding message format: `npx fallback detected in ${file}:${line}:
   "npx ${name}" — bare \`npx <package>\` without \`--no-install\` falls
   through to the public npm registry on first use. If \`<package>\`
   isn't a registered binary in your dev dependencies, this is a
   dependency-confusion vector. Use absolute path or
   \`npx --no-install <package>\` instead.`
7. Backward-compat: existing checks continue to pass; new check is
   additive.
8. Commit message references obs_2026-05-03_023 fix #3 (severity policy
   on `npx <package>` shell-PATH-dependent invocations).

**Files involved**:
- `packages/sdlc/src/verification/checks/source-ac-shellout-check.ts` (NEW)
- `packages/sdlc/src/verification/checks/index.ts` (registry wiring)
- `packages/sdlc/src/verification/findings.ts` (new finding category)
- `packages/sdlc/src/__tests__/verification/source-ac-shellout-check.test.ts` (NEW)

## Risks and assumptions

**Assumption 1 (prompt-side fix is sufficient)**: 67-1 + 67-2 cover
the structural blind spot at authoring time. The runtime-probes check
already gates on `## Runtime Probes` section presence (Story 64-2 hard
gate, v0.20.43); once create-story signals shell-script generation,
the gate auto-fires. Risk: shell-script generation signal phrase
patterns may not catch all real-world shell-script-generation ACs
on first try; iterate based on consumer dispatch feedback.

**Assumption 2 (Surface 4 deferred is OK)**: fresh-fixture verification
primitive (suggested-fix #1) is deferred to a future Epic 68 IF Epic
67 doesn't close the class. Architect Winston's argument: probe-author
guidance + npx-detection cover the highest-leverage parts of the
class; the verification-gate-side primitive adds substantial complexity
for marginal additional coverage. Track Epic 67's effectiveness for
2-3 dispatches before deciding on Epic 68 scope.

**Assumption 3 (npx severity warn is right initial level)**: starting
with `warn` (not `error`) avoids hard-blocking dispatches on a new
heuristic before its false-positive rate is known. Promotion path
follows Story 60-16 pattern (post-eval-confidence flip). Risk: warn
findings may be ignored by consumers; mitigate by clear finding message
with exploitation path explanation (AC6 message format).

**Risk: detection over-fires.** Story 67-3's `npx <name>` regex may
match legitimate dev-tool invocations that are NOT exploitable (e.g.,
`npx playwright install` in CI scripts where the package IS a known
dev dep and `--no-install` would be inappropriate). Mitigation: the
finding is `warn` severity, not blocking; consumer can suppress per-file
via existing finding-suppression mechanism (if substrate has one) or
absorb the noise. Real-world over-fire rate measurable post-ship.

**Risk: 67-1 and 67-2 prompt edits regress probe-author quality.**
Token-budget bumps (Story 64-2 / 65-5 pattern) carry mild risk of LLM
losing focus or producing weaker probe sections. Mitigation: Step 4.5
empirical smoke (mandatory for prompt edits) catches regressions before
ship; smoke fixture targets the specific structural property the change
introduces.

## Dependencies

- **Epic 60 Phase 2** (v0.20.41) — production-trigger guidance and the
  `runtime-probe-missing-production-trigger` warn→error gate. 67-1 +
  67-2 reuse this gate for free; once the create-story signal fires,
  the gate auto-applies.
- **Epic 65 Story 65-5** (v0.20.53) — multi-resource fixture rule in
  probe-author.md. 67-2's "fresh fixture" guidance is a natural
  extension of 65-5's "production-shaped fixture" rule.
- **Epic 64 Story 64-2** (v0.20.43) — `runtime-probe-missing-declared-probes`
  hard gate. Wired to fire when `external_state_dependencies` frontmatter
  non-empty AND probes section absent. 67-1 may want to extend the
  frontmatter shape to include `shell_script_generation: true` flag —
  but the existing AC-text-scan path (Story 64-1, v0.20.42) already
  covers it without frontmatter, so probably not needed.

## Out of scope

- **Fresh-fixture verification primitive** (suggested-fix #1 from
  obs_023): scoped to Epic 68 if needed. Epic 67 provides the
  prompt-side guidance and static-analysis safety net, which together
  should close most of the class.
- **Migration of existing strata stories** that already shipped with
  shell-out defects (3-3 + 3-4): out of scope. Strata-side fix-forward
  already landed in this session; Epic 67 prevents future occurrences.
- **Eval harness for shell-script generation ACs**: parallel to Epic
  65 Story 65-3's defect corpus for state-integrating ACs. Future
  work; not required for Epic 67 ramp-up because the existing
  runtime-probes gate already provides empirical signal.
- **`npx --no-install` enforcement at runtime probe execution**: out
  of scope. This would require modifying the runtime probe executor
  to inject `--no-install` automatically — too invasive. The
  static-analysis heuristic (67-3) at authoring/verification time is
  the right layer.

## References

- obs_2026-05-03_023:
  `~/code/jplanow/strata/_observations-pending-cpo.md` lines 2216–2293
- obs_2026-05-02_018 (RESOLVED v0.20.53, Story 65-5) — multi-resource
  fixture rule, structurally related ("substrate verification accepts
  shipping code that fails canonical execution" family)
- obs_2026-04-26_014 (RESOLVED v0.20.28, Story 60-11) —
  runtime-probe-missing-production-trigger warn→error gate, the
  underlying primitive Epic 67 leverages
- Story 60-10 (v0.20.28) — production-trigger guidance in probe-author.md
- Story 65-5 (v0.20.53) — multi-resource fixture rule + state-integration
  probe shapes (parallel structure for Epic 67)

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-05 | party-mode session (jplanow + Mary + Winston + Bob + Quinn + Amelia) | open | Filed as the only remaining open substrate-targeted observation. Three-story scope (67-1 create-story signals, 67-2 probe-author shapes, 67-3 npx static analysis) covers suggested-fix-2 + suggested-fix-3 from obs_023; suggested-fix-1 (fresh-fixture verification primitive) deferred to potential Epic 68 if Epic 67 doesn't close the class. Severity for npx finding initially `warn` per defensive-rollout discipline (Story 60-16 escalation pattern). Substrate-on-substrate dispatch with `--max-review-cycles 3`. Step 4.5 prompt-edit smoke mandatory for 67-1 + 67-2 (prompt edits to packs/bmad/prompts/*.md). |
