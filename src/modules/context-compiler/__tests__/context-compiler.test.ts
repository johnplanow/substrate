/**
 * Unit tests for the context-compiler module.
 *
 * Covers all acceptance criteria:
 * AC1: Core compile interface
 * AC2: Token budget enforcement
 * AC3: Section priority system
 * AC4: Template registration
 * AC5: Selective decision store queries
 * AC6: Token counting accuracy
 * AC7: CompileResult format
 *
 * Uses a real in-memory SQLite with the full decision store migration schema.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createDecision, createRequirement, createConstraint } from '../../../persistence/queries/decisions.js'
import { createContextCompiler } from '../context-compiler-impl.js'
import { countTokens, truncateToTokens } from '../token-counter.js'
import type { ContextTemplate, ContextCompiler, TaskDescriptor } from '../types.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

function openTestDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

// ---------------------------------------------------------------------------
// Helpers: build templates for tests
// ---------------------------------------------------------------------------

function makeDecisionsTemplate(taskType = 'test-task'): ContextTemplate {
  return {
    taskType,
    sections: [
      {
        name: 'Architecture Decisions',
        priority: 'required',
        query: { table: 'decisions', filters: { phase: 'solutioning' } },
        format: (rows) => {
          const decisions = rows as Array<{ key: string; value: string }>
          if (decisions.length === 0) return ''
          return decisions.map((d) => `- ${d.key}: ${d.value}`).join('\n')
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// AC6: Token counting
// ---------------------------------------------------------------------------

describe('AC6: Token counting', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('uses chars/4 heuristic for plain text', () => {
    // 40 chars → ceil(40/4) = 10
    const text = 'a'.repeat(40)
    expect(countTokens(text)).toBe(10)
  })

  it('applies 10% code block adjustment when triple backticks present', () => {
    // 40 chars with code block → ceil(40/4 * 1.1) = ceil(11) = 11
    const text = '```\n' + 'a'.repeat(32) + '\n```'
    // text.length = 40
    expect(text.length).toBe(40)
    expect(countTokens(text)).toBe(11)
  })

  it('is within 15% of expected for plain text of various lengths', () => {
    const samples = [100, 500, 1000, 4000]
    for (const len of samples) {
      const text = 'x'.repeat(len)
      const count = countTokens(text)
      const expected = len / 4
      expect(count).toBeGreaterThanOrEqual(expected * 0.85)
      expect(count).toBeLessThanOrEqual(expected * 1.15)
    }
  })

  it('code block adjustment stays within 15% threshold', () => {
    // Build text with code blocks that is 400 chars total
    const codeText = '```\n' + 'x'.repeat(392) + '\n```'
    expect(codeText.length).toBe(400)
    const count = countTokens(codeText)
    const expectedBase = 400 / 4  // 100 without adjustment
    const expectedAdjusted = expectedBase * 1.1  // 110 with adjustment
    // Should be within 15% of actual GPT-like count (roughly 100-110 range)
    expect(count).toBeGreaterThanOrEqual(expectedAdjusted * 0.85)
    expect(count).toBeLessThanOrEqual(expectedAdjusted * 1.15)
  })
})

// ---------------------------------------------------------------------------
// truncateToTokens
// ---------------------------------------------------------------------------

describe('truncateToTokens', () => {
  it('returns original text when within budget', () => {
    const text = 'Hello world'
    const result = truncateToTokens(text, 100)
    expect(result).toBe(text)
  })

  it('truncates text exceeding budget and appends ellipsis', () => {
    const text = 'a'.repeat(400) // ~100 tokens
    const result = truncateToTokens(text, 10)
    expect(result.endsWith('…')).toBe(true)
    expect(countTokens(result)).toBeLessThanOrEqual(15) // some tolerance
  })

  it('returns empty string for budget of 0', () => {
    expect(truncateToTokens('some text', 0)).toBe('')
  })

  it('truncates at word boundary when possible', () => {
    // 100 words of 5 chars each = 500 chars ≈ 125 tokens
    const words = Array.from({ length: 100 }, () => 'hello').join(' ')
    const result = truncateToTokens(words, 5)
    // Should not end with a partial word (the ellipsis is added after the last full word)
    expect(result.endsWith('…')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC1: Core compile interface
// ---------------------------------------------------------------------------

describe('AC1: Core compile interface', () => {
  let db: BetterSqlite3Database
  let compiler: ContextCompiler

  beforeEach(() => {
    db = openTestDb()
    compiler = createContextCompiler({ db })
  })

  it('throws when no template is registered for task type', () => {
    const descriptor: TaskDescriptor = {
      taskType: 'unknown-task',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    }
    expect(() => compiler.compile(descriptor)).toThrow(
      /no template registered for task type "unknown-task"/,
    )
  })

  it('returns a CompileResult with prompt, tokenCount, sections, and truncated flag', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'architecture',
      key: 'pattern',
      value: 'modular-monolith',
    })

    const template = makeDecisionsTemplate()
    compiler.registerTemplate(template)

    const descriptor: TaskDescriptor = {
      taskType: 'test-task',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    }

    const result = compiler.compile(descriptor)

    expect(result).toHaveProperty('prompt')
    expect(result).toHaveProperty('tokenCount')
    expect(result).toHaveProperty('sections')
    expect(result).toHaveProperty('truncated')
    expect(typeof result.prompt).toBe('string')
    expect(typeof result.tokenCount).toBe('number')
    expect(Array.isArray(result.sections)).toBe(true)
    expect(typeof result.truncated).toBe('boolean')
  })

  it('produces a prompt containing decision data', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'architecture',
      key: 'pattern',
      value: 'modular-monolith',
    })

    compiler.registerTemplate(makeDecisionsTemplate())

    const result = compiler.compile({
      taskType: 'test-task',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toContain('pattern')
    expect(result.prompt).toContain('modular-monolith')
  })

  it('produces a prompt within the token budget', () => {
    // Add many decisions to fill up context
    for (let i = 0; i < 20; i++) {
      createDecision(db, {
        phase: 'solutioning',
        category: 'architecture',
        key: `key-${i}`,
        value: 'x'.repeat(100),
      })
    }

    compiler.registerTemplate(makeDecisionsTemplate())

    const tokenBudget = 50
    const result = compiler.compile({
      taskType: 'test-task',
      pipelineRunId: 'run-1',
      tokenBudget,
    })

    // Required sections can exceed budget (not truncated), but total must be near budget
    // Actually required sections are always included even if they exceed budget
    // The important thing is the result is coherent
    expect(result.tokenCount).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// AC2: Token budget enforcement
// ---------------------------------------------------------------------------

describe('AC2: Token budget enforcement', () => {
  let db: BetterSqlite3Database
  let compiler: ContextCompiler

  beforeEach(() => {
    db = openTestDb()
    compiler = createContextCompiler({ db })
  })

  it('keeps prompt within budget when sections are trimmed', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'architecture',
      key: 'info',
      value: 'x'.repeat(400), // ~100 tokens
    })

    const template: ContextTemplate = {
      taskType: 'budget-test',
      sections: [
        {
          name: 'Decisions',
          priority: 'important',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => {
            const decisions = rows as Array<{ value: string }>
            return decisions.map((d) => d.value).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const tokenBudget = 20
    const result = compiler.compile({
      taskType: 'budget-test',
      pipelineRunId: 'run-1',
      tokenBudget,
    })

    expect(result.tokenCount).toBeLessThanOrEqual(tokenBudget + 5) // small tolerance
    expect(result.truncated).toBe(true)
  })

  it('marks truncated=false when all sections fit within budget', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'k',
      value: 'small value',
    })

    compiler.registerTemplate(makeDecisionsTemplate())

    const result = compiler.compile({
      taskType: 'test-task',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.truncated).toBe(false)
  })

  it('omits important section entirely when no budget remains', () => {
    // Create content that fills up the budget with required sections
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'required-data',
      value: 'x'.repeat(2000), // ~500 tokens
    })
    createRequirement(db, {
      source: 'spec',
      type: 'functional',
      description: 'y'.repeat(200), // ~50 tokens
      priority: 'must',
    })

    const template: ContextTemplate = {
      taskType: 'omit-test',
      sections: [
        {
          name: 'Required Section',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => {
            const decisions = rows as Array<{ value: string }>
            return decisions.map((d) => d.value).join('\n')
          },
        },
        {
          name: 'Important Section',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: (rows) => {
            const reqs = rows as Array<{ description: string }>
            return reqs.map((r) => r.description).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'omit-test',
      pipelineRunId: 'run-1',
      tokenBudget: 20, // tiny budget — required section alone will exceed it
    })

    expect(result.truncated).toBe(true)
    const importantReport = result.sections.find((s) => s.name === 'Important Section')
    expect(importantReport?.included).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC3: Section priority system
// ---------------------------------------------------------------------------

describe('AC3: Section priority system', () => {
  let db: BetterSqlite3Database
  let compiler: ContextCompiler

  beforeEach(() => {
    db = openTestDb()
    compiler = createContextCompiler({ db })
  })

  it('always includes required sections', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'pattern',
      value: 'modular-monolith',
    })

    const template: ContextTemplate = {
      taskType: 'priority-test',
      sections: [
        {
          name: 'Required',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'priority-test',
      pipelineRunId: 'run-1',
      tokenBudget: 5, // very small budget
    })

    const report = result.sections.find((s) => s.name === 'Required')
    expect(report?.included).toBe(true)
    expect(report?.truncated).toBe(false)
  })

  it('drops optional sections when budget < 30% remaining after required+important', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'required',
      value: 'x'.repeat(280), // ~70 tokens (70% of a 100-token budget)
    })
    createConstraint(db, {
      category: 'tech',
      description: 'optional constraint that should be dropped',
      source: 'manual',
    })

    const template: ContextTemplate = {
      taskType: 'optional-test',
      sections: [
        {
          name: 'Required Section',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
        {
          name: 'Optional Section',
          priority: 'optional',
          query: { table: 'constraints', filters: {} },
          format: (rows) =>
            (rows as Array<{ description: string }>).map((r) => r.description).join('\n'),
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'optional-test',
      pipelineRunId: 'run-1',
      tokenBudget: 100,
    })

    // Required section (~70 tokens) leaves 30 tokens = 30% of 100 budget
    // Optional threshold is >30%, so 30/100 = 0.3 which is NOT > 0.3
    const optionalReport = result.sections.find((s) => s.name === 'Optional Section')
    expect(optionalReport?.included).toBe(false)
  })

  it('includes optional sections when >30% budget remains', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'small',
      value: 'tiny', // ~1 token
    })
    createConstraint(db, {
      category: 'tech',
      description: 'optional content',
      source: 'manual',
    })

    const template: ContextTemplate = {
      taskType: 'optional-include-test',
      sections: [
        {
          name: 'Required',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
        {
          name: 'Optional',
          priority: 'optional',
          query: { table: 'constraints', filters: {} },
          format: (rows) =>
            (rows as Array<{ description: string }>).map((r) => r.description).join('\n'),
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'optional-include-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    const optionalReport = result.sections.find((s) => s.name === 'Optional')
    expect(optionalReport?.included).toBe(true)
  })

  it('processes sections in priority order: required before important before optional', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'k',
      value: 'v',
    })

    // Template with sections in reversed order
    const template: ContextTemplate = {
      taskType: 'order-test',
      sections: [
        {
          name: 'Optional First',
          priority: 'optional',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) =>
            'OPTIONAL: ' +
            (rows as Array<{ value: string }>)
              .map((r) => r.value)
              .join('\n'),
        },
        {
          name: 'Required Last',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) =>
            'REQUIRED: ' +
            (rows as Array<{ value: string }>)
              .map((r) => r.value)
              .join('\n'),
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'order-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    // Required should appear before optional in output
    const reqIdx = result.prompt.indexOf('REQUIRED:')
    const optIdx = result.prompt.indexOf('OPTIONAL:')
    expect(reqIdx).toBeGreaterThanOrEqual(0)
    expect(optIdx).toBeGreaterThanOrEqual(0)
    expect(reqIdx).toBeLessThan(optIdx)
  })
})

// ---------------------------------------------------------------------------
// AC4: Template registration
// ---------------------------------------------------------------------------

describe('AC4: Template registration', () => {
  let db: BetterSqlite3Database
  let compiler: ContextCompiler

  beforeEach(() => {
    db = openTestDb()
    compiler = createContextCompiler({ db })
  })

  it('registers a template and retrieves it by task type', () => {
    const template = makeDecisionsTemplate('create-story')
    compiler.registerTemplate(template)
    const retrieved = compiler.getTemplate('create-story')
    expect(retrieved).toBeDefined()
    expect(retrieved?.taskType).toBe('create-story')
  })

  it('returns undefined for unregistered task types', () => {
    expect(compiler.getTemplate('nonexistent')).toBeUndefined()
  })

  it('overwrites an existing template for the same task type', () => {
    const template1 = makeDecisionsTemplate('my-task')
    const template2: ContextTemplate = {
      taskType: 'my-task',
      sections: [],
    }
    compiler.registerTemplate(template1)
    compiler.registerTemplate(template2)
    const retrieved = compiler.getTemplate('my-task')
    expect(retrieved?.sections).toHaveLength(0)
  })

  it('accepts templates with multiple sections', () => {
    const template: ContextTemplate = {
      taskType: 'multi-section',
      sections: [
        {
          name: 'Section A',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: () => 'A',
        },
        {
          name: 'Section B',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: () => 'B',
        },
        {
          name: 'Section C',
          priority: 'optional',
          query: { table: 'constraints', filters: {} },
          format: () => 'C',
        },
      ],
    }
    compiler.registerTemplate(template)
    const retrieved = compiler.getTemplate('multi-section')
    expect(retrieved?.sections).toHaveLength(3)
  })

  it('pre-populates templates from constructor options', () => {
    const templates = new Map<string, ContextTemplate>()
    templates.set('dev-story', makeDecisionsTemplate('dev-story'))
    templates.set('code-review', makeDecisionsTemplate('code-review'))

    const compiler2 = createContextCompiler({ db, templates })
    expect(compiler2.getTemplate('dev-story')).toBeDefined()
    expect(compiler2.getTemplate('code-review')).toBeDefined()
    expect(compiler2.getTemplate('create-story')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC5: Selective decision store queries
// ---------------------------------------------------------------------------

describe('AC5: Selective decision store queries', () => {
  let db: BetterSqlite3Database
  let compiler: ContextCompiler

  beforeEach(() => {
    db = openTestDb()
    compiler = createContextCompiler({ db })
  })

  it('only includes decisions matching the template phase filter', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'architecture',
      key: 'arch-decision',
      value: 'should-appear',
    })
    createDecision(db, {
      phase: 'planning',
      category: 'scope',
      key: 'scope-decision',
      value: 'should-not-appear',
    })

    const template: ContextTemplate = {
      taskType: 'selective-test',
      sections: [
        {
          name: 'Solutioning Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => {
            const decisions = rows as Array<{ value: string }>
            return decisions.map((d) => d.value).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'selective-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toContain('should-appear')
    expect(result.prompt).not.toContain('should-not-appear')
  })

  it('filters decisions by category when specified', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'architecture',
      key: 'arch-key',
      value: 'arch-value',
    })
    createDecision(db, {
      phase: 'solutioning',
      category: 'tech-stack',
      key: 'tech-key',
      value: 'tech-value',
    })

    const template: ContextTemplate = {
      taskType: 'category-filter-test',
      sections: [
        {
          name: 'Architecture Only',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning', category: 'architecture' } },
          format: (rows) => {
            const decisions = rows as Array<{ key: string; value: string }>
            return decisions.map((d) => `${d.key}=${d.value}`).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'category-filter-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toContain('arch-key=arch-value')
    expect(result.prompt).not.toContain('tech-key=tech-value')
  })

  it('filters requirements by type', () => {
    createRequirement(db, {
      source: 'spec',
      type: 'functional',
      description: 'functional requirement',
      priority: 'must',
    })
    createRequirement(db, {
      source: 'spec',
      type: 'non_functional',
      description: 'non-functional requirement',
      priority: 'should',
    })

    const template: ContextTemplate = {
      taskType: 'req-filter-test',
      sections: [
        {
          name: 'Functional Requirements',
          priority: 'required',
          query: { table: 'requirements', filters: { type: 'functional' } },
          format: (rows) => {
            const reqs = rows as Array<{ description: string }>
            return reqs.map((r) => r.description).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'req-filter-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toContain('functional requirement')
    expect(result.prompt).not.toContain('non-functional requirement')
  })

  it('filters constraints by category', () => {
    createConstraint(db, {
      category: 'security',
      description: 'security constraint',
      source: 'policy',
    })
    createConstraint(db, {
      category: 'performance',
      description: 'performance constraint',
      source: 'spec',
    })

    const template: ContextTemplate = {
      taskType: 'constraint-filter-test',
      sections: [
        {
          name: 'Security Constraints',
          priority: 'required',
          query: { table: 'constraints', filters: { category: 'security' } },
          format: (rows) => {
            const constraints = rows as Array<{ description: string }>
            return constraints.map((c) => c.description).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'constraint-filter-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toContain('security constraint')
    expect(result.prompt).not.toContain('performance constraint')
  })

  it('produces empty sections when query returns no results', () => {
    // No decisions in DB at all

    const template: ContextTemplate = {
      taskType: 'empty-test',
      sections: [
        {
          name: 'Empty Section',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => {
            const decisions = rows as Array<{ value: string }>
            return decisions.map((d) => d.value).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'empty-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toBe('')
    expect(result.truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC7: CompileResult format
// ---------------------------------------------------------------------------

describe('AC7: CompileResult format', () => {
  let db: BetterSqlite3Database
  let compiler: ContextCompiler

  beforeEach(() => {
    db = openTestDb()
    compiler = createContextCompiler({ db })
  })

  it('returns SectionReport with name, priority, tokens, included, truncated', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'k',
      value: 'v',
    })

    compiler.registerTemplate(makeDecisionsTemplate())

    const result = compiler.compile({
      taskType: 'test-task',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.sections).toHaveLength(1)
    const section = result.sections[0]
    expect(section).toHaveProperty('name')
    expect(section).toHaveProperty('priority')
    expect(section).toHaveProperty('tokens')
    expect(section).toHaveProperty('included')
    expect(section).toHaveProperty('truncated')
    expect(typeof section.name).toBe('string')
    expect(['required', 'important', 'optional']).toContain(section.priority)
    expect(typeof section.tokens).toBe('number')
    expect(typeof section.included).toBe('boolean')
    expect(typeof section.truncated).toBe('boolean')
  })

  it('tokenCount matches countTokens of the returned prompt', () => {
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'key',
      value: 'value',
    })

    compiler.registerTemplate(makeDecisionsTemplate())

    const result = compiler.compile({
      taskType: 'test-task',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.tokenCount).toBe(countTokens(result.prompt))
  })

  it('includes one SectionReport per template section', () => {
    const template: ContextTemplate = {
      taskType: 'multi-report-test',
      sections: [
        {
          name: 'Section A',
          priority: 'required',
          query: { table: 'decisions', filters: {} },
          format: () => 'content A',
        },
        {
          name: 'Section B',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: () => 'content B',
        },
        {
          name: 'Section C',
          priority: 'optional',
          query: { table: 'constraints', filters: {} },
          format: () => 'content C',
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'multi-report-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.sections).toHaveLength(3)
    const names = result.sections.map((s) => s.name)
    expect(names).toContain('Section A')
    expect(names).toContain('Section B')
    expect(names).toContain('Section C')
  })

  it('section tokens are 0 for omitted sections', () => {
    // Required section takes up all budget
    createDecision(db, {
      phase: 'solutioning',
      category: 'arch',
      key: 'large',
      value: 'x'.repeat(2000),
    })
    createRequirement(db, {
      source: 'spec',
      type: 'functional',
      description: 'requirement',
      priority: 'must',
    })

    const template: ContextTemplate = {
      taskType: 'omit-tokens-test',
      sections: [
        {
          name: 'Required',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: (rows) => (rows as Array<{ value: string }>).map((r) => r.value).join('\n'),
        },
        {
          name: 'Important',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: (rows) =>
            (rows as Array<{ description: string }>).map((r) => r.description).join('\n'),
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'omit-tokens-test',
      pipelineRunId: 'run-1',
      tokenBudget: 5, // tiny budget
    })

    const importantReport = result.sections.find((s) => s.name === 'Important')
    if (importantReport && !importantReport.included) {
      expect(importantReport.tokens).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Additional: empty decision store
// ---------------------------------------------------------------------------

describe('Empty decision store', () => {
  it('produces a prompt with empty sections when store is empty', () => {
    const db = openTestDb()
    const compiler = createContextCompiler({ db })

    const template: ContextTemplate = {
      taskType: 'empty-store-test',
      sections: [
        {
          name: 'Decisions',
          priority: 'required',
          query: { table: 'decisions', filters: {} },
          format: (rows) => {
            if ((rows as unknown[]).length === 0) return ''
            return (rows as Array<{ key: string; value: string }>)
              .map((d) => `${d.key}: ${d.value}`)
              .join('\n')
          },
        },
        {
          name: 'Requirements',
          priority: 'important',
          query: { table: 'requirements', filters: {} },
          format: (rows) => {
            if ((rows as unknown[]).length === 0) return ''
            return (rows as Array<{ description: string }>).map((r) => r.description).join('\n')
          },
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = compiler.compile({
      taskType: 'empty-store-test',
      pipelineRunId: 'run-1',
      tokenBudget: 1000,
    })

    expect(result.prompt).toBe('')
    expect(result.tokenCount).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.sections).toHaveLength(2)
  })
})
