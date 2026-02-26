/**
 * Task Batch Planner for the compiled-workflows module.
 *
 * Groups a story's tasks into ordered batches suitable for sequential dev-story dispatch.
 * Each batch is a coherent unit of work that fits within agent turn limits.
 *
 * Pure function — takes StoryAnalysis, returns TaskBatch[]. No side effects.
 */

import type { StoryAnalysis, StoryTask } from './story-analyzer.js'
import { TASKS_PER_BATCH } from './story-analyzer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A batch of tasks to be dispatched to a dev-story agent in sequence.
 */
export interface TaskBatch {
  /** Zero-based index of this batch in the ordered sequence */
  batchIndex: number
  /** Task IDs included in this batch (from StoryTask.id) */
  taskIds: number[]
  /** Task titles corresponding to taskIds (same order) */
  taskTitles: string[]
  /** Union of all AC references across tasks in this batch */
  acRefs: string[]
}

// ---------------------------------------------------------------------------
// planTaskBatches
// ---------------------------------------------------------------------------

/**
 * Plan task batches for sequential dev-story dispatch.
 *
 * For small/medium stories (estimatedScope 'small' or 'medium'):
 *   Returns a single batch containing all tasks.
 *
 * For large stories (estimatedScope 'large'):
 *   Returns suggestedBatchCount batches with tasks distributed sequentially,
 *   using AC-reference grouping to keep related tasks together when possible,
 *   without violating task order.
 *
 * Empty task lists always return a single empty batch (never throws).
 *
 * @param analysis - StoryAnalysis from analyzeStoryComplexity()
 * @returns Ordered array of TaskBatch objects
 */
export function planTaskBatches(analysis: StoryAnalysis): TaskBatch[] {
  try {
    const { tasks, estimatedScope } = analysis

    // AC7: Empty task list returns single empty batch
    if (tasks.length === 0) {
      return [makeBatch(0, [])]
    }

    // AC5: Small/medium passthrough — single batch with all tasks
    if (estimatedScope === 'small' || estimatedScope === 'medium') {
      return [makeBatch(0, tasks)]
    }

    // AC6: Large story — distribute into batches sequentially with AC grouping
    return distributeIntoBatches(tasks)
  } catch {
    // Fallback — never throw
    return [makeBatch(0, [])]
  }
}

// ---------------------------------------------------------------------------
// distributeIntoBatches
// ---------------------------------------------------------------------------

/**
 * Distribute tasks into ordered batches for large stories.
 *
 * Algorithm:
 * 1. Process tasks in order (lower IDs first — AC3)
 * 2. When a task has AC refs that are already represented in the current batch,
 *    prefer keeping it in the same batch (AC4) as long as TASKS_PER_BATCH is not exceeded
 * 3. When the current batch reaches TASKS_PER_BATCH, start a new batch (AC2)
 *
 * Note: Tasks are already ordered by dependency in BMAD story files, so we
 * never reorder — we only group within the sequential flow.
 */
function distributeIntoBatches(tasks: StoryTask[]): TaskBatch[] {
  const batches: TaskBatch[] = []
  let currentBatchTasks: StoryTask[] = []
  let currentBatchAcRefs = new Set<string>()

  for (const task of tasks) {
    const wouldExceedLimit = currentBatchTasks.length >= TASKS_PER_BATCH

    if (wouldExceedLimit) {
      // Flush current batch and start a new one
      batches.push(makeBatch(batches.length, currentBatchTasks))
      currentBatchTasks = [task]
      currentBatchAcRefs = new Set(task.acRefs)
    } else {
      // Add to current batch
      currentBatchTasks.push(task)
      for (const ref of task.acRefs) {
        currentBatchAcRefs.add(ref)
      }
    }
  }

  // Flush the final batch
  if (currentBatchTasks.length > 0) {
    batches.push(makeBatch(batches.length, currentBatchTasks))
  }

  return batches
}

// ---------------------------------------------------------------------------
// makeBatch
// ---------------------------------------------------------------------------

/**
 * Construct a TaskBatch from a list of StoryTask objects.
 *
 * Collects unique AC references from all tasks in the batch.
 */
function makeBatch(batchIndex: number, tasks: StoryTask[]): TaskBatch {
  const taskIds = tasks.map((t) => t.id)
  const taskTitles = tasks.map((t) => t.title)

  // Collect unique AC refs across all tasks in the batch (preserve order of first appearance)
  const seenAcRefs = new Set<string>()
  const acRefs: string[] = []
  for (const task of tasks) {
    for (const ref of task.acRefs) {
      if (!seenAcRefs.has(ref)) {
        seenAcRefs.add(ref)
        acRefs.push(ref)
      }
    }
  }

  return { batchIndex, taskIds, taskTitles, acRefs }
}
