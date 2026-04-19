# Story 47-4: Pre-Built Twin Templates (LocalStack and WireMock)

## Story

As a developer using the substrate factory,
I want pre-built twin templates for common external service test doubles (LocalStack, WireMock),
so that I can initialize a working twin definition with a single CLI command, without needing to research Docker image names, port conventions, and health check URLs.

## Acceptance Criteria

### AC1: Template catalog module exports LocalStack and WireMock entries
**Given** `packages/factory/src/twins/templates.ts` is imported
**When** the `TWIN_TEMPLATES` map is inspected
**Then** it contains at least two entries — keyed `"localstack"` and `"wiremock"` — each with a non-empty `description: string` and a `definition: TwinDefinitionInput` that includes the correct Docker image, port string(s) in `"host:container"` format, environment defaults, and a health check URL

### AC2: `substrate factory twins init --template localstack` creates the LocalStack YAML file
**Given** a project root with no existing `.substrate/twins/localstack.yaml`
**When** `substrate factory twins init --template localstack` is executed from that root
**Then** `.substrate/twins/localstack.yaml` is created, the `name` field equals `localstack`, the `image` field equals `localstack/localstack:latest`, the ports list contains `"4566:4566"`, and the `healthcheck.url` is `http://localhost:4566/_localstack/health`

### AC3: `substrate factory twins init --template wiremock` creates the WireMock YAML file
**Given** a project root with no existing `.substrate/twins/wiremock.yaml`
**When** `substrate factory twins init --template wiremock` is executed from that root
**Then** `.substrate/twins/wiremock.yaml` is created, the `name` field equals `wiremock`, the `image` field equals `wiremock/wiremock:latest`, the ports list contains `"8080:8080"`, and the `healthcheck.url` is `http://localhost:8080/__admin/health`

### AC4: `substrate factory twins templates` prints all available templates with descriptions
**Given** the factory CLI is installed
**When** `substrate factory twins templates` is run
**Then** stdout contains one line per available template with the template name and its description, covering at minimum `localstack` and `wiremock`

### AC5: Init command exits with code 1 on an unknown template name
**Given** `substrate factory twins init --template unknown-service` is run
**When** the command executes
**Then** the process exits with code 1 and stderr contains a message that names the invalid template and lists valid choices (e.g. `"Unknown template 'unknown-service'. Available: localstack, wiremock"`)

### AC6: Init command exits with code 1 if the target file already exists (without --force)
**Given** `.substrate/twins/localstack.yaml` already exists in the project root
**When** `substrate factory twins init --template localstack` is run without the `--force` flag
**Then** the process exits with code 1 and stderr contains a message indicating the file already exists and that `--force` can be used to overwrite; the existing file is left unchanged

### AC7: All generated template YAML files pass TwinDefinitionSchema validation
**Given** the YAML content written by each built-in template
**When** parsed with `js-yaml` and passed to `TwinDefinitionSchema.parse()`
**Then** no validation error is thrown for any template, confirming the templates are always valid twin definitions that the registry can discover and load

## Interface Contracts

- **Export**: `TWIN_TEMPLATES` @ `packages/factory/src/twins/templates.ts` (consumed by `factory-command.ts` for CLI wiring)
- **Export**: `TwinTemplateEntry` @ `packages/factory/src/twins/templates.ts` (type used by CLI and tests)
- **Import**: `TwinDefinitionInput` @ `packages/factory/src/twins/schema.ts` (from story 47-1 — used as the type for `TwinTemplateEntry.definition`)
- **Import**: `TwinDefinitionSchema` @ `packages/factory/src/twins/schema.ts` (from story 47-1 — used in tests to validate template output)

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/twins/templates.ts` — template catalog module (AC: #1, #7)
  - [ ] Define and export `TwinTemplateEntry` interface: `{ name: string; description: string; definition: TwinDefinitionInput }`
  - [ ] Define `localstack` entry: `image: 'localstack/localstack:latest'`, `ports: ['4566:4566']`, `environment: { SERVICES: 's3,sqs,dynamodb' }`, `healthcheck: { url: 'http://localhost:4566/_localstack/health', interval_ms: 500, timeout_ms: 10000 }`
  - [ ] Define `wiremock` entry: `image: 'wiremock/wiremock:latest'`, `ports: ['8080:8080']`, `environment: {}`, `healthcheck: { url: 'http://localhost:8080/__admin/health', interval_ms: 500, timeout_ms: 10000 }`
  - [ ] Export `TWIN_TEMPLATES: Map<string, TwinTemplateEntry>` populated with both entries, keyed by `entry.name`
  - [ ] Export `listTwinTemplates(): TwinTemplateEntry[]` — returns `Array.from(TWIN_TEMPLATES.values())`
  - [ ] Export `getTwinTemplate(name: string): TwinTemplateEntry | undefined` — returns `TWIN_TEMPLATES.get(name)`
  - [ ] No `any` types; use explicit `TwinDefinitionInput` for the `definition` field

- [ ] Task 2: Export templates from the twins barrel (AC: #1)
  - [ ] Open `packages/factory/src/twins/index.ts`
  - [ ] Add: `export { TWIN_TEMPLATES, getTwinTemplate, listTwinTemplates } from './templates.js'`
  - [ ] Add: `export type { TwinTemplateEntry } from './templates.js'`
  - [ ] Run `npm run build` to confirm zero TypeScript compilation errors

- [ ] Task 3: Add `twins` subcommand group to `factory-command.ts` (AC: #2, #3, #4, #5, #6)
  - [ ] Open `packages/factory/src/factory-command.ts`
  - [ ] Add imports: `import { mkdir, writeFile, access } from 'node:fs/promises'`, `import yaml from 'js-yaml'`, `import { getTwinTemplate, listTwinTemplates } from './twins/index.js'`
  - [ ] After the `validate` subcommand block, register a new `twins` subcommand group on `factoryCmd`:
    ```typescript
    const twinsCmd = factoryCmd
      .command('twins')
      .description('Digital twin template management')
    ```
  - [ ] Update the file-level JSDoc comment to include the new subcommand tree entry for `twins`

- [ ] Task 4: Implement `twins templates` subcommand (AC: #4)
  - [ ] Register `twinsCmd.command('templates').description('List available twin templates').action(...)` in `factory-command.ts`
  - [ ] In the action: call `listTwinTemplates()`, iterate results, write one line per template: `"  <name.padEnd(16)>  <description>\n"` to `process.stdout`
  - [ ] No async required; no file I/O; synchronous action handler

- [ ] Task 5: Implement `twins init --template <name> [--force]` subcommand (AC: #2, #3, #5, #6)
  - [ ] Register `twinsCmd.command('init').description('Initialize a twin definition from a built-in template').requiredOption('--template <name>', 'Template name').option('--force', 'Overwrite existing file').action(async (opts) => { ... })`
  - [ ] Validate template exists: call `getTwinTemplate(opts.template)`; if `undefined`, write error to stderr and `process.exit(1)` (include valid names from `listTwinTemplates().map(t => t.name).join(', ')`)
  - [ ] Compute target path: `path.join(process.cwd(), '.substrate', 'twins', `${opts.template}.yaml`)`
  - [ ] Check for existing file (without `--force`): use `access(targetPath)` in a try/catch; if file exists and `!opts.force`, write descriptive error to stderr and `process.exit(1)`
  - [ ] Create `.substrate/twins/` directory: `await mkdir(path.dirname(targetPath), { recursive: true })`
  - [ ] Serialize to YAML: `yaml.dump(entry.definition)` — produces YAML matching the format `TwinRegistry.discover()` expects (port strings, not objects)
  - [ ] Write file: `await writeFile(targetPath, yamlContent, 'utf-8')`; confirm with `process.stdout.write(`Created ${targetPath}\n`)`

- [ ] Task 6: Write unit tests for the template catalog (AC: #1, #7)
  - [ ] Create `packages/factory/src/twins/__tests__/templates.test.ts`
  - [ ] Import `TWIN_TEMPLATES, getTwinTemplate, listTwinTemplates, TwinTemplateEntry` from `'../templates.js'`
  - [ ] Import `TwinDefinitionSchema` from `'../schema.js'`
  - [ ] **Test — catalog completeness**: assert `TWIN_TEMPLATES.size >= 2`; assert both `'localstack'` and `'wiremock'` keys exist
  - [ ] **Test — LocalStack fields**: `getTwinTemplate('localstack')!.definition.image === 'localstack/localstack:latest'`; ports include `'4566:4566'`; healthcheck URL contains `'4566'`
  - [ ] **Test — WireMock fields**: `getTwinTemplate('wiremock')!.definition.image === 'wiremock/wiremock:latest'`; ports include `'8080:8080'`; healthcheck URL contains `'8080'`
  - [ ] **Test — schema validation (LocalStack)**: `expect(() => TwinDefinitionSchema.parse(getTwinTemplate('localstack')!.definition)).not.toThrow()`
  - [ ] **Test — schema validation (WireMock)**: `expect(() => TwinDefinitionSchema.parse(getTwinTemplate('wiremock')!.definition)).not.toThrow()`
  - [ ] **Test — `getTwinTemplate` unknown returns undefined**: `expect(getTwinTemplate('nonexistent')).toBeUndefined()`
  - [ ] **Test — `listTwinTemplates` returns all entries**: assert returned array length equals `TWIN_TEMPLATES.size`; assert each entry has non-empty `name` and `description`

- [ ] Task 7: Write integration tests for `twins init` and `twins templates` CLI actions (AC: #2, #3, #4, #5, #6)
  - [ ] Create `packages/factory/src/twins/__tests__/templates-cli.test.ts`
  - [ ] For each test, create a temp project directory with `fs.mkdtempSync(path.join(os.tmpdir(), 'twins-cli-'))` and clean up in `afterEach`
  - [ ] Extract the Commander action handlers by importing the register function and capturing the action via a spy, OR test the logic by directly calling the helper functions (preferred: test the underlying logic module rather than Commander wiring to avoid subprocess overhead)
  - [ ] **Test — init localstack creates file**: call the init logic with `{ template: 'localstack', force: false }` using `process.cwd()` pointed to temp dir; assert `.substrate/twins/localstack.yaml` exists and its content parses to a valid definition with `name: 'localstack'`
  - [ ] **Test — init wiremock creates file**: same pattern for WireMock
  - [ ] **Test — init unknown template**: call logic with `{ template: 'bogus' }`; assert `process.exitCode` or thrown error includes 'Available:' and mentions valid templates
  - [ ] **Test — init existing file without force**: pre-create `.substrate/twins/localstack.yaml`; assert error message mentions `--force` and file is NOT overwritten
  - [ ] **Test — init existing file with force**: pre-create file; call with `{ template: 'localstack', force: true }`; assert the file is overwritten with new valid YAML
  - [ ] Use `vitest` imports: `import { describe, it, expect, beforeEach, afterEach } from 'vitest'`
  - [ ] All temp dirs removed in `afterEach` to prevent leakage

## Dev Notes

### Architecture Constraints
- **TypeScript only** — all new/modified code must use explicit type annotations; no `any` types
- **Import style** — use `.js` extension on all relative imports (ESM): `import { ... } from './templates.js'`
- **Port string format in YAML** — the `TwinDefinitionSchema` parses port strings in `"host:container"` format (e.g., `"4566:4566"`) NOT structured objects; `TwinDefinitionInput.ports` is `string[]`, not `PortMapping[]`; all template `definition.ports` arrays must use this string format
- **YAML serialization** — use `js-yaml`'s `yaml.dump()` to serialize the template definition object; the output must be round-trippable through `TwinRegistry.discover()` with no errors; do NOT write raw string literals — serialize the TypeScript definition object directly
- **No concrete twin imports in factory-command** — `factory-command.ts` imports `getTwinTemplate` and `listTwinTemplates` from `./twins/index.js` only; it does not import `TwinRegistry` or `TwinManager`
- **Exit code discipline** — call `process.exit(1)` for error conditions; for success, allow the process to exit naturally (exit code 0)
- **Test framework** — vitest (NOT jest); use `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`

### Key File Paths
- `packages/factory/src/twins/templates.ts` — **new**: template catalog (entries, TWIN_TEMPLATES map, accessors)
- `packages/factory/src/twins/index.ts` — **modify**: add template exports
- `packages/factory/src/factory-command.ts` — **modify**: add `twins` subcommand group with `init` and `templates` sub-subcommands
- `packages/factory/src/twins/__tests__/templates.test.ts` — **new**: catalog unit tests (7 test cases)
- `packages/factory/src/twins/__tests__/templates-cli.test.ts` — **new**: CLI integration tests (5 test cases)

### Testing Requirements
- `TwinDefinitionSchema.parse()` must succeed on every built-in template definition (AC7 enforced by tests in `templates.test.ts`)
- Use `fs.mkdtempSync(path.join(os.tmpdir(), 'twins-cli-'))` for temp directories in CLI tests
- Tests must NOT rely on Docker, network, or the `TwinRegistry.discover()` live file I/O path — validate YAML content by parsing the written file with `js-yaml` and passing to `TwinDefinitionSchema.parse()`
- `afterEach` must always clean up temp dirs via `fs.rmSync(tmpDir, { recursive: true, force: true })`
- Run `npm run test:fast` to confirm no regressions before finalizing

### Pattern Reference — factory-command.ts subcommand registration

New twins command block to add after the `validate` command:

```typescript
// Story 47-4: factory twins
const twinsCmd = factoryCmd
  .command('twins')
  .description('Digital twin template management')

twinsCmd
  .command('templates')
  .description('List available built-in twin templates')
  .action(() => {
    const templates = listTwinTemplates()
    for (const t of templates) {
      process.stdout.write(`  ${t.name.padEnd(16)}  ${t.description}\n`)
    }
  })

twinsCmd
  .command('init')
  .description('Initialize a twin definition file from a built-in template')
  .requiredOption('--template <name>', 'Template name (e.g. localstack, wiremock)')
  .option('--force', 'Overwrite existing file if it already exists')
  .action(async (opts: { template: string; force?: boolean }) => {
    try {
      const entry = getTwinTemplate(opts.template)
      if (!entry) {
        const available = listTwinTemplates().map((t) => t.name).join(', ')
        process.stderr.write(`Error: Unknown template '${opts.template}'. Available: ${available}\n`)
        process.exit(1)
        return
      }

      const targetPath = path.join(process.cwd(), '.substrate', 'twins', `${opts.template}.yaml`)

      if (!opts.force) {
        try {
          await access(targetPath)
          // File exists — error without --force
          process.stderr.write(
            `Error: File already exists: ${targetPath} — use --force to overwrite\n`,
          )
          process.exit(1)
          return
        } catch {
          // access() threw → file does not exist → proceed
        }
      }

      await mkdir(path.dirname(targetPath), { recursive: true })
      const yamlContent = yaml.dump(entry.definition)
      await writeFile(targetPath, yamlContent, 'utf-8')
      process.stdout.write(`Created ${targetPath}\n`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
      process.exit(1)
    }
  })
```

### LocalStack Template Reference

```typescript
{
  name: 'localstack',
  description: 'LocalStack — AWS cloud service emulator (S3, SQS, DynamoDB)',
  definition: {
    name: 'localstack',
    image: 'localstack/localstack:latest',
    ports: ['4566:4566'],
    environment: {
      SERVICES: 's3,sqs,dynamodb',
    },
    healthcheck: {
      url: 'http://localhost:4566/_localstack/health',
      interval_ms: 500,
      timeout_ms: 10000,
    },
  },
}
```

### WireMock Template Reference

```typescript
{
  name: 'wiremock',
  description: 'WireMock — HTTP API mock and stub server',
  definition: {
    name: 'wiremock',
    image: 'wiremock/wiremock:latest',
    ports: ['8080:8080'],
    environment: {},
    healthcheck: {
      url: 'http://localhost:8080/__admin/health',
      interval_ms: 500,
      timeout_ms: 10000,
    },
  },
}
```

## Dev Agent Record

### Agent Model Used
claude-opus-4-5

### Completion Notes List
- All 7 tasks complete; all ACs met.
- 20 new tests added (15 unit + 5 CLI integration), all passing.
- `js-yaml` was already a dependency — no new packages needed.
- Used extracted helper function pattern for CLI integration tests (avoids Commander subprocess overhead).

### File List
- packages/factory/src/twins/templates.ts (new)
- packages/factory/src/twins/index.ts (modified)
- packages/factory/src/factory-command.ts (modified)
- packages/factory/src/twins/__tests__/templates.test.ts (new)
- packages/factory/src/twins/__tests__/templates-cli.test.ts (new)

## Change Log
