# Adder — Epics (hardening-program fixture corpus)

## Epic 1: Arithmetic API

### Story 1.1: Add Sub function

**Acceptance Criteria:**

1. `Sub(a, b int) int` exists in `adder.go` and returns `a - b`.
2. A Go test covers `Sub(3, 1) == 2`.
3. Existing `Add` behavior unchanged.

### Story 1.2: Add Mul function (verification-trip fixture)

**Acceptance Criteria:**

1. `Mul(a, b int) int` returns the product.
2. A Go test covers it.
