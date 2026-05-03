---
external_state_dependencies:
  - filesystem
  - subprocess
  - network
---

# Story 65-3: corpus + eval harness for state-integrating defect class

## Story

As a substrate maintainer,
I want a defect corpus and eval harness for state-integrating probe patterns,
so that I can empirically measure and validate the probe-author agent's catch rate on state-integration defect shapes before shipping Phase 3 (Epic 65).

## Acceptance Criteria

<!-- source-ac-hash: 403385a707c4eaa73116fe7875ae3cf0d7df20d07067f9afa95148d4f6a613bf -->

1. Corpus persisted at `packs/bmad/eval/probe-author-state-integrating-corpus.yaml`.
2. Eval script extends `scripts/probe-author-eval.ts` (or sibling) to drive the corpus through probe-author dispatch and assert each authored probe catches the defect against real or near-real state.
3. Eval is reproducible: pinned model, deterministic prompt, no network dependencies beyond probe-author dispatch itself.
4. Eval emits structured per-case results: `caught: bool`, `cost_usd`, `wall_clock_ms`, `probe_count`, `failure_reason` (if not caught).
5. Aggregate report: catch rate, total cost, total wall clock, per-case breakdown.

## Tasks / Subtasks

- [ ] Task 1: Create corpus YAML file and author fixtures 1–4 (AC: #1, #3)
  - [ ] Create `packs/bmad/eval/` directory and `probe-author-state-integrating-corpus.yaml`
  - [ ] Follow the pure-YAML schema (not the v1 markdown-with-embedded-YAML format used by `_bmad-output/planning-artifacts/probe-author-defect-corpus.md`): top-level keys `applicable_entries` and `excluded_entries`, each entry having `id`, `source_ac`, `signature`, `description`, `broken_implementation`, `real_state_condition`, and `mock_authored_probes`
  - [ ] Author fixture 1 (`entry-1-obs017-git-log-wrong-cwd`): obs_017 reproduction — `git log` called with `cwd=fleetRoot` instead of per-project directory; source AC describes per-project commit attribution; signature requires `git\s+log` + multi-repo fixture markers; mock probe creates ≥2 tmp repos with distinct commits
  - [ ] Author fixture 2 (`entry-2-subprocess-synthesized-vs-real`): subprocess called with mocked/piped input instead of real process state; source AC describes invoking `npm outdated --json`; signature requires real subprocess invocation
  - [ ] Author fixture 3 (`entry-3-tilde-path-not-expanded`): `fs.readFileSync` called with literal `~/.config/…` (tilde not expanded); source AC describes reading from user config path; signature requires `HOME|homedir\(\)|\$HOME` + path match
  - [ ] Author fixture 4 (`entry-4-db-mocked-vs-real`): DB query returns canned/mocked response instead of real Dolt state; source AC describes querying `wg_stories` for PLANNED stories; signature requires `dolt|mysql` + table/status reference

- [ ] Task 2: Author fixtures 5–8 and validate corpus completeness (AC: #1)
  - [ ] Author fixture 5 (`entry-5-network-mocked-vs-real`): network fetch intercepted by test double instead of real endpoint; source AC describes fetching current package version from npm registry; signature requires `curl|npm\s+view|registry\.npmjs` in probe command
  - [ ] Author fixture 6 (`entry-6-registry-scan-single-vs-multi`): registry scan passes on single-package workspace, fails on multi-package; source AC describes scanning monorepo workspace for version-constraint mismatches; signature requires multi-package fixture (`mktemp|tmpdir`) + `package\.json`
  - [ ] Author fixture 7 (`entry-7-git-op-empty-vs-real-repo`): git operation succeeds on empty repo (returns empty/default), fails on real repo with history; source AC describes reading latest tag/version from git repo; signature requires `git\s+tag|git\s+describe` + non-empty assertion
  - [ ] Author fixture 8 (`entry-8-spawn-swallows-nonzero-exit`): spawn invocation ignores non-zero exit code, masking compile/lint failure; source AC describes running `tsc --noEmit` to validate TypeScript; signature requires `tsc` + exit-code assertion
  - [ ] Verify all 8 entries in `applicable_entries` have required fields: `id`, `source_ac`, `signature` (non-empty list), `mock_authored_probes` (≥1 probe with `name`, `sandbox`, `command`)

- [ ] Task 3: Create sibling eval script with corpus loading and probe-author dispatch (AC: #2, #3)
  - [ ] Create `scripts/eval-probe-author-state-integrating.mjs` as a sibling to `scripts/eval-probe-author.mjs` (the v1 script from Story 60-14d); do NOT modify the v1 script
  - [ ] Import and reuse `evaluateSignature` and `computeCatchRate` from `scripts/eval-probe-author/lib.mjs`
  - [ ] Implement `parseStateIntegratingCorpus(yamlPath)`: reads the pure YAML corpus file with `js-yaml`, validates all required fields per entry, returns `{ applicable_entries, excluded_entries }`
  - [ ] Replicate the `dispatchProbeAuthor(entry, opts)` function from v1 (or factor it into a shared helper in `scripts/eval-probe-author/lib.mjs`): write temp story file, invoke `substrate probe-author dispatch --story-file … --bypass-gates --output-format json`, parse JSON response
  - [ ] Pin the model: add a `PINNED_MODEL` constant (check `packs/bmad/manifest.yaml` for the probe-author task's default model; use that value); pass via `--model` flag to the dispatch subcommand or document in a comment if the dispatch inherits from manifest
  - [ ] Accept CLI flags: `--corpus <path>`, `--output <path>`, `--threshold <n>` (default 0.5), `--dry-run`, `--list-cases`, `--help`

- [ ] Task 4: Implement per-case NDJSON output and aggregate report (AC: #4, #5)
  - [ ] After each case completes, emit one NDJSON line to stdout: `{ "case_id": "...", "caught": true|false, "cost_usd": 0.00, "wall_clock_ms": 0, "probe_count": 0, "failure_reason": "..." }`
  - [ ] `caught`: `evaluateSignature(authoredProbes, entry.signature).matched`
  - [ ] `cost_usd`: computed from `dispatchOutcome.tokenUsage` using model pricing constants (follow the pattern from v1 eval or `src/modules/run-model/cost-calc.ts` if available)
  - [ ] `wall_clock_ms`: elapsed ms from dispatch start to response
  - [ ] `probe_count`: `authoredProbes.length`
  - [ ] `failure_reason`: populated when `caught = false` — include `dispatchOutcome.error` if dispatch failed, or "no authored probe matched signature" + first unmatched signature regex if dispatch succeeded but probes didn't match
  - [ ] After all cases, emit aggregate JSON to stdout on a final line (or write to `--output` file): `{ "catch_rate": 0.0, "total_cost_usd": 0.0, "total_wall_clock_ms": 0, "per_case": [...] }`
  - [ ] Aggregate keys mirror v1 report shape (`timestamp`, `substrate_version`, `corpus_path`, `threshold`, `dry_run`, `decision`) plus new fields `total_cost_usd`, `total_wall_clock_ms`, `per_case`
  - [ ] `decision`: `catch_rate >= 0.5 ? "GREEN" : catch_rate >= 0.3 ? "YELLOW" : "RED"` (same rubric as v1)
  - [ ] Exit 0 when `catch_rate >= threshold`, exit 1 otherwise

- [ ] Task 5: Add dry-run mode, list-cases mode, and unit tests (AC: #3, #4, #5)
  - [ ] `--dry-run`: use each entry's `mock_authored_probes` instead of dispatching — enables eval-logic testing without LLM cost; per-case `cost_usd` = 0, `wall_clock_ms` = 0
  - [ ] `--list-cases`: print each entry's `id` and `description` to stdout, one per line, then exit 0 — no dispatch, no dry-run overhead; enables lightweight corpus verification in CI
  - [ ] Create `scripts/__tests__/eval-probe-author-state-integrating.test.ts` with unit tests:
    - `parseStateIntegratingCorpus`: valid YAML parses correctly; missing `signature` throws; missing `id` throws; non-array `signature` throws
    - Per-case result shape: `caught = true` when mock probes match signature; `caught = false` with `failure_reason` when no probe matches
    - `computeCatchRate` round-trip: 8 cases, some caught/some not, correct catch_rate
    - Aggregate report shape: all required keys present in dry-run output
  - [ ] Verify all new tests pass alongside existing `eval-probe-author.test.ts`

## Dev Notes

### Architecture Constraints

- **Corpus file path**: `packs/bmad/eval/probe-author-state-integrating-corpus.yaml` — pure YAML (not markdown-with-embedded-YAML like the v1 corpus at `_bmad-output/planning-artifacts/probe-author-defect-corpus.md`)
- **Eval script**: `scripts/eval-probe-author-state-integrating.mjs` — sibling to `scripts/eval-probe-author.mjs`; do NOT modify the v1 script (its 4/4 catch rate is empirically validated under v0.20.39 and is a load-bearing baseline)
- **Shared library**: reuse `evaluateSignature` and `computeCatchRate` from `scripts/eval-probe-author/lib.mjs`; add `parseStateIntegratingCorpus` to that lib or inline it in the new script
- **No TypeScript build step**: the scripts are `.mjs` (ESM), run directly via `node scripts/eval-probe-author-state-integrating.mjs` — no `tsc` compilation required for the scripts themselves
- **Test framework**: `vitest` — match pattern from `scripts/__tests__/eval-probe-author.test.ts`
- **Probe-author dispatch**: invokes `node dist/cli/index.js probe-author dispatch --story-file <tmp> --story-key <id> --bypass-gates --output-format json` with `LOG_LEVEL=silent` (see `dispatchProbeAuthor` in `scripts/eval-probe-author.mjs` for the exact invocation)

### File Paths

| Path | Description |
|---|---|
| `packs/bmad/eval/probe-author-state-integrating-corpus.yaml` | New corpus file (AC1) — create `packs/bmad/eval/` directory |
| `scripts/eval-probe-author-state-integrating.mjs` | New sibling eval script (AC2) |
| `scripts/eval-probe-author/lib.mjs` | Existing shared library — reuse, optionally extend |
| `scripts/__tests__/eval-probe-author-state-integrating.test.ts` | Unit tests |
| `scripts/eval-probe-author.mjs` | Existing v1 eval script — DO NOT MODIFY |
| `_bmad-output/planning-artifacts/probe-author-defect-corpus.md` | Existing v1 corpus (markdown format) — reference for schema conventions |

### Corpus YAML Schema

Each entry in `applicable_entries` must have:

```yaml
- id: entry-N-<kebab-label>          # required; unique; used in --list-cases output
  story_key: '<hyphen-form>'         # optional; for reference only
  description: "..."                 # required; one-line human label
  source_ac: |                       # required; the AC text sent to probe-author
    ...
  broken_implementation: |           # required; what the broken impl does
    ...
  real_state_condition: |            # required; the real-state condition that breaks it
    ...
  signature:                         # required; non-empty list of regex strings
    - 'regex1'                       # ALL must match JSON.stringify(probe) for ANY probe
    - 'regex2'
  mock_authored_probes:              # required; ≥1 probe; used in --dry-run mode
    - name: probe-name
      sandbox: host | twin
      command: |
        ...
      expect_stdout_regex:           # optional
        - '...'
      expect_stdout_no_regex:        # optional
        - '...'
```

The `signature` evaluation is identical to v1: `JSON.stringify(probe)` is tested against all regex strings; entry is "caught" if ANY probe in the authored set matches ALL regex strings.

### Corpus Entry Design: Signature Authoring Rules

Signature regexes must be:
1. **Specific enough** to reject a weak probe (e.g., `echo "git log"` shouldn't match `git\s+log` if we require the command to actually invoke git)
2. **Permissive enough** to match any reasonable "good" probe shape for the defect class
3. **Machine-checkable**: no prose predicates; every signature entry must be a valid JavaScript regex string

Pattern: use 2-3 signature items per entry — one anchoring the key operation (e.g., `git\s+log`), one anchoring the real-state fixture or assertion (e.g., `alpha|beta|fleet`).

### Fixture Authoring: Minimum Viable Source ACs

Each `source_ac` must be short enough to fit in a probe-author prompt token budget but specific enough to trigger the state-integration signal. Aim for 3–5 lines describing:
- What external state the implementation reads/writes/queries
- What the output should reflect
- Optional: any failure mode from the obs description

### v1 Eval Script Reference

Study `scripts/eval-probe-author.mjs` before implementing:
- `parseArgs()` pattern for CLI flags
- `dispatchProbeAuthor(entry, opts)` for the substrate subcommand invocation
- `main()` loop structure for iterating entries and aggregating results
- Output file write + stderr summary pattern

The new script should feel like a natural extension of v1, not a rewrite.

### Model Pinning

Check `packs/bmad/manifest.yaml` for the `probe-author` task entry to find the pinned model (likely `claude-opus-4-7` or similar). Pass this as a constant in the new eval script. If the manifest's probe-author task doesn't expose a `--model` override via the dispatch subcommand, document the pinned model in a `PINNED_MODEL` constant comment at the top of the script with a note about how to update it when the model rotates.

### Testing Requirements

- Unit tests use `vitest` — import lib functions directly (no subprocess spawning in unit tests)
- Unit tests do NOT dispatch to probe-author (mock the dispatch function)
- Unit tests cover: corpus YAML parsing (valid / missing fields / wrong types), per-case result shape (caught/missed/failure_reason), aggregate computation, `--dry-run` mode using `mock_authored_probes`
- Full live eval (≥8 LLM dispatches) is manual / CI-opt-in only — estimated $0.10–$0.40 and 15–45 min wall clock
- `--list-cases` and `--dry-run` enable lightweight CI verification without dispatch cost

## Runtime Probes

```yaml
- name: corpus-parses-and-has-min-cases
  sandbox: host
  command: |
    node -e "
    const yaml = require('js-yaml');
    const fs = require('fs');
    const data = yaml.load(
      fs.readFileSync('packs/bmad/eval/probe-author-state-integrating-corpus.yaml', 'utf8')
    );
    const cases = Array.isArray(data) ? data : (data.applicable_entries || []);
    if (!cases.length || cases.length < 8) {
      console.error('FAIL: corpus has ' + cases.length + ' cases, expected >= 8');
      process.exit(1);
    }
    for (const c of cases) {
      for (const f of ['id', 'source_ac', 'signature', 'mock_authored_probes']) {
        if (!c[f] || (Array.isArray(c[f]) && c[f].length === 0)) {
          console.error('FAIL: case ' + (c.id || '?') + ' missing or empty field: ' + f);
          process.exit(1);
        }
      }
    }
    console.log('OK: ' + cases.length + ' corpus cases, all fields present');
    "
  description: corpus YAML parses correctly and has ≥8 complete entries with required fields
  expect_stdout_regex:
    - 'OK: \d+ corpus cases, all fields present'
  expect_stdout_no_regex:
    - 'FAIL:'

- name: eval-script-list-cases
  sandbox: host
  command: |
    node scripts/eval-probe-author-state-integrating.mjs \
      --corpus packs/bmad/eval/probe-author-state-integrating-corpus.yaml \
      --list-cases
  description: eval script lists all corpus cases without dispatching; verifies CLI wiring and corpus loading
  expect_stdout_regex:
    - 'entry-1-obs017'
    - 'entry-8'
  expect_stdout_no_regex:
    - 'Error:'
    - 'Cannot find module'
    - 'undefined'

- name: eval-script-dry-run-report-shape
  sandbox: host
  command: |
    node scripts/eval-probe-author-state-integrating.mjs \
      --corpus packs/bmad/eval/probe-author-state-integrating-corpus.yaml \
      --dry-run \
      --output /tmp/si-eval-dry-run.json \
      --threshold 0
    node -e "
    const r = JSON.parse(require('fs').readFileSync('/tmp/si-eval-dry-run.json', 'utf8'));
    const hasAgg = r.catch_rate !== undefined && r.total_cost_usd !== undefined && Array.isArray(r.per_case);
    const hasCaseFields = r.per_case.every(c =>
      'caught' in c && 'cost_usd' in c && 'wall_clock_ms' in c && 'probe_count' in c
    );
    if (hasAgg && hasCaseFields && r.per_case.length >= 8) {
      console.log('OK: ' + r.per_case.length + ' per-case results, aggregate shape valid');
    } else {
      console.error('FAIL: report shape invalid — hasAgg=' + hasAgg + ' hasCaseFields=' + hasCaseFields + ' count=' + (r.per_case || []).length);
      process.exit(1);
    }
    "
  description: dry-run eval produces valid JSON report with per-case and aggregate fields matching AC4/AC5
  expect_stdout_regex:
    - 'OK: \d+ per-case results, aggregate shape valid'
  expect_stdout_no_regex:
    - 'FAIL:'
    - 'SyntaxError'
```

## Interface Contracts

- **Import**: `evaluateSignature`, `computeCatchRate` @ `scripts/eval-probe-author/lib.mjs` (from Story 60-14d)
- **Import**: probe-author dispatch subcommand @ `dist/cli/index.js probe-author dispatch` (from Story 60-13)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
