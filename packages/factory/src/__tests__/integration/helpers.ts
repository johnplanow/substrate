/**
 * Shared helpers for graph engine integration tests.
 * Story 42-15: Graph Engine Integration Tests.
 * Story 44-10: Scenario Store Integration Test (additions).
 */

import { vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import crypto from 'node:crypto'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../../graph/types.js'
import type { IHandlerRegistry, NodeHandler } from '../../handlers/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents, ScenarioRunResult } from '../../events.js'
import type { ChildProcess } from 'node:child_process'

// Resolve __dirname for ESM (used by readFixtureDot)
const __helpers_dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Temp-directory helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique temporary directory under os.tmpdir().
 * The caller is responsible for cleanup via cleanDir().
 */
export async function makeTmpDir(): Promise<string> {
  const dirPath = `${os.tmpdir()}/integration-test-${crypto.randomUUID()}`
  await mkdir(dirPath, { recursive: true })
  return dirPath
}

/**
 * Recursively remove a directory (no-op if it doesn't exist).
 */
export async function cleanDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Mock handler factory
// ---------------------------------------------------------------------------

/**
 * Create a single mock node handler that always resolves to SUCCESS
 * (with optional partial Outcome overrides).
 */
export function makeMockHandler(outcomeOverride?: Partial<Outcome>): NodeHandler {
  const outcome: Outcome = { status: 'SUCCESS', ...outcomeOverride }
  return vi.fn().mockResolvedValue(outcome) as unknown as NodeHandler
}

// ---------------------------------------------------------------------------
// Mock registry factory
// ---------------------------------------------------------------------------

/**
 * Result of `makeMockRegistry()` — exposes both the registry and a map of
 * per-node spies so tests can assert call counts and captured arguments.
 */
export interface MockRegistryResult {
  registry: IHandlerRegistry
  /** Spy for each node, keyed by node.id (created lazily on first resolve). */
  spies: Map<string, ReturnType<typeof vi.fn>>
}

/**
 * Build a mock `IHandlerRegistry` that:
 * - Returns a `vi.fn()` spy for each node (keyed by `node.id`).
 * - All handlers resolve to `{ status: 'SUCCESS' }` by default.
 * - `overrides` lets per-node outcomes be customised (keyed by node id).
 *
 * Usage:
 * ```ts
 * const { registry, spies } = makeMockRegistry({ analyze: { contextUpdates: { status: 'success' } } })
 * ```
 */
export function makeMockRegistry(overrides?: Record<string, Partial<Outcome>>): MockRegistryResult {
  const spies = new Map<string, ReturnType<typeof vi.fn>>()

  const registry: IHandlerRegistry = {
    register(): void {},
    registerShape(): void {},
    setDefault(): void {},
    resolve(node: GraphNode): NodeHandler {
      if (!spies.has(node.id)) {
        const outcome: Outcome = { status: 'SUCCESS', ...(overrides?.[node.id] ?? {}) }
        spies.set(node.id, vi.fn().mockResolvedValue(outcome))
      }
      return spies.get(node.id)! as unknown as NodeHandler
    },
  }

  return { registry, spies }
}

// ---------------------------------------------------------------------------
// Event spy factory
// ---------------------------------------------------------------------------

/**
 * Captured event entry emitted on the spy bus.
 */
export interface SpyEvent {
  event: string
  payload: unknown
}

/**
 * Result of `makeEventSpy()`.
 */
export interface EventSpyResult {
  bus: TypedEventBus<FactoryEvents>
  events: SpyEvent[]
}

/**
 * Build a lightweight mock `TypedEventBus<FactoryEvents>` that records every
 * emitted event into the returned `events` array.
 *
 * Usage:
 * ```ts
 * const { bus, events } = makeEventSpy()
 * await executor.run(graph, { ..., eventBus: bus })
 * const started = events.filter(e => e.event === 'graph:node-started')
 * ```
 */
export function makeEventSpy(): EventSpyResult {
  const events: SpyEvent[] = []

  const bus: TypedEventBus<FactoryEvents> = {
    emit<K extends keyof FactoryEvents>(event: K, payload: FactoryEvents[K]): void {
      events.push({ event: event as string, payload })
    },
    on(): void {},
    off(): void {},
  }

  return { bus, events }
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/**
 * Payload type for `graph:node-started` events.
 */
export interface NodeStartedPayload {
  runId: string
  nodeId: string
  nodeType: string
}

/**
 * Payload type for `graph:checkpoint-saved` events.
 */
export interface CheckpointSavedPayload {
  runId: string
  nodeId: string
  checkpointPath: string
}

/**
 * Extract an ordered list of nodeId values from `graph:node-started` events.
 */
export function getNodeStartedIds(events: SpyEvent[]): string[] {
  return events
    .filter((e) => e.event === 'graph:node-started')
    .map((e) => (e.payload as NodeStartedPayload).nodeId)
}

/**
 * Count how many `graph:checkpoint-saved` events were emitted.
 */
export function countCheckpointSaved(events: SpyEvent[]): number {
  return events.filter((e) => e.event === 'graph:checkpoint-saved').length
}

// ---------------------------------------------------------------------------
// Story 44-10: Scenario store integration test helpers
// ---------------------------------------------------------------------------

/**
 * Build a full ScenarioRunResult with per-scenario entries.
 *
 * @param passed - Number of scenarios that should pass
 * @param total  - Total number of scenarios
 */
export function buildScenarioRunResult(passed: number, total: number): ScenarioRunResult {
  const failed = total - passed
  return {
    scenarios: Array.from({ length: total }, (_, i) => ({
      name: `scenario-${i + 1}`,
      status: i < passed ? 'pass' : 'fail',
      exitCode: i < passed ? 0 : 1,
      stdout: '',
      stderr: '',
      durationMs: 50,
    })),
    summary: { total, passed, failed },
    durationMs: total * 50,
  }
}

/**
 * Create a mock ChildProcess-like object that emits stdout data and a close event.
 * Uses setImmediate to defer emission, simulating async process behaviour.
 *
 * @param options.stdout   - String to emit on the stdout 'data' event
 * @param options.exitCode - Exit code to emit with the 'close' event
 */
export function createMockSpawnProcess(options: {
  stdout: string
  exitCode: number
}): ChildProcess {
  const proc = new EventEmitter()
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  ;(proc as unknown as Record<string, unknown>).stdout = stdoutEmitter
  ;(proc as unknown as Record<string, unknown>).stderr = stderrEmitter
  setImmediate(() => {
    stdoutEmitter.emit('data', options.stdout)
    proc.emit('close', options.exitCode)
  })
  return proc as unknown as ChildProcess
}

/**
 * Read the pipeline DOT fixture synchronously.
 * The fixture lives at `fixtures/pipeline.dot` relative to this file.
 */
export function readFixtureDot(): string {
  return readFileSync(join(__helpers_dirname, 'fixtures', 'pipeline.dot'), 'utf8')
}
