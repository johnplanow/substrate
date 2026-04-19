# Story 42-5: Graph Validator — Warning Rules (5 Rules) and Custom Rules

## Story

As a graph engine consumer,
I want a `GraphValidator` that checks a parsed `Graph` against the 5 warning-severity Attractor lint rules and exposes a `registerRule()` extension point for custom rules,
so that questionable graphs produce actionable warnings without blocking execution.

## Acceptance Criteria

### AC1: `type_known` Warning Rule
**Given** a graph node whose `type` attribute is non-empty and is not one of the known handler types (`codergen`, `tool`, `wait.human`, `conditional`, `start`, `exit`)
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "type_known"`, `severity: "warning"`, `nodeId` set to the offending node's id, and a descriptive message listing the unrecognised type.

### AC2: `fidelity_valid` Warning Rule
**Given** a graph node whose `fidelity` attribute is non-empty and is not one of the valid fidelity modes (`high`, `medium`, `low`, `draft`)
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "fidelity_valid"`, `severity: "warning"`, `nodeId` set to the offending node's id, and a message identifying the invalid value.

### AC3: `retry_target_exists` Warning Rule
**Given** a graph where a node's `retryTarget` or `fallbackRetryTarget` is non-empty but does not match any key in `graph.nodes`, OR the graph-level `retryTarget` or `fallbackRetryTarget` is non-empty but does not match any key in `graph.nodes`
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "retry_target_exists"`, `severity: "warning"`, and a message identifying the missing target node id.

### AC4: `goal_gate_has_retry` Warning Rule
**Given** a graph node with `goalGate: true` but an empty `retryTarget` (both node-level and no graph-level default)
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "goal_gate_has_retry"`, `severity: "warning"`, `nodeId` set to the offending node's id, and a message indicating a goal gate node requires a retry target.

### AC5: `prompt_on_llm_nodes` Warning Rule
**Given** a graph node with `shape: "box"` or `type: "codergen"` that has both an empty `prompt` and an empty `label`
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "prompt_on_llm_nodes"`, `severity: "warning"`, `nodeId` set to the offending node's id, and a message indicating that codergen nodes should have a prompt or label.

### AC6: Custom Rule Registration via `registerRule()`
**Given** a custom `LintRule` registered on a validator instance via `validator.registerRule(customRule)`
**When** `validate(graph)` is called
**Then** the custom rule's `check()` method is invoked and its `ValidationDiagnostic[]` results are appended to the validator output alongside all built-in rule results.

### AC7: Warnings Do Not Block Execution
**Given** a `Graph` that produces one or more warning-severity diagnostics and zero error-severity diagnostics from `validate()`
**When** `validateOrRaise(graph)` is called
**Then** it does NOT throw (returns `undefined`), confirming warnings are non-blocking.

### AC8: All Unit Tests Pass
**Given** the warning-rules implementation after this story
**When** `npm run test:fast` is run from the repo root
**Then** the output contains the "Test Files" summary line, all new warning-rule tests pass, and no previously passing tests regress. [PRD: GE-V2]

## Tasks / Subtasks

- [ ] Task 1: Read existing validator and type definitions (AC: #1–#7)
  - [ ] Read `packages/factory/src/graph/types.ts` in full — confirm `ValidationDiagnostic`, `LintRule`, `GraphValidator`, `GraphNode` (particularly `type`, `fidelity`, `goalGate`, `retryTarget`, `fallbackRetryTarget`, `prompt`, `label`, `shape` fields), and `Graph` (particularly `retryTarget`, `fallbackRetryTarget`)
  - [ ] Read `packages/factory/src/graph/validator.ts` — understand `createValidator()` structure and how `errorRules` are registered; `registerRule()` is already present
  - [ ] Read `packages/factory/src/graph/rules/error-rules.ts` — follow the same `LintRule` implementation pattern for warning rules
  - [ ] Read `packages/factory/src/graph/__tests__/validator-errors.test.ts` — adopt the same vitest import style, fixture construction patterns, and test naming conventions

- [ ] Task 2: Implement `type_known` and `fidelity_valid` warning rules (AC: #1, #2)
  - [ ] Create `packages/factory/src/graph/rules/warning-rules.ts`
  - [ ] Define `KNOWN_HANDLER_TYPES = new Set(['codergen', 'tool', 'wait.human', 'conditional', 'start', 'exit'])` — empty string is valid (means "use shape-based default")
  - [ ] `type_known`: iterate `graph.nodes.values()`; for each node where `node.type !== ''` and `!KNOWN_HANDLER_TYPES.has(node.type)`, emit `ValidationDiagnostic` with `ruleId: 'type_known'`, `severity: 'warning'`, `nodeId: node.id`
  - [ ] Define `VALID_FIDELITY_VALUES = new Set(['high', 'medium', 'low', 'draft'])` — empty string is valid (means "use graph default")
  - [ ] `fidelity_valid`: iterate `graph.nodes.values()`; for each node where `node.fidelity !== ''` and `!VALID_FIDELITY_VALUES.has(node.fidelity)`, emit `ValidationDiagnostic` with `ruleId: 'fidelity_valid'`, `severity: 'warning'`, `nodeId: node.id`

- [ ] Task 3: Implement `retry_target_exists` warning rule (AC: #3)
  - [ ] In `warning-rules.ts`, implement `retry_target_exists`:
    - For each node in `graph.nodes.values()`: if `node.retryTarget !== ''` and `!graph.nodes.has(node.retryTarget)`, emit warning with message `"Node '${nodeId}' retryTarget '${node.retryTarget}' does not exist"`
    - If `node.fallbackRetryTarget !== ''` and `!graph.nodes.has(node.fallbackRetryTarget)`, emit warning with message `"Node '${nodeId}' fallbackRetryTarget '${node.fallbackRetryTarget}' does not exist"`
    - If `graph.retryTarget !== ''` and `!graph.nodes.has(graph.retryTarget)`, emit a single warning with message `"Graph-level retryTarget '${graph.retryTarget}' does not exist"`
    - If `graph.fallbackRetryTarget !== ''` and `!graph.nodes.has(graph.fallbackRetryTarget)`, emit a single warning with message `"Graph-level fallbackRetryTarget '${graph.fallbackRetryTarget}' does not exist"`
  - [ ] All diagnostics for this rule use `ruleId: 'retry_target_exists'` and `severity: 'warning'`

- [ ] Task 4: Implement `goal_gate_has_retry` and `prompt_on_llm_nodes` warning rules (AC: #4, #5)
  - [ ] `goal_gate_has_retry`: iterate `graph.nodes.values()`; for each node where `node.goalGate === true` AND `node.retryTarget === ''` AND `graph.retryTarget === ''`, emit `ValidationDiagnostic` with `ruleId: 'goal_gate_has_retry'`, `severity: 'warning'`, `nodeId: node.id`, message `"Node '${node.id}' has goal_gate=true but no retryTarget is set (node-level or graph-level default)"`
  - [ ] `prompt_on_llm_nodes`: iterate `graph.nodes.values()`; for each node where (`node.shape === 'box'` OR `node.type === 'codergen'`) AND `node.prompt === ''` AND `node.label === ''`, emit `ValidationDiagnostic` with `ruleId: 'prompt_on_llm_nodes'`, `severity: 'warning'`, `nodeId: node.id`, message `"Codergen node '${node.id}' has no prompt or label"`
  - [ ] Export `warningRules: LintRule[]` array from `warning-rules.ts` containing all 5 rules in order

- [ ] Task 5: Register warning rules in `createValidator()` (AC: #1–#5)
  - [ ] In `packages/factory/src/graph/validator.ts`, add `import { warningRules } from './rules/warning-rules.js'`
  - [ ] In `createValidator()`, initialise the rules array with both error and warning rules: `const rules: LintRule[] = [...errorRules, ...warningRules]`
  - [ ] The existing `registerRule()` implementation already supports custom rules — verify no changes needed there (AC: #6)

- [ ] Task 6: Write unit tests (AC: #1–#8)
  - [ ] Create `packages/factory/src/graph/__tests__/validator-warnings.test.ts`
  - [ ] Build a minimal valid graph helper (`makeValidGraph()`) that passes all 8 error rules — use the pattern from `validator-errors.test.ts`
  - [ ] Test `type_known`: (a) node with `type: ''` → no warning; (b) node with `type: 'codergen'` → no warning; (c) node with `type: 'unknown_handler'` → 1 warning with correct `ruleId` and `nodeId`
  - [ ] Test `fidelity_valid`: (a) node with `fidelity: ''` → no warning; (b) node with `fidelity: 'high'` → no warning; (c) node with `fidelity: 'ultra'` → 1 warning with correct `ruleId` and `nodeId`
  - [ ] Test `retry_target_exists`: (a) node `retryTarget: ''` → no warning; (b) node `retryTarget: 'existing_node'` → no warning; (c) node `retryTarget: 'ghost_node'` → 1 warning; (d) `graph.retryTarget: 'ghost_node'` → 1 warning
  - [ ] Test `goal_gate_has_retry`: (a) `goalGate: false` → no warning; (b) `goalGate: true` with `retryTarget: 'some_node'` → no warning; (c) `goalGate: true`, `retryTarget: ''`, no graph-level default → 1 warning; (d) `goalGate: true`, `retryTarget: ''`, graph-level default set → no warning
  - [ ] Test `prompt_on_llm_nodes`: (a) `shape: 'box'`, `prompt: 'do something'` → no warning; (b) `shape: 'box'`, `label: 'My Task'` → no warning; (c) `shape: 'box'`, both empty → 1 warning; (d) `shape: 'diamond'` (non-codergen) with both empty → no warning
  - [ ] Test custom rule via `registerRule()`: create a `LintRule` stub that always returns one fixed diagnostic; register it; call `validate()`; confirm the stub diagnostic appears in the results alongside built-in diagnostics
  - [ ] Test `validateOrRaise()` with warnings only: graph triggers at least one warning but no errors → `validateOrRaise()` returns `undefined` (does not throw)

- [ ] Task 7: Build verification and test run (AC: #8)
  - [ ] Verify no vitest instance is running: `pgrep -f vitest` returns nothing
  - [ ] Run `npm run build` from the repo root and confirm exit code 0 and zero TypeScript errors
  - [ ] Run `npm run test:fast` from the repo root (timeout: 300000ms, foreground, do NOT pipe output)
  - [ ] Confirm output contains "Test Files" summary line and all new tests pass with zero failures

## Dev Notes

### Architecture Constraints
- **Target files (new)**:
  - `packages/factory/src/graph/rules/warning-rules.ts` — all 5 `LintRule` implementations
  - `packages/factory/src/graph/__tests__/validator-warnings.test.ts` — unit tests for this story
- **Target files (modified)**:
  - `packages/factory/src/graph/validator.ts` — import and register `warningRules` in `createValidator()`
- **ESM `.js` extensions**: all intra-package imports in `packages/factory/src/` must use `.js` extensions (TypeScript resolves to `.ts` at compile time via `moduleResolution: "NodeNext"`)
- **No imports from monolith `src/`** — `packages/factory` must be self-contained; only import from `@substrate-ai/core`, `@substrate-ai/sdlc`, Node built-ins, or local package paths
- **Do NOT implement error rules** — those are complete in story 42-4; only the 5 warning rules listed above are in scope
- **`registerRule()` is already implemented** in `createValidator()` (story 42-4) — no changes needed to that method signature or implementation

### Known Handler Types
```typescript
// The complete set of known handler types for the type_known rule:
const KNOWN_HANDLER_TYPES = new Set([
  'codergen',     // AI-assisted code generation (default for shape=box)
  'tool',         // Shell command execution (story 42-11)
  'wait.human',   // Human gate / accelerator key (story 42-11)
  'conditional',  // Routing only — no side effects (story 42-9)
  'start',        // Trivial start handler (story 42-9)
  'exit',         // Trivial exit handler (story 42-9)
])
// Empty string '' is always valid — means "resolve via shape or use default"
```

### Valid Fidelity Values
```typescript
// The complete set of valid fidelity values for the fidelity_valid rule:
const VALID_FIDELITY_VALUES = new Set(['high', 'medium', 'low', 'draft'])
// Empty string '' is always valid — means "use graph default"
// Matches FidelityMode type from types.ts
```

### `goal_gate_has_retry` — Graph-Level Default Handling
```typescript
// A node with goalGate=true is considered "safe" if EITHER:
//   1. node.retryTarget is non-empty, OR
//   2. graph.retryTarget is non-empty (graph-level default applies)
// Only emit a warning if BOTH are empty.
if (node.goalGate && node.retryTarget === '' && graph.retryTarget === '') {
  // emit warning
}
```

### `prompt_on_llm_nodes` — Codergen Node Detection
```typescript
// A node is considered a codergen node for this rule if:
//   node.shape === 'box'  OR  node.type === 'codergen'
// The warning fires only when BOTH node.prompt and node.label are empty strings.
const isCodergen = node.shape === 'box' || node.type === 'codergen'
if (isCodergen && node.prompt === '' && node.label === '') {
  // emit warning
}
```

### `createValidator()` after this story
```typescript
import { errorRules } from './rules/error-rules.js'
import { warningRules } from './rules/warning-rules.js'

export function createValidator(): GraphValidator {
  const rules: LintRule[] = [...errorRules, ...warningRules]
  // ... rest unchanged
}
```

### Testing Requirements
- Use `vitest` (already configured in the repo)
- Test file: `packages/factory/src/graph/__tests__/validator-warnings.test.ts`
- Do NOT run tests concurrently — verify `pgrep -f vitest` returns nothing before running
- Run `npm run test:fast` from the **repo root** (not inside `packages/factory/`) — tests are discovered across the monorepo
- Do NOT pipe test output through `head`, `grep`, `tail`, or any command — must see the "Test Files" summary line
- Build a `makeValidGraph()` helper that creates a minimal graph satisfying all 8 error rules (one start node, one exit node, all reachable, valid conditions, etc.) — then mutate copies of it per test to trigger individual warnings
- Minimum test coverage for this story:
  - 3 tests per semantic rule (happy paths + violation): `type_known`, `fidelity_valid`, `fidelity_valid`
  - 4 tests for `retry_target_exists` (node retryTarget, node fallbackRetryTarget, graph retryTarget — missing)
  - 4 tests for `goal_gate_has_retry` (false, node target set, graph target set, both empty → warning)
  - 4 tests for `prompt_on_llm_nodes` (prompt present, label present, both missing → warning, non-codergen shape → no warning)
  - 1 test for custom rule via `registerRule()`
  - 1 test for `validateOrRaise()` warnings-only → no throw

### Key Files to Read Before Starting
- `packages/factory/src/graph/types.ts` — `ValidationDiagnostic`, `LintRule`, `GraphValidator`, `GraphNode`, `Graph`
- `packages/factory/src/graph/validator.ts` — `createValidator()` implementation (story 42-4)
- `packages/factory/src/graph/rules/error-rules.ts` — follow the same rule implementation pattern
- `packages/factory/src/graph/__tests__/validator-errors.test.ts` — adopt vitest import style and fixture patterns

## Interface Contracts

- **Import**: `ValidationDiagnostic`, `LintRule`, `Graph`, `GraphNode` @ `packages/factory/src/graph/types.ts` (from story 42-4)
- **Import**: `errorRules` @ `packages/factory/src/graph/rules/error-rules.ts` (from story 42-4)
- **Export**: `warningRules` @ `packages/factory/src/graph/rules/warning-rules.ts` (consumed by `validator.ts` and story 42-15 integration tests)
- **Modifies**: `createValidator()` @ `packages/factory/src/graph/validator.ts` — adds warning rules to the default rule set; `registerRule()` contract unchanged

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 42 (Graph Engine Foundation — Parser, Validator, Executor, Handlers)
