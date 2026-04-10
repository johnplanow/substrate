/**
 * Twin Registry — Zod validation schema for twin definition YAML files.
 *
 * Story 47-1.
 */

import { z } from 'zod'
import type { TwinDefinition } from './types.js'

/**
 * Validates and transforms a "host:container" port string into a PortMapping object.
 */
const portMappingStringSchema = z
  .string()
  .regex(/^\d+:\d+$/, 'Port mapping must be in "host:container" format (e.g., "5432:5432")')
  .transform((val) => {
    const parts = val.split(':')
    const host = Number(parts[0])
    const container = Number(parts[1])
    return { host, container } as { host: number; container: number }
  })

/**
 * Validates a healthcheck configuration object.
 */
const twinHealthcheckSchema = z.object({
  url: z.string().url('Healthcheck URL must be a valid URL'),
  interval_ms: z.number().int().positive().default(500),
  timeout_ms: z.number().int().positive().default(10000),
})

/**
 * Validates a full twin definition. Unknown fields are rejected via `.strict()`.
 */
const twinDefinitionSchema = z
  .object({
    name: z.string().min(1, 'Twin name must not be empty'),
    image: z.string().min(1, 'Twin image must not be empty'),
    ports: z.array(portMappingStringSchema).default([]),
    environment: z.record(z.string(), z.string()).default({}),
    healthcheck: twinHealthcheckSchema.optional(),
  })
  .strict()

export const TwinDefinitionSchema = twinDefinitionSchema

export type TwinDefinitionInput = z.input<typeof twinDefinitionSchema>

// Compile-time assertion: schema output must be assignable to TwinDefinition (minus sourceFile
// and healthcheck). The healthcheck field is excluded because Zod's `.optional()` produces
// `T | undefined` which conflicts with exactOptionalPropertyTypes (which requires the field
// to be absent, not explicitly undefined). The registry.ts constructor handles this mismatch
// with a spread-based conditional assignment.
const _schemaCompatCheck: Omit<TwinDefinition, 'sourceFile' | 'healthcheck'> = {} as Omit<
  z.output<typeof twinDefinitionSchema>,
  'healthcheck'
>
