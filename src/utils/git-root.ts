/**
 * Git root resolution utility.
 *
 * Resolves the main git repository root even when running from a worktree.
 * Uses `git rev-parse --git-common-dir` which always points to the shared
 * .git directory of the main worktree (ADR-005: child_process.spawn).
 */

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

/**
 * Resolve the main git repository root, even from a linked worktree.
 *
 * In the main worktree, `--git-common-dir` returns `.git` (relative).
 * In a linked worktree, it returns the absolute path to the main `.git` dir.
 * Either way, `dirname()` of the resolved absolute path yields the repo root.
 *
 * Falls back to `cwd` if not in a git repo or git is unavailable.
 */
export async function resolveMainRepoRoot(cwd: string = process.cwd()): Promise<string> {
  return new Promise<string>((res) => {
    let stdout = ''

    const proc = spawn('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (proc.stdout !== null) {
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
    }

    proc.on('error', () => {
      res(cwd)
    })

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        res(cwd)
        return
      }

      const commonDir = stdout.trim()
      if (!commonDir) {
        res(cwd)
        return
      }

      // Resolve to absolute (handles both relative `.git` and absolute paths)
      const absCommonDir = resolve(cwd, commonDir)
      res(dirname(absCommonDir))
    })
  })
}
