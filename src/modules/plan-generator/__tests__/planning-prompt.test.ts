/**
 * Unit tests for planning-prompt.ts
 *
 * Covers AC3, AC4, AC5 and backward compatibility.
 */

import { describe, it, expect } from 'vitest'
import { buildPlanningPrompt } from '../planning-prompt.js'
import type { AgentSummary } from '../planning-prompt.js'
import type { CodebaseContext } from '../codebase-scanner.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCodebaseContext(overrides: Partial<CodebaseContext> = {}): CodebaseContext {
  return {
    rootPath: '/test/project',
    detectedLanguages: ['TypeScript', 'JavaScript'],
    techStack: [
      { name: 'Node.js', source: 'package.json' },
      { name: 'TypeScript', version: '^5.0.0', source: 'package.json' },
    ],
    topLevelDirs: ['src', 'test', 'docs'],
    keyFiles: [
      { relativePath: 'package.json', contentSummary: '{}', skipped: false },
    ],
    dependencies: {
      runtime: { commander: '^12.0.0', zod: '^3.0.0' },
      development: { vitest: '^1.0.0' },
    },
    ...overrides,
  }
}

function makeAgents(): AgentSummary[] {
  return [
    {
      agentId: 'claude',
      supportedTaskTypes: ['coding', 'testing', 'debugging'],
      billingMode: 'subscription',
      healthy: true,
    },
    {
      agentId: 'codex',
      supportedTaskTypes: ['coding', 'refactoring'],
      billingMode: 'api',
      healthy: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// Basic prompt structure
// ---------------------------------------------------------------------------

describe('buildPlanningPrompt - basic', () => {
  it('includes goal in the prompt', () => {
    const prompt = buildPlanningPrompt({ goal: 'Add JWT authentication' })
    expect(prompt).toContain('Add JWT authentication')
  })

  it('returns string', () => {
    const prompt = buildPlanningPrompt({ goal: 'my goal' })
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// AC5: Codebase context section
// ---------------------------------------------------------------------------

describe('AC5: codebaseContext in prompt', () => {
  it('includes ## Codebase Context section when codebaseContext provided', () => {
    const ctx = makeCodebaseContext()
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('## Codebase Context')
  })

  it('includes rootPath in codebase context section', () => {
    const ctx = makeCodebaseContext({ rootPath: '/my/special/project' })
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('/my/special/project')
  })

  it('includes detected languages', () => {
    const ctx = makeCodebaseContext({ detectedLanguages: ['TypeScript', 'JavaScript'] })
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('TypeScript')
    expect(prompt).toContain('JavaScript')
  })

  it('includes tech stack items', () => {
    const ctx = makeCodebaseContext()
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('Node.js')
    expect(prompt).toContain('TypeScript')
  })

  it('includes version in tech stack when provided', () => {
    const ctx = makeCodebaseContext({
      techStack: [{ name: 'TypeScript', version: '^5.9.0', source: 'package.json' }],
    })
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('^5.9.0')
  })

  it('includes top-level directories', () => {
    const ctx = makeCodebaseContext({ topLevelDirs: ['src', 'test', 'docs'] })
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('src/')
    expect(prompt).toContain('test/')
  })

  it('includes runtime dependencies', () => {
    const ctx = makeCodebaseContext({
      dependencies: {
        runtime: { commander: '^12.0.0', zod: '^3.0.0' },
        development: {},
      },
    })
    const prompt = buildPlanningPrompt({ goal: 'Add auth', codebaseContext: ctx })

    expect(prompt).toContain('commander@^12.0.0')
    expect(prompt).toContain('zod@^3.0.0')
  })

  it('does NOT include ## Codebase Context when codebaseContext is not provided', () => {
    const prompt = buildPlanningPrompt({ goal: 'Add auth' })

    expect(prompt).not.toContain('## Codebase Context')
  })
})

// ---------------------------------------------------------------------------
// AC5: Available agents section
// ---------------------------------------------------------------------------

describe('AC5: availableAgents in prompt', () => {
  it('includes ## Available Agents section when agents provided', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      availableAgents: makeAgents(),
    })

    expect(prompt).toContain('## Available Agents')
  })

  it('lists each agent with task types, billing mode, and status', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      availableAgents: makeAgents(),
    })

    expect(prompt).toContain('claude')
    expect(prompt).toContain('codex')
    expect(prompt).toContain('coding')
    expect(prompt).toContain('subscription')
    expect(prompt).toContain('api')
    expect(prompt).toContain('healthy')
  })

  it('does NOT include ## Available Agents when agents is empty array', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      availableAgents: [],
    })

    expect(prompt).not.toContain('## Available Agents')
  })

  it('does NOT include ## Available Agents when not provided', () => {
    const prompt = buildPlanningPrompt({ goal: 'Add auth' })

    expect(prompt).not.toContain('## Available Agents')
  })
})

// ---------------------------------------------------------------------------
// AC3: Multi-agent instructions section
// ---------------------------------------------------------------------------

describe('AC3: agentCount in prompt', () => {
  it('includes ## Multi-Agent Instructions when agentCount and availableAgents provided', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      availableAgents: makeAgents(),
      agentCount: 2,
    })

    expect(prompt).toContain('## Multi-Agent Instructions')
    expect(prompt).toContain('2')
  })

  it('mentions agent count in multi-agent instructions', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      availableAgents: makeAgents(),
      agentCount: 3,
    })

    expect(prompt).toContain('3')
    expect(prompt).toContain('parallel agents')
  })

  it('does NOT include ## Multi-Agent Instructions when agentCount provided but no availableAgents', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      agentCount: 2,
    })

    expect(prompt).not.toContain('## Multi-Agent Instructions')
  })

  it('does NOT include ## Multi-Agent Instructions when availableAgents is empty', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add auth',
      availableAgents: [],
      agentCount: 2,
    })

    expect(prompt).not.toContain('## Multi-Agent Instructions')
  })

  it('does NOT include ## Multi-Agent Instructions when neither agentCount nor agents provided', () => {
    const prompt = buildPlanningPrompt({ goal: 'Add auth' })

    expect(prompt).not.toContain('## Multi-Agent Instructions')
  })
})

// ---------------------------------------------------------------------------
// Full integration: all options together
// ---------------------------------------------------------------------------

describe('full prompt with all options', () => {
  it('includes all three sections when all options provided', () => {
    const prompt = buildPlanningPrompt({
      goal: 'Add authentication',
      codebaseContext: makeCodebaseContext(),
      availableAgents: makeAgents(),
      agentCount: 2,
    })

    expect(prompt).toContain('## Codebase Context')
    expect(prompt).toContain('## Available Agents')
    expect(prompt).toContain('## Multi-Agent Instructions')
    expect(prompt).toContain('Add authentication')
  })
})
