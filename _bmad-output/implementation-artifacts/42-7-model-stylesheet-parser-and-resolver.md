# Story 42-7: Model Stylesheet Parser and Resolver

## Story

As a graph engine consumer,
I want a CSS-like stylesheet parser and specificity-based resolver for the `model_stylesheet` graph attribute,
so that LLM model routing properties (`llm_model`, `llm_provider`, `reasoning_effort`) can be declared once at the graph level and applied to matching nodes without annotating every node individually.

## Acceptance Criteria

### AC1: Universal Selector Applies to All Nodes
**Given** a stylesheet `* { llm_model: claude-sonnet-4-5; llm_provider: anthropic; }`
**When** `resolveNodeStyles(node, stylesheet)` is called for any node
**Then** the returned `ResolvedNodeStyles` has `llmModel: "claude-sonnet-4-5"` and `llmProvider: "anthropic"` for every node in the graph

### AC2: Shape Selector Matches Nodes by Shape
**Given** a stylesheet `box { llm_model: gpt-4o; }` and a node with `shape: "box"`
**When** `resolveNodeStyles(node, stylesheet)` is called
**Then** the returned `ResolvedNodeStyles` has `llmModel: "gpt-4o"` for that node; nodes with a different shape are not affected

### AC3: Class Selector Matches Nodes with a Matching Class Token
**Given** a stylesheet `.code { llm_model: claude-opus-4; }` and a node with `class: "code,critical"`
**When** `resolveNodeStyles(node, stylesheet)` is called
**Then** the returned `ResolvedNodeStyles` has `llmModel: "claude-opus-4"`; a node without the `code` class token is not affected

### AC4: ID Selector Matches Exactly One Node by Its ID
**Given** a stylesheet `#review_node { reasoning_effort: high; }` and a node with `id: "review_node"`
**When** `resolveNodeStyles(node, stylesheet)` is called
**Then** the returned `ResolvedNodeStyles` has `reasoningEffort: "high"` for that node only; all other nodes are unaffected

### AC5: Higher-Specificity Rule Wins; Equal-Specificity Later Rule Wins
**Given** a stylesheet with rules `* { llm_model: base; }` (specificity 0), `.code { llm_model: class-model; }` (specificity 2), and `#target { llm_model: id-model; }` (specificity 3) applied to a node with `id: "target"` and `class: "code"`
**When** `resolveNodeStyles(node, stylesheet)` is called
**Then** the returned `ResolvedNodeStyles` has `llmModel: "id-model"` (ID specificity 3 wins over class specificity 2 and universal specificity 0); when two rules share the same specificity, the rule appearing later in the stylesheet wins

### AC6: Explicit Node Attribute Overrides Stylesheet Resolution
**Given** a stylesheet `* { llm_model: claude-sonnet; }` and a node that has `llmModel: "gpt-4o"` explicitly set (non-empty)
**When** the caller checks the resolved styles and compares against the node's own attributes
**Then** `resolveNodeStyles` returns `llmModel: "claude-sonnet"` from the stylesheet, but callers MUST prefer the explicit node attribute — the resolver's returned value is only applied when the node attribute is the empty string `""`

### AC7: `parseStylesheet` Throws `StylesheetParseError` on Invalid Syntax
**Given** an invalid stylesheet string (e.g., missing closing brace, unknown property, malformed selector)
**When** `parseStylesheet(source)` is called
**Then** it throws a `StylesheetParseError` with a descriptive message identifying the syntax problem

### AC8: `stylesheet_syntax` Validator Rule Uses Real Parser
**Given** the `stylesheet_syntax` error rule implemented with a structural check in story 42-4
**When** story 42-7 is complete
**Then** `rules/error-rules.ts` is updated to call `parseStylesheet` instead of the structural check; existing validator tests for `stylesheet_syntax` still pass without modification

## Tasks / Subtasks

- [ ] Task 1: Define stylesheet types in `types.ts` (AC: #1–#5, #7)
  - [ ] Read `packages/factory/src/graph/types.ts` to understand existing type patterns and what is already defined
  - [ ] Add `StylesheetProperty` union type: `'llm_model' | 'llm_provider' | 'reasoning_effort'`
  - [ ] Add `StylesheetDeclaration` interface: `{ property: StylesheetProperty; value: string }`
  - [ ] Add `StylesheetSelectorType` union: `'universal' | 'shape' | 'class' | 'id'`
  - [ ] Add `StylesheetSelector` interface: `{ type: StylesheetSelectorType; value: string; specificity: 0 | 1 | 2 | 3 }`
  - [ ] Add `StylesheetRule` interface: `{ selector: StylesheetSelector; declarations: StylesheetDeclaration[] }`
  - [ ] Add `ParsedStylesheet` type alias: `StylesheetRule[]`
  - [ ] Add `ResolvedNodeStyles` interface: `{ llmModel?: string; llmProvider?: string; reasoningEffort?: string }` (all optional — only properties resolved from the stylesheet are present)
  - [ ] Export all new types from `packages/factory/src/graph/types.ts`

- [ ] Task 2: Implement `parseStylesheet` in `packages/factory/src/stylesheet/parser.ts` (AC: #1–#5, #7)
  - [ ] Create the directory `packages/factory/src/stylesheet/` if it does not exist
  - [ ] Create `packages/factory/src/stylesheet/parser.ts` exporting `parseStylesheet` and `StylesheetParseError`
  - [ ] Implement `StylesheetParseError` as a class extending `Error` with `name: 'StylesheetParseError'`
  - [ ] Parse the stylesheet source string by iterating `Selector { Declaration* }` blocks using a hand-written tokenizer (no external CSS parser):
    - Strip C-style `/* */` block comments and `//` line comments before parsing
    - Parse each block: identify the selector token, then parse semicolon-separated `property: value` pairs inside braces
    - Selector token `*` → `{ type: 'universal', value: '*', specificity: 0 }`
    - Selector starting with `#` → `{ type: 'id', value: idName, specificity: 3 }`
    - Selector starting with `.` → `{ type: 'class', value: className, specificity: 2 }`
    - Any other bare identifier → `{ type: 'shape', value: shapeName, specificity: 1 }`
  - [ ] Throw `StylesheetParseError` when: braces are unbalanced, a declaration has an unrecognised property (not in `StylesheetProperty`), or a `property: value` pair cannot be parsed
  - [ ] Return a `ParsedStylesheet` (array of `StylesheetRule`) preserving source order

- [ ] Task 3: Implement `resolveNodeStyles` in `packages/factory/src/stylesheet/resolver.ts` (AC: #1–#6)
  - [ ] Create `packages/factory/src/stylesheet/resolver.ts` exporting `resolveNodeStyles`
  - [ ] Implement `resolveNodeStyles(node: GraphNode, stylesheet: ParsedStylesheet): ResolvedNodeStyles`:
    - Filter rules to only those whose selector matches the node:
      - `universal`: always matches
      - `shape`: matches when `node.shape === selector.value`
      - `class`: matches when the node's `class` field, split on commas and trimmed, contains `selector.value`
      - `id`: matches when `node.id === selector.value`
    - Sort matching rules by `specificity` ascending, preserving source order among ties (i.e., stable sort)
    - Iterate the sorted list, letting each rule overwrite properties from the previous — the last rule at the highest specificity wins (equal specificity: later in stylesheet wins)
    - Return a `ResolvedNodeStyles` object containing only the properties resolved from matching rules
  - [ ] Resolver does NOT enforce the "explicit attribute wins" rule — that is the caller's responsibility (document clearly in JSDoc)

- [ ] Task 4: Update `stylesheet_syntax` error rule to use real parser (AC: #8)
  - [ ] Read `packages/factory/src/graph/rules/error-rules.ts` to find the `stylesheet_syntax` rule (implemented as a structural check in story 42-4)
  - [ ] Replace the structural brace-balance check with a call to `parseStylesheet(graph.modelStylesheet)` wrapped in a try/catch for `StylesheetParseError`
  - [ ] On `StylesheetParseError`, emit a `ValidationDiagnostic` with `ruleId: 'stylesheet_syntax'`, `severity: 'error'`, and `message` derived from the error
  - [ ] Verify the existing `validator-errors.test.ts` tests for `stylesheet_syntax` pass without modification; update only if the fixture stylesheet is now rejected by the stricter parser (fix the fixture, not the test expectation)

- [ ] Task 5: Write unit tests (AC: #1–#8)
  - [ ] Create `packages/factory/src/stylesheet/__tests__/stylesheet.test.ts`
  - [ ] Test `parseStylesheet`:
    - Single universal rule with two properties → correct `ParsedStylesheet`
    - Shape selector (`box { ... }`) → `type: 'shape'`, `specificity: 1`
    - Class selector (`.code { ... }`) → `type: 'class'`, `specificity: 2`
    - ID selector (`#node_id { ... }`) → `type: 'id'`, `specificity: 3`
    - Multiple rules in one stylesheet → all rules returned in source order
    - Quoted and unquoted values both parsed correctly
    - Missing closing brace → `StylesheetParseError` thrown
    - Unknown property (`font-size: 12px`) → `StylesheetParseError` thrown
  - [ ] Test `resolveNodeStyles`:
    - Universal rule only → all three properties resolved from the rule
    - Shape rule only: matching node gets properties; non-matching node gets empty `ResolvedNodeStyles`
    - Class rule only: node with matching class token gets properties; node without that class does not
    - ID rule only: node with matching id gets properties; all other nodes do not
    - ID rule + class rule on same node → ID's property value wins (specificity 3 > 2)
    - Two universal rules (`*`) → later rule's property value wins for overlapping properties
    - Node with `class: "a,b,c"` and rule `.b { ... }` → matches (space-trimmed token match)
  - [ ] Test `stylesheet_syntax` validator rule with an explicitly invalid stylesheet → emits `ruleId: 'stylesheet_syntax'` error diagnostic

- [ ] Task 6: Verify build and tests pass (AC: #1–#8)
  - [ ] Confirm no vitest instance is running: `pgrep -f vitest` returns nothing
  - [ ] Run `npm run test:fast` from the monorepo root (do not pipe output)
  - [ ] Verify output contains the "Test Files" summary line with zero failures
  - [ ] Run `npm run build` to confirm no TypeScript compilation errors

## Dev Notes

### Architecture Constraints
- **File paths** (new files):
  - `packages/factory/src/stylesheet/parser.ts` — exports `parseStylesheet`, `StylesheetParseError`
  - `packages/factory/src/stylesheet/resolver.ts` — exports `resolveNodeStyles`
  - `packages/factory/src/stylesheet/__tests__/stylesheet.test.ts` — test file
- **File paths** (extended):
  - `packages/factory/src/graph/types.ts` — add new stylesheet types (do not create a separate stylesheet-types.ts)
  - `packages/factory/src/graph/rules/error-rules.ts` — update `stylesheet_syntax` rule (do not replace any other rules)
- **Import style**: All relative intra-package imports must use ESM `.js` extensions: `import { GraphNode } from '../graph/types.js'`
- **No circular deps**: `stylesheet/parser.ts` and `stylesheet/resolver.ts` may import from `graph/types.ts` but must not import from `graph/validator.ts`, `graph/executor.ts`, or `graph/condition-parser.ts`
- **No external CSS parser**: Implement a hand-written tokenizer. The grammar is intentionally minimal — a full CSS parser library is out of scope and adds unnecessary dependency weight.
- **Test execution rules**: Never run tests concurrently; never pipe vitest output; confirm results by checking for "Test Files" summary line

### Grammar Reference (Attractor Spec §8.2)
```
Stylesheet    ::= Rule*
Rule          ::= Selector '{' Declaration ( ';' Declaration )* ';'? '}'
Selector      ::= '*' | ShapeName | '#' Identifier | '.' ClassName
ClassName     ::= [a-z0-9_-]+
ShapeName     ::= [a-zA-Z_][a-zA-Z0-9_]*
Identifier    ::= [a-zA-Z_][a-zA-Z0-9_]*
Declaration   ::= Property ':' PropertyValue
Property      ::= 'llm_model' | 'llm_provider' | 'reasoning_effort'
PropertyValue ::= QuotedString | BareValue
QuotedString  ::= '"' [^"]* '"' | "'" [^']* "'"
BareValue     ::= [^\s;{}]+
```

### Specificity Table
| Selector type | Example           | Specificity |
|---------------|-------------------|-------------|
| Universal     | `*`               | 0           |
| Shape         | `box`, `diamond`  | 1           |
| Class         | `.code`           | 2           |
| ID            | `#review_node`    | 3           |

### Resolver Caller Contract
The `resolveNodeStyles` function returns properties found in the stylesheet only. The caller (executor or node preparation layer) is responsible for the final merge:

```typescript
// Pseudocode for caller (implemented in a later story):
const resolved = resolveNodeStyles(node, stylesheet)
const finalModel = node.llmModel || resolved.llmModel || graph.defaultLlmModel || ''
```

Explicit node attributes (non-empty string) always win; stylesheet fills the gap; graph-level defaults fill any remaining gaps. The resolver itself does not implement this merge — it only returns what the stylesheet declares for the node.

### Class Attribute Parsing
The node `class` attribute is a comma-separated list of class tokens (e.g., `"code,critical,fast"`). The resolver must split on commas and trim whitespace from each token before comparing with the selector's class value. Comparison is case-sensitive.

### Testing Requirements
- **Framework**: Vitest (`describe`, `it`, `expect` from `'vitest'`)
- **New test file**: `packages/factory/src/stylesheet/__tests__/stylesheet.test.ts`
- **Test runner**: `npm run test:fast` from monorepo root
- **NEVER pipe test output** — pipes discard the vitest summary line
- **NEVER run tests concurrently** — verify `pgrep -f vitest` returns nothing first
- **Confirm results** by checking for "Test Files" in output — exit code alone is insufficient

## Interface Contracts

- **Import**: `GraphNode` @ `packages/factory/src/graph/types.ts` (from story 42-2)
- **Export**: `StylesheetProperty`, `StylesheetDeclaration`, `StylesheetSelectorType`, `StylesheetSelector`, `StylesheetRule`, `ParsedStylesheet`, `ResolvedNodeStyles` @ `packages/factory/src/graph/types.ts` (consumed by stories 42-9 through 42-14 via node preparation)
- **Export**: `parseStylesheet`, `StylesheetParseError` @ `packages/factory/src/stylesheet/parser.ts` (consumed by `stylesheet_syntax` validator rule; consumed by graph executor node preparation in 42-14)
- **Export**: `resolveNodeStyles` @ `packages/factory/src/stylesheet/resolver.ts` (consumed by graph executor node preparation in 42-14)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 42 (Graph Engine Foundation)
