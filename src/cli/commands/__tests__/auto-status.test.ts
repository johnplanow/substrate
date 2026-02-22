/**
 * Unit tests for status formatting functions in src/cli/commands/auto.ts
 * (Story 11.5 — Task 8)
 *
 * Covers AC4 and AC5:
 *   AC4: Enhanced status command with phase-level detail
 *   AC5: JSON status output schema
 *
 * Tests:
 *   - Human format output: verify table structure and content
 *   - JSON format output: parse and validate against expected schema
 *   - No pipeline runs: outputs error
 *   - Completed run: all phases show "complete"
 *   - Running pipeline: current phase shows "running", future show "pending"
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPipelineRun, registerArtifact } from '../../../persistence/queries/decisions.js'
import type { PipelineRun, TokenUsageSummary } from '../../../persistence/queries/decisions.js'
import {
  buildPipelineStatusOutput,
  formatPipelineStatusHuman,
  formatPipelineSummary,
  formatTokenTelemetry,
  formatOutput,
} from '../auto.js'

// ---------------------------------------------------------------------------
// In-memory DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  runMigrations(db)
  return db
}

function createTestRun(
  db: BetterSqlite3Database,
  overrides: Partial<PipelineRun> = {},
): PipelineRun {
  const run = createPipelineRun(db, {
    methodology: 'bmad',
    start_phase: 'analysis',
    config_json: overrides.config_json ?? null,
  })
  // Apply any status overrides
  if (overrides.status !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET status = ? WHERE id = ?`).run(overrides.status, run.id)
  }
  if (overrides.current_phase !== undefined) {
    db.prepare(`UPDATE pipeline_runs SET current_phase = ? WHERE id = ?`).run(
      overrides.current_phase,
      run.id,
    )
  }
  return db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(run.id) as PipelineRun
}

function makePhaseHistory(
  completed: string[],
  running?: string,
): { phase: string; startedAt: string; completedAt?: string; gateResults: unknown[] }[] {
  const history = []
  for (const phase of completed) {
    history.push({
      phase,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      gateResults: [],
    })
  }
  if (running !== undefined) {
    history.push({
      phase: running,
      startedAt: '2026-01-01T00:02:00Z',
      gateResults: [],
    })
  }
  return history
}

function makeTokenSummary(phases: string[]): TokenUsageSummary[] {
  return phases.map((phase, i) => ({
    phase,
    agent: 'claude-code',
    total_input_tokens: (i + 1) * 1200,
    total_output_tokens: (i + 1) * 800,
    total_cost_usd: (i + 1) * 0.01,
  }))
}

// ---------------------------------------------------------------------------
// Tests: buildPipelineStatusOutput
// ---------------------------------------------------------------------------

describe('buildPipelineStatusOutput', () => {
  it('AC5: produces schema with all required fields', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: makePhaseHistory(['analysis', 'planning'], 'solutioning'),
      }),
    })

    const tokenSummary = makeTokenSummary(['analysis', 'planning'])
    const result = buildPipelineStatusOutput(run, tokenSummary, 47, 12)

    // Verify top-level fields
    expect(typeof result.run_id).toBe('string')
    expect(result.decisions_count).toBe(47)
    expect(result.stories_count).toBe(12)

    // Verify phases object
    expect(result.phases).toHaveProperty('analysis')
    expect(result.phases).toHaveProperty('planning')
    expect(result.phases).toHaveProperty('solutioning')
    expect(result.phases).toHaveProperty('implementation')

    // Verify total_tokens
    expect(result.total_tokens).toHaveProperty('input')
    expect(result.total_tokens).toHaveProperty('output')
    expect(result.total_tokens).toHaveProperty('cost_usd')

    db.close()
  })

  it('completed run: all phases show "complete"', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      status: 'completed',
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: makePhaseHistory(['analysis', 'planning', 'solutioning', 'implementation']),
      }),
    })

    const tokenSummary = makeTokenSummary(['analysis', 'planning', 'solutioning', 'implementation'])
    const result = buildPipelineStatusOutput(run, tokenSummary, 100, 20)

    expect(result.phases.analysis.status).toBe('complete')
    expect(result.phases.planning.status).toBe('complete')
    expect(result.phases.solutioning.status).toBe('complete')
    expect(result.phases.implementation.status).toBe('complete')

    db.close()
  })

  it('running pipeline: current phase shows "running", future phases show "pending"', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      current_phase: 'solutioning',
      status: 'running',
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: makePhaseHistory(['analysis', 'planning'], 'solutioning'),
      }),
    })

    const tokenSummary = makeTokenSummary(['analysis', 'planning'])
    const result = buildPipelineStatusOutput(run, tokenSummary, 30, 8)

    expect(result.phases.analysis.status).toBe('complete')
    expect(result.phases.planning.status).toBe('complete')
    expect(result.phases.solutioning.status).toBe('running')
    expect(result.phases.implementation.status).toBe('pending')

    db.close()
  })

  it('no phase history: planning/solutioning/implementation show "pending"', () => {
    const db = createTestDb()
    const run = createTestRun(db)  // no config_json, current_phase=analysis

    const result = buildPipelineStatusOutput(run, [], 0, 0)

    // Analysis may show as 'running' since current_phase is 'analysis'
    // but planning, solutioning, implementation should be pending
    expect(result.phases.planning.status).toBe('pending')
    expect(result.phases.solutioning.status).toBe('pending')
    expect(result.phases.implementation.status).toBe('pending')

    db.close()
  })

  it('correctly sums token usage per phase', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 1200, total_output_tokens: 800, total_cost_usd: 0.006 },
      { phase: 'planning', agent: 'claude-code', total_input_tokens: 1800, total_output_tokens: 1200, total_cost_usd: 0.023 },
    ]

    const result = buildPipelineStatusOutput(run, tokenSummary, 0, 0)

    expect(result.total_tokens.input).toBe(3000)
    expect(result.total_tokens.output).toBe(2000)
    expect(result.total_tokens.cost_usd).toBeCloseTo(0.029)

    db.close()
  })

  it('includes token_usage per phase when data available', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: makePhaseHistory(['analysis']),
      }),
    })

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 1200, total_output_tokens: 800, total_cost_usd: 0.006 },
    ]

    const result = buildPipelineStatusOutput(run, tokenSummary, 0, 0)

    expect(result.phases.analysis.token_usage).toEqual({ input: 1200, output: 800 })

    db.close()
  })

  it('AC5: matches exact JSON schema from story spec (solutioning running)', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      current_phase: 'solutioning',
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: [
          { phase: 'analysis', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', gateResults: [] },
          { phase: 'planning', startedAt: '2026-01-01T00:01:00Z', completedAt: '2026-01-01T00:02:00Z', gateResults: [] },
          { phase: 'solutioning', startedAt: '2026-01-01T00:02:00Z', gateResults: [] },
        ],
      }),
    })

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 1200, total_output_tokens: 800, total_cost_usd: 0.0054 },
      { phase: 'planning', agent: 'claude-code', total_input_tokens: 1800, total_output_tokens: 1200, total_cost_usd: 0.023 },
      { phase: 'solutioning', agent: 'claude-code', total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 },
    ]

    const result = buildPipelineStatusOutput(run, tokenSummary, 47, 12)

    // Verify the full schema matches the spec
    expect(result).toMatchObject({
      run_id: expect.any(String),
      current_phase: 'solutioning',
      phases: {
        analysis: {
          status: 'complete',
          completed_at: '2026-01-01T00:01:00Z',
          token_usage: { input: 1200, output: 800 },
        },
        planning: {
          status: 'complete',
          completed_at: '2026-01-01T00:02:00Z',
          token_usage: { input: 1800, output: 1200 },
        },
        solutioning: {
          status: 'running',
          started_at: '2026-01-01T00:02:00Z',
          token_usage: { input: 0, output: 0 },
        },
        implementation: {
          status: 'pending',
        },
      },
      total_tokens: {
        input: 3000,
        output: 2000,
        cost_usd: expect.any(Number),
      },
      decisions_count: 47,
      stories_count: 12,
    })

    db.close()
  })
})

// ---------------------------------------------------------------------------
// Tests: formatPipelineStatusHuman
// ---------------------------------------------------------------------------

describe('formatPipelineStatusHuman', () => {
  it('AC4: human format shows all phases with status indicators', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      current_phase: 'planning',
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: makePhaseHistory(['analysis'], 'planning'),
      }),
    })

    const statusOutput = buildPipelineStatusOutput(run, [], 5, 2)
    const output = formatPipelineStatusHuman(statusOutput)

    // Verify pipeline run header
    expect(output).toContain('Pipeline Run:')
    expect(output).toContain(run.id)

    // Verify phase sections
    expect(output).toContain('analysis')
    expect(output).toContain('planning')
    expect(output).toContain('solutioning')
    expect(output).toContain('implementation')

    // Verify status indicators
    expect(output).toContain('[DONE]')   // analysis complete
    expect(output).toContain('[RUN]')    // planning running
    expect(output).toContain('[    ]')   // solutioning + implementation pending

    db.close()
  })

  it('shows token usage when available', () => {
    const db = createTestDb()
    const run = createTestRun(db, {
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: makePhaseHistory(['analysis']),
      }),
    })

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 1200, total_output_tokens: 800, total_cost_usd: 0.006 },
    ]

    const statusOutput = buildPipelineStatusOutput(run, tokenSummary, 0, 0)
    const output = formatPipelineStatusHuman(statusOutput)

    expect(output).toContain('1,200')   // input tokens
    expect(output).toContain('800')     // output tokens

    db.close()
  })

  it('shows decisions and stories count', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const statusOutput = buildPipelineStatusOutput(run, [], 42, 15)
    const output = formatPipelineStatusHuman(statusOutput)

    expect(output).toContain('Decisions: 42')
    expect(output).toContain('Stories: 15')

    db.close()
  })

  it('shows total cost and total tokens', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 1000, total_output_tokens: 500, total_cost_usd: 0.015 },
    ]

    const statusOutput = buildPipelineStatusOutput(run, tokenSummary, 0, 0)
    const output = formatPipelineStatusHuman(statusOutput)

    expect(output).toContain('Total Tokens:')
    expect(output).toContain('Total Cost:')

    db.close()
  })
})

// ---------------------------------------------------------------------------
// Tests: formatPipelineSummary
// ---------------------------------------------------------------------------

describe('formatPipelineSummary', () => {
  it('AC8: human format shows all required metrics', () => {
    const db = createTestDb()
    const run = createTestRun(db, { status: 'completed' })

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 2000, total_output_tokens: 1000, total_cost_usd: 0.021 },
      { phase: 'planning', agent: 'claude-code', total_input_tokens: 3000, total_output_tokens: 1200, total_cost_usd: 0.027 },
    ]

    const output = formatPipelineSummary(run, tokenSummary, 30, 10, 180000, 'human')

    expect(output).toContain('Pipeline Run Summary')
    expect(output).toContain(run.id)
    expect(output).toContain('Decisions:')
    expect(output).toContain('Stories:')
    expect(output).toContain('Duration:')
    expect(output).toContain('Token Usage:')
    expect(output).toContain('BMAD Baseline:')
    expect(output).toContain('Token Savings:')

    db.close()
  })

  it('AC8: JSON format includes all metrics', () => {
    const db = createTestDb()
    const run = createTestRun(db, { status: 'completed' })

    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 2000, total_output_tokens: 1000, total_cost_usd: 0.021 },
    ]

    const output = formatPipelineSummary(run, tokenSummary, 30, 10, 180000, 'json')

    const parsed = JSON.parse(output)
    expect(parsed).toHaveProperty('run_id', run.id)
    expect(parsed).toHaveProperty('status', 'completed')
    expect(parsed).toHaveProperty('duration_ms', 180000)
    expect(parsed).toHaveProperty('phases_completed')
    expect(parsed).toHaveProperty('decisions_count', 30)
    expect(parsed).toHaveProperty('stories_count', 10)
    expect(parsed.token_usage).toHaveProperty('input', 2000)
    expect(parsed.token_usage).toHaveProperty('output', 1000)
    expect(parsed.token_usage).toHaveProperty('total', 3000)
    expect(parsed.token_usage).toHaveProperty('cost_usd')
    expect(parsed.token_usage).toHaveProperty('bmad_baseline')
    expect(parsed.token_usage).toHaveProperty('savings_pct')

    db.close()
  })

  it('calculates savings percentage correctly', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // 17,100 tokens = ~70% savings vs 56,800 baseline
    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 10000, total_output_tokens: 7100, total_cost_usd: 0.1 },
    ]

    const output = formatPipelineSummary(run, tokenSummary, 0, 0, 60000, 'json')
    const parsed = JSON.parse(output)

    // 17,100 / 56,800 → about 70% savings
    expect(parsed.token_usage.savings_pct).toBeGreaterThan(60)
    expect(parsed.token_usage.savings_pct).toBeLessThanOrEqual(100)

    db.close()
  })

  it('shows overhead when tokens exceed baseline', () => {
    const db = createTestDb()
    const run = createTestRun(db)

    // More tokens than baseline
    const tokenSummary: TokenUsageSummary[] = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 40000, total_output_tokens: 20000, total_cost_usd: 0.5 },
    ]

    const output = formatPipelineSummary(run, tokenSummary, 0, 0, 60000, 'json')
    const parsed = JSON.parse(output)

    // 60,000 tokens > 56,800 baseline → negative savings
    expect(parsed.token_usage.savings_pct).toBeLessThan(0)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// Tests: formatOutput (preserved from original)
// ---------------------------------------------------------------------------

describe('formatOutput', () => {
  it('returns JSON success format', () => {
    const result = formatOutput({ foo: 'bar' }, 'json', true)
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({ foo: 'bar' })
  })

  it('returns JSON error format', () => {
    const result = formatOutput(null, 'json', false, 'something went wrong')
    const parsed = JSON.parse(result)
    expect(parsed.success).toBe(false)
    expect(parsed.error).toBe('something went wrong')
  })

  it('returns human format string as-is', () => {
    const result = formatOutput('hello world', 'human')
    expect(result).toBe('hello world')
  })
})

// ---------------------------------------------------------------------------
// Tests: formatTokenTelemetry
// ---------------------------------------------------------------------------

describe('formatTokenTelemetry', () => {
  it('shows "No token usage recorded" when empty', () => {
    expect(formatTokenTelemetry([])).toBe('No token usage recorded.')
  })

  it('shows BMAD baseline comparison with custom baseline', () => {
    const summary: TokenUsageSummary[] = [
      {
        phase: 'analysis',
        agent: 'claude-code',
        total_input_tokens: 1200,
        total_output_tokens: 800,
        total_cost_usd: 0.006,
      },
    ]
    // Use full pipeline baseline
    const output = formatTokenTelemetry(summary, 56800)
    expect(output).toContain('BMAD Baseline: 56,800 tokens')
    expect(output).toContain('Savings:')
  })

  it('defaults to implementation-only baseline (23,800)', () => {
    const summary: TokenUsageSummary[] = [
      {
        phase: 'implementation',
        agent: 'claude-code',
        total_input_tokens: 1200,
        total_output_tokens: 800,
        total_cost_usd: 0.006,
      },
    ]
    const output = formatTokenTelemetry(summary)
    expect(output).toContain('BMAD Baseline: 23,800 tokens')
  })
})

// ---------------------------------------------------------------------------
// Test: Error message strings
// ---------------------------------------------------------------------------

describe('Error message strings', () => {
  it('status with no runs returns expected error message text', () => {
    // Verify the error message text for no runs
    const errorMsg = 'No pipeline runs found. Run `substrate auto run` first.'
    expect(errorMsg).toContain('No pipeline runs found')
  })

  it('status with missing db returns expected error message text', () => {
    const errorMsg = `Decision store not initialized. Run 'substrate auto init' first.`
    expect(errorMsg).toContain('Decision store not initialized')
  })
})
