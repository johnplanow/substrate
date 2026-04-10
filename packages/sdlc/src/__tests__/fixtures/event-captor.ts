/**
 * Event capture and parity assertion helpers — Story 43-12.
 *
 * Provides:
 * - CapturedEvent: type for captured SDLC orchestrator events
 * - buildEventCaptor: factory for capturing orchestrator:* events
 * - assertEventSequenceParity: compares event-name sequences and throws on divergence
 * - buildReferenceEvents: builds expected event sequence from a fixture story
 */

import type { YnabFixtureStory } from './ynab-cross-project-fixture.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A captured SDLC orchestrator event with its position in the event stream. */
export interface CapturedEvent {
  eventName: string
  storyKey: string
  sequenceIdx: number
}

/** Minimal bus interface compatible with SdlcEventBus and vi.fn() mocks. */
export interface CapturableBus {
  emit(event: string, payload: unknown): void
}

// ---------------------------------------------------------------------------
// buildEventCaptor
// ---------------------------------------------------------------------------

/**
 * Factory that intercepts `orchestrator:*` events and captures them.
 *
 * Optionally wraps an underlying bus — events are forwarded to it after capture.
 * The storyKey is extracted from the event payload (all orchestrator events
 * include `storyKey` in their payload).
 *
 * @param underlyingBus - Optional underlying bus to forward all events to.
 * @returns Object with capturing `bus` (pass to createSdlcEventBridge), `events`
 *          array, and `reset()`.
 */
export function buildEventCaptor(underlyingBus?: CapturableBus): {
  events: CapturedEvent[]
  bus: CapturableBus
  reset(): void
} {
  const events: CapturedEvent[] = []

  const bus: CapturableBus = {
    emit(eventName: string, payload: unknown): void {
      if (eventName.startsWith('orchestrator:')) {
        const storyKey = ((payload as Record<string, unknown>)?.storyKey as string) ?? ''
        events.push({ eventName, storyKey, sequenceIdx: events.length })
      }
      underlyingBus?.emit(eventName, payload)
    },
  }

  return {
    events,
    bus,
    reset(): void {
      events.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// assertEventSequenceParity
// ---------------------------------------------------------------------------

/**
 * Compares the event-name sequences of two captured event streams.
 *
 * Performs element-by-element comparison first (finds earliest divergence),
 * then checks for length mismatches. Throws a descriptive error on any
 * divergence, including the story key and the index of first divergence.
 *
 * @param referenceEvents - Expected event stream (e.g. from buildReferenceEvents)
 * @param graphEvents - Actual event stream from graph engine
 * @param storyKey - Story key included in the error message on mismatch
 */
export function assertEventSequenceParity(
  referenceEvents: CapturedEvent[],
  graphEvents: CapturedEvent[],
  storyKey: string
): void {
  const refNames = referenceEvents.map((e) => e.eventName)
  const graphNames = graphEvents.map((e) => e.eventName)
  const minLen = Math.min(refNames.length, graphNames.length)

  for (let i = 0; i < minLen; i++) {
    if (refNames[i] !== graphNames[i]) {
      throw new Error(
        `assertEventSequenceParity: event sequence divergence for story '${storyKey}' at index ${i}. ` +
          `Expected '${refNames[i]}', got '${graphNames[i]}'.`
      )
    }
  }

  if (refNames.length !== graphNames.length) {
    throw new Error(
      `assertEventSequenceParity: event sequence length mismatch for story '${storyKey}'. ` +
        `Expected ${refNames.length} events, got ${graphNames.length}. ` +
        `First divergence at index ${minLen}.`
    )
  }
}

// ---------------------------------------------------------------------------
// buildReferenceEvents
// ---------------------------------------------------------------------------

/** Node IDs that the SDLC event bridge translates (all others are silently ignored). */
const SDLC_NODES = new Set([
  'analysis',
  'planning',
  'solutioning',
  'create_story',
  'dev_story',
  'code_review',
])

/**
 * Builds the expected SDLC event-name sequence for a fixture story.
 * Mirrors the translation logic in `createSdlcEventBridge`.
 *
 * For each SDLC-mapped phase:
 *   - `orchestrator:story-phase-start`
 *   - `orchestrator:story-phase-complete`
 *
 * Terminal event:
 *   - If last phase is code_review FAIL → `orchestrator:story-escalated`
 *   - Otherwise → `orchestrator:story-complete`
 */
export function buildReferenceEvents(story: YnabFixtureStory): CapturedEvent[] {
  const events: CapturedEvent[] = []
  let seq = 0

  for (const phase of story.phases) {
    if (!SDLC_NODES.has(phase.nodeId)) continue
    events.push({
      eventName: 'orchestrator:story-phase-start',
      storyKey: story.storyKey,
      sequenceIdx: seq++,
    })
    events.push({
      eventName: 'orchestrator:story-phase-complete',
      storyKey: story.storyKey,
      sequenceIdx: seq++,
    })
  }

  const lastPhase = story.phases[story.phases.length - 1]
  if (lastPhase?.nodeId === 'code_review' && lastPhase.outcomeStatus === 'FAIL') {
    events.push({
      eventName: 'orchestrator:story-escalated',
      storyKey: story.storyKey,
      sequenceIdx: seq++,
    })
  } else {
    events.push({
      eventName: 'orchestrator:story-complete',
      storyKey: story.storyKey,
      sequenceIdx: seq++,
    })
  }

  return events
}
