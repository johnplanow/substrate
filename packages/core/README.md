# @substrate-ai/core

Transport-agnostic primitives for the [Substrate](https://github.com/johnplanow/substrate) platform. This is the foundation package — adapters, dispatch, routing, persistence, telemetry, cost tracking, event bus, and supervisor analysis — kept free of SDLC-specific concerns so downstream packages (`@substrate-ai/sdlc`, `@substrate-ai/factory`, or custom orchestrators) can compose the pieces they need.

## Install

```bash
npm install @substrate-ai/core
```

Node 22 or later is required. If you plan to use the Dolt persistence adapter in socket mode, also install `mysql2` — it is declared as an optional peer dependency so consumers who only use the CLI or file-backed adapters skip the transitive binary.

## Modules

| Namespace | Representative exports |
|---|---|
| **adapters** | `WorkerAdapter`, `AdapterRegistry`, `SpawnCommand`, `AdapterOptions` |
| **budget** | `BudgetTracker` |
| **config** | `SubstrateConfig`, config loader, validation helpers |
| **context** | `ContextCompiler`, `TaskDescriptor`, `CompileResult` |
| **cost-tracker** | `CostTracker`, `CostEntry`, `TaskCostSummary`, `TOKEN_RATES` |
| **dispatch** | `Dispatcher`, `DispatchRequest`, `DispatchHandle`, `DispatchResult` |
| **events** | `TypedEventBus`, `createEventBus`, `CoreEvents`, `EventMap`, `EventHandler` |
| **git** | Git utilities, worktree management, `GitManager` |
| **llm** | `callLLM`, `LLMCallParams`, `LLMCallResult` (default stub — provide your own implementation) |
| **monitor** | `MonitorAgent`, `RecommendationEngine`, `ReportGenerator` |
| **persistence** | `DatabaseAdapter`, `SyncAdapter`, `createDatabaseAdapter` |
| **quality-gates** | `QualityGate`, `GatePipeline`, `GateResult` |
| **routing** | `RoutingDecision`, `RoutingPolicy`, `IRoutingResolver` |
| **supervisor** | Analysis engine, experimenter framework |
| **telemetry** | Telemetry pipeline, scoring modules, `estimateCost` |
| **version-manager** | `VersionManager`, `UpdateChecker`, `VersionCache` |

## Usage

```typescript
import { createEventBus, type TypedEventBus } from '@substrate-ai/core'

const bus: TypedEventBus = createEventBus()
bus.on('story:complete', (event) => console.log('Story done:', event.storyKey))
```

```typescript
import { AdapterRegistry } from '@substrate-ai/core'

const registry = new AdapterRegistry()
registry.register('claude', myClaudeAdapter)
const adapter = registry.get('claude')
```

## Versioning

This package releases in lockstep with `substrate-ai` on every `v*` tag push. Pick any version ≥ `0.20.1` — all four `@substrate-ai/*` packages publish together with verified npm provenance.

See the [main repository](https://github.com/johnplanow/substrate) for the full platform documentation.
