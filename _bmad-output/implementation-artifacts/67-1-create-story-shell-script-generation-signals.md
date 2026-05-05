# Story 67-1: create-story prompt extension for shell-script generation signals

## Story

As a substrate pipeline author,
I want the create-story prompt to recognize shell-script generation ACs as runtime-dependent,
so that stories generating git hooks, npm lifecycle scripts, or service units always include a `## Runtime Probes` section that invokes the canonical user trigger in a fresh fixture project.

## Acceptance Criteria

<!-- source-ac-hash: f6d047254267f8cdc0b1296b74c3940e5a12b481611613a37632b011f79b33cb -->

### AC1: Prompt subsection added in Behavioral signals area
`packs/bmad/prompts/create-story.md` extended with "Shell-script generation signals" subsection in the "Behavioral signals" area (after the existing 6 state-integration signal categories).

### AC2: Subsection enumerates signal types and phrase patterns
The subsection enumerates ≥5 signal types (hook generators, install scripts, lifecycle scripts, service generators, wrapper scripts) and ≥6 phrase patterns.

### AC3: Motivating incident cited inline
The subsection cites obs_2026-05-03_023 + strata 3-3+3-4 incident inline as motivation, mirroring Story 60-4 / 60-10's convention for citing motivating incidents.

### AC4: Subsection ends with mandatory-probes rule
The subsection ends with a clear rule: "if any shell-script generation signal fires, the story MUST include a `## Runtime Probes` section that invokes the canonical user trigger in a fresh fixture project, not direct-call the script."

### AC5: Tests in create-story.test.ts
Tests in `src/modules/compiled-workflows/__tests__/create-story.test.ts`:
(a) prompt content includes the new subsection heading + the 5 signal types + the rule; (b) methodology-pack token-budget assertion bumped to accommodate the new content.

### AC6: Empirical smoke validation
Step 4.5 prompt-edit smoke validated empirically: dispatch fixture epic-999-prompt-smoke-shell-script-generation.md story 999-1 (provided by Story 67-2 alongside its own probe-author smoke), inspect rendered story file, assert `## Runtime Probes` section is present AND mentions `mktemp -d` AND a canonical user trigger pattern.

### AC7: Commit message
Commit message references obs_2026-05-03_023 fix #2 (create-story prompt enforce probe section for shell-out boundaries).

## Tasks / Subtasks

- [ ] Task 1: Read create-story.md and determine insertion point (AC: #1)
  - [ ] Read `packs/bmad/prompts/create-story.md` in full
  - [ ] Locate the "Behavioral signals" paragraph (~line 109) that ends with the 6th category ("registry / configuration source")
  - [ ] Confirm that the text immediately following is the "Architectural-level signals" paragraph — the new subsection inserts between these two paragraphs
  - [ ] Record the exact insertion point (the blank line between "Behavioral signals" and "Architectural-level signals" paragraphs)

- [ ] Task 2: Author the "Shell-script generation signals" subsection in create-story.md (AC: #1, #2, #3, #4)
  - [ ] Add the new subsection as a bold paragraph beginning with `**Shell-script generation signals` immediately after the "Behavioral signals" paragraph and before the "Architectural-level signals" paragraph
  - [ ] Enumerate ≥5 signal types in a bullet list: hook generators (`pre-push`, `post-merge`, `pre-commit`, `post-commit`, `post-rewrite` git hooks; `husky` configurations; `.git/hooks/*` writes), install scripts (`vg install`, `<binary> install`, "installs the X hook", "writes the X script", "generates a wrapper for"), lifecycle scripts (npm `prepublish`, `postinstall`, `prepare` script generation; `package.json` scripts written by code), service generators (systemd `.service` / `.timer` unit file generation, podman/docker image build scripts), wrapper scripts (shell wrappers around binaries — `#!/bin/sh\nexec node $@`-shape generators)
  - [ ] Enumerate ≥6 phrase patterns: "writes a hook", "generates a script", "installs a pre-push hook", "creates a wrapper", "emits a shell script", "writes to .git/hooks/", "creates a systemd unit"
  - [ ] Cite `obs_2026-05-03_023` and strata 3-3+3-4 incident inline (e.g., "Strata Stories 3-3+3-4 shipped LGTM_WITH_NOTES with a real dependency-confusion attack vector (`npx strata` fallback) because the verification gate accepted shell-script-generating code without canonical-invocation probe. See `obs_2026-05-03_023`.")
  - [ ] End the subsection with the mandatory rule: "if any shell-script generation signal fires, the story MUST include a `## Runtime Probes` section that invokes the canonical user trigger in a fresh fixture project, not direct-call the script."

- [ ] Task 3: Add test assertions for subsection content in create-story.test.ts (AC: #5a)
  - [ ] Add a new describe block `'Story 67-1: shell-script generation signals in create-story prompt'` inside `create-story.test.ts` after the existing obs_017/018 tests within the `'Story 56: Runtime Verification guidance in create-story prompt'` describe block (or as a peer describe block using the same `promptContent` variable)
  - [ ] Add test: subsection heading "Shell-script generation signals" appears in prompt
  - [ ] Add test: ≥5 signal types present — hook generators (`.git/hooks`), install scripts, lifecycle scripts (`postinstall` or `prepublish`), service generators (`systemd`), wrapper scripts
  - [ ] Add test: ≥6 phrase patterns present — "writes a hook", "generates a script", "installs a pre-push hook", "creates a wrapper", "emits a shell script", "writes to .git/hooks/"
  - [ ] Add test: mandatory rule is present — prompt contains "MUST include a `## Runtime Probes`" in the shell-script-generation context
  - [ ] Add test: motivating incident cited — prompt contains "obs_2026-05-03_023" and "strata" + "3-3" or "3-4"

- [ ] Task 4: Bump methodology-pack token-budget assertion (AC: #5b)
  - [ ] In `create-story.test.ts`, within the `'Story 56: Runtime Verification guidance in create-story prompt'` describe block (or the new Story 67-1 describe block), add a minimum-length assertion: `expect(promptContent.length).toBeGreaterThan(28000)` (bumped from the prior implicit minimum of ~26000 to 28000, accounting for the ~1200-char subsection addition atop the current 28182-char prompt)
  - [ ] If a prior minimum-length assertion already exists, find and update it to the new threshold value

- [ ] Task 5: Empirical smoke validation — AC6 (AC: #6)
  - [ ] After Story 67-2 has authored the smoke fixture (`_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md`), dispatch story 999-1: `npm run substrate:dev -- run --events --stories 999-1`
  - [ ] Inspect the rendered story file at `_bmad-output/implementation-artifacts/999-1-*.md`
  - [ ] Assert: `## Runtime Probes` section is present in the rendered file
  - [ ] Assert: `mktemp -d` appears in the probes section (fresh fixture pattern)
  - [ ] Assert: a canonical user trigger pattern is present (e.g., `git push`, `npm install`, `git commit`, or similar)
  - [ ] If any assertion fails, adjust the subsection phrasing in create-story.md and re-run

- [ ] Task 6: Commit (AC: #7)
  - [ ] Run `npm run build` and `npm run test:fast` — confirm all tests pass
  - [ ] Commit with message that references obs_2026-05-03_023 fix #2: include "obs_2026-05-03_023 fix #2: create-story prompt enforce probe section for shell-out boundaries" in the commit body

## Dev Notes

### Architecture Constraints

- The new subsection MUST be inserted **between** the "Behavioral signals" paragraph and the "Architectural-level signals" paragraph in `packs/bmad/prompts/create-story.md` — after the existing 6 state-integration categories (subprocess, filesystem, git, database, network, registry) and before the architectural-level signals.
- The new subsection is a standalone bold paragraph, mirroring the style of "Behavioral signals" and "Architectural-level signals" — NOT a markdown heading. It begins with `**Shell-script generation signals`.
- The insertion point is approximately line 110 in the current prompt (the blank line separating the "Behavioral signals" and "Architectural-level signals" paragraphs).
- The subsection must NOT use markdown `###` headings — it follows the paragraph-bold convention of the surrounding prompt guidance.

### Testing Requirements

- Tests go in `src/modules/compiled-workflows/__tests__/create-story.test.ts` within or adjacent to the existing `'Story 56: Runtime Verification guidance in create-story prompt'` describe block, which already reads `promptContent` from the actual file at `packs/bmad/prompts/create-story.md`.
- The tests are static analysis — no LLM dispatch, no subprocess calls. Pattern: `expect(promptContent).toContain(...)` / `expect(promptContent).toMatch(...)`.
- The minimum-length assertion (AC5b) should be a single `it(...)` test that asserts `expect(promptContent.length).toBeGreaterThan(28000)`. This is the tripwire against accidental prompt truncation. If a prior assertion exists at a lower threshold, bump it.
- All new tests must use the `promptContent` variable already loaded by the `beforeEach` in the Story 56 describe block — do NOT re-read the file.
- Run `npm run test:fast` (not `npm test`) during development iteration to avoid slow feedback loops.
- AC5a signals to verify: `Shell-script generation signals`, `.git/hooks`, `postinstall`, `systemd`, `#!/bin/sh`, `obs_2026-05-03_023`, the mandatory rule string.

### Phrase pattern guidance for the prompt subsection

The phrase patterns in the subsection are what the create-story agent uses to recognize shell-script-generation ACs. The 6 required phrases per AC2 are:
1. "writes a hook"
2. "generates a script"
3. "installs a pre-push hook"
4. "creates a wrapper"
5. "emits a shell script"
6. "writes to .git/hooks/"
7. "creates a systemd unit" (bonus — include for completeness)

The 5 required signal types per AC2 are:
1. Hook generators — git hooks (pre-push, post-merge, etc.), husky, `.git/hooks/*` writes
2. Install scripts — `vg install`, `<binary> install`, "installs the X hook", "writes the X script"
3. Lifecycle scripts — npm `prepublish`, `postinstall`, `prepare` script generation
4. Service generators — systemd `.service` / `.timer` unit file generation, podman/docker build scripts
5. Wrapper scripts — `#!/bin/sh\nexec node $@`-shape generators, shell wrappers around binaries

### Motivating incident reference (AC3)

Per the 60-4 / 60-10 / obs_017 / obs_018 convention, cite the incident inline. Example wording:

> Strata Stories 3-3+3-4 shipped LGTM_WITH_NOTES with a real dependency-confusion attack vector (`npx strata` fallback) because the verification gate accepted shell-script-generating code without a canonical-invocation probe. See `obs_2026-05-03_023` (create-story prompt enforce probe section for shell-out boundaries).

### Mandatory rule (AC4)

The subsection must end with this exact rule (or very close to verbatim):

> If any shell-script generation signal fires, the story MUST include a `## Runtime Probes` section that invokes the canonical user trigger in a fresh fixture project, not direct-call the script.

The key elements: "MUST include", "`## Runtime Probes`", "canonical user trigger", "fresh fixture project", "not direct-call the script".

### Insertion point — exact surrounding context

The insertion point in `packs/bmad/prompts/create-story.md` is between these two paragraphs:

```
**Behavioral signals (runtime-dependent even when the artifact ships as TypeScript / JavaScript / Python source):** the AC describes the implementation invoking a **subprocess** (`execSync`, `spawn`, `child_process`), reading or writing the **filesystem outside test tmpdirs** (`fs.read*`, `fs.write*`, `path.join(homedir(), ...)`), running **git operations** (`git log`, `git push`, `git merge`), querying a **database** (Dolt, mysql, sqlite, postgres), making **network requests** (`fetch`, `axios`, `http.get`), or scanning a **registry / configuration source** ("queries the registry", "scans the fleet").

**Architectural-level signals (the same external-state interactions described at higher abstraction levels — runtime-dependent identically):** ...
```

Insert the new subsection as a new paragraph(s) between the blank line separating these two paragraphs.

### AC6 smoke dependency

AC6 requires the fixture `epic-999-prompt-smoke-shell-script-generation.md` which is authored by Story 67-2. If Story 67-2 has not shipped, Task 5 (smoke validation) must be deferred until Story 67-2 completes. The prompt edit (Tasks 1-2) and unit tests (Tasks 3-4) can and should be completed before Story 67-2 ships.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

---

## Runtime Probes

```yaml
- name: prompt-subsection-heading-present
  sandbox: host
  command: |
    grep -qF "Shell-script generation signals" <REPO_ROOT>/packs/bmad/prompts/create-story.md \
      && echo "HEADING_FOUND" \
      || { echo "HEADING_MISSING"; exit 1; }
  description: AC1 — create-story.md contains the Shell-script generation signals subsection heading in the Behavioral signals area
  expect_stdout_regex:
    - HEADING_FOUND
  _authoredBy: probe-author
- name: prompt-enumerates-five-signal-types
  sandbox: host
  command: |
    PROMPT=<REPO_ROOT>/packs/bmad/prompts/create-story.md
    FAILED=0
    grep -qF '.git/hooks' "$PROMPT" \
      && echo "HOOK_GENERATORS_PRESENT" || { echo "HOOK_GENERATORS_MISSING"; FAILED=1; }
    grep -qE 'vg install|installs the .* hook|writes the .* script|generates a wrapper' "$PROMPT" \
      && echo "INSTALL_SCRIPTS_PRESENT" || { echo "INSTALL_SCRIPTS_MISSING"; FAILED=1; }
    grep -qE 'postinstall|prepublish' "$PROMPT" \
      && echo "LIFECYCLE_SCRIPTS_PRESENT" || { echo "LIFECYCLE_SCRIPTS_MISSING"; FAILED=1; }
    grep -qF 'systemd' "$PROMPT" \
      && echo "SERVICE_GENERATORS_PRESENT" || { echo "SERVICE_GENERATORS_MISSING"; FAILED=1; }
    grep -qE '#!/bin/sh|exec node' "$PROMPT" \
      && echo "WRAPPER_SCRIPTS_PRESENT" || { echo "WRAPPER_SCRIPTS_MISSING"; FAILED=1; }
    exit $FAILED
  description: >-
    AC2 — prompt subsection enumerates all 5 required signal types (hook generators, install scripts, lifecycle scripts,
    service generators, wrapper scripts)
  expect_stdout_regex:
    - HOOK_GENERATORS_PRESENT
    - INSTALL_SCRIPTS_PRESENT
    - LIFECYCLE_SCRIPTS_PRESENT
    - SERVICE_GENERATORS_PRESENT
    - WRAPPER_SCRIPTS_PRESENT
  _authoredBy: probe-author
- name: prompt-has-six-phrase-patterns
  sandbox: host
  command: |
    PROMPT=<REPO_ROOT>/packs/bmad/prompts/create-story.md
    FAILED=0
    grep -qF "writes a hook" "$PROMPT" \
      && echo "PATTERN_1_WRITES_HOOK" || { echo "PATTERN_1_MISSING"; FAILED=1; }
    grep -qF "generates a script" "$PROMPT" \
      && echo "PATTERN_2_GENERATES_SCRIPT" || { echo "PATTERN_2_MISSING"; FAILED=1; }
    grep -qF "installs a pre-push hook" "$PROMPT" \
      && echo "PATTERN_3_INSTALLS_PREPUSH" || { echo "PATTERN_3_MISSING"; FAILED=1; }
    grep -qF "creates a wrapper" "$PROMPT" \
      && echo "PATTERN_4_CREATES_WRAPPER" || { echo "PATTERN_4_MISSING"; FAILED=1; }
    grep -qF "emits a shell script" "$PROMPT" \
      && echo "PATTERN_5_EMITS_SHELL" || { echo "PATTERN_5_MISSING"; FAILED=1; }
    grep -qE 'writes to .*\.git/hooks' "$PROMPT" \
      && echo "PATTERN_6_WRITES_GIT_HOOKS" || { echo "PATTERN_6_MISSING"; FAILED=1; }
    exit $FAILED
  description: AC2 — prompt subsection enumerates all 6 required phrase patterns
  expect_stdout_regex:
    - PATTERN_1_WRITES_HOOK
    - PATTERN_2_GENERATES_SCRIPT
    - PATTERN_3_INSTALLS_PREPUSH
    - PATTERN_4_CREATES_WRAPPER
    - PATTERN_5_EMITS_SHELL
    - PATTERN_6_WRITES_GIT_HOOKS
  _authoredBy: probe-author
- name: prompt-cites-obs023-and-strata-incident
  sandbox: host
  command: |
    PROMPT=<REPO_ROOT>/packs/bmad/prompts/create-story.md
    FAILED=0
    grep -qF "obs_2026-05-03_023" "$PROMPT" \
      && echo "OBS_023_CITED" || { echo "OBS_023_NOT_CITED"; FAILED=1; }
    grep -qE "3-3|3-4" "$PROMPT" \
      && echo "STRATA_STORIES_CITED" || { echo "STRATA_STORIES_NOT_CITED"; FAILED=1; }
    exit $FAILED
  description: >-
    AC3 — prompt subsection cites obs_2026-05-03_023 and strata 3-3+3-4 incident inline as motivation, mirroring
    60-4/60-10 convention
  expect_stdout_regex:
    - OBS_023_CITED
    - STRATA_STORIES_CITED
  _authoredBy: probe-author
- name: prompt-has-mandatory-rule
  sandbox: host
  command: |
    PROMPT=<REPO_ROOT>/packs/bmad/prompts/create-story.md
    FAILED=0
    grep -qF "MUST include" "$PROMPT" \
      && echo "MUST_INCLUDE_PRESENT" || { echo "MUST_INCLUDE_MISSING"; FAILED=1; }
    grep -qF "canonical user trigger" "$PROMPT" \
      && echo "CANONICAL_TRIGGER_RULE_PRESENT" || { echo "CANONICAL_TRIGGER_RULE_MISSING"; FAILED=1; }
    grep -qF "fresh fixture project" "$PROMPT" \
      && echo "FRESH_FIXTURE_RULE_PRESENT" || { echo "FRESH_FIXTURE_RULE_MISSING"; FAILED=1; }
    grep -qF "not direct-call the script" "$PROMPT" \
      && echo "NOT_DIRECT_CALL_PRESENT" || { echo "NOT_DIRECT_CALL_MISSING"; FAILED=1; }
    exit $FAILED
  description: >-
    AC4 — prompt subsection ends with mandatory rule containing MUST include, canonical user trigger, fresh fixture
    project, not direct-call the script
  expect_stdout_regex:
    - MUST_INCLUDE_PRESENT
    - CANONICAL_TRIGGER_RULE_PRESENT
    - FRESH_FIXTURE_RULE_PRESENT
    - NOT_DIRECT_CALL_PRESENT
  _authoredBy: probe-author
- name: test-file-has-story-67-1-assertions
  sandbox: host
  command: |
    TEST=<REPO_ROOT>/src/modules/compiled-workflows/__tests__/create-story.test.ts
    FAILED=0
    grep -qF "Shell-script generation signals" "$TEST" \
      && echo "HEADING_ASSERTION_FOUND" || { echo "HEADING_ASSERTION_MISSING"; FAILED=1; }
    grep -qF "obs_2026-05-03_023" "$TEST" \
      && echo "OBS_ASSERTION_FOUND" || { echo "OBS_ASSERTION_MISSING"; FAILED=1; }
    grep -q "28000" "$TEST" \
      && echo "BUDGET_28000_FOUND" || { echo "BUDGET_28000_MISSING"; FAILED=1; }
    grep -qE "MUST include|canonical user trigger" "$TEST" \
      && echo "MANDATORY_RULE_ASSERTION_FOUND" || { echo "MANDATORY_RULE_ASSERTION_MISSING"; FAILED=1; }
    exit $FAILED
  description: >-
    AC5a — create-story.test.ts contains assertions for subsection heading, obs_2026-05-03_023 citation, mandatory rule,
    and bumped token-budget threshold to 28000
  expect_stdout_regex:
    - HEADING_ASSERTION_FOUND
    - OBS_ASSERTION_FOUND
    - BUDGET_28000_FOUND
    - MANDATORY_RULE_ASSERTION_FOUND
  _authoredBy: probe-author
- name: test-suite-passes-with-new-tests
  sandbox: host
  command: |
    cd <REPO_ROOT> && npm run test:fast 2>&1
  timeout_ms: 120000
  description: >-
    AC5b — npm run test:fast completes with all tests passing including new Story 67-1 assertions and bumped budget
    assertion
  expect_stdout_no_regex:
    - \d+ failed
  expect_stdout_regex:
    - Test Files
  _authoredBy: probe-author
- name: smoke-dispatch-renders-runtime-probes-section
  sandbox: host
  command: |
    set -e
    FIXTURE=<REPO_ROOT>/_bmad-output/planning-artifacts/epic-999-prompt-smoke-shell-script-generation.md
    test -f "$FIXTURE" || { echo "FIXTURE_MISSING_REQUIRES_STORY_67-2_TO_SHIP_FIRST"; exit 1; }
    echo "FIXTURE_FOUND"
    cd <REPO_ROOT>
    npm run substrate:dev -- run --events --stories 999-1
    RENDERED=$(ls -t _bmad-output/implementation-artifacts/999-1-*.md 2>/dev/null | head -1)
    test -n "$RENDERED" || { echo "RENDERED_FILE_NOT_FOUND"; exit 1; }
    echo "RENDERED_FILE_FOUND"
    grep -qF "## Runtime Probes" "$RENDERED" \
      && echo "RUNTIME_PROBES_SECTION_PRESENT" || { echo "RUNTIME_PROBES_SECTION_MISSING"; exit 1; }
    grep -qF "mktemp -d" "$RENDERED" \
      && echo "MKTEMP_PATTERN_PRESENT" || { echo "MKTEMP_PATTERN_MISSING"; exit 1; }
    grep -qE "(git push|git commit|npm install)" "$RENDERED" \
      && echo "CANONICAL_TRIGGER_PRESENT" || { echo "CANONICAL_TRIGGER_MISSING"; exit 1; }
  timeout_ms: 2400000
  description: >-
    AC6 — dispatch story 999-1 (shell-script smoke fixture authored by Story 67-2) via substrate and verify the rendered
    story contains Runtime Probes section with mktemp -d fresh-fixture pattern and a canonical user trigger (git
    push/commit or npm install); fails early with clear message if Story 67-2 fixture not yet present
  expect_stdout_regex:
    - FIXTURE_FOUND
    - RENDERED_FILE_FOUND
    - RUNTIME_PROBES_SECTION_PRESENT
    - MKTEMP_PATTERN_PRESENT
    - CANONICAL_TRIGGER_PRESENT
  _authoredBy: probe-author
- name: git-commit-references-obs023
  sandbox: host
  command: |
    cd <REPO_ROOT>
    RECENT=$(git log --oneline -15)
    if echo "$RECENT" | grep -qF "obs_2026-05-03_023"; then
      echo "OBS023_IN_COMMIT_LOG"
    else
      echo "OBS023_NOT_IN_RECENT_COMMITS"
      exit 1
    fi
  description: AC7 — recent git commit (last 15) references obs_2026-05-03_023 fix
  expect_stdout_regex:
    - OBS023_IN_COMMIT_LOG
  _authoredBy: probe-author
```
