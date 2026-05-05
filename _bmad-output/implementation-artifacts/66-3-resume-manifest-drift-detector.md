---
external_state_dependencies:
  - filesystem
---

# Story 66-3: `substrate resume` manifest-vs-disk drift detector + `--force-from-manifest` flag

## Story

As an operator using substrate,
I want `substrate resume` to detect when the manifest phase is stale relative to my working-tree state,
so that I don't accidentally clobber dev-story output that the orchestrator wrote but failed to persist to the manifest (obs_2026-05-03_022 class).

## Acceptance Criteria

<!-- source-ac-hash: 0318ac7c1ec01736f52febf343972e65aa320c9ca38066dcc34825323c6b3601 -->

1. `src/cli/commands/resume.ts` (or its helper) gains a
   `detectManifestDriftAgainstWorkingTree(manifest, projectRoot)`
   helper returning `{drifted: boolean, evidence: { storyKey: string, sampleFiles: string[] }[] }`.
2. The helper is invoked at the start of resume; if `drifted === true`
   and `--force-from-manifest` was NOT passed, resume exits non-zero
   with the error message above (or substantively similar).
3. New `--force-from-manifest` boolean flag on `substrate resume`
   bypasses the drift check.
4. Drift detection scans configurable globs (default:
   `packages/*/src/**/*.ts`, `src/**/*.ts`); the glob set is
   overridable via `SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS` env var
   (comma-separated).
5. Integration test in `__tests__/integration/resume-manifest-drift.test.ts`:
   creates a fake manifest at IN_STORY_CREATION with `updated_at` of
   `T - 600s`; writes a fake source file to a tmpdir at `T`; runs
   resume against the fake manifest and asserts non-zero exit + error
   message contains "manifest drift detected"; re-runs with
   `--force-from-manifest` and asserts resume proceeds.
6. Coexists with `substrate resume`'s existing semantics — when no
   drift is detected, resume behavior is unchanged (regression-test
   guarded with at least one fixture where the manifest is coherent
   with disk).
7. Commit message references obs_2026-05-03_022 fix #3.

**Files involved**:
- `src/cli/commands/resume.ts` (drift check + flag)
- new helper module (likely `src/cli/commands/resume-drift-detector.ts`)
- `__tests__/integration/resume-manifest-drift.test.ts` (new)

## Tasks / Subtasks

- [ ] Task 1: Create `src/cli/commands/resume-drift-detector.ts` with the drift detection helper (AC: #1, #4)
  - [ ] Define and export `DriftEvidence` interface `{ storyKey: string; sampleFiles: string[] }` and `DriftDetectionResult` interface `{ drifted: boolean; evidence: DriftEvidence[] }`
  - [ ] Implement `detectManifestDriftAgainstWorkingTree(manifest, projectRoot)` as an async function that iterates `per_story_state` entries where `phase === 'IN_STORY_CREATION' && status === 'dispatched'`
  - [ ] Read scan globs from `SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS` env var (comma-separated) with fallback to `['packages/*/src/**/*.ts', 'src/**/*.ts']`
  - [ ] For each qualifying story entry, use the manifest entry's `updated_at` timestamp; glob-scan the project root for files whose `fs.stat().mtimeMs` exceeds that timestamp; collect up to 3 sample file paths as evidence
  - [ ] Return `{ drifted: true, evidence: [...] }` if newer files are found for any qualifying story, `{ drifted: false, evidence: [] }` otherwise

- [ ] Task 2: Update `src/cli/commands/resume.ts` to add `--force-from-manifest` flag and invoke drift check (AC: #2, #3)
  - [ ] Add `--force-from-manifest` boolean flag to the resume command's CLI option parser (follow existing flag patterns in this file)
  - [ ] At the start of the resume command handler — before any existing resume dispatch logic — load the manifest and call `detectManifestDriftAgainstWorkingTree(manifest, projectRoot)`
  - [ ] If `drifted === true` and `options.forceFromManifest` is falsy: emit the formatted error message (see Dev Notes for required format including "manifest drift detected" substring, sample files, and recovery options), then `process.exit(1)`
  - [ ] If `--force-from-manifest` is present, skip the drift check entirely and proceed with the existing resume logic unchanged

- [ ] Task 3: Write integration tests in `__tests__/integration/resume-manifest-drift.test.ts` (AC: #5, #6)
  - [ ] Test "drift detected → non-zero exit with drift message": create a tmpdir, write a fake manifest with `updated_at = new Date(Date.now() - 600_000).toISOString()` and one story entry at `IN_STORY_CREATION/dispatched`, write a fake `.ts` source file (so its mtime > manifest timestamp), invoke the built CLI binary or import + run the resume handler, assert non-zero exit and output contains `"manifest drift detected"`
  - [ ] Test "drift detected + `--force-from-manifest` → bypasses drift check": same tmpdir/manifest setup, re-run with `--force-from-manifest` flag, assert the process does NOT emit `"manifest drift detected"` and exit immediately due to drift (process may still exit for other reasons)
  - [ ] Test "no drift → resume behavior unchanged" (AC6 regression guard): create a tmpdir with a manifest whose `updated_at` is in the future (`Date.now() + 60_000`), assert the drift check returns `{ drifted: false }` and resume is not blocked

- [ ] Task 4: Final validation (AC: #7)
  - [ ] Run `npm run test:fast` and confirm all new tests pass alongside existing tests
  - [ ] Verify commit message references `obs_2026-05-03_022 fix #3`

## Dev Notes

### Architecture Constraints
- New helper module path: `src/cli/commands/resume-drift-detector.ts` (matches AC1 "or its helper")
- Integration test path: `__tests__/integration/resume-manifest-drift.test.ts` — exact path required by AC5
- The exported function signature is fixed by AC1: `detectManifestDriftAgainstWorkingTree(manifest, projectRoot): Promise<DriftDetectionResult>` where `DriftDetectionResult = { drifted: boolean; evidence: { storyKey: string; sampleFiles: string[] }[] }`
- Drift trigger condition: `per_story_state` entries where **both** `phase === 'IN_STORY_CREATION'` **and** `status === 'dispatched'` — do not trigger on other phases or statuses
- Default scan globs (exact values from AC4): `['packages/*/src/**/*.ts', 'src/**/*.ts']`
- Env var name (exact from AC4): `SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS` (comma-separated list)
- Error output must contain the substring `"manifest drift detected"` — AC5 asserts on this

### Manifest Shape
Read the existing `resume.ts` to understand how the manifest is loaded and what type it is. The manifest has:
- Top-level `updated_at` (ISO string)
- `per_story_state: Record<string, { phase: string; status: string; updated_at: string; ... }>`

Use the manifest entry's own `updated_at` (not top-level) for per-story drift comparison — individual story entries may have been updated at different times than the manifest header.

### Glob Scanning
Prefer the glob library already used elsewhere in the project (likely `fast-glob` or `glob`). Search for existing `import * from 'fast-glob'` / `import * as glob from 'glob'` in `src/` to find the in-use pattern. The glob patterns must be resolved relative to `projectRoot`.

Mtime comparison: `(await fs.promises.stat(filePath)).mtimeMs > new Date(storyEntry.updated_at).getTime()`.

### Error Message Format
The error message must be substantively similar to (and contain `"manifest drift detected"`):

```
substrate resume: manifest drift detected for story <key>
  manifest phase: IN_STORY_CREATION dispatched (recorded <ago>)
  working tree:   <N> files newer than manifest (sample: <path1>, <path2>, ...)

This usually means the orchestrator died after writing dev-story output but
before persisting the phase advancement (obs_2026-05-03_022 class).
Re-dispatching from IN_STORY_CREATION would clobber that work.

Recovery options:
  1. Inspect the working tree, validate dev-story output, then commit it
     as if the pipeline had shipped LGTM — see obs_022 recovery runbook.
  2. To proceed with re-dispatch anyway (clobbering disk state),
     re-run with --force-from-manifest.
```

Format `<ago>` as a human-readable duration (e.g., `"10 minutes ago"`). Include all drifted stories if multiple qualify.

### Import Patterns
- Import existing manifest-loading and projectRoot-resolution utilities from `resume.ts` or its existing helpers — do not re-implement
- `resume-drift-detector.ts` must be a pure module with no side effects on import; functions should be async
- Export types explicitly so integration tests can import `DriftDetectionResult` for type assertions without triggering CLI side effects

### Testing Approach
- Integration tests in `__tests__/integration/` use the project's vitest framework
- For the CLI invocation test, use `execa` or `child_process.execFileSync` against the built `dist/cli.mjs` binary; OR import and call the resume handler directly with a mock argv if the existing integration tests show that pattern
- Control mtime by writing the file AFTER setting the manifest `updated_at` in the past — no need for `utimes`/`futimes` syscalls since `touch` / `fs.writeFileSync` sets mtime to "now"
- For the `--force-from-manifest` bypass test: assert the output does NOT contain `"manifest drift detected"` — the process may still fail for other reasons (no active run, network, etc.) which is acceptable

## Runtime Probes

```yaml
- name: resume-drift-detected-exits-nonzero
  sandbox: twin
  command: |
    set -e
    cd <REPO_ROOT>
    npm run build --silent
    WORK=$(mktemp -d)
    mkdir -p "$WORK/.substrate" "$WORK/src"
    STALE_TS=$(node -e "process.stdout.write(new Date(Date.now()-600000).toISOString())")
    node -e "
    const fs = require('fs');
    fs.writeFileSync('$WORK/.substrate/state.json', JSON.stringify({
      updated_at: '$STALE_TS',
      per_story_state: {
        'probe-story': { phase: 'IN_STORY_CREATION', status: 'dispatched', updated_at: '$STALE_TS' }
      }
    }));"
    # Write a source file whose mtime is 'now' — newer than the stale manifest
    touch "$WORK/src/probe-file.ts"
    cd "$WORK"
    SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS="src/**/*.ts" \
      node <REPO_ROOT>/dist/cli.mjs resume 2>&1 || true
  expect_stdout_regex:
    - 'manifest drift detected'
  description: |
    Sets up a manifest whose updated_at is 10min ago and writes a newer src file.
    resume must emit "manifest drift detected" and exit non-zero.
    NOTE: adjust dist/cli.mjs path and .substrate/state.json schema to match actual substrate layout.

- name: resume-force-from-manifest-bypasses-drift
  sandbox: twin
  command: |
    set -e
    cd <REPO_ROOT>
    WORK=$(mktemp -d)
    mkdir -p "$WORK/.substrate" "$WORK/src"
    STALE_TS=$(node -e "process.stdout.write(new Date(Date.now()-600000).toISOString())")
    node -e "
    const fs = require('fs');
    fs.writeFileSync('$WORK/.substrate/state.json', JSON.stringify({
      updated_at: '$STALE_TS',
      per_story_state: {
        'probe-story': { phase: 'IN_STORY_CREATION', status: 'dispatched', updated_at: '$STALE_TS' }
      }
    }));"
    touch "$WORK/src/probe-file.ts"
    cd "$WORK"
    OUTPUT=$(SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS="src/**/*.ts" \
      node <REPO_ROOT>/dist/cli.mjs resume --force-from-manifest 2>&1 || true)
    echo "$OUTPUT"
  expect_stdout_no_regex:
    - 'manifest drift detected'
  description: |
    Same drift scenario but --force-from-manifest is passed: drift check must be bypassed.
    Process may exit for other reasons (no active run, etc.), but must NOT print "manifest drift detected".
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
