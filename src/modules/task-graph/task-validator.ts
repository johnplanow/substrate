/**
 * Task graph validator.
 *
 * Combines Zod schema validation, cycle detection, dangling reference
 * detection, and optional agent availability checks into a single
 * ValidationResult.
 */

import { ZodError } from 'zod'
import { TaskGraphFileSchema, SUPPORTED_GRAPH_VERSIONS } from './schemas.js'
import type { TaskGraphFile } from './schemas.js'
import { detectCycle, validateDependencies } from './dependency-resolver.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// ValidationResult
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  /** The validated and typed graph (only present when valid === true) */
  graph?: TaskGraphFile
}

// ---------------------------------------------------------------------------
// VersionError (thrown directly from validateGraph for version incompatibility)
// ---------------------------------------------------------------------------

export class VersionError extends Error {
  constructor(version: string) {
    super(
      `Task graph version '${version}' is not supported. This toolkit supports: ${SUPPORTED_GRAPH_VERSIONS.join(', ')}`,
    )
    this.name = 'VersionError'
  }
}

// ---------------------------------------------------------------------------
// ValidationError (thrown when validation fails — not to be used for partial data persistence)
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  public readonly errors: string[]
  public readonly warnings: string[]

  constructor(errors: string[], warnings: string[] = []) {
    super(`Task graph validation failed:\n${errors.join('\n')}`)
    this.name = 'ValidationError'
    this.errors = errors
    this.warnings = warnings
  }
}

// ---------------------------------------------------------------------------
// validateGraph
// ---------------------------------------------------------------------------

/**
 * Validate a raw (unknown) task graph object.
 *
 * Runs in order:
 *  1. Version field check (before full schema parse) for clear VersionError
 *  2. Zod schema validation
 *  3. Cycle detection
 *  4. Dangling reference detection
 *  5. Agent availability check (if adapterRegistry provided)
 *
 * @param raw - Raw parsed object (output of parseGraphFile/parseGraphString)
 * @param adapterRegistry - Optional adapter registry for agent availability checks
 * @returns ValidationResult — valid=true if all checks pass
 */
export function validateGraph(
  raw: unknown,
  adapterRegistry?: AdapterRegistry,
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Step 1: Pre-check version for a clear error message before full Zod parse
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const rawObj = raw as Record<string, unknown>
    const version = rawObj['version']

    if (version === undefined || version === null) {
      errors.push(
        `Task graph version is missing. This toolkit supports: ${SUPPORTED_GRAPH_VERSIONS.join(', ')}`,
      )
      return { valid: false, errors, warnings }
    }

    if (
      typeof version === 'string' &&
      !(SUPPORTED_GRAPH_VERSIONS as readonly string[]).includes(version)
    ) {
      errors.push(new VersionError(version).message)
      return { valid: false, errors, warnings }
    }
  }

  // Step 2: Zod schema validation
  const parseResult = TaskGraphFileSchema.safeParse(raw)

  if (!parseResult.success) {
    const zodError = parseResult.error as ZodError
    for (const issue of zodError.issues) {
      const path = issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : ''
      errors.push(`${issue.message}${path}`)
    }
    return { valid: false, errors, warnings }
  }

  const graph = parseResult.data

  // Step 3: Cycle detection
  const cycle = detectCycle(graph.tasks)
  if (cycle !== null) {
    errors.push(`Circular dependency detected: ${cycle.join(' → ')}`)
  }

  // Step 4: Dangling reference detection
  const depErrors = validateDependencies(graph.tasks)
  errors.push(...depErrors)

  // Step 5: Agent availability check (optional)
  if (adapterRegistry !== undefined) {
    for (const [taskId, taskDef] of Object.entries(graph.tasks)) {
      if (taskDef.agent !== undefined) {
        // Check against registered adapters — use string comparison with adapter id
        const adapters = adapterRegistry.getAll()
        const agentIds = adapters.map((a) => a.id as string)
        if (!agentIds.includes(taskDef.agent)) {
          warnings.push(
            `Task "${taskId}" references agent "${taskDef.agent}" which is not registered. ` +
              `Available agents: ${agentIds.length > 0 ? agentIds.join(', ') : 'none'}`,
          )
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings }
  }

  return { valid: true, errors, warnings, graph }
}
