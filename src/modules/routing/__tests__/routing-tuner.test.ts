/**
 * Tests for routing-tuner.ts
 *
 * AC4: Happy path — downgrade applied, tune log grows, event emitted
 * AC4: One-step-only guard — only one-step recommendations applied
 * AC5: No-op when auto_tune is false
 * AC5: No-op when insufficient data (< 5 breakdowns)
 * AC6: Tune log grows with each auto-tune invocation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { RoutingTuner } from '../routing-tuner.js'
import { RoutingRecommender } from '../routing-recommender.js'
import type { ModelRoutingConfig } from '../model-routing-config.js'
import type { PhaseTokenBreakdown, RoutingAnalysis, TuneLogEntry } from '../types.js'
import type { StateStore } from '../../state/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock('js-yaml', () => ({
  load: vi.fn(),
  dump: vi.fn(),
}))

import { readFileSync, writeFileSync } from 'node:fs'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'

const mockReadFileSync = vi.mocked(readFileSync)
const mockWriteFileSync = vi.mocked(writeFileSync)
const mockYamlLoad = vi.mocked(yamlLoad)
const mockYamlDump = vi.mocked(yamlDump)

// ---------------------------------------------------------------------------
// Helper: create mock logger
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

// ---------------------------------------------------------------------------
// Helper: create mock StateStore
// ---------------------------------------------------------------------------

function createMockStateStore(): StateStore {
  const kvStore: Record<string, Record<string, unknown>> = {}

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getStoryState: vi.fn().mockResolvedValue(undefined),
    setStoryState: vi.fn().mockResolvedValue(undefined),
    queryStories: vi.fn().mockResolvedValue([]),
    recordMetric: vi.fn().mockResolvedValue(undefined),
    queryMetrics: vi.fn().mockResolvedValue([]),
    setMetric: vi.fn().mockImplementation(async (runId: string, key: string, value: unknown) => {
      if (kvStore[runId] === undefined) kvStore[runId] = {}
      kvStore[runId][key] = value
    }),
    getMetric: vi.fn().mockImplementation(async (runId: string, key: string) => {
      return kvStore[runId]?.[key]
    }),
    getContracts: vi.fn().mockResolvedValue([]),
    setContracts: vi.fn().mockResolvedValue(undefined),
    queryContracts: vi.fn().mockResolvedValue([]),
    setContractVerification: vi.fn().mockResolvedValue(undefined),
    getContractVerification: vi.fn().mockResolvedValue([]),
    branchForStory: vi.fn().mockResolvedValue(undefined),
    mergeStory: vi.fn().mockResolvedValue(undefined),
    rollbackStory: vi.fn().mockResolvedValue(undefined),
    diffStory: vi.fn().mockResolvedValue({ storyKey: '', tables: [] }),
    getHistory: vi.fn().mockResolvedValue([]),
  } as unknown as StateStore
}

// ---------------------------------------------------------------------------
// Helper: create mock EventBus
// ---------------------------------------------------------------------------

function createMockEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus
}

// ---------------------------------------------------------------------------
// Helper: base routing config
// ---------------------------------------------------------------------------

const BASE_CONFIG: ModelRoutingConfig = {
  version: 1,
  baseline_model: 'claude-sonnet-4-5',
  auto_tune: true,
  phases: {
    explore: { model: 'claude-sonnet-4-5' },
    generate: { model: 'claude-sonnet-4-5' },
    review: { model: 'claude-sonnet-4-5' },
  },
}

const DISABLED_CONFIG: ModelRoutingConfig = {
  ...BASE_CONFIG,
  auto_tune: false,
}

/**
 * Build a PhaseTokenBreakdown with a low output ratio (triggering downgrade).
 * inputTokens:outputTokens = 9:1 → ratio ≈ 0.1 (below 0.15 threshold)
 */
function makeLowRatioBreakdown(runId: string): PhaseTokenBreakdown {
  return {
    runId,
    baselineModel: 'claude-sonnet-4-5',
    entries: [
      {
        phase: 'explore',
        model: 'claude-sonnet-4-5',
        inputTokens: 9000,
        outputTokens: 1000,
        dispatchCount: 5,
      },
    ],
  }
}

/**
 * Seed a state store with N breakdowns under sequential run IDs,
 * registering them in the run index as RoutingTuner expects.
 */
async function seedBreakdowns(stateStore: StateStore, count: number): Promise<void> {
  const runIds: string[] = []
  for (let i = 0; i < count; i++) {
    const runId = `seed-run-${i}`
    runIds.push(runId)
    await stateStore.setMetric(runId, 'phase_token_breakdown', makeLowRatioBreakdown(runId))
  }
  await stateStore.setMetric('__global__', 'phase_token_breakdown_runs', runIds)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // Default YAML mock: return a parseable config object
  mockYamlLoad.mockReturnValue({
    version: 1,
    baseline_model: 'claude-sonnet-4-5',
    auto_tune: true,
    phases: {
      explore: { model: 'claude-sonnet-4-5' },
    },
  })
  mockYamlDump.mockReturnValue('version: 1\nbaseline_model: claude-sonnet-4-5\n')
  mockReadFileSync.mockReturnValue('dummy yaml content' as unknown as Buffer)
  mockWriteFileSync.mockReturnValue(undefined)
})

// ---------------------------------------------------------------------------
// AC5: No-op when auto_tune is false
// ---------------------------------------------------------------------------

describe('RoutingTuner.maybeAutoTune — no-op when auto_tune disabled (AC5)', () => {
  it('returns immediately without loading breakdowns when auto_tune is false', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())

    await tuner.maybeAutoTune('run-001', DISABLED_CONFIG)

    // Should not read the run index or breakdowns
    expect(stateStore.getMetric).not.toHaveBeenCalled()
    expect(stateStore.setMetric).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('returns immediately when auto_tune is undefined', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    const configNoTune: ModelRoutingConfig = { ...BASE_CONFIG, auto_tune: undefined }
    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())

    await tuner.maybeAutoTune('run-001', configNoTune)

    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC5: No-op with insufficient data
// ---------------------------------------------------------------------------

describe('RoutingTuner.maybeAutoTune — no-op with insufficient data (AC5)', () => {
  it('does not apply any change when fewer than 5 breakdowns exist', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    // Only 3 breakdowns seeded (below the 5-breakdown threshold in RoutingTuner)
    await seedBreakdowns(stateStore, 3)

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-new', BASE_CONFIG)

    // No file writes, no event emitted
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('does not apply any change when exactly 4 breakdowns exist', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    await seedBreakdowns(stateStore, 4)

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-new', BASE_CONFIG)

    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC4: Happy path — downgrade applied
// ---------------------------------------------------------------------------

describe('RoutingTuner.maybeAutoTune — happy path (AC4)', () => {
  it('applies a downgrade recommendation when 5+ breakdowns with low output ratio', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    // Seed 6 breakdowns with low output ratio → downgrade recommendation
    await seedBreakdowns(stateStore, 6)

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-new', BASE_CONFIG)

    // Config file should be written
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
    const writeArgs = mockWriteFileSync.mock.calls[0]!
    expect(writeArgs[0]).toBe('/path/routing.yml')

    // Event should be emitted
    expect(eventBus.emit).toHaveBeenCalledOnce()
    const [eventName, payload] = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(eventName).toBe('routing:auto-tuned')
    expect(payload).toMatchObject({
      runId: 'run-new',
      phase: 'explore',
      oldModel: 'claude-sonnet-4-5',
    })
    expect((payload as { newModel: string }).newModel.toLowerCase()).toContain('haiku')
  })

  it('registers the current runId in the run index', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    await seedBreakdowns(stateStore, 6)

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-new', BASE_CONFIG)

    // The run index should have been updated to include run-new
    const runIndex = await stateStore.getMetric('__global__', 'phase_token_breakdown_runs')
    expect(Array.isArray(runIndex)).toBe(true)
    expect(runIndex as string[]).toContain('run-new')
  })
})

// ---------------------------------------------------------------------------
// AC6: Tune log growth
// ---------------------------------------------------------------------------

describe('RoutingTuner.maybeAutoTune — tune log growth (AC6)', () => {
  it('appends to the tune log on each successful invocation', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    // First run
    await seedBreakdowns(stateStore, 6)
    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-A', BASE_CONFIG)

    const logAfterFirst = await stateStore.getMetric('__global__', 'routing_tune_log')
    expect(Array.isArray(logAfterFirst)).toBe(true)
    expect((logAfterFirst as TuneLogEntry[]).length).toBe(1)

    // Second run (new breakdowns needed — add them to the run index)
    await stateStore.setMetric('run-B-extra', 'phase_token_breakdown', makeLowRatioBreakdown('run-B-extra'))
    const existingIds = await stateStore.getMetric('__global__', 'phase_token_breakdown_runs') as string[]
    await stateStore.setMetric('__global__', 'phase_token_breakdown_runs', [...existingIds, 'run-B-extra'])

    // Reset mocks so writeFileSync/emit are callable again
    vi.mocked(eventBus.emit).mockClear()
    mockWriteFileSync.mockClear()

    await tuner.maybeAutoTune('run-B', BASE_CONFIG)

    const logAfterSecond = await stateStore.getMetric('__global__', 'routing_tune_log')
    expect(Array.isArray(logAfterSecond)).toBe(true)
    expect((logAfterSecond as TuneLogEntry[]).length).toBe(2)
  })

  it('each tune log entry has required fields', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    await seedBreakdowns(stateStore, 6)
    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-check', BASE_CONFIG)

    const log = await stateStore.getMetric('__global__', 'routing_tune_log') as TuneLogEntry[]
    const entry = log[0]!

    expect(entry).toBeDefined()
    expect(typeof entry.id).toBe('string')
    expect(entry.id.length).toBeGreaterThan(0)
    expect(entry.runId).toBe('run-check')
    expect(typeof entry.phase).toBe('string')
    expect(typeof entry.oldModel).toBe('string')
    expect(typeof entry.newModel).toBe('string')
    expect(typeof entry.estimatedSavingsPct).toBe('number')
    expect(typeof entry.appliedAt).toBe('string')
    // appliedAt should be a valid ISO timestamp
    expect(new Date(entry.appliedAt).getTime()).not.toBeNaN()
  })
})

// ---------------------------------------------------------------------------
// AC4: One-step-only guard
// ---------------------------------------------------------------------------

describe('RoutingTuner.maybeAutoTune — one-step-only guard (AC4)', () => {
  it('applies at most one phase change per invocation', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    // Seed breakdowns where multiple phases have low output ratio
    const multiPhaseBreakdown = (runId: string): PhaseTokenBreakdown => ({
      runId,
      baselineModel: 'claude-sonnet-4-5',
      entries: [
        { phase: 'explore', model: 'claude-sonnet-4-5', inputTokens: 9000, outputTokens: 500, dispatchCount: 3 },
        { phase: 'generate', model: 'claude-sonnet-4-5', inputTokens: 9000, outputTokens: 500, dispatchCount: 3 },
        { phase: 'review', model: 'claude-sonnet-4-5', inputTokens: 9000, outputTokens: 500, dispatchCount: 3 },
      ],
    })

    const runIds: string[] = []
    for (let i = 0; i < 6; i++) {
      const runId = `multi-run-${i}`
      runIds.push(runId)
      await stateStore.setMetric(runId, 'phase_token_breakdown', multiPhaseBreakdown(runId))
    }
    await stateStore.setMetric('__global__', 'phase_token_breakdown_runs', runIds)

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-new', BASE_CONFIG)

    // Only one event should be emitted (one phase changed)
    expect(eventBus.emit).toHaveBeenCalledOnce()
    // Only one file write
    expect(mockWriteFileSync).toHaveBeenCalledOnce()
  })

  it('rejects a two-step tier-jump recommendation (opus→haiku) — no config write', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    // Seed enough breakdowns so the data-threshold is met
    await seedBreakdowns(stateStore, 6)

    // Spy on the recommender to return a two-step opus→haiku recommendation
    vi.spyOn(recommender, 'analyze').mockReturnValue({
      recommendations: [
        {
          phase: 'explore',
          currentModel: 'claude-opus-4',
          suggestedModel: 'claude-3-haiku',
          estimatedSavingsPct: 33,
          confidence: 0.6,
          dataPoints: 6,
          direction: 'downgrade',
        },
      ],
      analysisRuns: 6,
      insufficientData: false,
      phaseOutputRatios: { explore: 0.10 },
    })

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-two-step', BASE_CONFIG)

    // Two-step jump (opus tier=3, haiku tier=1, diff=2) must be rejected — no write, no event
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC5: no_safe_recommendation — neutral-zone ratios
// ---------------------------------------------------------------------------

describe('RoutingTuner.maybeAutoTune — no_safe_recommendation when all phases are neutral (AC5)', () => {
  it('does not write config when all phase output ratios are in neutral zone (0.15–0.40)', async () => {
    const stateStore = createMockStateStore()
    const recommender = new RoutingRecommender(createMockLogger())
    const eventBus = createMockEventBus()

    // Build breakdowns where explore phase has a neutral output ratio (~0.25)
    const neutralBreakdown = (runId: string): PhaseTokenBreakdown => ({
      runId,
      baselineModel: 'claude-sonnet-4-5',
      entries: [
        {
          phase: 'explore',
          model: 'claude-sonnet-4-5',
          inputTokens: 7500,
          outputTokens: 2500, // ratio = 2500/10000 = 0.25 — neutral
          dispatchCount: 3,
        },
      ],
    })

    const runIds: string[] = []
    for (let i = 0; i < 6; i++) {
      const runId = `neutral-run-${i}`
      runIds.push(runId)
      await stateStore.setMetric(runId, 'phase_token_breakdown', neutralBreakdown(runId))
    }
    await stateStore.setMetric('__global__', 'phase_token_breakdown_runs', runIds)

    const tuner = new RoutingTuner(stateStore, recommender, eventBus, '/path/routing.yml', createMockLogger())
    await tuner.maybeAutoTune('run-neutral', BASE_CONFIG)

    // Neutral zone produces no downgrade candidates → no_safe_recommendation path
    expect(mockWriteFileSync).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
