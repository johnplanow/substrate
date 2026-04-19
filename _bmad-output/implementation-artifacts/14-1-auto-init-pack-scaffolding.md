# Story 14.1: Auto Init Pack Scaffolding

Status: draft

## Story

As a developer installing Substrate via npm,
I want `substrate auto init` to scaffold the methodology pack into my project automatically,
so that onboarding works out of the box without manually copying pack files.

## Acceptance Criteria

### AC1: Bundled Packs Ship with npm Package
**Given** the Substrate package is published to npm
**When** a user installs it via `npm install substrate-ai` or `npx substrate`
**Then** the `packs/` directory is included in the published package
**And** `packs/bmad/manifest.yaml` and all referenced files are present

### AC2: Auto Init Scaffolds Missing Pack
**Given** a user runs `substrate auto init` in a project that has no `packs/bmad/` directory
**When** the command detects the local pack is missing
**Then** it copies the bundled pack from the Substrate package root into `<projectRoot>/packs/<packName>/`
**And** the copy preserves all files (manifest.yaml, prompts/, constraints/, templates/)
**And** the command proceeds to validate and initialize the database as normal

### AC3: Existing Local Pack Not Overwritten
**Given** a user has an existing `packs/bmad/` directory in their project
**When** they run `substrate auto init`
**Then** the existing pack is NOT overwritten
**And** the command loads and validates the existing local pack as it does today

### AC4: Bundled Pack Not Found Error
**Given** the local pack is missing AND the bundled pack cannot be resolved (e.g., corrupt install)
**When** the user runs `substrate auto init`
**Then** the error message clearly states the pack could not be found or scaffolded
**And** the message does NOT circularly say "Run 'substrate auto init' first"
**And** the message suggests reinstalling Substrate

### AC5: Force Re-scaffold with --force Flag
**Given** a user has an existing `packs/bmad/` directory
**When** they run `substrate auto init --force`
**Then** the existing pack is replaced with the bundled version
**And** a warning is printed before overwriting: "Replacing existing pack 'bmad' with bundled version"

### AC6: JSON Output Format Supported
**Given** the user runs `substrate auto init --output-format json`
**When** pack scaffolding occurs
**Then** the JSON output includes a `scaffolded: true` field
**And** errors are formatted as JSON consistent with existing error output

### AC7: Pack Scaffolding is Logged
**Given** any scaffolding operation occurs
**When** the pack is copied to the project
**Then** a human-readable message is printed: "Scaffolding methodology pack 'bmad' into packs/bmad/"
**And** the pino logger records the operation at info level

## Dev Notes

### Architecture

This follows existing patterns in the CLI commands layer:

- **Path resolution**: Use `fileURLToPath(import.meta.url)` pattern from `src/cli/commands/templates.ts` to locate the package root, then resolve `packs/<name>` relative to it
- **File copy**: Use `cpSync(src, dest, { recursive: true })` from `node:fs` — already available, no new deps
- **No changes to pack-loader.ts** — the loader interface is clean; all changes are in the caller (`auto.ts`)

### Package Root Resolution

```typescript
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// From dist/cli/commands/auto.js → package root is 3 levels up
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_ROOT = join(__dirname, '..', '..', '..')
```

Note: After `tsdown` build, `auto.ts` compiles to `dist/cli/commands/auto.js`. Verify the relative path depth is correct post-build. The `templates.ts` command uses the same pattern for reference.

### Key Changes

1. **`package.json`** — Add `"packs"` to the `files` array
2. **`src/cli/commands/auto.ts`** — Add scaffolding step in `runAutoInit` before `packLoader.load()`
3. **`src/cli/commands/auto.ts`** — Register `--force` option on the `auto init` subcommand
4. **`src/cli/commands/auto.ts`** — Fix circular error message at line 406

### Scaffolding Logic (insert before existing Step 1)

```typescript
// Step 0: Scaffold pack if not present locally
const localManifest = join(packPath, 'manifest.yaml')
if (!existsSync(localManifest) || options.force) {
  const bundledPackPath = join(PACKAGE_ROOT, 'packs', packName)
  if (!existsSync(join(bundledPackPath, 'manifest.yaml'))) {
    // Bundled pack missing — bad install
    const errorMsg = `Pack '${packName}' not found locally or in bundled packs. Try reinstalling Substrate.`
    // ... output error and return 1
  }
  if (options.force && existsSync(localManifest)) {
    logger.info({ pack: packName }, 'Replacing existing pack with bundled version')
    process.stderr.write(`Warning: Replacing existing pack '${packName}' with bundled version\n`)
  }
  mkdirSync(dirname(packPath), { recursive: true })
  cpSync(bundledPackPath, packPath, { recursive: true })
  logger.info({ pack: packName, dest: packPath }, 'Scaffolded methodology pack')
  process.stdout.write(`Scaffolding methodology pack '${packName}' into packs/${packName}/\n`)
}
```

### Testing Strategy

- **Unit tests** (`auto.test.ts`): Mock `existsSync`, `cpSync`, `mkdirSync` — verify scaffolding logic triggers when manifest missing, skips when present, overwrites with `--force`
- **Integration test**: Use temp directory with no pack, run `runAutoInit`, verify pack files are copied and DB initialized
- Existing auto.test.ts already mocks `fs` (`existsSync`, `mkdirSync`) — extend with `cpSync` mock
- Coverage target: 80% (project standard)

### Files Modified

- `package.json` — add `packs` to `files`
- `src/cli/commands/auto.ts` — scaffolding logic, `--force` flag, error message fix

## Tasks

- [ ] Task 1: Add `packs` to `files` array in `package.json` (AC: #1)
- [ ] Task 2: Add `PACKAGE_ROOT` resolution constant using `import.meta.url` pattern in `auto.ts` (AC: #2)
- [ ] Task 3: Implement pack scaffolding logic in `runAutoInit` before pack validation step (AC: #2, #3, #5, #6, #7)
  - [ ] Check for local manifest existence
  - [ ] Resolve bundled pack path from package root
  - [ ] Copy bundled pack to local project if missing
  - [ ] Handle `--force` flag for overwrite
  - [ ] Add scaffolded field to JSON output
  - [ ] Add log messages for scaffolding operations
- [ ] Task 4: Register `--force` option on `auto init` subcommand (AC: #5)
- [ ] Task 5: Fix circular error message — replace "Run 'substrate auto init' first" with actionable message (AC: #4)
- [ ] Task 6: Write unit tests for scaffolding logic (AC: #1-#7)
  - [ ] Test: scaffolds when local pack missing
  - [ ] Test: skips scaffold when local pack exists
  - [ ] Test: overwrites with --force flag
  - [ ] Test: error when bundled pack missing
  - [ ] Test: JSON output includes scaffolded field
  - [ ] Test: human-readable scaffold message printed
- [ ] Task 7: Write integration test — full auto init in temp dir with no pack (AC: #2, #6)
- [ ] Task 8: Verify post-build path resolution — run `npm run build` and confirm `PACKAGE_ROOT` resolves correctly from `dist/cli/commands/auto.js` (AC: #1, #2)
