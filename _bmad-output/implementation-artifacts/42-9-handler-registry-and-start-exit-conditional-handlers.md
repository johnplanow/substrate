# Story 42-9: Handler Registry and start/exit/conditional Handlers

## Story

As a graph engine developer,
I want a `HandlerRegistry` that maps node types and shapes to handler functions, plus trivial implementations for `start`, `exit`, and `conditional` nodes,
so that the executor (story 42-14) can dispatch any node to the correct handler via a consistent resolution algorithm without being coupled to individual handler implementations.

## Acceptance Criteria

### AC1: Handler Lookup by Explicit Type
**Given** a `HandlerRegistry` with `start`, `exit`, and `conditional` handlers registered
**When** `registry.resolve(node)` is called for a node with `type="start"`
**Then** the handler function registered under the key `"start"` is returned

### AC2: Shape-Based Fallback When Type Is Absent
**Given** a `HandlerRegistry` and a node with no explicit `type` but `shape="Mdiamond"`, `"Msquare"`, or `"diamond"`
**When** `registry.resolve(node)` is called
**Then** the handler registered for the corresponding canonical type (`start`, `exit`, or `conditional`) is returned via the shape-to-type mapping

### AC3: Default Handler for Unrecognized Nodes
**Given** a `HandlerRegistry` with a default handler set
**When** `registry.resolve(node)` is called for a node whose `type` is absent or unrecognized and whose `shape` has no registered mapping
**Then** the default handler is returned

### AC4: Start Handler Returns SUCCESS with No Side Effects
**Given** the `startHandler` function and any `GraphNode` and `IGraphContext`
**When** `startHandler(node, context, graph)` is called
**Then** it resolves to an `Outcome` with `status: 'SUCCESS'`; `contextUpdates` is undefined or empty; no mutations are made to the context

### AC5: Exit Handler Returns SUCCESS with No Side Effects
**Given** the `exitHandler` function and any `GraphNode` and `IGraphContext`
**When** `exitHandler(node, context, graph)` is called
**Then** it resolves to an `Outcome` with `status: 'SUCCESS'`; `contextUpdates` is undefined or empty; no mutations are made to the context

### AC6: Conditional Handler Returns SUCCESS and Defers Routing
**Given** the `conditionalHandler` function and any `GraphNode` and `IGraphContext`
**When** `conditionalHandler(node, context, graph)` is called
**Then** it resolves to an `Outcome` with `status: 'SUCCESS'`; it does not set `suggestedNextIds`; edge selection (story 42-12) is fully responsible for routing

### AC7: Dynamic Handler Registration and Override
**Given** a `HandlerRegistry`
**When** `registry.register('my-type', myHandler)` is called and then `registry.resolve(node)` is called for a node with `type='my-type'`
**Then** `myHandler` is returned; calling `register` a second time with the same key replaces the previous handler

## Tasks / Subtasks

- [ ] Task 1: Define `NodeHandler` type and `IHandlerRegistry` interface in `packages/factory/src/handlers/types.ts` (AC: #1, #2, #3, #7)
  - [ ] Define `NodeHandler` as `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>`
  - [ ] Import `GraphNode`, `Graph` from `../graph/types.js`; import `IGraphContext` from `../graph/types.js`; import `Outcome` from `../graph/types.js`
  - [ ] Define `IHandlerRegistry` interface with methods: `register(type: string, handler: NodeHandler): void`, `registerShape(shape: string, type: string): void`, `setDefault(handler: NodeHandler): void`, `resolve(node: GraphNode): NodeHandler`
  - [ ] Export `NodeHandler` and `IHandlerRegistry`

- [ ] Task 2: Implement `startHandler` in `packages/factory/src/handlers/start.ts` (AC: #4)
  - [ ] Create file `packages/factory/src/handlers/start.ts`
  - [ ] Implement `startHandler: NodeHandler` as an async arrow function that immediately returns `{ status: 'SUCCESS' as const }`
  - [ ] Add a brief JSDoc comment: handler for start nodes; no side effects; edge selection drives next step
  - [ ] Export `startHandler` as a named export

- [ ] Task 3: Implement `exitHandler` in `packages/factory/src/handlers/exit.ts` (AC: #5)
  - [ ] Create file `packages/factory/src/handlers/exit.ts`
  - [ ] Implement `exitHandler: NodeHandler` as an async arrow function that immediately returns `{ status: 'SUCCESS' as const }`
  - [ ] Add JSDoc: handler for exit/terminal nodes; signals successful graph completion
  - [ ] Export `exitHandler` as a named export

- [ ] Task 4: Implement `conditionalHandler` in `packages/factory/src/handlers/conditional.ts` (AC: #6)
  - [ ] Create file `packages/factory/src/handlers/conditional.ts`
  - [ ] Implement `conditionalHandler: NodeHandler` as an async arrow function that returns `{ status: 'SUCCESS' as const }`
  - [ ] Add JSDoc: handler for conditional/branching nodes; routing is delegated entirely to edge selection (story 42-12); this handler does nothing
  - [ ] Export `conditionalHandler` as a named export

- [ ] Task 5: Implement `HandlerRegistry` in `packages/factory/src/handlers/registry.ts` (AC: #1, #2, #3, #7)
  - [ ] Create file `packages/factory/src/handlers/registry.ts`
  - [ ] Implement `HandlerRegistry` class implementing `IHandlerRegistry`
  - [ ] Backing stores: `private _handlers = new Map<string, NodeHandler>()` (type → handler) and `private _shapeMap = new Map<string, string>()` (shape → type)
  - [ ] `register(type, handler)`: stores in `_handlers`; overwrites if already present
  - [ ] `registerShape(shape, type)`: stores in `_shapeMap`; overwrites if already present
  - [ ] `setDefault(handler)`: stores in `private _default: NodeHandler | undefined`
  - [ ] `resolve(node)`: (1) if `node.type` is non-empty and has a registered handler → return it; (2) if `node.shape` is non-empty and `_shapeMap` maps shape to a type that has a registered handler → return it; (3) return `_default` if set; (4) throw `Error(\`No handler for node "${node.id}" (type="${node.type}", shape="${node.shape}")\`)`
  - [ ] Implement `createDefaultRegistry(): HandlerRegistry` factory function that pre-registers: `start`/`exit`/`conditional` handlers; shape mappings `Mdiamond→start`, `Msquare→exit`, `diamond→conditional`; **does not** set a default (codergen default is registered in 42-10)
  - [ ] Export `HandlerRegistry` (class) and `createDefaultRegistry` (function) as named exports

- [ ] Task 6: Create barrel export in `packages/factory/src/handlers/index.ts` (AC: all)
  - [ ] Create or update `packages/factory/src/handlers/index.ts`
  - [ ] Re-export `startHandler` from `./start.js`
  - [ ] Re-export `exitHandler` from `./exit.js`
  - [ ] Re-export `conditionalHandler` from `./conditional.js`
  - [ ] Re-export `HandlerRegistry`, `createDefaultRegistry` from `./registry.js`
  - [ ] Re-export `NodeHandler`, `IHandlerRegistry` from `./types.js`

- [ ] Task 7: Write unit tests in `packages/factory/src/handlers/__tests__/registry.test.ts` (AC: #1–#7)
  - [ ] Create directory `packages/factory/src/handlers/__tests__/` if it does not exist
  - [ ] Test `startHandler`: verify it returns `{ status: 'SUCCESS' }` and does not mutate context
  - [ ] Test `exitHandler`: verify it returns `{ status: 'SUCCESS' }` and does not mutate context
  - [ ] Test `conditionalHandler`: verify it returns `{ status: 'SUCCESS' }` with no `suggestedNextIds`
  - [ ] Test `resolve` by explicit `type`: register a mock handler, create a node with that type, verify resolution
  - [ ] Test `resolve` by shape: create a node with no `type` but `shape="Mdiamond"`, verify `startHandler` is returned from `createDefaultRegistry()`
  - [ ] Test `resolve` shape fallback for `"Msquare"` → `exitHandler` and `"diamond"` → `conditionalHandler`
  - [ ] Test `resolve` returns default handler for a node with unrecognized type and shape, after `setDefault()` is called
  - [ ] Test `resolve` throws for unrecognized node when no default is set
  - [ ] Test `register` override: register a handler, replace it, verify the new handler is returned
  - [ ] Aim for ≥ 90% branch coverage on `HandlerRegistry.resolve`

## Dev Notes

### Architecture Constraints
- **File paths:**
  - `packages/factory/src/handlers/types.ts` — new file; defines `NodeHandler` and `IHandlerRegistry`
  - `packages/factory/src/handlers/start.ts` — new file; exports `startHandler`
  - `packages/factory/src/handlers/exit.ts` — new file; exports `exitHandler`
  - `packages/factory/src/handlers/conditional.ts` — new file; exports `conditionalHandler`
  - `packages/factory/src/handlers/registry.ts` — new file; exports `HandlerRegistry`, `createDefaultRegistry`
  - `packages/factory/src/handlers/index.ts` — new barrel; re-exports all of the above
  - `packages/factory/src/handlers/__tests__/registry.test.ts` — new test file
- **Import style:** ESM with `.js` extensions on all relative imports (e.g., `import { Outcome } from '../graph/types.js'`)
- **Imports from prior stories:** `GraphNode`, `Graph`, `IGraphContext`, `Outcome`, `OutcomeStatus` are all defined in `packages/factory/src/graph/types.ts` (stories 42-1 through 42-8); `GraphContext` from `packages/factory/src/graph/context.ts` (42-8) may be used in tests to construct a concrete context
- **No circular deps:** handler files must not import from `executor.ts`, `edge-selector.ts`, `checkpoint.ts`, or any story not yet implemented
- **Handler signature is async:** all three handlers (`start`, `exit`, `conditional`) must be `async` functions returning `Promise<Outcome>` even though they have no awaited work — the executor (42-14) always awaits handlers

### Handler Resolution Algorithm
The `resolve` method implements the following 3-step priority chain (from spec):
1. **Explicit type**: `node.type` is non-empty and a handler is registered under that exact string key
2. **Shape-based**: `node.type` is absent/unknown, but `node.shape` maps to a registered type via `_shapeMap`
3. **Default**: fall back to `_default` if set; throw if not set

The `createDefaultRegistry()` factory pre-wires the shape map:
| DOT Shape | Canonical Type |
|-----------|----------------|
| `Mdiamond` | `start` |
| `Msquare` | `exit` |
| `diamond` | `conditional` |

No default handler is set by `createDefaultRegistry()` because the codergen handler (42-10) will call `registry.setDefault(codergenHandler)` after construction.

### Testing Requirements
- Test framework: Vitest (already configured in the monorepo)
- Run tests with: `npm run test:fast` (unit only, no e2e)
- All tests must pass before the story is considered done
- Verify with `npm run test:fast` — confirm "Test Files" line appears in output

## Interface Contracts

- **Export**: `NodeHandler` @ `packages/factory/src/handlers/types.ts` (consumed by executor in 42-14, codergen handler in 42-10, tool/wait.human handlers in 42-11)
- **Export**: `IHandlerRegistry` @ `packages/factory/src/handlers/types.ts` (consumed by executor in 42-14)
- **Export**: `HandlerRegistry` @ `packages/factory/src/handlers/registry.ts` (consumed by executor in 42-14, extended by 42-10 via `setDefault`)
- **Export**: `createDefaultRegistry` @ `packages/factory/src/handlers/registry.ts` (consumed by executor in 42-14)
- **Import**: `GraphNode`, `Graph`, `IGraphContext`, `Outcome`, `OutcomeStatus` @ `packages/factory/src/graph/types.ts` (from stories 42-1/42-2/42-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
