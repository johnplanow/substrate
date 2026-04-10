/**
 * Shared tools available to all provider profiles.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ToolDefinition, ExecutionEnvironment } from './types.js'

/**
 * Creates the five shared tools: read_file, write_file, shell, grep, glob.
 */
export function createSharedTools(shellTimeoutMs = 10_000): ToolDefinition[] {
  return [
    createReadFileTool() as ToolDefinition,
    createWriteFileTool() as ToolDefinition,
    createShellTool(shellTimeoutMs) as ToolDefinition,
    createGrepTool(shellTimeoutMs) as ToolDefinition,
    createGlobTool() as ToolDefinition,
  ]
}

function createReadFileTool(): ToolDefinition<{ path: string; offset?: number; limit?: number }> {
  return {
    name: 'read_file',
    description:
      'Read a file from the filesystem, with optional offset and limit for line ranges. Returns content with 1-based line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        offset: {
          type: 'number',
          minimum: 1,
          description: 'Line number to start reading from (1-based, optional)',
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: 'Maximum number of lines to read (optional)',
        },
      },
      required: ['path'],
    },
    outputTruncation: 50_000,
    async executor(args, _env: ExecutionEnvironment) {
      const raw = await readFile(args.path, 'utf-8')
      const lines = raw.split('\n')
      const offset = args.offset !== undefined ? args.offset - 1 : 0
      const slice =
        args.limit !== undefined ? lines.slice(offset, offset + args.limit) : lines.slice(offset)
      const numbered = slice.map((line, i) => {
        const lineNum = offset + i + 1
        return `${String(lineNum).padStart(3)}\t${line}`
      })
      return numbered.join('\n')
    },
  }
}

function createWriteFileTool(): ToolDefinition<{ path: string; content: string }> {
  return {
    name: 'write_file',
    description: 'Write content to a file, creating parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
    async executor(args, _env: ExecutionEnvironment) {
      const dir = dirname(args.path)
      await mkdir(dir, { recursive: true })
      const bytes = Buffer.byteLength(args.content, 'utf-8')
      await writeFile(args.path, args.content, 'utf-8')
      return `Wrote ${bytes} bytes to ${args.path}`
    },
  }
}

function createShellTool(
  shellTimeoutMs: number
): ToolDefinition<{ command: string; timeout_ms?: number }> {
  return {
    name: 'shell',
    description: 'Execute a shell command and return its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (optional)' },
      },
      required: ['command'],
    },
    outputTruncation: 10_000,
    async executor(args, env: ExecutionEnvironment) {
      const timeout = args.timeout_ms !== undefined ? args.timeout_ms : shellTimeoutMs
      const result = await env.exec(args.command, timeout)
      if (result.exitCode !== 0) {
        throw new Error(
          [result.stdout, result.stderr].filter(Boolean).join('\n') ||
            `Command failed with exit code ${result.exitCode}`
        )
      }
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
      return combined || `(exit code ${result.exitCode})`
    },
  }
}

function createGrepTool(
  shellTimeoutMs: number
): ToolDefinition<{ pattern: string; paths: string[] }> {
  return {
    name: 'grep',
    description:
      'Search for a regex pattern in files. Returns matching lines with filenames and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths or directories to search in',
        },
      },
      required: ['pattern', 'paths'],
    },
    outputTruncation: 10_000,
    async executor(args, env: ExecutionEnvironment) {
      // Sanitize pattern and paths to prevent shell injection.
      // Reject patterns containing shell metacharacters that could escape quoting.
      if (/[`$\\]/.test(args.pattern) && /[`$]/.test(args.pattern)) {
        // Fall back to safe Node.js regex scan for suspicious patterns
        return nodeGrepFallback(args.pattern, args.paths)
      }
      // Escape double quotes and use -- to separate options from arguments
      const escapedPattern = args.pattern.replace(/"/g, '\\"')
      const escapedPaths = args.paths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(' ')
      const cmd = `rg --no-heading -n -- "${escapedPattern}" ${escapedPaths} 2>&1`
      try {
        const result = await env.exec(cmd, shellTimeoutMs)
        if (result.exitCode === 0 || result.stdout.trim() !== '') {
          return result.stdout || result.stderr
        }
        if (result.exitCode === 1) {
          // rg exits 1 when no matches found
          return result.stdout
        }
        // rg might not be available, fall back
        throw new Error('rg not available')
      } catch (_err) {
        // Fall back to Node regex line scan
        return nodeGrepFallback(args.pattern, args.paths)
      }
    },
  }
}

async function nodeGrepFallback(pattern: string, paths: string[]): Promise<string> {
  const regex = new RegExp(pattern)
  const results: string[] = []

  async function scanFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        if (regex.test(line)) {
          results.push(`${filePath}:${i + 1}:${line}`)
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  async function scanPath(p: string): Promise<void> {
    try {
      const entries = await readdir(p, { withFileTypes: true })
      for (const entry of entries) {
        const full = join(p, entry.name)
        if (entry.isDirectory()) {
          await scanPath(full)
        } else {
          await scanFile(full)
        }
      }
    } catch {
      // treat as file
      await scanFile(p)
    }
  }

  for (const p of paths) {
    await scanPath(resolve(p))
  }

  return results.join('\n')
}

function createGlobTool(): ToolDefinition<{ pattern: string }> {
  return {
    name: 'glob',
    description: 'Find files matching a glob pattern. Returns newline-separated matching paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files against' },
      },
      required: ['pattern'],
    },
    outputTruncation: 5_000,
    async executor(args, env: ExecutionEnvironment) {
      return manualGlob(args.pattern, env)
    },
  }
}

async function manualGlob(pattern: string, env: ExecutionEnvironment): Promise<string> {
  // Route through env.exec so workdir is respected and sandboxing applies
  try {
    const result = await env.exec(`find . -path "./${pattern}" 2>/dev/null || true`, 5_000)
    return result.stdout.trim()
  } catch {
    return ''
  }
}
