/**
 * Validation Level 0 — Structural Output Validation.
 *
 * Checks agent outputs against their Zod schemas and verifies required
 * files exist on disk. Uses only synchronous in-process operations
 * (Zod parse + existsSync) to stay well under 100ms.
 */

import type { ValidationLevel, LevelResult, LevelFailure, ValidationContext } from '../types.js'
import {
  DevStoryResultSchema,
  CodeReviewResultSchema,
  CreateStoryResultSchema,
} from '../../compiled-workflows/schemas.js'
import { existsSync } from 'node:fs'

type TaskType = 'dev-story' | 'code-review' | 'create-story' | 'unknown'

export class StructuralValidator implements ValidationLevel {
  readonly level = 0
  readonly name = 'structural'

  private _detectTaskType(result: unknown): TaskType {
    if (result === null || typeof result !== 'object') return 'unknown'
    const r = result as Record<string, unknown>
    if ('verdict' in r) return 'code-review'
    if ('ac_met' in r || 'files_modified' in r || 'ac_failures' in r) return 'dev-story'
    if ('story_file' in r || 'story_key' in r || 'story_title' in r) return 'create-story'
    return 'unknown'
  }

  async run(context: ValidationContext): Promise<LevelResult> {
    const failures: LevelFailure[] = []
    const taskType = this._detectTaskType(context.result)

    if (taskType === 'unknown') {
      const keys =
        context.result !== null && typeof context.result === 'object'
          ? Object.keys(context.result as object).join(', ')
          : String(context.result)
      return {
        passed: false,
        failures: [
          {
            category: 'schema',
            description: 'Unable to determine task type from result shape',
            evidence: `Top-level keys: ${keys || '(none)'}`,
          },
        ],
        canAutoRemediate: false,
      }
    }

    const schemaMap = {
      'dev-story': DevStoryResultSchema,
      'code-review': CodeReviewResultSchema,
      'create-story': CreateStoryResultSchema,
    }
    const schema = schemaMap[taskType]
    const parseResult = schema.safeParse(context.result)

    if (!parseResult.success) {
      for (const err of parseResult.error.issues) {
        const loc = err.path.join('.') || '(root)'
        failures.push({
          category: 'schema',
          description: `Schema validation failed at '${loc}': ${err.message}`,
          location: loc,
          evidence: err.message,
        })
      }
      return {
        passed: false,
        failures,
        canAutoRemediate: true,
      }
    }

    const parsed = parseResult.data

    // AC2: files_modified existence check (dev-story only)
    if (taskType === 'dev-story') {
      const filesModified: string[] = (parsed as { files_modified?: string[] }).files_modified ?? []
      for (const filePath of filesModified) {
        if (!existsSync(filePath)) {
          failures.push({
            category: 'schema',
            description: 'File listed in files_modified does not exist on disk',
            location: filePath,
            evidence: 'existsSync returned false',
          })
        }
      }
    }

    // AC3: story_file existence check (create-story only)
    if (taskType === 'create-story') {
      const storyFile: string | undefined = (parsed as { story_file?: string }).story_file
      if (storyFile && !existsSync(storyFile)) {
        failures.push({
          category: 'schema',
          description: 'Story file not found on disk after create-story dispatch',
          location: storyFile,
          evidence: 'Story file not found on disk',
        })
      }
    }

    return {
      passed: failures.length === 0,
      failures,
      canAutoRemediate: true,
    }
  }
}
