/**
 * TaskTypeClassifier — heuristic-based classification of task types.
 *
 * Design principles (AC3):
 *  - Zero LLM calls; all classification is keyword-based heuristics
 *  - Case-insensitive keyword matching
 *  - Returns explicit task.taskType if present (no re-classification)
 *  - Falls back to "coding" when no keyword matches
 *  - Supports custom taxonomy override via config
 */

import { createLogger } from '../../utils/logger.js'

const logger = createLogger('monitor:classifier')

// ---------------------------------------------------------------------------
// Default taxonomy
// ---------------------------------------------------------------------------

/**
 * Default keyword taxonomy mapping task type labels to keywords.
 * Keywords are matched case-insensitively against the task title/description.
 */
export const DEFAULT_TAXONOMY: Record<string, string[]> = {
  testing: ['test', 'spec', 'assert', 'verify', 'validate', 'coverage'],
  debugging: ['fix', 'debug', 'resolve', 'patch', 'hotfix', 'bug'],
  refactoring: ['refactor', 'restructure', 'reorganize', 'clean up', 'optimize'],
  docs: ['document', 'readme', 'jsdoc', 'comment', 'guide', 'tutorial'],
  api: ['endpoint', 'route', 'controller', 'rest', 'graphql', 'api'],
  database: ['migration', 'schema', 'model', 'query', 'database', 'sql'],
  ui: ['component', 'page', 'layout', 'style', 'css', 'frontend', 'ui'],
  devops: ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'infra'],
  coding: ['implement', 'create', 'build', 'add', 'write code', 'develop'],
}

// ---------------------------------------------------------------------------
// TaskTypeClassifier
// ---------------------------------------------------------------------------

/**
 * Classifier that maps task descriptions to task type labels using
 * keyword heuristics. No LLM calls are made.
 *
 * @example
 * const classifier = new TaskTypeClassifier()
 * classifier.classify({ taskType: 'testing', title: '...' }) // → 'testing'
 * classifier.classify({ title: 'Fix bug in auth module' })    // → 'debugging'
 * classifier.classify({ title: 'Unknown task' })              // → 'coding'
 */
export class TaskTypeClassifier {
  private readonly _taxonomy: Record<string, string[]>

  constructor(customTaxonomy?: Record<string, string[]>) {
    if (customTaxonomy && Object.keys(customTaxonomy).length > 0) {
      this._taxonomy = customTaxonomy
      logger.debug({ types: Object.keys(customTaxonomy) }, 'Using custom taxonomy')
    } else {
      this._taxonomy = DEFAULT_TAXONOMY
    }
  }

  /**
   * Classify a task into a task type string.
   *
   * Priority:
   *  1. Return explicit `taskType` field if present
   *  2. Heuristic keyword matching against title and description
   *  3. Default fallback: "coding"
   *
   * @param task - Object with optional taskType, title, description fields
   * @returns The task type label (e.g., "coding", "testing", "debugging")
   */
  classify(task: { taskType?: string; title?: string; description?: string }): string {
    // Priority 1: explicit task type
    if (task.taskType && task.taskType.trim().length > 0) {
      return task.taskType.trim()
    }

    // Build text corpus for keyword matching
    const text = [task.title ?? '', task.description ?? ''].join(' ').toLowerCase()

    if (text.trim().length === 0) {
      logger.debug('No text for classification — defaulting to "coding"')
      return 'coding'
    }

    // Priority 2: heuristic keyword matching
    for (const [taskType, keywords] of Object.entries(this._taxonomy)) {
      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) {
          logger.debug({ taskType, keyword }, 'Heuristic match found')
          return taskType
        }
      }
    }

    // Priority 3: fallback
    logger.debug('No keyword match — defaulting to "coding"')
    return 'coding'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TaskTypeClassifier with optional custom taxonomy.
 */
export function createTaskTypeClassifier(
  customTaxonomy?: Record<string, string[]>
): TaskTypeClassifier {
  return new TaskTypeClassifier(customTaxonomy)
}
