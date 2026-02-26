/**
 * Story Complexity Analyzer for the compiled-workflows module.
 *
 * Parses a BMAD story file content string and extracts structured metadata:
 * AC count, task list (with subtasks and AC references), estimated scope,
 * and suggested batch count.
 *
 * Pure function — no side effects. Accepts file content string, returns analysis object.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of tasks per implementation batch */
export const TASKS_PER_BATCH = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A parsed task from a BMAD story file.
 */
export interface StoryTask {
  /** 1-based task number extracted from the task line */
  id: number
  /** Task title text (after T1:, Task 1:, or similar prefix) */
  title: string
  /** Acceptance criteria references found in the task description */
  acRefs: string[]
  /** Number of indented subtasks under this task */
  subtaskCount: number
  /** Whether the task is already marked complete (- [x]) */
  completed: boolean
}

/**
 * Result object returned by analyzeStoryComplexity().
 */
export interface StoryAnalysis {
  /** Total count of AC patterns (AC1, AC2, ...) in the story */
  acCount: number
  /** Parsed tasks from the Tasks section */
  tasks: StoryTask[]
  /** Total number of tasks */
  taskCount: number
  /** Estimated scope based on task count */
  estimatedScope: 'small' | 'medium' | 'large'
  /** Suggested number of implementation batches */
  suggestedBatchCount: number
}

// ---------------------------------------------------------------------------
// analyzeStoryComplexity
// ---------------------------------------------------------------------------

/**
 * Analyze a BMAD story file content string and return structured metadata.
 *
 * @param storyContent - The full text content of a BMAD story markdown file
 * @param tasksPerBatch - Number of tasks per batch for batch count calculation (default: 5)
 * @returns StoryAnalysis object with extracted metadata
 */
export function analyzeStoryComplexity(
  storyContent: string,
  tasksPerBatch: number = TASKS_PER_BATCH,
): StoryAnalysis {
  try {
    const acCount = parseAcCount(storyContent)
    const tasks = parseTaskList(storyContent)
    const taskCount = tasks.length
    const estimatedScope = estimateScope(taskCount)
    const suggestedBatchCount = Math.ceil(taskCount / tasksPerBatch)

    return {
      acCount,
      tasks,
      taskCount,
      estimatedScope,
      suggestedBatchCount,
    }
  } catch {
    // AC9: Fallback — never throw
    return {
      acCount: 0,
      tasks: [],
      taskCount: 0,
      estimatedScope: 'small',
      suggestedBatchCount: 1,
    }
  }
}

// ---------------------------------------------------------------------------
// parseAcCount
// ---------------------------------------------------------------------------

/**
 * Count AC patterns in the story content.
 *
 * Handles:
 * - `### AC1:` heading format
 * - `AC1:` inline format in acceptance criteria sections
 * - `**AC1:**` bold format
 *
 * Counts unique AC numbers to avoid double-counting when both formats appear.
 */
function parseAcCount(content: string): number {
  // Match AC followed by one or more digits (case-sensitive, word boundary aware)
  // Patterns: AC1, AC1:, AC1 (as standalone or in headings)
  const acPattern = /\bAC(\d+)\b/g
  const seenNumbers = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = acPattern.exec(content)) !== null) {
    seenNumbers.add(match[1])
  }

  return seenNumbers.size
}

// ---------------------------------------------------------------------------
// parseTaskList
// ---------------------------------------------------------------------------

/**
 * Parse the Tasks section of a BMAD story file.
 *
 * Handles:
 * - `- [ ] T1: title` format
 * - `- [ ] Task 1: title` format
 * - `- [x] T1: title` completed tasks
 * - Indented subtasks (two or more spaces before `- [ ]`)
 * - AC references in task descriptions: `(AC: #1, #3)` or `AC1, AC3`
 */
function parseTaskList(content: string): StoryTask[] {
  const tasks: StoryTask[] = []

  // Find the Tasks section
  const tasksSectionMatch = content.match(/^#{1,3}\s*Tasks?\b.*$/im)
  if (!tasksSectionMatch) {
    return []
  }

  // Extract the Tasks section content (from "## Tasks" to the next top-level heading or end)
  const tasksSectionStart = tasksSectionMatch.index! + tasksSectionMatch[0].length
  const afterTasksSection = content.slice(tasksSectionStart)

  // Find the next heading of the same or higher level that is NOT a subtask heading
  // Stop at the next ## or # heading (but allow ### within tasks section)
  const nextSectionMatch = afterTasksSection.match(/^#{1,2}\s+\S/m)
  const tasksSectionContent = nextSectionMatch
    ? afterTasksSection.slice(0, nextSectionMatch.index)
    : afterTasksSection

  // Split into lines for processing
  const lines = tasksSectionContent.split('\n')

  // Regex patterns for task items
  const subtaskPattern = /^[ \t]{2,}[-*]\s+\[([ xX])\]/

  // Pattern 1: - [ ] T1: title  or  - [x] T1: title
  const namedTaskPattern = /^[-*]\s+\[([ xX])\]\s+(?:T(\d+)|Task\s+(\d+))[:\s]\s*(.*)/
  // Pattern 2: - [ ] generic task (no T/Task prefix)
  const genericTaskPattern = /^[-*]\s+\[([ xX])\]\s+(?!T\d+\b|Task\s+\d+\b)(.*)/

  let currentTask: StoryTask | null = null
  let taskIdCounter = 0

  for (const line of lines) {
    // Check if this is an indented subtask line
    if (subtaskPattern.test(line) && currentTask !== null) {
      currentTask.subtaskCount++
      continue
    }

    // Try named task pattern (T1:, Task 1:)
    const namedMatch = line.match(namedTaskPattern)
    if (namedMatch) {
      // Finalize previous task
      if (currentTask) {
        tasks.push(currentTask)
      }

      const checkboxChar = namedMatch[1]
      const tNum = namedMatch[2] // from "T1"
      const taskNum = namedMatch[3] // from "Task 1"
      const rawTitle = namedMatch[4] || ''
      const taskNumber = tNum ? parseInt(tNum, 10) : taskNum ? parseInt(taskNum, 10) : ++taskIdCounter

      currentTask = {
        id: taskNumber,
        title: rawTitle.trim(),
        acRefs: extractAcRefs(rawTitle),
        subtaskCount: 0,
        completed: checkboxChar === 'x' || checkboxChar === 'X',
      }
      continue
    }

    // Try generic task pattern (- [ ] some task without T/Task prefix)
    const genericMatch = line.match(genericTaskPattern)
    if (genericMatch) {
      // Finalize previous task
      if (currentTask) {
        tasks.push(currentTask)
      }

      const checkboxChar = genericMatch[1]
      const rawTitle = genericMatch[2] || ''
      taskIdCounter++

      currentTask = {
        id: taskIdCounter,
        title: rawTitle.trim(),
        acRefs: extractAcRefs(rawTitle),
        subtaskCount: 0,
        completed: checkboxChar === 'x' || checkboxChar === 'X',
      }
      continue
    }

    // Non-task line — if we have a current task, continue accumulating subtasks
    // (subtasks already handled above)
  }

  // Push the last task
  if (currentTask) {
    tasks.push(currentTask)
  }

  return tasks
}

// ---------------------------------------------------------------------------
// extractAcRefs
// ---------------------------------------------------------------------------

/**
 * Extract AC references from a task description string.
 *
 * Handles formats:
 * - `(AC: #1, #3)` → ['AC1', 'AC3']
 * - `AC1, AC3` → ['AC1', 'AC3']
 * - `(AC1)` → ['AC1']
 */
function extractAcRefs(text: string): string[] {
  const refs: string[] = []

  // Pattern 1: (AC: #1, #3) or (AC: 1, 3)
  const acColonPattern = /\(AC:\s*((?:#?\d+\s*,?\s*)+)\)/gi
  let match: RegExpExecArray | null

  while ((match = acColonPattern.exec(text)) !== null) {
    const numPart = match[1]
    const nums = numPart.match(/\d+/g) ?? []
    for (const n of nums) {
      refs.push(`AC${n}`)
    }
  }

  // Pattern 2: standalone AC\d+ references (e.g., AC1, AC3 in text)
  const acStandalonePattern = /\bAC(\d+)\b/g
  while ((match = acStandalonePattern.exec(text)) !== null) {
    const ref = `AC${match[1]}`
    if (!refs.includes(ref)) {
      refs.push(ref)
    }
  }

  return refs
}

// ---------------------------------------------------------------------------
// estimateScope
// ---------------------------------------------------------------------------

/**
 * Estimate implementation scope based on task count.
 *
 * - small: 0-5 tasks
 * - medium: 6-9 tasks
 * - large: 10+ tasks
 */
function estimateScope(taskCount: number): 'small' | 'medium' | 'large' {
  if (taskCount >= 10) return 'large'
  if (taskCount >= 6) return 'medium'
  return 'small'
}
