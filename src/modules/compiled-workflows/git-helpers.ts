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
 * Capture the full git diff for HEAD (working tree vs current commit).
 *
 * Runs `git diff HEAD` in the specified working directory and returns
 * the diff output as a string. Uses HEAD (not HEAD~1) so the diff shows
 * only changes made since the current commit — not changes already in HEAD.
 * On error (no git repo, process exits non-zero), returns an empty string.
 *
 * Uses child_process.spawn per ADR-005.
 *
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns The diff output string, or '' on error
 */
export async function getGitDiffSummary(workingDirectory: string = process.cwd()): Promise<string> {
  return runGitCommand(['diff', 'HEAD'], workingDirectory, 'git-diff-summary')
}

// ---------------------------------------------------------------------------
// getGitDiffStatSummary
// ---------------------------------------------------------------------------

/**
 * Capture the file-level stat summary from git diff HEAD.
 *
 * Runs `git diff --stat HEAD` which provides a condensed summary of
 * changed files without the full diff hunks. Used as a fallback when the
 * full diff exceeds the token budget.
 *
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns The stat summary string, or '' on error
 */
export async function getGitDiffStatSummary(workingDirectory: string = process.cwd()): Promise<string> {
  return runGitCommand(['diff', '--stat', 'HEAD'], workingDirectory, 'git-diff-stat')
}

// ---------------------------------------------------------------------------
// getGitDiffForFiles
// ---------------------------------------------------------------------------

/**
 * Capture the git diff scoped to specific files.
 *
 * Runs `git diff HEAD -- file1.ts file2.ts ...` to produce a diff
 * limited to only the specified file paths. Returns '' if files is empty.
 *
 * Before diffing, marks any untracked files with `git add -N` (intent-to-add)
 * so that newly created files appear in the diff output. Without this,
 * `git diff` cannot see untracked files and the review agent misses them.
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
  // Mark untracked files for intent-to-add so they appear in git diff
  await stageIntentToAdd(files, workingDirectory)
  return runGitCommand(['diff', 'HEAD', '--', ...files], workingDirectory, 'git-diff-files')
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
// stageIntentToAdd
// ---------------------------------------------------------------------------

/**
 * Mark untracked files with `git add -N` (intent-to-add) so they appear in diffs.
 *
 * `git diff` cannot see untracked files. `git add -N` marks them as
 * intent-to-add without staging their content, which makes `git diff HEAD`
 * show them as new file additions. This is non-destructive — it does not
 * stage the files for commit.
 *
 * Silently ignores errors (file doesn't exist, already tracked, etc.).
 *
 * @param files - List of file paths to mark for intent-to-add
 * @param workingDirectory - Directory to run git in
 */
export async function stageIntentToAdd(
  files: string[],
  workingDirectory: string,
): Promise<void> {
  if (files.length === 0) return
  // git add -N is safe on already-tracked files (no-op)
  await runGitCommand(['add', '-N', '--', ...files], workingDirectory, 'git-add-intent')
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
