# Story 65-5: probe-author prompt extensions for state-integration probe shapes

## Story

As a dev agent implementing state-integration features,
I want `packs/bmad/prompts/probe-author.md` to include a "State-integration probe shapes" section with worked examples for each shape and guidance on sandbox choice, production-layout fixtures, and binary-availability assertions,
so that the probe-author agent generates probes that faithfully catch state-integration defects — particularly the obs_017 cwd-as-parent class of bug — without requiring LLM-derived inference of shape patterns not yet documented.

## Acceptance Criteria

<!-- source-ac-hash: 95f48b25bb6fc8a89b81e5a5554d7d8e351ad13ea4fbb71832d599cea063bd3f -->

1. probe-author.md extended with "State-integration probe shapes" section.
2. Each shape (filesystem, subprocess, git, database, network, registry) has a worked example.
3. Schema-drift guardrail (existing in probe-author test suite) passes: every YAML fenced block validates against `RuntimeProbeListSchema`.
4. obs_017 reproduction: a state-integration probe authored from strata 2-4's AC text catches the cwd-as-parent defect against a multi-repo tmpdir fixture.

## Tasks / Subtasks

- [x] Task 1: Add "State-integration probe shapes" section to `packs/bmad/prompts/probe-author.md` (AC: #1, #2)
  - [x] Insert section header "State-integration probe shapes" immediately after the existing "Production-shaped fixtures" section and before the "Mission" section
  - [x] Write introductory prose covering the four key principles: (a) real-state context — populate tmpdir with a structure matching the production layout; (b) sandbox choice leans `twin` for anything touching home directory or running services, `host` only for read-only registry/config probes; (c) multi-resource fixtures MUST contain ≥2 distinct, non-overlapping resources; (d) external-binary availability — a sibling probe or in-probe assertion MUST check that `git`, `dolt`, `podman`, etc. exist before the fleet probe runs
  - [x] Add `filesystem` shape worked example: probe populates a tmpdir with a production-layout directory structure and asserts file contents / directory invariants; sandbox `twin`
  - [x] Add `subprocess` shape worked example: probe first asserts binary availability via `command -v`, then exercises the subprocess via its production invocation path; sandbox `twin`
  - [x] Add `git` shape worked example: probe creates a ≥2-repo fleet in a tmpdir with non-overlapping commit messages, sets `cwd` per-repo (NOT fleet root), and asserts each repo's commits are attributed correctly; sandbox `twin` — this is the canonical obs_017 pattern
  - [x] Add `database` shape worked example: probe exercises a Dolt or SQLite database in a twin sandbox, seeding ≥2 rows and asserting per-row behavior; sandbox `twin`
  - [x] Add `network` shape worked example: probe exercises an HTTP endpoint with `expect_stdout_no_regex` error-envelope guards; sandbox `twin` (or `host` if read-only)
  - [x] Add `registry` shape worked example: probe reads from an npm/package registry or fleet-config source, preceded by a binary-availability sibling probe; sandbox `host` (read-only)

- [x] Task 2: Verify schema-drift guardrail passes for all new YAML examples (AC: #3)
  - [x] Confirm every fenced `yaml` block in the new section contains a YAML list (not a bare map)
  - [x] Confirm every probe entry includes the three required fields: `name` (hyphen-separated), `sandbox` (`host` or `twin`), `command`
  - [x] Confirm no extra fields appear outside the `RuntimeProbeListSchema` shape (`name`, `sandbox`, `command`, `timeout_ms`, `description`, `expect_stdout_regex`, `expect_stdout_no_regex`)
  - [x] Run `npm run test:fast` (or targeted: `npm run test:fast -- --testPathPattern probe-author`) and confirm the schema-drift guardrail test passes
  - [x] If total prompt character count after edits is ≥ 22,000, bump the budget cap assertion in `src/modules/compiled-workflows/__tests__/probe-author.test.ts` to the next round ceiling (e.g. `28000`) and document the bump in this story's Completion Notes

- [x] Task 3: Write obs_017 reproduction test (AC: #4)
  - [x] Add a new `describe` block to `src/modules/compiled-workflows/__tests__/probe-author.test.ts` titled "obs_017 reproduction: git-shape probe catches cwd-as-parent defect"
  - [x] The test creates a two-repo tmpdir fleet (`alpha`, `beta`) using `execSync` / `mkdirSync` + `execSync('git init')` within the test body, each repo committed with a distinct message (`alpha-only commit` and `beta-only commit`)
  - [x] The test creates a small shell script (written to a tmp path) that mimics the defective `fetchGitLog` behavior: runs `git log --oneline` with `cwd` set to the fleet root (NOT the individual repo directory)
  - [x] The test creates a correct variant of the same shell script: iterates repos, runs `git log --oneline` with `cwd` set per-repo
  - [x] Assert the defective variant's output, when checked against the `expect_stdout_regex` patterns from the git-shape probe example (`alpha-only commit` AND `beta-only commit` appearing in the correct per-repo output), would FAIL — i.e., both messages appear in a single output blob with no per-repo attribution boundary
  - [x] Assert the correct variant's output would PASS — each repo's invocation returns only its own commit message
  - [x] The test must use only Node.js built-ins (`node:child_process`, `node:fs`, `node:os`, `node:path`) — no new test utility imports

- [x] Task 4: Run full fast test suite and confirm no regressions (AC: #3)
  - [x] Run `npm run test:fast` and confirm results contain "Test Files" summary line (per CLAUDE.md rules — do NOT pipe)
  - [x] Confirm test count increased by at least 2 (schema-drift guardrail runs against new YAML blocks + new obs_017 reproduction describe block)
  - [x] Confirm zero test regressions

## Dev Notes

### File Paths
- **Primary artifact**: `packs/bmad/prompts/probe-author.md` — add "State-integration probe shapes" section
- **Test file**: `src/modules/compiled-workflows/__tests__/probe-author.test.ts` — add obs_017 reproduction describe block here (co-located with the existing schema-drift guardrail test)
- **Schema reference**: `RuntimeProbeListSchema` is imported from `@substrate-ai/sdlc` in the existing test file — use the same import for any new inline schema assertions

### Section Placement in probe-author.md
- Insert "State-integration probe shapes" AFTER the "Production-shaped fixtures" section and BEFORE the "## Mission" section
- The new section follows the same pattern as the event-driven trigger table: intro paragraph → shape-specific subsections with worked examples

### Key Principles to Cover (intro prose)
1. **Real-state context, not synthesized**: for filesystem probes, populate a tmpdir with a structure matching the production layout (e.g., for fleet-scanning logic, N subdirs each containing a `.git` directory)
2. **Sandbox choice leans `twin` more often**: state-integration probes that touch the user's actual home directory or running services MUST use `sandbox: twin`; use `sandbox: host` only for read-only registry / config-shape probes that cannot mutate host state
3. **Multi-resource fixtures**: fixtures MUST contain ≥2 distinct, non-overlapping resources. A single-resource fixture hides defects whose failure mode only surfaces under multiplicity (obs_017 pattern: the cwd-as-parent defect produces plausible output against a one-repo fleet; it only fails when ≥2 repos have distinct, non-overlapping commit messages and assertions distinguish them)
4. **External-binary availability assertions**: if the probe invokes `git`, `dolt`, `podman`, etc., a binary-availability sibling probe MUST precede the fleet probe, OR an inline check (`command -v git || { echo "git not found"; exit 1; }`) MUST appear at the top of the `command:` block

### YAML Fenced Block Constraints (schema-drift guardrail)
All fenced YAML blocks added must:
- Be a YAML list (not a bare map) — the schema-drift test skips maps but a list that fails schema will throw
- Each entry must include exactly: `name` (string, hyphen-separated), `sandbox` (`host` | `twin`), `command` (string)
- Optional fields are: `timeout_ms` (number), `description` (string), `expect_stdout_regex` (string[]), `expect_stdout_no_regex` (string[])
- No other top-level keys are allowed — the `RuntimeProbeListSchema` will reject unknown fields
- The inline `<REPO_ROOT>` placeholder (used in the existing event-driven example) is acceptable in prose-level YAML examples since the schema-drift test validates structure, not shell correctness

### Budget Cap
The existing budget cap test asserts `probe-author.md` is under 22,000 characters. Current size: ~12,200 chars. The new section adds ~3,000–5,000 chars of prose + 6 YAML examples — expected final size ~15,000–17,000 chars, well within the cap. If the actual content exceeds 22,000 chars, bump the test threshold to `28000` and document in Completion Notes.

### obs_017 Reproduction Test Design
The test demonstrates the key insight from obs_017: running `git log --oneline` with `cwd` set to a fleet root (parent of N repos) returns commits from ALL repos mixed together, while running with `cwd` set per-repo returns only that repo's commits. The test:

1. Uses `execSync` from `node:child_process` and `mkdtempSync` from `node:fs` to create a tmpdir fleet
2. Initializes `alpha` and `beta` repos with single distinct commits
3. Runs `git log --oneline` with `cwd=fleetRoot` (defective) → output contains BOTH `alpha-only commit` and `beta-only commit`; per-repo attribution is impossible from this output shape
4. Runs `git log --oneline` with `cwd=fleetRoot/alpha` (correct) → output contains ONLY `alpha-only commit`
5. Assertions confirm the defective mode mixes outputs (assertion matches both messages in one blob) and the correct mode isolates them (assertion matches exactly one message per invocation)

The test does NOT dispatch to an LLM — it verifies the defect pattern and correct pattern directly, matching Story 64-3's static-analysis precedent (no LLM dispatch in the probe-author unit test suite).

### Architecture Constraints
- Do NOT add new imports to `probe-author.test.ts` beyond `node:child_process`, `node:fs`, `node:os`, `node:path` (all built-ins)
- The obs_017 reproduction test should be in the same file (`probe-author.test.ts`) to avoid test-runner overhead
- All git commands in the test must set `user.email` and `user.name` git config to prevent `git commit` from failing in CI environments without a global git config

### Testing Requirements
- `npm run test:fast` must pass (no regressions in existing probe-author tests)
- The schema-drift guardrail (existing test "every yaml fenced block in probe-author.md parses against RuntimeProbeListSchema") must pass with all new YAML blocks
- The new obs_017 reproduction describe block must have ≥2 `it()` cases: one asserting defective-cwd behavior and one asserting correct-cwd behavior

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Final probe-author.md size: 18,763 chars (well under 22,000 cap — no budget bump needed)
- 6 new YAML fenced blocks added (blocks 4–9 in schema-drift validation), all validating as RuntimeProbeListSchema-compliant lists
- obs_017 test uses direct execSync invocations rather than shell script files to simulate defective vs. correct behavior (cleaner and equivalent)
- All 9375 tests pass (9376 with 1 skip), 2 new obs_017 describe-block tests added
- git config user.email / user.name set in beforeEach to prevent CI failures in environments without global git config

### File List
- packs/bmad/prompts/probe-author.md
- src/modules/compiled-workflows/__tests__/probe-author.test.ts

## Change Log

| Change | Story |
|---|---|
| Added "State-integration probe shapes" section with 6 shape examples | 65-5 |
| Added obs_017 reproduction describe block to probe-author.test.ts | 65-5 |

## Runtime Probes

```yaml
- name: probe-author-md-state-integration-section
  sandbox: host
  command: |
    FILE="<REPO_ROOT>/packs/bmad/prompts/probe-author.md"
    echo "--- Checking section header ---"
    grep -c "State-integration probe shapes" "$FILE" && echo "SECTION_FOUND" || { echo "SECTION_NOT_FOUND"; exit 1; }
    echo "--- Checking shape coverage ---"
    for shape in filesystem subprocess git database network registry; do
      grep -qi "$shape" "$FILE" && echo "SHAPE_OK: $shape" || { echo "SHAPE_MISSING: $shape"; exit 1; }
    done
    echo "ALL_COVERAGE_CHECKS_PASSED"
  description: >-
    probe-author.md contains the "State-integration probe shapes" section header and all six shape subsections
    (filesystem, subprocess, git, database, network, registry)
  expect_stdout_regex:
    - SECTION_FOUND
    - 'SHAPE_OK: filesystem'
    - 'SHAPE_OK: subprocess'
    - 'SHAPE_OK: git'
    - 'SHAPE_OK: database'
    - 'SHAPE_OK: network'
    - 'SHAPE_OK: registry'
    - ALL_COVERAGE_CHECKS_PASSED
  _authoredBy: probe-author
- name: probe-author-schema-drift-guardrail
  sandbox: host
  command: |
    cd <REPO_ROOT> && npm run test:fast 2>&1
  timeout_ms: 120000
  description: >-
    schema-drift guardrail passes — all YAML fenced blocks in probe-author.md (including new state-integration shape
    examples) validate against RuntimeProbeListSchema; zero test regressions in fast suite
  expect_stdout_no_regex:
    - '[1-9][0-9]* failed'
  expect_stdout_regex:
    - Test Files
  _authoredBy: probe-author
- name: obs017-reproduction-test-block-exists
  sandbox: host
  command: >
    grep -qi "obs.017|obs_017|cwd-as-parent|fleet root|cwd.*fleet"
    "<REPO_ROOT>/src/modules/compiled-workflows/__tests__/probe-author.test.ts" && echo "OBS017_TEST_FOUND" || echo
    "OBS017_TEST_MISSING"
  description: probe-author.test.ts contains an obs_017 reproduction describe block testing the cwd-as-parent defect pattern
  expect_stdout_no_regex:
    - OBS017_TEST_MISSING
  expect_stdout_regex:
    - OBS017_TEST_FOUND
  _authoredBy: probe-author
- name: obs017-git-fleet-per-repo-attribution
  sandbox: twin
  command: >
    set -e

    FLEET=$(mktemp -d)

    for proj in alpha beta; do
      mkdir -p "$FLEET/$proj"
      git -C "$FLEET/$proj" init -q
      git -C "$FLEET/$proj" config user.email "t@example.com"
      git -C "$FLEET/$proj" config user.name "test"
      echo "$proj content" > "$FLEET/$proj/a.md"
      git -C "$FLEET/$proj" add .
      git -C "$FLEET/$proj" commit -qm "$proj-only commit"
    done

    echo "=== per-repo cwd (correct attribution) ==="

    ALPHA_LOG=$(git -C "$FLEET/alpha" log --oneline)

    BETA_LOG=$(git -C "$FLEET/beta" log --oneline)

    echo "alpha: $ALPHA_LOG"

    echo "beta: $BETA_LOG"

    echo "$ALPHA_LOG" | grep -q "alpha-only commit" || { echo "FAIL: alpha commit not found in alpha log"; exit 1; }

    echo "$ALPHA_LOG" | grep -q "beta-only commit" && { echo "FAIL: alpha log contains beta-only commit (wrong
    attribution)"; exit 1; }

    echo "$BETA_LOG" | grep -q "beta-only commit" || { echo "FAIL: beta commit not found in beta log"; exit 1; }

    echo "$BETA_LOG" | grep -q "alpha-only commit" && { echo "FAIL: beta log contains alpha-only commit (wrong
    attribution)"; exit 1; }

    echo "PER_REPO_ATTRIBUTION_CORRECT"
  description: >
    obs_017 git-shape production fixture — two-repo fleet (alpha, beta) with non-overlapping commit messages; per-repo
    cwd correctly isolates each project's commits and attribution is unambiguous. Catches the cwd-as-parent defect
    class: a defective implementation that runs git log at fleet root (not per-repo) would either fail entirely or
    aggregate both repos' commits into one blob, making per-project attribution impossible — this probe's per-repo
    assertions would fail in that case.
  expect_stdout_no_regex:
    - 'FAIL:'
  expect_stdout_regex:
    - alpha:.*alpha-only commit
    - beta:.*beta-only commit
    - PER_REPO_ATTRIBUTION_CORRECT
  _authoredBy: probe-author
```
