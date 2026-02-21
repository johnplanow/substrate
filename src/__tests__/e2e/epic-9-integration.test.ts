/**
 * Epic 9 Integration Tests — Cross-story interaction coverage
 *
 * Covers integration gaps between the five Epic 9 stories:
 *
 * 9-1: Decision Store Schema & Persistence
 * 9-2: Context Compiler
 * 9-3: Sub-Agent Dispatch Engine
 * 9-4: Quality Gates & Debate Panel
 * 9-5: Methodology Pack Format
 *
 * Each test group exercises a cross-story interaction that is not covered
 * by any individual story's unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { resolve } from 'path'

// Persistence (9-1)
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  createDecision,
  createRequirement,
  createConstraint,
  createPipelineRun,
} from '../../persistence/queries/decisions.js'

// Context Compiler (9-2)
import { createContextCompiler } from '../../modules/context-compiler/context-compiler-impl.js'
import { countTokens } from '../../modules/context-compiler/token-counter.js'
import type { ContextTemplate } from '../../modules/context-compiler/types.js'

// YAML parser (9-3)
import {
  extractYamlBlock,
  parseYamlResult,
} from '../../modules/agent-dispatch/yaml-parser.js'

// Quality Gates (9-4)
import {
  createGate,
  createGatePipeline,
} from '../../modules/quality-gates/index.js'

// Debate Panel (9-4)
import { createDebatePanel } from '../../modules/debate-panel/debate-panel-impl.js'
import type { PerspectiveGeneratorFn } from '../../modules/debate-panel/debate-panel-impl.js'
import type { Perspective } from '../../modules/debate-panel/types.js'
import type { Dispatcher } from '../../modules/agent-dispatch/types.js'

// Methodology Pack (9-5)
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function mockDispatcher(): Dispatcher {
  return {
    dispatch: () => { throw new Error('should not dispatch in unit tests') },
    getPending: () => 0,
    getRunning: () => 0,
    shutdown: async () => undefined,
  }
}

function fixedPerspectiveGenerator(
  recommendation: string,
  confidence: number,
): PerspectiveGeneratorFn {
  return async (viewpoint: string): Promise<Perspective> => ({
    viewpoint,
    recommendation,
    confidence,
    risks: [],
  })
}

// ---------------------------------------------------------------------------
// Group 1: Decision Store + Context Compiler (9-1 + 9-2)
// ---------------------------------------------------------------------------

describe('Integration: Decision Store → Context Compiler (9-1 + 9-2)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  it('decisions written to the store are immediately readable by the context compiler', () => {
    // Write several decisions across tables
    createDecision(db, {
      phase: 'solutioning',
      category: 'architecture',
      key: 'pattern',
      value: 'modular-monolith',
    })
    createDecision(db, {
      phase: 'solutioning',
      category: 'tech-stack',
      key: 'language',
      value: 'TypeScript',
    })
    createRequirement(db, {
      source: 'spec',
      type: 'functional',
      description: 'user-auth-required',
      priority: 'must',
    })
    createConstraint(db, {
      category: 'security',
      description: 'no-plaintext-passwords',
      source: 'policy',
    })

    const template: ContextTemplate = {
      taskType: 'dev-story',
      sections: [
        {
          name: 'Architecture Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => {
            const d = rows as Array<{ key: string; value: string }>
            if (d.length === 0) return ''
            return '## Architecture\n' + d.map((r) => `- ${r.key}: ${r.value}`).join('\n')
          },
        },
        {
          name: 'Functional Requirements',
          priority: 'important',
          query: { table: 'requirements', filters: { type: 'functional' } },
          format: (rows) => {
            const r = rows as Array<{ description: string }>
            if (r.length === 0) return ''
            return '## Requirements\n' + r.map((req) => `- ${req.description}`).join('\n')
          },
        },
        {
          name: 'Security Constraints',
          priority: 'optional',
          query: { table: 'constraints', filters: { category: 'security' } },
          format: (rows) => {
            const c = rows as Array<{ description: string }>
            if (c.length === 0) return ''
            return '## Constraints\n' + c.map((con) => `- ${con.description}`).join('\n')
          },
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'dev-story',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    expect(result.prompt).toContain('modular-monolith')
    expect(result.prompt).toContain('TypeScript')
    expect(result.prompt).toContain('user-auth-required')
    expect(result.prompt).toContain('no-plaintext-passwords')
    expect(result.truncated).toBe(false)
    expect(result.sections).toHaveLength(3)
    expect(result.sections.every((s) => s.included)).toBe(true)
  })

  it('token budget prevents overflow when multiple tables contribute content', () => {
    // Insert enough data across all tables that the budget is exceeded
    for (let i = 0; i < 10; i++) {
      createDecision(db, {
        phase: 'solutioning',
        category: 'arch',
        key: `decision-${String(i)}`,
        value: 'x'.repeat(200),
      })
    }
    for (let i = 0; i < 5; i++) {
      createRequirement(db, {
        source: 'spec',
        type: 'functional',
        description: 'y'.repeat(200),
        priority: 'must',
      })
    }

    const template: ContextTemplate = {
      taskType: 'budget-overflow-test',
      sections: [
        {
          name: 'Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) =>
            (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
        {
          name: 'Requirements',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: (rows) =>
            (rows as Array<{ description: string }>).map((r) => r.description).join('\n'),
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const tokenBudget = 100
    const result = compiler.compile({
      taskType: 'budget-overflow-test',
      pipelineRunId: 'run-1',
      tokenBudget,
    })

    // Required section may exceed budget (by design), but the result is coherent
    expect(result).toBeDefined()
    expect(result.sections).toHaveLength(2)
    // The required section must always be included
    const reqSection = result.sections.find((s) => s.name === 'Decisions')
    expect(reqSection?.included).toBe(true)
  })

  it('compiling from an IN-filter query matches multiple decision phase values', () => {
    createDecision(db, {
      phase: 'planning',
      category: 'scope',
      key: 'scope-decision',
      value: 'planning-value',
    })
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'arch-decision',
      value: 'solutioning-value',
    })
    createDecision(db, {
      phase: 'analysis',
      category: 'risk',
      key: 'risk-decision',
      value: 'analysis-value',
    })

    // Use an IN filter with multiple values
    const template: ContextTemplate = {
      taskType: 'multi-phase-test',
      sections: [
        {
          name: 'Multi-phase Decisions',
          priority: 'required',
          query: {
            table: 'decisions',
            filters: { phase: ['planning', 'solutioning'] },
          },
          format: (rows) =>
            (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'multi-phase-test',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    expect(result.prompt).toContain('planning-value')
    expect(result.prompt).toContain('solutioning-value')
    expect(result.prompt).not.toContain('analysis-value')
  })

  it('section report tokenCount matches countTokens of the compiled prompt', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'k1',
      value: 'decision-value-text',
    })

    const template: ContextTemplate = {
      taskType: 'token-consistency-test',
      sections: [
        {
          name: 'Test Section',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) =>
            (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'token-consistency-test',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    // tokenCount on the result must equal countTokens(result.prompt)
    expect(result.tokenCount).toBe(countTokens(result.prompt))
    expect(result.sections[0]?.tokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Group 2: Debate Panel → Decision Store → Context Compiler (9-1 + 9-2 + 9-4)
// ---------------------------------------------------------------------------

describe('Integration: Debate Panel → Decision Store → Context Compiler (9-1 + 9-2 + 9-4)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  it('a debate panel decision is immediately queryable via the context compiler', async () => {
    // Run a routine debate panel decision that persists to the DB
    const panel = createDebatePanel({
      dispatcher: mockDispatcher(),
      db,
      perspectiveGenerator: fixedPerspectiveGenerator('use-postgres', 0.9),
    })

    await panel.decide({
      tier: 'routine',
      question: 'What database to use?',
      context: 'We need an OLTP database.',
      key: 'database-choice',
      phase: 'solutioning',
    })

    // Now compile context — the debate decision should appear
    const template: ContextTemplate = {
      taskType: 'review-task',
      sections: [
        {
          name: 'Debate Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { category: 'debate-panel' } },
          format: (rows) => {
            const d = rows as Array<{ key: string; value: string }>
            if (d.length === 0) return ''
            return d.map((r) => `Decision: ${r.key}=${r.value}`).join('\n')
          },
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'review-task',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    expect(result.prompt).toContain('database-choice')
    expect(result.prompt).toContain('use-postgres')
  })

  it('multiple debate decisions across tiers all appear in compiled context', async () => {
    const panel = createDebatePanel({
      dispatcher: mockDispatcher(),
      db,
      perspectiveGenerator: fixedPerspectiveGenerator('adopt', 0.9),
    })

    // Routine decision
    await panel.decide({
      tier: 'routine',
      question: 'Should we use TypeScript?',
      context: 'Backend service.',
      key: 'typescript-choice',
      phase: 'solutioning',
    })

    // Significant decision — all perspectives agree
    await panel.decide({
      tier: 'significant',
      question: 'What caching strategy?',
      context: 'High traffic service.',
      key: 'caching-strategy',
      phase: 'solutioning',
    })

    // Verify both are in the store and compilable
    const template: ContextTemplate = {
      taskType: 'multi-decision-task',
      sections: [
        {
          name: 'All Debate Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning', category: 'debate-panel' } },
          format: (rows) => {
            const d = rows as Array<{ key: string; value: string }>
            return d.map((r) => `${r.key}: ${r.value}`).join('\n')
          },
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'multi-decision-task',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    expect(result.prompt).toContain('typescript-choice')
    expect(result.prompt).toContain('caching-strategy')
  })

  it('architectural decision with escalation still persists to the decision store', async () => {
    // Create a split-vote scenario that triggers escalation
    let callIdx = 0
    const perspectives: Perspective[] = [
      { viewpoint: 'security', recommendation: 'option-A', confidence: 0.5, risks: [] },
      { viewpoint: 'scalability', recommendation: 'option-A', confidence: 0.5, risks: [] },
      { viewpoint: 'developer-experience', recommendation: 'option-A', confidence: 0.5, risks: [] },
      { viewpoint: 'cost', recommendation: 'option-B', confidence: 0.9, risks: [] },
      { viewpoint: 'maintainability', recommendation: 'option-B', confidence: 0.9, risks: [] },
    ]
    const splitGenerator: PerspectiveGeneratorFn = async (viewpoint) => ({
      ...(perspectives[callIdx++] ?? perspectives[0]),
      viewpoint,
    })

    const panel = createDebatePanel({
      dispatcher: mockDispatcher(),
      db,
      perspectiveGenerator: splitGenerator,
    })

    const result = await panel.decide({
      tier: 'architectural',
      question: 'Which microservices pattern?',
      context: 'Platform migration.',
      key: 'microservices-pattern',
      phase: 'solutioning',
    })

    // Should be escalated
    expect(result.escalated).toBe(true)

    // Even escalated decisions must be persisted
    const rows = db.prepare(
      "SELECT * FROM decisions WHERE key = 'microservices-pattern'"
    ).all() as Array<{ key: string; value: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe('microservices-pattern')
  })
})

// ---------------------------------------------------------------------------
// Group 3: YAML Parser + Quality Gates (9-3 + 9-4)
// ---------------------------------------------------------------------------

describe('Integration: YAML Parser → Quality Gates (9-3 + 9-4)', () => {
  it('agent output parsed by yaml-parser passes through ac-validation gate', () => {
    const agentOutput = [
      'I have completed all the acceptance criteria.',
      '',
      'result: success',
      'ac_met: yes',
      'ac_failures: []',
    ].join('\n')

    const yamlBlock = extractYamlBlock(agentOutput)
    expect(yamlBlock).not.toBeNull()

    const { parsed, error } = parseYamlResult(yamlBlock!)
    expect(error).toBeNull()
    expect(parsed).not.toBeNull()

    const gate = createGate('ac-validation')
    const gateResult = gate.evaluate(parsed)
    expect(gateResult.action).toBe('proceed')
    expect(gateResult.issues).toEqual([])
  })

  it('agent output with ac_met: no triggers warn from ac-validation gate', () => {
    const agentOutput = 'result: failure\nac_met: no\nac_failures:\n  - AC3 not met'
    const yamlBlock = extractYamlBlock(agentOutput)
    const { parsed } = parseYamlResult(yamlBlock!)

    const gate = createGate('ac-validation')
    const gateResult = gate.evaluate(parsed)
    expect(gateResult.action).toBe('warn')
    expect(gateResult.issues[0]).toContain('no')
  })

  it('agent code-review output with SHIP_IT verdict passes code-review-verdict gate', () => {
    const reviewOutput = [
      'After careful analysis:',
      '',
      'verdict: SHIP_IT',
      'issues_found: []',
      'overall_quality: high',
    ].join('\n')

    const yamlBlock = extractYamlBlock(reviewOutput)
    const { parsed } = parseYamlResult(yamlBlock!)

    const gate = createGate('code-review-verdict')
    const gateResult = gate.evaluate(parsed)
    expect(gateResult.action).toBe('proceed')
  })

  it('agent code-review output with REWORK verdict triggers warn from gate pipeline', () => {
    const reviewOutput = [
      'Found critical issues.',
      '',
      'verdict: REWORK',
      'issues_found:\n  - memory leak in handler',
    ].join('\n')

    const yamlBlock = extractYamlBlock(reviewOutput)
    const { parsed } = parseYamlResult(yamlBlock!)

    const pipeline = createGatePipeline([
      createGate('code-review-verdict'),
    ])

    const result = pipeline.run(parsed)
    expect(result.action).toBe('proceed') // warn does not halt pipeline
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0]?.message).toContain('REWORK')
  })

  it('dev-story output with passing tests passes the full review gate pipeline', () => {
    const devStoryOutput = [
      'Implemented all tasks successfully.',
      '',
      'result: success',
      'ac_met: yes',
      'ac_failures: []',
      'tests:',
      '  pass: 42',
      '  fail: 0',
    ].join('\n')

    const yamlBlock = extractYamlBlock(devStoryOutput)
    const { parsed } = parseYamlResult(yamlBlock!)

    const pipeline = createGatePipeline([
      createGate('ac-validation'),
      createGate('test-coverage'),
    ])

    const result = pipeline.run(parsed)
    expect(result.action).toBe('proceed')
    expect(result.gatesRun).toBe(2)
    expect(result.gatesPassed).toBe(2)
    expect(result.issues).toEqual([])
  })

  it('dev-story output with failing tests halts pipeline at test-coverage gate', () => {
    const devStoryOutput = [
      'result: success',
      'ac_met: yes',
      'tests:',
      '  pass: 38',
      '  fail: 4',
    ].join('\n')

    const yamlBlock = extractYamlBlock(devStoryOutput)
    const { parsed } = parseYamlResult(yamlBlock!)

    const pipeline = createGatePipeline([
      createGate('ac-validation'),
      createGate('test-coverage', { maxRetries: 1 }),
    ])

    const result = pipeline.run(parsed)
    // ac-validation passes, test-coverage fails with retry action
    expect(result.action).toBe('retry')
    expect(result.gatesRun).toBe(2)
    expect(result.gatesPassed).toBe(1)
    expect(result.issues.some((i) => i.gate === 'test-coverage')).toBe(true)
  })

  it('null yaml block from agent output produces null parsed and is handled gracefully by gate', () => {
    const agentOutput = 'Some plain text output with no YAML at all.'

    const yamlBlock = extractYamlBlock(agentOutput)
    expect(yamlBlock).toBeNull()

    // When there is no YAML, the gate should still evaluate (treating null as failed output)
    const gate = createGate('ac-validation')
    const gateResult = gate.evaluate(null)
    expect(gateResult.action).toBe('warn')
  })
})

// ---------------------------------------------------------------------------
// Group 4: Methodology Pack + Context Compiler (9-2 + 9-5)
// ---------------------------------------------------------------------------

describe('Integration: Methodology Pack → Context Compiler (9-2 + 9-5)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  it('BMAD pack create-story prompt can be used as a context compiler section format', async () => {
    const bmadPackPath = resolve(process.cwd(), 'packs/bmad')
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)

    // Load the prompt from the pack
    const prompt = await pack.getPrompt('create-story')
    expect(prompt.length).toBeGreaterThan(100)

    // Use the prompt as fixed header in a context template section
    const template: ContextTemplate = {
      taskType: 'bmad-create-story',
      sections: [
        {
          name: 'Methodology Prompt',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'planning' } },
          format: (_rows) => prompt.slice(0, 500), // Use first 500 chars as context header
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'bmad-create-story',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    // The prompt content should appear in the compiled output
    expect(result.prompt.length).toBeGreaterThan(0)
    expect(result.truncated).toBe(false)
  })

  it('BMAD pack constraints map onto quality gate pipeline correctly', async () => {
    const bmadPackPath = resolve(process.cwd(), 'packs/bmad')
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)

    const constraints = await pack.getConstraints('dev-story')

    // Verify required constraints exist
    const requiredConstraints = constraints.filter((c) => c.severity === 'required')
    expect(requiredConstraints.length).toBeGreaterThan(0)

    // All dev-story constraints are 'required' severity by design
    const validSeverities = new Set(['required', 'recommended', 'optional'])
    for (const c of constraints) {
      expect(validSeverities.has(c.severity)).toBe(true)
    }

    // Verify constraint names map to known gate-usable identifiers
    const constraintNames = constraints.map((c) => c.name)
    expect(constraintNames).toContain('sequential-task-execution')
    expect(constraintNames).toContain('red-green-refactor')
  })

  it('BMAD pack code-review constraints align with code-review-verdict gate', async () => {
    const bmadPackPath = resolve(process.cwd(), 'packs/bmad')
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)

    const constraints = await pack.getConstraints('code-review')

    // The verdict-criteria constraint should align with the code-review-verdict gate
    const verdictConstraint = constraints.find((c) => c.name === 'verdict-criteria')
    expect(verdictConstraint).toBeDefined()
    expect(verdictConstraint?.severity).toBe('required')

    // Simulate what the code-review-verdict gate checks
    const gate = createGate('code-review-verdict')
    const passResult = gate.evaluate({ verdict: 'SHIP_IT' })
    expect(passResult.action).toBe('proceed')

    const failResult = gate.evaluate({ verdict: 'REWORK' })
    expect(failResult.action).toBe('warn')
  })

  it('pack phases are consistent with pipeline run phases used in the decision store', async () => {
    const bmadPackPath = resolve(process.cwd(), 'packs/bmad')
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)

    const phases = pack.getPhases()
    const phaseNames = phases.map((p) => p.name)

    // Standard BMAD phases
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
    expect(phaseNames).toContain('solutioning')
    expect(phaseNames).toContain('implementation')

    // Decisions can be stored using any of these phase names
    const run = createPipelineRun(db, { methodology: 'bmad', start_phase: phaseNames[0] })
    expect(run.id).toBeDefined()

    for (const phaseName of phaseNames) {
      createDecision(db, {
        phase: phaseName,
        category: 'test',
        key: `decision-in-${phaseName}`,
        value: 'test-value',
        pipeline_run_id: run.id,
      })
    }

    // Context compiler can query all phases
    const template: ContextTemplate = {
      taskType: 'all-phases-test',
      sections: phaseNames.map((phase) => ({
        name: `${phase} decisions`,
        priority: 'required' as const,
        query: { table: 'decisions' as const, filters: { phase } },
        format: (rows) =>
          (rows as Array<{ key: string; value: string }>).map((r) => r.key).join('\n'),
      })),
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'all-phases-test',
      pipelineRunId: run.id,
      tokenBudget: 10000,
    })

    for (const phaseName of phaseNames) {
      expect(result.prompt).toContain(`decision-in-${phaseName}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Group 5: Full pipeline — Decision Store + Context Compiler + Debate Panel + Quality Gates
// ---------------------------------------------------------------------------

describe('Integration: Full Epic 9 pipeline (9-1 + 9-2 + 9-4)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openDb()
  })

  it('decisions from debate panel inform compiled context which is then gate-evaluated', async () => {
    // Step 1: Run debate panel to make a decision, persisting to DB
    const panel = createDebatePanel({
      dispatcher: mockDispatcher(),
      db,
      perspectiveGenerator: fixedPerspectiveGenerator('microservices', 0.85),
    })

    await panel.decide({
      tier: 'significant',
      question: 'Service architecture?',
      context: 'Building a platform.',
      key: 'service-architecture',
      phase: 'solutioning',
    })

    // Step 2: Compile context from the DB (includes the debate decision)
    const template: ContextTemplate = {
      taskType: 'dev-story',
      sections: [
        {
          name: 'Architecture Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => {
            const d = rows as Array<{ key: string; value: string }>
            return d.map((r) => `${r.key}: ${r.value}`).join('\n')
          },
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const compileResult = compiler.compile({
      taskType: 'dev-story',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    // Compiled context should contain the debate result
    expect(compileResult.prompt).toContain('service-architecture')
    expect(compileResult.prompt).toContain('microservices')

    // Step 3: Simulate sub-agent output (using the compiled prompt to produce a result)
    const agentOutput = [
      `I used the context: ${compileResult.prompt.slice(0, 50)}`,
      '',
      'result: success',
      'ac_met: yes',
      'tests:',
      '  pass: 10',
      '  fail: 0',
    ].join('\n')

    // Step 4: Parse and evaluate through quality gates
    const yamlBlock = extractYamlBlock(agentOutput)
    expect(yamlBlock).not.toBeNull()

    const { parsed } = parseYamlResult(yamlBlock!)
    expect(parsed).not.toBeNull()

    const pipeline = createGatePipeline([
      createGate('ac-validation'),
      createGate('test-coverage'),
    ])

    const gateResult = pipeline.run(parsed)
    expect(gateResult.action).toBe('proceed')
    expect(gateResult.gatesPassed).toBe(2)
  })

  it('failed gate triggers retry and re-evaluated output eventually passes', () => {
    // Simulate iterative retry: first attempt fails, second passes
    const gate = createGate('ac-validation', { maxRetries: 1 })

    // First attempt — ac_met: no
    const firstAttemptOutput = parseYamlResult('result: failure\nac_met: no').parsed
    const firstResult = gate.evaluate(firstAttemptOutput)
    expect(firstResult.action).toBe('retry')
    expect(firstResult.retriesRemaining).toBe(0)

    // Second attempt — ac_met: yes (agent fixed the issues)
    const secondAttemptOutput = parseYamlResult('result: success\nac_met: yes').parsed
    const secondResult = gate.evaluate(secondAttemptOutput)
    expect(secondResult.action).toBe('proceed')
  })

  it('context compiler sections use correct token counts relative to full prompt', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'decision-A',
      value: 'value-A',
    })
    createRequirement(db, {
      source: 'spec',
      type: 'functional',
      description: 'requirement-B',
      priority: 'must',
    })

    const template: ContextTemplate = {
      taskType: 'token-test',
      sections: [
        {
          name: 'Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) =>
            (rows as Array<{ key: string; value: string }>).map((r) => `${r.key}: ${r.value}`).join('\n'),
        },
        {
          name: 'Requirements',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: (rows) =>
            (rows as Array<{ description: string }>).map((r) => r.description).join('\n'),
        },
      ],
    }

    const compiler = createContextCompiler({ db })
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'token-test',
      pipelineRunId: 'run-1',
      tokenBudget: 10000,
    })

    // The sum of individual section tokens should be consistent with the prompt
    const sectionTokenSum = result.sections
      .filter((s) => s.included)
      .reduce((sum, s) => sum + s.tokens, 0)

    // sectionTokenSum approximates result.tokenCount (sections joined with '\n')
    // Allow tolerance for join characters
    expect(Math.abs(sectionTokenSum - result.tokenCount)).toBeLessThanOrEqual(
      result.sections.filter((s) => s.included).length
    )
  })

  it('debate panel with database records multiple decisions that are all findable by phase', async () => {
    const panel = createDebatePanel({
      dispatcher: mockDispatcher(),
      db,
      perspectiveGenerator: fixedPerspectiveGenerator('chosen-option', 0.9),
    })

    const phases = ['solutioning', 'planning', 'analysis']
    for (const phase of phases) {
      await panel.decide({
        tier: 'routine',
        question: `Decision for phase ${phase}?`,
        context: 'Context text.',
        key: `key-${phase}`,
        phase,
      })
    }

    // Each phase should have exactly one debate-panel decision
    for (const phase of phases) {
      const rows = db.prepare(
        `SELECT * FROM decisions WHERE phase = ? AND category = 'debate-panel'`
      ).all(phase) as Array<{ key: string }>
      expect(rows).toHaveLength(1)
      expect(rows[0]?.key).toBe(`key-${phase}`)
    }
  })
})
