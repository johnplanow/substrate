/**
 * TelemetryNormalizer — transforms raw OTLP payloads into normalized models.
 *
 * Accepts raw OTLP JSON objects (traces or logs) and returns arrays of
 * `NormalizedSpan` or `NormalizedLog` objects suitable for downstream analysis.
 *
 * Design invariants:
 *   - Never throws from public methods — returns empty array on any error
 *   - Constructor injection of ILogger for testability
 *   - No external dependencies beyond built-in Node.js and internal modules
 */

import type { ILogger } from '../dispatch/types.js'
import type { NormalizedSpan, NormalizedLog, DispatchContext } from './types.js'
import { estimateCost } from './cost-table.js'
import { normalizeTimestamp } from './timestamp-normalizer.js'
import {
  extractTokensFromAttributes,
  extractTokensFromBody,
  mergeTokenCounts,
} from './token-extractor.js'

// ---------------------------------------------------------------------------
// OTLP raw shape types (minimal, internal only)
// ---------------------------------------------------------------------------

interface OtlpAttrValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: string | number
  boolValue?: boolean
}

interface OtlpAttr {
  key: string
  value: OtlpAttrValue
}

interface OtlpSpan {
  spanId?: string
  traceId?: string
  parentSpanId?: string
  name?: string
  startTimeUnixNano?: string | number
  endTimeUnixNano?: string | number
  attributes?: OtlpAttr[]
  events?: unknown[]
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[]
}

interface OtlpResource {
  attributes?: OtlpAttr[]
}

interface OtlpResourceSpan {
  resource?: OtlpResource
  scopeSpans?: OtlpScopeSpans[]
}

interface OtlpTracePayload {
  resourceSpans?: OtlpResourceSpan[]
}

interface OtlpLogRecord {
  logRecordId?: string
  traceId?: string
  spanId?: string
  timeUnixNano?: string | number
  severityText?: string
  body?: { stringValue?: string } | string
  attributes?: OtlpAttr[]
}

interface OtlpScopeLogs {
  logRecords?: OtlpLogRecord[]
}

interface OtlpResourceLog {
  resource?: OtlpResource
  scopeLogs?: OtlpScopeLogs[]
}

interface OtlpLogPayload {
  resourceLogs?: OtlpResourceLog[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a string value from an OTLP attribute array by key.
 */
function getAttrString(attrs: OtlpAttr[] | undefined, key: string): string | undefined {
  if (!Array.isArray(attrs)) return undefined
  const entry = attrs.find((a) => a?.key === key)
  if (!entry?.value) return undefined
  return (
    entry.value.stringValue ??
    (entry.value.intValue !== undefined ? String(entry.value.intValue) : undefined) ??
    (entry.value.doubleValue !== undefined ? String(entry.value.doubleValue) : undefined)
  )
}

/**
 * Determine source from resource attributes service.name.
 */
function resolveSource(resourceAttrs: OtlpAttr[] | undefined): string {
  const serviceName = getAttrString(resourceAttrs, 'service.name')
  if (!serviceName) return 'unknown'
  const lower = serviceName.toLowerCase()
  if (lower.includes('claude')) return 'claude-code'
  if (lower.includes('codex') || lower.includes('openai')) return 'codex'
  if (lower.includes('local')) return 'local-llm'
  return serviceName
}

/**
 * Resolve model from span attributes (tries multiple known keys).
 */
function resolveModel(attrs: OtlpAttr[] | undefined): string | undefined {
  const modelKeys = [
    'gen_ai.request.model',
    'gen_ai.response.model',
    'llm.request.model',
    'anthropic.model',
    'openai.model',
    'model',
  ]
  for (const key of modelKeys) {
    const val = getAttrString(attrs, key)
    if (val) return val
  }
  return undefined
}

/**
 * Resolve provider from span attributes.
 */
function resolveProvider(attrs: OtlpAttr[] | undefined, source: string): string | undefined {
  const providerVal = getAttrString(attrs, 'gen_ai.system')
  if (providerVal) return providerVal
  if (source === 'claude-code') return 'anthropic'
  if (source === 'codex') return 'openai'
  return undefined
}

/**
 * Extract the body string from a log record body field.
 */
function extractBodyString(body: OtlpLogRecord['body']): string | undefined {
  if (!body) return undefined
  if (typeof body === 'string') return body
  if (typeof body === 'object' && body.stringValue) return body.stringValue
  return undefined
}

/**
 * Generate a unique log record ID.
 */
let _logIdCounter = 0
function generateLogId(): string {
  return `log-${Date.now()}-${++_logIdCounter}`
}

// ---------------------------------------------------------------------------
// TelemetryNormalizer
// ---------------------------------------------------------------------------

/**
 * Transforms raw OTLP payloads into normalized telemetry models.
 *
 * Inject an `ILogger` for structured logging.
 * All public methods return empty arrays on any error — never throw.
 */
export class TelemetryNormalizer {
  private readonly _logger: ILogger

  constructor(logger: ILogger) {
    this._logger = logger
  }

  // -------------------------------------------------------------------------
  // normalizeSpan
  // -------------------------------------------------------------------------

  /**
   * Normalize a raw OTLP trace payload into an array of `NormalizedSpan`.
   *
   * @param raw - Raw OTLP trace payload (resourceSpans structure)
   * @returns Array of normalized spans; empty on error or empty input
   */
  normalizeSpan(raw: unknown): NormalizedSpan[] {
    try {
      return this._normalizeSpanInternal(raw)
    } catch (err) {
      this._logger.warn({ err }, 'TelemetryNormalizer.normalizeSpan: unexpected error')
      return []
    }
  }

  private _normalizeSpanInternal(raw: unknown): NormalizedSpan[] {
    if (!raw || typeof raw !== 'object') return []

    const payload = raw as OtlpTracePayload
    if (!Array.isArray(payload.resourceSpans)) return []

    const results: NormalizedSpan[] = []

    for (const resourceSpan of payload.resourceSpans) {
      if (!resourceSpan) continue

      const resourceAttrs = resourceSpan.resource?.attributes
      const source = resolveSource(resourceAttrs)

      if (!Array.isArray(resourceSpan.scopeSpans)) continue

      for (const scopeSpan of resourceSpan.scopeSpans) {
        if (!Array.isArray(scopeSpan?.spans)) continue

        for (const span of scopeSpan.spans) {
          if (!span) continue

          try {
            const normalized = this._normalizeOneSpan(span, resourceAttrs, source)
            results.push(normalized)
          } catch (err) {
            this._logger.warn({ err, spanId: span.spanId }, 'Failed to normalize span — skipping')
          }
        }
      }
    }

    return results
  }

  private _normalizeOneSpan(
    span: OtlpSpan,
    resourceAttrs: OtlpAttr[] | undefined,
    source: string,
  ): NormalizedSpan {
    const spanId = span.spanId ?? ''
    const traceId = span.traceId ?? ''
    const name = span.name ?? ''

    const model = resolveModel(span.attributes) ?? resolveModel(resourceAttrs)
    const provider = resolveProvider(span.attributes, source)
    const operationName = getAttrString(span.attributes, 'gen_ai.operation.name') ?? name

    // Timestamps
    const startTime = normalizeTimestamp(span.startTimeUnixNano)
    const endTime = span.endTimeUnixNano ? normalizeTimestamp(span.endTimeUnixNano) : undefined
    const durationMs = endTime !== undefined ? endTime - startTime : 0

    // Token extraction
    const fromAttrs = extractTokensFromAttributes(
      span.attributes as Parameters<typeof extractTokensFromAttributes>[0],
    )
    const bodyStr =
      getAttrString(span.attributes, 'llm.response.body') ??
      getAttrString(span.attributes, 'gen_ai.response.body')
    const fromBody = extractTokensFromBody(bodyStr)
    const tokens = mergeTokenCounts(fromAttrs, fromBody)

    // Story key
    const storyKey =
      getAttrString(span.attributes, 'substrate.story_key') ??
      getAttrString(resourceAttrs, 'substrate.story_key')

    // Cost
    const costUsd = model ? estimateCost(model, tokens) : 0

    // Flatten attributes to record
    const attributesRecord: Record<string, unknown> = {}
    if (Array.isArray(span.attributes)) {
      for (const attr of span.attributes) {
        if (attr?.key) {
          attributesRecord[attr.key] =
            attr.value?.stringValue ??
            attr.value?.intValue ??
            attr.value?.doubleValue ??
            attr.value?.boolValue
        }
      }
    }

    return {
      spanId,
      traceId,
      ...(span.parentSpanId !== undefined && { parentSpanId: span.parentSpanId }),
      name,
      source,
      ...(model !== undefined && { model }),
      ...(provider !== undefined && { provider }),
      operationName,
      ...(storyKey !== undefined && { storyKey }),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheCreationTokens: tokens.cacheCreation,
      costUsd,
      durationMs,
      startTime,
      ...(endTime !== undefined && { endTime }),
      attributes: attributesRecord,
      ...(span.events !== undefined && { events: span.events }),
    }
  }

  // -------------------------------------------------------------------------
  // normalizeLog
  // -------------------------------------------------------------------------

  /**
   * Normalize a raw OTLP log payload into an array of `NormalizedLog`.
   *
   * @param raw - Raw OTLP log payload (resourceLogs structure)
   * @param dispatchContext - Optional dispatch context to stamp on each log (Story 30-1)
   * @returns Array of normalized logs; empty on error or empty input
   */
  normalizeLog(raw: unknown, dispatchContext?: DispatchContext): NormalizedLog[] {
    try {
      return this._normalizeLogInternal(raw, dispatchContext)
    } catch (err) {
      this._logger.warn({ err }, 'TelemetryNormalizer.normalizeLog: unexpected error')
      return []
    }
  }

  private _normalizeLogInternal(raw: unknown, dispatchContext?: DispatchContext): NormalizedLog[] {
    if (!raw || typeof raw !== 'object') return []

    const payload = raw as OtlpLogPayload
    if (!Array.isArray(payload.resourceLogs)) return []

    const results: NormalizedLog[] = []

    for (const resourceLog of payload.resourceLogs) {
      if (!resourceLog) continue

      const resourceAttrs = resourceLog.resource?.attributes

      if (!Array.isArray(resourceLog.scopeLogs)) continue

      for (const scopeLog of resourceLog.scopeLogs) {
        if (!Array.isArray(scopeLog?.logRecords)) continue

        for (const record of scopeLog.logRecords) {
          if (!record) continue

          try {
            const normalized = this._normalizeOneLog(record, resourceAttrs, dispatchContext)
            results.push(normalized)
          } catch (err) {
            this._logger.warn({ err }, 'Failed to normalize log record — skipping')
          }
        }
      }
    }

    return results
  }

  private _normalizeOneLog(
    record: OtlpLogRecord,
    resourceAttrs: OtlpAttr[] | undefined,
    dispatchContext?: DispatchContext,
  ): NormalizedLog {
    const logId = record.logRecordId ?? generateLogId()
    const timestamp = normalizeTimestamp(record.timeUnixNano)

    const bodyStr = extractBodyString(record.body)

    // Extract from attributes
    const fromAttrs = extractTokensFromAttributes(
      record.attributes as Parameters<typeof extractTokensFromAttributes>[0],
    )
    const fromBody = extractTokensFromBody(bodyStr)
    const tokens = mergeTokenCounts(fromAttrs, fromBody)

    // Event name
    const eventName =
      getAttrString(record.attributes, 'event.name') ??
      getAttrString(record.attributes, 'gen_ai.event.name') ??
      getAttrString(record.attributes, 'event_name')

    // Session id
    const sessionId =
      getAttrString(record.attributes, 'session.id') ??
      getAttrString(record.attributes, 'gen_ai.session.id') ??
      getAttrString(resourceAttrs, 'session.id')

    // Tool name
    const toolName =
      getAttrString(record.attributes, 'tool.name') ??
      getAttrString(record.attributes, 'gen_ai.tool.name') ??
      getAttrString(record.attributes, 'tool_name')

    // Model
    const model = resolveModel(record.attributes) ?? resolveModel(resourceAttrs)

    // Story key
    const storyKey =
      getAttrString(record.attributes, 'substrate.story_key') ??
      getAttrString(resourceAttrs, 'substrate.story_key')

    // Cost
    const costUsd = model ? estimateCost(model, tokens) : 0

    return {
      logId,
      ...(record.traceId !== undefined && { traceId: record.traceId }),
      ...(record.spanId !== undefined && { spanId: record.spanId }),
      timestamp,
      ...(record.severityText !== undefined && { severity: record.severityText }),
      ...(bodyStr !== undefined && { body: bodyStr }),
      ...(eventName !== undefined && { eventName }),
      ...(sessionId !== undefined && { sessionId }),
      ...(toolName !== undefined && { toolName }),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      costUsd,
      ...(model !== undefined && { model }),
      ...(storyKey !== undefined && { storyKey }),
      ...(dispatchContext !== undefined && {
        taskType: dispatchContext.taskType,
        phase: dispatchContext.phase,
        dispatchId: dispatchContext.dispatchId,
      }),
    }
  }
}
