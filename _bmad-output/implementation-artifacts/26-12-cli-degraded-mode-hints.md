# Story 26.12: CLI Degraded-Mode Hints

Status: ready-for-dev

## Story

As a developer running substrate without Dolt installed or initialized,
I want informative, actionable hints when I use `substrate diff` or `substrate history` on a file-only backend,
so that I know exactly what is missing and how to enable Dolt features.

## Acceptance Criteria

### AC1: Hints written to stderr, not stdout
**Given** the state backend resolves to file (Dolt not detected by auto-detection from story 26-10)
**When** `substrate diff <storyKey>` or `substrate history` is invoked
**Then** all hint text is written to stderr; stdout contains either nothing or valid JSON — never a mix of hint text and data output

### AC2: Dolt-not-installed hint includes download URL
**Given** the Dolt binary is not on PATH
**When** `substrate diff` or `substrate history` runs on file backend
**Then** the stderr hint reads: `Note: Dolt is not installed. Install it from https://docs.dolthub.com/introduction/installation, then run \`substrate init --dolt\` to enable diff and history features.`

### AC3: Dolt-not-initialized hint includes init command
**Given** the Dolt binary is on PATH but no `.dolt` directory exists in the resolved state path
**When** `substrate diff` or `substrate history` runs on file backend
**Then** the stderr hint reads: `Note: Dolt is installed but not initialized. Run \`substrate init --dolt\` to enable diff and history features.`

### AC4: JSON output format emits machine-readable hint
**Given** `--output-format json` is passed
**When** either command runs on file backend
**Then** stdout is a single JSON object with fields `backend: "file"` and `hint: "<message>"` plus command-specific null/empty fields (`diff: null` for diff, `entries: []` for history); exit code remains 0

### AC5: Shared utility eliminates duplication in diff and history commands
**Given** both `diff.ts` and `history.ts` need to emit degraded-mode hints
**When** the file backend is active
**Then** both commands delegate to `emitDegradedModeHint(options)` exported from `src/utils/degraded-mode-hint.ts`; no duplicate hint string literals remain in diff.ts or history.ts

### AC6: Graceful exit code 0 on degraded-mode
**Given** file backend is active and Dolt-specific features are unavailable
**When** `substrate diff` or `substrate history` are invoked
**Then** the process exits with code 0 (degradation is expected UX, not an error condition)

### AC7: Inline stub hints removed from diff.ts and history.ts
**Given** diff.ts and history.ts previously contained inline `console.log` hint messages on the `FileStateStore` branch
**When** this story's refactor is complete
**Then** those inline hint strings are replaced by calls to the shared utility; no standalone hint `console.log` calls remain in either file

## Tasks / Subtasks

- [ ] Task 1: Create `src/utils/degraded-mode-hint.ts` shared utility (AC1, AC2, AC3, AC5)
  - [ ] Define `DegradedModeHintOptions` interface: `{ outputFormat: string; command: 'diff' | 'history'; statePath: string }`
  - [ ] Define `DegradedModeHintResult` interface: `{ hint: string; doltInstalled: boolean }`
  - [ ] Implement `getDegradedModeHint(statePath: string): Promise<string>` — calls `checkDoltInstalled()` from state module; catches `DoltNotInstalled` → "not installed" message; on success checks `existsSync(join(statePath, '.dolt'))` to determine "not initialized" message
  - [ ] Implement `emitDegradedModeHint(options: DegradedModeHintOptions): Promise<DegradedModeHintResult>` — for text mode, writes `\n<hint>\n` to `process.stderr`; for JSON mode, returns result without writing to stderr (caller writes JSON to stdout)
  - [ ] Use `process.stderr.write()` (not `console.error`) so output bypasses any stderr mock in tests that use `vi.spyOn`

- [ ] Task 2: Update `src/cli/commands/diff.ts` to use shared hint utility (AC1, AC4, AC5, AC6, AC7)
  - [ ] Import `emitDegradedModeHint` from `../../utils/degraded-mode-hint.js`
  - [ ] Remove the two inline `console.log` hint blocks (single-story branch and sprint-aggregation branch)
  - [ ] After `store.initialize()`, if `store instanceof FileStateStore`, call `emitDegradedModeHint({ outputFormat: options.outputFormat, command: 'diff', statePath })`
  - [ ] For JSON output mode on file backend: emit `JSON.stringify({ backend: 'file', hint: result.hint, diff: null })` to stdout via `console.log`; return early
  - [ ] For text mode on file backend: return early after hint is written to stderr (no stdout output)

- [ ] Task 3: Update `src/cli/commands/history.ts` to use shared hint utility (AC1, AC4, AC5, AC6, AC7)
  - [ ] Import `emitDegradedModeHint` from `../../utils/degraded-mode-hint.js`
  - [ ] Remove the inline `console.log` hint block inside the `entries.length === 0` guard
  - [ ] After `store.initialize()`, if `store instanceof FileStateStore`, call `emitDegradedModeHint({ outputFormat: options.outputFormat, command: 'history', statePath })` and return early (before querying history)
  - [ ] For JSON output mode on file backend: emit `JSON.stringify({ backend: 'file', hint: result.hint, entries: [] })` to stdout; return early
  - [ ] For text mode on file backend: return early after hint is written to stderr

- [ ] Task 4: Unit tests for `src/utils/__tests__/degraded-mode-hint.test.ts` (AC1, AC2, AC3, AC5)
  - [ ] Mock `checkDoltInstalled` and `DoltNotInstalled` via `vi.mock('../../modules/state/index.js', () => ({ checkDoltInstalled: vi.fn(), DoltNotInstalled: class extends Error {} }))`
  - [ ] Mock `existsSync` from `node:fs` for `.dolt` directory check
  - [ ] Test: `checkDoltInstalled` throws `DoltNotInstalled` → hint contains "not installed" and `https://docs.dolthub.com/introduction/installation`
  - [ ] Test: `checkDoltInstalled` resolves, `.dolt` dir absent → hint contains "not initialized" and `substrate init --dolt`
  - [ ] Test: text mode → `process.stderr.write` called with hint text
  - [ ] Test: JSON mode → `process.stderr.write` NOT called; returned `hint` field is populated

- [ ] Task 5: Unit tests for updated diff.ts (AC4, AC6, AC7)
  - [ ] Test: file backend + text format → `process.stderr.write` called with hint; `console.log` not called with hint string; exit code not set to non-zero
  - [ ] Test: file backend + JSON format → `console.log` called with JSON string containing `backend: 'file'` and `hint` field
  - [ ] Test: Dolt backend (mock `store instanceof FileStateStore` returns false) → `emitDegradedModeHint` not called; normal diff output rendered

- [ ] Task 6: Unit tests for updated history.ts (AC4, AC6, AC7)
  - [ ] Test: file backend + text format → `process.stderr.write` called with hint; `console.log` not called with hint string; exit code not set to non-zero
  - [ ] Test: file backend + JSON format → `console.log` called with JSON string containing `backend: 'file'`, `hint`, and `entries: []`
  - [ ] Test: Dolt backend → `emitDegradedModeHint` not called; normal history entries rendered

## Dev Notes

### Architecture Constraints
- New file: `src/utils/degraded-mode-hint.ts` (kebab-case filename; exports PascalCase interfaces and camelCase functions)
- Import order in all files: Node built-ins → third-party packages → internal relative paths; blank line between groups
- Use `process.stderr.write()` for hint output; never `console.error()` or `console.log()` for hint text
- `console.log()` is only appropriate for valid stdout data (JSON output or text output rows)
- Import `checkDoltInstalled`, `DoltNotInstalled` from `../../modules/state/index.js` (already barrel-exported)
- Import `FileStateStore` from `../../modules/state/index.js` for `instanceof` check (already barrel-exported)
- Import `existsSync` from `node:fs` (not `node:fs/promises`) for synchronous `.dolt` directory check

### Key File Paths
- **New**: `src/utils/degraded-mode-hint.ts`
- **New**: `src/utils/__tests__/degraded-mode-hint.test.ts`
- **Modified**: `src/cli/commands/diff.ts`
- **Modified**: `src/cli/commands/history.ts`
- **Modified** (test updates): `src/cli/commands/__tests__/diff.test.ts` (if exists)
- **Modified** (test updates): `src/cli/commands/__tests__/history.test.ts` (if exists)

### Testing Requirements
- All test files co-located in `__tests__/` directories adjacent to source
- Test file naming: `<module>.test.ts`
- Spy pattern for stderr: `vi.spyOn(process.stderr, 'write').mockImplementation(() => true)`
- Spy pattern for stdout: `vi.spyOn(console, 'log').mockImplementation(() => undefined)`
- 80% coverage threshold enforced by `npm test`; run `npm run test:fast` during iteration, `npm run test:changed` for targeted validation
- Do NOT run `npm test` concurrently — only one vitest instance at a time

### `getDegradedModeHint` Logic Pseudocode
```typescript
async function getDegradedModeHint(statePath: string): Promise<string> {
  try {
    await checkDoltInstalled()
    // Dolt binary found — check if repo is initialized
    if (!existsSync(join(statePath, '.dolt'))) {
      return 'Note: Dolt is installed but not initialized. Run `substrate init --dolt` to enable diff and history features.'
    }
    // Should not reach here when in file backend, but guard anyway
    return 'Note: Running on file backend. Diff and history require Dolt.'
  } catch (err) {
    if (err instanceof DoltNotInstalled) {
      return 'Note: Dolt is not installed. Install it from https://docs.dolthub.com/introduction/installation, then run `substrate init --dolt` to enable diff and history features.'
    }
    throw err
  }
}
```

### Story Dependencies
- **Requires 26-10**: `StateStoreConfig.backend` must support `'auto'`; diff.ts and history.ts should use `{ backend: 'auto' }` after 26-10 is merged. If 26-10 is not yet merged, the `existsSync(doltStatePath)` detection in diff.ts/history.ts remains and the `FileStateStore instanceof` check still works.
- **Requires 26-11**: `substrate init --dolt` must exist before 26-12 ships (hints reference it). Confirm `registerInitCommand` accepts `--dolt` flag.

## Interface Contracts

- **Import**: `checkDoltInstalled`, `DoltNotInstalled`, `FileStateStore` @ `src/modules/state/index.ts` (from story 26-1/26-2)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
