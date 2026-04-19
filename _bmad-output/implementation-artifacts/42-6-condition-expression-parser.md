# Story 42-6: Condition Expression Parser

## Story

As a graph engine developer,
I want an edge condition expression parser and evaluator,
so that the executor can determine which outgoing edges are eligible for traversal based on the current node output and context.

## Acceptance Criteria

### AC1: Equality Condition Evaluates True
**Given** condition `outcome=success`
**When** evaluated against context `{ outcome: "success" }`
**Then** `evaluateCondition` returns `true`

### AC2: Inequality Condition Evaluates True
**Given** condition `outcome!=fail`
**When** evaluated against context `{ outcome: "success" }`
**Then** `evaluateCondition` returns `true`

### AC3: Conjunction (&&) Evaluates All Clauses
**Given** condition `outcome=success && iteration!=0`
**When** evaluated against context `{ outcome: "success", iteration: "1" }`
**Then** `evaluateCondition` returns `true`; if either clause fails, returns `false`

### AC4: Missing Context Key Resolves to Empty String
**Given** condition `missing_key=value`
**When** evaluated against a context that does not contain `missing_key`
**Then** `missing_key` resolves to `""` (empty string) and the condition returns `false`

### AC5: Invalid Condition Syntax Throws Parse Error
**Given** an invalid condition string (e.g., `outcome==success` with double equals, or an empty clause)
**When** `parseCondition` is called with that string
**Then** it throws a `ConditionParseError` with a descriptive message indicating the invalid syntax

### AC6: Comparison Is Case-Sensitive
**Given** condition `outcome=success`
**When** evaluated against context `{ outcome: "Success" }` (capital S)
**Then** `evaluateCondition` returns `false`

### AC7: condition_syntax Validator Rule Uses Real Parser
**Given** the `condition_syntax` error rule implemented (regex-based) in story 42-4
**When** story 42-6 is complete
**Then** `rules/error-rules.ts` is updated to call `parseCondition` instead of the regex, and all existing validator tests still pass

## Tasks / Subtasks

- [ ] Task 1: Define types and document grammar (AC: #1, #2, #3, #5)
  - [ ] Define `ConditionClause` interface: `{ key: string; op: '=' | '!='; value: string }`
  - [ ] Define `ParsedCondition` as `ConditionClause[]` (conjunction of clauses)
  - [ ] Define `ConditionParseError` extends `Error` for invalid syntax
  - [ ] Add types to `packages/factory/src/graph/types.ts`
  - [ ] Document grammar in JSDoc: `condition := clause ('&&' clause)*; clause := key ('=' | '!=') value`

- [ ] Task 2: Implement `parseCondition` (AC: #1, #2, #3, #5)
  - [ ] Implement `parseCondition(conditionStr: string): ParsedCondition` in `packages/factory/src/graph/condition-parser.ts`
  - [ ] Split on `&&`, trim each clause, parse into key/op/value triples
  - [ ] Detect `==` (double equals) and other invalid operators; throw `ConditionParseError`
  - [ ] Reject empty condition string or clause; throw `ConditionParseError`
  - [ ] Support unquoted and quoted (single or double) values; strip surrounding quotes

- [ ] Task 3: Implement `evaluateCondition` (AC: #1, #2, #3, #4, #6)
  - [ ] Implement `evaluateCondition(conditionStr: string, context: Record<string, unknown>): boolean`
  - [ ] Call `parseCondition` internally; propagate `ConditionParseError` on bad syntax
  - [ ] Look up each clause key in context; coerce value to string; default to `""` if absent
  - [ ] Perform case-sensitive string comparison for `=` and `!=`
  - [ ] Return `true` only if every clause in the conjunction passes

- [ ] Task 4: Update `condition_syntax` validator rule to use real parser (AC: #7)
  - [ ] In `packages/factory/src/graph/rules/error-rules.ts`, replace the regex-based condition check with a call to `parseCondition`
  - [ ] Catch `ConditionParseError` and emit a `ValidationDiagnostic` with `ruleId: 'condition_syntax'`, `severity: 'error'`
  - [ ] Verify all existing tests in `validator-errors.test.ts` still pass without modification

- [ ] Task 5: Write unit tests (AC: #1–#7)
  - [ ] Create `packages/factory/src/graph/__tests__/condition-parser.test.ts`
  - [ ] Test all AC scenarios: equality, inequality, conjunction, missing key, invalid syntax, case-sensitivity
  - [ ] Test edge cases: empty string condition, whitespace-only clause, quoted values, numeric-string values
  - [ ] Test that `condition_syntax` validator rule rejects `outcome==success` via `createValidator().validate(graph)`

## Dev Notes

### Architecture Constraints
- **File paths:**
  - `packages/factory/src/graph/condition-parser.ts` — new file, exports `parseCondition`, `evaluateCondition`, `ConditionParseError`
  - `packages/factory/src/graph/types.ts` — add `ConditionClause`, `ParsedCondition`
  - `packages/factory/src/graph/rules/error-rules.ts` — update `condition_syntax` rule (from 42-4)
  - `packages/factory/src/graph/__tests__/condition-parser.test.ts` — new test file
- **Import style:** ESM with `.js` extensions for all relative imports (e.g., `import { parseCondition } from './condition-parser.js'`)
- **No circular deps:** `condition-parser.ts` must not import from `validator.ts` or `executor.ts`
- **No external parser library:** implement a simple hand-written tokenizer; the grammar is intentionally minimal

### Grammar Reference (Attractor Spec §10)
```
condition  ::= clause ('&&' clause)*
clause     ::= key op value
key        ::= [a-zA-Z_][a-zA-Z0-9_]*
op         ::= '=' | '!='
value      ::= quoted_string | unquoted_token
quoted_string  ::= '"' [^"]* '"' | "'" [^']* "'"
unquoted_token ::= [^\s&&]+
```

- All comparisons are **case-sensitive**
- Missing context keys resolve to `""` (empty string)
- Whitespace around `&&`, keys, ops, and values is trimmed
- Only `&&` conjunction is supported; `||` is out of scope

### Context Compatibility
- `evaluateCondition` accepts `Record<string, unknown>` so it is usable before `GraphContext` (42-8) is implemented
- When `GraphContext` is available (42-8+), callers pass `context.snapshot()` to `evaluateCondition`
- Coerce all context values to string via `String(value)` before comparing

### Testing Requirements
- Test framework: Vitest (already configured in the monorepo)
- Run tests with: `npm run test:fast` (unit only, no e2e)
- All tests must pass before the story is considered done
- Aim for 100% branch coverage on `parseCondition` and `evaluateCondition`

## Interface Contracts

- **Export**: `ConditionClause` @ `packages/factory/src/graph/types.ts`
- **Export**: `ParsedCondition` @ `packages/factory/src/graph/types.ts`
- **Export**: `ConditionParseError` @ `packages/factory/src/graph/condition-parser.ts`
- **Export**: `parseCondition` @ `packages/factory/src/graph/condition-parser.ts` (consumed by validator `condition_syntax` rule; consumed by edge selector in 42-13)
- **Export**: `evaluateCondition` @ `packages/factory/src/graph/condition-parser.ts` (consumed by edge selector in 42-13)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
