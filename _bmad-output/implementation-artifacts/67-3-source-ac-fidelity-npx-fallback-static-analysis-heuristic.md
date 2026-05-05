# Story 67-3: source-ac-fidelity npx-fallback static-analysis heuristic

## Story

As a substrate verification pipeline consumer,
I want a static-analysis check that detects bare `npx <package>` invocations
in story-modified files,
so that dependency-confusion attack vectors (obs_2026-05-03_023) are surfaced as
`warn`-severity findings before a story ships.

## Acceptance Criteria

<!-- source-ac-hash: ed05307c4eb321bc5a86aaa662aa52e676a9c33e53ce276e739c71114a0d47ba -->

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

## Tasks / Subtasks

- [ ] Task 1: Declare `source-ac-shellout-npx-fallback` finding category (AC: #3)
  - [ ] Open `packages/sdlc/src/verification/findings.ts`; locate where `source-ac-negation-reference` and `source-ac-dependency-reference` are declared and add `source-ac-shellout-npx-fallback` following the same pattern
  - [ ] Confirm the category maps to severity `warn` in any category-to-severity lookup used downstream (e.g., `renderFindings` severity prefix selection)

- [ ] Task 2: Implement `runShelloutCheck` and `SourceAcShelloutCheck` (AC: #1, #4, #6)
  - [ ] Create `packages/sdlc/src/verification/checks/source-ac-shellout-check.ts`
  - [ ] Export `SourceAcShelloutCheck` class implementing `VerificationCheck` (`name = 'source-ac-shellout'`, `tier: 'A'`) with a `run(context)` method that delegates to `runShelloutCheck`
  - [ ] Export standalone `runShelloutCheck(context: VerificationContext): Promise<VerificationResult>` function
  - [ ] Implement `getModifiedFiles(context)`: use `context.devStoryResult?.files_modified` if non-empty; fall back to `git diff --name-only HEAD~1` via `execSync` with `cwd: context.workingDir`; immediately filter out any path ending in `.md`
  - [ ] Implement `isInStringLiteralContext(line: string, matchIndex: number): boolean`: return `true` when `matchIndex` falls inside a single-quoted (`'...'`), double-quoted (`"..."`), or template-literal (`` `...` ``) region, OR when the line starts with `#!` (shebang); return `false` otherwise
  - [ ] Implement `isCommentLine(line: string): boolean`: return `true` when the line, trimmed of leading whitespace, starts with `//` or `#`
  - [ ] Implement `scanFile(absolutePath: string): Array<{lineNum: number; name: string}>`: read content with `fs.readFileSync(absolutePath, 'utf-8')`; split on newlines; for each line apply regex `/npx\s+(?!--no-install)([a-zA-Z0-9_@\-/]+)/g`; skip lines where `isCommentLine` is true; skip matches where `isInStringLiteralContext` is false; return matching `{lineNum, name}` entries (1-indexed line numbers)
  - [ ] Construct `VerificationFinding` per match using the exact message format from AC6: `` `npx fallback detected in ${file}:${lineNum}: "npx ${name}" — bare \`npx <package>\` without \`--no-install\` falls through to the public npm registry on first use. If \`<package>\` isn't a registered binary in your dev dependencies, this is a dependency-confusion vector. Use absolute path or \`npx --no-install <package>\` instead.` ``
  - [ ] Return early `pass` with no findings when `devStoryResult` is absent or `files_modified` is empty and git fallback also returns nothing

- [ ] Task 3: Register check in verification pipeline (AC: #2, #7)
  - [ ] Add `export { SourceAcShelloutCheck } from './source-ac-shellout-check.js'` to `packages/sdlc/src/verification/checks/index.ts`
  - [ ] Import `SourceAcShelloutCheck` in `packages/sdlc/src/verification/verification-pipeline.ts` and append it to the `checks` array in `createDefaultVerificationPipeline()` (after `SourceAcFidelityCheck`, preserving existing order)
  - [ ] Run `npm run build` to confirm TypeScript compilation succeeds with no new errors

- [ ] Task 4: Write unit tests (AC: #5)
  - [ ] Create `packages/sdlc/src/__tests__/verification/source-ac-shellout-check.test.ts`
  - [ ] TC1 (positive — double-quoted shell string): context with `files_modified: ['hooks/install.ts']`; file content `execSync("npx some-tool arg")` → one `source-ac-shellout-npx-fallback` warn finding
  - [ ] TC2 (negative — `--no-install` present): file content `execSync('npx --no-install some-tool')` → zero findings
  - [ ] TC3 (skip `.md` file): `files_modified: ['README.md']`; file content has `npx some-tool` → zero findings (`.md` filtered before scan)
  - [ ] TC4 (skip comment line — `//`): line is `  // npx some-tool` → zero findings
  - [ ] TC5 (skip non-string-literal context — bare code comment): line is `/* run npx strata to install */` with match not inside quotes → zero findings
  - [ ] TC6 (obs_023 reproduction — strata 3-3 hook fixture): file content contains a single-quoted JS string with `'exec npx strata run --hook pre-push "$@"'` → one `source-ac-shellout-npx-fallback` warn finding; message matches format from AC6 (assert substring `"npx strata"` and `dependency-confusion vector` appear in finding message)
  - [ ] TC7 (additional — template literal): file content `` const cmd = `npx prettier --write .` `` → one finding (template literal is a string-literal context)
  - [ ] Run `npm run test:fast` to confirm ≥6 new tests pass and no existing tests regress

## Dev Notes

### File Locations
- **New**: `packages/sdlc/src/verification/checks/source-ac-shellout-check.ts`
- **New**: `packages/sdlc/src/__tests__/verification/source-ac-shellout-check.test.ts`
- **Modified**: `packages/sdlc/src/verification/findings.ts` — new category `source-ac-shellout-npx-fallback`
- **Modified**: `packages/sdlc/src/verification/checks/index.ts` — new export
- **Modified**: `packages/sdlc/src/verification/verification-pipeline.ts` — pipeline registration

### Check Input / Output Contract
Follows `VerificationCheck` interface from `packages/sdlc/src/verification/types.ts`:
```typescript
import type { VerificationContext, VerificationResult } from '../types.js'
import type { VerificationCheck } from '../types.js'
```
Return shape:
```typescript
{
  status: 'pass' | 'warn' | 'fail',
  details: string,       // use renderFindings(findings)
  duration_ms: number,
  findings: VerificationFinding[]
}
```
Status derives from findings: any `error` → `'fail'`; any `warn` → `'warn'`; else `'pass'`. The new check only emits `warn` findings, so status is either `'pass'` or `'warn'`.

### Import Style
All local imports must use `.js` extension (ESM build convention throughout this package):
```typescript
import { renderFindings } from '../findings.js'
import type { VerificationContext, VerificationResult, VerificationCheck } from '../types.js'
```

### Class Shape Pattern
Follow the pattern from `packages/sdlc/src/verification/checks/build-check.ts` or `phantom-review-check.ts`:
```typescript
export class SourceAcShelloutCheck implements VerificationCheck {
  name = 'source-ac-shellout'
  tier: 'A' | 'B' = 'A'
  async run(context: VerificationContext): Promise<VerificationResult> {
    return runShelloutCheck(context)
  }
}
```

### Finding Category Declaration
In `findings.ts`, find where `source-ac-negation-reference` and `source-ac-dependency-reference`
are declared (they are `info`-severity entries). Add `source-ac-shellout-npx-fallback` at
`warn` severity nearby. The `renderFindings()` helper renders each severity with its prefix
(`WARN`, `ERROR`, `INFO`) so no custom rendering code is needed.

### Detection Regex
```typescript
const NPX_PATTERN = /npx\s+(?!--no-install)([a-zA-Z0-9_@\-/]+)/g
```
Apply per line (reset `lastIndex` between lines or use `match()` on each line string). The
captured group `[1]` is `<name>` for the finding message.

### String-Literal Context Detection
Track open/close quote regions per line. Simplest correct implementation:
scan the line character by character from index 0, toggling `inSingle`, `inDouble`,
`inTemplate` flags at unescaped quote characters (check `line[i-1] !== '\\'` for escaping).
Return `true` if `matchIndex` falls between any open/close pair. Also return `true` when
`line.trimStart().startsWith('#!')` (shebang lines are shell string context).

### Modified Files Source Priority
1. `context.devStoryResult?.files_modified` — agent-reported list (preferred; no I/O)
2. `execSync('git diff --name-only HEAD~1', { cwd: context.workingDir, encoding: 'utf-8' })` — fallback
3. If both are empty/unavailable, return early `pass` (skip rule for missing context mirrors the pattern in `AcceptanceCriteriaEvidenceCheck`)

Always resolve file paths relative to `context.workingDir` before passing to `scanFile`.

### Test Fixture Pattern
Write fixture files to a `tmp` directory scoped per test:
```typescript
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const tmpDir = mkdtempSync(join(tmpdir(), 'shellout-check-'))
const filePath = join(tmpDir, 'hooks', 'install.ts')
mkdirSync(join(tmpDir, 'hooks'), { recursive: true })
writeFileSync(filePath, fileContent)

const ctx: VerificationContext = {
  storyKey: '67-3',
  workingDir: tmpDir,
  commitSha: 'abc123',
  timeout: 30000,
  devStoryResult: { files_modified: ['hooks/install.ts'] }
}
const result = await runShelloutCheck(ctx)
```
Clean up `tmpDir` in `afterEach` to avoid leaking temp files.

### obs_023 Reproduction Fixture (TC6)
The strata 3-3 hook defect used `npx strata` inside a single-quoted JS string:
```typescript
const hookContent = [
  '#!/bin/sh',
  'exec npx strata run --hook pre-push "$@"',
].join('\n')

const fileContent = `
import { writeFileSync } from 'fs'
import { join } from 'path'
export function installPrePushHook(hooksDir: string): void {
  const script = [
    '#!/bin/sh',
    'exec npx strata run --hook pre-push "$@"',
  ].join('\\n')
  writeFileSync(join(hooksDir, 'pre-push'), script, { mode: 0o755 })
}
`
```
The line `'exec npx strata run --hook pre-push "$@"'` is inside a single-quoted string →
`isInStringLiteralContext` returns `true` → finding fires. Assert:
```typescript
expect(result.findings).toHaveLength(1)
expect(result.findings![0].category).toBe('source-ac-shellout-npx-fallback')
expect(result.findings![0].message).toContain('"npx strata"')
expect(result.findings![0].message).toContain('dependency-confusion vector')
```

### Commit Message Convention
Per AC8, commit message MUST reference obs_2026-05-03_023 fix #3:
```
feat: add source-ac-shellout-npx-fallback static-analysis check (obs_2026-05-03_023 fix #3)
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
