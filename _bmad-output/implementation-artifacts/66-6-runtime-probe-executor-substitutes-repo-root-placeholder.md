---
external_state_dependencies:
  - subprocess
  - filesystem
---
# Story 66-6: runtime probe executor substitutes `<REPO_ROOT>` placeholder

## Story

As a substrate verification pipeline operator,
I want the runtime probe executor to substitute `<REPO_ROOT>` and `$REPO_ROOT` placeholders in probe commands before shell invocation,
so that probes authored with `<REPO_ROOT>/path` syntax per the probe-author convention actually resolve against the project root instead of failing with "No such file or directory".

## Acceptance Criteria

<!-- source-ac-hash: 3ed594f0293d7a59de3bea430e6993fb4fd84b2ac0eda1fdefbfcd64757ecd41 -->

1. New helper `substituteRuntimePlaceholders(command: string, projectRoot: string): string`
   in `packages/sdlc/src/verification/probes/executor.ts` (or a
   sibling module). Replaces every literal `<REPO_ROOT>` substring
   with `projectRoot`. Replaces every `$REPO_ROOT` token (whitespace-
   or punctuation-bounded) with `projectRoot` as well.
2. The executor invokes `substituteRuntimePlaceholders(probe.command, cwd)`
   before passing to shell. Both `executeProbeOnHost` and `twin`
   sandbox paths apply substitution consistently.
3. Probes WITHOUT placeholders are unchanged byte-for-byte (no
   spurious substitution).
4. Probes containing `<REPO_ROOT>` appearing twice substitute both.
5. Probes containing unknown `<UNKNOWN_PLACEHOLDER>` strings reach
   the shell unchanged (Story 66-7 handles the unknown-placeholder
   finding category separately).
6. Tests: ≥4 unit tests covering positive cases, negative cases,
   double-occurrence, and unknown-placeholder pass-through. Use
   inline fixtures.
7. Integration test: author a probe with `cd <REPO_ROOT> && pwd`,
   run via the executor, assert exit 0 and stdout matches the
   expected projectRoot.
8. Backward-compat: any existing probe shell that legitimately
   contained the literal text `<REPO_ROOT>` (none expected) would
   change behavior — flagged in commit message as expected.
9. Commit message references obs_2026-05-04_024 fix #1.

## Tasks / Subtasks

- [ ] Task 1: Implement `substituteRuntimePlaceholders` helper (AC: #1, #3, #4, #5)
  - [ ] Add exported function `substituteRuntimePlaceholders(command: string, projectRoot: string): string` to `packages/sdlc/src/verification/probes/executor.ts` (or a sibling `placeholder-substitution.ts` in the same directory)
  - [ ] Replace all occurrences of literal `<REPO_ROOT>` using a global replace (`replaceAll` or `/\<REPO_ROOT\>/g`)
  - [ ] Replace `$REPO_ROOT` tokens that are whitespace- or punctuation-bounded (e.g. `/\$REPO_ROOT(?=[^A-Za-z0-9_]|$)/g`) with `projectRoot`
  - [ ] Leave all other `<...>` placeholder patterns untouched (pass-through for unknown placeholders per AC #5)

- [ ] Task 2: Wire substitution into both executor call sites (AC: #2)
  - [ ] In `executeProbeOnHost`, apply `substituteRuntimePlaceholders(probe.command, cwd)` and pass the result to `spawn` instead of `probe.command` directly
  - [ ] Confirm or implement the same substitution in the `twin` sandbox execution path in `executor.ts` (or wherever twin probes are dispatched)
  - [ ] Verify `cwd` used as `projectRoot` is the same value already resolved from `options.cwd ?? process.cwd()` (executor.ts ~line 174)

- [ ] Task 3: Add unit tests for `substituteRuntimePlaceholders` (AC: #6)
  - [ ] Create `packages/sdlc/src/__tests__/verification/probes/executor.test.ts`
  - [ ] Positive case: `<REPO_ROOT>/src/index.ts` → `<projectRoot>/src/index.ts`
  - [ ] Positive case: `ls $REPO_ROOT/packages` → `ls <projectRoot>/packages`
  - [ ] Double-occurrence case: `cd <REPO_ROOT> && ls <REPO_ROOT>/src` — both occurrences substituted
  - [ ] Negative/no-placeholder case: `echo hello` — returned byte-for-byte identical
  - [ ] Unknown-placeholder pass-through: `grep foo <UNKNOWN_PLACEHOLDER>/bar` — `<UNKNOWN_PLACEHOLDER>` unchanged, `<REPO_ROOT>` (if present) still substituted

- [ ] Task 4: Add integration test for end-to-end executor execution (AC: #7)
  - [ ] In the same test file, add an integration test that calls `executeProbeOnHost` with a probe `{ command: 'cd <REPO_ROOT> && pwd', sandbox: 'host', name: 'test-repo-root-substitution' }`
  - [ ] Assert the result `outcome` is `'pass'`
  - [ ] Assert `stdoutTail` contains `process.cwd()` (trimmed)

## Dev Notes

### Architecture Constraints
- `substituteRuntimePlaceholders` must be **exported** from `executor.ts` (or its sibling module) so it can be unit-tested independently
- Both `executeProbeOnHost` and the twin-sandbox path must apply substitution before the command reaches the shell — no path should bypass it
- Use the existing `cwd` binding in `executeProbeOnHost` (already resolved as `options.cwd ?? process.cwd()` at ~line 174) as the `projectRoot` argument — do not introduce a new config knob or option
- `$REPO_ROOT` substitution must be bounded so it doesn't corrupt adjacent identifiers (e.g. `$REPO_ROOT_EXTRA` must NOT be substituted)
- Unknown placeholders (e.g. `<UNKNOWN_PLACEHOLDER>`) must pass through unchanged — Story 66-7 handles the unknown-placeholder finding category

### Testing Requirements
- Unit tests for `substituteRuntimePlaceholders` use inline string fixtures only (no file I/O, no subprocess)
- Integration test calls `executeProbeOnHost` directly; asserts the real shell runs and stdout contains the actual `process.cwd()` value
- Test file: `packages/sdlc/src/__tests__/verification/probes/executor.test.ts` (new file; no existing executor test file in this directory)
- Test framework: vitest (match existing `packages/sdlc/src/__tests__/` convention)
- Minimum 4 unit tests + 1 integration test (AC #6 and #7)

### Key File Locations
- Executor: `packages/sdlc/src/verification/probes/executor.ts`
  - `executeProbeOnHost` export at ~line 169
  - `cwd` resolved at ~line 174 (`options.cwd ?? process.cwd()`)
  - `spawn(probe.command, [], {...})` call site at ~line 183 — substitute before this call
- probe-author convention reference: `packs/bmad/prompts/probe-author.md:113`
- Existing test pattern examples: `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts`

### Commit Message Requirements
- Reference `obs_2026-05-04_024 fix #1` (AC #9)
- Note backward-compat change: probes previously containing literal `<REPO_ROOT>` text (none expected in practice) will now have the text substituted with the project root path (AC #8)

## Runtime Probes

```yaml
- name: substitute-runtime-placeholders-tests-pass
  sandbox: host
  command: |
    cd <REPO_ROOT> && npm run test:fast -- --reporter=verbose --run packages/sdlc/src/__tests__/verification/probes/executor
  description: all substituteRuntimePlaceholders unit tests and the end-to-end integration test pass

- name: repo-root-probe-executes-correctly
  sandbox: host
  command: |
    set -e
    cd <REPO_ROOT>
    EXPECTED=$(pwd)
    RESULT=$(node -e "
    const { executeProbeOnHost } = require('./packages/sdlc/dist/verification/probes/executor.js');
    executeProbeOnHost({ name: 'smoke', sandbox: 'host', command: 'cd <REPO_ROOT> && pwd' })
      .then(r => { process.stdout.write(r.stdoutTail); process.exit(r.outcome === 'pass' ? 0 : 1); });
    " 2>/dev/null)
    echo "result: $RESULT"
    echo "$RESULT" | grep -qF "$EXPECTED"
  description: after build, a probe containing <REPO_ROOT> resolves and exits 0 with stdout matching the project root
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
