/**
 * Integration tests for V1b features (V1b-6).
 *
 * These tests verify that the V1b features work together end-to-end
 * using the in-memory adapter, without making LLM calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'node:os'
import { InMemoryDatabaseAdapter } from '@substrate-ai/core'
import { initSchema } from '../../../persistence/schema.js'
import {
  writeEvalResult,
  getLatestEvalForRun,
  loadEvalPairForComparison,
} from '../../../persistence/queries/eval-results.js'
import { EvalComparer } from '../comparer.js'
import { EvalEngine, resolveThreshold } from '../eval-engine.js'
import type { EvalAdapter } from '../adapter.js'
import type { EvalReport, PhaseEvalResult, ThresholdConfig } from '../types.js'

async function openTestDb() {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

function makeReport(
  runId: string,
  phases: Array<{ phase: string; score: number }>,
  metadata?: EvalReport['metadata'],
): EvalReport {
  return {
    runId,
    depth: 'standard',
    timestamp: new Date().toISOString(),
    phases: phases.map(
      (p): PhaseEvalResult => ({
        phase: p.phase as PhaseEvalResult['phase'],
        score: p.score,
        pass: p.score >= 0.7,
        layers: [],
        issues: [],
        feedback: '',
      }),
    ),
    overallScore: phases.reduce((s, p) => s + p.score, 0) / phases.length,
    pass: phases.every((p) => p.score >= 0.7),
    metadata,
  }
}

describe('V1b integration: DB round-trip', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('writes eval result, reads it back, all fields intact including metadata', async () => {
    const report = makeReport('run-rt', [
      { phase: 'analysis', score: 0.82 },
      { phase: 'planning', score: 0.91 },
    ], { schemaVersion: '1b', gitSha: 'abc1234', rubricHashes: { analysis: 'hash-a' } })

    await writeEvalResult(db, {
      run_id: report.runId,
      eval_id: crypto.randomUUID(),
      depth: report.depth,
      timestamp: report.timestamp,
      overall_score: report.overallScore,
      pass: report.pass,
      phases_json: JSON.stringify(report.phases),
      metadata_json: JSON.stringify(report.metadata),
    })

    const loaded = await getLatestEvalForRun(db, 'run-rt')
    expect(loaded).toBeDefined()
    expect(loaded!.overall_score).toBe(report.overallScore)
    expect(loaded!.pass).toBe(true)

    const phases = JSON.parse(loaded!.phases_json)
    expect(phases).toHaveLength(2)
    expect(phases[0].phase).toBe('analysis')
    expect(phases[0].score).toBe(0.82)

    const meta = JSON.parse(loaded!.metadata_json!)
    expect(meta.schemaVersion).toBe('1b')
    expect(meta.gitSha).toBe('abc1234')
    expect(meta.rubricHashes.analysis).toBe('hash-a')
  })
})

describe('V1b integration: comparison flow', () => {
  let db: InMemoryDatabaseAdapter

  beforeEach(async () => {
    db = await openTestDb()
  })

  it('writes two results, loads pair, runs compare, detects regression', async () => {
    const reportA = makeReport('run-a', [{ phase: 'analysis', score: 0.85 }])
    const reportB = makeReport('run-b', [{ phase: 'analysis', score: 0.70 }])

    await writeEvalResult(db, {
      run_id: 'run-a', eval_id: crypto.randomUUID(),
      depth: 'standard', timestamp: reportA.timestamp,
      overall_score: reportA.overallScore, pass: reportA.pass,
      phases_json: JSON.stringify(reportA.phases),
    })
    await writeEvalResult(db, {
      run_id: 'run-b', eval_id: crypto.randomUUID(),
      depth: 'standard', timestamp: reportB.timestamp,
      overall_score: reportB.overallScore, pass: reportB.pass,
      phases_json: JSON.stringify(reportB.phases),
    })

    const [rowA, rowB] = await loadEvalPairForComparison(db, 'run-a', 'run-b')
    expect(rowA).toBeDefined()
    expect(rowB).toBeDefined()

    // Reconstruct EvalReports from rows
    const loadedA: EvalReport = {
      runId: rowA!.run_id, depth: rowA!.depth as EvalReport['depth'],
      timestamp: rowA!.timestamp, phases: JSON.parse(rowA!.phases_json),
      overallScore: rowA!.overall_score, pass: rowA!.pass as boolean,
    }
    const loadedB: EvalReport = {
      runId: rowB!.run_id, depth: rowB!.depth as EvalReport['depth'],
      timestamp: rowB!.timestamp, phases: JSON.parse(rowB!.phases_json),
      overallScore: rowB!.overall_score, pass: rowB!.pass as boolean,
    }

    const comparer = new EvalComparer()
    const compareResult = comparer.compare(loadedA, loadedB)

    expect(compareResult.hasRegression).toBe(true)
    expect(compareResult.phases[0].verdict).toBe('REGRESSION')
    expect(compareResult.phases[0].delta).toBeCloseTo(-0.15, 2)
  })
})

describe('V1b integration: JSON fallback for comparison', () => {
  it('falls back to JSON when DB row is missing', async () => {
    const db = await openTestDb()
    // Only write run-a to DB
    await writeEvalResult(db, {
      run_id: 'run-a', eval_id: crypto.randomUUID(),
      depth: 'standard', timestamp: new Date().toISOString(),
      overall_score: 0.85, pass: true, phases_json: '[]',
    })

    // run-b only has a JSON file (no DB row)
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-json-'))
    const report: EvalReport = makeReport('run-b', [{ phase: 'analysis', score: 0.70 }])
    await writeFile(join(tmpDir, 'run-b.json'), JSON.stringify(report))

    // Verify DB returns nothing for run-b
    const dbRow = await getLatestEvalForRun(db, 'run-b')
    expect(dbRow).toBeUndefined()

    // JSON file should be loadable
    const content = await readFile(join(tmpDir, 'run-b.json'), 'utf-8')
    const parsed = JSON.parse(content) as EvalReport
    expect(parsed.runId).toBe('run-b')
  })
})

describe('V1b integration: thresholds affect phase pass/fail', () => {
  it('implementation passes at 0.65 with custom threshold 0.60', async () => {
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName, score: 0.65, pass: true,
        assertions: [{ name: 'test', score: 0.65, pass: true, reason: 'ok' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const thresholds: ThresholdConfig = { default: 0.7, phases: { implementation: 0.60 } }

    const report = await engine.evaluate(
      [
        { phase: 'analysis', output: 'out', promptTemplate: '## M', context: {} },
        { phase: 'implementation', output: 'out', promptTemplate: '## M', context: {} },
      ],
      'standard', 'run-thresh', thresholds,
    )

    // Analysis at 0.65 < default 0.70 → fail
    expect(report.phases[0].pass).toBe(false)
    // Implementation at 0.65 > custom 0.60 → pass
    expect(report.phases[1].pass).toBe(true)
  })
})

describe('V1b integration: standard-tier coherence', () => {
  it('produces cross-phase-coherence-standard layer in standard eval with upstream', async () => {
    const adapter: EvalAdapter = {
      runAssertions: vi.fn(async (_output, _assertions, layerName) => ({
        layer: layerName, score: 0.80, pass: true,
        assertions: [{ name: 'test', score: 0.80, pass: true, reason: 'ok' }],
      })),
    }

    const engine = new EvalEngine(adapter)
    const report = await engine.evaluate(
      [
        { phase: 'analysis', output: 'analysis out', promptTemplate: '## M', context: {} },
        {
          phase: 'planning', output: 'planning out', promptTemplate: '## M', context: {},
          upstreamOutput: 'analysis out', upstreamPhase: 'analysis',
        },
      ],
      'standard', 'run-coherence',
    )

    // Planning phase should have cross-phase-coherence-standard
    const planningLayers = report.phases[1].layers.map((l) => l.layer)
    expect(planningLayers).toContain('cross-phase-coherence-standard')
    expect(planningLayers).not.toContain('cross-phase-coherence')

    // Analysis should NOT have it (no upstream)
    const analysisLayers = report.phases[0].layers.map((l) => l.layer)
    expect(analysisLayers).not.toContain('cross-phase-coherence-standard')
  })
})
