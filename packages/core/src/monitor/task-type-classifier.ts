/**
 * TaskTypeClassifier — heuristic-based classification of task types.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { ILogger } from '../dispatch/types.js'

// ---------------------------------------------------------------------------
// Default taxonomy
// ---------------------------------------------------------------------------

export const DEFAULT_TAXONOMY: Record<string, string[]> = {
  testing: ['test', 'tests', 'spec', 'assert', 'verify', 'validate', 'coverage', 'e2e', 'unit', 'integration'],
  debugging: ['fix', 'debug', 'resolve', 'patch', 'hotfix', 'bug', 'crash', 'error', 'issue'],
  refactoring: ['refactor', 'restructure', 'reorganize', 'cleanup', 'optimize', 'clean', 'improve'],
  docs: ['document', 'readme', 'jsdoc', 'comment', 'guide', 'tutorial', 'wiki', 'docstring'],
  api: ['endpoint', 'route', 'controller', 'rest', 'graphql', 'api', 'request'],
  database: ['migration', 'schema', 'model', 'query', 'database', 'sql', 'table', 'index', 'view'],
  ui: ['component', 'page', 'layout', 'style', 'css', 'frontend', 'ui', 'dom'],
  devops: ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'infra', 'config'],
  coding: ['implement', 'create', 'build', 'add', 'write', 'develop', 'feature', 'new'],
}

// ---------------------------------------------------------------------------
// TaskTypeClassifier
// ---------------------------------------------------------------------------

export class TaskTypeClassifier {
  private _taxonomy: Record<string, string[]>
  private readonly _logger: ILogger

  constructor(customTaxonomy?: Record<string, string[]>, logger?: ILogger) {
    this._logger = logger ?? console
    if (customTaxonomy && Object.keys(customTaxonomy).length > 0) {
      this._taxonomy = customTaxonomy
      this._logger.debug('Using custom taxonomy')
    } else {
      this._taxonomy = DEFAULT_TAXONOMY
    }
  }

  setTaxonomy(taxonomy: Record<string, string[]>): void {
    this._taxonomy = taxonomy
    this._logger.debug('Taxonomy updated')
  }

  classify(task: { taskType?: string; title?: string; description?: string }): string {
    if (task.taskType && task.taskType.trim().length > 0) {
      return task.taskType.trim()
    }

    const text = [task.title ?? '', task.description ?? ''].join(' ').toLowerCase()

    if (text.trim().length === 0) {
      this._logger.debug('No text for classification — defaulting to "coding"')
      return 'coding'
    }

    for (const [taskType, keywords] of Object.entries(this._taxonomy)) {
      for (const keyword of keywords) {
        const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(`\\b${escaped}\\b`)
        if (pattern.test(text)) {
          this._logger.debug(`Heuristic match: ${taskType} (keyword: ${keyword})`)
          return taskType
        }
      }
    }

    this._logger.debug('No keyword match — defaulting to "coding"')
    return 'coding'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskTypeClassifier(
  customTaxonomy?: Record<string, string[]>,
  logger?: ILogger,
): TaskTypeClassifier {
  return new TaskTypeClassifier(customTaxonomy, logger)
}
