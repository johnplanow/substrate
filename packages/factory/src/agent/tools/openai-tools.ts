/**
 * OpenAI-specific tools: apply_patch (v4a format patch application).
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolDefinition, ExecutionEnvironment } from './types.js'

/**
 * Creates the apply_patch tool used by OpenAI models.
 * Accepts v4a-format patch strings.
 */
export function createApplyPatchTool(): ToolDefinition<{ patch: string }> {
  return {
    name: 'apply_patch',
    description:
      'Apply a v4a-format patch to modify files. ' +
      'Format: *** Begin Patch\\n*** Update File: <path>\\n@@ <context>\\n-<removed line>\\n+<added line>\\n*** End Patch',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description:
            'v4a format patch string. Uses *** Begin Patch / *** End Patch delimiters, ' +
            '*** Update File: <path> or *** Add File: <path> headers, ' +
            '@@ hunk markers, and -/+ diff lines.',
        },
      },
      required: ['patch'],
    },
    async executor(args, env: ExecutionEnvironment) {
      return applyV4aPatch(args.patch, env.workdir)
    },
  }
}

/**
 * Applies a v4a-format patch string to the filesystem.
 * Exported as a pure helper for independent testing.
 */
export async function applyV4aPatch(patch: string, workdir: string): Promise<string> {
  // Verify delimiters
  if (!patch.includes('*** Begin Patch')) {
    throw new Error('Malformed patch: missing *** Begin Patch delimiter')
  }
  if (!patch.includes('*** End Patch')) {
    throw new Error('Malformed patch: missing *** End Patch delimiter')
  }

  const lines = patch.split('\n')
  const changedFiles: string[] = []

  let i = 0

  // Skip to Begin Patch
  while (i < lines.length && !(lines[i] ?? '').includes('*** Begin Patch')) {
    i++
  }
  i++ // skip *** Begin Patch line

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.includes('*** End Patch')) {
      break
    }

    if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim()
      const absPath = join(workdir, filePath)
      i++
      i = await applyUpdateBlock(lines, i, absPath)
      changedFiles.push(filePath)
    } else if (line.startsWith('*** Add File: ')) {
      const filePath = line.slice('*** Add File: '.length).trim()
      const absPath = join(workdir, filePath)
      i++
      i = await applyAddBlock(lines, i, absPath)
      changedFiles.push(filePath)
    } else {
      i++
    }
  }

  if (changedFiles.length === 0) {
    throw new Error('Malformed patch: no file operations found')
  }

  return `Applied patch to: ${changedFiles.join(', ')}`
}

/**
 * Apply an update block (hunks with +/- lines) to an existing file.
 * Returns the next line index after the block.
 */
async function applyUpdateBlock(lines: string[], startIdx: number, absPath: string): Promise<number> {
  let content: string
  try {
    content = await readFile(absPath, 'utf-8')
  } catch {
    throw new Error(`File not found: ${absPath}`)
  }

  const contentLines = content.split('\n')
  let i = startIdx

  // Process hunks until we hit next file block or End Patch
  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.includes('*** End Patch')
    ) {
      break
    }

    if (line.startsWith('@@')) {
      i++
      // Collect hunk lines
      const removals: string[] = []
      const additions: string[] = []
      const context: string[] = []

      while (i < lines.length) {
        const hunkLine = lines[i] ?? ''
        if (
          hunkLine.startsWith('@@') ||
          hunkLine.startsWith('*** Update File: ') ||
          hunkLine.startsWith('*** Add File: ') ||
          hunkLine.includes('*** End Patch')
        ) {
          break
        }

        if (hunkLine.startsWith('-')) {
          removals.push(hunkLine.slice(1))
        } else if (hunkLine.startsWith('+')) {
          additions.push(hunkLine.slice(1))
        } else {
          // Context line (may start with ' ' or be bare)
          context.push(hunkLine.startsWith(' ') ? hunkLine.slice(1) : hunkLine)
        }
        i++
      }

      // Apply this hunk: find the removal lines in contentLines and replace
      if (removals.length > 0) {
        applyHunk(contentLines, removals, additions, context)
      } else if (additions.length > 0) {
        // Pure addition — find context and insert after
        applyAdditionHunk(contentLines, additions, context)
      }
    } else {
      i++
    }
  }

  await writeFile(absPath, contentLines.join('\n'), 'utf-8')
  return i
}

/**
 * Apply a hunk with removals to contentLines (in-place mutation).
 */
function applyHunk(contentLines: string[], removals: string[], additions: string[], _context: string[]): void {
  // Find the first removal line in contentLines
  const firstRemoval = removals[0] ?? ''
  const startIdx = contentLines.findIndex(l => l === firstRemoval)
  if (startIdx === -1) {
    // Try to find by trimmed match
    const trimIdx = contentLines.findIndex(l => l.trim() === firstRemoval.trim())
    if (trimIdx === -1) return // can't apply, skip
    contentLines.splice(trimIdx, removals.length, ...additions)
    return
  }
  contentLines.splice(startIdx, removals.length, ...additions)
}

/**
 * Apply a pure addition hunk (no removals) — insert after context.
 */
function applyAdditionHunk(contentLines: string[], additions: string[], context: string[]): void {
  if (context.length === 0) {
    contentLines.push(...additions)
    return
  }
  const lastCtx = context[context.length - 1] ?? ''
  // findLastIndex is ES2023+; use a manual reverse search for ES2022 compatibility
  let idx = -1
  for (let j = contentLines.length - 1; j >= 0; j--) {
    if (contentLines[j] === lastCtx) {
      idx = j
      break
    }
  }
  if (idx === -1) {
    contentLines.push(...additions)
    return
  }
  contentLines.splice(idx + 1, 0, ...additions)
}

/**
 * Apply an add block (new file creation) from patch lines.
 * Returns the next line index after the block.
 */
async function applyAddBlock(lines: string[], startIdx: number, absPath: string): Promise<number> {
  let i = startIdx
  const fileLines: string[] = []

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.includes('*** End Patch')
    ) {
      break
    }
    if (line.startsWith('+')) {
      fileLines.push(line.slice(1))
    }
    i++
  }

  await mkdir(dirname(absPath), { recursive: true })
  await writeFile(absPath, fileLines.join('\n'), 'utf-8')
  return i
}
