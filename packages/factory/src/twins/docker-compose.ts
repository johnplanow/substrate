/**
 * TwinManager — Docker Compose orchestration for digital twin containers.
 *
 * Generates Docker Compose files, manages container lifecycles (start, stop,
 * health check, cleanup), and emits twin lifecycle events.
 *
 * Story 47-2.
 */

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'
import type { TwinDefinition } from './types.js'

// ---------------------------------------------------------------------------
// TwinError
// ---------------------------------------------------------------------------

/**
 * Thrown when Docker is unavailable or the compose lifecycle fails.
 */
export class TwinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwinError'
  }
}

// ---------------------------------------------------------------------------
// Options and interface
// ---------------------------------------------------------------------------

/**
 * Options for TwinManager health check behavior.
 */
export interface TwinManagerOptions {
  /** Maximum polling attempts per health check. Default: 30. */
  maxHealthAttempts?: number
  /** Milliseconds between health check polls. Default: 1000. */
  healthIntervalMs?: number
}

/**
 * Interface for managing twin container lifecycle via Docker Compose.
 */
export interface TwinManager {
  /** Start all specified twins via Docker Compose. Resolves when all are healthy. */
  start(twins: TwinDefinition[]): Promise<void>
  /** Stop all running twins and clean up the compose file. No-op if not started. */
  stop(): Promise<void>
  /** Returns the temp directory path of the active docker-compose.yml, or null if not started. */
  getComposeDir(): string | null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generates a Docker Compose v3.8 YAML string from an array of twin definitions.
 * Built manually with template strings — no external YAML library required.
 */
function generateComposeYaml(twins: TwinDefinition[]): string {
  const lines: string[] = []
  lines.push("version: '3.8'")
  lines.push('services:')

  for (const twin of twins) {
    lines.push(`  ${twin.name}:`)
    lines.push(`    image: ${twin.image}`)

    if (twin.ports.length > 0) {
      lines.push('    ports:')
      for (const port of twin.ports) {
        lines.push(`      - "${port.host}:${port.container}"`)
      }
    }

    if (twin.environment && Object.keys(twin.environment).length > 0) {
      lines.push('    environment:')
      for (const [key, value] of Object.entries(twin.environment)) {
        lines.push(`      ${key}: ${value}`)
      }
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Polls a twin's health endpoint until it returns a 2xx response or exhausts attempts.
 *
 * Algorithm (from story 47-2 dev notes):
 *   attempts = 0
 *   while attempts < maxAttempts:
 *     try fetch → if ok, return
 *     catch (connection refused) → continue
 *     attempts++
 *     sleep(intervalMs)
 *   throw TwinError
 */
async function pollTwinHealth(
  twin: TwinDefinition,
  maxAttempts: number,
  healthIntervalMs: number,
): Promise<void> {
  if (!twin.healthcheck?.url) return

  const url = twin.healthcheck.url
  const intervalMs = twin.healthcheck.interval_ms ?? healthIntervalMs

  let attempts = 0

  while (attempts < maxAttempts) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Connection refused — container not yet up; continue polling
    }

    attempts++

    if (attempts < maxAttempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  throw new TwinError(
    `Twin '${twin.name}' failed health check after ${maxAttempts} attempts`,
  )
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Creates a TwinManager that orchestrates Docker Compose for digital twin services.
 *
 * The event bus is injected — do NOT import a global singleton or create one internally.
 *
 * @param eventBus - Typed event bus for emitting twin lifecycle events
 * @param options - Optional health check configuration
 * @returns TwinManager with start() and stop() methods
 */
export function createTwinManager(
  eventBus: TypedEventBus<FactoryEvents>,
  options?: TwinManagerOptions,
): TwinManager {
  const maxHealthAttempts = options?.maxHealthAttempts ?? 30
  const healthIntervalMs = options?.healthIntervalMs ?? 1000

  /** Temp directory containing the generated docker-compose.yml. Null when not started. */
  let composeDir: string | null = null
  /** Twins that were passed to start() — used by stop() to emit twin:stopped events. */
  let startedTwins: TwinDefinition[] = []

  return {
    async start(twins: TwinDefinition[]): Promise<void> {
      // AC4: Check Docker availability before doing anything
      try {
        execSync('docker info', { stdio: 'ignore' })
      } catch {
        throw new TwinError('Docker not found — twins require Docker')
      }

      // AC1, AC2: Generate and write docker-compose.yml to a temp directory
      const yaml = generateComposeYaml(twins)
      const dir = join(tmpdir(), randomUUID())
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'docker-compose.yml'), yaml, 'utf-8')
      composeDir = dir
      startedTwins = twins

      // AC1: Execute docker compose up -d
      try {
        execSync('docker compose up -d', { cwd: dir, stdio: 'pipe' })
      } catch (err) {
        const error = err as { stderr?: Buffer }
        const stderr = error.stderr?.toString() ?? ''
        throw new TwinError(`docker compose up failed: ${stderr}`)
      }

      // AC3: Poll health endpoints before resolving
      for (const twin of twins) {
        await pollTwinHealth(twin, maxHealthAttempts, healthIntervalMs)
      }

      // AC5: Emit twin:started for each twin
      for (const twin of twins) {
        eventBus.emit('twin:started', {
          twinName: twin.name,
          ports: twin.ports,
          healthStatus: 'healthy',
        })
      }
    },

    async stop(): Promise<void> {
      // AC6: Guard — no-op if start() was never called
      if (!composeDir) return

      const dir = composeDir

      // AC6: Shut down containers
      try {
        execSync('docker compose down --remove-orphans', { cwd: dir, stdio: 'pipe' })
      } catch {
        // Best-effort shutdown — still clean up the temp dir
      }

      // AC6: Delete the temp compose directory
      rmSync(dir, { recursive: true, force: true })

      // Emit twin:stopped for each twin that was started
      for (const twin of startedTwins) {
        eventBus.emit('twin:stopped', { twinName: twin.name })
      }

      composeDir = null
      startedTwins = []
    },

    getComposeDir(): string | null {
      return composeDir
    },
  }
}
