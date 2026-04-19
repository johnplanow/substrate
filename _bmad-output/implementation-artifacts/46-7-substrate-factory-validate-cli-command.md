# Story 46-7: `substrate factory validate` CLI Command

## Story

As a factory pipeline operator,
I want `substrate factory validate <graph-file>` to parse a DOT graph and report all rule violations,
so that I can detect structural and semantic problems in a pipeline definition before running it.

## Acceptance Criteria

### AC1: Valid graph reports full pass
**Given** a DOT file that satisfies all 13 lint rules
**When** `substrate factory validate <graph-file>` is run
**Then** it prints "13/13 rules passed, 0 errors, 0 warnings" to stdout and exits with code 0

### AC2: Error diagnostics reported with non-zero exit
**Given** a DOT file with two start nodes (violating the `start_node` rule)
**When** `substrate factory validate` is run
**Then** it prints a summary showing the failing rule count (e.g., "12/13 rules passed, 1 error, 0 warnings"), lists each diagnostic with severity, ruleId, and message, and exits with code 1

### AC3: Warning-only graphs exit 0
**Given** a DOT file with a codergen node that has no prompt or label (violating the `prompt_on_llm_nodes` warning rule) but no errors
**When** `substrate factory validate` is run
**Then** it lists the warning diagnostic, prints a summary showing the warning count, and exits with code 0 (warnings do not fail the command)

### AC4: JSON output format emits `ValidationDiagnostic` array
**Given** `--output-format json` is passed
**When** `substrate factory validate` runs on any graph
**Then** it writes a JSON array of `ValidationDiagnostic` objects to stdout (empty array `[]` for a valid graph); no summary line is printed; the schema of each object matches `{ ruleId: string, severity: 'error' | 'warning', message: string, nodeId?: string, edgeIndex?: number }`

### AC5: Missing file exits with code 2
**Given** a file path that does not exist on disk
**When** `substrate factory validate <non-existent-path>` is run
**Then** it prints a clear error to stderr ("Error: file not found: <path>") and exits with code 2

### AC6: Malformed DOT file parse error exits with code 2
**Given** a file whose contents cannot be parsed by `parseGraph()`
**When** `substrate factory validate` is run
**Then** it prints the parse error message to stderr ("Error: failed to parse graph: <detail>") and exits with code 2

### AC7: Summary counts reflect unique fired rules
**Given** a DOT file where the `reachability` rule fires on two unreachable nodes (2 diagnostics from 1 rule) and the `fidelity_valid` warning fires on one node (1 diagnostic from 1 rule)
**When** `substrate factory validate` is run
**Then** the summary shows "11/13 rules passed, 1 error, 1 warning" — passed count = 13 minus the number of *unique* ruleIds in the diagnostic list

## Tasks / Subtasks

- [ ] Task 1: Add `validate` subcommand registration to `registerFactoryCommand` in `packages/factory/src/factory-command.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Import `createValidator` from `'./graph/validator.js'`, `parseGraph` from `'./graph/parser.js'`, and `{ readFile }` from `'node:fs/promises'` at the top of the file
  - [ ] After the existing `run` subcommand block, register: `const validate = factory.command('validate <graph-file>').description('Parse and lint a DOT graph against all 13 validation rules')`
  - [ ] Add `.option('--output-format <format>', 'Output format: json | text', 'text')` option to the validate command
  - [ ] Wire the async action handler: `.action(async (graphFile: string, opts: { outputFormat: string }) => { ... })`

- [ ] Task 2: Implement file reading and graph parsing in the validate action handler (AC: #5, #6)
  - [ ] Wrap file reading in try/catch: `const source = await readFile(graphFile, 'utf-8')` — on ENOENT, write `Error: file not found: ${graphFile}` to stderr and call `process.exit(2)`
  - [ ] Wrap `parseGraph(source)` in try/catch — on any thrown error, write `Error: failed to parse graph: ${err.message}` to stderr and call `process.exit(2)`
  - [ ] Both error paths must use `process.stderr.write(...)` (not `console.error`) to stay consistent with the rest of the CLI

- [ ] Task 3: Run validation and compute summary statistics (AC: #1, #7)
  - [ ] Call `createValidator().validate(graph)` to get `diagnostics: ValidationDiagnostic[]`
  - [ ] Partition: `const errors = diagnostics.filter(d => d.severity === 'error')` and `const warnings = diagnostics.filter(d => d.severity === 'warning')`
  - [ ] Compute unique fired rule count: `const firedRuleIds = new Set(diagnostics.map(d => d.ruleId))`
  - [ ] Define `const TOTAL_RULE_COUNT = 13` at module scope (constant, not derived at runtime, since `createValidator()` always loads exactly 8 error + 5 warning rules)
  - [ ] Compute: `const passedCount = TOTAL_RULE_COUNT - firedRuleIds.size`

- [ ] Task 4: Implement human-readable text output formatter (AC: #1, #2, #3, #7)
  - [ ] Build summary line: when no diagnostics → `✓ 13/13 rules passed, 0 errors, 0 warnings`; when diagnostics exist → `✗ ${passedCount}/${TOTAL_RULE_COUNT} rules passed, ${errors.length} error${errors.length !== 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`
  - [ ] For non-empty diagnostics, print each on its own line with padding: `  ${d.severity.padEnd(7)}  ${d.ruleId.padEnd(24)}  ${d.message}${d.nodeId ? ` [node: ${d.nodeId}]` : ''}${d.edgeIndex !== undefined ? ` [edge: ${d.edgeIndex}]` : ''}`
  - [ ] Print diagnostics before the summary line so the summary appears last
  - [ ] Use `process.stdout.write(...)` for all output lines in text mode

- [ ] Task 5: Implement JSON output formatter (AC: #4)
  - [ ] When `opts.outputFormat === 'json'`, call `process.stdout.write(JSON.stringify(diagnostics, null, 2) + '\n')` — outputs `[]` for a valid graph
  - [ ] Skip summary line and diagnostic list in JSON mode
  - [ ] Exit code logic is identical in both modes: 0 for no errors, 1 for errors

- [ ] Task 6: Implement exit codes (AC: #1, #2, #3)
  - [ ] After printing output (text or JSON), call `process.exit(errors.length > 0 ? 1 : 0)`
  - [ ] File-not-found and parse errors use `process.exit(2)` (already handled in Task 2)
  - [ ] Do NOT call `process.exit(0)` on the success path — let the Commander action handler return naturally if exit code is 0 to avoid breaking tests; only call `process.exit(1)` explicitly on the error path
  - [ ] Reconsider: Commander swallows uncaught errors and sets non-zero exit differently — use `process.exitCode = 1` if process.exit causes test teardown issues; adjust based on how existing `factory run` handles errors

- [ ] Task 7: Write unit tests in `packages/factory/src/__tests__/factory-validate-command.test.ts` (AC: #1–#7)
  - [ ] Mock `node:fs/promises` with `vi.mock('node:fs/promises', ...)`, `parseGraph` with `vi.mock('../graph/parser.js', ...)`, and `createValidator` with `vi.mock('../graph/validator.js', ...)`
  - [ ] Spy on `process.stdout.write`, `process.stderr.write`, and `process.exit` using `vi.spyOn`; restore after each test
  - [ ] Write test: valid graph → stdout contains "13/13 rules passed, 0 errors, 0 warnings", exit code 0
  - [ ] Write test: error diagnostic → stdout contains "error" line with ruleId, exit code 1
  - [ ] Write test: warning-only → stdout contains "warning" line, exit code 0
  - [ ] Write test: `--output-format json` → stdout is valid JSON array matching `ValidationDiagnostic[]` shape
  - [ ] Write test: `--output-format json` with valid graph → stdout is `[]`
  - [ ] Write test: ENOENT → stderr contains "file not found", exit code 2
  - [ ] Write test: parse error → stderr contains "failed to parse graph", exit code 2
  - [ ] Write test: 2 diagnostics from 1 ruleId + 1 from another → summary shows correct unique-rule pass count
  - [ ] After implementation, run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line appears in output — do NOT pipe output through `grep` or `head`

## Dev Notes

### Architecture Constraints
- All new imports in `factory-command.ts` must use `.js` extension (ESM): `import { createValidator } from './graph/validator.js'`, `import { parseGraph } from './graph/parser.js'`, `import { readFile } from 'node:fs/promises'`
- `parseGraph` and `createValidator` already exist in the factory package — do NOT reimplement them; just import
- `ValidationDiagnostic` type is defined in `packages/factory/src/graph/types.ts` and re-exported through `packages/factory/src/index.ts`; import it via `import type { ValidationDiagnostic } from './graph/types.js'`
- The `validate` subcommand lives entirely inside `registerFactoryCommand` in `factory-command.ts` — do NOT create a separate file; keep it alongside the existing `run` and `scenarios` registration for cohesion
- `TOTAL_RULE_COUNT = 13` is a fixed constant (8 error rules + 5 warning rules from `createValidator()`); it must not be computed at runtime since the `GraphValidator` interface does not expose a rule count
- Use `process.stdout.write` and `process.stderr.write` (not `console.log`/`console.error`) to match the style of the rest of `factory-command.ts`

### Exit Code Contract
| Condition | Exit Code |
|---|---|
| All diagnostics are warnings only (or no diagnostics) | 0 |
| At least one error-severity diagnostic | 1 |
| File not found (ENOENT) | 2 |
| DOT parse failure | 2 |

### Summary Line Format
The 13 known rule IDs are split into 8 error rules and 5 warning rules. Passed count is computed from unique ruleIds that produced at least one diagnostic:

```
passedCount = 13 - (new Set(diagnostics.map(d => d.ruleId))).size
```

If 3 diagnostics come from 2 rules, passedCount = 13 - 2 = 11 (not 13 - 3 = 10).

### Text Output Layout
```
  error    start_node               Expected exactly one start node, found 2
  warning  prompt_on_llm_nodes      Codergen node 'generate' has no prompt or label [node: generate]

✗ 11/13 rules passed, 1 error, 1 warning
```
(diagnostics first, summary last; blank line between diagnostics and summary)

### Testing Patterns from Existing Tests
Reference `packages/factory/src/__tests__/factory-run-command.test.ts` for the established mock pattern:
```typescript
vi.mock('../graph/parser.js', () => ({ parseGraph: vi.fn() }))
vi.mock('../graph/validator.js', () => ({
  createValidator: vi.fn(() => ({
    validate: vi.fn().mockReturnValue([]),
    validateOrRaise: vi.fn(),
    registerRule: vi.fn(),
  })),
}))
```

### File Paths
- **Modified**: `packages/factory/src/factory-command.ts` — add `validate` subcommand registration and action handler; add imports for `createValidator`, `parseGraph`, `readFile`
- **New**: `packages/factory/src/__tests__/factory-validate-command.test.ts` — unit tests (≥ 8 test cases)
- **No changes needed**: `packages/factory/src/index.ts` — `registerFactoryCommand` is already re-exported; `ValidationDiagnostic` type is already re-exported via `graph/types.js` barrel

### Dependency Notes
- **Depends on 42-4 and 42-5**: `createValidator()` with all 13 rules (8 error + 5 warning) exists from Epic 42 stories
- **Depends on 42-1/42-3**: `parseGraph()` exists from Epic 42 DOT parser stories
- **Does NOT depend on 46-6**: This story is independent; the validate command does not involve quality modes or convergence
- **Story 46-8 depends on this story**: Integration tests assume the validate command exists

### Testing Requirements
- Test files: use `vitest` with `describe` / `it` / `expect` / `vi.fn()` / `vi.spyOn()`
- Spy on `process.exit` to prevent process termination during tests: `vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })`
- Use `beforeEach(() => vi.clearAllMocks())` to reset spies between tests
- After implementation, run `npm run test:fast` with `timeout: 300000` — confirm "Test Files" line appears in output; never pipe output through `grep` or `head`

## Interface Contracts

- **Import**: `ValidationDiagnostic` @ `packages/factory/src/graph/types.ts` (from stories 42-4/42-5)
- **Import**: `createValidator` @ `packages/factory/src/graph/validator.ts` (from story 42-4)
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (from story 42-1)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
