# Epic 78: Operational polish

Small, self-contained operational fixes surfaced during Epic 77 dogfooding. Each
story is intentionally trivial — single-file, single-behavior — so it ships in one
dev-story dispatch.

## Story Map

- 78-1: Fix substrate report recovery-attempts count for zero review cycles (P1, Small)

---

## Story 78-1: Fix `substrate report` recovery-attempts count for zero review cycles

**Priority**: must · **Dispatch eligibility**: dispatchable.

**Description**: In `src/cli/commands/report.ts`, the escalation enrichment computes
`recovery_attempts` as:

```ts
const recovery_attempts =
  state.review_cycles ??
  (manifest.recovery_history ?? []).filter((e) => e.story_key === storyKey).length
```

The `??` (nullish coalescing) operator only falls through on `null`/`undefined` — NOT
on `0`. So when a story escalated with `review_cycles === 0` but DID accrue
`recovery_history` entries (e.g. a dev-story checkpoint-retry-timeout, which records a
recovery entry but no review cycles), the report displays `Recovery attempts: 0` and a
blast-radius line saying "0 recovery attempt(s)" — even though recovery actually ran.
This was observed on run `770fe858` (1 recovery_history entry, displayed as 0).

**Acceptance Criteria:**

1. `recovery_attempts` reflects actual recovery activity when `review_cycles` is 0:
   it must be at least the count of `recovery_history` entries for the story. Compute
   it as the maximum of `review_cycles` (when present) and the per-story
   `recovery_history` entry count — so neither signal is masked by the other.
2. When `review_cycles` is `undefined`/absent, the recovery_history count is still used
   (preserve the existing fallback behavior).
3. When both are 0/absent, `recovery_attempts` is 0 (unchanged).
4. The `blast_radius` string reflects the corrected count.
5. Unit test covering: (a) review_cycles=0 + 2 recovery_history entries → 2;
   (b) review_cycles=3 + 0 recovery_history → 3; (c) review_cycles=1 + 2
   recovery_history → 2; (d) both absent → 0.

## Runtime Probes

```yaml
- name: report-recovery-count-unit-test
  sandbox: host
  command: npx vitest run src/cli/commands/__tests__/report.test.ts 2>&1
  expect_stdout_regex:
    - 'Test Files.*passed'
  description: the report recovery-attempts unit tests pass
```
