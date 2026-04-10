/**
 * Tests for repo-map-telemetry.ts
 *
 * AC6: RepoMapTelemetry.recordQuery() calls telemetry.recordSpan with
 *      name: 'repo_map.query' and the passed attributes; error flag included
 *      on error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { RepoMapTelemetry } from '../repo-map-telemetry.js'
import type { ITelemetryPersistence } from '../../telemetry/index.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockLogger(): pino.Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(),
    level: 'debug',
  } as unknown as pino.Logger
}

function createMockTelemetry(): ITelemetryPersistence {
  return {
    recordSpan: vi.fn(),
    purgeStoryTelemetry: vi.fn(async () => {}),
    persistSpan: vi.fn(),
    getSpans: vi.fn(),
    listSpans: vi.fn(),
  } as unknown as ITelemetryPersistence
}

// ---------------------------------------------------------------------------
// AC6: recordQuery — OTEL span emission
// ---------------------------------------------------------------------------

describe('RepoMapTelemetry.recordQuery (AC6 — span emission)', () => {
  let logger: pino.Logger
  let telemetry: ITelemetryPersistence
  let repoMapTelemetry: RepoMapTelemetry

  beforeEach(() => {
    logger = createMockLogger()
    telemetry = createMockTelemetry()
    repoMapTelemetry = new RepoMapTelemetry(telemetry, logger)
  })

  it('AC6: calls telemetry.recordSpan with name: repo_map.query', () => {
    repoMapTelemetry.recordQuery({
      queryDurationMs: 50,
      symbolCount: 10,
      truncated: false,
      filterFields: ['name'],
    })

    expect(telemetry.recordSpan).toHaveBeenCalledOnce()
    const call = vi.mocked(telemetry.recordSpan).mock.calls[0][0]
    expect(call.name).toBe('repo_map.query')
  })

  it('AC6: passes all attributes through to recordSpan', () => {
    const attrs = {
      queryDurationMs: 123,
      symbolCount: 42,
      truncated: true,
      filterFields: ['kind', 'file'],
    }
    repoMapTelemetry.recordQuery(attrs)

    const call = vi.mocked(telemetry.recordSpan).mock.calls[0][0]
    expect(call.attributes).toEqual(attrs)
  })

  it('AC6: includes error: true in attributes when error flag is set', () => {
    repoMapTelemetry.recordQuery({
      queryDurationMs: 5,
      symbolCount: 0,
      truncated: false,
      filterFields: [],
      error: true,
    })

    const call = vi.mocked(telemetry.recordSpan).mock.calls[0][0]
    expect(call.attributes).toMatchObject({ error: true })
  })

  it('AC6: emits a debug log after recording the span', () => {
    repoMapTelemetry.recordQuery({
      queryDurationMs: 30,
      symbolCount: 5,
      truncated: false,
      filterFields: [],
    })

    expect(logger.debug).toHaveBeenCalledOnce()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ queryDurationMs: 30, symbolCount: 5 }),
      expect.any(String)
    )
  })

  it('AC6: multiple calls each emit a separate span', () => {
    repoMapTelemetry.recordQuery({
      queryDurationMs: 10,
      symbolCount: 2,
      truncated: false,
      filterFields: [],
    })
    repoMapTelemetry.recordQuery({
      queryDurationMs: 20,
      symbolCount: 8,
      truncated: true,
      filterFields: ['kind'],
    })

    expect(telemetry.recordSpan).toHaveBeenCalledTimes(2)
  })
})
