/**
 * Concrete ExecutionEnvironment implementation.
 * Story 48-6: Uses killSignal: 'SIGKILL' per the Coding Agent Loop spec
 * to ensure timed-out processes are force-killed, not left hanging on SIGTERM.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExecutionEnvironment, ShellResult } from './types.js'

const execAsync = promisify(exec)

/**
 * Create a concrete ExecutionEnvironment with proper timeout enforcement.
 */
export function createExecutionEnvironment(workdir: string): ExecutionEnvironment {
  return {
    workdir,
    async exec(command: string, timeoutMs: number): Promise<ShellResult> {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workdir,
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 10 * 1024 * 1024, // 10MB
        })
        return { stdout, stderr, exitCode: 0 }
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean }
        if (e.killed) {
          return {
            stdout: e.stdout ?? '',
            stderr: `Process killed after ${timeoutMs}ms timeout`,
            exitCode: 137,
          }
        }
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 }
      }
    },
  }
}
