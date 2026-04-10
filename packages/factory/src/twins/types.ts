/**
 * Twin Registry — Type definitions for TwinDefinition and related interfaces.
 *
 * Story 47-1.
 */

/**
 * Represents a host:container port mapping for a digital twin service.
 */
export interface PortMapping {
  host: number
  container: number
}

/**
 * Healthcheck configuration for a digital twin service.
 */
export interface TwinHealthcheck {
  url: string
  interval_ms?: number
  timeout_ms?: number
}

/**
 * Full definition of a digital twin service, parsed from a YAML file.
 */
export interface TwinDefinition {
  name: string
  image: string
  ports: PortMapping[]
  environment: Record<string, string>
  healthcheck?: TwinHealthcheck
  sourceFile?: string
}

/**
 * Result of polling a twin's health endpoint.
 */
export type HealthPollResult =
  | { healthy: true; attempts: number }
  | { healthy: false; error: string }

/**
 * Thrown when a single twin definition file fails validation or parsing.
 */
export class TwinDefinitionError extends Error {
  constructor(
    message: string,
    public readonly sourceFile?: string
  ) {
    super(message)
    this.name = 'TwinDefinitionError'
  }
}

/**
 * Thrown when a registry-level constraint is violated (e.g., duplicate twin names).
 */
export class TwinRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwinRegistryError'
  }
}
