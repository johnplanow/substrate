/**
 * Unit tests for the task-batch-planner module.
 *
 * Tests: main function signature, batch size limit (TASKS_PER_BATCH),
 * task ordering, AC grouping, small/medium passthrough, large story batching,
 * empty task handling, and edge cases.
 *
 * Uses StoryAnalysis fixtures that mirror real BMAD story outputs.
 */

import { describe, it, expect } from 'vitest'
import { planTaskBatches } from '../task-batch-planner.js'
import type { TaskBatch } from '../task-batch-planner.js'
import type { StoryAnalysis, StoryTask } from '../story-analyzer.js'
import { TASKS_PER_BATCH } from '../story-analyzer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(
  id: number,
  title: string,
  acRefs: string[] = [],
  subtaskCount = 0,
  completed = false,
): StoryTask {
  return { id, title, acRefs, subtaskCount, completed }
}

function makeAnalysis(
  tasks: StoryTask[],
  estimatedScope: 'small' | 'medium' | 'large',
  overrides: Partial<StoryAnalysis> = {},
): StoryAnalysis {
  const taskCount = tasks.length
  const suggestedBatchCount = Math.ceil(taskCount / TASKS_PER_BATCH) || 0
  return {
    acCount: 5,
    tasks,
    taskCount,
    estimatedScope,
    suggestedBatchCount,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Small story: 5 tasks (scope: small) */
const SMALL_TASKS: StoryTask[] = [
  makeTask(1, 'Task one', ['AC1']),
  makeTask(2, 'Task two', ['AC2']),
  makeTask(3, 'Task three', ['AC1', 'AC3']),
  makeTask(4, 'Task four', []),
  makeTask(5, 'Task five', ['AC2']),
]

/** Medium story: 8 tasks (scope: medium) */
const MEDIUM_TASKS: StoryTask[] = [
  makeTask(1, 'Task one', ['AC1']),
  makeTask(2, 'Task two', ['AC1', 'AC2']),
  makeTask(3, 'Task three', ['AC2']),
  makeTask(4, 'Task four', ['AC3']),
  makeTask(5, 'Task five', []),
  makeTask(6, 'Task six', ['AC3']),
  makeTask(7, 'Task seven', ['AC4']),
  makeTask(8, 'Task eight', ['AC4', 'AC5']),
]

/** Large story: 14 tasks (scope: large) → should yield 3 batches */
const LARGE_TASKS: StoryTask[] = [
  makeTask(1, 'Task 1', ['AC1']),
  makeTask(2, 'Task 2', ['AC1', 'AC2']),
  makeTask(3, 'Task 3', ['AC2']),
  makeTask(4, 'Task 4', ['AC3']),
  makeTask(5, 'Task 5', ['AC3']),
  makeTask(6, 'Task 6', ['AC4']),
  makeTask(7, 'Task 7', ['AC4', 'AC5']),
  makeTask(8, 'Task 8', ['AC5']),
  makeTask(9, 'Task 9', ['AC6']),
  makeTask(10, 'Task 10', ['AC6']),
  makeTask(11, 'Task 11', ['AC7']),
  makeTask(12, 'Task 12', ['AC7']),
  makeTask(13, 'Task 13', ['AC8']),
  makeTask(14, 'Task 14', ['AC8']),
]

// ---------------------------------------------------------------------------
// AC1: Main function signature
// ---------------------------------------------------------------------------

describe('planTaskBatches — main function signature', () => {
  it('accepts a StoryAnalysis and returns an array', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const result = planTaskBatches(analysis)
    expect(Array.isArray(result)).toBe(true)
  })

  it('each element has batchIndex, taskIds, taskTitles, and acRefs', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      expect(batch).toHaveProperty('batchIndex')
      expect(batch).toHaveProperty('taskIds')
      expect(batch).toHaveProperty('taskTitles')
      expect(batch).toHaveProperty('acRefs')
      expect(typeof batch.batchIndex).toBe('number')
      expect(Array.isArray(batch.taskIds)).toBe(true)
      expect(Array.isArray(batch.taskTitles)).toBe(true)
      expect(Array.isArray(batch.acRefs)).toBe(true)
    }
  })

  it('batchIndex values are zero-based sequential integers', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    result.forEach((batch, i) => {
      expect(batch.batchIndex).toBe(i)
    })
  })

  it('taskIds and taskTitles have the same length within each batch', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      expect(batch.taskIds.length).toBe(batch.taskTitles.length)
    }
  })

  it('taskIds match expected task IDs', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.taskIds).toEqual([1, 2, 3, 4, 5])
  })

  it('taskTitles match expected task titles', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.taskTitles).toEqual([
      'Task one',
      'Task two',
      'Task three',
      'Task four',
      'Task five',
    ])
  })
})

// ---------------------------------------------------------------------------
// AC2: Batch size limit
// ---------------------------------------------------------------------------

describe('planTaskBatches — batch size limit', () => {
  it('each batch has at most TASKS_PER_BATCH tasks', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      expect(batch.taskIds.length).toBeLessThanOrEqual(TASKS_PER_BATCH)
    }
  })

  it('14 large tasks produce at most ceil(14/5) = 3 batches', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(3)
  })

  it('exactly TASKS_PER_BATCH tasks in the first batch for a 14-task story', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result[0].taskIds.length).toBe(TASKS_PER_BATCH)
  })

  it('no batch exceeds TASKS_PER_BATCH tasks (stress test with 20 tasks)', () => {
    const tasks20: StoryTask[] = Array.from({ length: 20 }, (_, i) =>
      makeTask(i + 1, `Task ${i + 1}`, []),
    )
    const analysis = makeAnalysis(tasks20, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      expect(batch.taskIds.length).toBeLessThanOrEqual(TASKS_PER_BATCH)
    }
  })

  it('all 20 tasks are included across batches', () => {
    const tasks20: StoryTask[] = Array.from({ length: 20 }, (_, i) =>
      makeTask(i + 1, `Task ${i + 1}`, []),
    )
    const analysis = makeAnalysis(tasks20, 'large')
    const result = planTaskBatches(analysis)

    const allIds = result.flatMap((b) => b.taskIds)
    expect(allIds.length).toBe(20)
    expect(allIds).toEqual(expect.arrayContaining([...Array.from({ length: 20 }, (_, i) => i + 1)]))
  })
})

// ---------------------------------------------------------------------------
// AC3: Task ordering
// ---------------------------------------------------------------------------

describe('planTaskBatches — task ordering', () => {
  it('tasks with lower IDs appear in earlier batches', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    // Flatten task IDs across batches — should be in ascending order
    const allIds = result.flatMap((b) => b.taskIds)
    const sorted = [...allIds].sort((a, b) => a - b)
    expect(allIds).toEqual(sorted)
  })

  it('within each batch, task IDs are in ascending order', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      const sorted = [...batch.taskIds].sort((a, b) => a - b)
      expect(batch.taskIds).toEqual(sorted)
    }
  })

  it('tasks from earlier batches always have lower IDs than tasks in later batches', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    for (let i = 0; i < result.length - 1; i++) {
      const currentMaxId = Math.max(...result[i].taskIds)
      const nextMinId = Math.min(...result[i + 1].taskIds)
      expect(currentMaxId).toBeLessThan(nextMinId)
    }
  })

  it('every task appears exactly once across all batches', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    const allIds = result.flatMap((b) => b.taskIds)
    const uniqueIds = new Set(allIds)
    expect(allIds.length).toBe(uniqueIds.size)
    expect(allIds.length).toBe(LARGE_TASKS.length)
  })
})

// ---------------------------------------------------------------------------
// AC4: AC grouping
// ---------------------------------------------------------------------------

describe('planTaskBatches — AC grouping', () => {
  it('acRefs in each batch is the union of AC refs from tasks in that batch', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      const expectedRefs = new Set<string>()
      for (const id of batch.taskIds) {
        const task = LARGE_TASKS.find((t) => t.id === id)!
        for (const ref of task.acRefs) {
          expectedRefs.add(ref)
        }
      }
      expect(new Set(batch.acRefs)).toEqual(expectedRefs)
    }
  })

  it('acRefs contains no duplicates within a batch', () => {
    const tasks = [
      makeTask(1, 'Task 1', ['AC1', 'AC2']),
      makeTask(2, 'Task 2', ['AC2', 'AC3']),
      makeTask(3, 'Task 3', ['AC1']),
      makeTask(4, 'Task 4', ['AC3']),
      makeTask(5, 'Task 5', ['AC4']),
      makeTask(6, 'Task 6', ['AC4']),
      makeTask(7, 'Task 7', ['AC5']),
      makeTask(8, 'Task 8', ['AC5']),
      makeTask(9, 'Task 9', ['AC6']),
      makeTask(10, 'Task 10', ['AC6']),
      makeTask(11, 'Task 11', ['AC7']),
    ]
    const analysis = makeAnalysis(tasks, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      const uniqueRefs = new Set(batch.acRefs)
      expect(batch.acRefs.length).toBe(uniqueRefs.size)
    }
  })

  it('empty acRefs when tasks have no AC references', () => {
    const tasks = Array.from({ length: 11 }, (_, i) => makeTask(i + 1, `Task ${i + 1}`, []))
    const analysis = makeAnalysis(tasks, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      expect(batch.acRefs).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// AC5: Small/medium passthrough
// ---------------------------------------------------------------------------

describe('planTaskBatches — small/medium passthrough', () => {
  it('returns exactly 1 batch for small scope story', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(1)
  })

  it('returns exactly 1 batch for medium scope story (8 tasks)', () => {
    const analysis = makeAnalysis(MEDIUM_TASKS, 'medium')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(1)
  })

  it('single batch contains all tasks for small story', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.taskIds).toEqual(SMALL_TASKS.map((t) => t.id))
  })

  it('single batch contains all tasks for medium story (8 tasks)', () => {
    const analysis = makeAnalysis(MEDIUM_TASKS, 'medium')
    const [batch] = planTaskBatches(analysis)
    expect(batch.taskIds).toEqual(MEDIUM_TASKS.map((t) => t.id))
  })

  it('medium passthrough works even when task count > TASKS_PER_BATCH (8 > 5)', () => {
    // Medium with 8 tasks should still be 1 batch (ignores TASKS_PER_BATCH limit)
    const analysis = makeAnalysis(MEDIUM_TASKS, 'medium')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(1)
    expect(result[0].taskIds.length).toBe(8)
  })

  it('batchIndex is 0 for the single batch', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.batchIndex).toBe(0)
  })

  it('acRefs in single batch is union of all task AC refs', () => {
    const analysis = makeAnalysis(SMALL_TASKS, 'small')
    const [batch] = planTaskBatches(analysis)
    // SMALL_TASKS has AC1, AC2, AC3 across tasks
    expect(batch.acRefs).toContain('AC1')
    expect(batch.acRefs).toContain('AC2')
    expect(batch.acRefs).toContain('AC3')
    // No duplicates
    const uniqueRefs = new Set(batch.acRefs)
    expect(batch.acRefs.length).toBe(uniqueRefs.size)
  })
})

// ---------------------------------------------------------------------------
// AC6: Large story batching
// ---------------------------------------------------------------------------

describe('planTaskBatches — large story batching', () => {
  it('returns 3 batches for 14-task large story', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(3)
  })

  it('14 tasks → batches of [5, 5, 4]', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result[0].taskIds.length).toBe(5)
    expect(result[1].taskIds.length).toBe(5)
    expect(result[2].taskIds.length).toBe(4)
  })

  it('batch 0 has tasks 1-5 for 14-task large story', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result[0].taskIds).toEqual([1, 2, 3, 4, 5])
  })

  it('batch 1 has tasks 6-10 for 14-task large story', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result[1].taskIds).toEqual([6, 7, 8, 9, 10])
  })

  it('batch 2 has tasks 11-14 for 14-task large story', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)
    expect(result[2].taskIds).toEqual([11, 12, 13, 14])
  })

  it('returns 2 batches for 10-task large story', () => {
    const tasks10: StoryTask[] = Array.from({ length: 10 }, (_, i) =>
      makeTask(i + 1, `Task ${i + 1}`, []),
    )
    const analysis = makeAnalysis(tasks10, 'large')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(2)
  })

  it('all tasks in large story are present across batches', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    const allIds = result.flatMap((b) => b.taskIds)
    const expectedIds = LARGE_TASKS.map((t) => t.id)
    expect(allIds.sort((a, b) => a - b)).toEqual(expectedIds.sort((a, b) => a - b))
  })
})

// ---------------------------------------------------------------------------
// AC7: Empty task handling
// ---------------------------------------------------------------------------

describe('planTaskBatches — empty task handling', () => {
  it('returns exactly 1 batch for empty task list', () => {
    const analysis = makeAnalysis([], 'small')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(1)
  })

  it('single batch has empty taskIds for empty task list', () => {
    const analysis = makeAnalysis([], 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.taskIds).toEqual([])
  })

  it('single batch has empty taskTitles for empty task list', () => {
    const analysis = makeAnalysis([], 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.taskTitles).toEqual([])
  })

  it('single batch has empty acRefs for empty task list', () => {
    const analysis = makeAnalysis([], 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.acRefs).toEqual([])
  })

  it('empty batch has batchIndex 0', () => {
    const analysis = makeAnalysis([], 'small')
    const [batch] = planTaskBatches(analysis)
    expect(batch.batchIndex).toBe(0)
  })

  it('does not throw for empty tasks with any scope', () => {
    expect(() => planTaskBatches(makeAnalysis([], 'small'))).not.toThrow()
    expect(() => planTaskBatches(makeAnalysis([], 'medium'))).not.toThrow()
    expect(() => planTaskBatches(makeAnalysis([], 'large'))).not.toThrow()
  })

  it('does not throw for empty tasks with large scope', () => {
    const analysis = makeAnalysis([], 'large')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(1)
    expect(result[0].taskIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Integration tests: realistic BMAD story scenarios
// ---------------------------------------------------------------------------

describe('planTaskBatches — integration: story 13-2 scenario (5 tasks, small)', () => {
  it('5 tasks with small scope → 1 batch with all 5 tasks', () => {
    const tasks: StoryTask[] = [
      makeTask(1, 'Create task-batch-planner.ts with TaskBatch type export', ['AC1']),
      makeTask(2, 'Implement sequential batching algorithm with TASKS_PER_BATCH limit', ['AC2', 'AC3']),
      makeTask(3, 'Implement AC-reference grouping heuristic', ['AC4']),
      makeTask(4, 'Implement small/medium passthrough (single batch)', ['AC5']),
      makeTask(5, 'Write unit tests', ['AC8']),
    ]
    const analysis = makeAnalysis(tasks, 'small')
    const result = planTaskBatches(analysis)

    expect(result.length).toBe(1)
    expect(result[0].taskIds).toEqual([1, 2, 3, 4, 5])
    expect(result[0].batchIndex).toBe(0)
    expect(result[0].acRefs).toContain('AC1')
    expect(result[0].acRefs).toContain('AC2')
    expect(result[0].acRefs).toContain('AC3')
    expect(result[0].acRefs).toContain('AC4')
    expect(result[0].acRefs).toContain('AC5')
    expect(result[0].acRefs).toContain('AC8')
  })
})

describe('planTaskBatches — integration: medium story (8 tasks)', () => {
  it('8 medium tasks → 1 batch containing all 8 tasks', () => {
    const analysis = makeAnalysis(MEDIUM_TASKS, 'medium')
    const result = planTaskBatches(analysis)

    expect(result.length).toBe(1)
    expect(result[0].taskIds.length).toBe(8)
    expect(result[0].taskIds).toEqual(MEDIUM_TASKS.map((t) => t.id))
  })
})

describe('planTaskBatches — integration: large story (14 tasks → 3 batches)', () => {
  it('14 large tasks → 3 batches with correct size distribution', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    expect(result.length).toBe(3)
    expect(result[0].taskIds.length).toBe(5)
    expect(result[1].taskIds.length).toBe(5)
    expect(result[2].taskIds.length).toBe(4)
  })

  it('total tasks across all 3 batches equals 14', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    const totalTasks = result.reduce((sum, b) => sum + b.taskIds.length, 0)
    expect(totalTasks).toBe(14)
  })
})

describe('planTaskBatches — integration: AC grouping with shared refs', () => {
  it('tasks sharing AC refs are included in the same batch when possible', () => {
    // Tasks 1-4 share AC1 and AC2; task 5 starts AC3; tasks 6-10 are new ACs
    const tasks = [
      makeTask(1, 'Task 1', ['AC1']),
      makeTask(2, 'Task 2', ['AC1', 'AC2']),
      makeTask(3, 'Task 3', ['AC2']),
      makeTask(4, 'Task 4', ['AC2']),
      makeTask(5, 'Task 5', ['AC3']),
      makeTask(6, 'Task 6', ['AC4']),
      makeTask(7, 'Task 7', ['AC4']),
      makeTask(8, 'Task 8', ['AC5']),
      makeTask(9, 'Task 9', ['AC5']),
      makeTask(10, 'Task 10', ['AC6']),
      makeTask(11, 'Task 11', ['AC7']),
    ]
    const analysis = makeAnalysis(tasks, 'large')
    const result = planTaskBatches(analysis)

    // First batch (tasks 1-5) covers AC1 and AC2 together
    const firstBatchRefs = result[0].acRefs
    expect(firstBatchRefs).toContain('AC1')
    expect(firstBatchRefs).toContain('AC2')
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('planTaskBatches — edge cases', () => {
  it('single task returns 1 batch with 1 task', () => {
    const tasks = [makeTask(1, 'Only task', ['AC1'])]
    const analysis = makeAnalysis(tasks, 'small')
    const result = planTaskBatches(analysis)

    expect(result.length).toBe(1)
    expect(result[0].taskIds).toEqual([1])
    expect(result[0].taskTitles).toEqual(['Only task'])
    expect(result[0].acRefs).toEqual(['AC1'])
  })

  it('exactly TASKS_PER_BATCH tasks with large scope → 1 batch', () => {
    const tasks5: StoryTask[] = Array.from({ length: TASKS_PER_BATCH }, (_, i) =>
      makeTask(i + 1, `Task ${i + 1}`, []),
    )
    const analysis = makeAnalysis(tasks5, 'large')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(1)
    expect(result[0].taskIds.length).toBe(TASKS_PER_BATCH)
  })

  it('TASKS_PER_BATCH + 1 tasks with large scope → 2 batches', () => {
    const tasks6: StoryTask[] = Array.from({ length: TASKS_PER_BATCH + 1 }, (_, i) =>
      makeTask(i + 1, `Task ${i + 1}`, []),
    )
    const analysis = makeAnalysis(tasks6, 'large')
    const result = planTaskBatches(analysis)
    expect(result.length).toBe(2)
    expect(result[0].taskIds.length).toBe(TASKS_PER_BATCH)
    expect(result[1].taskIds.length).toBe(1)
  })

  it('tasks with high IDs (e.g., T100, T101) preserve ordering', () => {
    const tasks = [
      makeTask(100, 'Hundredth task', ['AC1']),
      makeTask(101, 'Hundred and first', ['AC2']),
      makeTask(102, 'Hundred and second', ['AC3']),
      makeTask(103, 'Hundred and third', []),
      makeTask(104, 'Hundred and fourth', []),
      makeTask(105, 'Hundred and fifth', []),
      makeTask(106, 'Hundred and sixth', []),
      makeTask(107, 'Hundred and seventh', []),
      makeTask(108, 'Hundred and eighth', []),
      makeTask(109, 'Hundred and ninth', []),
      makeTask(110, 'Hundred and tenth', []),
    ]
    const analysis = makeAnalysis(tasks, 'large')
    const result = planTaskBatches(analysis)

    expect(result[0].taskIds[0]).toBe(100)
    for (let i = 0; i < result.length - 1; i++) {
      const currentMax = Math.max(...result[i].taskIds)
      const nextMin = Math.min(...result[i + 1].taskIds)
      expect(currentMax).toBeLessThan(nextMin)
    }
  })

  it('completed tasks are included in batches', () => {
    const tasks = [
      makeTask(1, 'Already done', [], 0, true),
      makeTask(2, 'Pending', [], 0, false),
      makeTask(3, 'Also done', [], 0, true),
      makeTask(4, 'Pending 2', []),
      makeTask(5, 'Pending 3', []),
      makeTask(6, 'Pending 4', []),
      makeTask(7, 'Pending 5', []),
      makeTask(8, 'Pending 6', []),
      makeTask(9, 'Pending 7', []),
      makeTask(10, 'Pending 8', []),
      makeTask(11, 'Pending 9', []),
    ]
    const analysis = makeAnalysis(tasks, 'large')
    const result = planTaskBatches(analysis)
    const allIds = result.flatMap((b) => b.taskIds)
    expect(allIds).toContain(1)
    expect(allIds).toContain(3)
  })

  it('taskTitles match task titles in order within each batch', () => {
    const analysis = makeAnalysis(LARGE_TASKS, 'large')
    const result = planTaskBatches(analysis)

    for (const batch of result) {
      for (let i = 0; i < batch.taskIds.length; i++) {
        const task = LARGE_TASKS.find((t) => t.id === batch.taskIds[i])!
        expect(batch.taskTitles[i]).toBe(task.title)
      }
    }
  })
})
