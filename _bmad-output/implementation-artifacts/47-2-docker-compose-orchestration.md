# Story 47-2: Docker Compose Orchestration

## Story

As a factory pipeline developer,
I want a `TwinManager` that generates Docker Compose files and manages twin container lifecycles (start, stop, health check, cleanup),
so that scenario runners can depend on external service twins that are reliably started before test execution and cleaned up afterwards.

## Acceptance Criteria

### AC1: Generate Compose File and Execute `docker compose up -d`
**Given** a set of twin definitions (each with `name`, `image`, `ports`, `environment`)
**When** `twinManager.start(twins)` is called
**Then** a `docker-compose.yml` is written to a temp directory with one service per twin and `docker compose up -d` is executed in that directory

### AC2: Correct Service Mapping in Generated Compose File
**Given** a twin definition with `image: "localstack/localstack"`, `ports: [{ host: 4566, container: 4566 }]`, and `environment: { SERVICES: "s3" }`
**When** `twinManager.start([twin])` is called
**Then** the generated `docker-compose.yml` contains a service entry with image `"localstack/localstack"`, port mapping `"4566:4566"`, and environment variable `SERVICES: s3`

### AC3: Health Check Polling Before Resolving Ready
**Given** a twin definition with `healthcheck.url: "http://localhost:4566/_localstack/health"`
**When** `twinManager.start(twins)` is called
**Then** the manager polls the health endpoint at 1-second intervals up to `maxAttempts` (default 30) until it receives a 2xx response before resolving

### AC4: Docker Not Installed Returns Descriptive Error
**Given** Docker is not available in PATH (i.e., `docker info` exits non-zero)
**When** `twinManager.start(twins)` is called
**Then** a `TwinError` is thrown with message `"Docker not found — twins require Docker"`

### AC5: `twin:started` Event Emitted Per Twin on Success
**Given** twins start successfully and health checks pass (or no health check is defined)
**When** `twinManager.start(twins)` resolves
**Then** a `twin:started` event is emitted for each twin containing `{ twinName, ports, healthStatus: 'healthy' }`

### AC6: `stop()` Shuts Down Containers and Deletes Compose File
**Given** running twins started via `twinManager.start(twins)`
**When** `twinManager.stop()` is called
**Then** `docker compose down --remove-orphans` is executed and the temp compose directory is deleted

### AC7: `TwinManager` Interface, `createTwinManager` Factory, and `TwinError` Exported
**Given** the `packages/factory` package
**When** `TwinManager`, `createTwinManager`, and `TwinError` are imported from `packages/factory/src/twins/docker-compose.ts`
**Then** all are available; `createTwinManager(eventBus)` returns a `TwinManager` with callable `start()` and `stop()` methods

## Tasks / Subtasks

- [ ] Task 1: Add `twin:started` and `twin:stopped` to `FactoryEvents` in `packages/factory/src/events.ts` (AC: #5)
  - [ ] Add `'twin:started': { runId?: string; twinName: string; ports: Array<{ host: number; container: number }>; healthStatus: 'healthy' | 'unknown' }` to the `FactoryEvents` intersection type
  - [ ] Add `'twin:stopped': { twinName: string }` to `FactoryEvents`
  - [ ] Update the JSDoc comment block on `FactoryEvents` to mention twin lifecycle events added in story 47-2

- [ ] Task 2: Create `packages/factory/src/twins/docker-compose.ts` with interface, error, and factory (AC: #4, #7)
  - [ ] Create the file and define `TwinError extends Error` with `this.name = 'TwinError'`
  - [ ] Define `TwinManagerOptions` interface: `{ maxHealthAttempts?: number; healthIntervalMs?: number }`
  - [ ] Define `TwinManager` interface: `start(twins: TwinDefinition[]): Promise<void>`, `stop(): Promise<void>`
  - [ ] Import `TwinDefinition` from `'./types.js'` (defined by story 47-1)
  - [ ] Import `TypedEventBus` from `'@substrate-ai/core'` and `FactoryEvents` from `'../events.js'`
  - [ ] Export `createTwinManager(eventBus: TypedEventBus<FactoryEvents>, options?: TwinManagerOptions): TwinManager`

- [ ] Task 3: Implement Docker Compose YAML generation (AC: #1, #2)
  - [ ] Implement private `generateComposeYaml(twins: TwinDefinition[]): string`
  - [ ] Produce a valid Compose v3.8 YAML string: top-level `version: '3.8'` and `services:` map
  - [ ] For each twin: add a service keyed by `twin.name` with `image`, `ports` array (`"host:container"` format), and `environment` as a key-value map
  - [ ] Use `os.tmpdir()` + a `crypto.randomUUID()`-based subdirectory for the compose file path
  - [ ] Write the YAML using `fs.mkdirSync` + `fs.writeFileSync`; store the temp dir path on the instance for `stop()`

- [ ] Task 4: Implement Docker availability check and `docker compose up -d` launch (AC: #1, #4)
  - [ ] Before compose execution, run `execSync('docker info', { stdio: 'ignore' })` wrapped in a try/catch; on failure throw `new TwinError("Docker not found — twins require Docker")`
  - [ ] Execute `execSync('docker compose up -d', { cwd: composeDir, stdio: 'pipe' })` after YAML is written
  - [ ] On non-zero exit, throw `new TwinError('docker compose up failed: ' + stderr)`

- [ ] Task 5: Implement health check polling and `twin:started` event emission (AC: #3, #5)
  - [ ] After `docker compose up -d` succeeds, iterate each twin that has `healthcheck.url`
  - [ ] For each: poll the URL using `fetch` at `healthIntervalMs` (default 1000 ms) intervals, up to `maxHealthAttempts` (default 30) attempts
  - [ ] If all attempts fail, throw `new TwinError(\`Twin '${twin.name}' failed health check after ${maxAttempts} attempts\`)`
  - [ ] Emit `twin:started` for every twin (health check passing or no health check) via the injected event bus: `{ twinName: twin.name, ports: twin.ports, healthStatus: 'healthy' }`

- [ ] Task 6: Implement `stop()` and cleanup (AC: #6)
  - [ ] Guard: if `stop()` is called before `start()` (no compose dir stored), return immediately (no-op)
  - [ ] Execute `execSync('docker compose down --remove-orphans', { cwd: composeDir, stdio: 'pipe' })`
  - [ ] Delete the temp directory recursively using `fs.rmSync(composeDir, { recursive: true, force: true })`
  - [ ] Emit `twin:stopped` event for each twin that was started

- [ ] Task 7: Create `packages/factory/src/twins/index.ts` and write unit tests (AC: #7)
  - [ ] Create `packages/factory/src/twins/index.ts` exporting `TwinManager`, `createTwinManager`, `TwinError`; also re-export `TwinDefinition` from `'./types.js'`
  - [ ] Ensure `packages/factory/src/index.ts` re-exports from `'./twins/index.js'`
  - [ ] Create `packages/factory/src/twins/__tests__/docker-compose.test.ts`
  - [ ] Mock `node:child_process` using `vi.mock('node:child_process')` — tests must not require Docker installed
  - [ ] Mock `node:fs` calls for file write operations
  - [ ] **AC1 test**: verify `execSync` is called with `'docker compose up -d'` and compose file is written
  - [ ] **AC2 test**: capture generated YAML string — assert it contains `localstack/localstack`, `"4566:4566"`, and `SERVICES: s3`
  - [ ] **AC3 test**: mock `fetch` to return 200 on 2nd attempt — verify polling retries and `start()` resolves successfully
  - [ ] **AC3 timeout test**: mock `fetch` to always fail — verify `TwinError("failed health check after 30 attempts")` is thrown
  - [ ] **AC4 test**: mock `docker info` execSync to throw — verify `TwinError("Docker not found — twins require Docker")`
  - [ ] **AC5 test**: verify `eventBus.emit('twin:started', ...)` called with correct `twinName`, `ports`, `healthStatus`
  - [ ] **AC6 test**: call `stop()` after `start()` — verify `execSync` called with `'docker compose down --remove-orphans'`
  - [ ] **AC6 cleanup test**: verify `fs.rmSync` called with the temp dir path after stop
  - [ ] **AC7 test**: `typeof createTwinManager === 'function'` and `typeof TwinError === 'function'`
  - [ ] **No-op stop test**: call `stop()` without prior `start()` — verify no error thrown and no execSync called
  - [ ] Aim for ≥ 12 tests in the describe block

- [ ] Task 8: Build validation (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears; all tests pass
  - [ ] Confirm no regressions in the 7,965-test baseline

## Dev Notes

### Architecture Constraints

- **Primary new file:** `packages/factory/src/twins/docker-compose.ts` — all `TwinManager` interface, `TwinError`, and `createTwinManager` factory live here
- **Events update:** `packages/factory/src/events.ts` — add `twin:started` and `twin:stopped` to the existing `FactoryEvents` intersection type; do NOT restructure the file
- **Depends on story 47-1** for `TwinDefinition` type from `packages/factory/src/twins/types.ts`; if 47-1 has not yet been implemented, stub `TwinDefinition` locally and add a `// TODO: import from ./types.js once 47-1 ships` comment
- **ESM imports:** All relative imports within the factory package use `.js` extensions (e.g., `import type { TwinDefinition } from './types.js'`)
- **Event bus injection:** `createTwinManager(eventBus: TypedEventBus<FactoryEvents>, options?)` — the event bus is injected; do NOT import a global singleton or create one internally
- **Temp directory:** Use `os.tmpdir()` + `crypto.randomUUID()` subdirectory. Delete on `stop()` via `fs.rmSync(dir, { recursive: true, force: true })`
- **No real Docker in tests:** Mock `child_process.execSync` and `fetch` entirely — tests must pass without Docker installed
- **Test framework:** Vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`

### TwinDefinition Dependency (from Story 47-1)

Story 47-2 imports the `TwinDefinition` interface defined in 47-1:

```typescript
// packages/factory/src/twins/types.ts (defined by story 47-1)
export interface TwinDefinition {
  name: string
  image: string
  ports: Array<{ host: number; container: number }>
  healthcheck?: {
    url: string
    intervalMs?: number
    maxAttempts?: number
  }
  environment?: Record<string, string>
}
```

### TwinManager Interface and Factory Signature

```typescript
export class TwinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwinError'
  }
}

export interface TwinManager {
  /** Start all specified twins via Docker Compose. Resolves when all are healthy. */
  start(twins: TwinDefinition[]): Promise<void>
  /** Stop all running twins and clean up the compose file. No-op if not started. */
  stop(): Promise<void>
}

export interface TwinManagerOptions {
  /** Maximum polling attempts per health check. Default: 30. */
  maxHealthAttempts?: number
  /** Milliseconds between health check polls. Default: 1000. */
  healthIntervalMs?: number
}

export function createTwinManager(
  eventBus: TypedEventBus<FactoryEvents>,
  options?: TwinManagerOptions
): TwinManager
```

### Generated Docker Compose YAML Format

The generated `docker-compose.yml` must use Compose spec version 3.8:

```yaml
version: '3.8'
services:
  localstack:
    image: localstack/localstack
    ports:
      - "4566:4566"
    environment:
      SERVICES: s3
```

Build the YAML string manually (no external YAML library dependency). Each service block is straightforward enough to assemble with template strings. Environment variables must be emitted as `KEY: VALUE` lines under the `environment:` key.

### New Events Added to `FactoryEvents`

```typescript
/** Twin container started successfully and health check passed (story 47-2) */
'twin:started': {
  runId?: string
  twinName: string
  ports: Array<{ host: number; container: number }>
  healthStatus: 'healthy' | 'unknown'
}

/** Twin container stopped and cleaned up (story 47-2) */
'twin:stopped': {
  twinName: string
}
```

### Health Check Polling Algorithm

```
For each twin with healthcheck.url:
  attempts = 0
  maxAttempts = twin.healthcheck.maxAttempts ?? options.maxHealthAttempts ?? 30
  intervalMs = twin.healthcheck.intervalMs ?? options.healthIntervalMs ?? 1000

  while attempts < maxAttempts:
    try:
      response = await fetch(healthcheck.url)
      if response.ok (status 200-299): break
    catch: (connection refused — container not yet up)
    attempts++
    await sleep(intervalMs)

  if attempts === maxAttempts:
    throw new TwinError(`Twin '${name}' failed health check after ${maxAttempts} attempts`)
```

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`
- **Mock strategy:** Use `vi.mock('node:child_process', ...)` and `vi.mock('node:fs', ...)` to avoid real filesystem and subprocess calls; mock global `fetch` with `vi.stubGlobal('fetch', ...)`
- **Run command:** `npm run test:fast` with `timeout: 300000`
- **NEVER pipe** test output through `head`, `tail`, or `grep`
- **Confirm results** by checking for "Test Files" summary line in output
- **Minimum new tests:** ≥ 12 tests in the new test file
- **No regressions:** All 7,965 existing tests must continue to pass

## Interface Contracts

- **Export**: `TwinManager` @ `packages/factory/src/twins/docker-compose.ts` (consumed by story 47-3)
- **Export**: `TwinError` @ `packages/factory/src/twins/docker-compose.ts` (consumed by stories 47-3, 47-5)
- **Export**: `createTwinManager` @ `packages/factory/src/twins/docker-compose.ts` (consumed by story 47-3)
- **Export**: `twin:started` event shape @ `packages/factory/src/events.ts` (consumed by stories 47-3, 47-6)
- **Import**: `TwinDefinition` @ `packages/factory/src/twins/types.ts` (from story 47-1)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 47 — Digital Twin Foundation
