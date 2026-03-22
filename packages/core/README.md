# @substrate-ai/core

General-purpose agent infrastructure for the Substrate platform. This package contains all transport-agnostic modules extracted from the Substrate monolith during Epic 41 (Core Extraction Phase 1). Downstream packages — `substrate-ai` (SDLC), factory, and any custom orchestrators — import from `@substrate-ai/core` without coupling to SDLC-specific types.

## Exported Modules

| Namespace | Key exports |
|---|---|
| **adapters** | `WorkerAdapter`, `AdapterRegistry`, `SpawnCommand`, `AdapterOptions` |
| **config** | `SubstrateConfig`, config loader, validation helpers |
| **dispatch** | `Dispatcher`, `DispatchRequest`, `DispatchHandle`, `DispatchResult`, `DispatchConfig` |
| **events** | `TypedEventBus`, `TypedEventBusImpl`, `createEventBus`, `CoreEvents`, `EventMap`, `EventHandler` |
| **git** | Git utilities, worktree management, `GitManager` |
| **persistence** | `DatabaseAdapter`, `DatabaseAdapterConfig`, `SyncAdapter`, `isSyncAdapter`, `InitSchemaFn` |
| **routing** | `RoutingDecision`, `RoutingPolicy`, `IRoutingResolver`, `ModelResolution` |
| **telemetry** | Telemetry pipeline, scoring modules, `ITelemetryPersistence`, `estimateCost` |
| **supervisor** | Analysis engine, experimenter framework |
| **budget** | `BudgetTracker` interface and implementation |
| **cost-tracker** | Token rates, cost tracking, `CostEntry`, `TaskCostSummary`, `SessionCostSummary` |
| **monitor** | `MonitorAgent`, `RecommendationEngine`, `ReportGenerator`, `TaskTypeClassifier` |
| **version-manager** | `VersionManager`, `VersionManagerImpl`, `UpdateChecker`, `VersionCache` |
| **context** | `ContextCompiler`, `TaskDescriptor`, `CompileResult` |
| **quality-gates** | `QualityGate`, `GatePipeline`, `GateResult` |

## Usage

```typescript
// Event bus — subscribe and publish typed pipeline events
import { createEventBus, TypedEventBus } from '@substrate-ai/core';

const bus: TypedEventBus = createEventBus();
bus.on('story:complete', (event) => console.log('Story done:', event.storyKey));
```

```typescript
// Adapter registry — register and retrieve worker adapters
import { AdapterRegistry, WorkerAdapter } from '@substrate-ai/core';

const registry = new AdapterRegistry();
registry.register('claude', myClaudeAdapter);
const adapter: WorkerAdapter = registry.get('claude');
```

```typescript
// Persistence — create a database adapter for pipeline state
import { DatabaseAdapterConfig, createDatabaseAdapter } from '@substrate-ai/core';

const config: DatabaseAdapterConfig = { backend: 'dolt', basePath: '.substrate' };
const db = await createDatabaseAdapter(config);
await db.initSchema(mySchema);
```

## Version

`@substrate-ai/core` follows the root `substrate-ai` version. Current version: **0.9.0** (Epic 41 — Core Extraction Phase 1 complete).
