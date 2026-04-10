/**
 * Anthropic-specific tools: edit_file (exact string search-and-replace).
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { readFile, writeFile } from 'node:fs/promises'
import type { ToolDefinition, ExecutionEnvironment } from './types.js'

/**
 * Creates the edit_file tool used by Anthropic (Claude) models.
 * Performs exact string search-and-replace on file contents.
 */
export function createEditFileTool(): ToolDefinition<{
  path: string
  old_string: string
  new_string: string
}> {
  return {
    name: 'edit_file',
    description:
      'Edit a file by replacing an exact string. The old_string must appear exactly once in the file. ' +
      'Provide enough context to uniquely identify the target location.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        old_string: {
          type: 'string',
          description: 'Exact string to search for (must be unique in the file)',
        },
        new_string: { type: 'string', description: 'String to replace old_string with' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async executor(args, _env: ExecutionEnvironment) {
      const content = await readFile(args.path, 'utf-8')

      // Count occurrences
      let count = 0
      let pos = 0
      while ((pos = content.indexOf(args.old_string, pos)) !== -1) {
        count++
        pos += args.old_string.length
      }

      if (count === 0) {
        throw new Error('old_string not found in file')
      }
      if (count > 1) {
        throw new Error(`old_string is ambiguous (found ${count} times)`)
      }

      const updated = content.replace(args.old_string, args.new_string)
      await writeFile(args.path, updated, 'utf-8')
      return `Edited ${args.path}`
    },
  }
}
