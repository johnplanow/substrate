/**
 * Integration tests for the full readiness check flow in runSolutioningPhase().
 *
 * T13: Integration test for full readiness check with mock stories.
 *
 * These tests verify the complete solutioning pipeline — architecture generation,
 * story generation, and adversarial readiness check — using realistic mock data.
 * They are "integration" tests in that they exercise the full function call chain
 * (prompt assembly, context injection, dispatch, verdict handling) with mocked
 * external dependencies (dispatcher, pack, db).
 *
 * Key scenarios:
 *  - Readiness prompt contains all assembled context (FRs, NFRs, arch, stories)
 *  - Readiness dispatch uses taskType='readiness-check' and agent='claude-code'
 *  - Readiness prompt includes UX decisions when available
 *  - Readiness prompt omits UX block when no UX decisions present
 *  - Coverage score and findings are correctly propagated to phase result
 *  - Findings are stored in decision store with correct structure
 *  - Full pipeline with multiple epics and stories completes successfully
 *  - NFR context assembled from planning phase decisions
 *  - Architecture decisions context assembled from solutioning phase decisions
 *  - Story context assembled from all stories across all epics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SyncDatabaseAdapter } from '../../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../../persistence/schema.js'
import {
  createPipelineRun,
  createDecision,
} from '../../../../persistence/queries/decisions.js'
import { runSolutioningPhase } from '../solutioning.js'
import type {
  PhaseDeps,
  ArchitectureDecision,
  EpicDefinition,
} from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../../core/event-bus.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'solutioning-readiness-integration-'))
  const db = new Database(join(tmpDir, 'test.db'))
  const adapter = new SyncDatabaseAdapter(db)
  await initSchema(adapter)
  return { db, adapter, tmpDir }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

/**
 * Seed realistic functional requirements across multiple priorities.
 */
async function seedFunctionalRequirements(adapter: DatabaseAdapter, runId: string): Promise<void> {
  const frs = [
    { key: 'FR-1', value: JSON.stringify({ description: 'User can register an account with email and password', priority: 'must' }) },
    { key: 'FR-2', value: JSON.stringify({ description: 'User can log in with email and password', priority: 'must' }) },
    { key: 'FR-3', value: JSON.stringify({ description: 'User can create project workspaces', priority: 'must' }) },
    { key: 'FR-4', value: JSON.stringify({ description: 'User can invite team members to workspaces', priority: 'must' }) },
    { key: 'FR-5', value: JSON.stringify({ description: 'User can create and assign tasks within a workspace', priority: 'must' }) },
    { key: 'FR-6', value: JSON.stringify({ description: 'User can set task due dates and priorities', priority: 'should' }) },
    { key: 'FR-7', value: JSON.stringify({ description: 'User receives email notifications for task assignments', priority: 'could' }) },
  ]
  for (const { key, value } of frs) {
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'functional-requirements',
      key,
      value,
    })
  }
}

/**
 * Seed non-functional requirements.
 */
async function seedNonFunctionalRequirements(adapter: DatabaseAdapter, runId: string): Promise<void> {
  const nfrs = [
    { key: 'NFR-1', value: JSON.stringify({ description: 'API response time under 200ms for 95th percentile', category: 'performance' }) },
    { key: 'NFR-2', value: JSON.stringify({ description: 'System supports 10,000 concurrent users', category: 'scalability' }) },
    { key: 'NFR-3', value: JSON.stringify({ description: 'All user data encrypted at rest using AES-256', category: 'security' }) },
  ]
  for (const { key, value } of nfrs) {
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'non-functional-requirements',
      key,
      value,
    })
  }
}

/**
 * Seed UX design decisions (simulating a ux-design phase having run).
 */
async function seedUxDecisions(adapter: DatabaseAdapter, runId: string): Promise<void> {
  const uxDecisions = [
    { key: 'ux-component-library', value: 'Tailwind UI components with shadcn/ui', category: 'component-library' },
    { key: 'ux-accessibility', value: 'WCAG 2.1 AA compliance required for all interactive elements', category: 'accessibility' },
    { key: 'ux-navigation', value: 'Sidebar navigation with collapsible menu for mobile', category: 'navigation' },
  ]
  for (const { key, value, category } of uxDecisions) {
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'ux-design',
      category,
      key,
      value,
    })
  }
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const COMPREHENSIVE_ARCHITECTURE_DECISIONS: ArchitectureDecision[] = [
  { category: 'language', key: 'language', value: 'TypeScript 5.x', rationale: 'Type safety and developer productivity' },
  { category: 'database', key: 'database', value: 'PostgreSQL 16 with Prisma ORM', rationale: 'Relational data with strong typing' },
  { category: 'api', key: 'api-style', value: 'REST over HTTPS with OpenAPI 3.0 spec', rationale: 'Wide tooling support' },
  { category: 'auth', key: 'auth', value: 'JWT with refresh token rotation', rationale: 'Stateless auth for horizontal scaling' },
  { category: 'notifications', key: 'notifications', value: 'Async email via AWS SES with SQS queue', rationale: 'Decoupled, reliable delivery' },
]

const COMPREHENSIVE_EPICS: EpicDefinition[] = [
  {
    title: 'Authentication & Authorization',
    description: 'User registration, login, and session management',
    stories: [
      {
        key: '1-1',
        title: 'User registration with email and password',
        description: 'Users register with email/password. Handles email validation and duplicate detection.',
        acceptance_criteria: [
          'Given a new user, When they submit valid email and password, Then account is created and verification email sent',
          'Given duplicate email, When registration attempted, Then error "Email already registered" is returned',
          'Given invalid email format, When form submitted, Then inline validation error shown',
        ],
        priority: 'must',
      },
      {
        key: '1-2',
        title: 'User login with JWT session',
        description: 'Users log in with credentials and receive JWT tokens for API access.',
        acceptance_criteria: [
          'Given valid credentials, When login submitted, Then access token and refresh token returned',
          'Given invalid credentials, When login attempted, Then generic error shown (no credential hints)',
          'Given expired access token, When API request made, Then refresh token used to issue new access token',
        ],
        priority: 'must',
      },
    ],
  },
  {
    title: 'Workspace Management',
    description: 'Project workspace creation and team collaboration',
    stories: [
      {
        key: '2-1',
        title: 'Create project workspace',
        description: 'Authenticated users can create named project workspaces.',
        acceptance_criteria: [
          'Given authenticated user, When workspace created with name, Then workspace persisted with unique ID',
          'Given workspace created, When creator views workspace list, Then new workspace appears',
        ],
        priority: 'must',
      },
      {
        key: '2-2',
        title: 'Invite team members to workspace',
        description: 'Workspace owners can invite other users by email.',
        acceptance_criteria: [
          'Given workspace owner, When they invite user by email, Then invitation email sent via SES/SQS',
          'Given invitee clicks link, When they accept invitation, Then they are added to workspace as member',
        ],
        priority: 'must',
      },
    ],
  },
  {
    title: 'Task Management',
    description: 'Task creation, assignment, and lifecycle management',
    stories: [
      {
        key: '3-1',
        title: 'Create and assign tasks within workspace',
        description: 'Workspace members can create tasks and assign them to other members.',
        acceptance_criteria: [
          'Given workspace member, When task created with title and assignee, Then task stored in database',
          'Given task created, When assignee views their task list, Then task appears in their queue',
        ],
        priority: 'must',
      },
      {
        key: '3-2',
        title: 'Set task due dates and priorities',
        description: 'Task creators can set due dates and priority levels on tasks.',
        acceptance_criteria: [
          'Given existing task, When due date set, Then date stored and displayed in task view',
          'Given task with due date, When priority set, Then priority badge shown in task list',
        ],
        priority: 'should',
      },
      {
        key: '3-3',
        title: 'Email notifications for task assignments',
        description: 'Assignees receive email notifications when tasks are assigned to them.',
        acceptance_criteria: [
          'Given task assigned to user, When assignment saved, Then email queued in SQS',
          'Given email queued, When SES processes it, Then assignee receives notification email',
        ],
        priority: 'could',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeArchDispatchResult(overrides: Partial<DispatchResult<unknown>> = {}): DispatchResult<unknown> {
  return {
    id: 'dispatch-arch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', architecture_decisions: COMPREHENSIVE_ARCHITECTURE_DECISIONS },
    parseError: null,
    durationMs: 1200,
    tokenEstimate: { input: 800, output: 250 },
    ...overrides,
  }
}

function makeStoryDispatchResult(
  epics = COMPREHENSIVE_EPICS,
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: 'dispatch-story-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', epics },
    parseError: null,
    durationMs: 3000,
    tokenEstimate: { input: 1200, output: 600 },
    ...overrides,
  }
}

function makeReadinessDispatchResult(
  verdict: 'READY' | 'NEEDS_WORK' | 'NOT_READY' = 'READY',
  findings: Array<{
    category: string
    severity: string
    description: string
    affected_items: string[]
  }> = [],
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  const coverageScore = verdict === 'READY' ? 100 : verdict === 'NEEDS_WORK' ? 72 : 25
  return {
    id: 'dispatch-readiness-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { verdict, coverage_score: coverageScore, findings },
    parseError: null,
    durationMs: 800,
    tokenEstimate: { input: 400, output: 150 },
    ...overrides,
  }
}

function makeSequentialDispatcher(results: DispatchResult<unknown>[]): Dispatcher {
  let callIndex = 0
  const dispatch = vi.fn().mockImplementation(() => {
    const result = results[callIndex] ?? results[results.length - 1]
    callIndex++
    const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
      id: result.id,
      status: 'completed',
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(result),
    }
    return handle
  })
  return {
    dispatch,
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Readiness prompt template with all context placeholders.
 * Matches the expected format used in the production template.
 */
const READINESS_PROMPT_TEMPLATE = `# Adversarial Readiness Review

You are a senior engineering lead conducting a go/no-go review.
Your success is measured by finding gaps others missed.

## Functional Requirements
{{functional_requirements}}

## Non-Functional Requirements
{{non_functional_requirements}}

## Architecture Decisions
{{architecture_decisions}}

## Stories
{{stories}}

{{ux_decisions}}

## Instructions
Review the stories against all requirements and architecture decisions.
Identify FR coverage gaps, architecture compliance issues, story quality problems.

Output YAML with: verdict (READY|NEEDS_WORK|NOT_READY), coverage_score (0-100), findings array.`

const STORY_PROMPT_TEMPLATE =
  'Generate stories:\n\n{{requirements}}\n\n{{architecture_decisions}}\n\n{{gap_analysis}}\n\nOutput YAML.'

const ARCH_PROMPT_TEMPLATE = 'Generate architecture:\n\n{{requirements}}\n\nOutput YAML.'

function makePack(
  archTemplate = ARCH_PROMPT_TEMPLATE,
  storyTemplate = STORY_PROMPT_TEMPLATE,
  readinessTemplate = READINESS_PROMPT_TEMPLATE,
): MethodologyPack {
  const getPrompt = vi.fn().mockImplementation((name: string) => {
    if (name === 'architecture') return Promise.resolve(archTemplate)
    if (name === 'story-generation') return Promise.resolve(storyTemplate)
    if (name === 'readiness-check') return Promise.resolve(readinessTemplate)
    return Promise.resolve('')
  })
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      phases: [],
      prompts: {
        architecture: 'prompts/architecture.md',
        'story-generation': 'prompts/story-generation.md',
        'readiness-check': 'prompts/readiness-check.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt,
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
  eventBus?: TypedEventBus,
): PhaseDeps {
  return {
    db: adapter,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
    eventBus,
  }
}

// ---------------------------------------------------------------------------
// Test suite: Readiness dispatch context assembly
// ---------------------------------------------------------------------------

describe('Readiness check integration: context assembly (AC1)', () => {
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

  it('readiness dispatch prompt contains functional requirements from planning phase', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // Prompt should contain FR descriptions from planning phase
    expect(readinessCall.prompt).toContain('register an account with email and password')
    expect(readinessCall.prompt).toContain('log in with email and password')
    expect(readinessCall.prompt).toContain('create project workspaces')
  })

  it('readiness dispatch prompt contains NFR context from planning phase', async () => {
    await seedFunctionalRequirements(adapter, runId)
    await seedNonFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // Prompt should contain NFR descriptions
    expect(readinessCall.prompt).toContain('API response time under 200ms')
    expect(readinessCall.prompt).toContain('concurrent users')
    expect(readinessCall.prompt).toContain('AES-256')
  })

  it('readiness dispatch prompt contains architecture decisions', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // Prompt should contain architecture decisions from dispatch result
    expect(readinessCall.prompt).toContain('TypeScript 5.x')
    expect(readinessCall.prompt).toContain('PostgreSQL 16 with Prisma ORM')
    expect(readinessCall.prompt).toContain('JWT with refresh token rotation')
  })

  it('readiness dispatch prompt contains story titles from all epics', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // Should contain stories from all 3 epics
    expect(readinessCall.prompt).toContain('User registration with email and password')
    expect(readinessCall.prompt).toContain('Create project workspace')
    expect(readinessCall.prompt).toContain('Create and assign tasks within workspace')
    expect(readinessCall.prompt).toContain('Email notifications for task assignments')
  })

  it('readiness dispatch prompt contains acceptance criteria from stories', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // Should contain at least some acceptance criteria text
    expect(readinessCall.prompt).toContain('verification email sent')
    expect(readinessCall.prompt).toContain('access token and refresh token returned')
  })

  it('readiness dispatch uses taskType=readiness-check', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    expect(readinessCall.taskType).toBe('readiness-check')
  })

  it('readiness dispatch uses agent=claude-code', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    expect(readinessCall.agent).toBe('claude-code')
  })

  it('readiness dispatch is the 3rd dispatch (after arch and story)', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // 3 dispatches total: arch(0), story(1), readiness(2)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })
})

// ---------------------------------------------------------------------------
// Test suite: UX decisions conditional inclusion
// ---------------------------------------------------------------------------

describe('Readiness check integration: UX alignment (AC9)', () => {
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

  it('includes UX decisions in readiness prompt when ux-design phase decisions exist', async () => {
    await seedFunctionalRequirements(adapter, runId)
    await seedUxDecisions(adapter, runId) // Seed UX decisions into the ux-design phase
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // UX decisions should appear in the prompt
    expect(readinessCall.prompt).toContain('Tailwind UI components with shadcn/ui')
    expect(readinessCall.prompt).toContain('WCAG 2.1 AA')
    expect(readinessCall.prompt).toContain('Sidebar navigation')
  })

  it('omits UX section from readiness prompt when no ux-design decisions exist', async () => {
    await seedFunctionalRequirements(adapter, runId)
    // Do NOT seed UX decisions — simulates ux-design phase skipped
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // UX placeholder should be removed (replaced with empty string)
    expect(readinessCall.prompt).not.toContain('{{ux_decisions}}')
    expect(readinessCall.prompt).not.toContain('UX Design Decisions')
  })

  it('pipeline succeeds regardless of UX decisions presence', async () => {
    await seedFunctionalRequirements(adapter, runId)

    // Test without UX decisions
    const dispatcher1 = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const result1 = await runSolutioningPhase(makeDeps(adapter, dispatcher1), { runId })
    expect(result1.result).toBe('success')

    // Cleanup and re-run with UX decisions
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    const setup = await createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    const newRunId = await createTestRun(adapter)
    await seedFunctionalRequirements(adapter, newRunId)
    await seedUxDecisions(adapter, newRunId)

    const dispatcher2 = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const result2 = await runSolutioningPhase(makeDeps(adapter, dispatcher2), { runId: newRunId })
    expect(result2.result).toBe('success')
  })
})

// ---------------------------------------------------------------------------
// Test suite: Full pipeline with comprehensive mock stories
// ---------------------------------------------------------------------------

describe('Readiness check integration: full pipeline with realistic mock data', () => {
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

  it('full pipeline with 3 epics and 7 stories returns success when READY', async () => {
    await seedFunctionalRequirements(adapter, runId)
    await seedNonFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(COMPREHENSIVE_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
    expect(result.epics).toBe(3)
    expect(result.stories).toBe(7)
  })

  it('correct architecture decision count in result', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.architecture_decisions).toBe(5) // 5 decisions in COMPREHENSIVE_ARCHITECTURE_DECISIONS
  })

  it('emits readiness-check event with correct data for READY verdict', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY', []),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-check',
      expect.objectContaining({
        verdict: 'READY',
        runId,
        coverageScore: 100,
        findingCount: 0,
        blockerCount: 0,
      }),
    )
  })

  it('READY verdict with mixed findings (major + minor) stores no findings in decision store', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const readinessFindings = [
      { category: 'story_quality', severity: 'major', description: 'Story 2-2 ACs not testable', affected_items: ['2-2'] },
      { category: 'ux_alignment', severity: 'minor', description: 'Story 1-1 missing accessibility reference', affected_items: ['1-1'] },
    ]
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY', readinessFindings),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // READY verdict should NOT store findings in decision store
    const storedFindings = db
      .prepare("SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings'")
      .all(runId) as Array<{ key: string }>

    expect(storedFindings).toHaveLength(0)
  })

  it('NOT_READY verdict stores all findings (blockers + major + minor) in decision store', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const readinessFindings = [
      { category: 'fr_coverage', severity: 'blocker', description: 'FR-7 notifications not covered', affected_items: ['FR-7'] },
      { category: 'architecture_compliance', severity: 'blocker', description: 'Story 1-2 uses session auth, not JWT', affected_items: ['1-2', 'auth'] },
      { category: 'story_quality', severity: 'major', description: 'Story 2-1 ACs not in GWT format', affected_items: ['2-1'] },
      { category: 'ux_alignment', severity: 'minor', description: 'Stories omit accessibility references', affected_items: ['1-1', '1-2'] },
    ]
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', readinessFindings),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const storedFindings = db
      .prepare(
        "SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings' ORDER BY key ASC",
      )
      .all(runId) as Array<{ key: string; value: string }>

    expect(storedFindings).toHaveLength(4)
    // Verify keys are sequential (finding-1, finding-2, ...)
    expect(storedFindings[0].key).toBe('finding-1')
    expect(storedFindings[1].key).toBe('finding-2')
    expect(storedFindings[2].key).toBe('finding-3')
    expect(storedFindings[3].key).toBe('finding-4')
  })

  it('NOT_READY stored findings contain correct category and severity', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const readinessFindings = [
      { category: 'fr_coverage', severity: 'blocker', description: 'FR-7 notifications not covered', affected_items: ['FR-7'] },
      { category: 'story_quality', severity: 'major', description: 'Story quality issue', affected_items: ['2-1'] },
    ]
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', readinessFindings),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const firstFinding = db
      .prepare(
        "SELECT value FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings' AND key = 'finding-1'",
      )
      .get(runId) as { value: string } | undefined

    expect(firstFinding).toBeDefined()
    const parsed = JSON.parse(firstFinding!.value) as {
      category: string
      severity: string
      description: string
      affected_items: string[]
    }
    expect(parsed.category).toBe('fr_coverage')
    expect(parsed.severity).toBe('blocker')
    expect(parsed.description).toBe('FR-7 notifications not covered')
    expect(parsed.affected_items).toEqual(['FR-7'])
  })

  it('total token usage accumulates from all 3 dispatches in READY path', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult({ tokenEstimate: { input: 800, output: 250 } }),
      makeStoryDispatchResult(COMPREHENSIVE_EPICS, { tokenEstimate: { input: 1200, output: 600 } }),
      makeReadinessDispatchResult('READY', [], { tokenEstimate: { input: 400, output: 150 } }),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    // Input: 800 + 1200 + 400 = 2400
    expect(result.tokenUsage.input).toBe(2400)
    // Output: 250 + 600 + 150 = 1000
    expect(result.tokenUsage.output).toBe(1000)
  })

  it('artifact_ids contains arch and story artifact IDs on READY success', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.artifact_ids).toBeDefined()
    expect(result.artifact_ids!.length).toBeGreaterThanOrEqual(2)
    // All artifact IDs should be non-empty strings
    for (const id of result.artifact_ids!) {
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    }
  })

  it('NOT_READY result includes gaps from fr_coverage blocker findings', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const readinessFindings = [
      { category: 'fr_coverage', severity: 'blocker', description: 'FR-7 (email notifications) not covered by any story', affected_items: ['FR-7'] },
      { category: 'fr_coverage', severity: 'blocker', description: 'FR-4 (invite team members) not traceable to story ACs', affected_items: ['FR-4'] },
      { category: 'story_quality', severity: 'major', description: 'Story 3-2 ACs are vague', affected_items: ['3-2'] },
    ]
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', readinessFindings),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.gaps).toBeDefined()
    expect(result.gaps).toHaveLength(2)
    expect(result.gaps![0]).toContain('FR-7')
    expect(result.gaps![1]).toContain('FR-4')
  })

  it('NEEDS_WORK with blockers triggers retry that includes all blocker descriptions', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const blockerDesc1 = 'FR-6 (task due dates) is not covered by any story'
    const blockerDesc2 = 'FR-7 (email notifications) is not covered by any story'
    const readinessFindings = [
      { category: 'fr_coverage', severity: 'blocker', description: blockerDesc1, affected_items: ['FR-6'] },
      { category: 'fr_coverage', severity: 'blocker', description: blockerDesc2, affected_items: ['FR-7'] },
    ]

    const improvedEpics: EpicDefinition[] = [
      ...COMPREHENSIVE_EPICS,
      {
        title: 'Notifications & Scheduling',
        description: 'Additional stories added to address coverage gaps',
        stories: [
          {
            key: '4-1',
            title: 'Set task due dates',
            description: 'Users can set due dates on tasks. Covers FR-6.',
            acceptance_criteria: ['Given task, When due date set, Then date stored'],
            priority: 'should',
          },
        ],
      },
    ]

    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(COMPREHENSIVE_EPICS),
      makeReadinessDispatchResult('NEEDS_WORK', readinessFindings),
      makeStoryDispatchResult(improvedEpics),
      makeReadinessDispatchResult('READY', []),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // 4th call (index 3) is the retry story generation
    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    expect(retryCall.prompt).toContain(blockerDesc1)
    expect(retryCall.prompt).toContain(blockerDesc2)
  })

  it('pipeline emits solutioning:readiness-failed event with detailed findings on NOT_READY', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const readinessFindings = [
      { category: 'fr_coverage', severity: 'blocker', description: 'FR-1 not covered', affected_items: ['FR-1'] },
      { category: 'architecture_compliance', severity: 'blocker', description: 'Story uses REST', affected_items: ['1-1', 'api-style'] },
    ]
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', readinessFindings),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    expect(eventBus.emit).toHaveBeenCalledWith(
      'solutioning:readiness-failed',
      expect.objectContaining({
        runId,
        verdict: 'NOT_READY',
        findings: expect.arrayContaining([
          expect.objectContaining({ category: 'fr_coverage', severity: 'blocker' }),
          expect.objectContaining({ category: 'architecture_compliance', severity: 'blocker' }),
        ]),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test suite: Readiness check with no NFRs (edge case)
// ---------------------------------------------------------------------------

describe('Readiness check integration: edge cases', () => {
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

  it('pipeline succeeds when no NFRs are present', async () => {
    await seedFunctionalRequirements(adapter, runId)
    // No NFRs seeded
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
  })

  it('readiness prompt contains "No non-functional requirements found" when no NFRs', async () => {
    await seedFunctionalRequirements(adapter, runId)
    // No NFRs seeded
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    expect(readinessCall.prompt).toContain('No non-functional requirements found')
  })

  it('readiness prompt does not contain raw {{placeholders}} after context injection', async () => {
    await seedFunctionalRequirements(adapter, runId)
    await seedNonFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // None of the context placeholders should remain unreplaced
    expect(readinessCall.prompt).not.toContain('{{functional_requirements}}')
    expect(readinessCall.prompt).not.toContain('{{non_functional_requirements}}')
    expect(readinessCall.prompt).not.toContain('{{architecture_decisions}}')
    expect(readinessCall.prompt).not.toContain('{{stories}}')
    expect(readinessCall.prompt).not.toContain('{{ux_decisions}}')
  })

  it('NEEDS_WORK without blockers proceeds successfully with warning (no retry)', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const readinessFindings = [
      { category: 'story_quality', severity: 'major', description: 'Story 3-2 ACs are vague', affected_items: ['3-2'] },
      { category: 'ux_alignment', severity: 'minor', description: 'Story missing accessibility reference', affected_items: ['1-1'] },
    ]
    // NEEDS_WORK but no blockers — should succeed with warnings
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', readinessFindings),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
    // Only 3 dispatches — no retry
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })

  it('readiness check error (dispatch failed) returns readiness_check_error', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY', [], {
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'Readiness agent process crashed',
      }),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('readiness_check_error')
    expect(result.readiness_passed).toBe(false)
  })

  it('readiness dispatch is the 3rd dispatch and receives outputSchema', async () => {
    await seedFunctionalRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const readinessCall = vi.mocked(dispatcher.dispatch).mock.calls[2][0]
    // Readiness check should provide an outputSchema for validation
    expect(readinessCall.outputSchema).toBeDefined()
  })
})
