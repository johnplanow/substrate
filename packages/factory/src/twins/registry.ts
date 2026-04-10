/**
 * Twin Registry — Discovery, validation, and health polling for twin definitions.
 *
 * Story 47-1.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { TwinDefinitionSchema } from './schema.js'
import { TwinDefinitionError, TwinRegistryError } from './types.js'
import type { TwinDefinition, HealthPollResult } from './types.js'

export class TwinRegistry {
  private _twins: Map<string, TwinDefinition> = new Map()

  /**
   * Discovers and validates all *.yaml and *.yml twin definition files in the given directory.
   * Non-recursive — only top-level files are processed.
   *
   * @throws {TwinDefinitionError} if a file contains invalid YAML or fails schema validation
   * @throws {TwinRegistryError} if two files declare the same twin name
   */
  async discover(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      throw new TwinDefinitionError(`Failed to read directory: ${dir} — ${(err as Error).message}`)
    }

    const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))

    // Collect per-file validation errors so that valid siblings are still discovered (AC3).
    // TwinRegistryError (duplicate names) is still thrown immediately as a consistency error.
    const perFileErrors: TwinDefinitionError[] = []

    for (const filename of yamlFiles) {
      const filePath = resolve(join(dir, filename))
      let raw: string

      try {
        raw = await readFile(filePath, 'utf-8')
      } catch (err) {
        perFileErrors.push(
          new TwinDefinitionError(
            `Failed to read file: ${filePath} — ${(err as Error).message}`,
            filePath
          )
        )
        continue
      }

      // Parse YAML
      let parsed: unknown
      try {
        parsed = yaml.load(raw)
      } catch (err) {
        perFileErrors.push(
          new TwinDefinitionError(
            `Twin definition at ${filePath} contains invalid YAML: ${(err as Error).message}`,
            filePath
          )
        )
        continue
      }

      // Validate with Zod schema
      const result = TwinDefinitionSchema.safeParse(parsed)
      if (!result.success) {
        const firstIssue = result.error.issues[0]
        const fieldPath = firstIssue?.path?.join('.') ?? 'unknown'
        const fieldMessage = firstIssue?.message ?? result.error.message

        // Provide a descriptive error distinguishing missing required fields from unknown fields
        let message: string
        const issueCode = firstIssue?.code as string | undefined
        if (issueCode === 'unrecognized_keys') {
          // Zod v3: unrecognized_keys issue
          const keys = (firstIssue as { keys?: string[] }).keys ?? []
          message = `Twin definition at ${filePath} contains unrecognised field(s): ${keys.join(', ')}`
        } else if (issueCode === 'unrecognized_key') {
          // Zod v4: single unrecognized_key issue
          const key = (firstIssue as { key?: string }).key ?? fieldPath
          message = `Twin definition at ${filePath} contains unrecognised field(s): ${key}`
        } else {
          // Determine if this is a missing required field by checking the parsed input directly
          const parsedObj = parsed as Record<string, unknown>
          const isMissingField =
            parsedObj &&
            typeof parsedObj === 'object' &&
            fieldPath !== 'unknown' &&
            !(fieldPath in parsedObj)

          if (isMissingField) {
            message = `Twin definition at ${filePath} is missing required field: ${fieldPath}`
          } else {
            message = `Twin definition at ${filePath} failed validation — ${fieldPath}: ${fieldMessage}`
          }
        }

        perFileErrors.push(new TwinDefinitionError(message, filePath))
        continue
      }

      // Construct TwinDefinition manually to satisfy exactOptionalPropertyTypes —
      // Zod types optional fields as `T | undefined` but TwinDefinition uses `T?` (absent).
      const data = result.data
      const twin: TwinDefinition = {
        name: data.name,
        image: data.image,
        ports: data.ports,
        environment: data.environment,
        sourceFile: filePath,
        ...(data.healthcheck !== undefined && { healthcheck: data.healthcheck }),
      }

      // Check for duplicate names — throw immediately as a registry consistency error (AC4).
      if (this._twins.has(twin.name)) {
        const existing = this._twins.get(twin.name)!
        throw new TwinRegistryError(
          `Duplicate twin name "${twin.name}" found in: ${existing.sourceFile} and ${filePath}`
        )
      }

      this._twins.set(twin.name, twin)
    }

    // After processing all files, surface the first per-file validation error (AC3).
    // Valid siblings have already been added to the registry above.
    if (perFileErrors.length > 0) {
      throw perFileErrors[0]!
    }
  }

  /**
   * Returns all discovered twin definitions.
   */
  list(): TwinDefinition[] {
    return Array.from(this._twins.values())
  }

  /**
   * Returns a twin definition by name, or undefined if not found.
   */
  get(name: string): TwinDefinition | undefined {
    return this._twins.get(name)
  }

  /**
   * Polls the health endpoint of a twin definition until healthy or timed out.
   *
   * @param twin - The twin definition to poll
   * @param options - Optional overrides (e.g., mock fetch for testing)
   * @returns HealthPollResult indicating success or timeout
   */
  async pollHealth(
    twin: TwinDefinition,
    options?: { fetch?: typeof fetch }
  ): Promise<HealthPollResult> {
    const { healthcheck } = twin

    if (!healthcheck) {
      return { healthy: true, attempts: 0 }
    }

    const fetchFn = options?.fetch ?? globalThis.fetch
    const { url, interval_ms = 500, timeout_ms = 10000 } = healthcheck
    const startTime = Date.now()
    let attempts = 0

    while (true) {
      attempts++

      try {
        const response = await fetchFn(url)
        if (response.ok) {
          return { healthy: true, attempts }
        }
      } catch {
        // Network error — treat as non-2xx, continue looping
      }

      const elapsed = Date.now() - startTime
      if (elapsed >= timeout_ms) {
        return {
          healthy: false,
          error: `Health check timed out after ${timeout_ms}ms`,
        }
      }

      // Wait before next attempt
      await new Promise<void>((resolve) => setTimeout(resolve, interval_ms))

      // Check timeout again after sleep
      if (Date.now() - startTime >= timeout_ms) {
        return {
          healthy: false,
          error: `Health check timed out after ${timeout_ms}ms`,
        }
      }
    }
  }
}

/**
 * Factory function that creates a new TwinRegistry instance.
 */
export function createTwinRegistry(): TwinRegistry {
  return new TwinRegistry()
}
