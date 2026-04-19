# Story 47-1: Twin Registry — Definition Schema and Storage

## Story

As a factory pipeline operator,
I want a typed twin registry that discovers, validates, and stores twin definitions from YAML files,
so that downstream stories (Docker Compose orchestration, scenario integration, CLI commands) can depend on a well-defined `TwinDefinition` schema and registry API.

## Acceptance Criteria

### AC1: YAML Discovery and Full-Field Parsing
**Given** a twin definition YAML file at `.substrate/twins/stripe.yaml` containing `name`, `image`, `ports`, `healthcheck`, and `environment` fields
**When** `registry.discover('.substrate/twins/')` is called
**Then** the twin is loaded, parsed, and returned as a valid `TwinDefinition` object with all fields correctly typed; `registry.list()` returns exactly one entry matching the file contents

### AC2: Required Field Validation — Descriptive Error on Missing Fields
**Given** a twin definition YAML file that is missing the required `name` or `image` field
**When** `registry.discover()` processes that file
**Then** a `TwinDefinitionError` is thrown with a message that identifies both the missing field name and the source file path (e.g., `"Twin definition at .substrate/twins/bad.yaml is missing required field: name"`)

### AC3: Malformed YAML and Unknown Field Detection
**Given** a YAML file that contains syntactically invalid YAML or an unrecognised top-level field not in the schema
**When** `registry.discover()` processes that file
**Then** a `TwinDefinitionError` is thrown with a descriptive message; valid sibling files in the same directory are still discovered

### AC4: Duplicate Twin Name Detection
**Given** two YAML files in `.substrate/twins/` that both declare `name: postgres`
**When** `registry.discover()` is called
**Then** a `TwinRegistryError` is thrown with a message indicating a duplicate twin name and listing both conflicting file paths

### AC5: Port Mapping Parsed into Structured Objects
**Given** a twin definition with `ports: ['5432:5432', '5433:5433']` in host:container string format
**When** the twin is parsed and returned by `registry.list()`
**Then** each port entry is available as a structured `PortMapping` object with `host: number` and `container: number` properties; the raw string form is not exposed

### AC6: Optional Fields Default Correctly
**Given** a twin definition YAML containing only the required `name` and `image` fields (no `healthcheck`, `environment`, or `ports`)
**When** parsed by `registry.discover()`
**Then** `environment` defaults to `{}`, `ports` defaults to `[]`, `healthcheck` is `undefined`, and the object satisfies `TwinDefinition` without TypeScript errors

### AC7: Health Endpoint Polling with Configurable Interval and Timeout
**Given** a `TwinDefinition` with `healthcheck: { url: 'http://localhost:4242/health', interval_ms: 200, timeout_ms: 1000 }`
**When** `registry.pollHealth(twin, { fetch: mockFetch })` is called, where `mockFetch` returns HTTP 200 on the third call
**Then** the function resolves with `{ healthy: true, attempts: 3 }` before the timeout; and when `mockFetch` always returns a non-2xx response, the function resolves with `{ healthy: false, error: 'Health check timed out after 1000ms' }` after the timeout elapses

## Tasks / Subtasks

- [ ] Task 1: Define `TwinDefinition` and supporting types in `packages/factory/src/twins/types.ts` (AC: #1, #5, #6, #7)
  - [ ] Export `PortMapping` interface: `{ host: number; container: number }`
  - [ ] Export `TwinHealthcheck` interface: `{ url: string; interval_ms?: number; timeout_ms?: number }`
  - [ ] Export `TwinDefinition` interface: `{ name: string; image: string; ports: PortMapping[]; environment: Record<string, string>; healthcheck?: TwinHealthcheck; sourceFile?: string }`
  - [ ] Export `HealthPollResult` type: `{ healthy: true; attempts: number } | { healthy: false; error: string }`
  - [ ] Export `TwinDefinitionError` class (extends `Error`) and `TwinRegistryError` class (extends `Error`) with `sourceFile?: string` property

- [ ] Task 2: Implement Zod validation schema for twin definitions in `packages/factory/src/twins/schema.ts` (AC: #1, #2, #3, #6)
  - [ ] Import `z` from `'zod'`; confirm `zod` is already in `packages/factory/package.json` (if not, add it)
  - [ ] Define `portMappingStringSchema`: refine `z.string()` matching `/^\d+:\d+$/` with transform to `PortMapping`
  - [ ] Define `twinHealthcheckSchema`: `z.object({ url: z.string().url(), interval_ms: z.number().int().positive().default(500), timeout_ms: z.number().int().positive().default(10000) })`
  - [ ] Define `twinDefinitionSchema`: `z.object({ name: z.string().min(1), image: z.string().min(1), ports: z.array(portMappingStringSchema).default([]), environment: z.record(z.string()).default({}), healthcheck: twinHealthcheckSchema.optional() })`
  - [ ] Use `.strict()` on `twinDefinitionSchema` so unknown fields are rejected (AC#3)
  - [ ] Export `TwinDefinitionSchema` and its inferred type `TwinDefinitionInput`

- [ ] Task 3: Implement `TwinRegistry` class in `packages/factory/src/twins/registry.ts` (AC: #1, #2, #3, #4)
  - [ ] Import `fs/promises` and `path` (Node builtins); import `js-yaml` (add to `packages/factory/package.json` if absent); import `TwinDefinitionSchema` from `'./schema.js'`; import error classes and `TwinDefinition` from `'./types.js'`
  - [ ] Implement `discover(dir: string): Promise<void>`: read all `*.yaml` and `*.yml` files in `dir` (non-recursive); for each file, `yaml.load()` the content, run `TwinDefinitionSchema.safeParse()`; on ZodError, throw `TwinDefinitionError` with file path + field info; on YAML parse error, throw `TwinDefinitionError`; store valid definitions in a `Map<string, TwinDefinition>` keyed by name
  - [ ] Detect duplicate names: if `Map` already has `twin.name`, throw `TwinRegistryError` with both file paths
  - [ ] Attach `sourceFile` (absolute path) to each parsed `TwinDefinition`
  - [ ] Implement `list(): TwinDefinition[]`: return `Array.from(this._twins.values())`
  - [ ] Implement `get(name: string): TwinDefinition | undefined`
  - [ ] Export `createTwinRegistry(): TwinRegistry` factory function

- [ ] Task 4: Implement `pollHealth` in `packages/factory/src/twins/registry.ts` (AC: #7)
  - [ ] Add `pollHealth(twin: TwinDefinition, options?: { fetch?: typeof fetch }): Promise<HealthPollResult>` to the `TwinRegistry` class
  - [ ] If `twin.healthcheck` is `undefined`, resolve immediately with `{ healthy: true, attempts: 0 }`
  - [ ] Use `options.fetch ?? globalThis.fetch` as the HTTP client (enables mocking in tests without `vi.mock`)
  - [ ] Loop: attempt HTTP GET on `healthcheck.url`; if response status is 2xx, return `{ healthy: true, attempts }`; wait `interval_ms` between attempts; if elapsed time exceeds `timeout_ms`, return `{ healthy: false, error: 'Health check timed out after ${timeout_ms}ms' }`
  - [ ] Catch network errors (e.g., ECONNREFUSED) and treat as a non-2xx result (continue looping)

- [ ] Task 5: Create barrel export in `packages/factory/src/twins/index.ts` (AC: #1)
  - [ ] Export `createTwinRegistry`, `TwinRegistry` from `'./registry.js'`
  - [ ] Export all types from `'./types.js'`
  - [ ] Export `TwinDefinitionSchema` from `'./schema.js'`

- [ ] Task 6: Write unit tests in `packages/factory/src/twins/__tests__/registry.test.ts` (AC: #1–#7)
  - [ ] Import `createTwinRegistry` from `'../registry.js'`; import `TwinDefinitionError`, `TwinRegistryError`, `type TwinDefinition` from `'../types.js'`; use `vitest` globals (`describe`, `it`, `expect`, `vi`)
  - [ ] Use `os.tmpdir()` + `crypto.randomUUID()` for temp directories in tests; clean up with `afterEach` using `fs.rm(dir, { recursive: true, force: true })`
  - [ ] Helper `writeTwin(dir, filename, content)` using `fs.writeFile`
  - [ ] **AC1 tests** (≥3 `it` cases): full-field YAML parsed correctly; `list()` returns correct count; `get('stripe')` returns correct definition
  - [ ] **AC2 tests** (≥2 `it` cases): missing `name` → `TwinDefinitionError` with file path; missing `image` → `TwinDefinitionError`
  - [ ] **AC3 tests** (≥2 `it` cases): invalid YAML syntax → `TwinDefinitionError`; unknown field → `TwinDefinitionError`; valid sibling still discovered
  - [ ] **AC4 test** (≥1 `it` case): two files with same name → `TwinRegistryError` mentioning both file paths
  - [ ] **AC5 tests** (≥2 `it` cases): `'5432:5432'` → `{ host: 5432, container: 5432 }`; multiple ports parsed correctly
  - [ ] **AC6 tests** (≥2 `it` cases): minimal definition (name+image only) parsed without error; defaults applied (`ports: []`, `environment: {}`)
  - [ ] **AC7 tests** (≥3 `it` cases): `mockFetch` returns 200 on 3rd call → `{ healthy: true, attempts: 3 }`; always-failing mock → `{ healthy: false, error: '...' }`; no healthcheck → `{ healthy: true, attempts: 0 }`
  - [ ] Ensure at least 15 `it(...)` cases total

- [ ] Task 7: Run tests and confirm passing (AC: #1–#7)
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line appears with zero failures
  - [ ] Do NOT pipe output through `grep`, `head`, `tail`, or any filtering command — check raw output for the summary line
  - [ ] If any import fails (missing `.js` extension, wrong path), fix the import and re-run
  - [ ] Confirm `js-yaml` and `zod` are resolvable from `packages/factory` (check `package.json`; add if absent)

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { foo } from './bar.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `createDatabaseAdapter` / `TypedEventBus` / `DatabaseAdapter`: import from `@substrate-ai/core` (package import, not relative)
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`, `vi.fn`, `beforeEach`, `afterEach`) — no Jest globals
- No `vi.mock()` for `fs` or `yaml` — use real filesystem with temp directories; inject `fetch` via options parameter (avoids module mocking)

### New File Paths
```
packages/factory/src/twins/types.ts      — TwinDefinition, PortMapping, error classes, HealthPollResult
packages/factory/src/twins/schema.ts     — Zod validation schema
packages/factory/src/twins/registry.ts   — TwinRegistry class, createTwinRegistry(), pollHealth()
packages/factory/src/twins/index.ts      — barrel export
packages/factory/src/twins/__tests__/registry.test.ts  — unit tests (≥15 test cases)
```

### Key Import Patterns

```typescript
// types.ts (no external deps)
export interface PortMapping { host: number; container: number }
export interface TwinHealthcheck { url: string; interval_ms?: number; timeout_ms?: number }
export interface TwinDefinition {
  name: string
  image: string
  ports: PortMapping[]
  environment: Record<string, string>
  healthcheck?: TwinHealthcheck
  sourceFile?: string
}
export type HealthPollResult =
  | { healthy: true; attempts: number }
  | { healthy: false; error: string }
export class TwinDefinitionError extends Error {
  constructor(message: string, public readonly sourceFile?: string) { super(message) }
}
export class TwinRegistryError extends Error {}

// schema.ts
import { z } from 'zod'
import type { TwinDefinition } from './types.js'

// registry.ts
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { TwinDefinitionSchema } from './schema.js'
import { TwinDefinitionError, TwinRegistryError } from './types.js'
import type { TwinDefinition, HealthPollResult } from './types.js'

// registry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createTwinRegistry } from '../registry.js'
import { TwinDefinitionError, TwinRegistryError } from '../types.js'
import type { TwinDefinition } from '../types.js'
```

### Reference YAML Fixture

```yaml
# .substrate/twins/stripe.yaml
name: stripe
image: stripe/stripe-mock:latest
ports:
  - "12111:12111"
environment:
  STRIPE_MOCK_PORT: "12111"
healthcheck:
  url: "http://localhost:12111/v1/charges"
  interval_ms: 500
  timeout_ms: 10000
```

### pollHealth Test Pattern

```typescript
it('resolves healthy when fetch succeeds on 3rd attempt', async () => {
  const registry = createTwinRegistry()
  const twin: TwinDefinition = {
    name: 'test',
    image: 'test:latest',
    ports: [],
    environment: {},
    healthcheck: { url: 'http://localhost:9999/health', interval_ms: 10, timeout_ms: 500 },
  }
  let callCount = 0
  const mockFetch = vi.fn().mockImplementation(async () => {
    callCount++
    if (callCount < 3) return { ok: false, status: 503 }
    return { ok: true, status: 200 }
  })
  const result = await registry.pollHealth(twin, { fetch: mockFetch as unknown as typeof fetch })
  expect(result).toEqual({ healthy: true, attempts: 3 })
})
```

### js-yaml Dependency Check

Before adding `js-yaml`, check whether it's already present in the factory package:
```bash
cat packages/factory/package.json | grep js-yaml
```
If absent, add `"js-yaml": "^4.1.0"` to `dependencies` and `"@types/js-yaml": "^4.0.9"` to `devDependencies`, then run `npm install` at the repo root.

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi.fn`, `beforeEach`, `afterEach`
- Real filesystem with temp directories — no mocking of `fs` or `js-yaml`
- Inject mock `fetch` via options parameter for `pollHealth` tests
- Run with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output

## Interface Contracts

- **Export**: `TwinDefinition` @ `packages/factory/src/twins/types.ts` (consumed by stories 47-2, 47-3, 47-4, 47-5, 47-6, 47-7)
- **Export**: `PortMapping` @ `packages/factory/src/twins/types.ts` (consumed by stories 47-2, 47-5)
- **Export**: `TwinHealthcheck` @ `packages/factory/src/twins/types.ts` (consumed by stories 47-2, 47-6)
- **Export**: `HealthPollResult` @ `packages/factory/src/twins/types.ts` (consumed by story 47-2)
- **Export**: `TwinDefinitionError`, `TwinRegistryError` @ `packages/factory/src/twins/types.ts` (consumed by stories 47-2, 47-3, 47-5)
- **Export**: `createTwinRegistry`, `TwinRegistry` @ `packages/factory/src/twins/registry.ts` (consumed by stories 47-2, 47-5)
- **Import**: `createDatabaseAdapter`, `TypedEventBus` @ `@substrate-ai/core` (not needed in this story, but downstream stories 47-7 will use them)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
