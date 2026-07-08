/**
 * Acceptance Gate — Journey Registry schema + validation (story A0.1).
 *
 * Parses and validates `.substrate/acceptance/journeys.yaml` content.
 * Validation errors are NAMED and PATHED so the operator lint
 * (`substrate acceptance validate`) can print actionable output.
 */

import { load as loadYaml, YAMLException } from 'js-yaml'
import { z } from 'zod'
import type { JourneyRegistry, RegistryParseResult, RegistryValidationIssue } from './types.js'

/** Repo-relative path of the registry — the single canonical location. */
export const JOURNEY_REGISTRY_PATH = '.substrate/acceptance/journeys.yaml'

const JourneySurfaceSchema = z.enum(['email', 'cli', 'file', 'web'])

const JourneyEndStateSchema = z.object({
  id: z.string().min(1, 'end-state id must be a non-empty string'),
  given: z.string().min(1, 'given must be a non-empty string'),
  walk: z.string().min(1, 'walk must be a non-empty string'),
  then: z.string().min(1, 'then must be a non-empty string'),
})

const JourneySchema = z.object({
  id: z.string().min(1, 'journey id must be a non-empty string'),
  title: z.string().min(1, 'title must be a non-empty string'),
  criticality: z.enum(['critical', 'standard']),
  surfaces: z.array(JourneySurfaceSchema).min(1, 'a journey must declare at least one surface'),
  epic: z.number().int().positive().optional(),
  end_states: z
    .array(JourneyEndStateSchema)
    .min(1, 'a journey must declare at least one end_state — a journey with none is unjudgeable'),
})

export const JourneyRegistrySchema = z
  .object({
    version: z.number().int().positive('version must be a positive integer'),
    journeys: z.array(JourneySchema),
  })
  .superRefine((registry, ctx) => {
    // Duplicate journey ids — each id must map to exactly one journey.
    const seenJourneyIds = new Map<string, number>()
    registry.journeys.forEach((journey, i) => {
      const firstIndex = seenJourneyIds.get(journey.id)
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['journeys', i, 'id'],
          message: `duplicate journey id "${journey.id}" (first declared at journeys[${firstIndex}])`,
        })
      } else {
        seenJourneyIds.set(journey.id, i)
      }
      // Duplicate end-state ids within a journey.
      const seenEndStateIds = new Map<string, number>()
      journey.end_states.forEach((endState, j) => {
        const firstEs = seenEndStateIds.get(endState.id)
        if (firstEs !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['journeys', i, 'end_states', j, 'id'],
            message: `duplicate end-state id "${endState.id}" in journey "${journey.id}" (first declared at end_states[${firstEs}])`,
          })
        } else {
          seenEndStateIds.set(endState.id, j)
        }
      })
    })
  })

function zodErrorToValidationIssues(error: z.ZodError): RegistryValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
    message: issue.message,
  }))
}

/**
 * Parse and validate registry YAML content.
 *
 * Never throws: malformed YAML, non-object documents, and schema violations
 * all come back as named, pathed issues.
 */
export function parseJourneyRegistry(yamlContent: string): RegistryParseResult {
  let doc: unknown
  try {
    doc = loadYaml(yamlContent)
  } catch (err) {
    const message = err instanceof YAMLException ? err.message : String(err)
    return { ok: false, issues: [{ path: '(root)', message: `malformed YAML: ${message}` }] }
  }
  if (doc === null || doc === undefined) {
    return { ok: false, issues: [{ path: '(root)', message: 'registry file is empty' }] }
  }
  const result = JourneyRegistrySchema.safeParse(doc)
  if (!result.success) {
    return { ok: false, issues: zodErrorToValidationIssues(result.error) }
  }
  return { ok: true, registry: result.data as JourneyRegistry }
}
