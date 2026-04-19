# Story 26-6: Contract Verification Migration

Status: complete

## Story

As a pipeline orchestrator,
I want contract declarations and verification results managed through the StateStore interface,
so that cross-story interface dependencies are queryable via SQL, visible in Dolt history, and exposed through a dedicated CLI command.

## Acceptance Criteria

### AC1: StateStore Interface Extended with Query and Verification Methods
**Given** the `StateStore` interface in `src/modules/state/types.ts`
**When** other modules import it
**Then** it additionally exports:
- `queryContracts(filter?: ContractFilter): Promise<ContractRecord[]>` — query all contracts across all stories with optional filter
- `setContractVerification(storyKey: string, results: ContractVerificationRecord[]): Promise<void>` — persist post-sprint verification results
- `getContractVerification(storyKey: string): Promise<ContractVerificationRecord[]>` — retrieve verification results for a story
- `ContractFilter` interface: `{ storyKey?: string; direction?: 'export' | 'import' }`
- `ContractVerificationRecord` interface: `{ storyKey: string; contractName: string; verdict: 'pass' | 'fail'; mismatchDescription?: string; verifiedAt: string }`

And both `FileStateStore` and `DoltStateStore` implement all three new methods.

### AC2: Contract Declarations Written via StateStore in Orchestrator
**Given** a story's Interface Contracts section is parsed by `parseInterfaceContracts()` in `orchestrator-impl.ts`
**When** declarations are extracted (currently around line 747)
**Then**:
- `ContractDeclaration[]` is mapped to `ContractRecord[]` (`contractName → contractName`, `filePath → schemaPath`, `direction`/`transport`/`storyKey` preserved)
- `stateStore.setContracts(storyKey, contractRecords)` is called instead of the `storeDecision(category: 'interface-contract', ...)` loop
- The decision store write for `interface-contract` category is removed from that code path
- `FileStateStore` stores contracts in its in-memory map; `DoltStateStore` writes to the `contracts` SQL table

### AC3: Dependency Graph Reads from StateStore
**Given** contract declarations are stored in StateStore (populated in AC2)
**When** `_runStoriesInBatches` in `orchestrator-impl.ts` builds the contract dependency graph (currently around line 1848)
**Then**:
- `getDecisionsByCategory(db, 'interface-contract')` is replaced with `await stateStore.queryContracts()`
- Result is mapped back to `ContractDeclaration[]` for input to `detectConflictGroupsWithContracts` (`schemaPath → filePath`)
- Dispatch ordering behavior is unchanged — identical batches are produced

### AC4: Contract Verification Results Persisted After Sprint
**Given** `verifyContracts(declarations, projectRoot)` runs post-sprint and returns `ContractMismatch[]`
**When** verification results are computed
**Then**:
- For each affected story key, `stateStore.setContractVerification(storyKey, records)` is called
- Each `ContractVerificationRecord` includes: `storyKey`, `contractName`, `verdict` (`'pass'` or `'fail'`), `mismatchDescription` (if fail), `verifiedAt` (ISO timestamp from `new Date().toISOString()`)
- `FileStateStore` serializes records to `<basePath>/contract-verifications.json` (falls back to in-memory if no basePath)
- `DoltStateStore` writes to the `review_verdicts` table with `task_type = 'contract-verification'` and per-contract details JSON-encoded in the `notes` column

### AC5: `substrate contracts` CLI Command
**Given** contract data is stored in StateStore
**When** `substrate contracts` is invoked
**Then** it displays a table of all stored contracts with columns: story key, contract name, direction, schema path, and verification status (✓ pass / ✗ fail / ? pending)

**And** when `--output-format json` is passed, a raw JSON array of contracts merged with verification status is returned

**And** when no contracts are stored, it exits cleanly with the message: `No contracts stored. Run a pipeline to populate contract data.`

### AC6: All Tests Pass Against Both Backends
**Given** the migrations in AC2–AC4 and the new methods in AC1
**When** the full test suite runs (`npm run test:fast`)
**Then** all existing orchestrator tests pass without modification, and new unit tests cover:
- `queryContracts` with no filter, `storyKey` filter, and `direction` filter
- `setContractVerification` / `getContractVerification` round-trip (FileStateStore and DoltStateStore)
- `substrate contracts` CLI command: table output, JSON output, and empty-state message

## Interface Contracts

- **Import**: `StateStore`, `ContractRecord` @ `src/modules/state/types.ts` (from story 26-1)
- **Import**: `DoltStateStore` @ `src/modules/state/dolt-store.ts` (from story 26-3)
- **Import**: `OrchestratorImpl` with injected `StateStore` @ `src/modules/implementation-orchestrator/orchestrator-impl.ts` (from story 26-4)
- **Export**: `ContractFilter`, `ContractVerificationRecord` @ `src/modules/state/types.ts` (extensions to 26-1 types)

## Tasks / Subtasks

- [ ] Task 1: Extend StateStore interface and supporting types (AC1)
  - [ ] Add `ContractFilter` interface to `src/modules/state/types.ts`: `{ storyKey?: string; direction?: 'export' | 'import' }`
  - [ ] Add `ContractVerificationRecord` interface to `src/modules/state/types.ts`: `{ storyKey: string; contractName: string; verdict: 'pass' | 'fail'; mismatchDescription?: string; verifiedAt: string }`
  - [ ] Add `queryContracts(filter?: ContractFilter): Promise<ContractRecord[]>` to the `StateStore` interface
  - [ ] Add `setContractVerification(storyKey: string, results: ContractVerificationRecord[]): Promise<void>` to the `StateStore` interface
  - [ ] Add `getContractVerification(storyKey: string): Promise<ContractVerificationRecord[]>` to the `StateStore` interface
  - [ ] Export `ContractFilter` and `ContractVerificationRecord` from `src/modules/state/index.ts`
  - [ ] Verify `npm run build` still succeeds (interface extension is additive)

- [ ] Task 2: Implement new methods in FileStateStore (AC1, AC4)
  - [ ] Add `_contractVerifications: Map<string, ContractVerificationRecord[]>` field to `FileStateStore`
  - [ ] Implement `queryContracts(filter?)`: iterate `_contracts` Map, flatten all values, apply optional storyKey and direction filters; return matching `ContractRecord[]`
  - [ ] Implement `setContractVerification(storyKey, results)`: update `_contractVerifications` map; if `this._basePath` is set, write `<basePath>/contract-verifications.json` (full map serialized)
  - [ ] Implement `getContractVerification(storyKey)`: return `_contractVerifications.get(storyKey) ?? []`
  - [ ] Unit tests in `src/modules/state/__tests__/file-store.test.ts`: queryContracts with no filter, storyKey filter, direction filter; setContractVerification/getContractVerification round-trip

- [ ] Task 3: Implement new methods in DoltStateStore (AC1, AC4)
  - [ ] Implement `queryContracts(filter?)`: build `SELECT * FROM contracts` with optional `WHERE story_key = ?` and/or `AND direction = ?`; map rows to `ContractRecord[]`
  - [ ] Implement `setContractVerification(storyKey, results)`: batch INSERT into `review_verdicts` — one row per `ContractVerificationRecord` with `task_type = 'contract-verification'`, `verdict = r.verdict`, `issues_count = results.filter(r => r.verdict === 'fail').length`, `notes = JSON.stringify({ contractName: r.contractName, mismatchDescription: r.mismatchDescription })`, `timestamp = r.verifiedAt`; flush with `dolt commit`
  - [ ] Implement `getContractVerification(storyKey)`: `SELECT * FROM review_verdicts WHERE story_key = ? AND task_type = 'contract-verification' ORDER BY timestamp DESC`; parse `notes` JSON to reconstruct `ContractVerificationRecord[]`
  - [ ] Unit tests using mocked `DoltClient`: verify correct SQL for each method, verify commit is called after write

- [ ] Task 4: Migrate contract declaration storage in orchestrator (AC2)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts` (around line 747–779): locate the `parseInterfaceContracts` call and the subsequent `storeDecision` loop
  - [ ] Build `ContractRecord[]` from the `ContractDeclaration[]` result: `{ storyKey: d.storyKey, contractName: d.contractName, direction: d.direction, schemaPath: d.filePath, ...(d.transport ? { transport: d.transport } : {}) }`
  - [ ] Replace the `storeDecision` loop with a single `await stateStore.setContracts(storyKey, contractRecords)` call
  - [ ] Remove the `storeDecision` import/call for `interface-contract` category if no longer used elsewhere
  - [ ] Verify orchestrator tests still pass: `npm run test:fast`

- [ ] Task 5: Migrate dependency graph query to StateStore (AC3)
  - [ ] In `orchestrator-impl.ts` (around line 1848–1875): locate `const interfaceContractDecisions = getDecisionsByCategory(db, 'interface-contract')`
  - [ ] Replace with `const allContractRecords = await stateStore.queryContracts()`
  - [ ] Map back to `ContractDeclaration[]`: `{ storyKey: r.storyKey, contractName: r.contractName, direction: r.direction, filePath: r.schemaPath, ...(r.transport ? { transport: r.transport } : {}) }`
  - [ ] Remove the now-unused `interfaceContractDecisions` mapping and `ContractDeclaration` reconstruction logic
  - [ ] Verify `detectConflictGroupsWithContracts` still produces correct batches in existing tests

- [ ] Task 6: Persist verification results via StateStore (AC4)
  - [ ] In `orchestrator-impl.ts`: locate the call site of `verifyContracts(declarations, projectRoot)` post-sprint
  - [ ] After `_contractMismatches` is populated, group mismatches by `exporter` and `importer` story keys
  - [ ] For stories with no mismatches among their exports: create `ContractVerificationRecord[]` with `verdict: 'pass'` for each export; for stories with mismatches: `verdict: 'fail'` with `mismatchDescription` from `ContractMismatch.mismatchDescription`
  - [ ] Call `await stateStore.setContractVerification(storyKey, records)` for each story key that has declarations
  - [ ] Set `verifiedAt: new Date().toISOString()` on each record

- [ ] Task 7: Create `substrate contracts` CLI command and register it (AC5, AC6)
  - [ ] Create `src/cli/commands/contracts.ts` exporting `registerContractsCommand(program: Command): void`
  - [ ] Command definition: `program.command('contracts').description('Show contract declarations and verification status').option('--output-format <format>', 'Output format: text or json', 'text')`
  - [ ] Implementation: instantiate StateStore via `createStateStore(config)`, call `queryContracts()` and `getContractVerification()` for each story key; merge into display records
  - [ ] Table output: two-column format with header row; include verification status symbol (✓ / ✗ / ?)
  - [ ] JSON output: `console.log(JSON.stringify(mergedRecords, null, 2))`
  - [ ] Empty state: if `queryContracts()` returns `[]`, print message and exit 0
  - [ ] Register in `src/cli/index.ts`: add `import { registerContractsCommand } from './commands/contracts.js'` and call `registerContractsCommand(program)` in the `registerAll` function
  - [ ] Unit tests: render table for 2 contracts (one pass, one fail), JSON mode, empty state

## Dev Notes

### Architecture Constraints
- **File paths**: `src/modules/state/types.ts` (extend), `src/modules/state/file-store.ts` (extend), `src/modules/state/dolt-store.ts` (extend), `src/modules/implementation-orchestrator/orchestrator-impl.ts` (migrate), new `src/cli/commands/contracts.ts`, `src/cli/index.ts` (register)
- **Import style**: ES modules with `.js` extensions on all local imports (e.g., `import { StateStore } from '../../modules/state/index.js'`)
- **Node builtins**: use `node:` prefix (e.g., `import { readFileSync, writeFileSync } from 'node:fs'`)
- **Type imports**: use `import type { ... }` for type-only imports
- **Interface extension is additive**: adding methods to `StateStore` requires implementing them in both `FileStateStore` and `DoltStateStore`. TypeScript will error if either class is missing new methods — fix both before running `npm run build`.
- **DI pattern**: `orchestrator-impl.ts` receives a `StateStore` via constructor injection from story 26-4. If `this._stateStore` is not yet present (story 26-4 not merged), use a module-level `createStateStore({ backend: 'file' })` call as a temporary bridge and guard all calls with `if (this._stateStore)`.
- **Logger**: `import { createLogger } from '../../utils/logger.js'`; reuse existing namespaces (`'modules:orchestrator'` in orchestrator files)
- **No global state**: do not rely on process working directory; pass absolute paths explicitly

### Key Mapping: ContractDeclaration ↔ ContractRecord

```typescript
// ContractDeclaration → ContractRecord (for storage)
const record: ContractRecord = {
  storyKey: decl.storyKey,
  contractName: decl.contractName,
  direction: decl.direction,
  schemaPath: decl.filePath,          // filePath → schemaPath (matches SQL column schema_path)
  ...(decl.transport ? { transport: decl.transport } : {}),
}

// ContractRecord → ContractDeclaration (for dependency graph)
const decl: ContractDeclaration = {
  storyKey: record.storyKey,
  contractName: record.contractName,
  direction: record.direction,
  filePath: record.schemaPath,        // schemaPath → filePath
  ...(record.transport ? { transport: record.transport } : {}),
}
```

### review_verdicts Table Schema (DoltStateStore)

`DoltStateStore.setContractVerification` writes to the existing `review_verdicts` table using a `task_type` discriminator:

```sql
INSERT INTO review_verdicts
  (story_key, task_type, verdict, issues_count, notes, timestamp)
VALUES
  (?, 'contract-verification', ?, ?, ?, ?)
```

- `task_type = 'contract-verification'` distinguishes from code-review verdicts
- `notes` column stores JSON: `{ "contractName": "...", "mismatchDescription": "..." }`
- `issues_count` = number of `'fail'` records in the batch (for quick aggregate queries)
- `verdict` column maps directly to `ContractVerificationRecord.verdict`

### FileStateStore Persistence

The `_contractVerifications` in-memory map is serialized to disk only when `this._basePath` is set (provided to the constructor). Format is a flat JSON object keyed by storyKey:

```json
{
  "26-1": [
    { "storyKey": "26-1", "contractName": "StateStore", "verdict": "pass", "verifiedAt": "2026-03-08T..." }
  ]
}
```

### Backward Compatibility

The existing orchestrator behavior is preserved:
- `FileStateStore.setContracts` / `getContracts` still use in-memory Map (from story 26-1)
- The decision store `interface-contract` category writes are removed — they are superseded by `setContracts`. Reads from that category in `_runStoriesInBatches` are replaced by `queryContracts()`.
- All existing orchestrator unit tests should pass unchanged because they exercise the file backend path.

### Testing Requirements
- **Framework**: vitest (NOT jest). Run with `npm run test:fast`.
- **Coverage threshold**: 80% enforced — do not drop below.
- **New test files**: add to `src/modules/state/__tests__/` for FileStateStore and DoltStateStore extensions; add `src/cli/commands/__tests__/contracts.test.ts` for CLI command
- **DoltStateStore tests**: skip if `dolt` binary not found on PATH (`try { execSync('dolt version') } catch { return }`)
- **CLI unit tests**: use commander `.parseAsync()` in test and inject a mock StateStore via module-level DI or constructor argument

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
