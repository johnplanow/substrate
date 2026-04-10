/**
 * Integration tests for Story 25-4: Contract Declaration in Story Creation.
 *
 * Verifies that the orchestrator parses Interface Contracts sections from
 * story files after create-story completes and stores each contract
 * declaration in the decision store with category 'interface-contract'.
 *
 * AC3: Contract Declarations in Decision Store
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Mock compiled workflow functions
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
  isValidStoryFile: vi.fn().mockResolvedValue({ valid: false, reason: 'missing_structure' }),
}))
vi.mock('../../compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))
vi.mock('../../compiled-workflows/test-plan.js', () => ({
  runTestPlan: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock persistence queries — include createDecision so we can spy on it
// ---------------------------------------------------------------------------

vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn(),
  getDecisionsByPhase: vi.fn().mockReturnValue([]),
  getDecisionsByCategory: vi.fn().mockReturnValue([]),
  registerArtifact: vi.fn(),
  createDecision: vi.fn().mockReturnValue({
    id: 'decision-uuid',
    pipeline_run_id: 'test-run-id',
    phase: 'implementation',
    category: 'interface-contract',
    key: 'test-key',
    value: '{}',
    rationale: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }),
}))

vi.mock('../../../persistence/queries/metrics.js', () => ({
  writeRunMetrics: vi.fn(),
  writeStoryMetrics: vi.fn(),
  aggregateTokenUsageForRun: vi.fn().mockReturnValue({ input: 0, output: 0, cost: 0 }),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// Default: readFile is overridden per-test
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('mock readFile: file not found')),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
}))

vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi
    .fn()
    .mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))

vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))

vi.mock('../../agent-dispatch/interface-change-detector.js', () => ({
  detectInterfaceChanges: vi
    .fn()
    .mockReturnValue({ modifiedInterfaces: [], potentiallyAffectedTests: [] }),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { runTestPlan } from '../../compiled-workflows/test-plan.js'
import { createDecision } from '../../../persistence/queries/decisions.js'
import { readFile } from 'node:fs/promises'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockRunTestPlan = vi.mocked(runTestPlan)
const mockCreateDecision = vi.mocked(createDecision)
const mockReadFile = vi.mocked(readFile)

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function createMockDb(): DatabaseAdapter {
  return {} as DatabaseAdapter
}

function createMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function createMockContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  } as unknown as ContextCompiler
}

function createMockDispatcher(): Dispatcher {
  const mockResult: DispatchResult<unknown> = {
    id: 'fix-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const mockHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'fix-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(mockResult),
  }
  return {
    dispatch: vi.fn().mockReturnValue(mockHandle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi
      .fn()
      .mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 1,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    gcPauseMs: 0,
    ...overrides,
  }
}

function makeCreateStorySuccess(storyKey = 'test-story', filePath?: string) {
  return {
    result: 'success' as const,
    story_file: filePath ?? `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Test Story',
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeDevStorySuccess() {
  return {
    result: 'success' as const,
    ac_met: ['AC1'],
    ac_failures: [],
    files_modified: ['src/foo.ts'],
    tests: 'pass' as const,
    tokenUsage: { input: 200, output: 100 },
  }
}

function makeCodeReviewShipIt() {
  return {
    verdict: 'SHIP_IT' as const,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// Story file content with Interface Contracts section
// ---------------------------------------------------------------------------

const STORY_WITH_CONTRACTS = `# Story 25-4: Contract Declaration in Story Creation

Status: pending

## User Story

As a pipeline operator, I want stories to declare interface contracts.

## Acceptance Criteria

### AC1: something
**Given** the pipeline
**When** something happens
**Then** something occurs

## Interface Contracts

- **Export**: JudgeResult @ src/modules/judge/types.ts (queue: judge-results)
- **Import**: CheckRunInput @ src/modules/check-publisher/types.ts (from story 25-5)

## Dev Notes

Some notes here.

## Tasks

- [ ] Task 1: Do something
`

const STORY_WITHOUT_CONTRACTS = `# Story 25-3: LGTM_WITH_NOTES Verdict

Status: pending

## User Story

As a pipeline operator, no contracts here.

## Acceptance Criteria

### AC1: something

## Dev Notes

No contracts.

## Tasks

- [ ] Task 1: Do something
`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AC3: orchestrator stores interface contract declarations after create-story', () => {
  let db: DatabaseAdapter
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let config: OrchestratorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    config = defaultConfig()

    // Default test plan mock
    mockRunTestPlan.mockResolvedValue({
      result: 'success' as const,
      test_files: [],
      test_categories: [],
      coverage_notes: '',
      tokenUsage: { input: 50, output: 20 },
    })
  })

  it('stores contract declarations in decision store when story has Interface Contracts section', async () => {
    const storyFilePath = '/path/to/25-4-contract-declaration.md'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-4', storyFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    // Return story content with Interface Contracts section for this specific file
    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (String(filePath) === storyFilePath) {
        return STORY_WITH_CONTRACTS
      }
      throw new Error('mock readFile: file not found')
    })

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
    })

    await orchestrator.run(['25-4'])

    // createDecision should have been called with interface-contract entries
    const interfaceContractCalls = mockCreateDecision.mock.calls.filter(
      (call) => call[1]?.category === 'interface-contract'
    )
    expect(interfaceContractCalls).toHaveLength(2)

    // Verify the export declaration
    const exportCall = interfaceContractCalls.find((call) => call[1]?.key === '25-4:JudgeResult')
    expect(exportCall).toBeDefined()
    const exportValue = JSON.parse(exportCall![1]?.value ?? '{}')
    expect(exportValue.direction).toBe('export')
    expect(exportValue.schemaName).toBe('JudgeResult')
    expect(exportValue.filePath).toBe('src/modules/judge/types.ts')
    expect(exportValue.storyKey).toBe('25-4')
    expect(exportValue.transport).toBe('queue: judge-results')

    // Verify the import declaration
    const importCall = interfaceContractCalls.find((call) => call[1]?.key === '25-4:CheckRunInput')
    expect(importCall).toBeDefined()
    const importValue = JSON.parse(importCall![1]?.value ?? '{}')
    expect(importValue.direction).toBe('import')
    expect(importValue.schemaName).toBe('CheckRunInput')
    expect(importValue.filePath).toBe('src/modules/check-publisher/types.ts')
    expect(importValue.storyKey).toBe('25-4')
    expect(importValue.transport).toBe('from story 25-5')
  })

  it('stores declarations with phase=implementation and category=interface-contract', async () => {
    const storyFilePath = '/path/to/25-4-contract-declaration.md'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-4', storyFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (String(filePath) === storyFilePath) {
        return STORY_WITH_CONTRACTS
      }
      throw new Error('mock readFile: file not found')
    })

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
    })

    await orchestrator.run(['25-4'])

    const interfaceContractCalls = mockCreateDecision.mock.calls.filter(
      (call) => call[1]?.category === 'interface-contract'
    )
    for (const call of interfaceContractCalls) {
      expect(call[1]?.phase).toBe('implementation')
      expect(call[1]?.category).toBe('interface-contract')
      expect(call[1]?.pipeline_run_id).toBe('test-run-id')
    }
  })

  it('does NOT call createDecision with interface-contract when story has no Interface Contracts section', async () => {
    const storyFilePath = '/path/to/25-3-lgtm-with-notes.md'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-3', storyFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (String(filePath) === storyFilePath) {
        return STORY_WITHOUT_CONTRACTS
      }
      throw new Error('mock readFile: file not found')
    })

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
    })

    await orchestrator.run(['25-3'])

    const interfaceContractCalls = mockCreateDecision.mock.calls.filter(
      (call) => call[1]?.category === 'interface-contract'
    )
    expect(interfaceContractCalls).toHaveLength(0)
  })

  it('continues pipeline without error when readFile throws during contract parsing', async () => {
    const storyFilePath = '/path/to/25-4-contract-declaration.md'

    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-4', storyFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    // All readFile calls fail (simulates file read error)
    mockReadFile.mockRejectedValue(new Error('ENOENT: file not found'))

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
    })

    const status = await orchestrator.run(['25-4'])

    // Pipeline should still complete successfully despite contract parsing failure
    expect(status.state).toBe('COMPLETE')
    expect(status.stories['25-4']?.phase).toBe('COMPLETE')
  })

  it('stores key as {storyKey}:{contractName} format', async () => {
    const storyFilePath = '/path/to/25-4.md'
    const storyWithSingleExport = `# Story 25-4

## Acceptance Criteria

AC1: Something

## Interface Contracts

- **Export**: MyCustomSchema @ src/schemas/custom.ts

## Tasks

- [ ] Task 1
`
    mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('25-4', storyFilePath))
    mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
    mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

    mockReadFile.mockImplementation(async (filePath: unknown) => {
      if (String(filePath) === storyFilePath) return storyWithSingleExport
      throw new Error('mock readFile: file not found')
    })

    const orchestrator = createImplementationOrchestrator({
      db,
      pack,
      contextCompiler,
      dispatcher,
      eventBus,
      config,
    })

    await orchestrator.run(['25-4'])

    const interfaceContractCalls = mockCreateDecision.mock.calls.filter(
      (call) => call[1]?.category === 'interface-contract'
    )
    expect(interfaceContractCalls).toHaveLength(1)
    expect(interfaceContractCalls[0][1]?.key).toBe('25-4:MyCustomSchema')
  })
})
