# Counter — Epics (hardening-program fixture corpus)

## Epic 1: Counter API

### Story 1.1: Add decrement function

**Acceptance Criteria:**

1. `decrement(n)` exists in `src/counter.mjs` and returns `n - 1`.
2. A node:test case covers `decrement(2) === 1`.
3. Existing `increment` behavior unchanged.

### Story 1.2: Add reset function (verification-trip fixture)

**Acceptance Criteria:**

1. `reset()` returns 0.
2. A node:test case covers it.
