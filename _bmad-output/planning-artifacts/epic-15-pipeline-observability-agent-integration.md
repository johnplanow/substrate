# Epic 15: Pipeline Observability & Agent Integration

## Vision

Transform `substrate auto run` from a fire-and-forget batch CLI into a controllable, observable pipeline that AI agents can drive conversationally and humans can monitor intuitively.

## Scope

### In Scope

- NDJSON event protocol for machine-readable pipeline output
- Human-readable compact progress display (default mode)
- `--help-agent` flag for self-describing CLI-to-agent knowledge transfer
- CLAUDE.md scaffold update to wire Claude Code into substrate automatically
- Optional TUI dashboard for rich terminal monitoring

### Out of Scope (Future Research)

- **MCP Server (Layer 3)**: Conceptually right — substrate as a native tool provider for Claude. However, MCP's request-response model doesn't map cleanly to long-running streaming pipelines. Requires research into streaming tool results, polling patterns, or MCP transport extensions. Deferred as a research spike, not committed.
- **Codex/Gemini agent scaffolding**: The event protocol is agent-agnostic, but knowledge delivery mechanisms (AGENTS.md, GEMINI.md) differ per provider. Claude is the first priority. Extension points should exist but implementations are deferred.

## Story Map

```
Story 15-1: Event Protocol Foundation
    |
    +-- Story 15-2: Human-Readable Default Output (parallel)
    +-- Story 15-3: --help-agent Self-Describing CLI (parallel)
    +-- Story 15-4: CLAUDE.md Scaffold Update (parallel)
    |
Story 15-5: TUI Dashboard (depends on 15-1 only)
```

### Dependency Analysis

| Story | Depends On | Can Parallelize With |
|-------|-----------|---------------------|
| 15-1  | None      | —                   |
| 15-2  | 15-1      | 15-3, 15-4, 15-5   |
| 15-3  | 15-1      | 15-2, 15-4, 15-5   |
| 15-4  | 15-1      | 15-2, 15-3, 15-5   |
| 15-5  | 15-1      | 15-2, 15-3, 15-4   |

### Sprint Planning

- **MVP (Sprint 1)**: Stories 15-1 through 15-4. Delivers full agent integration.
- **Stretch / Sprint 2**: Story 15-5. Delivers TUI dashboard.
- **Future Epic**: MCP server, multi-provider agent scaffolding.

## Event Schema Reference

```typescript
type PipelineEvent =
  | { event: 'pipeline:start'; run_id: string; stories: string[]; concurrency: number; ts: string }
  | { event: 'pipeline:complete'; succeeded: string[]; failed: string[]; escalated: string[]; ts: string }
  | { event: 'story:phase'; key: string; phase: 'create-story' | 'dev-story' | 'code-review' | 'fix'; status: 'in_progress' | 'complete' | 'failed'; verdict?: string; file?: string; ts: string }
  | { event: 'story:done'; key: string; result: 'success' | 'failure'; review_cycles: number; ts: string }
  | { event: 'story:escalation'; key: string; reason: string; cycles: number; issues?: Array<{ severity: string; file: string; desc: string }>; ts: string }
  | { event: 'story:warn'; key: string; msg: string; ts: string }
  | { event: 'story:log'; key: string; level: 'info' | 'debug'; msg: string; ts: string }
```

Seven event types. `event` field is the discriminant. `ts` is ISO-8601 timestamp added at emit time. Every field is the minimum a consumer needs to make a decision.

## Architecture Decisions

- **Event emitter is parallel to pino, not a replacement.** `--events` writes NDJSON to stdout; pino continues to stderr. No interference with existing logging.
- **Events are typed as a TypeScript discriminated union.** Schema is source of truth for both runtime emit and `--help-agent` documentation generation.
- **`--help-agent` is generated, not hand-written.** Reads from the same type definitions at build time. Single source of truth.
- **Backpressure: fire-and-forget.** If stdout is piped to a slow consumer, events buffer but pipeline doesn't block.
- **TUI is a consumer of the event stream.** Clean separation — the TUI renders events, it doesn't own pipeline state. Can be replaced or supplemented without touching pipeline internals.

## Success Metrics

- AI agent (Claude Code) can run a full pipeline and narrate results conversationally with zero substrate-specific training
- Human user sees clean progress output by default (no raw JSON warn logs)
- Event protocol is stable enough for third-party consumers (documented schema, versioned)
- TUI provides at-a-glance pipeline monitoring without requiring log interpretation
