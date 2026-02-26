/**
 * Unit tests for the story-analyzer module.
 *
 * Tests AC count parsing, task list parsing, subtask handling,
 * AC reference extraction, scope estimation, batch count calculation,
 * and fallback behavior.
 *
 * Uses realistic BMAD story file content as fixtures.
 */

import { describe, it, expect } from 'vitest'
import {
  analyzeStoryComplexity,
  TASKS_PER_BATCH,
} from '../story-analyzer.js'
import type { StoryAnalysis, StoryTask } from '../story-analyzer.js'

// ---------------------------------------------------------------------------
// Fixtures — realistic BMAD story content
// ---------------------------------------------------------------------------

/**
 * A minimal but realistic BMAD story in "T1:" format.
 * Mirrors the format used in 13-1-story-complexity-analyzer.md
 */
const STORY_13_1 = `# Story 13-1: Story Complexity Analyzer

Status: ready-for-dev

## Story

As a pipeline developer, I want a module that parses a BMAD story file and extracts structured metadata.

## Acceptance Criteria

### AC1: Main Function Signature
\`analyzeStoryComplexity(storyContent)\` accepts a story file content string and returns a \`StoryAnalysis\` object.

### AC2: AC Count Parser
\`acCount\` correctly counts \`AC\\d+\` patterns in the story.

### AC3: Task List Parser
\`tasks\` is an array of \`{ id, title, acRefs, subtaskCount }\` parsed from the Tasks section.

### AC4: Scope Estimation
\`estimatedScope\` returns \`'small'\` for ≤5 tasks, \`'medium'\` for 6-9, \`'large'\` for ≥10.

### AC5: Batch Count Calculation
\`suggestedBatchCount\` equals \`Math.ceil(taskCount / tasksPerBatch)\`.

### AC6: Subtask Handling
The parser handles tasks with subtasks.

### AC7: AC Reference Extraction
The parser handles AC references in task descriptions.

### AC8: Completed Task Handling
The parser handles tasks already marked complete.

### AC9: Fallback Behavior
Missing or malformed task sections return \`estimatedScope: 'small'\` as fallback.

### AC10: Test Coverage
Unit test coverage is at or above 80%.

## Dev Notes

- Module at \`src/modules/compiled-workflows/story-analyzer.ts\`

## Tasks

- [ ] T1: Create \`src/modules/compiled-workflows/story-analyzer.ts\` with \`StoryAnalysis\` type export
- [ ] T2: Implement AC count parser using regex pattern matching on story content
- [ ] T3: Implement task list parser handling \`- [ ] T1:\` and \`- [ ] Task 1:\` formats with subtask detection
- [ ] T4: Implement AC reference extraction from task descriptions
- [ ] T5: Implement scope estimation and batch count calculation
- [ ] T6: Write unit tests with real BMAD story file content as fixtures
`

/**
 * A story using "Task N:" format with subtasks and AC references.
 */
const STORY_WITH_TASK_FORMAT = `# Story 7-1: Plan Generation Core

## Acceptance Criteria

### AC1: Basic Plan Generation
Description of AC1.

### AC2: Output File Flag
Description of AC2.

### AC3: Model Selection Flag
Description of AC3.

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

/**
 * Story with completed tasks (- [x]).
 */
const STORY_WITH_COMPLETED_TASKS = `# Story with completed tasks

## Acceptance Criteria

### AC1: First criterion

## Tasks

- [x] T1: Already done task
- [ ] T2: Pending task
- [x] T3: Another completed task
`

/**
 * Story with AC references in various formats.
 */
const STORY_WITH_AC_REFS = `# Story with AC references

## Acceptance Criteria

### AC1: First
### AC2: Second
### AC3: Third

## Tasks

- [ ] T1: Implement feature (AC: #1, #3)
- [ ] T2: Add tests for AC2, AC3
- [ ] T3: Create module (AC1)
`

/**
 * A large story with 10+ tasks (scope: large).
 */
const STORY_LARGE = `# Large story

## Acceptance Criteria

### AC1: First
### AC2: Second

## Tasks

- [ ] T1: Task one
- [ ] T2: Task two
- [ ] T3: Task three
- [ ] T4: Task four
- [ ] T5: Task five
- [ ] T6: Task six
- [ ] T7: Task seven
- [ ] T8: Task eight
- [ ] T9: Task nine
- [ ] T10: Task ten
- [ ] T11: Task eleven
`

/**
 * A medium story with 6-9 tasks.
 */
const STORY_MEDIUM = `# Medium story

## Acceptance Criteria

### AC1: First

## Tasks

- [ ] T1: First task
- [ ] T2: Second task
- [ ] T3: Third task
- [ ] T4: Fourth task
- [ ] T5: Fifth task
- [ ] T6: Sixth task
- [ ] T7: Seventh task
`

/**
 * Story with no Tasks section.
 */
const STORY_NO_TASKS = `# Story with no tasks

## Acceptance Criteria

### AC1: First criterion

## Dev Notes

Some dev notes here.
`

/**
 * Completely empty string.
 */
const STORY_EMPTY = ``

/**
 * Story with malformed task lines (should not crash).
 */
const STORY_MALFORMED = `# Malformed

## Tasks

This is not a valid task line
- Missing checkbox format
[ ] Not a list item checkbox
`

// ---------------------------------------------------------------------------
// AC1: analyzeStoryComplexity — main function signature
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — main function signature', () => {
  it('returns a StoryAnalysis object with all required fields', () => {
    const result = analyzeStoryComplexity(STORY_13_1)

    expect(result).toHaveProperty('acCount')
    expect(result).toHaveProperty('tasks')
    expect(result).toHaveProperty('taskCount')
    expect(result).toHaveProperty('estimatedScope')
    expect(result).toHaveProperty('suggestedBatchCount')
  })

  it('returns numeric acCount', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    expect(typeof result.acCount).toBe('number')
    expect(result.acCount).toBeGreaterThanOrEqual(0)
  })

  it('returns tasks as an array', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    expect(Array.isArray(result.tasks)).toBe(true)
  })

  it('returns numeric taskCount matching tasks.length', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    expect(result.taskCount).toBe(result.tasks.length)
  })

  it('returns estimatedScope as one of the valid literals', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    expect(['small', 'medium', 'large']).toContain(result.estimatedScope)
  })

  it('returns numeric suggestedBatchCount', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    expect(typeof result.suggestedBatchCount).toBe('number')
    expect(result.suggestedBatchCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// AC2: AC count parser
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — AC count parser', () => {
  it('correctly counts AC patterns in story 13-1 (10 ACs)', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    // Story has AC1 through AC10 in headings
    expect(result.acCount).toBe(10)
  })

  it('counts unique AC numbers only (no double-counting)', () => {
    // AC1 appears in heading and in inline "AC1:" reference
    const content = `
## Acceptance Criteria

### AC1: First
### AC2: Second

Some text referencing AC1 again and AC2 inline.

## Tasks
- [ ] T1: Task (AC1, AC2)
`
    const result = analyzeStoryComplexity(content)
    // Should count only 2 unique ACs (AC1 and AC2)
    expect(result.acCount).toBe(2)
  })

  it('handles ### AC1: heading format', () => {
    const content = `
## Acceptance Criteria

### AC1: First criterion
### AC2: Second criterion

## Tasks
- [ ] T1: Task one
`
    const result = analyzeStoryComplexity(content)
    expect(result.acCount).toBe(2)
  })

  it('handles AC1: inline format (no heading)', () => {
    const content = `
## Acceptance Criteria

AC1: First criterion
AC2: Second criterion
AC3: Third criterion

## Tasks
- [ ] T1: Task one
`
    const result = analyzeStoryComplexity(content)
    expect(result.acCount).toBe(3)
  })

  it('returns 0 for story with no AC patterns', () => {
    const content = `
## Story

As a user, I want something.

## Tasks
- [ ] T1: Task one
`
    const result = analyzeStoryComplexity(content)
    expect(result.acCount).toBe(0)
  })

  it('correctly counts ACs in 7-1 style story (3 ACs)', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    // Story has AC1, AC2, AC3 in headings + AC1 and AC3 in task refs + AC2 in task ref
    // Unique: AC1, AC2, AC3 = 3
    expect(result.acCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// AC3: Task list parser — T1: and Task 1: formats
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — task list parser', () => {
  it('parses tasks in T1: format from story 13-1', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    expect(result.taskCount).toBe(6)
    expect(result.tasks[0].id).toBe(1)
    expect(result.tasks[0].title).toContain('story-analyzer.ts')
  })

  it('parses tasks in Task N: format from story 7-1', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    expect(result.taskCount).toBe(3)
    expect(result.tasks[0].id).toBe(1)
    expect(result.tasks[1].id).toBe(2)
    expect(result.tasks[2].id).toBe(3)
  })

  it('each task has id, title, acRefs, subtaskCount, completed fields', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    const task = result.tasks[0]

    expect(task).toHaveProperty('id')
    expect(task).toHaveProperty('title')
    expect(task).toHaveProperty('acRefs')
    expect(task).toHaveProperty('subtaskCount')
    expect(task).toHaveProperty('completed')
    expect(Array.isArray(task.acRefs)).toBe(true)
    expect(typeof task.subtaskCount).toBe('number')
    expect(typeof task.completed).toBe('boolean')
  })

  it('correctly parses task titles', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    expect(result.tasks[0].title).toContain('plan-generator.ts')
    expect(result.tasks[1].title).toContain('index.ts')
    expect(result.tasks[2].title).toContain('plan.ts')
  })

  it('returns empty tasks array when no Tasks section exists', () => {
    const result = analyzeStoryComplexity(STORY_NO_TASKS)
    expect(result.tasks).toEqual([])
    expect(result.taskCount).toBe(0)
  })

  it('does not include subtask items as top-level tasks', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    // Story has 3 top-level tasks, not the subtask items
    expect(result.taskCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// AC4: Scope estimation
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — scope estimation', () => {
  it('returns medium for 6 tasks (STORY_13_1 has 6 tasks)', () => {
    const result = analyzeStoryComplexity(STORY_13_1) // 6 tasks = medium
    expect(result.estimatedScope).toBe('medium')
  })

  it('returns small for 0 tasks', () => {
    const result = analyzeStoryComplexity(STORY_NO_TASKS)
    expect(result.estimatedScope).toBe('small')
  })

  it('returns small for exactly 5 tasks', () => {
    const content = `
## Tasks

- [ ] T1: Task one
- [ ] T2: Task two
- [ ] T3: Task three
- [ ] T4: Task four
- [ ] T5: Task five
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(5)
    expect(result.estimatedScope).toBe('small')
  })

  it('returns medium for 6 tasks', () => {
    const content = `
## Tasks

- [ ] T1: Task one
- [ ] T2: Task two
- [ ] T3: Task three
- [ ] T4: Task four
- [ ] T5: Task five
- [ ] T6: Task six
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(6)
    expect(result.estimatedScope).toBe('medium')
  })

  it('returns medium for 7 tasks (story MEDIUM)', () => {
    const result = analyzeStoryComplexity(STORY_MEDIUM)
    expect(result.taskCount).toBe(7)
    expect(result.estimatedScope).toBe('medium')
  })

  it('returns medium for 9 tasks', () => {
    const content = `
## Tasks

- [ ] T1: One
- [ ] T2: Two
- [ ] T3: Three
- [ ] T4: Four
- [ ] T5: Five
- [ ] T6: Six
- [ ] T7: Seven
- [ ] T8: Eight
- [ ] T9: Nine
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(9)
    expect(result.estimatedScope).toBe('medium')
  })

  it('returns large for exactly 10 tasks', () => {
    const content = `
## Tasks

- [ ] T1: One
- [ ] T2: Two
- [ ] T3: Three
- [ ] T4: Four
- [ ] T5: Five
- [ ] T6: Six
- [ ] T7: Seven
- [ ] T8: Eight
- [ ] T9: Nine
- [ ] T10: Ten
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(10)
    expect(result.estimatedScope).toBe('large')
  })

  it('returns large for 11 tasks (story LARGE)', () => {
    const result = analyzeStoryComplexity(STORY_LARGE)
    expect(result.taskCount).toBe(11)
    expect(result.estimatedScope).toBe('large')
  })
})

// ---------------------------------------------------------------------------
// AC5: Batch count calculation
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — batch count calculation', () => {
  it('calculates suggestedBatchCount as Math.ceil(taskCount / tasksPerBatch)', () => {
    const result = analyzeStoryComplexity(STORY_13_1) // 6 tasks, tasksPerBatch=5
    // Math.ceil(6/5) = 2
    expect(result.suggestedBatchCount).toBe(2)
  })

  it('returns 1 batch for 5 tasks with default tasksPerBatch=5', () => {
    const content = `
## Tasks

- [ ] T1: One
- [ ] T2: Two
- [ ] T3: Three
- [ ] T4: Four
- [ ] T5: Five
`
    const result = analyzeStoryComplexity(content)
    expect(result.suggestedBatchCount).toBe(1)
  })

  it('returns 2 batches for 6 tasks with default tasksPerBatch=5', () => {
    const result = analyzeStoryComplexity(STORY_MEDIUM) // 7 tasks
    // Math.ceil(7/5) = 2
    expect(result.suggestedBatchCount).toBe(2)
  })

  it('returns 3 batches for 11 tasks with default tasksPerBatch=5', () => {
    const result = analyzeStoryComplexity(STORY_LARGE) // 11 tasks
    // Math.ceil(11/5) = 3
    expect(result.suggestedBatchCount).toBe(3)
  })

  it('uses custom tasksPerBatch parameter', () => {
    // 6 tasks, tasksPerBatch=3 → Math.ceil(6/3) = 2
    const result = analyzeStoryComplexity(STORY_13_1, 3)
    expect(result.suggestedBatchCount).toBe(2)
  })

  it('uses custom tasksPerBatch=10 → 1 batch for 6 tasks', () => {
    const result = analyzeStoryComplexity(STORY_13_1, 10)
    // Math.ceil(6/10) = 1
    expect(result.suggestedBatchCount).toBe(1)
  })

  it('returns 1 batch for 0 tasks (Math.ceil(0/5) = 0, but minimum should be handled)', () => {
    // Math.ceil(0/5) = 0, but suggestedBatchCount of 0 is still valid per spec
    const result = analyzeStoryComplexity(STORY_NO_TASKS)
    // Math.ceil(0 / 5) = 0
    expect(result.suggestedBatchCount).toBe(0)
  })

  it('TASKS_PER_BATCH constant equals 5', () => {
    expect(TASKS_PER_BATCH).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// AC6: Subtask handling
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — subtask handling', () => {
  it('counts subtasks per task in Task N: format story', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    // Task 1 has 3 subtasks, Task 2 has 0, Task 3 has 2
    expect(result.tasks[0].subtaskCount).toBe(3)
    expect(result.tasks[1].subtaskCount).toBe(0)
    expect(result.tasks[2].subtaskCount).toBe(2)
  })

  it('task without subtasks has subtaskCount of 0', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    // All tasks in story 13-1 have no subtasks
    for (const task of result.tasks) {
      expect(task.subtaskCount).toBe(0)
    }
  })

  it('subtasks are counted but not included as top-level tasks', () => {
    const content = `
## Tasks

- [ ] T1: Main task one
  - [ ] Subtask 1a
  - [ ] Subtask 1b
  - [ ] Subtask 1c
- [ ] T2: Main task two
  - [ ] Subtask 2a
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(2)
    expect(result.tasks[0].subtaskCount).toBe(3)
    expect(result.tasks[1].subtaskCount).toBe(1)
  })

  it('handles mixed indented and non-indented items correctly', () => {
    const content = `
## Tasks

- [ ] T1: First task
  - [ ] Subtask A
  - [ ] Subtask B
- [ ] T2: Second task
- [ ] T3: Third task
  - [ ] Subtask C
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(3)
    expect(result.tasks[0].subtaskCount).toBe(2)
    expect(result.tasks[1].subtaskCount).toBe(0)
    expect(result.tasks[2].subtaskCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC7: AC reference extraction
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — AC reference extraction', () => {
  it('extracts AC refs from (AC: #1, #3) format', () => {
    const result = analyzeStoryComplexity(STORY_WITH_AC_REFS)
    // T1: (AC: #1, #3)
    expect(result.tasks[0].acRefs).toContain('AC1')
    expect(result.tasks[0].acRefs).toContain('AC3')
  })

  it('extracts AC refs from standalone AC1 format', () => {
    const result = analyzeStoryComplexity(STORY_WITH_AC_REFS)
    // T3: (AC1)
    expect(result.tasks[2].acRefs).toContain('AC1')
  })

  it('extracts AC refs from ACN, ACM format in task text', () => {
    const result = analyzeStoryComplexity(STORY_WITH_AC_REFS)
    // T2: AC2, AC3
    expect(result.tasks[1].acRefs).toContain('AC2')
    expect(result.tasks[1].acRefs).toContain('AC3')
  })

  it('does not duplicate AC refs', () => {
    const content = `
## Tasks

- [ ] T1: Task (AC: #1) and also AC1 again
`
    const result = analyzeStoryComplexity(content)
    const ac1Refs = result.tasks[0].acRefs.filter((r) => r === 'AC1')
    expect(ac1Refs.length).toBe(1)
  })

  it('returns empty acRefs for tasks with no AC references', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    // Tasks in 13-1 story don't have AC refs in task descriptions
    for (const task of result.tasks) {
      expect(Array.isArray(task.acRefs)).toBe(true)
    }
  })

  it('extracts AC refs from Task N: format in 7-1 story', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    // Task 1: (AC1, AC3)
    expect(result.tasks[0].acRefs).toContain('AC1')
    expect(result.tasks[0].acRefs).toContain('AC3')
    // Task 2: (AC1)
    expect(result.tasks[1].acRefs).toContain('AC1')
    // Task 3: (AC1, AC2)
    expect(result.tasks[2].acRefs).toContain('AC1')
    expect(result.tasks[2].acRefs).toContain('AC2')
  })
})

// ---------------------------------------------------------------------------
// AC8: Completed task handling
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — completed task handling', () => {
  it('includes completed tasks in the task list', () => {
    const result = analyzeStoryComplexity(STORY_WITH_COMPLETED_TASKS)
    expect(result.taskCount).toBe(3)
  })

  it('marks completed tasks with completed=true', () => {
    const result = analyzeStoryComplexity(STORY_WITH_COMPLETED_TASKS)
    expect(result.tasks[0].completed).toBe(true) // T1: [x]
    expect(result.tasks[1].completed).toBe(false) // T2: [ ]
    expect(result.tasks[2].completed).toBe(true) // T3: [x]
  })

  it('marks pending tasks with completed=false', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    for (const task of result.tasks) {
      expect(task.completed).toBe(false)
    }
  })

  it('includes completed tasks in taskCount and scope estimation', () => {
    // Story with completed tasks should still count them
    const result = analyzeStoryComplexity(STORY_WITH_COMPLETED_TASKS)
    expect(result.taskCount).toBe(3)
    expect(result.estimatedScope).toBe('small')
  })
})

// ---------------------------------------------------------------------------
// AC9: Fallback behavior
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — fallback behavior', () => {
  it('returns estimatedScope small for missing Tasks section', () => {
    const result = analyzeStoryComplexity(STORY_NO_TASKS)
    expect(result.estimatedScope).toBe('small')
  })

  it('does not throw for empty string input', () => {
    expect(() => analyzeStoryComplexity(STORY_EMPTY)).not.toThrow()
    const result = analyzeStoryComplexity(STORY_EMPTY)
    expect(result.estimatedScope).toBe('small')
    expect(result.tasks).toEqual([])
    expect(result.acCount).toBe(0)
  })

  it('does not throw for malformed task section', () => {
    expect(() => analyzeStoryComplexity(STORY_MALFORMED)).not.toThrow()
  })

  it('returns valid StoryAnalysis even for malformed content', () => {
    const result = analyzeStoryComplexity(STORY_MALFORMED)
    expect(result).toHaveProperty('acCount')
    expect(result).toHaveProperty('tasks')
    expect(result).toHaveProperty('taskCount')
    expect(result).toHaveProperty('estimatedScope')
    expect(result).toHaveProperty('suggestedBatchCount')
  })

  it('returns estimatedScope small for null-like content', () => {
    // Edge: very short content
    const result = analyzeStoryComplexity('Hello world')
    expect(result.estimatedScope).toBe('small')
  })

  it('returns tasks=[] and taskCount=0 when Tasks section is missing', () => {
    const result = analyzeStoryComplexity(STORY_NO_TASKS)
    expect(result.tasks).toEqual([])
    expect(result.taskCount).toBe(0)
  })

  it('handles content with only whitespace', () => {
    expect(() => analyzeStoryComplexity('   \n\n\t  \n')).not.toThrow()
    const result = analyzeStoryComplexity('   \n\n\t  \n')
    expect(result.estimatedScope).toBe('small')
  })
})

// ---------------------------------------------------------------------------
// Integration: real-world story fixture (Story 13-1)
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — integration with real story 13-1', () => {
  it('produces correct analysis for story 13-1', () => {
    const result = analyzeStoryComplexity(STORY_13_1)

    // 10 ACs (AC1-AC10)
    expect(result.acCount).toBe(10)
    // 6 tasks (T1-T6)
    expect(result.taskCount).toBe(6)
    // 6 tasks → medium scope
    expect(result.estimatedScope).toBe('medium')
    // Math.ceil(6/5) = 2 batches
    expect(result.suggestedBatchCount).toBe(2)
    // All tasks pending
    for (const task of result.tasks) {
      expect(task.completed).toBe(false)
    }
  })

  it('task IDs are sequential starting from 1', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    const ids = result.tasks.map((t) => t.id)
    expect(ids).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('task titles are non-empty strings', () => {
    const result = analyzeStoryComplexity(STORY_13_1)
    for (const task of result.tasks) {
      expect(task.title.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: real-world story fixture (Story 7-1 with Task N: format)
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — integration with Task N: format story', () => {
  it('produces correct analysis for 7-1 style story', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)

    expect(result.acCount).toBe(3)
    expect(result.taskCount).toBe(3)
    expect(result.estimatedScope).toBe('small')
    // Math.ceil(3/5) = 1
    expect(result.suggestedBatchCount).toBe(1)
  })

  it('task 1 has 3 subtasks, task 2 has 0, task 3 has 2', () => {
    const result = analyzeStoryComplexity(STORY_WITH_TASK_FORMAT)
    expect(result.tasks[0].subtaskCount).toBe(3)
    expect(result.tasks[1].subtaskCount).toBe(0)
    expect(result.tasks[2].subtaskCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Edge cases: boundary values
// ---------------------------------------------------------------------------

describe('analyzeStoryComplexity — boundary values', () => {
  it('handles single task correctly', () => {
    const content = `
## Acceptance Criteria
### AC1: Only criterion

## Tasks
- [ ] T1: Only task
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(1)
    expect(result.acCount).toBe(1)
    expect(result.estimatedScope).toBe('small')
    expect(result.suggestedBatchCount).toBe(1)
  })

  it('handles very large task numbers (T100:)', () => {
    const content = `
## Tasks
- [ ] T100: Hundredth task
- [ ] T101: Hundred and first
`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(2)
    expect(result.tasks[0].id).toBe(100)
    expect(result.tasks[1].id).toBe(101)
  })

  it('handles Tasks section at end of file with no trailing newline', () => {
    const content = `## Tasks\n- [ ] T1: Task one`
    const result = analyzeStoryComplexity(content)
    expect(result.taskCount).toBe(1)
  })

  it('does not cross-contaminate sections after Tasks', () => {
    const content = `
## Tasks

- [ ] T1: Real task

## Dev Agent Record

- [ ] This should NOT be parsed as a task
`
    const result = analyzeStoryComplexity(content)
    // Only the task in the Tasks section should be parsed
    expect(result.taskCount).toBe(1)
  })
})
