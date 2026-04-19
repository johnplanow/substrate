# Story 50-3: Join Policies — wait_all, first_success, and quorum

## Story

As a pipeline graph author,
I want configurable join policies (`wait_all`, `first_success`, `quorum`) on parallel nodes,
so that I can control how fan-out branches are coordinated — waiting for all branches, racing to the first success, or requiring a quorum — before the fan-in stage proceeds.

## Acceptance Criteria

### AC1: wait_all Policy — All Branches Must Complete
**Given** a parallel node with `join_policy="wait_all"` (or no `join_policy` attribute) and 3 outgoing branches
**When** the parallel handler executes all branches
**Then** the handler waits for all 3 branches to complete (SUCCESS or FAIL) before resolving, and `context.get("parallel.results")` contains exactly 3 `BranchResult` entries including any failed branches

### AC2: first_success Policy — Cancel Remaining on First SUCCESS
**Given** a parallel node with `join_policy="first_success"` and 3 branches where branch-1 completes with SUCCESS first
**When** branch-1 resolves with outcome `SUCCESS`
**Then** the parallel handler triggers cancellation on the remaining branches via `AbortController`, resolves immediately with the winning branch's result, and stores the winner index in `context.set("parallel.winner_index", 0)` and the full results array (including CANCELLED entries) in `context.set("parallel.results", [...])`

### AC3: quorum Policy — Proceed After quorum_size Successes
**Given** a parallel node with `join_policy="quorum"`, `quorum_size=2`, and 4 branches
**When** any 2 branches complete with outcome `SUCCESS`
**Then** the handler triggers cancellation on the remaining 2 branches, resolves with `context.get("parallel.results")` containing the 2 successful results plus any CANCELLED entries, and stores the quorum count in `context.set("parallel.quorum_reached", 2)`

### AC4: Branch Cancellation Uses AbortController
**Given** a `first_success` or `quorum` policy run with multiple in-flight branches
**When** the join condition is satisfied and cancellation is triggered
**Then** each in-flight branch receives an `AbortSignal` that is aborted, the parallel handler awaits branch cleanup up to `cancel_drain_timeout_ms` (default 5000 ms), and branches that have not yet started are skipped entirely

### AC5: quorum Failure When Quorum Cannot Be Reached
**Given** a parallel node with `join_policy="quorum"` and `quorum_size=3` and 4 branches where 3 branches fail before the quorum is met
**When** the number of failed branches makes it mathematically impossible to reach the quorum (failed > total − quorum_size)
**Then** the handler terminates early with overall outcome `FAIL`, stores the failure reason string in `context.set("parallel.join_error", "quorum unreachable: 3 failed, needed 3 of 4")`, and cancels any remaining in-flight branches

### AC6: JoinPolicy Types Extracted Into Dedicated Module
**Given** `packages/factory/src/handlers/join-policy.ts`
**When** imported by `packages/factory/src/handlers/parallel.ts`
**Then** it exports `JoinPolicy` string-union type, `JoinPolicyConfig` interface, `BranchResult` interface, `JoinDecision` discriminated union, and a pure `evaluateJoinPolicy(policy: JoinPolicyConfig, completed: BranchResult[], total: number): JoinDecision` function — with zero async I/O and zero external dependencies

### AC7: Unit Tests Cover All Join Policy Behaviors
**Given** `packages/factory/src/handlers/__tests__/join-policy.test.ts`
**When** run via `npm run test:fast`
**Then** at least 20 `it(...)` cases pass covering: `wait_all` (all-success, mixed success/fail), `first_success` (race won on first, race won on second, all-fail fallback), `quorum` (exact quorum met, quorum exceeded, quorum unreachable), cancellation signal delivery, `cancel_drain_timeout_ms` default, and edge cases (single branch, zero quorum_size guard)

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/handlers/join-policy.ts` — types and pure evaluator (AC: #6)
  - [ ] Export `JoinPolicy` as `'wait_all' | 'first_success' | 'quorum'`
  - [ ] Export `BranchResult` interface with fields: `index: number`, `outcome: 'SUCCESS' | 'FAIL' | 'CANCELLED'`, `contextSnapshot?: Record<string, unknown>`, `error?: string`
  - [ ] Export `JoinPolicyConfig` interface with fields: `policy: JoinPolicy`, `quorum_size?: number`, `cancel_drain_timeout_ms?: number` (default 5000)
  - [ ] Export `JoinDecision` discriminated union: `{ action: 'continue'; results: BranchResult[] } | { action: 'wait' } | { action: 'fail'; reason: string }`
  - [ ] Implement `evaluateJoinPolicy(config: JoinPolicyConfig, completed: BranchResult[], total: number): JoinDecision` as a pure, synchronous function with no imports beyond the local types
  - [ ] Inside `evaluateJoinPolicy`: handle `wait_all` (continue only when `completed.length === total`), `first_success` (continue on first SUCCESS, fail if all completed with FAIL), `quorum` (continue on N successes, fail if remaining cannot reach quorum)

- [ ] Task 2: Implement `BranchCancellationManager` class in `join-policy.ts` (AC: #4)
  - [ ] Export `BranchCancellationManager` class that holds one `AbortController` per branch index
  - [ ] Method `getSignal(index: number): AbortSignal` — returns the signal for the given branch
  - [ ] Method `cancelRemaining(completedIndices: Set<number>): void` — calls `abort()` on all controllers whose index is not in `completedIndices`
  - [ ] Method `drainAsync(timeoutMs: number): Promise<void>` — resolves after `timeoutMs` ms (gives cancelled branches time to clean up); implemented with `new Promise(resolve => setTimeout(resolve, timeoutMs))`
  - [ ] Constructor accepts `branchCount: number` and allocates `branchCount` AbortControllers

- [ ] Task 3: Extend `packages/factory/src/handlers/parallel.ts` to wire join policies (AC: #1, #2, #3, #4, #5)
  - [ ] Import `evaluateJoinPolicy`, `BranchCancellationManager`, `JoinPolicyConfig`, `BranchResult`, `JoinDecision` from `./join-policy.js`
  - [ ] Parse `join_policy` node attribute (default `'wait_all'`), `quorum_size` (default `undefined`), `cancel_drain_timeout_ms` (default `5000`) from `node.attrs`
  - [ ] Construct `JoinPolicyConfig` from parsed attributes before launching branches
  - [ ] Create a `BranchCancellationManager` for the current parallel execution; pass each branch's `AbortSignal` into the branch execution context or dispatch options
  - [ ] After each branch completes, push a `BranchResult` into a shared `completed` array and call `evaluateJoinPolicy`
  - [ ] On `action: 'continue'`: call `cancellationManager.cancelRemaining(completedIndices)`, `await cancellationManager.drainAsync(config.cancel_drain_timeout_ms ?? 5000)`, then store results and resolve
  - [ ] On `action: 'fail'`: cancel remaining branches, store `parallel.join_error`, and return `{ outcome: 'FAIL' }`
  - [ ] On `action: 'wait'`: continue listening for the next branch to complete
  - [ ] After join resolves, set `context.set("parallel.winner_index", ...)` for `first_success`, and `context.set("parallel.quorum_reached", ...)` for `quorum`

- [ ] Task 4: Update barrel export in `packages/factory/src/handlers/index.ts` (AC: #6)
  - [ ] Add re-export of `JoinPolicy`, `JoinPolicyConfig`, `BranchResult`, `JoinDecision`, `evaluateJoinPolicy`, `BranchCancellationManager` from `./join-policy.js`
  - [ ] Verify no circular imports (join-policy.ts must not import from parallel.ts or registry.ts)

- [ ] Task 5: Write unit tests in `packages/factory/src/handlers/__tests__/join-policy.test.ts` (AC: #7)
  - [ ] **wait_all tests (4 cases):** all SUCCESS → `action: 'continue'`; mixed SUCCESS+FAIL → `action: 'continue'` when all complete; 2 of 3 complete → `action: 'wait'`; single branch completes → `action: 'continue'`
  - [ ] **first_success tests (5 cases):** first branch SUCCESS → `action: 'continue'` immediately; second branch SUCCESS (first failed) → `action: 'continue'`; all branches FAIL → `action: 'fail'` with reason; all branches CANCELLED → `action: 'fail'`; all complete, none SUCCESS → `action: 'fail'`
  - [ ] **quorum tests (5 cases):** exactly quorum_size succeed → `action: 'continue'`; more than quorum_size succeed → `action: 'continue'`; quorum_size=2, only 1 success but more remaining → `action: 'wait'`; quorum unreachable (failed > total−quorum_size) → `action: 'fail'` with descriptive reason; quorum_size=0 guard → `action: 'fail'` or throw
  - [ ] **BranchCancellationManager tests (4 cases):** `getSignal` returns an AbortSignal; signal is not aborted before `cancelRemaining`; after `cancelRemaining`, signal for cancelled branch is aborted; signal for completed branch is NOT aborted
  - [ ] **Edge case tests (2 cases):** `evaluateJoinPolicy` with `total=1`, `first_success`, branch succeeds → `action: 'continue'`; `wait_all` with 0 completed and `total=0` → `action: 'continue'` (vacuous)
  - [ ] Ensure at least 20 `it(...)` cases total
  - [ ] Run `npm run build` first; then run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output

- [ ] Task 6: Write integration tests in `packages/factory/src/handlers/__tests__/parallel-join.test.ts` (AC: #1, #2, #3, #4, #5)
  - [ ] Mock the branch execution function to return controlled outcomes with configurable delays
  - [ ] **AC1 integration test:** `wait_all` with 3 branches (2 SUCCESS, 1 FAIL) → results has 3 entries; context has `parallel.results`
  - [ ] **AC2 integration test:** `first_success` with branch-0 returning SUCCESS after 10 ms and branches 1-2 taking 500 ms → resolves before 200 ms; `parallel.winner_index === 0`; context has CANCELLED entries for branches 1-2
  - [ ] **AC3 integration test:** `quorum` with `quorum_size=2` and 4 branches → resolves after 2 successes; `parallel.quorum_reached === 2`; 2 remaining branches marked CANCELLED
  - [ ] **AC5 integration test:** `quorum` with `quorum_size=3` and 3 branches all failing → context has `parallel.join_error` containing "quorum unreachable"

- [ ] Task 7: Run build and tests to confirm zero errors (AC: #6, #7)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] Verify no test output is piped through `grep`, `head`, `tail`, or any other filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { evaluateJoinPolicy } from './join-policy.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `join-policy.ts` must have **zero external package imports** — only TypeScript types, no Node builtins, no Zod, no third-party libs; it is a pure algorithmic module
- `BranchCancellationManager` may use the Node/browser built-in `AbortController` (globally available in Node 18+); no import needed
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Story 50-3 extends `packages/factory/src/handlers/parallel.ts` which is created by Story 50-1; the dev agent must verify that `parallel.ts` exists and understand its branch execution loop before extending it
- Do NOT modify `packages/factory/src/graph/executor.ts` — join policy is entirely internal to the parallel handler
- `AbortSignal` should be passed through the branch execution context as an optional abort hook; if the branch implementation does not check it, cancellation is best-effort (drain timeout applies)

### New File Paths
```
packages/factory/src/handlers/join-policy.ts                          — JoinPolicy, BranchResult, JoinPolicyConfig, JoinDecision, evaluateJoinPolicy, BranchCancellationManager
packages/factory/src/handlers/__tests__/join-policy.test.ts           — unit tests for evaluateJoinPolicy and BranchCancellationManager (≥20 test cases)
packages/factory/src/handlers/__tests__/parallel-join.test.ts         — integration tests wiring parallel.ts with join policies (≥4 test cases)
```

### Files Modified
```
packages/factory/src/handlers/parallel.ts   — extend with join policy wiring (created by Story 50-1)
packages/factory/src/handlers/index.ts      — add join-policy.ts re-exports
```

### Key Type Definitions

```typescript
// packages/factory/src/handlers/join-policy.ts

export type JoinPolicy = 'wait_all' | 'first_success' | 'quorum'

export interface BranchResult {
  index: number
  outcome: 'SUCCESS' | 'FAIL' | 'CANCELLED'
  contextSnapshot?: Record<string, unknown>
  error?: string
}

export interface JoinPolicyConfig {
  policy: JoinPolicy
  quorum_size?: number           // required when policy === 'quorum'
  cancel_drain_timeout_ms?: number  // default 5000
}

export type JoinDecision =
  | { action: 'continue'; results: BranchResult[] }
  | { action: 'wait' }
  | { action: 'fail'; reason: string }

export function evaluateJoinPolicy(
  config: JoinPolicyConfig,
  completed: BranchResult[],
  total: number,
): JoinDecision {
  const successes = completed.filter(r => r.outcome === 'SUCCESS')
  const failures  = completed.filter(r => r.outcome === 'FAIL')

  switch (config.policy) {
    case 'wait_all': {
      if (completed.length < total) return { action: 'wait' }
      return { action: 'continue', results: completed }
    }
    case 'first_success': {
      if (successes.length >= 1) return { action: 'continue', results: completed }
      if (failures.length === total) return { action: 'fail', reason: `first_success: all ${total} branches failed` }
      return { action: 'wait' }
    }
    case 'quorum': {
      const needed = config.quorum_size ?? 1
      if (needed <= 0) return { action: 'fail', reason: 'quorum_size must be >= 1' }
      if (successes.length >= needed) return { action: 'continue', results: completed }
      const remaining = total - completed.length
      if (successes.length + remaining < needed) {
        return {
          action: 'fail',
          reason: `quorum unreachable: ${successes.length} succeeded, ${failures.length} failed, needed ${needed} of ${total}`,
        }
      }
      return { action: 'wait' }
    }
  }
}

export class BranchCancellationManager {
  private controllers: AbortController[]

  constructor(branchCount: number) {
    this.controllers = Array.from({ length: branchCount }, () => new AbortController())
  }

  getSignal(index: number): AbortSignal {
    return this.controllers[index].signal
  }

  cancelRemaining(completedIndices: Set<number>): void {
    this.controllers.forEach((ctrl, i) => {
      if (!completedIndices.has(i)) ctrl.abort()
    })
  }

  async drainAsync(timeoutMs: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
  }
}
```

### Test Pattern

```typescript
// packages/factory/src/handlers/__tests__/join-policy.test.ts
import { describe, it, expect } from 'vitest'
import {
  evaluateJoinPolicy,
  BranchCancellationManager,
} from '../join-policy.js'
import type { BranchResult, JoinPolicyConfig } from '../join-policy.js'

const success = (index: number): BranchResult => ({ index, outcome: 'SUCCESS' })
const fail    = (index: number): BranchResult => ({ index, outcome: 'FAIL' })

describe('evaluateJoinPolicy — wait_all', () => {
  it('returns wait when not all branches complete', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    expect(evaluateJoinPolicy(cfg, [success(0)], 3)).toEqual({ action: 'wait' })
  })

  it('returns continue when all branches complete (all success)', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [success(0), success(1), success(2)], 3)
    expect(result.action).toBe('continue')
  })

  it('returns continue when all branches complete (mixed)', () => {
    const cfg: JoinPolicyConfig = { policy: 'wait_all' }
    const result = evaluateJoinPolicy(cfg, [success(0), fail(1), success(2)], 3)
    expect(result.action).toBe('continue')
    if (result.action === 'continue') expect(result.results).toHaveLength(3)
  })
})

describe('evaluateJoinPolicy — first_success', () => {
  it('returns continue immediately on first SUCCESS', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [success(0)], 3)
    expect(result.action).toBe('continue')
  })

  it('returns fail when all branches fail', () => {
    const cfg: JoinPolicyConfig = { policy: 'first_success' }
    const result = evaluateJoinPolicy(cfg, [fail(0), fail(1), fail(2)], 3)
    expect(result.action).toBe('fail')
    if (result.action === 'fail') expect(result.reason).toMatch(/all 3 branches failed/)
  })
})

describe('BranchCancellationManager', () => {
  it('getSignal returns an AbortSignal that is not yet aborted', () => {
    const mgr = new BranchCancellationManager(3)
    expect(mgr.getSignal(0).aborted).toBe(false)
  })

  it('cancelRemaining aborts signals for non-completed branches', () => {
    const mgr = new BranchCancellationManager(3)
    mgr.cancelRemaining(new Set([0]))
    expect(mgr.getSignal(0).aborted).toBe(false)  // completed, not cancelled
    expect(mgr.getSignal(1).aborted).toBe(true)
    expect(mgr.getSignal(2).aborted).toBe(true)
  })
})
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- `evaluateJoinPolicy` is a pure function — no mocks needed for unit tests
- Integration tests in `parallel-join.test.ts` mock the branch executor via `vi.fn()` returning controlled Promises with delays
- Run tests with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output
- Also run `npm run build` before tests to catch TypeScript compilation errors early
- Minimum 20 `it(...)` cases in `join-policy.test.ts` required

## Interface Contracts

- **Export**: `JoinPolicy` @ `packages/factory/src/handlers/join-policy.ts` (consumed by stories 50-1 extension, 50-11)
- **Export**: `BranchResult` @ `packages/factory/src/handlers/join-policy.ts` (consumed by stories 50-2, 50-11)
- **Export**: `JoinPolicyConfig` @ `packages/factory/src/handlers/join-policy.ts` (consumed by story 50-11)
- **Export**: `JoinDecision` @ `packages/factory/src/handlers/join-policy.ts` (consumed by story 50-11)
- **Export**: `evaluateJoinPolicy` @ `packages/factory/src/handlers/join-policy.ts` (consumed by `parallel.ts`, story 50-11)
- **Export**: `BranchCancellationManager` @ `packages/factory/src/handlers/join-policy.ts` (consumed by `parallel.ts`, story 50-11)
- **Import**: `parallel.ts` handler context/branch loop @ `packages/factory/src/handlers/parallel.ts` (from story 50-1)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
