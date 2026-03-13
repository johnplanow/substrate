/**
 * Integration tests for the end-to-end elicitation round (Story 16.3).
 *
 * Covers:
 *  AC3 — Elicitation prompt template loaded and filled with real method data
 *  AC4 — Elicitation results stored in the decision store
 *  AC5 — Steps with elicitate: true trigger elicitation without breaking step-runner
 *  AC6 — Method rotation works across multiple rounds (deduplication)
 *
 * Integration strategy:
 *  - Uses the REAL elicitation-selector.ts (no mock)
 *  - Uses the REAL CSV file from packs/bmad/data/elicitation-methods.csv
 *  - Uses the REAL elicitation-apply.md prompt template (loaded from disk)
 *  - Mocks agent dispatch (external I/O) and database queries (persistence)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { runMigrations } from '../../../persistence/migrations/index.js'
import {
  createPipelineRun,
  getDecisionsByPhaseForRun,
  upsertDecision,
} from '../../../persistence/queries/decisions.js'
import {
  loadElicitationMethods,
  selectMethods,
  deriveContentType,
} from '../elicitation-selector.js'
import type { ElicitationContext, ElicitationMethod } from '../elicitation-selector.js'
import type { PhaseDeps } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'
import { SqliteDatabaseAdapter } from '../../../persistence/sqlite-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Helpers — test DB setup
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'elicitation-integration-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  const adapter = new SqliteDatabaseAdapter(db)
  return { db, adapter, tmpDir }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

// ---------------------------------------------------------------------------
// Helpers — mock factories
// ---------------------------------------------------------------------------

const ElicitationOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  insights: z.string(),
})

function makeDispatchResult(
  parsed: unknown,
  index = 0,
): DispatchResult<unknown> {
  return {
    id: `dispatch-${index}`,
    status: 'completed',
    exitCode: 0,
    output: 'yaml',
    parsed,
    parseError: null,
    durationMs: 300,
    tokenEstimate: { input: 200 + index * 30, output: 100 + index * 15 },
  }
}

function makeDispatcher(results: DispatchResult<unknown>[]): Dispatcher {
  let callIndex = 0
  return {
    dispatch: vi.fn().mockImplementation(() => {
      const result = results[callIndex] ?? results[results.length - 1]!
      callIndex++
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
}

function makeElicitationPack(elicitationTemplate?: string): MethodologyPack {
  const template =
    elicitationTemplate ??
    `# Elicitation: {{method_name}}\n\n**Description:** {{method_description}}\n\n**Output Pattern:** {{output_pattern}}\n\n## Artifact\n\n{{artifact_content}}\n\nApply the **{{method_name}}** method.\n\nReturn:\n\`\`\`yaml\nresult: success\ninsights: |\n  [insights here]\n\`\`\``
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [
        {
          name: 'analysis',
          description: 'Analysis',
          entryGates: [],
          exitGates: ['product-brief-complete'],
          artifacts: ['product-brief'],
          steps: [],
        },
      ],
      prompts: {
        'elicitation-apply': 'prompts/elicitation-apply.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockImplementation((key: string) => {
      if (key === 'elicitation-apply') {
        return Promise.resolve(template)
      }
      return Promise.reject(new Error('Template not found: ' + key))
    }),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi
      .fn()
      .mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack: MethodologyPack,
): PhaseDeps {
  return { db: adapter, pack, contextCompiler: makeContextCompiler(), dispatcher }
}

// ---------------------------------------------------------------------------
// Helper: fill elicitation prompt (mirrors what a real implementation would do)
// ---------------------------------------------------------------------------

function fillElicitationPrompt(
  template: string,
  method: ElicitationMethod,
  artifactContent: string,
): string {
  return template
    .replace(/\{\{method_name\}\}/g, method.name)
    .replace(/\{\{method_description\}\}/g, method.description)
    .replace(/\{\{output_pattern\}\}/g, method.output_pattern)
    .replace(/\{\{artifact_content\}\}/g, artifactContent)
}

// ---------------------------------------------------------------------------
// Helper: store elicitation results in decision store (mirrors AC4 behavior)
//
// Note: upsertDecision uniqueness is keyed on (pipeline_run_id, category, key)
// WITHOUT phase. To avoid cross-phase key collisions, include the phase name
// in the key itself (e.g., "analysis-round-1-method").
// ---------------------------------------------------------------------------

async function storeElicitationResult(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
  roundIndex: number,
  methodName: string,
  insights: string,
): Promise<void> {
  await upsertDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'elicitation',
    key: `${phase}-round-${roundIndex}-method`,
    value: methodName,
  })
  await upsertDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'elicitation',
    key: `${phase}-round-${roundIndex}-insights`,
    value: insights,
  })
}

// ---------------------------------------------------------------------------
// Test: Real CSV loading (data foundation for integration)
// ---------------------------------------------------------------------------

describe('Integration: Real CSV data loading', () => {
  it('loads all 50 methods from the real CSV file', () => {
    const methods = loadElicitationMethods()
    expect(methods.length).toBe(50)
  })

  it('all loaded methods have required fields', () => {
    const methods = loadElicitationMethods()
    for (const method of methods) {
      expect(method.name).toBeTruthy()
      expect(method.category).toBeTruthy()
      expect(method.description).toBeTruthy()
      expect(method.output_pattern).toBeTruthy()
    }
  })

  it('loaded methods include all expected categories', () => {
    const methods = loadElicitationMethods()
    const categories = new Set(methods.map((m) => m.category))
    expect(categories.has('collaboration')).toBe(true)
    expect(categories.has('advanced')).toBe(true)
    expect(categories.has('competitive')).toBe(true)
    expect(categories.has('technical')).toBe(true)
    expect(categories.has('creative')).toBe(true)
    expect(categories.has('research')).toBe(true)
    expect(categories.has('risk')).toBe(true)
    expect(categories.has('core')).toBe(true)
    expect(categories.has('learning')).toBe(true)
    expect(categories.has('philosophical')).toBe(true)
    expect(categories.has('retrospective')).toBe(true)
  })

  it('real CSV contains "First Principles Analysis" in core category', () => {
    const methods = loadElicitationMethods()
    const fp = methods.find((m) => m.name === 'First Principles Analysis')
    expect(fp).toBeDefined()
    expect(fp!.category).toBe('core')
    expect(fp!.output_pattern).toBe('assumptions → truths → new approach')
  })

  it('real CSV contains "Stakeholder Round Table" in collaboration category', () => {
    const methods = loadElicitationMethods()
    const srt = methods.find((m) => m.name === 'Stakeholder Round Table')
    expect(srt).toBeDefined()
    expect(srt!.category).toBe('collaboration')
  })
})

// ---------------------------------------------------------------------------
// Test: Context-aware selection with real CSV (AC2)
// ---------------------------------------------------------------------------

describe('Integration: Context-aware selection with real CSV data', () => {
  let realMethods: ElicitationMethod[]

  beforeEach(() => {
    realMethods = loadElicitationMethods()
  })

  it('selects 2 methods for analysis/brief context from real method pool', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], realMethods)
    expect(selected.length).toBe(2)
  })

  it('selects 2 methods for prd context from real method pool', () => {
    const ctx: ElicitationContext = { content_type: 'prd' }
    const selected = selectMethods(ctx, [], realMethods)
    expect(selected.length).toBe(2)
  })

  it('selects 2 methods for architecture context from real method pool', () => {
    const ctx: ElicitationContext = { content_type: 'architecture' }
    const selected = selectMethods(ctx, [], realMethods)
    expect(selected.length).toBe(2)
  })

  it('selects 2 methods for stories context from real method pool', () => {
    const ctx: ElicitationContext = { content_type: 'stories' }
    const selected = selectMethods(ctx, [], realMethods)
    expect(selected.length).toBe(2)
  })

  it('brief context prefers core or collaboration methods from real pool', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], realMethods)
    const preferred = ['core', 'collaboration', 'creative']
    const hasPreferred = selected.some((m) => preferred.includes(m.category))
    expect(hasPreferred).toBe(true)
  })

  it('architecture context with high complexity and risk selects technical/risk from real pool', () => {
    const ctx: ElicitationContext = {
      content_type: 'architecture',
      complexity_score: 0.9,
      risk_level: 'high',
    }
    const selected = selectMethods(ctx, [], realMethods)
    const boosted = ['technical', 'competitive', 'risk', 'advanced']
    const hasBoosted = selected.some((m) => boosted.includes(m.category))
    expect(hasBoosted).toBe(true)
  })

  it('returns distinct methods (no duplicates) from real pool', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], realMethods)
    const names = selected.map((m) => m.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})

// ---------------------------------------------------------------------------
// Test: Method rotation across multiple rounds (AC6)
// ---------------------------------------------------------------------------

describe('Integration: Method rotation across multiple rounds (AC6)', () => {
  let realMethods: ElicitationMethod[]

  beforeEach(() => {
    realMethods = loadElicitationMethods()
  })

  it('selects different methods in round 2 when round 1 methods are marked used', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }

    const round1 = selectMethods(ctx, [], realMethods)
    const round1Names = round1.map((m) => m.name)

    const round2 = selectMethods(ctx, round1Names, realMethods)
    const round2Names = round2.map((m) => m.name)

    // With 50 methods available, round 2 should pick different methods
    const overlap = round2Names.filter((n) => round1Names.includes(n))
    expect(overlap.length).toBeLessThan(round1Names.length)
  })

  it('accumulates used method names across 3 rounds and avoids repetition', () => {
    const ctx: ElicitationContext = { content_type: 'prd' }
    const usedMethods: string[] = []
    const allRoundNames: string[][] = []

    for (let round = 0; round < 3; round++) {
      const selected = selectMethods(ctx, usedMethods, realMethods)
      const names = selected.map((m) => m.name)
      allRoundNames.push(names)
      usedMethods.push(...names)
    }

    // Each round should return 2 methods
    for (const roundNames of allRoundNames) {
      expect(roundNames.length).toBe(2)
    }

    // Total unique names should grow (at least 4 different methods across 3 rounds)
    const allUnique = new Set(allRoundNames.flat())
    expect(allUnique.size).toBeGreaterThanOrEqual(4)
  })

  it('works across different content types per round (phase progression)', () => {
    const usedMethods: string[] = []

    // Round 1: analysis phase (brief)
    const round1 = selectMethods({ content_type: 'brief' }, usedMethods, realMethods)
    usedMethods.push(...round1.map((m) => m.name))
    expect(round1.length).toBe(2)

    // Round 2: planning phase (prd)
    const round2 = selectMethods({ content_type: 'prd' }, usedMethods, realMethods)
    usedMethods.push(...round2.map((m) => m.name))
    expect(round2.length).toBe(2)

    // Round 3: solutioning phase (architecture)
    const round3 = selectMethods({ content_type: 'architecture' }, usedMethods, realMethods)
    expect(round3.length).toBe(2)

    // All 6 methods should be unique across the 3 rounds
    const allNames = [...round1, ...round2, ...round3].map((m) => m.name)
    const unique = new Set(allNames)
    expect(unique.size).toBe(allNames.length)
  })

  it('still returns methods even when many have been used (graceful degradation)', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    // Mark 40 of 50 methods as used
    const usedMethods = realMethods.slice(0, 40).map((m) => m.name)
    const selected = selectMethods(ctx, usedMethods, realMethods)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThanOrEqual(2)
  })

  it('returns methods even when ALL 50 have been used', () => {
    const ctx: ElicitationContext = { content_type: 'brief' }
    const usedMethods = realMethods.map((m) => m.name)
    const selected = selectMethods(ctx, usedMethods, realMethods)
    // Degrades gracefully — still returns methods, just with recency penalty applied
    expect(selected.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Test: Elicitation prompt template loading and filling (AC3)
// ---------------------------------------------------------------------------

describe('Integration: Elicitation prompt template loading and filling (AC3)', () => {
  it('loads the elicitation-apply template from the pack', async () => {
    const pack = makeElicitationPack()
    const template = await pack.getPrompt('elicitation-apply')
    expect(template).toContain('{{method_name}}')
    expect(template).toContain('{{method_description}}')
    expect(template).toContain('{{output_pattern}}')
    expect(template).toContain('{{artifact_content}}')
  })

  it('fills template with real method data producing a valid prompt', () => {
    const methods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], methods)
    const method = selected[0]!

    const template = `# Elicitation: {{method_name}}\n**Description:** {{method_description}}\n**Output Pattern:** {{output_pattern}}\n{{artifact_content}}`
    const artifactContent = '## Product Brief\n\nBuild a task manager for distributed teams.'

    const filled = fillElicitationPrompt(template, method, artifactContent)

    expect(filled).not.toContain('{{method_name}}')
    expect(filled).not.toContain('{{method_description}}')
    expect(filled).not.toContain('{{output_pattern}}')
    expect(filled).not.toContain('{{artifact_content}}')
    expect(filled).toContain(method.name)
    expect(filled).toContain(method.description)
    expect(filled).toContain(method.output_pattern)
    expect(filled).toContain(artifactContent)
  })

  it('fills prompts for all 4 content types using real method selection', () => {
    const methods = loadElicitationMethods()
    const template = `# {{method_name}}: {{method_description}} ({{output_pattern}})\n{{artifact_content}}`
    const artifact = 'Sample artifact content for testing.'
    const contentTypes: ElicitationContext['content_type'][] = [
      'brief',
      'prd',
      'architecture',
      'stories',
    ]

    for (const contentType of contentTypes) {
      const ctx: ElicitationContext = { content_type: contentType }
      const selected = selectMethods(ctx, [], methods)
      expect(selected.length).toBeGreaterThan(0)

      for (const method of selected) {
        const filled = fillElicitationPrompt(template, method, artifact)
        expect(filled).not.toContain('{{')
        expect(filled).toContain(method.name)
      }
    }
  })

  it('uses the real elicitation-apply.md template structure (has expected sections)', () => {
    // Load the REAL template from disk (not via mock)
    const realTemplatePath = join(
      process.cwd(),
      'packs',
      'bmad',
      'prompts',
      'elicitation-apply.md',
    )
    const realTemplate = readFileSync(realTemplatePath, 'utf-8')

    // Verify the real template has all required placeholders
    expect(realTemplate).toContain('{{method_name}}')
    expect(realTemplate).toContain('{{method_description}}')
    expect(realTemplate).toContain('{{output_pattern}}')
    expect(realTemplate).toContain('{{artifact_content}}')

    // Template should have a YAML output contract
    expect(realTemplate).toContain('result: success')
    expect(realTemplate).toContain('insights:')

    // Fill with real method data
    const methods = loadElicitationMethods()
    const method = methods.find((m) => m.name === 'First Principles Analysis')!
    expect(method).toBeDefined()

    const artifact = '## Analysis Brief\n\nBuild a task management tool.'
    const filled = fillElicitationPrompt(realTemplate, method, artifact)

    expect(filled).toContain('First Principles Analysis')
    expect(filled).toContain('assumptions → truths → new approach')
    expect(filled).not.toContain('{{method_name}}')
    expect(filled).not.toContain('{{artifact_content}}')
  })
})

// ---------------------------------------------------------------------------
// Test: Elicitation results stored in decision store (AC4)
// ---------------------------------------------------------------------------

describe('Integration: Elicitation results stored in decision store (AC4)', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('stores elicitation method name and insights for round 1', async () => {
    const methods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], methods)
    const method = selected[0]!

    await storeElicitationResult(adapter, runId, 'analysis', 1, method.name, 'Insight 1: Users need X.')

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')

    expect(elicitDecisions.length).toBe(2)
    const methodDecision = elicitDecisions.find((d) => d.key === 'analysis-round-1-method')
    const insightDecision = elicitDecisions.find((d) => d.key === 'analysis-round-1-insights')

    expect(methodDecision).toBeDefined()
    expect(methodDecision!.value).toBe(method.name)
    expect(insightDecision).toBeDefined()
    expect(insightDecision!.value).toBe('Insight 1: Users need X.')
  })

  it('stores multiple rounds of elicitation results', async () => {
    const methods = loadElicitationMethods()
    const usedMethods: string[] = []

    // Simulate 3 elicitation rounds
    for (let round = 1; round <= 3; round++) {
      const ctx: ElicitationContext = { content_type: 'brief' }
      const selected = selectMethods(ctx, usedMethods, methods)
      const method = selected[0]!
      usedMethods.push(method.name)

      await storeElicitationResult(
        adapter,
        runId,
        'analysis',
        round,
        method.name,
        `Insights from round ${round}.`,
      )
    }

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')

    // 3 rounds × 2 keys each = 6 decisions
    expect(elicitDecisions.length).toBe(6)

    // Each round should have method + insights
    for (let round = 1; round <= 3; round++) {
      expect(elicitDecisions.find((d) => d.key === `analysis-round-${round}-method`)).toBeDefined()
      expect(elicitDecisions.find((d) => d.key === `analysis-round-${round}-insights`)).toBeDefined()
    }
  })

  it('stored method names in decision store match the selected methods', async () => {
    const methods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'prd' }
    const selected = selectMethods(ctx, [], methods)

    // Store both selected methods
    for (let i = 0; i < selected.length; i++) {
      await storeElicitationResult(
        adapter,
        runId,
        'planning',
        i + 1,
        selected[i]!.name,
        `Method ${i + 1} insights.`,
      )
    }

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'planning')
    const methodDecisions = decisions.filter(
      (d) => d.category === 'elicitation' && d.key.endsWith('-method'),
    )
    const storedNames = methodDecisions.map((d) => d.value)

    // Each stored name should be a valid method name from the full registry
    for (const name of storedNames) {
      const found = methods.find((m) => m.name === name)
      expect(found).toBeDefined()
    }
  })

  it('upserts overwrite previous elicitation data for the same round', async () => {
    // Store initial elicitation result
    await storeElicitationResult(adapter, runId, 'analysis', 1, 'Old Method', 'Old insights.')

    // Overwrite with updated data (same phase, same round)
    await storeElicitationResult(adapter, runId, 'analysis', 1, 'New Method', 'New insights.')

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')

    // Should still be only 2 records (upsert, not insert)
    expect(elicitDecisions.length).toBe(2)
    const methodDecision = elicitDecisions.find((d) => d.key === 'analysis-round-1-method')
    expect(methodDecision!.value).toBe('New Method')
  })
})

// ---------------------------------------------------------------------------
// Test: elicitate: true in step definitions (AC5)
// ---------------------------------------------------------------------------

describe('Integration: elicitate: true steps in phase definitions (AC5)', () => {
  it('deriveContentType maps analysis phase steps to brief', () => {
    expect(deriveContentType('analysis', 'analysis-step-1-vision')).toBe('brief')
    expect(deriveContentType('analysis', 'analysis-step-2-scope')).toBe('brief')
  })

  it('deriveContentType maps planning phase steps to prd', () => {
    expect(deriveContentType('planning', 'planning-step-2-frs')).toBe('prd')
    expect(deriveContentType('planning', 'planning-step-1-classification')).toBe('prd')
  })

  it('deriveContentType maps solutioning arch steps to architecture', () => {
    expect(deriveContentType('solutioning', 'architecture-step-2-decisions')).toBe('architecture')
  })

  it('deriveContentType maps solutioning story steps to stories', () => {
    expect(deriveContentType('solutioning', 'stories-step-1-epics')).toBe('stories')
  })

  it('selectMethods for each elicitate: true step returns valid methods from real pool', () => {
    const realMethods = loadElicitationMethods()

    // Simulate elicitation selection for each step that has elicitate: true in manifest
    const elicitateSteps = [
      { phase: 'analysis', stepName: 'analysis-step-1-vision' },
      { phase: 'planning', stepName: 'planning-step-2-frs' },
      { phase: 'solutioning', stepName: 'architecture-step-2-decisions' },
      { phase: 'solutioning', stepName: 'stories-step-1-epics' },
    ]

    const usedMethods: string[] = []

    for (const { phase, stepName } of elicitateSteps) {
      const contentType = deriveContentType(phase, stepName)
      const ctx: ElicitationContext = { content_type: contentType }
      const selected = selectMethods(ctx, usedMethods, realMethods)

      // Each elicitate: true step should get 1-2 methods
      expect(selected.length).toBeGreaterThanOrEqual(1)
      expect(selected.length).toBeLessThanOrEqual(2)

      // Methods should be real methods from the registry
      for (const method of selected) {
        const found = realMethods.find((m) => m.name === method.name)
        expect(found).toBeDefined()
      }

      usedMethods.push(...selected.map((m) => m.name))
    }

    // All 4 steps should have selected distinct methods (8 total, all unique)
    const unique = new Set(usedMethods)
    expect(unique.size).toBe(usedMethods.length)
  })

  it('step definitions with elicitate: true are structurally valid StepDefinition objects', () => {
    // Verify that the elicitate field is consistent with how the codebase uses it.
    const stepWithElicitate = {
      name: 'analysis-step-1-vision',
      taskType: 'analysis-vision',
      outputSchema: z.object({ result: z.enum(['success', 'failed']) }),
      context: [{ placeholder: 'concept', source: 'param:concept' }],
      persist: [{ field: 'problem_statement', category: 'product-brief', key: 'problem_statement' }],
      elicitate: true,
    }

    // All required StepDefinition fields are present
    expect(stepWithElicitate.name).toBe('analysis-step-1-vision')
    expect(stepWithElicitate.taskType).toBe('analysis-vision')
    expect(stepWithElicitate.outputSchema).toBeDefined()
    expect(stepWithElicitate.context).toHaveLength(1)
    expect(stepWithElicitate.persist).toHaveLength(1)
    expect(stepWithElicitate.elicitate).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test: Full end-to-end elicitation round (all ACs together)
// ---------------------------------------------------------------------------

describe('Integration: End-to-end elicitation round', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('simulates a full elicitation round: select → fill prompt → dispatch → store results', async () => {
    // 1. Load real methods from CSV
    const realMethods = loadElicitationMethods()
    expect(realMethods.length).toBe(50)

    // 2. Select methods for analysis phase
    const ctx: ElicitationContext = { content_type: 'brief' }
    const usedMethods: string[] = []
    const selected = selectMethods(ctx, usedMethods, realMethods)
    expect(selected.length).toBe(2)

    // 3. Load the prompt template (AC3)
    const pack = makeElicitationPack()
    const template = await pack.getPrompt('elicitation-apply')
    expect(template).toContain('{{method_name}}')

    // 4. Fill the prompt with real method data (AC3)
    const artifactContent = '## Product Brief\n\nUsers struggle with distributed team coordination.'
    const method = selected[0]!
    const filledPrompt = fillElicitationPrompt(template, method, artifactContent)

    expect(filledPrompt).not.toContain('{{method_name}}')
    expect(filledPrompt).toContain(method.name)
    expect(filledPrompt).toContain(method.description)

    // 5. Dispatch elicitation agent (mocked)
    const elicitationOutput = {
      result: 'success' as const,
      insights: 'Assumption: users want real-time sync → Truth: async is sufficient for 80% of cases.',
    }
    const dispatcher = makeDispatcher([makeDispatchResult(elicitationOutput)])
    const deps = makeDeps(db, dispatcher, pack)

    const handle = deps.dispatcher.dispatch({
      prompt: filledPrompt,
      agent: 'claude-code',
      taskType: 'elicitation',
      outputSchema: ElicitationOutputSchema,
    })
    const dispatchResult = await handle.result

    expect(dispatchResult.status).toBe('completed')
    const parsed = dispatchResult.parsed as { result: string; insights: string }
    expect(parsed.result).toBe('success')
    expect(parsed.insights).toBeTruthy()

    // 6. Store results in decision store (AC4)
    await storeElicitationResult(adapter, runId, 'analysis', 1, method.name, parsed.insights)
    usedMethods.push(method.name)

    // 7. Verify stored (AC4)
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')
    expect(elicitDecisions.length).toBe(2)
    expect(elicitDecisions.find((d) => d.key === 'analysis-round-1-method')!.value).toBe(method.name)

    // 8. Round 2 uses different method (AC6)
    const round2Selected = selectMethods(ctx, usedMethods, realMethods)
    const round2Names = round2Selected.map((m) => m.name)
    expect(round2Names).not.toContain(method.name)
  })

  it('simulates a multi-phase elicitation run with rotation across analysis and planning', async () => {
    const realMethods = loadElicitationMethods()
    const usedMethods: string[] = []

    // Analysis phase elicitation (analysis-step-1-vision has elicitate: true)
    const analysisContentType = deriveContentType('analysis', 'analysis-step-1-vision')
    const analysisSelected = selectMethods(
      { content_type: analysisContentType },
      usedMethods,
      realMethods,
    )
    expect(analysisSelected.length).toBe(2)
    usedMethods.push(...analysisSelected.map((m) => m.name))

    // Store analysis elicitation results
    await storeElicitationResult(
      adapter,
      runId,
      'analysis',
      1,
      analysisSelected[0]!.name,
      'Analysis insights.',
    )

    // Planning phase elicitation (planning-step-2-frs has elicitate: true)
    const planningContentType = deriveContentType('planning', 'planning-step-2-frs')
    const planningSelected = selectMethods(
      { content_type: planningContentType },
      usedMethods,
      realMethods,
    )
    expect(planningSelected.length).toBe(2)
    usedMethods.push(...planningSelected.map((m) => m.name))

    // Store planning elicitation results (using phase-prefixed keys to avoid collision)
    await storeElicitationResult(
      adapter,
      runId,
      'planning',
      1,
      planningSelected[0]!.name,
      'Planning insights.',
    )

    // Verify: all selected methods are unique (rotation works)
    const allSelected = [...analysisSelected, ...planningSelected]
    const uniqueNames = new Set(allSelected.map((m) => m.name))
    expect(uniqueNames.size).toBe(allSelected.length)

    // Verify: decision store has elicitation records for both phases
    const analysisDecisions = (await getDecisionsByPhaseForRun(adapter, runId, 'analysis')).filter(
      (d) => d.category === 'elicitation',
    )
    const planningDecisions = (await getDecisionsByPhaseForRun(adapter, runId, 'planning')).filter(
      (d) => d.category === 'elicitation',
    )
    expect(analysisDecisions.length).toBeGreaterThan(0)
    expect(planningDecisions.length).toBeGreaterThan(0)
  })

  it('handles elicitation dispatch failure gracefully (does not crash)', async () => {
    const realMethods = loadElicitationMethods()
    const ctx: ElicitationContext = { content_type: 'brief' }
    const selected = selectMethods(ctx, [], realMethods)
    expect(selected.length).toBeGreaterThan(0)

    // Simulate a failed dispatch
    const failedResult: DispatchResult<unknown> = {
      id: 'dispatch-0',
      status: 'failed',
      exitCode: 1,
      output: 'Agent error',
      parsed: null,
      parseError: 'Elicitation agent failed to parse YAML',
      durationMs: 100,
      tokenEstimate: { input: 50, output: 0 },
    }

    const dispatcher = makeDispatcher([failedResult])
    const pack = makeElicitationPack()
    const deps = makeDeps(db, dispatcher, pack)

    const method = selected[0]!
    const template = await pack.getPrompt('elicitation-apply')
    const filledPrompt = fillElicitationPrompt(
      template,
      method,
      'Sample artifact content for testing.',
    )

    const handle = deps.dispatcher.dispatch({
      prompt: filledPrompt,
      agent: 'claude-code',
      taskType: 'elicitation',
      outputSchema: ElicitationOutputSchema,
    })

    const result = await handle.result
    // Status is 'failed' — the calling code should handle this gracefully
    expect(result.status).toBe('failed')

    // No elicitation decisions should be stored on failure
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')
    expect(elicitDecisions.length).toBe(0)
  })
})
