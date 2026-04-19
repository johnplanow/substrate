# Story 47-6: Twin Health Monitoring During Factory Runs

## Story

As a developer running factory pipelines with digital twins,
I want continuous health monitoring of twin containers during pipeline execution,
so that unhealthy twins are detected early and scenarios fail fast with informative errors instead of silently producing incorrect results.

## Acceptance Criteria

### AC1: Health monitor polls twin health endpoints at a configurable interval
**Given** a `TwinHealthMonitor` is created via `createTwinHealthMonitor(eventBus, options)` and `monitor.start(twins)` is called with twins that have a `healthcheck.url`
**When** the polling interval elapses (default `monitorIntervalMs: 30000`)
**Then** each twin's health URL is fetched; twins that return a 2xx response remain in `'healthy'` status; twins with no `healthcheck` configured are skipped

### AC2: Warning event emitted on health check failure
**Given** a twin's health endpoint returns a non-2xx response or throws a connection error during a mid-run poll
**When** the health monitor polls that twin
**Then** a `twin:health-warning` event is emitted with `{ twinName, error, consecutiveFailures }` and the twin's status transitions to `'degraded'`; a successful poll resets the consecutive failure counter and status back to `'healthy'`

### AC3: Hard failure event emitted after consecutive failures
**Given** a twin's health check has failed `maxConsecutiveFailures` times consecutively (default `3`)
**When** the next poll also fails
**Then** a `twin:health-failed` event is emitted with `{ twinName, error }`, the twin's status transitions to `'unhealthy'`, and that twin is removed from the polling rotation

### AC4: Pre-scenario health gate in ScenarioRunner
**Given** a `ScenarioRunner` is created with a `twinHealthMonitor` option injected via `ScenarioRunnerOptions`
**When** `runner.run()` is invoked and one or more twins are in `'unhealthy'` status at that moment
**Then** execution aborts before running any scenario files, returning a `ScenarioRunResult` where all scenarios are marked `'fail'` with `stderr` containing `"Twin '<name>' is unhealthy"`

### AC5: Monitor stop is idempotent
**Given** a `TwinHealthMonitor` that has been started
**When** `monitor.stop()` is called (once, multiple times, or before `start()`)
**Then** all polling timers are cancelled, no further events are emitted, and subsequent `stop()` calls are no-ops without throwing

### AC6: `getStatus()` returns current health map
**Given** twins have been started via `monitor.start(twins)`
**When** `monitor.getStatus()` is called at any point
**Then** it returns a `Record<string, TwinHealthStatus>` mapping each started twin's name to its current status: `'healthy'`, `'degraded'`, or `'unhealthy'`

### AC7: Unit tests cover monitor lifecycle and ScenarioRunner health gate
**Given** mocked `fetch` (via `vi.stubGlobal`) and a spy event bus
**When** the health-monitor test suite runs via `npm run test:fast`
**Then** all tests pass — minimum 12 test cases covering: start/stop lifecycle, healthy poll (no event emitted), failing poll (warning event + degraded status), 3 consecutive failures (health-failed event + unhealthy status), recovery after failure, stop cancels interval, `getStatus()` return shape, and the ScenarioRunner health gate (unhealthy twin aborts run before scenario execution)

## Interface Contracts

- **Export**: `TwinHealthMonitor`, `TwinHealthStatus`, `TwinHealthMonitorOptions`, `createTwinHealthMonitor` @ `packages/factory/src/twins/health-monitor.ts`
- **Export**: `twin:health-warning`, `twin:health-failed` event types @ `packages/factory/src/events.ts`
- **Import**: `TwinDefinition`, `TwinHealthcheck` @ `packages/factory/src/twins/types.ts` (from story 47-1)
- **Import**: `FactoryEvents` @ `packages/factory/src/events.ts` (from story 47-2)
- **Import**: `TwinCoordinator`, `ScenarioRunnerOptions` @ `packages/factory/src/scenarios/runner.ts` (from story 47-3)

## Tasks / Subtasks

- [ ] Task 1: Add new twin health events to `packages/factory/src/events.ts` (AC: #2, #3)
  - [ ] Add `twin:health-warning` event: `{ runId?: string; twinName: string; error: string; consecutiveFailures: number }` — emitted when a mid-run poll fails but max consecutive failures not yet reached
  - [ ] Add `twin:health-failed` event: `{ runId?: string; twinName: string; error: string }` — emitted when a twin is confirmed unhealthy (consecutive failures exhausted)
  - [ ] Add `// story 47-6` comment above both new events in the "Twin lifecycle events" block
  - [ ] Run `npm run build` after this task — zero TypeScript errors required before proceeding

- [ ] Task 2: Create `packages/factory/src/twins/health-monitor.ts` (AC: #1, #2, #3, #5, #6)
  - [ ] Define and export `TwinHealthStatus` type: `'healthy' | 'degraded' | 'unhealthy'`
  - [ ] Define and export `TwinHealthMonitorOptions` interface:
    ```typescript
    export interface TwinHealthMonitorOptions {
      /** Milliseconds between health check polls. Default: 30000. */
      monitorIntervalMs?: number
      /** Consecutive failures before emitting twin:health-failed. Default: 3. */
      maxConsecutiveFailures?: number
    }
    ```
  - [ ] Define and export `TwinHealthMonitor` interface:
    ```typescript
    export interface TwinHealthMonitor {
      /** Begin periodic health monitoring for the given twins. */
      start(twins: TwinDefinition[]): void
      /** Stop all polling timers. Idempotent — safe to call multiple times. */
      stop(): void
      /** Returns current health status for all monitored twins. */
      getStatus(): Record<string, TwinHealthStatus>
    }
    ```
  - [ ] Implement `createTwinHealthMonitor(eventBus, options?)` factory function:
    - [ ] Internal state per twin: `{ consecutiveFailures: number; status: TwinHealthStatus }`
    - [ ] `start(twins)`: filter to twins with `healthcheck?.url`; for each create a `setInterval` that calls an internal `pollTwin(twin)` function; store interval IDs; initialize all statuses to `'healthy'`
    - [ ] `pollTwin(twin)`: `fetch(twin.healthcheck.url)` in try/catch; if ok → reset counter, set status `'healthy'`; if fail → increment counter, set status `'degraded'`, emit `twin:health-warning`; if counter reaches `maxConsecutiveFailures` → set status `'unhealthy'`, emit `twin:health-failed`, clear that twin's interval
    - [ ] `stop()`: call `clearInterval` on all stored interval IDs; reset interval map to empty; guard against double-stop with a `started` flag
    - [ ] `getStatus()`: return a shallow copy of the status map
    - [ ] Use `AbortController` or try/catch with timeout on fetch to avoid hanging polls — set `signal` from `AbortSignal.timeout(twin.healthcheck?.timeout_ms ?? 5000)` if available, otherwise wrap in a `Promise.race` with a 5s timeout
    - [ ] No `any` types; use `.js` extension on all relative imports

- [ ] Task 3: Export health monitor from `packages/factory/src/twins/index.ts` (AC: #1)
  - [ ] Add: `export { createTwinHealthMonitor } from './health-monitor.js'`
  - [ ] Add: `export type { TwinHealthMonitor, TwinHealthStatus, TwinHealthMonitorOptions } from './health-monitor.js'`
  - [ ] Run `npm run build` — confirm zero TypeScript errors before proceeding

- [ ] Task 4: Extend `ScenarioRunner` with pre-scenario health gate (AC: #4)
  - [ ] In `packages/factory/src/scenarios/runner.ts`, import `TwinHealthMonitor` from `'../twins/health-monitor.js'`
  - [ ] Add `twinHealthMonitor?: TwinHealthMonitor` field to `ScenarioRunnerOptions`
  - [ ] In the `run()` method, after twin startup (inside the twin-aware code path, before `Promise.all` scenario execution):
    ```typescript
    if (options?.twinHealthMonitor) {
      const status = options.twinHealthMonitor.getStatus()
      const unhealthyTwins = Object.entries(status)
        .filter(([, s]) => s === 'unhealthy')
        .map(([name]) => name)
      if (unhealthyTwins.length > 0) {
        const msg = unhealthyTwins.map(n => `Twin '${n}' is unhealthy`).join('; ')
        return buildStartupFailureResult(manifest.scenarios, new Error(msg))
      }
    }
    ```
  - [ ] Also check health in the non-twin code path (when `!requiresTwins`) — if a health monitor is provided, still check `getStatus()` before executing scenarios; if any twin is `'unhealthy'`, abort

- [ ] Task 5: Write unit tests in `packages/factory/src/twins/__tests__/health-monitor.test.ts` (AC: #7)
  - [ ] Use vitest: `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
  - [ ] Use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach` — fake timers allow `vi.advanceTimersByTimeAsync(30000)` to trigger intervals without waiting real time
  - [ ] Mock `fetch` globally: `vi.stubGlobal('fetch', vi.fn())`; restore with `vi.unstubAllGlobals()` in `afterEach`
  - [ ] Create a minimal spy event bus: `{ emit: vi.fn() }` cast as `TypedEventBus<FactoryEvents>`
  - [ ] **Test 1 — start/stop lifecycle**: call `start([twin])` then `stop()`; advance timers by 30s; verify `fetch` NOT called after stop
  - [ ] **Test 2 — no healthcheck URL**: start with a twin that has no `healthcheck`; advance timers; verify `fetch` never called; `getStatus()` returns `{}`
  - [ ] **Test 3 — healthy poll**: mock `fetch` to return `{ ok: true }`; start + advance by 30s; verify `emit` not called; `getStatus()` shows `'healthy'`
  - [ ] **Test 4 — failing poll emits warning**: mock `fetch` to throw; start + advance by 30s; verify `emit` called with `'twin:health-warning'` payload containing `consecutiveFailures: 1`; `getStatus()` shows `'degraded'`
  - [ ] **Test 5 — warning increments counter**: advance by 60s (2 polls); verify `consecutiveFailures: 2` on second warning event
  - [ ] **Test 6 — hard failure after 3 consecutive fails**: advance by 90s (3 polls with failing fetch); verify `emit` called with `'twin:health-failed'` on the 3rd failure; `getStatus()` shows `'unhealthy'`
  - [ ] **Test 7 — polling stops after hard failure**: advance by 120s (4th interval); verify `fetch` called exactly 3 times total (not 4)
  - [ ] **Test 8 — recovery resets counter**: mock `fetch` to fail once then succeed; advance 60s; verify `getStatus()` returns `'healthy'` after recovery; no `twin:health-failed` emitted
  - [ ] **Test 9 — stop is idempotent**: call `stop()` twice before `start()` and twice after; verify no errors thrown
  - [ ] **Test 10 — getStatus before start**: `getStatus()` returns `{}` before any call to `start()`
  - [ ] **Test 11 — ScenarioRunner health gate (unhealthy)**: create a `TwinHealthMonitor` spy where `getStatus()` returns `{ 'my-twin': 'unhealthy' }`; create `ScenarioRunner` with `twinHealthMonitor`; call `runner.run(manifest, projectRoot)` (manifest with `twins: ['my-twin']`); verify result has `summary.failed > 0` and first scenario's `stderr` contains `"Twin 'my-twin' is unhealthy"`; verify no actual scenario scripts were executed
  - [ ] **Test 12 — ScenarioRunner health gate (healthy)**: `getStatus()` returns `{ 'my-twin': 'healthy' }`; verify scenarios proceed normally
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line in output; all 12+ tests pass

- [ ] Task 6: Build and regression validation (all ACs)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors required
  - [ ] Run `npm run test:fast` with `timeout: 300000` — all new tests pass; no regression in existing 7965-test baseline
  - [ ] Verify `getStatus()` return type is `Record<string, TwinHealthStatus>` (not `Record<string, string>`)

## Dev Notes

### Architecture Constraints
- **TypeScript only** — all new/modified code must use explicit type annotations; no `any` types allowed
- **Import style** — use `.js` extension on all relative imports (ESM): `import { ... } from './health-monitor.js'`
- **Test framework** — vitest (NOT jest); use fake timers (`vi.useFakeTimers()`) to control setInterval timing
- **No real Docker/network in tests** — mock `fetch` globally via `vi.stubGlobal`; tests must pass without Docker or network access
- **Event bus injection** — `createTwinHealthMonitor` receives `TypedEventBus<FactoryEvents>`; do NOT create or import a module-level singleton
- **No circular imports** — `health-monitor.ts` imports from `types.ts` and `events.ts` only; must NOT import from `registry.ts`, `docker-compose.ts`, `run-state.ts`, or `factory-command.ts`
- **Package boundary** — factory package must NOT import from `@substrate-ai/sdlc` (ADR-003)

### Key File Paths

- `packages/factory/src/twins/health-monitor.ts` — **new**: `TwinHealthMonitor` interface, `TwinHealthStatus` type, `TwinHealthMonitorOptions` interface, `createTwinHealthMonitor()` factory
- `packages/factory/src/twins/index.ts` — **modify**: add health-monitor exports
- `packages/factory/src/events.ts` — **modify**: add `twin:health-warning` and `twin:health-failed` event types
- `packages/factory/src/scenarios/runner.ts` — **modify**: import `TwinHealthMonitor`, extend `ScenarioRunnerOptions`, add health gate check before scenario execution
- `packages/factory/src/twins/__tests__/health-monitor.test.ts` — **new**: unit tests (12+ cases)

### `health-monitor.ts` Implementation Sketch

```typescript
import { setInterval, clearInterval } from 'node:timers'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'
import type { TwinDefinition } from './types.js'

export type TwinHealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface TwinHealthMonitorOptions {
  monitorIntervalMs?: number      // default: 30000
  maxConsecutiveFailures?: number // default: 3
}

export interface TwinHealthMonitor {
  start(twins: TwinDefinition[]): void
  stop(): void
  getStatus(): Record<string, TwinHealthStatus>
}

export function createTwinHealthMonitor(
  eventBus: TypedEventBus<FactoryEvents>,
  options?: TwinHealthMonitorOptions,
): TwinHealthMonitor {
  const monitorIntervalMs = options?.monitorIntervalMs ?? 30000
  const maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 3

  const statusMap = new Map<string, TwinHealthStatus>()
  const failureCountMap = new Map<string, number>()
  const intervals = new Map<string, ReturnType<typeof setInterval>>()

  async function pollTwin(twin: TwinDefinition): Promise<void> {
    if (!twin.healthcheck?.url) return
    const timeoutMs = twin.healthcheck.timeout_ms ?? 5000
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(twin.healthcheck.url, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (response.ok) {
        failureCountMap.set(twin.name, 0)
        statusMap.set(twin.name, 'healthy')
        return
      }
      throw new Error(`HTTP ${response.status}`)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const prev = failureCountMap.get(twin.name) ?? 0
      const count = prev + 1
      failureCountMap.set(twin.name, count)

      if (count >= maxConsecutiveFailures) {
        statusMap.set(twin.name, 'unhealthy')
        eventBus.emit('twin:health-failed', { twinName: twin.name, error })
        // Stop polling this twin
        const id = intervals.get(twin.name)
        if (id !== undefined) {
          clearInterval(id)
          intervals.delete(twin.name)
        }
      } else {
        statusMap.set(twin.name, 'degraded')
        eventBus.emit('twin:health-warning', {
          twinName: twin.name,
          error,
          consecutiveFailures: count,
        })
      }
    }
  }

  return {
    start(twins: TwinDefinition[]): void {
      for (const twin of twins) {
        if (!twin.healthcheck?.url) continue
        statusMap.set(twin.name, 'healthy')
        failureCountMap.set(twin.name, 0)
        const id = setInterval(() => { void pollTwin(twin) }, monitorIntervalMs)
        intervals.set(twin.name, id)
      }
    },

    stop(): void {
      for (const id of intervals.values()) {
        clearInterval(id)
      }
      intervals.clear()
    },

    getStatus(): Record<string, TwinHealthStatus> {
      return Object.fromEntries(statusMap.entries())
    },
  }
}
```

### New Events Shape

```typescript
// In FactoryEvents (events.ts) — add to twin lifecycle block:

/** Twin health check failed mid-run but has not yet exhausted retries (story 47-6) */
'twin:health-warning': {
  runId?: string
  twinName: string
  error: string
  consecutiveFailures: number
}

/** Twin confirmed unhealthy — consecutive failure limit exhausted (story 47-6) */
'twin:health-failed': {
  runId?: string
  twinName: string
  error: string
}
```

### ScenarioRunner Health Gate Placement

The health gate should run inside `runner.run()` immediately before scenario execution begins, in both the twin-aware and non-twin code paths (in case the monitor was started externally before the run). Insert after twin startup (or at the top of the non-twin path) and before `Promise.all(manifest.scenarios.map(...))`:

```typescript
// Check health gate — abort if any monitored twin is unhealthy
if (options?.twinHealthMonitor) {
  const healthStatus = options.twinHealthMonitor.getStatus()
  const unhealthyNames = Object.entries(healthStatus)
    .filter(([, s]) => s === 'unhealthy')
    .map(([name]) => name)
  if (unhealthyNames.length > 0) {
    const msg = unhealthyNames.map((n) => `Twin '${n}' is unhealthy`).join('; ')
    return buildStartupFailureResult(manifest.scenarios, new Error(msg))
  }
}
```

### Testing Notes for Fake Timers

Use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(N)` to trigger setInterval callbacks without real waiting. The `pollTwin` function is async so use `await vi.advanceTimersByTimeAsync(30000)` (not `vi.advanceTimersByTime`) to allow async callbacks to complete.

Example test pattern:
```typescript
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('emits warning on failing poll', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
  const eventBus = { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
  const monitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 1000 })
  monitor.start([{ name: 'my-twin', image: 'x', ports: [], environment: {},
    healthcheck: { url: 'http://localhost:4566/health' } }])
  await vi.advanceTimersByTimeAsync(1100)
  expect(eventBus.emit).toHaveBeenCalledWith('twin:health-warning', expect.objectContaining({
    twinName: 'my-twin', consecutiveFailures: 1,
  }))
  monitor.stop()
})
```

### Dependency Alignment

Story 47-8 (DTU Integration Test) directly depends on this story (47-6) — specifically the mid-run crash detection scenario (47-8 AC2). The `TwinHealthMonitor` created here will be used in integration tests to simulate a twin crashing mid-run.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 47 — Digital Twin Foundation
