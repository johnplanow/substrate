# Adapter Implementation Guide

This document explains the WorkerAdapter interface and how to add custom CLI agent adapters to substrate.

> Last verified: v0.20.46. The adapter interface itself has been stable since Epic 41 (March 2026); only the package path has changed.

## Overview

The adapter system provides a pluggable interface for integrating any CLI agent (Claude Code, Codex CLI, Gemini CLI, or custom agents) with the orchestrator. Adding a new adapter never requires modifying the orchestrator core (NFR11, FR14).

## Directory Structure

Adapters live in `@substrate-ai/core` (extracted from the monolith in Epic 41):

```
packages/core/src/adapters/
├── worker-adapter.ts          # WorkerAdapter interface definition
├── types.ts                   # All TypeScript types for adapters
├── schemas.ts                 # Zod validation schemas
├── adapter-registry.ts        # AdapterRegistry class
├── adapter-output-normalizer.ts  # Output recovery (4 strategies, Epic 62)
├── adapter-format-error.ts    # Format error reporting
├── claude-adapter.ts          # Claude Code adapter
├── codex-adapter.ts           # Codex CLI adapter
└── gemini-adapter.ts          # Gemini CLI adapter
```

For consumers using substrate as a library, import the interface from `@substrate-ai/core`:

```typescript
import type { WorkerAdapter, AdapterOptions, TaskResult } from '@substrate-ai/core'
```

The `substrate-ai` CLI re-exports the interface, so internal code (the substrate monolith itself) can import from either path.

## WorkerAdapter Interface

Every adapter must implement the `WorkerAdapter` interface from `packages/core/src/adapters/worker-adapter.ts`.

### Required Readonly Properties

| Property         | Type     | Description                             |
|------------------|----------|-----------------------------------------|
| `id`             | `AgentId`| Unique identifier (e.g. "claude-code")  |
| `displayName`    | `string` | Human-readable name (e.g. "Claude Code")|
| `adapterVersion` | `string` | Semantic version (e.g. "1.0.0")         |

### Required Methods

| Method                   | Description                                               |
|--------------------------|-----------------------------------------------------------|
| `healthCheck()`          | Check CLI binary is installed and responsive              |
| `buildCommand()`         | Return SpawnCommand for task execution                    |
| `buildPlanningCommand()` | Return SpawnCommand for plan generation                   |
| `parseOutput()`          | Parse CLI stdout/stderr/exitCode to TaskResult            |
| `parsePlanOutput()`      | Parse CLI plan output to PlanParseResult                  |
| `estimateTokens()`       | Estimate token count for a prompt string                  |
| `getCapabilities()`      | Return AdapterCapabilities for routing decisions          |

## Key Types

### SpawnCommand

The descriptor used by the orchestrator to spawn a CLI process:

```typescript
interface SpawnCommand {
  binary: string                     // e.g. "claude"
  args: string[]                     // CLI arguments
  env?: Record<string, string>       // Optional env overrides
  cwd: string                        // Must be worktreePath (NFR10)
  stdin?: string                     // Optional stdin data
  timeoutMs?: number                 // Optional timeout
}
```

### AdapterOptions

Per-invocation options passed to `buildCommand()` and `buildPlanningCommand()`:

```typescript
interface AdapterOptions {
  worktreePath: string               // Git worktree for file context
  billingMode: BillingMode           // 'subscription' | 'api' | 'free'
  model?: string                     // Optional model override
  additionalFlags?: string[]         // Optional extra CLI flags
  apiKey?: string                    // Optional API key override
}
```

### AdapterCapabilities

Capabilities the CLI agent supports:

```typescript
interface AdapterCapabilities {
  supportsJsonOutput: boolean
  supportsStreaming: boolean
  supportsSubscriptionBilling: boolean
  supportsApiBilling: boolean
  supportsPlanGeneration: boolean
  maxContextTokens: number
  supportedTaskTypes: string[]
  supportedLanguages: string[]
}
```

### AdapterHealthResult

Result from a health check:

```typescript
interface AdapterHealthResult {
  healthy: boolean
  version?: string
  cliPath?: string
  error?: string
  billingMode?: BillingMode
  supportsHeadless: boolean
}
```

### Expected JSON Output Format

All CLI agents should output JSON to stdout when invoked in headless mode:

```json
{
  "status": "completed",
  "output": "The task result text here",
  "error": null,
  "metadata": {
    "executionTime": 1234,
    "tokensUsed": {
      "input": 100,
      "output": 50
    }
  }
}
```

Status can be `"completed"` or `"failed"`. When `"error"` is non-null, the adapter marks the result as failed.

## Implementing a Custom Adapter

### Step 1: Create the adapter file

Create `packages/core/src/adapters/my-agent-adapter.ts`:

```typescript
import { execSync } from 'child_process'
import type { AgentId } from '../core/types.js'
import type { WorkerAdapter } from './worker-adapter.js'
import type {
  SpawnCommand, AdapterOptions, AdapterCapabilities,
  AdapterHealthResult, TaskResult, TokenEstimate,
  PlanRequest, PlanParseResult, PlannedTask,
} from './types.js'

export class MyAgentAdapter implements WorkerAdapter {
  readonly id: AgentId = 'my-agent'
  readonly displayName = 'My Agent'
  readonly adapterVersion = '1.0.0'

  async healthCheck(): Promise<AdapterHealthResult> {
    try {
      const version = execSync('my-agent --version', {
        encoding: 'utf-8', timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      return { healthy: true, version, supportsHeadless: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { healthy: false, error: message, supportsHeadless: false }
    }
  }

  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    return {
      binary: 'my-agent',
      args: ['run', '--json', '--prompt', prompt],
      cwd: options.worktreePath,
    }
  }

  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand {
    return {
      binary: 'my-agent',
      args: ['plan', '--json', '--goal', request.goal],
      cwd: options.worktreePath,
    }
  }

  parseOutput(stdout: string, stderr: string, exitCode: number): TaskResult {
    if (exitCode !== 0) {
      return { success: false, output: stdout, error: stderr, exitCode }
    }
    try {
      const parsed = JSON.parse(stdout) as { output?: string; error?: string }
      return {
        success: !parsed.error,
        output: parsed.output ?? stdout,
        ...(parsed.error ? { error: parsed.error } : {}),
        exitCode,
      }
    } catch {
      return { success: true, output: stdout, exitCode }
    }
  }

  parsePlanOutput(stdout: string, stderr: string, exitCode: number): PlanParseResult {
    if (exitCode !== 0) {
      return { success: false, tasks: [], error: stderr, rawOutput: stdout }
    }
    try {
      const parsed = JSON.parse(stdout) as { tasks?: PlannedTask[] }
      if (!Array.isArray(parsed.tasks)) {
        return { success: false, tasks: [], error: 'Missing tasks array', rawOutput: stdout }
      }
      return { success: true, tasks: parsed.tasks, rawOutput: stdout }
    } catch {
      return { success: false, tasks: [], error: 'Invalid JSON', rawOutput: stdout }
    }
  }

  estimateTokens(prompt: string): TokenEstimate {
    const input = Math.ceil(prompt.length / 3)
    const output = Math.ceil(input * 0.5)
    return { input, output, total: input + output }
  }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsJsonOutput: true,
      supportsStreaming: false,
      supportsSubscriptionBilling: false,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 64_000,
      supportedTaskTypes: ['code', 'test'],
      supportedLanguages: ['*'],
    }
  }
}
```

### Step 2: Register in AdapterRegistry

Add the adapter to `discoverAndRegister()` in `packages/core/src/adapters/adapter-registry.ts`:

```typescript
import { MyAgentAdapter } from './my-agent-adapter.js'

// In discoverAndRegister():
const builtInAdapters: WorkerAdapter[] = [
  new ClaudeCodeAdapter(),
  new CodexCLIAdapter(),
  new GeminiCLIAdapter(),
  new MyAgentAdapter(), // Add here
]
```

### Step 3: Write tests

Create `test/adapters/my-agent-adapter.test.ts` following the patterns in the existing test files.

## AdapterRegistry Usage

```typescript
import { AdapterRegistry } from './adapter-registry.js'

// Initialize and discover adapters at startup
const registry = new AdapterRegistry()
const report = await registry.discoverAndRegister()

console.log(`Registered: ${report.registeredCount} adapters`)
console.log(`Failed: ${report.failedCount} adapters`)

// Get a specific adapter
const claude = registry.get('claude-code')

// Get all adapters
const all = registry.getAll()

// Get only plan-capable adapters
const planners = registry.getPlanningCapable()
```

## Zod Validation (NFR13)

Schemas in `packages/core/src/adapters/schemas.ts` can be used to validate adapter data at runtime:

```typescript
import { validateSpawnCommand, validateAdapterCapabilities } from './schemas.js'

// Validate before use (throws AdtError on failure)
const cmd = validateSpawnCommand(untrustedData)
const caps = validateAdapterCapabilities(untrustedCapabilities)
```

Custom adapters can extend these schemas to add new validated fields without breaking existing code.

## Health Check Flow

1. Adapter calls `execSync('<binary> --version')` or equivalent
2. If successful, parses version and detects billing mode
3. Returns `AdapterHealthResult` with `healthy: true`
4. If the binary is missing or errors, returns `healthy: false` with `error` string
5. `healthCheck()` must NEVER throw — all errors must be captured in the result

## Billing Mode Detection

- **Claude Code**: Checks `ANTHROPIC_API_KEY` env var; falls back to `ADT_BILLING_MODE` env
- **Codex CLI**: Always `'api'` (Codex is API-only)
- **Gemini CLI**: Checks `GEMINI_API_KEY` env var; falls back to `ADT_BILLING_MODE` env

Set `ADT_BILLING_MODE=subscription` in the environment to indicate subscription billing for agents that support it.
