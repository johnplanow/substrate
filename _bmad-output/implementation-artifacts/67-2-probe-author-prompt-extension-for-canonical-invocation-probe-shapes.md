# Story 67-2: probe-author prompt extension for canonical-invocation probe shapes

## Story

As a probe-author agent operating on a story whose AC describes a shell-script generator (git hook, install wrapper, lifecycle script),
I want `packs/bmad/prompts/probe-author.md` to include a "Shell-script generation probe shapes" subsection with a worked example and three enumerated rules (fresh fixture, canonical trigger, observable post-condition),
so that I generate probes that exercise the canonical user trigger in a fresh fixture project rather than direct-calling the generated script with synthetic inputs — catching dependency-confusion and wiring defects that direct invocation silently masks.

## Acceptance Criteria

<!-- source-ac-hash: df886bbc7caeef8af9f2442b4ac2b84370019f639235eef7883af99161334294 -->

1. `packs/bmad/prompts/probe-author.md` extended with "Shell-script generation probe shapes" subsection (parallel to existing state-integration shapes).
2. Subsection includes ≥1 worked example showing fresh-fixture setup + canonical trigger + observable post-condition (the strata 3-3 pre-push hook scenario above is the canonical example).
3. Subsection enumerates the three rules (fresh fixture, canonical trigger, observable post-condition) with rationale for each.
4. Subsection cites obs_2026-05-03_023 + strata 3-3+3-4 incident inline as motivation per Story 60-10/65-5 convention.
5. Tests in `src/modules/compiled-workflows/__tests__/probe-author.test.ts`: prompt content includes the new subsection + the three rules; budget assertion bumped if needed.
6. Smoke fixture authored at `_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md` with story 999-1: AC describes a pre-push hook generator that archives findings to `.findings/history.jsonl`. Story 67-1's smoke step (AC6) consumes this fixture.
7. Commit message references obs_2026-05-03_023 fix #1 (verification gate fresh-fixture canonical-invocation probe class — partial; the structural primitive is deferred but the prompt-side guidance ships).

## Tasks / Subtasks

- [ ] Task 1: Add "Shell-script generation probe shapes" subsection to `packs/bmad/prompts/probe-author.md` (AC: #1, #2, #3, #4)
  - [ ] Insert section header `## Shell-script generation probe shapes` immediately after the `## State-integration probe shapes` section (i.e., just before the `## Mission` section)
  - [ ] Write introductory motivation paragraph citing obs_2026-05-03_023 + strata 3-3+3-4 incident per Story 60-10/65-5 convention (name the observation and the incident inline)
  - [ ] Explain why the fresh-fixture requirement is critical with three rationale points: (a) the orchestrator's working tree may have global state (installed binaries, config files) that the production user environment doesn't; (b) the canonical user invocation runs in their project root, not substrate's; (c) defects like dependency-confusion (`npx <name>`) only manifest when no local binary exists
  - [ ] Enumerate three rules as a numbered list with rationale for each:
    - Rule 1 — **Fresh fixture in `mktemp -d`**: never run against substrate's own project tree; the working tree silently satisfies probes that would fail in a user's fresh environment
    - Rule 2 — **Canonical user trigger**: `git push` for a pre-push hook, `npm install` for a postinstall hook — NOT direct script invocation (`bash .git/hooks/pre-push`); direct invocation skips the wiring layer that determines whether the hook actually fires on the user's machine
    - Rule 3 — **Observable post-condition**: assert filesystem or process state the user would observe (e.g., `test -f .findings/history.jsonl`), not just exit code; a script that exits 0 without writing the expected artifact satisfies exit-code-only probes but silently fails the user
  - [ ] Add the canonical worked example YAML block using the strata 3-3 pre-push hook scenario: fresh `mktemp -d` fixture project, `git push` as the canonical trigger against a local bare remote, `test -f .findings/history.jsonl && echo "ARCHIVE_PRESENT"` observable post-condition assertion
  - [ ] Ensure the YAML fenced block is a **YAML list** (not a bare map) and every entry has `name`, `sandbox`, `command`; `expect_stdout_regex` must be a YAML list (`- ARCHIVE_PRESENT`) not a scalar — required for the existing schema-drift guardrail test to pass

- [ ] Task 2: Add content-coverage tests to `src/modules/compiled-workflows/__tests__/probe-author.test.ts` (AC: #5)
  - [ ] Add a new `describe` block titled `'Shell-script generation probe shapes content'` immediately after the existing `'Prompt budget cap'` describe block
  - [ ] Add the following `it()` cases (read `probe-author.md` from the same path already used by the schema-drift and budget tests):
    - `'probe-author.md contains "Shell-script generation probe shapes" subsection header'` — assert substring match
    - `'probe-author.md contains fresh-fixture rule (mktemp -d)'` — assert file contains `mktemp -d` in the new section context
    - `'probe-author.md contains canonical-trigger rule'` — assert file contains text about canonical user trigger (e.g., `canonical user trigger` or `git push` in the rules prose)
    - `'probe-author.md contains observable post-condition rule'` — assert file contains `observable post-condition` or `observable post` text
    - `'probe-author.md cites obs_2026-05-03_023'` — assert file contains `obs_2026-05-03_023`
  - [ ] After adding the new section, measure `probe-author.md` size: if it exceeds 22,000 chars, update the budget cap assertion in the existing `'Prompt budget cap'` describe block from `toBeLessThan(22000)` to `toBeLessThan(26000)` and document the bump in Completion Notes
  - [ ] The existing schema-drift guardrail test (`'every yaml fenced block in probe-author.md parses against RuntimeProbeListSchema'`) must pass unchanged — do NOT modify it

- [ ] Task 3: Verify smoke fixture (AC: #6)
  - [ ] Confirm `_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md` exists and contains story 999-1 with an AC describing a pre-push hook generator that archives findings to `.findings/history.jsonl`
  - [ ] If the file does not exist, create it with the canonical AC shape from the story description: given `vg install` run from fresh project, when `git push origin main` fires, then `.findings/history.jsonl` is written and observable
  - [ ] If the file exists but is missing critical content, update it — do NOT delete it

- [ ] Task 4: Run fast test suite and confirm no regressions (AC: #5)
  - [ ] Run `npm run test:fast` with `timeout: 300000` — do NOT pipe through `head`, `tail`, or `grep` (per CLAUDE.md)
  - [ ] Confirm output contains "Test Files" summary line
  - [ ] Confirm test count increased by at least 5 (new describe block with 5 `it()` cases)
  - [ ] Confirm zero regressions

- [ ] Task 5: Use AC7-compliant commit message (AC: #7)
  - [ ] Commit message MUST reference `obs_2026-05-03_023 fix #1 (verification gate fresh-fixture canonical-invocation probe class — partial; structural primitive deferred, prompt-side guidance ships)`

## Dev Notes

### File Paths
- **Primary artifact**: `packs/bmad/prompts/probe-author.md` — add new `## Shell-script generation probe shapes` section
- **Test file**: `src/modules/compiled-workflows/__tests__/probe-author.test.ts` — add new `describe` block; possibly update budget cap assertion
- **Smoke fixture** (verify/create): `_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md`

### Section Placement in probe-author.md
- The file currently ends with `## State-integration probe shapes` (five sub-shape subsections: filesystem, subprocess, git, database, network, registry) followed directly by `## Mission`
- Insert `## Shell-script generation probe shapes` between the end of the state-integration section's last subsection (registry shape, ends around line 313) and the `## Mission` heading
- Do NOT move or reorder the `## Mission` or `## Output Contract` sections

### Three Rules — Exact Keywords Required by Tests
The test assertions are keyword-based. The following strings (or close equivalents) MUST appear in the prose:

| Rule | Keyword/phrase to include |
|---|---|
| Rule 1 (fresh fixture) | `mktemp -d` AND `fresh fixture` or `never run against substrate's own` |
| Rule 2 (canonical trigger) | `canonical user trigger` or `canonical trigger` AND `git push` |
| Rule 3 (observable post-condition) | `observable post-condition` or `observable post` |
| Citation | `obs_2026-05-03_023` |

### Canonical Worked Example YAML Shape
The worked example must validate against `RuntimeProbeListSchema`. Use this shape (adapted from the story description, with `expect_stdout_regex` as a YAML list):

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
    mkdir -p src
    echo "import x from 'lodash';" > src/bad.ts
    git add . && git commit -qm "initial"
    # trigger canonical user-facing event via git push (pre-push hook fires here)
    REMOTE=$(mktemp -d)
    git init --bare -q "$REMOTE"
    git remote add origin "$REMOTE"
    git push origin main 2>&1 || true
    # assert observable post-condition
    test -f .findings/history.jsonl && echo "ARCHIVE_PRESENT" || echo "ARCHIVE_MISSING"
  expect_stdout_regex:
    - ARCHIVE_PRESENT
  description: >-
    strata 3-3 canonical pre-push hook shape — fresh fixture (mktemp -d),
    canonical user trigger (git push), observable post-condition assertion
    (obs_2026-05-03_023 fix #1)
```

**Critical**: `expect_stdout_regex` must be a YAML list (`- ARCHIVE_PRESENT`), NOT a bare scalar (`ARCHIVE_PRESENT`). The `RuntimeProbeListSchema` expects `string[]`; a scalar will fail Zod validation and break the schema-drift guardrail.

### Schema-Drift Guardrail — How It Works
The existing test in `probe-author.test.ts` (describe `'Schema-drift guardrail: probe-author.md yaml fences'`) extracts all ```` ```yaml ```` fenced blocks from the prompt, parses each via `yamlLoad`, and validates list-shaped blocks against `RuntimeProbeListSchema`. The test skips bare-map objects but throws on any list entry that fails schema.

To pass:
1. The worked example must be a YAML list (`- name: ...`, not `name: ...` at root)
2. Each entry must have `name`, `sandbox` (`host`|`twin`), `command`
3. No unknown top-level fields in list entries
4. `expect_stdout_regex` and `expect_stdout_no_regex` must be string arrays when present

### Budget Cap — Current State
Current `probe-author.md` size: **18,763 bytes** (confirmed by `wc -c`). The current budget assertion in the test is `toBeLessThan(22000)`. Adding the new section adds approximately 2,000–3,500 chars (rules prose + worked example + section header). Estimated final size: 20,800–22,300 chars.

**Check the actual size after editing.** If `probe-author.md` exceeds 22,000 chars after adding the new section:
- Change `expect(content.length).toBeLessThan(22000)` → `expect(content.length).toBeLessThan(26000)` in the "Prompt budget cap" describe block
- Document the bump amount in Completion Notes

### New Test File Imports
No new imports are needed in `probe-author.test.ts`. The new describe block uses `readFile` from `node:fs/promises` and path utilities from `node:path` and `node:url` — all already imported in the test file.

The test file already resolves `probe-author.md` via:
```typescript
const __dirname = dirname(fileURLToPath(import.meta.url))
const promptPath = join(__dirname, '..', '..', '..', '..', 'packs', 'bmad', 'prompts', 'probe-author.md')
const content = await readFile(promptPath, 'utf-8')
```
Reuse this exact path resolution pattern in the new describe block. Do NOT introduce additional imports.

### Smoke Fixture — Already Exists
`_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md` was already created. Verify it contains:
- Story 999-1 with a pre-push hook generator AC
- AC describes archiving findings to `.findings/history.jsonl`
- Mention of `vg install` and `git push` as the canonical trigger

If the file is present and complete, no action is needed (AC6 is already satisfied). If missing, create it from the canonical AC shape in the story description.

### Architecture Constraints
- Do NOT modify any existing `it()` or `describe()` block in `probe-author.test.ts` other than possibly bumping the budget number
- Do NOT reorder sections in `probe-author.md` — only insert the new section at the correct location
- The new section's position: after state-integration shapes, before `## Mission`

### Testing Requirements
- `npm run test:fast` must pass with zero regressions
- The existing schema-drift guardrail test must pass for the new YAML block
- The new describe block must have ≥5 `it()` cases
- All `it()` cases in the new block must use `async/await` with `readFile` (consistent with the existing schema-drift and budget test patterns)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Change | Story |
|---|---|
| Added "Shell-script generation probe shapes" subsection to probe-author.md | 67-2 |
| Added shell-script generation content tests to probe-author.test.ts | 67-2 |
| Possibly bumped probe-author.md budget cap assertion (if size exceeded 22,000 chars) | 67-2 |

## Runtime Probes

```yaml
- name: probe-author-md-contains-shell-script-section-header
  sandbox: host
  command: >
    grep -q "Shell-script generation probe shapes" <REPO_ROOT>/packs/bmad/prompts/probe-author.md && echo
    "SECTION_FOUND" || echo "SECTION_MISSING"
  description: probe-author.md must contain the "Shell-script generation probe shapes" subsection header (AC1)
  expect_stdout_regex:
    - SECTION_FOUND
  _authoredBy: probe-author
- name: probe-author-md-contains-fresh-fixture-mktemp-rule
  sandbox: host
  command: |
    grep -q "mktemp -d" <REPO_ROOT>/packs/bmad/prompts/probe-author.md && echo "MKTEMP_FOUND" || echo "MKTEMP_MISSING"
  description: >-
    probe-author.md new section must contain mktemp -d for fresh fixture Rule 1 and the canonical worked example (AC2,
    AC3 Rule 1)
  expect_stdout_regex:
    - MKTEMP_FOUND
  _authoredBy: probe-author
- name: probe-author-md-contains-canonical-trigger-and-git-push
  sandbox: host
  command: >
    FILE=<REPO_ROOT>/packs/bmad/prompts/probe-author.md

    grep -q "canonical" "$FILE" && grep -q "git push" "$FILE" && echo "CANONICAL_TRIGGER_FOUND" || echo
    "CANONICAL_TRIGGER_MISSING"
  description: probe-author.md must contain canonical trigger rule prose and git push as the pre-push hook example (AC3 Rule 2)
  expect_stdout_regex:
    - CANONICAL_TRIGGER_FOUND
  _authoredBy: probe-author
- name: probe-author-md-contains-observable-post-condition-rule
  sandbox: host
  command: >
    grep -q "observable post" <REPO_ROOT>/packs/bmad/prompts/probe-author.md && echo "OBS_POST_FOUND" || echo
    "OBS_POST_MISSING"
  description: >-
    probe-author.md must contain observable post-condition rule (matches "observable post-condition" or "observable
    post") (AC3 Rule 3)
  expect_stdout_regex:
    - OBS_POST_FOUND
  _authoredBy: probe-author
- name: probe-author-md-cites-obs-2026-05-03-023
  sandbox: host
  command: >
    grep -q "obs_2026-05-03_023" <REPO_ROOT>/packs/bmad/prompts/probe-author.md && echo "OBS_CITED" || echo
    "OBS_NOT_CITED"
  description: probe-author.md must cite obs_2026-05-03_023 inline per Story 60-10/65-5 convention (AC4)
  expect_stdout_regex:
    - OBS_CITED
  _authoredBy: probe-author
- name: smoke-fixture-exists-with-pre-push-hook-and-findings-archive
  sandbox: host
  command: |
    FILE=<REPO_ROOT>/_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md
    test -f "$FILE" && echo "FIXTURE_EXISTS" || { echo "FIXTURE_MISSING"; exit 1; }
    grep -q "history.jsonl" "$FILE" && echo "ARCHIVE_AC_FOUND" || echo "ARCHIVE_AC_MISSING"
    grep -q "999-1" "$FILE" && echo "STORY_999_1_FOUND" || echo "STORY_999_1_MISSING"
  description: smoke fixture exists at epic-999 path, contains story 999-1, and AC references .findings/history.jsonl archive (AC6)
  expect_stdout_regex:
    - FIXTURE_EXISTS
    - ARCHIVE_AC_FOUND
    - STORY_999_1_FOUND
  _authoredBy: probe-author
- name: probe-author-test-suite-passes-with-shell-script-describe-block
  sandbox: host
  command: |
    cd <REPO_ROOT> && npm run test:fast 2>&1
  timeout_ms: 300000
  description: >-
    npm run test:fast passes — new "Shell-script generation probe shapes content" describe block with ≥5 it() cases and
    schema-drift guardrail test validates the new worked example YAML list shape (AC5)
  expect_stdout_regex:
    - Test Files
  _authoredBy: probe-author
```
