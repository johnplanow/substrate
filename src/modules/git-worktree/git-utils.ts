/**
 * git-utils.ts — Low-level git command helpers.
 *
 * All git commands are executed via child_process.spawn (not simple-git),
 * as specified in ADR-007 (Git Worktree Management).
 *
 * Functions:
 *  - spawnGit: Execute git with given args, returns stdout/stderr/code
 *  - getGitVersion: Returns version string like "2.42.0"
 *  - parseGitVersion: Parses version string into { major, minor, patch }
 *  - isGitVersionSupported: Checks if version >= 2.20.0
 *  - verifyGitVersion: Throws if git not installed or < 2.20
 *  - createWorktree: Creates a worktree + branch
 *  - removeWorktree: Removes a worktree directory
 *  - removeBranch: Deletes a branch with git branch -D
 *  - getOrphanedWorktrees: Scans .substrate-worktrees/ and returns paths
 *  - simulateMerge: Runs git merge --no-commit --no-ff to detect conflicts
 *  - abortMerge: Runs git merge --abort to clean up a simulated merge
 *  - getConflictingFiles: Returns list of files with conflicts using git diff --name-only --diff-filter=U
 *  - performMerge: Runs git merge --no-ff to execute actual merge
 *  - getMergedFiles: Returns list of files changed in a merge using git diff --name-only
 */

import { spawn } from 'node:child_process'
import { readdir, access } from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('git-utils')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface GitSpawnResult {
  stdout: string
  stderr: string
  code: number
}

export interface GitVersion {
  major: number
  minor: number
  patch: number
}

// Minimum supported git version
const MIN_GIT_MAJOR = 2
const MIN_GIT_MINOR = 20

// ---------------------------------------------------------------------------
// spawnGit
// ---------------------------------------------------------------------------

/**
 * Spawn a git subprocess with the given args.
 *
 * @param args    - Arguments to pass to git (e.g., ['worktree', 'add', ...])
 * @param options - Optional spawn options (cwd, env)
 * @returns       - Object with stdout, stderr, and exit code
 */
export function spawnGit(args: string[], options?: SpawnOptions): Promise<GitSpawnResult> {
  return new Promise((resolve) => {
    logger.debug({ args, cwd: options?.cwd }, 'spawnGit')

    const proc = spawn('git', args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 })
    })

    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: 1 })
    })
  })
}

// ---------------------------------------------------------------------------
// getGitVersion
// ---------------------------------------------------------------------------

/**
 * Get the installed git version string.
 *
 * @returns Version string like "2.42.0"
 * @throws  Error if git is not installed or version cannot be parsed
 */
export async function getGitVersion(): Promise<string> {
  const result = await spawnGit(['--version'])

  if (result.code !== 0) {
    throw new Error(`git --version failed: ${result.stderr}`)
  }

  // Output is like: "git version 2.42.0"
  const match = /git version\s+(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)
  if (match === null || match[1] === undefined) {
    throw new Error(`Unable to parse git version from output: "${result.stdout}"`)
  }

  return match[1]
}

// ---------------------------------------------------------------------------
// parseGitVersion
// ---------------------------------------------------------------------------

/**
 * Parse a git version string into major/minor/patch components.
 *
 * @param versionString - Version string like "2.42.0" or "2.20"
 * @returns             - Parsed version components
 */
export function parseGitVersion(versionString: string): GitVersion {
  const parts = versionString.split('.').map(Number)
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
  }
}

// ---------------------------------------------------------------------------
// isGitVersionSupported
// ---------------------------------------------------------------------------

/**
 * Check if the given git version string is >= 2.20.0.
 *
 * @param version - Version string like "2.42.0"
 * @returns       - true if version >= 2.20.0
 */
export function isGitVersionSupported(version: string): boolean {
  const { major, minor } = parseGitVersion(version)
  if (major > MIN_GIT_MAJOR) return true
  if (major === MIN_GIT_MAJOR && minor >= MIN_GIT_MINOR) return true
  return false
}

// ---------------------------------------------------------------------------
// verifyGitVersion
// ---------------------------------------------------------------------------

/**
 * Verify that git is installed and version >= 2.20.
 *
 * @throws Error with clear message if git is not installed or too old
 */
export async function verifyGitVersion(): Promise<void> {
  let version: string
  try {
    version = await getGitVersion()
  } catch (err) {
    throw new Error(
      `git is not installed or could not be executed. ` +
        `Please install git 2.20 or newer. Details: ${String(err)}`,
    )
  }

  if (!isGitVersionSupported(version)) {
    const { major, minor, patch } = parseGitVersion(version)
    throw new Error(
      `Git version ${major}.${minor}.${patch} is too old. ` +
        `Substrate requires git 2.20 or newer. ` +
        `Please upgrade git: https://git-scm.com/downloads`,
    )
  }

  logger.debug({ version }, 'git version verified')
}

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

/**
 * Create a git worktree and its associated branch.
 *
 * Uses a single `git worktree add {worktreePath} -b {branchName} {baseBranch}`
 * command to create the worktree with a new branch in one step.
 *
 * @param projectRoot - Absolute path to the git repository root
 * @param taskId      - Task identifier (used in path derivation)
 * @param branchName  - Branch name to create (e.g., "substrate/task-abc123")
 * @param baseBranch  - Branch to base the worktree on (e.g., "main")
 * @returns           - Object with the worktreePath
 * @throws            - Error if git command fails
 */
export async function createWorktree(
  projectRoot: string,
  taskId: string,
  branchName: string,
  baseBranch: string,
): Promise<{ worktreePath: string }> {
  const worktreePath = path.join(projectRoot, '.substrate-worktrees', taskId)

  logger.debug({ projectRoot, taskId, branchName, baseBranch, worktreePath }, 'createWorktree')

  // Create the worktree with a new branch based on baseBranch in one command
  const addResult = await spawnGit(
    ['worktree', 'add', worktreePath, '-b', branchName, baseBranch],
    { cwd: projectRoot },
  )

  if (addResult.code !== 0) {
    throw new Error(
      `git worktree add failed for task "${taskId}": ${addResult.stderr || addResult.stdout}`,
    )
  }

  logger.info({ taskId, branchName, worktreePath }, 'Worktree created')
  return { worktreePath }
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Remove a git worktree by path.
 *
 * Uses `git worktree remove --force` to handle unclean worktrees.
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectRoot  - Absolute path to the git repository root
 * @throws             - Error if git command fails
 */
export async function removeWorktree(worktreePath: string, projectRoot?: string): Promise<void> {
  logger.debug({ worktreePath }, 'removeWorktree')

  const spawnOpts: SpawnOptions = {}
  if (projectRoot !== undefined) spawnOpts.cwd = projectRoot

  const result = await spawnGit(
    ['worktree', 'remove', '--force', worktreePath],
    spawnOpts,
  )

  if (result.code !== 0) {
    throw new Error(`git worktree remove failed for "${worktreePath}": ${result.stderr || result.stdout}`)
  }

  logger.debug({ worktreePath }, 'Worktree removed')
}

// ---------------------------------------------------------------------------
// removeBranch
// ---------------------------------------------------------------------------

/**
 * Delete a git branch using `git branch -D`.
 *
 * @param branchName  - Branch name to delete (e.g., "substrate/task-abc123")
 * @param projectRoot - Absolute path to the git repository root
 * @returns           - true if branch was successfully deleted, false otherwise
 */
export async function removeBranch(branchName: string, projectRoot?: string): Promise<boolean> {
  logger.debug({ branchName }, 'removeBranch')

  const spawnOpts: SpawnOptions = {}
  if (projectRoot !== undefined) spawnOpts.cwd = projectRoot

  const result = await spawnGit(['branch', '-D', branchName], spawnOpts)

  if (result.code !== 0) {
    // Branch may not exist (e.g., worktree checkout failed earlier) — treat as warning not error
    logger.warn({ branchName, stderr: result.stderr }, 'git branch -D failed (may already be deleted)')
    return false
  }

  logger.debug({ branchName }, 'Branch deleted')
  return true
}

// ---------------------------------------------------------------------------
// getOrphanedWorktrees
// ---------------------------------------------------------------------------

/**
 * Scan the worktrees base directory and return paths of all found worktree directories.
 *
 * @param projectRoot   - Absolute path to the git repository root
 * @param baseDirectory - Relative directory name for worktrees (default: '.substrate-worktrees')
 * @returns             - Array of absolute worktree directory paths
 */
export async function getOrphanedWorktrees(projectRoot: string, baseDirectory = '.substrate-worktrees'): Promise<string[]> {
  const worktreesDir = path.join(projectRoot, baseDirectory)

  // Check if the directory exists
  try {
    await access(worktreesDir)
  } catch {
    // Directory doesn't exist — no orphaned worktrees
    return []
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(worktreesDir, { withFileTypes: true })
  } catch (err) {
    logger.warn({ worktreesDir, err }, 'getOrphanedWorktrees: failed to read directory')
    return []
  }

  // Filter for directories only and return absolute paths
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(worktreesDir, entry.name))
}

// ---------------------------------------------------------------------------
// simulateMerge
// ---------------------------------------------------------------------------

/**
 * Simulate a merge using git merge --no-commit --no-ff without committing.
 *
 * This runs in the target branch's working directory (the project root or
 * worktree path). The simulation must be aborted after checking conflicts
 * via abortMerge().
 *
 * @param branchName  - The source branch to simulate merging
 * @param cwd         - Working directory (must be on the target branch)
 * @returns           - true if merge would be clean, false if there are conflicts
 */
export async function simulateMerge(branchName: string, cwd: string): Promise<boolean> {
  logger.debug({ branchName, cwd }, 'simulateMerge')

  const result = await spawnGit(
    ['merge', '--no-commit', '--no-ff', branchName],
    { cwd },
  )

  // Git exits with code 0 if merge is clean (but not committed due to --no-commit)
  // Git exits with non-zero code if there are conflicts
  // Note: Even on success, git outputs "Automatic merge went well" to stderr or stdout
  if (result.code === 0) {
    // Fast-forward or clean merge — no conflicts
    return true
  }

  // Non-zero exit code typically means conflicts exist
  return false
}

// ---------------------------------------------------------------------------
// abortMerge
// ---------------------------------------------------------------------------

/**
 * Abort a merge in progress using git merge --abort.
 *
 * Should be called after simulateMerge() to clean up the merge state,
 * regardless of whether conflicts were found.
 *
 * @param cwd - Working directory (same as used for simulateMerge)
 */
export async function abortMerge(cwd: string): Promise<void> {
  logger.debug({ cwd }, 'abortMerge')

  const result = await spawnGit(['merge', '--abort'], { cwd })

  if (result.code !== 0) {
    // If there's nothing to abort (merge wasn't in progress), log a warning but don't throw
    logger.warn({ cwd, stderr: result.stderr }, 'abortMerge: git merge --abort returned non-zero (may have been nothing to abort)')
  }

  logger.debug({ cwd }, 'Merge aborted')
}

// ---------------------------------------------------------------------------
// getConflictingFiles
// ---------------------------------------------------------------------------

/**
 * Get a list of files with conflicts during a merge.
 *
 * Must be called while a merge is in progress (after simulateMerge() and
 * before abortMerge()).
 *
 * @param cwd - Working directory of the repository
 * @returns   - Array of conflicting file paths
 */
export async function getConflictingFiles(cwd: string): Promise<string[]> {
  logger.debug({ cwd }, 'getConflictingFiles')

  const result = await spawnGit(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd },
  )

  if (result.code !== 0) {
    logger.warn({ cwd, stderr: result.stderr }, 'getConflictingFiles: git diff returned non-zero')
    return []
  }

  if (result.stdout.trim() === '') {
    return []
  }

  return result.stdout.trim().split('\n').filter((f) => f.trim().length > 0)
}

// ---------------------------------------------------------------------------
// performMerge
// ---------------------------------------------------------------------------

/**
 * Perform an actual merge using git merge --no-ff.
 *
 * Should only be called after detectConflicts() confirms there are no conflicts.
 * Creates a merge commit even if fast-forward is possible (--no-ff ensures history).
 *
 * @param branchName  - The source branch to merge
 * @param cwd         - Working directory (must be on the target branch)
 * @returns           - true if merge succeeded, false otherwise
 */
export async function performMerge(branchName: string, cwd: string): Promise<boolean> {
  logger.debug({ branchName, cwd }, 'performMerge')

  const result = await spawnGit(
    ['merge', '--no-ff', branchName],
    { cwd },
  )

  if (result.code !== 0) {
    logger.warn({ branchName, cwd, stderr: result.stderr }, 'performMerge: git merge --no-ff failed')
    return false
  }

  logger.debug({ branchName, cwd }, 'Merge completed')
  return true
}

// ---------------------------------------------------------------------------
// getMergedFiles
// ---------------------------------------------------------------------------

/**
 * Get a list of files changed in the most recent merge.
 *
 * Uses git diff --name-only HEAD~1..HEAD to find files in the merge commit.
 * Falls back to empty array if commit history is insufficient.
 *
 * @param cwd - Working directory of the repository
 * @returns   - Array of file paths that were merged
 */
export async function getMergedFiles(cwd: string): Promise<string[]> {
  logger.debug({ cwd }, 'getMergedFiles')

  // Get files changed between HEAD~1 and HEAD (the merge commit)
  const result = await spawnGit(
    ['diff', '--name-only', 'HEAD~1..HEAD'],
    { cwd },
  )

  if (result.code !== 0) {
    // May fail if there's only one commit — try alternative approach
    const altResult = await spawnGit(
      ['show', '--name-only', '--format=', 'HEAD'],
      { cwd },
    )

    if (altResult.code !== 0) {
      logger.warn({ cwd, stderr: altResult.stderr }, 'getMergedFiles: failed to get merged file list')
      return []
    }

    return altResult.stdout.trim().split('\n').filter((f) => f.trim().length > 0)
  }

  if (result.stdout.trim() === '') {
    return []
  }

  return result.stdout.trim().split('\n').filter((f) => f.trim().length > 0)
}
