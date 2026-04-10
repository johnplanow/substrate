/**
 * Unit tests for Story 44-3: Scenario Isolation — ContextCompiler exclusion filter
 *
 * AC3: ContextCompilerImpl accepts an `excludedPaths` configuration option
 * AC4: ContextCompiler filters excluded path content from compiled output
 * AC6: Security test — SCENARIO_SECRET_TOKEN does not appear in compiled context
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ---------------------------------------------------------------------------
// Mock logger — use vi.hoisted() to avoid initialization order issues
// ---------------------------------------------------------------------------

const { mockWarn, mockInfo, mockDebug, mockError } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockDebug: vi.fn(),
  mockError: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    warn: mockWarn,
    info: mockInfo,
    debug: mockDebug,
    error: mockError,
  }),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { createContextCompiler } from '../context-compiler-impl.js'
import type { ContextTemplate, TaskDescriptor } from '../types.js'

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

async function openTestDb(): Promise<DatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    taskType: 'isolation-test',
    storyId: 'test-story',
    tokenBudget: 10000,
    ...overrides,
  }
}

function makeTemplate(
  taskType: string,
  sectionText: string,
  priority: 'required' | 'important' | 'optional' = 'required'
): ContextTemplate {
  return {
    taskType,
    sections: [
      {
        name: 'TestSection',
        priority,
        query: { table: 'decisions', filters: { phase: 'solutioning' } },
        format: () => sectionText,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextCompiler excludedPaths (AC3)', () => {
  let db: DatabaseAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    db = await openTestDb()
  })

  it('AC3: getExcludedPaths() returns the configured excludedPaths array', () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    const paths = compiler.getExcludedPaths()
    expect(paths).toContain('.substrate/scenarios/')
    expect(paths).toHaveLength(1)
  })

  it('AC3 default: getExcludedPaths() returns empty array when no excludedPaths provided', () => {
    const compiler = createContextCompiler({ db })

    expect(compiler.getExcludedPaths()).toEqual([])
  })

  it('AC3: accepts multiple excludedPaths values', () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/', '.substrate/secrets/'],
    })

    const paths = compiler.getExcludedPaths()
    expect(paths).toContain('.substrate/scenarios/')
    expect(paths).toContain('.substrate/secrets/')
    expect(paths).toHaveLength(2)
  })
})

describe('ContextCompiler exclusion filter (AC4)', () => {
  let db: DatabaseAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    db = await openTestDb()
  })

  it('AC4: compile() excludes section containing excluded path from prompt', async () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    compiler.registerTemplate(
      makeTemplate('isolation-test', 'See .substrate/scenarios/scenario-x.sh for details')
    )

    const result = await compiler.compile(makeDescriptor())

    expect(result.prompt).not.toContain('.substrate/scenarios/')
  })

  it('AC4: compile() emits a logger.warn when a section is excluded', async () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    compiler.registerTemplate(
      makeTemplate('isolation-test', 'Scenario reference: .substrate/scenarios/scenario-login.sh')
    )

    await compiler.compile(makeDescriptor())

    expect(mockWarn as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionName: 'TestSection',
        excludedPath: '.substrate/scenarios/',
      }),
      expect.stringContaining('exclusion list')
    )
  })

  it('AC4: section report marks excluded section as included:false and truncated:true', async () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    compiler.registerTemplate(
      makeTemplate('isolation-test', '.substrate/scenarios/scenario-secret.sh is referenced here')
    )

    const result = await compiler.compile(makeDescriptor())
    const section = result.sections.find((s) => s.name === 'TestSection')

    expect(section).toBeDefined()
    expect(section!.included).toBe(false)
    expect(section!.truncated).toBe(true)
    expect(section!.tokens).toBe(0)
  })

  it('AC4: sections WITHOUT excluded paths are not affected', async () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    const safeContent = 'This section contains only src/modules/foo/bar.ts references'
    compiler.registerTemplate(makeTemplate('isolation-test', safeContent))

    const result = await compiler.compile(makeDescriptor())

    expect(result.prompt).toContain(safeContent)
  })
})

describe('ContextCompiler security test (AC6)', () => {
  let db: DatabaseAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    db = await openTestDb()
  })

  it('AC6: SCENARIO_SECRET_TOKEN does not appear in compiled context when section contains .substrate/scenarios/', async () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    // Simulate a section where scenario content leaked into the DB (containing the secret)
    const leakedContent =
      'SCENARIO_SECRET_TOKEN=abc123 — leaked from .substrate/scenarios/scenario-auth.sh'
    compiler.registerTemplate(makeTemplate('isolation-test', leakedContent))

    const result = await compiler.compile(makeDescriptor())

    expect(result.prompt).not.toContain('SCENARIO_SECRET_TOKEN')
    expect(result.prompt).not.toContain('.substrate/scenarios/')
  })

  it('AC6: SCENARIO_SECRET_TOKEN is blocked even with multiple sections when the leaking section is excluded', async () => {
    const compiler = createContextCompiler({
      db,
      excludedPaths: ['.substrate/scenarios/'],
    })

    // Template with two sections: one clean, one containing the secret+path
    const template: ContextTemplate = {
      taskType: 'isolation-test',
      sections: [
        {
          name: 'SafeSection',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'solutioning' } },
          format: () => 'Safe content: src/modules/auth/auth.ts',
        },
        {
          name: 'LeakSection',
          priority: 'required',
          query: { table: 'decisions', filters: { phase: 'planning' } },
          format: () => 'SCENARIO_SECRET_TOKEN=xyz789 from .substrate/scenarios/scenario-login.sh',
        },
      ],
    }
    compiler.registerTemplate(template)

    const result = await compiler.compile(makeDescriptor())

    // Safe section should remain
    expect(result.prompt).toContain('src/modules/auth/auth.ts')
    // Secret token must not appear
    expect(result.prompt).not.toContain('SCENARIO_SECRET_TOKEN')
  })
})
