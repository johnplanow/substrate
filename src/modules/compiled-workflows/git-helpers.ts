/**
 * Git diff capture utilities for the compiled-workflows module.
 *
 * Provides helpers to capture git diff output for use in code-review prompts.
 * Uses child_process.spawn (ADR-005) for subprocess management.
 */

import { spawn } from 'node:child_process'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('compiled-workflows:git-helpers')

// ---------------------------------------------------------------------------
// getGitDiffSummary
// ---------------------------------------------------------------------------

/**
 * Capture the full git diff for HEAD~1.
 *
 * Runs `git diff HEAD~1` in the specified working directory and returns
 * the diff output as a string. On error (no git repo, no previous commit,
 * process exits non-zero), returns an empty string and logs a warning.
 *
 * Uses child_process.spawn per ADR-005.
 *
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns The diff output string, or '' on error
 */
export async function getGitDiffSummary(workingDirectory: string = process.cwd()): Promise<string> {
  return runGitCommand(['diff', 'HEAD~1'], workingDirectory, 'git-diff-summary')
}

// ---------------------------------------------------------------------------
// getGitDiffStatSummary
// ---------------------------------------------------------------------------

/**
 * Capture the file-level stat summary from git diff HEAD~1.
 *
 * Runs `git diff --stat HEAD~1` which provides a condensed summary of
 * changed files without the full diff hunks. Used as a fallback when the
 * full diff exceeds the token budget.
 *
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns The stat summary string, or '' on error
 */
export async function getGitDiffStatSummary(workingDirectory: string = process.cwd()): Promise<string> {
  return runGitCommand(['diff', '--stat', 'HEAD~1'], workingDirectory, 'git-diff-stat')
}

// ---------------------------------------------------------------------------
// getGitDiffForFiles
// ---------------------------------------------------------------------------

/**
 * Capture the git diff scoped to specific files.
 *
 * Runs `git diff HEAD~1 -- file1.ts file2.ts ...` to produce a diff
 * limited to only the specified file paths. Returns '' if files is empty.
 *
 * @param files - List of file paths to scope the diff to
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns The scoped diff output string, or '' on error/empty
 */
export async function getGitDiffForFiles(
  files: string[],
  workingDirectory: string = process.cwd(),
): Promise<string> {
  if (files.length === 0) return ''
  return runGitCommand(['diff', 'HEAD~1', '--', ...files], workingDirectory, 'git-diff-files')
}

// ---------------------------------------------------------------------------
// getGitChangedFiles
// ---------------------------------------------------------------------------

/**
 * Get all changed file paths from the working tree via `git status --porcelain`.
 *
 * Includes all status codes (M, A, R, D, ??) so that newly created untracked
 * files are captured. `.gitignore` filters build artifacts and noise.
 *
 * Used as a fallback to recover `files_modified` when the dev-story agent
 * doesn't emit a YAML output contract.
 *
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns Array of file paths, or [] on error
 */
export async function getGitChangedFiles(workingDirectory: string = process.cwd()): Promise<string[]> {
  const output = await runGitCommand(['status', '--porcelain'], workingDirectory, 'git-changed-files')
  if (output === '') return []

  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      // Porcelain format: XY filename  (or XY old -> new for renames)
      const raw = line.slice(3)
      // Handle renames: "R  old.ts -> new.ts" → extract new path
      const arrowIdx = raw.indexOf(' -> ')
      return arrowIdx !== -1 ? raw.slice(arrowIdx + 4) : raw
    })
}

// ---------------------------------------------------------------------------
// Internal helper (exported for reuse by getGitChangedFiles tests)
// ---------------------------------------------------------------------------

/**
 * Run a git command in the specified directory and return its stdout output.
 * Returns '' on any error and logs a warning.
 */
async function runGitCommand(
  args: string[],
  cwd: string,
  logLabel: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (proc.stdout !== null) {
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
    }

    if (proc.stderr !== null) {
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
    }

    proc.on('error', (err: Error) => {
      logger.warn(
        { label: logLabel, cwd, error: err.message },
        'Failed to spawn git process — returning empty diff',
      )
      resolve('')
    })

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        logger.warn(
          { label: logLabel, cwd, code, stderr: stderr.trim() },
          'Git process exited non-zero — returning empty diff',
        )
        resolve('')
        return
      }
      resolve(stdout)
    })
  })
}
