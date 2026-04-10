/**
 * Gemini-specific tools: read_many_files, list_dir, and Gemini variant of edit_file.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolDefinition, ExecutionEnvironment } from './types.js'

/**
 * Creates the read_many_files tool for Gemini models.
 * Reads multiple files and returns concatenated content with headers.
 */
export function createReadManyFilesTool(): ToolDefinition<{ paths: string[] }> {
  return {
    name: 'read_many_files',
    description: 'Read multiple files and return their concatenated content with file headers.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file paths to read',
        },
      },
      required: ['paths'],
    },
    outputTruncation: 100_000,
    async executor(args, _env: ExecutionEnvironment) {
      const parts: string[] = []
      for (const filePath of args.paths) {
        try {
          const content = await readFile(filePath, 'utf-8')
          const lines = content.split('\n')
          const numbered = lines
            .map((line, i) => `${String(i + 1).padStart(3)}\t${line}`)
            .join('\n')
          parts.push(`=== ${filePath} ===\n${numbered}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          parts.push(`=== ${filePath} ===\n(error reading file: ${message})`)
        }
      }
      return parts.join('\n\n')
    },
  }
}

/**
 * Creates the list_dir tool for Gemini models.
 * Returns a directory listing with entry types (dirs first, then alpha).
 */
export function createListDirTool(): ToolDefinition<{ path: string }> {
  return {
    name: 'list_dir',
    description:
      'List directory contents with entry types ([DIR] or [FILE]), sorted dirs first then alphabetically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
    async executor(args, _env: ExecutionEnvironment) {
      const entries = await readdir(args.path, { withFileTypes: true })
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => `[DIR] ${e.name}`)
        .sort()
      const files = entries
        .filter((e) => !e.isDirectory())
        .map((e) => `[FILE] ${e.name}`)
        .sort()
      return [...dirs, ...files].join('\n')
    },
  }
}

/**
 * Creates the Gemini variant of edit_file.
 * Uses file_path (instead of path) as the parameter name to match gemini-cli conventions.
 */
export function createGeminiEditFileTool(): ToolDefinition<{
  file_path: string
  old_string: string
  new_string: string
}> {
  return {
    name: 'edit_file',
    description:
      'Edit a file by replacing an exact string. The old_string must appear exactly once in the file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to edit' },
        old_string: {
          type: 'string',
          description: 'Exact string to search for (must be unique in the file)',
        },
        new_string: { type: 'string', description: 'String to replace old_string with' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    async executor(args, _env: ExecutionEnvironment) {
      const content = await readFile(args.file_path, 'utf-8')

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
      await mkdir(dirname(args.file_path), { recursive: true })
      await writeFile(args.file_path, updated, 'utf-8')
      return `Edited ${args.file_path}`
    },
  }
}
