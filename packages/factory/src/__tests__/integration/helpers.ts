/**
 * Shared helpers for graph engine integration tests.
 * Story 42-15: Graph Engine Integration Tests.
 */

import { vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../../graph/types.js'
import type { IHandlerRegistry, NodeHandler } from '../../handlers/types.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'

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
