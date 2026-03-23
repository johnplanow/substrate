/**
 * Tool handler — executes a shell command and returns stdout in context.
 *
 * AC1: Successful command → SUCCESS with stdout in context as `{node.id}.output`
 * AC2: Failing command → FAILURE with stderr as failureReason
 * AC3: Working directory resolved from context (falls back to defaultWorkingDir or cwd)
 *
 * Story 42-11.
 */

import { spawn } from 'child_process'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler } from './types.js'

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/**
 * Configuration options for the tool handler factory.
 */
export interface ToolHandlerOptions {
  /** Override the default working directory (used when `workingDirectory` is absent from context). */
  defaultWorkingDir?: string
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a tool node handler that executes a shell command specified in
 * `node.toolCommand` and captures the output into context.
 *
 * @param options - Optional configuration (defaultWorkingDir for testing).
 * @returns A `NodeHandler` that:
 *   1. Resolves the working directory from context (or falls back to defaultWorkingDir/cwd).
 *   2. Spawns the shell command from `node.toolCommand`.
 *   3. Returns SUCCESS with stdout trimmed and stored as `{node.id}.output`.
 *   4. Returns FAILURE with stderr as `failureReason` on non-zero exit code.
 */
export function createToolHandler(options?: ToolHandlerOptions): NodeHandler {
  return (node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    const command = node.toolCommand
    const cwd = context.getString('workingDirectory', options?.defaultWorkingDir ?? process.cwd())

    return new Promise<Outcome>((resolve) => {
      const child = spawn(command, [], { cwd, shell: true })

      let stdoutBuf = ''
      let stderrBuf = ''

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBuf += chunk.toString()
      })

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuf += chunk.toString()
      })

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({
            status: 'SUCCESS',
            contextUpdates: {
              [`${node.id}.output`]: stdoutBuf.trim(),
            },
          })
        } else {
          resolve({
            status: 'FAILURE',
            failureReason: stderrBuf.trim() || `Command exited with code ${code}`,
          })
        }
      })
    })
  }
}
