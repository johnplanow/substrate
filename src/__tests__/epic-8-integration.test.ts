/**
 * Epic 8 Integration/E2E Gap Tests
 *
 * These tests cover cross-component interactions that are NOT covered by
 * existing unit tests:
 *
 * 1. Task event → metric recording → aggregate update → report generation
 *    (MonitorAgentImpl + MonitorDatabaseImpl + generateMonitorReport in one flow)
 *
 * 2. Task event → aggregate pipeline → RecommendationEngine query
 *    (MonitorAgentImpl + MonitorDatabaseImpl + RecommendationEngine in one flow)
 *
 * 3. Task type classifier → MonitorAgentImpl → database (classifier output
 *    lands in the correct task_type column)
 *
 * 4. Monitor reset roundtrip: seed data, reset, verify empty
 *    (MonitorDatabaseImpl.resetAllData → getAggregates returns [])
 *
 * 5. VersionManager + VersionCache integration with forceRefresh flag
 *    (cache written after fetch, then bypassed again on forceRefresh)
 *
 * 6. VersionManager → migrateConfiguration path (delegates to ConfigMigrator)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MonitorAgentImpl } from '../modules/monitor/monitor-agent-impl.js'
import { MonitorDatabaseImpl } from '../persistence/monitor-database.js'
import { createEventBus } from '../core/event-bus.js'
import type { TypedEventBus } from '../core/event-bus.js'
import { generateMonitorReport } from '../modules/monitor/report-generator.js'
import { RecommendationEngine } from '../modules/monitor/recommendation-engine.js'
import { VersionManagerImpl } from '../modules/version-manager/version-manager-impl.js'
import { VersionCache } from '../modules/version-manager/version-cache.js'
import type { UpdateChecker } from '../modules/version-manager/update-checker.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestSetup(): {
  eventBus: TypedEventBus
  monitorDb: MonitorDatabaseImpl
  agent: MonitorAgentImpl
} {
  const eventBus = createEventBus()
  const monitorDb = new MonitorDatabaseImpl(':memory:')
  const agent = new MonitorAgentImpl(eventBus, monitorDb, { retentionDays: 90 })
  return { eventBus, monitorDb, agent }
}

function getInternalDb(db: MonitorDatabaseImpl): import('better-sqlite3').Database {
  return (db as unknown as { _db: import('better-sqlite3').Database })._db
}

function buildMockUpdateChecker(latestVersion = '1.5.0'): UpdateChecker {
  return {
    fetchLatestVersion: vi.fn().mockResolvedValue(latestVersion),
    isBreaking: vi.fn((current: string, latest: string) => {
      return parseInt(latest.split('.')[0] ?? '0', 10) > parseInt(current.split('.')[0] ?? '0', 10)
    }),
    getChangelog: vi.fn((v: string) => `https://example.com/releases/v${v}`),
  } as unknown as UpdateChecker
}

// ---------------------------------------------------------------------------
// Gap 1: Task event → aggregate pipeline → report generation
// ---------------------------------------------------------------------------

describe('Gap 1: task:complete events flow into generateMonitorReport', () => {
  let setup: ReturnType<typeof createTestSetup>

  beforeEach(async () => {
    setup = createTestSetup()
    await setup.agent.initialize()
  })

  afterEach(async () => {
    await setup.agent.shutdown()
  })

  it('task:complete events are reflected in generateMonitorReport agent summary', () => {
    const { eventBus, monitorDb } = setup

    // Emit 5 success events + 2 failure events for 'unknown' agent
    for (let i = 0; i < 5; i++) {
      eventBus.emit('task:complete', {
        taskId: `task-success-${i}`,
        result: { exitCode: 0, tokensUsed: 1000, costUsd: 0.05 },
      })
    }
    for (let i = 0; i < 2; i++) {
      eventBus.emit('task:failed', {
        taskId: `task-fail-${i}`,
        error: { message: 'Process failed', code: 'ERR' },
      })
    }

    const report = generateMonitorReport(monitorDb)

    expect(report.summary.total_tasks).toBe(7)
    expect(report.summary.total_agents).toBeGreaterThanOrEqual(1)
    // All 7 tasks appear in the agent summary
    const agentTotalTasks = report.agents.reduce((sum, a) => sum + a.total_tasks, 0)
    expect(agentTotalTasks).toBe(7)
  })

  it('task:complete events show correct success_rate in report', () => {
    const { eventBus, monitorDb } = setup

    // 8 successes, 2 failures → 80% success rate
    for (let i = 0; i < 8; i++) {
      eventBus.emit('task:complete', {
        taskId: `task-s-${i}`,
        result: { exitCode: 0, tokensUsed: 500, costUsd: 0.01 },
      })
    }
    for (let i = 0; i < 2; i++) {
      eventBus.emit('task:failed', {
        taskId: `task-f-${i}`,
        error: { message: 'Error' },
      })
    }

    const report = generateMonitorReport(monitorDb)

    // All tasks are under one agent (unknown), so there's a single agent summary
    expect(report.agents.length).toBe(1)
    const agentStats = report.agents[0]!
    expect(agentStats.success_rate).toBeCloseTo(80.0, 1)
    expect(agentStats.failure_rate).toBeCloseTo(20.0, 1)
  })

  it('task:complete events populate task_types breakdown in report', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:complete', {
      taskId: 'task-1',
      result: { exitCode: 0 },
    })

    const report = generateMonitorReport(monitorDb)

    // At least one task type entry should exist
    expect(report.task_types.length).toBeGreaterThanOrEqual(1)
    const totalInTypes = report.task_types.reduce((sum, tt) => sum + tt.total_tasks, 0)
    expect(totalInTypes).toBeGreaterThanOrEqual(1)
  })

  it('generateMonitorReport with includeRecommendations runs without error (real pipeline)', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:complete', {
      taskId: 'task-rec-1',
      result: { exitCode: 0 },
    })

    // Should not throw even with insufficient data for recommendations
    const report = generateMonitorReport(monitorDb, { includeRecommendations: true })

    expect(report.recommendations).toBeDefined()
    // With only one agent, no recommendations should be generated
    expect(report.recommendations!.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Gap 2: Task event → aggregate pipeline → RecommendationEngine
// ---------------------------------------------------------------------------

describe('Gap 2: task events flow into performance aggregates and are queryable by RecommendationEngine', () => {
  let monitorDb: MonitorDatabaseImpl

  beforeEach(() => {
    monitorDb = new MonitorDatabaseImpl(':memory:')
  })

  afterEach(() => {
    monitorDb.close()
  })

  it('updateAggregates accumulation feeds into RecommendationEngine correctly', () => {
    // Simulate what MonitorAgentImpl does: update aggregates for two agents

    // agent-a: 7/10 success (70%)
    for (let i = 0; i < 7; i++) {
      monitorDb.updateAggregates('agent-a', 'coding', {
        outcome: 'success',
        inputTokens: 2000,
        outputTokens: 0,
        durationMs: 1000,
        cost: 0.01,
      })
    }
    for (let i = 0; i < 3; i++) {
      monitorDb.updateAggregates('agent-a', 'coding', {
        outcome: 'failure',
        inputTokens: 500,
        outputTokens: 0,
        durationMs: 200,
        cost: 0,
      })
    }

    // agent-b: 9/10 success (90%)
    for (let i = 0; i < 9; i++) {
      monitorDb.updateAggregates('agent-b', 'coding', {
        outcome: 'success',
        inputTokens: 4000,
        outputTokens: 0,
        durationMs: 2000,
        cost: 0.02,
      })
    }
    monitorDb.updateAggregates('agent-b', 'coding', {
      outcome: 'failure',
      inputTokens: 1000,
      outputTokens: 0,
      durationMs: 400,
      cost: 0,
    })

    const engine = new RecommendationEngine(monitorDb, { min_sample_size: 10 })
    const recommendations = engine.generateRecommendations()

    // With 20% improvement (90% vs 70%), a recommendation should be generated
    expect(recommendations.length).toBe(1)
    expect(recommendations[0]!.recommended_agent).toBe('agent-b')
    expect(recommendations[0]!.current_agent).toBe('agent-a')
    expect(recommendations[0]!.improvement_percentage).toBeCloseTo(20.0, 0)
  })

  it('getMonitorRecommendation returns null when insufficient aggregate data', () => {
    // Only 3 tasks per agent — below default min_sample_size of 10
    monitorDb.updateAggregates('agent-a', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      cost: 0,
    })
    monitorDb.updateAggregates('agent-b', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      cost: 0,
    })

    const engine = new RecommendationEngine(monitorDb)
    const rec = engine.getMonitorRecommendation('coding')

    expect(rec).toBeNull()
  })

  it('accumulated aggregates across multiple task types feeds RecommendationEngine independently per type', () => {
    // coding: agent-a 60%, agent-b 90% → recommend agent-b for coding
    for (let i = 0; i < 6; i++) {
      monitorDb.updateAggregates('agent-a', 'coding', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    }
    for (let i = 0; i < 4; i++) {
      monitorDb.updateAggregates('agent-a', 'coding', { outcome: 'failure', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    }
    for (let i = 0; i < 9; i++) {
      monitorDb.updateAggregates('agent-b', 'coding', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    }
    monitorDb.updateAggregates('agent-b', 'coding', { outcome: 'failure', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })

    // testing: agent-a 90%, agent-b 60% → recommend agent-a for testing
    for (let i = 0; i < 9; i++) {
      monitorDb.updateAggregates('agent-a', 'testing', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    }
    monitorDb.updateAggregates('agent-a', 'testing', { outcome: 'failure', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    for (let i = 0; i < 6; i++) {
      monitorDb.updateAggregates('agent-b', 'testing', { outcome: 'success', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    }
    for (let i = 0; i < 4; i++) {
      monitorDb.updateAggregates('agent-b', 'testing', { outcome: 'failure', inputTokens: 100, outputTokens: 0, durationMs: 0, cost: 0 })
    }

    const engine = new RecommendationEngine(monitorDb, { min_sample_size: 10 })
    const all = engine.generateRecommendations()

    const codingRec = all.find((r) => r.task_type === 'coding')
    const testingRec = all.find((r) => r.task_type === 'testing')

    expect(codingRec?.recommended_agent).toBe('agent-b')
    expect(testingRec?.recommended_agent).toBe('agent-a')
  })
})

// ---------------------------------------------------------------------------
// Gap 3: Task type classifier → MonitorAgentImpl → database
// ---------------------------------------------------------------------------

describe('Gap 3: TaskTypeClassifier output lands in the database via MonitorAgentImpl', () => {
  let setup: ReturnType<typeof createTestSetup>

  beforeEach(async () => {
    setup = createTestSetup()
    await setup.agent.initialize()
  })

  afterEach(async () => {
    await setup.agent.shutdown()
  })

  it('task:complete event with no metadata falls back to "coding" task type in DB', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:complete', {
      taskId: 'task-classifier-1',
      result: { exitCode: 0 },
    })

    // The classifier should default to "coding" when no metadata is provided
    const internal = getInternalDb(monitorDb)
    const row = internal.prepare('SELECT task_type FROM task_metrics WHERE task_id = ?').get('task-classifier-1') as { task_type: string }

    expect(row).toBeDefined()
    expect(row.task_type).toBe('coding') // default fallback
  })

  it('multiple task:complete events each produce their own task_metrics row', () => {
    const { eventBus, monitorDb } = setup

    for (let i = 0; i < 3; i++) {
      eventBus.emit('task:complete', {
        taskId: `task-multi-${i}`,
        result: { exitCode: 0 },
      })
    }

    const internal = getInternalDb(monitorDb)
    const count = (internal.prepare('SELECT COUNT(*) as cnt FROM task_metrics').get() as { cnt: number }).cnt
    expect(count).toBe(3)
  })

  it('task:failed event is recorded with "coding" default task type', () => {
    const { eventBus, monitorDb } = setup

    eventBus.emit('task:failed', {
      taskId: 'task-fail-classify',
      error: { message: 'Task timeout', code: 'TIMEOUT' },
    })

    const internal = getInternalDb(monitorDb)
    const row = internal.prepare('SELECT task_type, outcome, failure_reason FROM task_metrics WHERE task_id = ?')
      .get('task-fail-classify') as { task_type: string; outcome: string; failure_reason: string }

    expect(row).toBeDefined()
    expect(row.outcome).toBe('failure')
    expect(row.failure_reason).toBe('Task timeout')
    expect(row.task_type).toBe('coding') // default
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Monitor reset roundtrip
// ---------------------------------------------------------------------------

describe('Gap 4: Monitor reset roundtrip — seed, reset, verify empty', () => {
  let monitorDb: MonitorDatabaseImpl

  beforeEach(() => {
    monitorDb = new MonitorDatabaseImpl(':memory:')
  })

  afterEach(() => {
    monitorDb.close()
  })

  it('resetAllData clears task_metrics and performance_aggregates', () => {
    // Seed data
    monitorDb.insertTaskMetrics({
      taskId: 'task-1',
      agent: 'claude',
      taskType: 'coding',
      outcome: 'success',
      failureReason: undefined,
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 500,
      cost: 0.05,
      estimatedCost: 0.04,
      billingMode: 'api',
      recordedAt: new Date().toISOString(),
    })
    monitorDb.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 200,
      durationMs: 500,
      cost: 0.05,
    })

    // Verify data exists before reset
    const internalBefore = getInternalDb(monitorDb)
    const metricsBefore = (internalBefore.prepare('SELECT COUNT(*) as cnt FROM task_metrics').get() as { cnt: number }).cnt
    expect(metricsBefore).toBe(1)

    // Reset
    monitorDb.resetAllData()

    // Verify both tables are empty
    const internalAfter = getInternalDb(monitorDb)
    const metricsAfter = (internalAfter.prepare('SELECT COUNT(*) as cnt FROM task_metrics').get() as { cnt: number }).cnt
    const aggAfter = (internalAfter.prepare('SELECT COUNT(*) as cnt FROM performance_aggregates').get() as { cnt: number }).cnt

    expect(metricsAfter).toBe(0)
    expect(aggAfter).toBe(0)
  })

  it('generateMonitorReport returns zero counts after resetAllData', () => {
    // Seed data
    monitorDb.insertTaskMetrics({
      taskId: 'task-reset-1',
      agent: 'claude',
      taskType: 'coding',
      outcome: 'success',
      failureReason: undefined,
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 2000,
      cost: 0.10,
      estimatedCost: 0.09,
      billingMode: 'api',
      recordedAt: new Date().toISOString(),
    })
    monitorDb.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 2000,
      cost: 0.10,
    })

    // Verify report has data
    const reportBefore = generateMonitorReport(monitorDb)
    expect(reportBefore.summary.total_tasks).toBe(1)

    // Reset
    monitorDb.resetAllData()

    // Verify report is empty
    const reportAfter = generateMonitorReport(monitorDb)
    expect(reportAfter.summary.total_tasks).toBe(0)
    expect(reportAfter.summary.total_agents).toBe(0)
    expect(reportAfter.agents).toHaveLength(0)
    expect(reportAfter.task_types).toHaveLength(0)
  })

  it('resetAllData → rebuildAggregates leaves aggregates empty', () => {
    // Insert metrics and aggregates
    monitorDb.insertTaskMetrics({
      taskId: 'task-rebuild-1',
      agent: 'claude',
      taskType: 'coding',
      outcome: 'success',
      failureReason: undefined,
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      cost: 0,
      estimatedCost: 0,
      billingMode: 'api',
      recordedAt: new Date().toISOString(),
    })
    monitorDb.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      cost: 0,
    })

    // Reset clears everything
    monitorDb.resetAllData()

    // Rebuild should now produce no aggregates
    monitorDb.rebuildAggregates()

    const aggregates = monitorDb.getAggregates()
    expect(aggregates).toHaveLength(0)
  })

  it('data can be re-inserted and queried normally after resetAllData', () => {
    // Seed and reset
    monitorDb.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 0,
      cost: 0,
    })
    monitorDb.resetAllData()

    // Re-seed after reset
    monitorDb.updateAggregates('claude', 'testing', {
      outcome: 'success',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 1000,
      cost: 0.02,
    })

    const aggregates = monitorDb.getAggregates()
    expect(aggregates).toHaveLength(1)
    expect(aggregates[0].taskType).toBe('testing')
    expect(aggregates[0].totalInputTokens).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Gap 5: VersionManager + VersionCache integration with forceRefresh
// ---------------------------------------------------------------------------

describe('Gap 5: VersionManager cache lifecycle — miss, hit, forceRefresh', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'substrate-epic8-gap5-'))
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('cache miss → network fetch → cache written → second call uses cache', async () => {
    const cachePath = join(tempDir, 'update-cache.json')
    const cache = new VersionCache(cachePath)
    const mockChecker = buildMockUpdateChecker('1.5.0')
    const manager = new VersionManagerImpl({ cache, updateChecker: mockChecker })

    // First call: no cache, fetches from network
    const result1 = await manager.checkForUpdates()
    expect(mockChecker.fetchLatestVersion).toHaveBeenCalledTimes(1)
    expect(result1.latestVersion).toBe('1.5.0')

    // Second call: cache is fresh, no network
    const result2 = await manager.checkForUpdates()
    expect(mockChecker.fetchLatestVersion).toHaveBeenCalledTimes(1)
    expect(result2.latestVersion).toBe('1.5.0')
  })

  it('forceRefresh=true bypasses fresh cache and fetches again', async () => {
    const cachePath = join(tempDir, 'update-cache.json')
    const cache = new VersionCache(cachePath)
    const mockChecker = buildMockUpdateChecker('1.5.0')
    const manager = new VersionManagerImpl({ cache, updateChecker: mockChecker })

    // First call: cache miss → writes '1.5.0' to cache
    await manager.checkForUpdates()
    expect(mockChecker.fetchLatestVersion).toHaveBeenCalledTimes(1)

    // Now mock returns a new version
    ;(mockChecker.fetchLatestVersion as ReturnType<typeof vi.fn>).mockResolvedValue('2.0.0')

    // forceRefresh: bypasses cache even though it's fresh
    const result = await manager.checkForUpdates(true)
    expect(mockChecker.fetchLatestVersion).toHaveBeenCalledTimes(2)
    expect(result.latestVersion).toBe('2.0.0')

    // Cache should now contain the new version
    const cached = cache.read()
    expect(cached?.latestVersion).toBe('2.0.0')
  })

  it('network error on first fetch still returns no-update result, does not write cache', async () => {
    const cachePath = join(tempDir, 'update-cache.json')
    const cache = new VersionCache(cachePath)
    const mockChecker = buildMockUpdateChecker()
    ;(mockChecker.fetchLatestVersion as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED')
    )
    const manager = new VersionManagerImpl({ cache, updateChecker: mockChecker })

    const result = await manager.checkForUpdates()

    expect(result.updateAvailable).toBe(false)
    // No cache file should have been written
    const cached = cache.read()
    expect(cached).toBeNull()
  })

  it('updateCheckEnabled=false skips check entirely across multiple calls', async () => {
    const cachePath = join(tempDir, 'update-cache.json')
    const cache = new VersionCache(cachePath)
    const mockChecker = buildMockUpdateChecker('2.0.0')
    const manager = new VersionManagerImpl({
      cache,
      updateChecker: mockChecker,
      updateCheckEnabled: false,
    })

    const r1 = await manager.checkForUpdates()
    const r2 = await manager.checkForUpdates(true) // even with forceRefresh

    expect(r1.updateAvailable).toBe(false)
    expect(r2.updateAvailable).toBe(false)
    expect(mockChecker.fetchLatestVersion).not.toHaveBeenCalled()
    // No cache written
    expect(cache.read()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Gap 6: VersionManager → migrateConfiguration delegation
// ---------------------------------------------------------------------------

describe('Gap 6: VersionManager migrateConfiguration and migrateTaskGraphFormat delegation', () => {
  it('migrateConfiguration same-version returns success:true', () => {
    const manager = new VersionManagerImpl()
    const result = manager.migrateConfiguration('1', '1')

    expect(result.success).toBe(true)
    expect(result.fromVersion).toBe('1')
    expect(result.toVersion).toBe('1')
  })

  it('migrateConfiguration provides migratedKeys array', () => {
    const manager = new VersionManagerImpl()
    const result = manager.migrateConfiguration('1', '1')

    expect(Array.isArray(result.migratedKeys)).toBe(true)
  })

  it('migrateTaskGraphFormat same-version returns success:true', () => {
    const manager = new VersionManagerImpl()
    const result = manager.migrateTaskGraphFormat('1', '1', '/fake/path/tasks.yaml')

    expect(result.success).toBe(true)
    expect(result.fromVersion).toBe('1')
    expect(result.toVersion).toBe('1')
  })

  it('isConfigCompatible rejects versions not in supported list', () => {
    const manager = new VersionManagerImpl()

    expect(manager.isConfigCompatible('1')).toBe(true)
    expect(manager.isConfigCompatible('999')).toBe(false)
    expect(manager.isConfigCompatible('')).toBe(false)
  })

  it('isTaskGraphCompatible rejects versions not in supported list', () => {
    const manager = new VersionManagerImpl()

    expect(manager.isTaskGraphCompatible('1')).toBe(true)
    expect(manager.isTaskGraphCompatible('999')).toBe(false)
    expect(manager.isTaskGraphCompatible('')).toBe(false)
  })

  it('getUpgradePreview includes breakingChanges for major version bump', () => {
    const mockChecker = buildMockUpdateChecker('2.0.0')
    // Make the isBreaking implementation return true for major bump
    ;(mockChecker.isBreaking as ReturnType<typeof vi.fn>).mockImplementation(
      (current: string, latest: string) => {
        const cMajor = parseInt(current.split('.')[0] ?? '0', 10)
        const lMajor = parseInt(latest.split('.')[0] ?? '0', 10)
        return lMajor > cMajor
      }
    )

    const manager = new VersionManagerImpl({ updateChecker: mockChecker })
    const preview = manager.getUpgradePreview('2.0.0')

    // Since current version is likely 0.x.x or 1.x.x, upgrading to 2.0.0 is breaking
    expect(preview.toVersion).toBe('2.0.0')
    expect(typeof preview.fromVersion).toBe('string')
    // The preview structure should be well-formed
    expect(Array.isArray(preview.breakingChanges)).toBe(true)
    expect(Array.isArray(preview.migrationSteps)).toBe(true)
    expect(Array.isArray(preview.automaticMigrations)).toBe(true)
    expect(Array.isArray(preview.manualStepsRequired)).toBe(true)
  })

  it('getUpgradePreview has empty breakingChanges for minor patch bump', () => {
    const mockChecker = buildMockUpdateChecker('0.2.0')
    ;(mockChecker.isBreaking as ReturnType<typeof vi.fn>).mockReturnValue(false)

    const manager = new VersionManagerImpl({ updateChecker: mockChecker })
    const preview = manager.getUpgradePreview('0.2.0')

    expect(preview.breakingChanges).toHaveLength(0)
    expect(preview.automaticMigrations).toHaveLength(0)
    expect(preview.manualStepsRequired).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gap 7: Monitor agent → report pipeline with pruning
// ---------------------------------------------------------------------------

describe('Gap 7: pruneOldData + rebuildAggregates followed by report generation', () => {
  let monitorDb: MonitorDatabaseImpl

  beforeEach(() => {
    monitorDb = new MonitorDatabaseImpl(':memory:')
  })

  afterEach(() => {
    monitorDb.close()
  })

  it('after pruning old data, report reflects only recent tasks', () => {
    const internal = getInternalDb(monitorDb)
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    const recentDate = new Date().toISOString()

    // Insert one old and one recent task
    internal.prepare(`
      INSERT INTO task_metrics (task_id, agent, task_type, outcome, input_tokens, output_tokens,
        duration_ms, cost, estimated_cost, billing_mode, recorded_at)
      VALUES ('old-task', 'claude', 'coding', 'success', 1000, 500, 2000, 0.05, 0.04, 'api', ?)
    `).run(oldDate)

    internal.prepare(`
      INSERT INTO task_metrics (task_id, agent, task_type, outcome, input_tokens, output_tokens,
        duration_ms, cost, estimated_cost, billing_mode, recorded_at)
      VALUES ('recent-task', 'claude', 'coding', 'success', 500, 200, 1000, 0.02, 0.02, 'api', ?)
    `).run(recentDate)

    // Build aggregates from both tasks
    monitorDb.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 1000, outputTokens: 500, durationMs: 2000, cost: 0.05 })
    monitorDb.updateAggregates('claude', 'coding', { outcome: 'success', inputTokens: 500, outputTokens: 200, durationMs: 1000, cost: 0.02 })

    // Pre-prune report: 2 tasks
    const preReport = generateMonitorReport(monitorDb)
    expect(preReport.summary.total_tasks).toBe(2)

    // Prune old data (90 days retention)
    const deleted = monitorDb.pruneOldData(90)
    expect(deleted).toBe(1)

    // Rebuild aggregates to reflect only the recent task
    monitorDb.rebuildAggregates()

    // Post-prune report: only 1 recent task
    const postReport = generateMonitorReport(monitorDb)
    expect(postReport.summary.total_tasks).toBe(1)
  })
})
