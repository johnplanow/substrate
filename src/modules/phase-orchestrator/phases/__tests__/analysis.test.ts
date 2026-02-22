/**
 * Unit tests for runAnalysisPhase().
 *
 * Covers AC1-AC8:
 *   AC1: Compiled analysis prompt retrieval via pack.getPrompt('analysis')
 *   AC2: User concept injection into {{concept}} placeholder
 *   AC3: Product brief generation with all required fields
 *   AC4: Decision store persistence for each product brief field
 *   AC5: Artifact registration with correct phase and type
 *   AC6: Failure handling for dispatch errors, timeouts, and invalid YAML
 *   AC7: Token budget compliance and concept truncation
 *   AC8: Output schema validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../../persistence/migrations/index.js'
import { createPipelineRun } from '../../../../persistence/queries/decisions.js'
import { runAnalysisPhase } from '../analysis.js'
import type { PhaseDeps, AnalysisPhaseParams, ProductBrief } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'analysis-phase-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

const SAMPLE_BRIEF: ProductBrief = {
  problem_statement: 'Users need a way to manage their tasks efficiently.',
  target_users: ['developers', 'teams'],
  core_features: ['task creation', 'task assignment', 'progress tracking'],
  success_metrics: ['50% reduction in missed deadlines', '90% user satisfaction'],
  constraints: ['must run on web browsers', 'GDPR compliant'],
}

const SAMPLE_OUTPUT = {
  result: 'success' as const,
  product_brief: SAMPLE_BRIEF,
}

function makeDispatchResult(
  overrides: Partial<DispatchResult<typeof SAMPLE_OUTPUT>> = {},
): DispatchResult<typeof SAMPLE_OUTPUT> {
  return {
    id: 'dispatch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: SAMPLE_OUTPUT,
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 500, output: 100 },
    ...overrides,
  }
}

function makeDispatcher(result: DispatchResult<unknown>): Dispatcher {
  const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: result.id,
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(templateWithPlaceholder = 'Analyze the concept: {{concept}}\nProvide product brief.'): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: { analysis: 'prompts/analysis.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(templateWithPlaceholder),
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
  db: BetterSqlite3Database,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
): PhaseDeps {
  return {
    db,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runAnalysisPhase()', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // AC1: Compiled analysis prompt retrieval
  // -------------------------------------------------------------------------

  describe('AC1: Compiled analysis prompt retrieval', () => {
    it('calls pack.getPrompt("analysis") to retrieve the template', async () => {
      const pack = makePack()
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      expect(pack.getPrompt).toHaveBeenCalledWith('analysis')
      expect(pack.getPrompt).toHaveBeenCalledTimes(1)
    })

    it('dispatches to claude-code agent with taskType analysis', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'claude-code',
          taskType: 'analysis',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC2: User concept injection
  // -------------------------------------------------------------------------

  describe('AC2: User concept injection', () => {
    it('injects the concept into the {{concept}} placeholder', async () => {
      const pack = makePack('Analyze: {{concept}}')
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const concept = 'Build a task manager app'
      const params: AnalysisPhaseParams = { runId, concept }

      await runAnalysisPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(dispatchCall.prompt).toContain(concept)
      expect(dispatchCall.prompt).not.toContain('{{concept}}')
      expect(dispatchCall.prompt).toBe('Analyze: Build a task manager app')
    })

    it('includes the full concept text without truncation for short concepts', async () => {
      const shortConcept = 'A short concept'
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: shortConcept }

      await runAnalysisPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(dispatchCall.prompt).toContain(shortConcept)
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Product brief generation
  // -------------------------------------------------------------------------

  describe('AC3: Product brief generation', () => {
    it('returns success with a structured product brief containing all required fields', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('success')
      expect(result.product_brief).toBeDefined()
      expect(result.product_brief!.problem_statement).toBe(SAMPLE_BRIEF.problem_statement)
      expect(result.product_brief!.target_users).toEqual(SAMPLE_BRIEF.target_users)
      expect(result.product_brief!.core_features).toEqual(SAMPLE_BRIEF.core_features)
      expect(result.product_brief!.success_metrics).toEqual(SAMPLE_BRIEF.success_metrics)
      expect(result.product_brief!.constraints).toEqual(SAMPLE_BRIEF.constraints)
    })

    it('returns an artifact_id on success', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('success')
      expect(result.artifact_id).toBeDefined()
      expect(typeof result.artifact_id).toBe('string')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Decision store persistence
  // -------------------------------------------------------------------------

  describe('AC4: Decision store persistence', () => {
    it('stores each product brief field as a separate decision record', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      // Query the database to verify decisions were created
      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'analysis' AND category = 'product-brief' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions).toHaveLength(5)

      const keyMap = Object.fromEntries(decisions.map((d) => [d.key, d.value]))
      expect(keyMap['problem_statement']).toBe(SAMPLE_BRIEF.problem_statement)
      expect(JSON.parse(keyMap['target_users'])).toEqual(SAMPLE_BRIEF.target_users)
      expect(JSON.parse(keyMap['core_features'])).toEqual(SAMPLE_BRIEF.core_features)
      expect(JSON.parse(keyMap['success_metrics'])).toEqual(SAMPLE_BRIEF.success_metrics)
      expect(JSON.parse(keyMap['constraints'])).toEqual(SAMPLE_BRIEF.constraints)
    })

    it('stores array values as JSON-serialized strings', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      const targetUsersDecision = db
        .prepare(
          "SELECT value FROM decisions WHERE pipeline_run_id = ? AND key = 'target_users'",
        )
        .get(runId) as { value: string } | undefined

      expect(targetUsersDecision).toBeDefined()
      // Should be a valid JSON array string
      const parsed = JSON.parse(targetUsersDecision!.value)
      expect(Array.isArray(parsed)).toBe(true)
    })

    it('stores all decisions with phase=analysis and category=product-brief', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase != 'analysis'",
        )
        .all(runId)

      // No decisions outside analysis phase
      expect(decisions).toHaveLength(0)
    })

    it('does NOT store decisions when dispatch fails', async () => {
      const failResult = makeDispatchResult({ status: 'failed', parsed: null, parseError: 'error' })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      const decisions = db
        .prepare('SELECT * FROM decisions WHERE pipeline_run_id = ?')
        .all(runId)

      expect(decisions).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Artifact registration
  // -------------------------------------------------------------------------

  describe('AC5: Artifact registration', () => {
    it('registers a product-brief artifact with correct phase and type', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      const artifact = db
        .prepare(
          "SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = 'analysis' AND type = 'product-brief'",
        )
        .get(runId) as { id: string; phase: string; type: string; path: string; summary: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.phase).toBe('analysis')
      expect(artifact!.type).toBe('product-brief')
      expect(artifact!.path).toBe('decision-store://analysis/product-brief')
      expect(result.artifact_id).toBe(artifact!.id)
    })

    it('sets artifact summary from problem_statement (first 100 chars)', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      const artifact = db
        .prepare("SELECT summary FROM artifacts WHERE pipeline_run_id = ? AND type = 'product-brief'")
        .get(runId) as { summary: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.summary).toBe(SAMPLE_BRIEF.problem_statement.substring(0, 100))
    })

    it('artifact can be retrieved by getArtifactByType after success', async () => {
      const { getArtifactByTypeForRun } = await import('../../../../persistence/queries/decisions.js')
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
      expect(artifact).toBeDefined()
    })

    it('does NOT register artifact when dispatch fails', async () => {
      const failResult = makeDispatchResult({ status: 'failed', parsed: null, parseError: 'bad yaml' })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      await runAnalysisPhase(deps, params)

      const artifacts = db
        .prepare('SELECT * FROM artifacts WHERE pipeline_run_id = ?')
        .all(runId)

      expect(artifacts).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Failure handling
  // -------------------------------------------------------------------------

  describe('AC6: Failure handling', () => {
    it('returns { result: "failed" } when dispatch status is failed', async () => {
      const failResult = makeDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'agent error',
      })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBeDefined()
    })

    it('returns { result: "failed" } when dispatch status is timeout', async () => {
      const timeoutResult = makeDispatchResult({
        status: 'timeout',
        exitCode: -1,
        parsed: null,
        parseError: null,
        durationMs: 300_001,
      })
      const dispatcher = makeDispatcher(timeoutResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('dispatch_timeout')
    })

    it('returns { result: "failed" } with schema_validation_failed when parsed is null', async () => {
      const nullResult = makeDispatchResult({
        status: 'completed',
        parsed: null,
        parseError: 'YAML parse error',
      })
      const dispatcher = makeDispatcher(nullResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
    })

    it('includes descriptive error message on failure', async () => {
      const failResult = makeDispatchResult({
        status: 'failed',
        parsed: null,
        parseError: 'Subprocess exited with code 1',
      })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBeTruthy()
    })

    it('returns failed when agent reports result: failed in output', async () => {
      const agentFailResult = makeDispatchResult({
        parsed: { result: 'failed', product_brief: SAMPLE_BRIEF },
      })
      const dispatcher = makeDispatcher(agentFailResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
    })

    it('handles pack.getPrompt throwing an error gracefully', async () => {
      const pack = makePack()
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Prompt file not found'))
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toContain('Prompt file not found')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Token budget compliance and concept truncation
  // -------------------------------------------------------------------------

  describe('AC7: Token budget compliance', () => {
    it('truncates concept over 500 tokens (2000 chars) with "..." suffix', async () => {
      const longConcept = 'x'.repeat(2001) // 2001 chars > 2000 char limit
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: longConcept }

      await runAnalysisPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      // The concept portion injected should end with '...'
      expect(dispatchCall.prompt).toContain('...')
    })

    it('does NOT truncate concept under 500 tokens (2000 chars)', async () => {
      const shortConcept = 'x'.repeat(1999) // Under limit
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: shortConcept }

      await runAnalysisPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      // Concept is in the prompt, should not have '...' appended to the concept part
      // The concept itself ends with 'x', not '...'
      expect(dispatchCall.prompt).toContain('x'.repeat(1999))
    })

    it('assembled prompt (with reasonable concept) is within 2500 token budget', async () => {
      // Template is ~50 chars, concept is ~100 chars — well within budget
      const concept = 'Build a task manager'.repeat(5) // ~100 chars
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept }

      const result = await runAnalysisPhase(deps, params)

      // Should succeed (not fail with prompt_too_long)
      expect(result.result).toBe('success')
    })

    it('returns failed with prompt_too_long when assembled prompt exceeds 2500 tokens', async () => {
      // Template is 10000 chars * 4 = 40000 tokens (well over budget)
      const hugTemplate = 'A'.repeat(10_001 * 4) + ' {{concept}}'
      const pack = makePack(hugTemplate)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: AnalysisPhaseParams = { runId, concept: 'small concept' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('prompt_too_long')
    })
  })

  // -------------------------------------------------------------------------
  // AC8: Output schema validation
  // -------------------------------------------------------------------------

  describe('AC8: Output schema validation', () => {
    it('returns typed AnalysisResult with all required fields on valid output', async () => {
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('success')
      expect(result.product_brief).toBeDefined()
      expect(result.tokenUsage).toBeDefined()
      expect(result.tokenUsage.input).toBeGreaterThanOrEqual(0)
      expect(result.tokenUsage.output).toBeGreaterThanOrEqual(0)
    })

    it('returns schema_validation_failed with details on invalid YAML output', async () => {
      const invalidResult = makeDispatchResult({
        status: 'completed',
        parsed: null,
        parseError: 'Missing required field: product_brief',
      })
      const dispatcher = makeDispatcher(invalidResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
      expect(result.details).toBeDefined()
    })

    it('populates tokenUsage from dispatch result tokenEstimate', async () => {
      const dispatchResult = makeDispatchResult({
        tokenEstimate: { input: 450, output: 120 },
      })
      const dispatcher = makeDispatcher(dispatchResult)
      const deps = makeDeps(db, dispatcher)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.tokenUsage.input).toBe(450)
      expect(result.tokenUsage.output).toBe(120)
    })

    it('returns tokenUsage { input: 0, output: 0 } when pack.getPrompt throws', async () => {
      const pack = makePack()
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('file missing'))
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager app' }

      const result = await runAnalysisPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.tokenUsage.input).toBe(0)
      expect(result.tokenUsage.output).toBe(0)
    })
  })
})
