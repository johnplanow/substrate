/**
 * Story complexity scorer for dynamic turn limit computation.
 *
 * Parses a story markdown file to estimate implementation complexity based on:
 *  - Top-level task count (`- [ ] Task N:` lines)
 *  - Subtask count (nested `  - [ ]` lines)
 *  - File count (lines in the File Layout fenced code block matching common extensions)
 *
 * The scorer is a pure function on markdown content — no filesystem or git access needed.
 *
 * Score formula: taskCount + (subtaskCount * 0.5) + (fileCount * 0.5), rounded to nearest int.
 *
 * Turn limit scaling:
 *  - dev-story:  base 75, +10/point above 10, cap 200
 *  - fix-story:  base 50, +10/point above 10, cap 150
 */

import { createLogger } from '../../utils/logger.js'

const logger = createLogger('compiled-workflows:story-complexity')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Breakdown of story complexity components.
 */
export interface StoryComplexity {
  /** Number of top-level task lines matching `- [ ] Task N:` */
  taskCount: number
  /** Number of nested subtask lines matching indented `- [ ]` */
  subtaskCount: number
  /** Number of file entries in the File Layout fenced code block */
  fileCount: number
  /** Aggregate complexity score (rounded) */
  complexityScore: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a complexity score from story markdown content.
 *
 * Returns { taskCount, subtaskCount, fileCount, complexityScore }.
 * All counts default to 0 when the corresponding sections are absent.
 *
 * @param storyContent - Raw markdown content of the story file
 */
export function computeStoryComplexity(storyContent: string): StoryComplexity {
  const taskCount = countTopLevelTasks(storyContent)
  const subtaskCount = countSubtasks(storyContent)
  const fileCount = countFilesInLayout(storyContent)

  const complexityScore = Math.round(taskCount + subtaskCount * 0.5 + fileCount * 0.5)

  return { taskCount, subtaskCount, fileCount, complexityScore }
}

/**
 * Compute the resolved maxTurns for a dev-story dispatch.
 *
 * base 75 turns for score <= 10, +10 turns per additional complexity point, capped at 200.
 *
 * @param complexityScore - Score returned by computeStoryComplexity
 */
export function resolveDevStoryMaxTurns(complexityScore: number): number {
  return Math.min(200, 75 + Math.max(0, complexityScore - 10) * 10)
}

/**
 * Compute the resolved maxTurns for a fix-story (major-rework) dispatch.
 *
 * base 50 turns for score <= 10, +10 turns per additional complexity point, capped at 150.
 *
 * @param complexityScore - Score returned by computeStoryComplexity
 */
export function resolveFixStoryMaxTurns(complexityScore: number): number {
  return Math.min(150, 50 + Math.max(0, complexityScore - 10) * 10)
}

/**
 * Log the complexity result at info level.
 *
 * Emits a structured log with storyKey, taskCount, subtaskCount, fileCount,
 * complexityScore, and resolvedMaxTurns so operators can observe turn-limit scaling.
 *
 * @param storyKey - Story identifier (e.g. "24-6")
 * @param complexity - Result from computeStoryComplexity
 * @param resolvedMaxTurns - Turn limit resolved for this dispatch
 */
export function logComplexityResult(
  storyKey: string,
  complexity: StoryComplexity,
  resolvedMaxTurns: number
): void {
  logger.info(
    {
      storyKey,
      taskCount: complexity.taskCount,
      subtaskCount: complexity.subtaskCount,
      fileCount: complexity.fileCount,
      complexityScore: complexity.complexityScore,
      resolvedMaxTurns,
    },
    'Story complexity computed'
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count top-level task lines matching `- [ ] Task N:` (with literal "Task" keyword).
 */
function countTopLevelTasks(content: string): number {
  const taskPattern = /^- \[ \] Task \d+:/gm
  return (content.match(taskPattern) ?? []).length
}

/**
 * Count nested subtask lines — `- [ ]` lines that begin with one or more spaces or tabs.
 *
 * IMPORTANT: Use `[ \t]+` (space/tab only), NOT `\s+`, because `\s` includes `\n`.
 * With multiline `/gm`, using `\s+` causes false matches when an empty line (`\n`)
 * precedes a top-level `- [ ]` line — the `\n` gets consumed as "whitespace".
 */
function countSubtasks(content: string): number {
  // Use [ \t]+ (space or tab only) to avoid matching \n as leading whitespace
  const subtaskPattern = /^[ \t]+- \[ \]/gm
  return (content.match(subtaskPattern) ?? []).length
}

/**
 * Count file entries inside a "File Layout" fenced code block.
 *
 * Uses a split-based section extraction to avoid regex lazy-matching pitfalls.
 * Finds a heading containing "File Layout", extracts section content up to the
 * next heading (or end of string), then finds fenced code blocks within it.
 *
 * Returns 0 when no File Layout section or fenced code block is found.
 */
function countFilesInLayout(content: string): number {
  // Find the File Layout section heading (## File Layout, ### File Layout, etc.)
  const headingMatch = content.match(/^#{2,4}\s+File\s+Layout\s*$/im)
  if (!headingMatch || headingMatch.index === undefined) return 0

  // Extract everything after the heading line
  const afterHeading = content.slice(headingMatch.index + headingMatch[0].length)

  // Find the next heading at the same or higher level, or use entire remaining content
  const nextHeadingMatch = afterHeading.match(/^#{2,4}\s+/m)
  const sectionContent =
    nextHeadingMatch?.index !== undefined
      ? afterHeading.slice(0, nextHeadingMatch.index)
      : afterHeading

  // Find fenced code blocks within the section
  const codeBlocks = sectionContent.match(/```[\s\S]*?```/g)
  if (!codeBlocks) return 0

  const fileExtPattern = /\.(ts|js|json|sql|yaml|yml|md)\b/
  let count = 0

  for (const block of codeBlocks) {
    const lines = block.split('\n')
    for (const line of lines) {
      // Skip fence markers
      if (line.trimStart().startsWith('```')) continue
      if (fileExtPattern.test(line)) {
        count++
      }
    }
  }

  return count
}
