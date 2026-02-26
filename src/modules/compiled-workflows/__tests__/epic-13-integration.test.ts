/**
 * Epic 13 Integration Tests — Adaptive Story Decomposition
 *
 * Tests cross-story interactions that individual unit tests cannot cover:
 *   1. analyzeStoryComplexity → planTaskBatches pipeline with real story content
 *   2. Module index re-exports for new Epic 13 symbols
 *   3. taskScope string format produced by the orchestrator batch loop
 *   4. analyzeStoryComplexity output directly drives planTaskBatches batch shape
 *   5. Boundary: medium story (scope="medium") never triggers batching in orchestrator
 */

import { describe, it, expect } from 'vitest'
import { analyzeStoryComplexity, planTaskBatches, TASKS_PER_BATCH } from '../index.js'
import type { StoryAnalysis, StoryTask, TaskBatch } from '../index.js'

// ---------------------------------------------------------------------------
// Fixtures — realistic BMAD story content mirroring Epic 13 stories
// ---------------------------------------------------------------------------

/**
 * A large story with 10 tasks, matching the fixture used in orchestrator tests.
 * Scope: large → triggers batched dispatch.
 */
const LARGE_STORY_10_TASKS = `# Story 13-3: Large Story

Status: ready-for-dev

## Story
As a developer, I want batched dispatch for large stories.

## Acceptance Criteria
### AC1: Feature One
### AC2: Feature Two
### AC3: Feature Three

## Tasks

- [ ] T1: Implement type extension
- [ ] T2: Update dev-story module
- [ ] T3: Add prompt placeholders
- [ ] T4: Add story analysis calls
- [ ] T5: Implement batch dispatch loop
- [ ] T6: Implement batch failure handling
- [ ] T7: Write tests for large story
- [ ] T8: Write tests for small story
- [ ] T9: Write tests for file accumulation
- [ ] T10: Write tests for batch failure
`

/**
 * A small story with 3 tasks.
 * Scope: small → single dispatch passthrough.
 */
const SMALL_STORY_3_TASKS = `# Story 5-1: Small Story

Status: ready-for-dev

## Story
As a developer, I want a small feature.

## Acceptance Criteria
### AC1: Feature

## Tasks

- [ ] T1: Do task one
- [ ] T2: Do task two
- [ ] T3: Do task three
`

/**
 * A medium story with 7 tasks.
 * Scope: medium → single dispatch passthrough (even though task count > TASKS_PER_BATCH).
 */
const MEDIUM_STORY_7_TASKS = `# Story 7-1: Medium Story

Status: ready-for-dev

## Story
As a developer, I want a medium feature.

## Acceptance Criteria
### AC1: Alpha
### AC2: Beta
### AC3: Gamma

## Tasks

- [ ] T1: Set up module structure
- [ ] T2: Implement core logic
- [ ] T3: Add error handling
- [ ] T4: Write unit tests
- [ ] T5: Write integration tests
- [ ] T6: Update documentation
- [ ] T7: Wire up CLI command
`

/**
 * A story that uses "Task N:" format with subtasks and AC refs.
 * Tests that subtasks are excluded from batch planning.
 */
const STORY_WITH_SUBTASKS_AND_AC_REFS = `# Story 7-1: Plan Generation Core

## Acceptance Criteria
### AC1: Basic Plan Generation
### AC2: Output File Flag
### AC3: Model Selection Flag

## Tasks

- [ ] Task 1: Create plan-generator.ts — core plan generation logic (AC1, AC3)
  - [ ] Define PlanError class
  - [ ] Define PlanGeneratorOptions interface
  - [ ] Implement PlanGenerator class
- [ ] Task 2: Create index.ts — public re-exports (AC1)
- [ ] Task 3: Create plan.ts — substrate plan CLI command (AC1, AC2)
  - [ ] Define PlanActionOptions interface
  - [ ] Implement runPlanAction function
`

// ---------------------------------------------------------------------------
// Integration 1: analyzeStoryComplexity → planTaskBatches pipeline
// ---------------------------------------------------------------------------

describe('Epic 13 Integration: analyzeStoryComplexity → planTaskBatches pipeline', () => {
  it('large story (10 tasks) produces 2 batches of 5 through the full pipeline', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)

    // Verify analysis output
    expect(analysis.taskCount).toBe(10)
    expect(analysis.estimatedScope).toBe('large')
    expect(analysis.suggestedBatchCount).toBe(2)

    // Verify batch planner output
    expect(batches.length).toBe(2)
    expect(batches[0]!.taskIds).toEqual([1, 2, 3, 4, 5])
    expect(batches[1]!.taskIds).toEqual([6, 7, 8, 9, 10])
    expect(batches[0]!.batchIndex).toBe(0)
    expect(batches[1]!.batchIndex).toBe(1)
  })

  it('small story (3 tasks) produces 1 batch with all tasks through the full pipeline', () => {
    const analysis = analyzeStoryComplexity(SMALL_STORY_3_TASKS)
    const batches = planTaskBatches(analysis)

    expect(analysis.taskCount).toBe(3)
    expect(analysis.estimatedScope).toBe('small')

    // planTaskBatches passthrough — single batch
    expect(batches.length).toBe(1)
    expect(batches[0]!.taskIds).toEqual([1, 2, 3])
  })

  it('medium story (7 tasks) produces 1 batch with all 7 tasks (passthrough behavior)', () => {
    const analysis = analyzeStoryComplexity(MEDIUM_STORY_7_TASKS)
    const batches = planTaskBatches(analysis)

    expect(analysis.taskCount).toBe(7)
    expect(analysis.estimatedScope).toBe('medium')

    // Medium stories are NOT batched — single dispatch
    expect(batches.length).toBe(1)
    expect(batches[0]!.taskIds.length).toBe(7)
    expect(batches[0]!.taskIds).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('story with subtasks: subtasks excluded from batch planning', () => {
    const analysis = analyzeStoryComplexity(STORY_WITH_SUBTASKS_AND_AC_REFS)
    const batches = planTaskBatches(analysis)

    // Only 3 top-level tasks (not the 5 subtasks)
    expect(analysis.taskCount).toBe(3)
    expect(batches.length).toBe(1)
    expect(batches[0]!.taskIds).toEqual([1, 2, 3])
  })

  it('AC refs from story content flow correctly into batch acRefs', () => {
    const analysis = analyzeStoryComplexity(STORY_WITH_SUBTASKS_AND_AC_REFS)
    const batches = planTaskBatches(analysis)

    // Task 1 has (AC1, AC3), Task 2 has (AC1), Task 3 has (AC1, AC2)
    // Single batch (small) should union all refs
    const acRefs = batches[0]!.acRefs
    expect(acRefs).toContain('AC1')
    expect(acRefs).toContain('AC2')
    expect(acRefs).toContain('AC3')
  })

  it('all tasks across all batches from a large story equals the original task count', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)

    const allTaskIds = batches.flatMap((b) => b.taskIds)
    expect(allTaskIds.length).toBe(analysis.taskCount)
    // All IDs are unique
    expect(new Set(allTaskIds).size).toBe(analysis.taskCount)
  })

  it('batch task titles from the planner match the titles parsed by the analyzer', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)

    // Verify each batch title matches the original task title from analysis
    for (const batch of batches) {
      for (let i = 0; i < batch.taskIds.length; i++) {
        const taskId = batch.taskIds[i]!
        const batchTitle = batch.taskTitles[i]!
        const originalTask = analysis.tasks.find((t) => t.id === taskId)
        expect(originalTask).toBeDefined()
        expect(batchTitle).toBe(originalTask!.title)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Integration 2: Module index re-exports (Story 13-1, 13-2, index.ts)
// ---------------------------------------------------------------------------

describe('Epic 13 Integration: module index re-exports', () => {
  it('analyzeStoryComplexity is exported from the module index', () => {
    expect(typeof analyzeStoryComplexity).toBe('function')
  })

  it('planTaskBatches is exported from the module index', () => {
    expect(typeof planTaskBatches).toBe('function')
  })

  it('TASKS_PER_BATCH constant is exported from the module index', () => {
    expect(typeof TASKS_PER_BATCH).toBe('number')
    expect(TASKS_PER_BATCH).toBe(5)
  })

  it('StoryAnalysis type is available (checked via runtime shape of output)', () => {
    const result: StoryAnalysis = analyzeStoryComplexity(SMALL_STORY_3_TASKS)
    // TypeScript compiles this — if StoryAnalysis type was not exported, this would fail to compile
    expect(result).toHaveProperty('acCount')
    expect(result).toHaveProperty('tasks')
    expect(result).toHaveProperty('taskCount')
    expect(result).toHaveProperty('estimatedScope')
    expect(result).toHaveProperty('suggestedBatchCount')
  })

  it('StoryTask type is available (checked via runtime shape of tasks)', () => {
    const result = analyzeStoryComplexity(SMALL_STORY_3_TASKS)
    const task: StoryTask = result.tasks[0]!
    expect(task).toHaveProperty('id')
    expect(task).toHaveProperty('title')
    expect(task).toHaveProperty('acRefs')
    expect(task).toHaveProperty('subtaskCount')
    expect(task).toHaveProperty('completed')
  })

  it('TaskBatch type is available (checked via runtime shape of planTaskBatches output)', () => {
    const analysis = analyzeStoryComplexity(SMALL_STORY_3_TASKS)
    const batches = planTaskBatches(analysis)
    const batch: TaskBatch = batches[0]!
    expect(batch).toHaveProperty('batchIndex')
    expect(batch).toHaveProperty('taskIds')
    expect(batch).toHaveProperty('taskTitles')
    expect(batch).toHaveProperty('acRefs')
  })
})

// ---------------------------------------------------------------------------
// Integration 3: taskScope string format produced by orchestrator
// (mirrors the string-building logic in orchestrator-impl.ts AC2)
// ---------------------------------------------------------------------------

describe('Epic 13 Integration: taskScope string format', () => {
  /**
   * Helper that replicates the orchestrator's taskScope string-building logic:
   *   batch.taskIds.map((id, i) => `T${id}: ${batch.taskTitles[i] ?? ''}`).join('\n')
   */
  function buildTaskScope(batch: TaskBatch): string {
    return batch.taskIds.map((id, i) => `T${id}: ${batch.taskTitles[i] ?? ''}`).join('\n')
  }

  it('first batch of large story produces correct T1-T5 taskScope string', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)
    const taskScope = buildTaskScope(batches[0]!)

    expect(taskScope).toContain('T1:')
    expect(taskScope).toContain('T2:')
    expect(taskScope).toContain('T3:')
    expect(taskScope).toContain('T4:')
    expect(taskScope).toContain('T5:')
    // Should NOT contain tasks from the second batch
    expect(taskScope).not.toContain('T6:')
    expect(taskScope).not.toContain('T10:')
  })

  it('second batch of large story produces correct T6-T10 taskScope string', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)
    const taskScope = buildTaskScope(batches[1]!)

    expect(taskScope).toContain('T6:')
    expect(taskScope).toContain('T7:')
    expect(taskScope).toContain('T8:')
    expect(taskScope).toContain('T9:')
    expect(taskScope).toContain('T10:')
    // Should NOT contain tasks from the first batch
    expect(taskScope).not.toContain('T1:')
    expect(taskScope).not.toContain('T5:')
  })

  it('taskScope string includes the actual task title text from the story', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)
    const firstBatchScope = buildTaskScope(batches[0]!)

    expect(firstBatchScope).toContain('Implement type extension')
    expect(firstBatchScope).toContain('Update dev-story module')
    expect(firstBatchScope).toContain('Add prompt placeholders')
  })

  it('taskScope lines use T<id>: format (matching dev-story.md Task N: parser)', () => {
    const analysis = analyzeStoryComplexity(LARGE_STORY_10_TASKS)
    const batches = planTaskBatches(analysis)
    const taskScope = buildTaskScope(batches[0]!)

    const lines = taskScope.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBe(5) // 5 tasks per batch
    for (const line of lines) {
      // Each line must match "T<number>: <text>" format
      expect(line).toMatch(/^T\d+: .+/)
    }
  })

  it('taskScope for small story is not built (single dispatch — undefined)', () => {
    const analysis = analyzeStoryComplexity(SMALL_STORY_3_TASKS)

    // Small story: estimatedScope === 'small', batches.length === 1
    // The orchestrator does NOT use taskScope for small stories (passes undefined)
    expect(analysis.estimatedScope).toBe('small')
    const batches = planTaskBatches(analysis)
    // Single batch — the orchestrator uses this as single dispatch, no taskScope
    expect(batches.length).toBe(1)
    // The orchestrator only passes taskScope when estimatedScope === 'large' && batches.length > 1
    const shouldUseBatching = analysis.estimatedScope === 'large' && batches.length > 1
    expect(shouldUseBatching).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration 4: Boundary conditions across the full analyze→plan pipeline
// ---------------------------------------------------------------------------

describe('Epic 13 Integration: boundary conditions across analyze→plan pipeline', () => {
  it('exactly 10 tasks (boundary: medium→large) triggers batching', () => {
    // 10 tasks is the minimum for 'large' scope
    const content = `
## Acceptance Criteria
### AC1: Criterion

## Tasks
- [ ] T1: Task 1
- [ ] T2: Task 2
- [ ] T3: Task 3
- [ ] T4: Task 4
- [ ] T5: Task 5
- [ ] T6: Task 6
- [ ] T7: Task 7
- [ ] T8: Task 8
- [ ] T9: Task 9
- [ ] T10: Task 10
`
    const analysis = analyzeStoryComplexity(content)
    const batches = planTaskBatches(analysis)

    expect(analysis.estimatedScope).toBe('large')
    expect(batches.length).toBe(2)
    expect(batches[0]!.taskIds.length).toBe(5)
    expect(batches[1]!.taskIds.length).toBe(5)
  })

  it('exactly 9 tasks (boundary: still medium) does NOT trigger batching', () => {
    const content = `
## Tasks
- [ ] T1: Task 1
- [ ] T2: Task 2
- [ ] T3: Task 3
- [ ] T4: Task 4
- [ ] T5: Task 5
- [ ] T6: Task 6
- [ ] T7: Task 7
- [ ] T8: Task 8
- [ ] T9: Task 9
`
    const analysis = analyzeStoryComplexity(content)
    const batches = planTaskBatches(analysis)

    expect(analysis.estimatedScope).toBe('medium')
    // Medium passthrough: single batch
    expect(batches.length).toBe(1)
    expect(batches[0]!.taskIds.length).toBe(9)
  })

  it('empty story produces a single empty batch and no errors', () => {
    const analysis = analyzeStoryComplexity('')
    const batches = planTaskBatches(analysis)

    expect(analysis.taskCount).toBe(0)
    expect(analysis.estimatedScope).toBe('small')
    expect(batches.length).toBe(1)
    expect(batches[0]!.taskIds).toEqual([])
  })

  it('story with completed tasks (- [x]) are still included in batch planning', () => {
    const content = `
## Tasks
- [x] T1: Already done
- [ ] T2: Pending task
- [x] T3: Also done
- [ ] T4: Still pending
- [x] T5: Also completed
- [ ] T6: Needs work
- [ ] T7: Needs work too
- [ ] T8: Also needs work
- [ ] T9: And this one
- [ ] T10: This one too
`
    const analysis = analyzeStoryComplexity(content)
    const batches = planTaskBatches(analysis)

    // All 10 tasks (including completed ones) are in the batches
    expect(analysis.taskCount).toBe(10)
    expect(analysis.estimatedScope).toBe('large')
    const allIds = batches.flatMap((b) => b.taskIds)
    expect(allIds.length).toBe(10)
    // Completed tasks included
    expect(allIds).toContain(1)
    expect(allIds).toContain(3)
    expect(allIds).toContain(5)
  })

  it('story with 11 tasks produces 3 batches (5+5+1 split)', () => {
    const content = `
## Tasks
- [ ] T1: Task 1
- [ ] T2: Task 2
- [ ] T3: Task 3
- [ ] T4: Task 4
- [ ] T5: Task 5
- [ ] T6: Task 6
- [ ] T7: Task 7
- [ ] T8: Task 8
- [ ] T9: Task 9
- [ ] T10: Task 10
- [ ] T11: Task 11
`
    const analysis = analyzeStoryComplexity(content)
    const batches = planTaskBatches(analysis)

    expect(analysis.estimatedScope).toBe('large')
    expect(batches.length).toBe(3)
    expect(batches[0]!.taskIds.length).toBe(5)
    expect(batches[1]!.taskIds.length).toBe(5)
    expect(batches[2]!.taskIds.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Integration 5: priorFiles accumulation logic mirrors orchestrator behavior
// ---------------------------------------------------------------------------

describe('Epic 13 Integration: priorFiles accumulation across batches', () => {
  /**
   * Simulates the orchestrator's allFilesModified Set accumulation logic.
   * Each "batch" call returns some files; we verify the Set correctly accumulates.
   */
  function simulateBatchAccumulation(batchFiles: string[][]): string[] {
    const allFilesModified = new Set<string>()
    for (const files of batchFiles) {
      for (const f of files) {
        allFilesModified.add(f)
      }
    }
    return Array.from(allFilesModified)
  }

  it('files from multiple batches are unioned correctly (no duplicates)', () => {
    const accumulated = simulateBatchAccumulation([
      ['src/types.ts', 'src/impl.ts'],
      ['src/tests.ts', 'src/index.ts'],
    ])

    expect(accumulated.length).toBe(4)
    expect(accumulated).toContain('src/types.ts')
    expect(accumulated).toContain('src/impl.ts')
    expect(accumulated).toContain('src/tests.ts')
    expect(accumulated).toContain('src/index.ts')
  })

  it('duplicate files across batches appear only once in accumulated list', () => {
    const accumulated = simulateBatchAccumulation([
      ['src/index.ts', 'src/a.ts'],
      ['src/index.ts', 'src/b.ts'],
    ])

    expect(accumulated.filter((f) => f === 'src/index.ts').length).toBe(1)
    expect(accumulated.length).toBe(3) // index.ts, a.ts, b.ts
  })

  it('priorFiles for second batch contains files from first batch only', () => {
    const batch1Files = ['src/types.ts', 'src/impl.ts']
    const accumulatedAfterBatch1 = simulateBatchAccumulation([batch1Files])

    // Second batch receives priorFiles = accumulation after first batch
    expect(accumulatedAfterBatch1).toEqual(batch1Files)
    expect(accumulatedAfterBatch1).toContain('src/types.ts')
    expect(accumulatedAfterBatch1).toContain('src/impl.ts')
  })

  it('empty files from a failed batch do not affect accumulation', () => {
    const accumulated = simulateBatchAccumulation([
      [], // batch 1 failed with no files
      ['src/batch2.ts'],
    ])

    expect(accumulated).toEqual(['src/batch2.ts'])
  })
})
