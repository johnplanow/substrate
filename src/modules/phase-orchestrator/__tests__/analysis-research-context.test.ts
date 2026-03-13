/**
 * Integration tests for research context injection into analysis step 1 (Story 20.4).
 *
 * Verifies that research findings from the decision store are wired into the
 * analysis-step-1-vision prompt when research data is available:
 *
 *   AC1: When research findings exist in the decision store, the assembled
 *        analysis-step-1-vision prompt contains the seeded research context strings.
 *   AC2: When no research findings exist in the decision store, the assembled
 *        analysis-step-1-vision prompt does NOT contain research context strings.
 *   AC3: The `decision:` source type in resolveContext returns "" when no
 *        matching entries exist in the decision store.
 *
 * Test structure:
 *   - Research-enabled path: seed decision store with research.findings entries,
 *     run step 1 with mocked dispatcher, verify prompt contains seeded strings.
 *   - Research-disabled path: no research findings seeded, verify prompt does NOT
 *     contain research context strings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { SyncDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import {
  createPipelineRun,
  createDecision,
} from '../../../persistence/queries/decisions.js'
import { runSteps, resolveContext } from '../step-runner.js'
import type { StepDefinition, ContextRef } from '../step-runner.js'
import type { PhaseDeps } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'analysis-research-context-'))
  const db = new Database(join(tmpDir, 'test.db'))
  const adapter = new SyncDatabaseAdapter(db)
  await initSchema(adapter)
  return { db, adapter, tmpDir }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'research' })
  return run.id
}

/** Minimal Zod schema matching AnalysisVisionOutputSchema contract */
const VisionOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  problem_statement: z.string().optional(),
  target_users: z.array(z.string()).optional(),
})

function makeDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: 'dispatch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: {
      result: 'success',
      problem_statement: 'A test problem statement.',
      target_users: ['Developers who need tooling'],
    },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 100, output: 50 },
    ...overrides,
  }
}

/**
 * Capture-dispatcher: captures the prompt string passed to dispatch() so tests
 * can assert on what the step-runner assembled.
 */
function makeCaptureDispatcher(result: DispatchResult<unknown>): {
  dispatcher: Dispatcher
  capturedPrompts: string[]
} {
  const capturedPrompts: string[] = []
  const dispatcher: Dispatcher = {
    dispatch: vi.fn().mockImplementation((opts: { prompt: string }) => {
      capturedPrompts.push(opts.prompt)
      return {
        id: result.id,
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(result),
      }
    }),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
  return { dispatcher, capturedPrompts }
}

function makePack(prompts: Record<string, string>): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack for research context injection',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockImplementation((key: string) => {
      return Promise.resolve(prompts[key] ?? '')
    }),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack: MethodologyPack,
): PhaseDeps {
  return {
    db: adapter,
    pack,
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

/**
 * Seed the decision store with research findings — matching what the
 * research-step-2-synthesis step would persist after completing.
 */
async function seedResearchFindings(adapter: DatabaseAdapter, runId: string): Promise<void> {
  const findings = [
    { key: 'market_context', value: 'Global developer tooling market is growing at 18% CAGR' },
    { key: 'competitive_landscape', value: 'Main competitors: GitHub Actions, CircleCI, Jenkins' },
    { key: 'technical_feasibility', value: 'TypeScript + SQLite stack is well-proven for CLI tooling' },
    { key: 'risk_flags', value: 'Market saturation in CI/CD space; differentiation required' },
    { key: 'opportunity_signals', value: 'AI-native pipelines represent a blue-ocean opportunity' },
  ]

  for (const f of findings) {
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'research',
      category: 'findings',
      key: f.key,
      value: f.value,
    })
  }
}

// The step definition for analysis-step-1-vision, including the research_findings
// context entry added by Story 20.4.
function buildVisionStepWithResearch(): StepDefinition {
  return {
    name: 'analysis-step-1-vision',
    taskType: 'analysis-vision',
    outputSchema: VisionOutputSchema,
    context: [
      { placeholder: 'concept', source: 'param:concept' },
      { placeholder: 'research_findings', source: 'decision:research.findings' },
    ],
    persist: [
      { field: 'problem_statement', category: 'product-brief', key: 'problem_statement' },
      { field: 'target_users', category: 'product-brief', key: 'target_users' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Task 3: Unit test for resolveContext — decision: with no matching entries
// ---------------------------------------------------------------------------

describe('resolveContext() — decision: source with no matching entries (Task 3)', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty string when decision store has no entries for the specified phase+category', async () => {
    const ref: ContextRef = { placeholder: 'research_findings', source: 'decision:research.findings' }
    const pack = makePack({})
    const { dispatcher } = makeCaptureDispatcher(makeDispatchResult())
    const deps = makeDeps(adapter, dispatcher, pack)

    // Decision store is empty — no research findings seeded
    const result = await resolveContext(ref, deps, runId, {}, new Map())

    expect(result).toBe('')
  })

  it('returns empty string when phase exists in store but category does not match', async () => {
    // Seed decisions under a different category
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'research',
      category: 'different-category',
      key: 'some_key',
      value: 'some value',
    })

    const ref: ContextRef = { placeholder: 'research_findings', source: 'decision:research.findings' }
    const pack = makePack({})
    const { dispatcher } = makeCaptureDispatcher(makeDispatchResult())
    const deps = makeDeps(adapter, dispatcher, pack)

    const result = await resolveContext(ref, deps, runId, {}, new Map())

    expect(result).toBe('')
  })

  it('returns non-empty string when matching research findings entries exist', async () => {
    await seedResearchFindings(adapter, runId)

    const ref: ContextRef = { placeholder: 'research_findings', source: 'decision:research.findings' }
    const pack = makePack({})
    const { dispatcher } = makeCaptureDispatcher(makeDispatchResult())
    const deps = makeDeps(adapter, dispatcher, pack)

    const result = await resolveContext(ref, deps, runId, {}, new Map())

    expect(result).not.toBe('')
    expect(result).toContain('market_context')
  })
})

// ---------------------------------------------------------------------------
// Task 4: Research-enabled path integration test
// ---------------------------------------------------------------------------

describe('analysis-step-1-vision — research-enabled path (Task 4)', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('assembled prompt contains seeded research findings when decision store is populated', async () => {
    // Seed research findings into the decision store (simulating a completed research phase)
    await seedResearchFindings(adapter, runId)

    const promptTemplate =
      '# Vision Analysis\n\n### Project Concept\n{{concept}}\n\n### Research Context\n{{research_findings}}\n\n## Mission\nAnalyze and produce vision.'

    const dispatchResult = makeDispatchResult()
    const { dispatcher, capturedPrompts } = makeCaptureDispatcher(dispatchResult)
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps = [buildVisionStepWithResearch()]
    const result = await runSteps(steps, deps, runId, 'analysis', {
      concept: 'Build an AI-powered pipeline tool',
    })

    expect(result.success).toBe(true)
    expect(capturedPrompts).toHaveLength(1)

    const assembledPrompt = capturedPrompts[0]!

    // Verify research findings are present in the assembled prompt
    expect(assembledPrompt).toContain('market_context')
    expect(assembledPrompt).toContain('Global developer tooling market is growing at 18% CAGR')
    expect(assembledPrompt).toContain('competitive_landscape')
    expect(assembledPrompt).toContain('Main competitors: GitHub Actions, CircleCI, Jenkins')
    expect(assembledPrompt).toContain('technical_feasibility')
    expect(assembledPrompt).toContain('TypeScript + SQLite stack is well-proven for CLI tooling')
    expect(assembledPrompt).toContain('risk_flags')
    expect(assembledPrompt).toContain('Market saturation in CI/CD space; differentiation required')
    expect(assembledPrompt).toContain('opportunity_signals')
    expect(assembledPrompt).toContain('AI-native pipelines represent a blue-ocean opportunity')
  })

  it('concept is also present in the assembled prompt alongside research findings', async () => {
    await seedResearchFindings(adapter, runId)

    const promptTemplate =
      '### Concept\n{{concept}}\n\n### Research\n{{research_findings}}'

    const { dispatcher, capturedPrompts } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const concept = 'Build a next-generation CLI tool for developers'
    const steps = [buildVisionStepWithResearch()]
    await runSteps(steps, deps, runId, 'analysis', { concept })

    const assembledPrompt = capturedPrompts[0]!
    expect(assembledPrompt).toContain(concept)
    expect(assembledPrompt).toContain('market_context')
  })

  it('all five research finding categories appear in the assembled prompt', async () => {
    await seedResearchFindings(adapter, runId)

    const promptTemplate = '{{concept}}\n{{research_findings}}'
    const { dispatcher, capturedPrompts } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps = [buildVisionStepWithResearch()]
    await runSteps(steps, deps, runId, 'analysis', { concept: 'Test concept' })

    const assembledPrompt = capturedPrompts[0]!
    const expectedKeys = [
      'market_context',
      'competitive_landscape',
      'technical_feasibility',
      'risk_flags',
      'opportunity_signals',
    ]
    for (const key of expectedKeys) {
      expect(assembledPrompt).toContain(key)
    }
  })

  it('step completes successfully with research findings in decision store', async () => {
    await seedResearchFindings(adapter, runId)

    const promptTemplate = '{{concept}}\n{{research_findings}}'
    const { dispatcher } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps = [buildVisionStepWithResearch()]
    const result = await runSteps(steps, deps, runId, 'analysis', {
      concept: 'Build an AI-powered pipeline tool',
    })

    expect(result.success).toBe(true)
    expect(result.steps[0]!.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 5: Research-disabled path integration test
// ---------------------------------------------------------------------------

describe('analysis-step-1-vision — research-disabled path (Task 5)', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('assembled prompt does NOT contain research finding strings when no findings in store', async () => {
    // Do NOT seed any research findings — empty decision store

    const promptTemplate =
      '# Vision Analysis\n\n### Project Concept\n{{concept}}\n\n### Research Context\n{{research_findings}}\n\n## Mission\nAnalyze and produce vision.'

    const { dispatcher, capturedPrompts } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps = [buildVisionStepWithResearch()]
    const result = await runSteps(steps, deps, runId, 'analysis', {
      concept: 'Build an AI-powered pipeline tool',
    })

    expect(result.success).toBe(true)
    const assembledPrompt = capturedPrompts[0]!

    // Verify research-specific strings are absent
    expect(assembledPrompt).not.toContain('market_context')
    expect(assembledPrompt).not.toContain('Global developer tooling market')
    expect(assembledPrompt).not.toContain('competitive_landscape')
    expect(assembledPrompt).not.toContain('Main competitors: GitHub Actions')
    expect(assembledPrompt).not.toContain('technical_feasibility')
    expect(assembledPrompt).not.toContain('risk_flags')
    expect(assembledPrompt).not.toContain('opportunity_signals')
  })

  it('concept is still present in assembled prompt even without research findings', async () => {
    const promptTemplate = '### Concept\n{{concept}}\n\n### Research\n{{research_findings}}'

    const { dispatcher, capturedPrompts } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const concept = 'Build a standalone developer CLI'
    const steps = [buildVisionStepWithResearch()]
    await runSteps(steps, deps, runId, 'analysis', { concept })

    const assembledPrompt = capturedPrompts[0]!
    expect(assembledPrompt).toContain(concept)
  })

  it('step completes successfully when no research findings are in the decision store', async () => {
    const promptTemplate = '{{concept}}\n{{research_findings}}'
    const { dispatcher } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps = [buildVisionStepWithResearch()]
    const result = await runSteps(steps, deps, runId, 'analysis', {
      concept: 'Build a developer tool',
    })

    expect(result.success).toBe(true)
    expect(result.steps[0]!.success).toBe(true)
  })

  it('research_findings placeholder is replaced with empty string when no entries exist', async () => {
    const promptTemplate = 'BEFORE|{{research_findings}}|AFTER'

    const { dispatcher, capturedPrompts } = makeCaptureDispatcher(makeDispatchResult())
    const pack = makePack({ 'analysis-step-1-vision': promptTemplate })
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps = [buildVisionStepWithResearch()]
    await runSteps(steps, deps, runId, 'analysis', { concept: 'Test' })

    const assembledPrompt = capturedPrompts[0]!
    // Placeholder replaced with empty string — no unreplaced {{}} tokens
    expect(assembledPrompt).not.toContain('{{research_findings}}')
    // The surrounding text remains intact
    expect(assembledPrompt).toContain('BEFORE||AFTER')
  })
})
