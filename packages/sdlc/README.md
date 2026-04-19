# @substrate-ai/sdlc

SDLC-specific orchestration for the [Substrate](https://github.com/johnplanow/substrate) platform. This package contains the phase-aware handlers, graph orchestrator, DOT pipeline topology, verification pipeline, learning loop, and unified run manifest that drive Substrate's software development lifecycle runs.

Depends on [`@substrate-ai/core`](https://www.npmjs.com/package/@substrate-ai/core) for transport-agnostic infrastructure.

## Install

```bash
npm install @substrate-ai/sdlc
```

Node 22 or later is required.

## Modules

| Namespace | Representative exports |
|---|---|
| **handlers** | `createSdlcCreateStoryHandler`, `createSdlcPhaseHandler`, `createSdlcDevStoryHandler`, `createSdlcCodeReviewHandler`, `createSdlcEventBridge` |
| **orchestrator** | Graph-based orchestrator entry point and config mapping |
| **verification** | Ordered check chain (phantom review, trivial output, build verification) with tier filtering |
| **gating** | Pre-dispatch conflict detection and dispatch-gate logic |
| **learning** | Root cause taxonomy, failure classifier, finding lifecycle and injector |
| **run-model** | Atomic JSON-backed `RunManifest`, per-story state, recovery history, CLI flag persistence, supervisor lock |

## Usage

```typescript
import { createSdlcEventBridge } from '@substrate-ai/sdlc'

const bridge = createSdlcEventBridge({ /* deps */ })
```

## Versioning

Releases in lockstep with `substrate-ai`. See the [main repository](https://github.com/johnplanow/substrate) for pipeline documentation, event protocol, and CLI reference.
