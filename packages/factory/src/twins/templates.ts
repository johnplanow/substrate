/**
 * Twin Template Catalog — pre-built twin definition templates for common external services.
 *
 * Story 47-4.
 */

import type { TwinDefinitionInput } from './schema.js'

/**
 * A single entry in the twin template catalog.
 */
export interface TwinTemplateEntry {
  name: string
  description: string
  definition: TwinDefinitionInput
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const localstackTemplate: TwinTemplateEntry = {
  name: 'localstack',
  description: 'LocalStack — AWS cloud service emulator (S3, SQS, DynamoDB)',
  definition: {
    name: 'localstack',
    image: 'localstack/localstack:latest',
    ports: ['4566:4566'],
    environment: {
      SERVICES: 's3,sqs,dynamodb',
    },
    healthcheck: {
      url: 'http://localhost:4566/_localstack/health',
      interval_ms: 500,
      timeout_ms: 10000,
    },
  },
}

const wiremockTemplate: TwinTemplateEntry = {
  name: 'wiremock',
  description: 'WireMock — HTTP API mock and stub server',
  definition: {
    name: 'wiremock',
    image: 'wiremock/wiremock:latest',
    ports: ['8080:8080'],
    environment: {},
    healthcheck: {
      url: 'http://localhost:8080/__admin/health',
      interval_ms: 500,
      timeout_ms: 10000,
    },
  },
}

// ---------------------------------------------------------------------------
// Template catalog
// ---------------------------------------------------------------------------

/**
 * Map of all built-in twin templates, keyed by template name.
 */
export const TWIN_TEMPLATES: Map<string, TwinTemplateEntry> = new Map([
  [localstackTemplate.name, localstackTemplate],
  [wiremockTemplate.name, wiremockTemplate],
])

/**
 * Returns all available twin template entries.
 */
export function listTwinTemplates(): TwinTemplateEntry[] {
  return Array.from(TWIN_TEMPLATES.values())
}

/**
 * Returns the twin template entry for the given name, or `undefined` if not found.
 */
export function getTwinTemplate(name: string): TwinTemplateEntry | undefined {
  return TWIN_TEMPLATES.get(name)
}
