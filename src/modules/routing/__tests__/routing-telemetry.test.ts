/**
 * Tests for routing-telemetry.ts
 *
 * AC5: RoutingTelemetry.recordModelResolved() calls telemetry.recordSpan with
 *      name: 'routing.model_resolved' and the passed attributes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { RoutingTelemetry } from '../routing-telemetry.js'
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
    // minimal no-ops for any other ITelemetryPersistence methods
    persistSpan: vi.fn(),
    getSpans: vi.fn(),
    listSpans: vi.fn(),
  } as unknown as ITelemetryPersistence
}

// ---------------------------------------------------------------------------
// AC5: recordModelResolved — OTEL span emission
// ---------------------------------------------------------------------------

describe('RoutingTelemetry.recordModelResolved (AC5 — span emission)', () => {
  let logger: pino.Logger
  let telemetry: ITelemetryPersistence
  let routingTelemetry: RoutingTelemetry

  beforeEach(() => {
    logger = createMockLogger()
    telemetry = createMockTelemetry()
    routingTelemetry = new RoutingTelemetry(telemetry, logger)
  })

  it('AC5: calls telemetry.recordSpan with name: routing.model_resolved', () => {
    routingTelemetry.recordModelResolved({
      dispatchId: 'dispatch-1',
      taskType: 'dev-story',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
      source: 'phase',
      latencyMs: 42,
    })

    expect(telemetry.recordSpan).toHaveBeenCalledOnce()
    const call = vi.mocked(telemetry.recordSpan).mock.calls[0][0]
    expect(call.name).toBe('routing.model_resolved')
  })

  it('AC5: passes all attributes through to recordSpan', () => {
    const attrs = {
      dispatchId: 'dispatch-99',
      taskType: 'code-review',
      phase: 'review',
      model: 'claude-haiku-4-5',
      source: 'override',
      latencyMs: 123,
    }
    routingTelemetry.recordModelResolved(attrs)

    const call = vi.mocked(telemetry.recordSpan).mock.calls[0][0]
    expect(call.attributes).toEqual(attrs)
  })

  it('AC5: emits a debug log after recording the span', () => {
    routingTelemetry.recordModelResolved({
      dispatchId: 'dispatch-1',
      taskType: 'dev-story',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
      source: 'phase',
      latencyMs: 10,
    })

    expect(logger.debug).toHaveBeenCalledOnce()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'dispatch-1', phase: 'generate' }),
      expect.any(String),
    )
  })

  it('AC5: source: override is passed correctly', () => {
    routingTelemetry.recordModelResolved({
      dispatchId: 'dispatch-override',
      taskType: 'dev-story',
      phase: 'generate',
      model: 'claude-opus-4-6',
      source: 'override',
      latencyMs: 5,
    })

    const call = vi.mocked(telemetry.recordSpan).mock.calls[0][0]
    expect(call.attributes).toMatchObject({ source: 'override', model: 'claude-opus-4-6' })
  })

  it('AC5: multiple calls each emit a separate span', () => {
    routingTelemetry.recordModelResolved({
      dispatchId: 'dispatch-1',
      taskType: 'dev-story',
      phase: 'generate',
      model: 'claude-sonnet-4-5',
      source: 'phase',
      latencyMs: 10,
    })
    routingTelemetry.recordModelResolved({
      dispatchId: 'dispatch-2',
      taskType: 'code-review',
      phase: 'review',
      model: 'claude-haiku-4-5',
      source: 'phase',
      latencyMs: 20,
    })

    expect(telemetry.recordSpan).toHaveBeenCalledTimes(2)
  })
})
