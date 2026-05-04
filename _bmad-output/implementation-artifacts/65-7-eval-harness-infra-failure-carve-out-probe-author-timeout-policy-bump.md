# Story 65-7: eval-harness infra-failure carve-out + probe-author timeout policy bump

## Story

As a substrate pipeline operator,
I want the eval harness to separate infrastructure timeout failures from logical probe-author misses and the probe-author dispatcher to use a more generous timeout,
so that catch-rate metrics accurately reflect probe-author quality rather than infra transience.

## Acceptance Criteria

<!-- source-ac-hash: bb3e7603082bc474ec5cdca28e15710f90c92fe62fc280fafdf165b3d1017d65 -->

1. `scripts/eval-probe-author-state-integrating.mjs` aggregate report shape includes `infra_failure_count: number` and `logical_catch_rate: number` (= `caught / (total - infra_failure_count)`). `infra_failure_count` counts entries whose `failure_reason` matches `/spawnSync.*ETIMEDOUT/i` or `/spawn.*timeout/i`.

2. NaN guard: when `total === infra_failure_count` (every case timed out), `logical_catch_rate: 0` (not NaN, not 1).

3. Decision rubric prints both `catch_rate` and `logical_catch_rate` so the operator can compare. Decision verdict (GREEN/YELLOW/RED) continues to use `catch_rate` for backward compat.

4. Default probe-author dispatcher timeout raised from `300000` ms to `600000` ms (initial attempt). Retry timeout from `450000` ms to `900000` ms. Configurable via `SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS` env var (overrides initial; retry is `1.5x` the initial).

5. Mirror the carve-out fields in the existing v1 event-driven harness (`scripts/probe-author-eval.ts` or equivalent) — so both eval shapes converge on the same report contract.

6. Tests: ≥3 new test cases in `scripts/__tests__/eval-probe-author-state-integrating.test.ts`: carve-out math (caught=6, total=8, infra_failure_count=2 → logical_catch_rate=1.0), NaN guard (all infra-fails → logical_catch_rate=0), decision-rubric output includes both rates.

7. obs_2026-05-04_023 referenced in commit message + status_history entry updated to `partial-fix-shipped` after ship.

## Tasks / Subtasks

- [ ] Task 1: Add `infra_failure_count` and `logical_catch_rate` to state-integrating eval aggregate (AC: #1, #2)
  - [ ] In `scripts/eval-probe-author-state-integrating.mjs`, after collecting `perCase` results, count entries where `failure_reason` matches `/spawnSync.*ETIMEDOUT/i` or `/spawn.*timeout/i` — this is `infra_failure_count`
  - [ ] Compute `logical_catch_rate`: when `total === infra_failure_count` return `0`; otherwise `caught / (total - infra_failure_count)`
  - [ ] Add both `infra_failure_count` and `logical_catch_rate` fields to the `report` object written to the output file

- [ ] Task 2: Update decision rubric to print both catch rates (AC: #3)
  - [ ] In `scripts/eval-probe-author-state-integrating.mjs`, extend the `process.stderr.write` decision rubric output to include both `catch_rate` and `logical_catch_rate` (e.g., `catch rate X% | logical catch rate Y% (excl. Z infra fails)`)
  - [ ] Confirm GREEN/YELLOW/RED verdict logic continues to reference `catchRate` (not `logical_catch_rate`) — backward-compat is required

- [ ] Task 3: Raise probe-author dispatcher timeout and add `SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS` support (AC: #4)
  - [ ] In `src/modules/compiled-workflows/probe-author.ts`, read `process.env.SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS` at module initialisation; when set and parseable as integer, use it as `initialTimeoutMs`; otherwise default to `600_000`
  - [ ] Compute `retryTimeoutMs = Math.round(1.5 * initialTimeoutMs)` (default retry: `900_000`)
  - [ ] Replace `DEFAULT_TIMEOUT_MS = 300_000` constant with the dynamic `initialTimeoutMs` value
  - [ ] If a retry path exists in the dispatcher invocation, apply `retryTimeoutMs` there; otherwise document in a comment that retry timeout is wired for future retry path and expose the computed value as an exported constant for tests

- [ ] Task 4: Mirror carve-out fields in v1 event-driven eval harness (AC: #5)
  - [ ] In `scripts/eval-probe-author.mjs` (the v1 event-driven harness from Story 60-14d), after collecting per-case results, compute `infra_failure_count` using the same regex logic (`/spawnSync.*ETIMEDOUT/i` or `/spawn.*timeout/i` on `failure_reason`)
  - [ ] Compute `logical_catch_rate` with the same NaN guard (return `0` when `total === infra_failure_count`)
  - [ ] Add both fields to the report object written to the output file; update the stderr rubric to print both rates

- [ ] Task 5: Write ≥3 test cases in the state-integrating eval test file (AC: #6)
  - [ ] Open `scripts/__tests__/eval-probe-author-state-integrating.test.ts`; import (or directly exercise) the aggregate calculation logic from `eval-probe-author-state-integrating.mjs`
  - [ ] Add test: carve-out math — build 8 per-case entries (6 caught, 2 with `failure_reason` matching `/spawnSync.*ETIMEDOUT/i`); assert `infra_failure_count === 2` and `logical_catch_rate === 1.0`
  - [ ] Add test: NaN guard — all 3 entries have `failure_reason: 'spawnSync node: ETIMEDOUT'`; assert `logical_catch_rate === 0` (not NaN)
  - [ ] Add test: decision-rubric output — run the rubric format logic (or spy on stderr); assert that the output string includes both `catch_rate`-derived percentage and `logical_catch_rate`-derived percentage

## Dev Notes

### File Locations

| File | Role |
|---|---|
| `scripts/eval-probe-author-state-integrating.mjs` | Primary target for AC1–3 |
| `scripts/eval-probe-author.mjs` | V1 event-driven harness to mirror (AC5) |
| `src/modules/compiled-workflows/probe-author.ts` | Probe-author dispatcher — timeout constants (AC4) |
| `scripts/__tests__/eval-probe-author-state-integrating.test.ts` | Existing test file — add ≥3 cases (AC6) |

### Existing shapes to extend

**`eval-probe-author-state-integrating.mjs` current aggregate `report` object** (lines ~440–454):
```js
const report = {
  timestamp, substrate_version, corpus_path, threshold, dry_run,
  catch_rate: catchRate,       // keep — backward compat
  total_cost_usd, total_wall_clock_ms,
  per_case: perCase,
  decision,
  caught,
  total,
  // ADD these two:
  infra_failure_count,
  logical_catch_rate,
}
```

**Current stderr rubric** (line ~459):
```js
process.stderr.write(
  `\neval-si: catch rate ${(catchRate * 100).toFixed(1)}% (${caught}/${total}) — ${decision}\n`
)
```
Extend to also print logical catch rate and infra failure count:
```js
process.stderr.write(
  `\neval-si: catch rate ${(catchRate * 100).toFixed(1)}% (${caught}/${total}) | ` +
  `logical catch rate ${(logicalCatchRate * 100).toFixed(1)}% (excl. ${infraFailureCount} infra fails) — ${decision}\n`
)
```

**`src/modules/compiled-workflows/probe-author.ts` current timeout constant** (line ~33):
```ts
/** Default timeout for probe-author dispatches in milliseconds (5 min — lightweight call) */
const DEFAULT_TIMEOUT_MS = 300_000
```
Replace with env-var–driven initialisation:
```ts
/** Default initial timeout: 10 min. Override via SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS (ms). */
const INITIAL_TIMEOUT_MS = process.env.SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS
  ? parseInt(process.env.SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS, 10)
  : 600_000

/** Retry timeout: 1.5× initial (default 15 min). */
const RETRY_TIMEOUT_MS = Math.round(1.5 * INITIAL_TIMEOUT_MS)
```
Then replace all uses of `DEFAULT_TIMEOUT_MS` with `INITIAL_TIMEOUT_MS`.

### infra_failure_count computation pattern

```js
const INFRA_TIMEOUT_RE = /spawnSync.*ETIMEDOUT|spawn.*timeout/i

const infraFailureCount = perCase.filter(
  (c) => c.failure_reason !== undefined && INFRA_TIMEOUT_RE.test(c.failure_reason)
).length

const logicalCatchRate =
  total === infraFailureCount ? 0 : caught / (total - infraFailureCount)
```

Apply the identical pattern in `eval-probe-author.mjs` for AC5.

### Testing Strategy

- `scripts/__tests__/eval-probe-author-state-integrating.test.ts` already exists from Story 65-3.
- The eval script exports `evaluateSignature`, `computeCatchRate`, and `parseStateIntegratingCorpus` for unit testing (the `main()` guard prevents CLI invocation on import). If the aggregate calc is not yet exported, extract it into a named helper function and export it — this is the simplest way to unit-test without spawning processes.
- Alternatively, if the script has an existing pattern for injecting per-case arrays, follow that pattern.
- Do NOT spawn child processes in these tests — the tests must be fast (unit tests).

### Backward Compatibility

- `catch_rate`, `caught`, `total`, `decision` fields in both harnesses are unchanged — new fields are purely additive.
- The GREEN/YELLOW/RED verdict threshold logic is unchanged — it compares `catchRate` (not `logicalCatchRate`) against `args.threshold`.
- Existing tests in both harness test files must continue to pass.

### Commit Message Requirement (AC7)

The commit message must reference `obs_2026-05-04_023`. Example:
```
feat: eval-harness infra-failure carve-out + probe-author timeout policy bump (closes obs_2026-05-04_023 layers 1+2)
```

After shipping, update the status_history of `obs_2026-05-04_023` in the observations tracking file to `partial-fix-shipped`.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

## Runtime Probes

```yaml
- name: eval-si-carve-out-tests-pass
  sandbox: host
  command: |
    npx vitest run scripts/__tests__/eval-probe-author-state-integrating.test.ts --reporter=verbose 2>&1
  timeout_ms: 120000
  description: >
    Run the eval-si test suite end-to-end; carve-out math (AC1), NaN guard (AC2), and rubric-format (AC3) tests must all
    pass — AC6's required test cases are the primary runtime verifier for AC1-3.
  expect_stdout_no_regex:
    - Tests.*\d+\s+failed
    - Test Files.*\d+\s+failed
  expect_stdout_regex:
    - Tests\s+\d+\s+passed
  _authoredBy: probe-author
- name: eval-si-source-has-carve-out-logic
  sandbox: host
  command: |
    node --input-type=module << 'EOF'
    import { readFileSync } from 'fs'
    const src = readFileSync('scripts/eval-probe-author-state-integrating.mjs', 'utf8')
    const check = (label, cond) => console.log(`${label}: ${cond}`)
    check('infra_failure_count_in_report',   /infra_failure_count/.test(src))
    check('logical_catch_rate_in_report',     /logical_catch_rate/.test(src))
    check('etimedout_regex_present',          /ETIMEDOUT/i.test(src))
    check('spawn_timeout_pattern',            /spawn.*timeout/i.test(src))
    check('nan_guard_total_eq_infra',
      /total\s*===\s*infraFailureCount|total\s*===\s*infra_failure_count/.test(src))
    check('rubric_prints_logical_rate',
      /logical.*catch.*rate[\s\S]{0,300}stderr|stderr[\s\S]{0,300}logical.*catch.*rate|logicalCatchRate.*toFixed/i.test(src))
    check('verdict_driven_by_catchRate',
      /catchRate[\s\S]{0,500}(?:GREEN|YELLOW|RED)|(?:GREEN|YELLOW|RED)[\s\S]{0,500}catchRate/.test(src))
    EOF
  description: >
    Verify eval-probe-author-state-integrating.mjs contains the infra-failure carve-out fields (AC1), NaN guard (AC2),
    rubric printing both rates (AC3), and backward-compat verdict logic (AC3).
  expect_stdout_regex:
    - 'infra_failure_count_in_report: true'
    - 'logical_catch_rate_in_report: true'
    - 'etimedout_regex_present: true'
    - 'nan_guard_total_eq_infra: true'
    - 'rubric_prints_logical_rate: true'
    - 'verdict_driven_by_catchRate: true'
  _authoredBy: probe-author
- name: probe-author-timeout-constants-and-env-var
  sandbox: host
  command: |
    node --input-type=module << 'EOF'
    import { readFileSync } from 'fs'
    const src = readFileSync('src/modules/compiled-workflows/probe-author.ts', 'utf8')
    const check = (label, cond) => console.log(`${label}: ${cond}`)
    check('initial_timeout_600k',    /600[_,]?000/.test(src))
    check('retry_timeout_900k',      /900[_,]?000/.test(src))
    check('env_var_name_present',    /SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS/.test(src))
    check('parseInt_env_var',        /parseInt\s*\(\s*process\.env\.SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS/.test(src))
    check('retry_1_5x_formula',      /Math\.round[\s\S]{0,40}1\.5\s*\*|1\.5\s*\*[\s\S]{0,40}Math\.round/.test(src))
    check('retry_ms_exported',       /export\s+const\s+RETRY_TIMEOUT_MS/.test(src))
    check('old_300k_default_removed', !/DEFAULT_TIMEOUT_MS\s*=\s*300/.test(src))
    EOF
  description: >
    Verify probe-author.ts raised the initial timeout to 600 s, retry to 900 s, wires SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS
    env var, applies 1.5× retry formula, exports RETRY_TIMEOUT_MS constant for tests, and removes the old 300 s default
    (AC4).
  expect_stdout_regex:
    - 'initial_timeout_600k: true'
    - 'retry_timeout_900k: true'
    - 'env_var_name_present: true'
    - 'parseInt_env_var: true'
    - 'retry_1_5x_formula: true'
    - 'retry_ms_exported: true'
    - 'old_300k_default_removed: true'
  _authoredBy: probe-author
- name: probe-author-timeout-env-var-runtime
  sandbox: host
  command: |
    # Dynamically import the TypeScript module via tsx to verify runtime behaviour
    SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS=720000 npx tsx --no-cache -e "
      import { RETRY_TIMEOUT_MS } from './src/modules/compiled-workflows/probe-author.ts'
      // With env var = 720000, retry must be Math.round(1.5 * 720000) = 1080000
      console.log('retry_exported:', RETRY_TIMEOUT_MS !== undefined)
      console.log('retry_is_1_5x_env:', RETRY_TIMEOUT_MS === 1080000)
    " 2>/dev/null
  description: >
    Import probe-author.ts at runtime with SUBSTRATE_PROBE_AUTHOR_TIMEOUT_MS=720000 and assert RETRY_TIMEOUT_MS equals 1
    080 000 (= 1.5 × 720 000) — exercises the env-var branch of the timeout initialisation (AC4).
  expect_stdout_regex:
    - 'retry_exported: true'
    - 'retry_is_1_5x_env: true'
  _authoredBy: probe-author
- name: eval-v1-mirrors-carve-out-fields
  sandbox: host
  command: |
    node --input-type=module << 'EOF'
    import { readFileSync, existsSync } from 'fs'
    // AC5: v1 event-driven harness must mirror the same report contract
    const candidates = [
      'scripts/eval-probe-author.mjs',
      'scripts/probe-author-eval.ts',
      'scripts/probe-author-eval.mjs',
    ]
    let src = null, fname = null
    for (const f of candidates) {
      if (existsSync(f)) { src = readFileSync(f, 'utf8'); fname = f; break }
    }
    console.log('v1_file_found:', src !== null)
    if (src) {
      const check = (label, cond) => console.log(`${label}: ${cond}`)
      console.log('v1_file:', fname)
      check('infra_failure_count', /infra_failure_count/.test(src))
      check('logical_catch_rate',  /logical_catch_rate/.test(src))
      check('etimedout_pattern',   /ETIMEDOUT/i.test(src))
      check('nan_guard',
        /total\s*===\s*infraFailureCount|total\s*===\s*infra_failure_count/.test(src))
      check('rubric_has_logical_rate',
        /logical.*catch.*rate[\s\S]{0,300}stderr|stderr[\s\S]{0,300}logical.*catch.*rate|logicalCatchRate.*toFixed/i.test(src))
    }
    EOF
  description: >
    Verify the v1 event-driven eval harness (eval-probe-author.mjs or equivalent) mirrors infra_failure_count,
    logical_catch_rate, NaN guard, and rubric output — converging both eval shapes on the same report contract (AC5).
  expect_stdout_regex:
    - 'v1_file_found: true'
    - 'infra_failure_count: true'
    - 'logical_catch_rate: true'
    - 'etimedout_pattern: true'
    - 'nan_guard: true'
    - 'rubric_has_logical_rate: true'
  _authoredBy: probe-author
- name: obs-023-status-partial-fix-shipped
  sandbox: host
  command: |
    node --input-type=module << 'EOF'
    import { readFileSync, existsSync } from 'fs'
    import { homedir } from 'os'
    const home = homedir()
    const candidates = [
      `${home}/code/jplanow/strata/_observations-pending-cpo.md`,
      '../strata/_observations-pending-cpo.md',
      '../../strata/_observations-pending-cpo.md',
    ]
    let found = false, updated = false
    for (const f of candidates) {
      if (existsSync(f)) {
        const txt = readFileSync(f, 'utf8')
        if (/obs_2026-05-04_023/.test(txt)) {
          found = true
          updated = /partial-fix-shipped/.test(txt)
          break
        }
      }
    }
    console.log('obs_023_entry_found:', found)
    console.log('status_partial_fix_shipped:', updated)
    EOF
  description: >
    Verify obs_2026-05-04_023 exists in the strata observations file and its status_history contains a
    partial-fix-shipped entry (AC7).
  expect_stdout_regex:
    - 'obs_023_entry_found: true'
    - 'status_partial_fix_shipped: true'
  _authoredBy: probe-author
```
