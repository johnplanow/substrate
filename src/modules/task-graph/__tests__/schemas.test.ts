/**
 * Unit tests for task graph Zod schemas.
 */

import { describe, it, expect } from 'vitest'
import {
  TaskGraphFileSchema,
  TaskDefinitionSchema,
  SessionMetaSchema,
  SUPPORTED_GRAPH_VERSIONS,
} from '../schemas.js'

describe('SUPPORTED_GRAPH_VERSIONS', () => {
  it('includes version "1"', () => {
    expect(SUPPORTED_GRAPH_VERSIONS).toContain('1')
  })

  it('includes version "1.0"', () => {
    expect(SUPPORTED_GRAPH_VERSIONS).toContain('1.0')
  })
})

describe('SessionMetaSchema', () => {
  it('parses valid session metadata', () => {
    const result = SessionMetaSchema.safeParse({ name: 'my-project', budget_usd: 10.0 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('my-project')
      expect(result.data.budget_usd).toBe(10.0)
    }
  })

  it('allows missing budget_usd', () => {
    const result = SessionMetaSchema.safeParse({ name: 'my-project' })
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = SessionMetaSchema.safeParse({ name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing name', () => {
    const result = SessionMetaSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('TaskDefinitionSchema', () => {
  const validTask = {
    name: 'My Task',
    description: 'Does something',
    prompt: 'Do the thing',
    type: 'coding',
    depends_on: [],
  }

  it('parses a valid task definition', () => {
    const result = TaskDefinitionSchema.safeParse(validTask)
    expect(result.success).toBe(true)
  })

  it('defaults depends_on to empty array when omitted', () => {
    const { depends_on: _, ...withoutDeps } = validTask
    const result = TaskDefinitionSchema.safeParse(withoutDeps)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.depends_on).toEqual([])
    }
  })

  it('accepts all valid task types', () => {
    const types = ['coding', 'testing', 'docs', 'debugging', 'refactoring'] as const
    for (const type of types) {
      const result = TaskDefinitionSchema.safeParse({ ...validTask, type })
      expect(result.success, `Expected type "${type}" to be valid`).toBe(true)
    }
  })

  it('rejects invalid task type', () => {
    const result = TaskDefinitionSchema.safeParse({ ...validTask, type: 'invalid-type' })
    expect(result.success).toBe(false)
  })

  it('allows optional agent and model fields', () => {
    const result = TaskDefinitionSchema.safeParse({
      ...validTask,
      agent: 'claude',
      model: 'sonnet',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agent).toBe('claude')
      expect(result.data.model).toBe('sonnet')
    }
  })

  it('allows optional budget_usd', () => {
    const result = TaskDefinitionSchema.safeParse({ ...validTask, budget_usd: 2.0 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.budget_usd).toBe(2.0)
    }
  })

  it('rejects empty prompt', () => {
    const result = TaskDefinitionSchema.safeParse({ ...validTask, prompt: '' })
    expect(result.success).toBe(false)
  })
})

describe('TaskGraphFileSchema', () => {
  const validGraph = {
    version: '1',
    session: { name: 'test', budget_usd: 5.0 },
    tasks: {
      't1': {
        name: 'Task 1',
        prompt: 'Do task 1',
        type: 'coding',
        depends_on: [],
      },
    },
  }

  it('parses a valid task graph', () => {
    const result = TaskGraphFileSchema.safeParse(validGraph)
    expect(result.success).toBe(true)
  })

  it('accepts version "1.0"', () => {
    const result = TaskGraphFileSchema.safeParse({ ...validGraph, version: '1.0' })
    expect(result.success).toBe(true)
  })

  it('rejects unsupported version', () => {
    const result = TaskGraphFileSchema.safeParse({ ...validGraph, version: '2' })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes("'2'"))).toBe(true)
    }
  })

  it('rejects missing version', () => {
    const { version: _, ...withoutVersion } = validGraph
    const result = TaskGraphFileSchema.safeParse(withoutVersion)
    expect(result.success).toBe(false)
  })

  it('rejects missing session', () => {
    const { session: _, ...withoutSession } = validGraph
    const result = TaskGraphFileSchema.safeParse(withoutSession)
    expect(result.success).toBe(false)
  })

  it('accepts graph with no tasks (empty tasks object)', () => {
    const result = TaskGraphFileSchema.safeParse({ ...validGraph, tasks: {} })
    expect(result.success).toBe(true)
  })

  it('infers TypeScript types correctly', () => {
    const result = TaskGraphFileSchema.safeParse(validGraph)
    if (result.success) {
      // Type assertion — if TypeScript compiles, the types are correct
      const graph = result.data
      const _version: string = graph.version
      const _sessionName: string = graph.session.name
      const _tasks: Record<string, unknown> = graph.tasks
      expect(_version).toBeDefined()
      expect(_sessionName).toBeDefined()
      expect(_tasks).toBeDefined()
    }
  })
})
