# @substrate-ai/factory

Software factory capabilities for the [Substrate](https://github.com/johnplanow/substrate) platform — the graph execution engine, scenario-based validation, convergence loops, digital twin orchestration, LLM client with middleware, and pipeline template library.

Depends on [`@substrate-ai/core`](https://www.npmjs.com/package/@substrate-ai/core) for transport-agnostic infrastructure.

## Install

```bash
npm install @substrate-ai/factory
```

Node 22 or later is required.

## Modules

| Namespace | Representative exports |
|---|---|
| **graph** | `parseGraph`, `createValidator`, `createGraphExecutor`, edge selector and stylesheet helpers |
| **handlers** | `HandlerRegistry`, `createDefaultRegistry`, manager-loop handler |
| **scenarios** | `ScenarioStore`, `ScenarioRunner`, `computeSatisfactionScore`, `registerScenariosCommand` |
| **convergence** | Goal gates, four-level retry chain, budget controls, plateau detection, remediation context injection |
| **backend** | Direct API backend — unified LLM client, codergen loop, provider-aligned tool sets |
| **llm** | `LLMClient` with middleware chain (logging, retry, cost-tracking) and provider adapters (Anthropic, OpenAI, Gemini) |
| **twins** | Digital twin registry, Docker Compose orchestration, health monitoring, persistence, pre-built templates |
| **config** | `FactoryConfigSchema`, `loadFactoryConfig`, `resolveConfigPath` |

## Usage

```typescript
import { parseGraph, createGraphExecutor } from '@substrate-ai/factory'

const graph = parseGraph(dotSource)
const executor = createGraphExecutor({ /* deps */ })
```

## Versioning

Releases in lockstep with `substrate-ai`. See the [main repository](https://github.com/johnplanow/substrate) for full documentation.
