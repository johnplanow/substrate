/**
 * source-detector — detects the OTLP source from a raw payload.
 *
 * Inspects the `service.name` and `telemetry.sdk.name` resource attributes
 * from either `resourceSpans` or `resourceLogs` envelope formats and maps
 * the values to a known source identifier.
 */

// ---------------------------------------------------------------------------
// OtlpSource
// ---------------------------------------------------------------------------

// OtlpSource is defined in types.ts; re-export it here for consumers that
// import it from this module's path.
export type { OtlpSource } from './types.js'
import type { OtlpSource } from './types.js'

// ---------------------------------------------------------------------------
// Detection table
// ---------------------------------------------------------------------------

const SOURCE_DETECTION_TABLE: Array<{ pattern: RegExp; source: OtlpSource }> = [
  { pattern: /claude[\s-]?code/i, source: 'claude-code' },
  { pattern: /claude/i, source: 'claude-code' },
  { pattern: /codex/i, source: 'codex' },
  { pattern: /openai/i, source: 'codex' },
  { pattern: /ollama|llama|local/i, source: 'local-llm' },
]

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface OtlpAttrValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: string | number
}

interface OtlpAttr {
  key?: string
  value?: OtlpAttrValue
}

interface OtlpResource {
  attributes?: OtlpAttr[]
}

interface OtlpResourceEntry {
  resource?: OtlpResource
}

interface OtlpPayloadWithSpans {
  resourceSpans?: OtlpResourceEntry[]
}

interface OtlpPayloadWithLogs {
  resourceLogs?: OtlpResourceEntry[]
}

/**
 * Extract string values for service.name and telemetry.sdk.name from
 * raw OTLP resource attributes, supporting both resourceSpans and resourceLogs.
 */
function extractAttributes(body: unknown): string[] {
  if (!body || typeof body !== 'object') return []

  const values: string[] = []

  const keysOfInterest = ['service.name', 'telemetry.sdk.name']

  const extractFromResources = (resources: OtlpResourceEntry[] | undefined): void => {
    if (!Array.isArray(resources)) return
    for (const entry of resources) {
      if (!entry?.resource?.attributes) continue
      for (const attr of entry.resource.attributes) {
        if (!attr?.key || !keysOfInterest.includes(attr.key)) continue
        const v = attr.value
        if (!v) continue
        const str =
          v.stringValue ??
          (v.intValue !== undefined ? String(v.intValue) : undefined) ??
          (v.doubleValue !== undefined ? String(v.doubleValue) : undefined)
        if (str !== undefined) values.push(str)
      }
    }
  }

  const payload = body as OtlpPayloadWithSpans & OtlpPayloadWithLogs
  extractFromResources(payload.resourceSpans)
  extractFromResources(payload.resourceLogs)

  return values
}

// ---------------------------------------------------------------------------
// detectSource
// ---------------------------------------------------------------------------

/**
 * Detect the OTLP source from a raw payload.
 *
 * Inspects `service.name` and `telemetry.sdk.name` from resource attributes
 * in both `resourceSpans` and `resourceLogs` envelope formats.
 *
 * Returns 'unknown' when no match is found or input is malformed.
 */
export function detectSource(body: unknown): OtlpSource {
  const values = extractAttributes(body)
  for (const value of values) {
    for (const { pattern, source } of SOURCE_DETECTION_TABLE) {
      if (pattern.test(value)) return source
    }
  }
  return 'unknown'
}
