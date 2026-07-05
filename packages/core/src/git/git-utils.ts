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
import { readdir, access, rm, copyFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'

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
 * @param branchName  - Branch name to create (e.g., "substrate/story-abc123")
 * @param baseBranch  - Branch to base the worktree on (e.g., "main")
 * @param copyFiles   - v0.20.109: Optional list of files to copy from the
 *                      project root into the new worktree after creation
 *                      (e.g., `[".env", ".env.local"]`). Missing files are
 *                      skipped silently. Useful for gitignored files that
 *                      build tooling needs but `git worktree add` won't carry.
 * @returns           - Object with the worktreePath
 * @throws            - Error if git command fails
 */
/** Decision for whether a pre-existing registered worktree can be safely reclaimed. */
export interface WorktreeReclaimDecision {
  /** True when the worktree can be removed + recreated with no risk of data loss. */
  safe: boolean
  /** When not safe, a human reason (for the "already registered" error message). */
  reason?: string
}

/**
 * Decide whether a registered worktree from a prior dispatch can be reclaimed
 * for a fresh re-run. Safe only when there is nothing to lose: no uncommitted
 * changes AND no commits on the branch beyond the base branch. A negative
 * `commitsAhead` means the ahead-count could not be determined → not safe.
 *
 * Pure + exported for testing (the git I/O that produces the inputs lives in
 * createWorktree).
 */
export function decideWorktreeReclaim(
  hasUncommittedChanges: boolean,
  commitsAhead: number,
  baseBranch: string,
): WorktreeReclaimDecision {
  if (hasUncommittedChanges) {
    return { safe: false, reason: 'it has uncommitted changes that are NOT on the branch' }
  }
  if (commitsAhead > 0) {
    return { safe: false, reason: `its branch has ${String(commitsAhead)} commit(s) beyond ${baseBranch}` }
  }
  if (commitsAhead < 0) {
    return { safe: false, reason: 'its state could not be verified as safe to discard' }
  }
  return { safe: true }
}

/** What a worktree/branch removal would destroy, and whether it is safe. */
export interface WorktreeRemovalDecision {
  /** True when removal destroys nothing unrecoverable. */
  safe: boolean
  /** When not safe, human-readable reasons (all that apply). */
  reasons: string[]
}

/**
 * Decide whether removing a story worktree AND deleting its branch is safe
 * (H0.3, field findings #17/#19). Unsafe when:
 *   - the worktree has uncommitted changes (removal destroys the only copy), or
 *   - the branch carries commits not reachable from the project's current HEAD
 *     (branch -D destroys them — this is where H0.1's wip checkpoints live), or
 *   - either state could not be determined (negative unmergedCommits).
 *
 * Pure + exported for testing (mirrors decideWorktreeReclaim; the git I/O that
 * produces the inputs lives in inspectWorktreeRemovalSafety).
 */
export function decideWorktreeRemoval(
  hasUncommittedChanges: boolean,
  uncommittedFiles: readonly string[],
  unmergedCommits: number,
  branchName: string,
): WorktreeRemovalDecision {
  const reasons: string[] = []
  if (hasUncommittedChanges) {
    const preview = uncommittedFiles.slice(0, 10).join(', ')
    const more = uncommittedFiles.length > 10 ? ` (+${String(uncommittedFiles.length - 10)} more)` : ''
    reasons.push(
      `the worktree has ${String(uncommittedFiles.length)} uncommitted change(s) that removal would destroy` +
        (preview.length > 0 ? `: ${preview}${more}` : ''),
    )
  }
  if (unmergedCommits > 0) {
    reasons.push(
      `branch ${branchName} carries ${String(unmergedCommits)} commit(s) not reachable from the current HEAD — deleting the branch would destroy them`,
    )
  }
  if (unmergedCommits < 0) {
    reasons.push('the branch state could not be verified as safe to discard')
  }
  return { safe: reasons.length === 0, reasons }
}

/**
 * Gather the inputs for `decideWorktreeRemoval` from git. Thin I/O wrapper:
 *   - `git status --porcelain` inside the worktree (skipped when the directory
 *     is missing — nothing on disk to lose)
 *   - `git rev-list --count HEAD..<branch>` in the project root (commits the
 *     branch has that the current checkout does not; 0 when the branch is
 *     merged or absent, -1 when the count could not be determined)
 */
export async function inspectWorktreeRemovalSafety(
  worktreePath: string,
  projectRoot: string,
  branchName: string,
): Promise<WorktreeRemovalDecision> {
  let hasUncommittedChanges = false
  let uncommittedFiles: string[] = []
  const worktreeOnDisk = await access(worktreePath).then(() => true).catch(() => false)
  if (worktreeOnDisk) {
    const statusResult = await spawnGit(['status', '--porcelain'], { cwd: worktreePath })
    if (statusResult.code === 0) {
      uncommittedFiles = statusResult.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.slice(3).trim())
      hasUncommittedChanges = uncommittedFiles.length > 0
    } else {
      // Can't read status — treat as unverifiable rather than clean.
      return decideWorktreeRemoval(false, [], -1, branchName)
    }
  }

  // Does the branch exist at all? A missing branch has nothing to lose.
  const branchExists = (await spawnGit(['rev-parse', '--verify', branchName], { cwd: projectRoot })).code === 0
  let unmergedCommits = 0
  if (branchExists) {
    const aheadResult = await spawnGit(['rev-list', '--count', `HEAD..${branchName}`], { cwd: projectRoot })
    unmergedCommits = aheadResult.code === 0 ? Number.parseInt(aheadResult.stdout.trim(), 10) || 0 : -1
  }

  return decideWorktreeRemoval(hasUncommittedChanges, uncommittedFiles, unmergedCommits, branchName)
}

export async function createWorktree(
  projectRoot: string,
  taskId: string,
  branchName: string,
  baseBranch: string,
  copyFiles: readonly string[] = [],
): Promise<{ worktreePath: string }> {
  const worktreePath = path.join(projectRoot, '.substrate-worktrees', taskId)

  // Gap-1 fix (Story 75-1, Path E spike 2026-05-10): Guard against orphan directories
  // before `git worktree add`. An orphan directory exists on disk but is NOT registered
  // in `git worktree list` — this can happen when a previous run crashed between mkdir
  // and git registration, or when the worktrees base dir was manually created.
  const worktreeExists = await access(worktreePath)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false
      throw err
    })

  if (worktreeExists) {
    // Directory exists — check if it's registered in git worktree list
    const listResult = await spawnGit(['worktree', 'list', '--porcelain'], { cwd: projectRoot })
    const registeredPaths = listResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())

    const isRegistered = registeredPaths.includes(worktreePath)

    if (!isRegistered) {
      // Orphan directory: exists on disk but not registered in git worktree list.
      // Use fs.rm (not git worktree remove) since git can't remove unregistered paths.
      await rm(worktreePath, { recursive: true, force: true })
      // Fall through to git worktree add below
    } else {
      // Registered AND directory exists: a prior dispatch (commonly a failed or
      // escalated one) preserved this worktree. Re-running the same story would
      // otherwise hit a hard "already registered" wall.
      //
      // Reclaim it for a fresh dispatch ONLY when there is nothing to lose:
      //   - no uncommitted changes in the worktree, AND
      //   - no commits on the branch beyond baseBranch.
      // This is exactly the common case (e.g. a create-story that wrote no file,
      // such as a Codex sandbox write-block). When the worktree has uncommitted
      // changes OR the branch carries commits, preserve it for forensic
      // inspection / reconcile-from-disk and surface guidance — never silently
      // discard recoverable work.
      const statusResult = await spawnGit(['status', '--porcelain'], { cwd: worktreePath })
      const hasUncommittedChanges =
        statusResult.code === 0 && statusResult.stdout.trim().length > 0
      const aheadResult = await spawnGit(
        ['rev-list', '--count', `${baseBranch}..${branchName}`],
        { cwd: projectRoot },
      )
      const commitsAhead =
        aheadResult.code === 0 ? Number.parseInt(aheadResult.stdout.trim(), 10) || 0 : -1
      const decision = decideWorktreeReclaim(hasUncommittedChanges, commitsAhead, baseBranch)

      if (!decision.safe) {
        throw new Error(
          `Worktree at ${worktreePath} is already registered (branch: ${branchName}) and ${decision.reason}.\n` +
            `It was preserved from a prior dispatch for inspection — inspect before removing.\n` +
            `\n` +
            `To remove and re-dispatch:\n` +
            `  substrate worktrees --cleanup ${taskId}\n` +
            `\n` +
            `To remove all substrate worktrees:\n` +
            `  substrate worktrees --cleanup`,
        )
      }

      // Nothing to lose — remove the stale worktree + branch and recreate fresh.
      await spawnGit(['worktree', 'remove', '--force', worktreePath], { cwd: projectRoot })
      // Branch delete is best-effort: the fresh `git worktree add -b` below needs
      // the name free. -D is safe here because commitsAhead === 0 (no unique work).
      await spawnGit(['branch', '-D', branchName], { cwd: projectRoot })
      // Fall through to git worktree add below.
    }
  }

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

  // v0.20.109: copy gitignored files (e.g. `.env*`) into the worktree.
  // Worktrees only contain tracked files, so gitignored configs are absent —
  // any build tooling that reads env vars at build time (SvelteKit
  // `$env/static/*`, Next.js inlining) breaks inside worktrees without this.
  // Missing files are skipped silently to keep `[".env", ".env.local"]`-style
  // permissive defaults safe across checkouts.
  await copyFilesToWorktree(projectRoot, worktreePath, copyFiles)

  return { worktreePath }
}

/**
 * Copy files from a source directory into a target worktree.
 *
 * Skips missing files silently (intentional — config like `[".env",
 * ".env.local"]` should not blow up if `.env.local` doesn't exist in the
 * parent checkout). Creates parent directories for nested paths.
 *
 * Exported for testability; not part of the public worktree API.
 */
export async function copyFilesToWorktree(
  sourceRoot: string,
  worktreePath: string,
  files: readonly string[],
): Promise<void> {
  if (files.length === 0) return

  for (const relativePath of files) {
    // Reject absolute paths and `..` traversal to keep copies scoped to the
    // project root. A misconfigured `copy_files: ['/etc/passwd']` should not
    // smuggle host files into the worktree.
    if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes('..')) {
      continue
    }

    const sourcePath = path.join(sourceRoot, relativePath)
    const destPath = path.join(worktreePath, relativePath)

    try {
      await access(sourcePath)
    } catch {
      // Source file doesn't exist — skip silently
      continue
    }

    // Ensure parent directory exists for nested paths (e.g. `config/.env`)
    const destDir = path.dirname(destPath)
    if (destDir !== worktreePath) {
      await mkdir(destDir, { recursive: true })
    }

    await copyFile(sourcePath, destPath)
  }
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
  const spawnOpts: SpawnOptions = {}
  if (projectRoot !== undefined) spawnOpts.cwd = projectRoot

  const result = await spawnGit(
    ['worktree', 'remove', '--force', worktreePath],
    spawnOpts,
  )

  if (result.code !== 0) {
    throw new Error(`git worktree remove failed for "${worktreePath}": ${result.stderr || result.stdout}`)
  }
}

// ---------------------------------------------------------------------------
// removeBranch
// ---------------------------------------------------------------------------

/**
 * Delete a git branch using `git branch -D`.
 *
 * @param branchName  - Branch name to delete (e.g., "substrate/story-abc123")
 * @param projectRoot - Absolute path to the git repository root
 * @returns           - true if branch was successfully deleted, false otherwise
 */
export async function removeBranch(branchName: string, projectRoot?: string): Promise<boolean> {
  const spawnOpts: SpawnOptions = {}
  if (projectRoot !== undefined) spawnOpts.cwd = projectRoot

  const result = await spawnGit(['branch', '-D', branchName], spawnOpts)

  if (result.code !== 0) {
    // Branch may not exist (e.g., worktree checkout failed earlier) — treat as warning not error
    return false
  }

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
  } catch {
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
  const result = await spawnGit(
    ['merge', '--no-commit', '--no-ff', branchName],
    { cwd },
  )

  // Git exits with code 0 if merge is clean (but not committed due to --no-commit)
  // Git exits with non-zero code if there are conflicts
  if (result.code === 0) {
    return true
  }

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
  await spawnGit(['merge', '--abort'], { cwd })
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
  const result = await spawnGit(
    ['diff', '--name-only', '--diff-filter=U'],
    { cwd },
  )

  if (result.code !== 0) {
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
  const result = await spawnGit(
    ['merge', '--no-ff', branchName],
    { cwd },
  )

  if (result.code !== 0) {
    return false
  }

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
      return []
    }

    return altResult.stdout.trim().split('\n').filter((f) => f.trim().length > 0)
  }

  if (result.stdout.trim() === '') {
    return []
  }

  return result.stdout.trim().split('\n').filter((f) => f.trim().length > 0)
}
