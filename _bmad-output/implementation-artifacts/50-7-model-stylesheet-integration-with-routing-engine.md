# Story 50-7: Model Stylesheet — Integration with RoutingEngine

## Story

As a pipeline graph author,
I want the model stylesheet to integrate with the existing RoutingEngine,
so that stylesheet provides per-node model intent and RoutingEngine applies operational constraints (rate limits, cost optimization, subscription routing) without conflict.

## Acceptance Criteria

### AC1: Stylesheet Model Feeds into RoutingEngine
**Given** a stylesheet resolves `llm_model: claude-opus-4-6` for a node
**When** the `RoutingEngine` processes the request
**Then** it applies subscription-first routing, rate limit checking, and cost optimization on top of the stylesheet's model selection

### AC2: Rate-Limited Model Fallback
**Given** a stylesheet specifies a model that is rate-limited
**When** the routing engine evaluates
**Then** it falls back to the next available model in the provider

### AC3: Stylesheet + RoutingPolicy Composition
**Given** both stylesheet and RoutingPolicy exist for a node
**When** model selection occurs
**Then** stylesheet provides intent (which model), RoutingPolicy applies constraints (rate limits, fallback) — they compose without conflict

## Implementation Notes

This story's functionality was delivered implicitly through the combined work of stories 50-6 (stylesheet resolver + transformer) and the existing executor integration. The `applyStylesheet()` call in `executor.ts:301` applies stylesheet-resolved model properties to graph nodes before handler dispatch. The RoutingEngine (from Epic 41-4) then applies its operational constraints on top of the stylesheet-resolved model when the handler makes LLM calls.

### Files Modified
- `packages/factory/src/graph/executor.ts` — `applyStylesheet()` wired at line 301
- `packages/factory/src/graph/transformer.ts` — `applyStylesheet()` and `resolveNodeStyles()` implementations
- `packages/factory/src/stylesheet/resolver.ts` — specificity-based rule matching

### Tests
- `packages/factory/src/__tests__/integration/stylesheet-application.test.ts` — 6 integration tests
- `packages/factory/src/graph/__tests__/transformer.test.ts` — 18 unit tests
- `packages/factory/src/stylesheet/__tests__/stylesheet.test.ts` — existing stylesheet tests

## Dependencies
- 50-6 (Model Stylesheet — Shape Selectors)
- 41-4 (Routing Engine Migration)
