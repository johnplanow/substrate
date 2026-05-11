/**
 * Git diff capture utilities for the compiled-workflows module.
 *
 * Provides helpers to capture git diff output for use in code-review prompts.
 * Uses child_process.spawn (ADR-005) for subprocess management.
 */

import { spawn, execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, relative as relativePath } from 'node:path'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('compiled-workflows:git-helpers')

/**
 * Result of `commitDevStoryOutput`.
 *
 * - `committed`: `git commit` succeeded; `sha` is the new HEAD SHA.
 * - `no-changes`: nothing to commit (filter removed everything or working tree was already clean).
 * - `failed`: `git commit` exited non-zero (pre-commit hook rejected, gpg signing failed, etc.).
 *   `stderr` carries the surfaced error so the orchestrator can escalate with context.
 */
export type CommitDevStoryResult =
  | { status: 'committed'; sha: string; filesStaged: string[] }
  | { status: 'no-changes'; reason: string }
  | { status: 'failed'; stderr: string }

/**
 * Commit the agent's working-tree output for a dev-story dispatch.
 *
 * Path E Bug #5 (post-v0.20.85): substrate's per-story worktree flow assumed
 * the dispatched agent would run `git commit` itself. Empirical audit across
 * substrate + 4 consumer projects (strata, agent-mesh, boardgame-sandbox,
 * lucky-numbers) found 1 `feat(story-X-Y)` commit total in 2 months — agents
 * don't reliably commit. Path E's merge-to-main has been a silent no-op
 * since v0.20.79 because the branch never advanced past the orchestrator's
 * start commit. Result: pipelines reported succeeded, work was lost on
 * worktree cleanup.
 *
 * Fix: substrate commits programmatically before merge-to-main fires. The
 * commit captures every uncommitted file under the worktree that isn't
 * `.gitignored` (git add respects ignore rules) and isn't outside the
 * worktree boundary (absolute paths to /tmp/... are filtered out so they
 * don't trip 'fatal: outside repository'). Pre-commit hooks are NOT
 * bypassed — they exist in the operator's repo for a reason and should
 * gate substrate-generated commits too. A hook failure surfaces as a
 * dev-story-no-commit escalation with the hook output as evidence.
 *
 * @param storyKey      Story key (e.g. "10-2") for the canonical commit-msg pattern
 * @param storyTitle    Title from create-story result (or fallback string)
 * @param filesModified Files the agent declared (or recovered via git-status fallback)
 * @param workingDir    The worktree path (or projectRoot when --no-worktree)
 * @returns Structured result for the orchestrator to inspect
 */
export async function commitDevStoryOutput(
  storyKey: string,
  storyTitle: string | undefined,
  filesModified: string[],
  workingDir: string,
): Promise<CommitDevStoryResult> {
  // Filter to paths INSIDE workingDir. Absolute paths outside (e.g. `/tmp/foo.log`)
  // are excluded so `git add` doesn't trip 'fatal: outside repository'. Paths
  // inside workingDir that match .gitignore are silently skipped by `git add`
  // itself — no extra filter needed for `node_modules/`, `dist/`, etc.
  const insideWorktree: string[] = []
  for (const p of filesModified) {
    const abs = isAbsolute(p) ? p : resolvePath(workingDir, p)
    const rel = relativePath(workingDir, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      // Outside the worktree boundary — skip silently. The agent shouldn't
      // be writing outside the worktree, but if it does, those files are
      // tmp-shaped and don't belong in the substrate commit.
      logger.debug({ path: p, abs, workingDir }, 'commitDevStoryOutput: filtered out path outside worktree')
      continue
    }
    insideWorktree.push(rel)
  }

  if (insideWorktree.length === 0) {
    return { status: 'no-changes', reason: 'no-files-inside-worktree' }
  }

  // Stage. `git add` respects .gitignore and is no-op for already-tracked
  // unchanged files, so passing a path that didn't actually change is safe.
  try {
    execSync(`git add ${insideWorktree.map((p) => JSON.stringify(p)).join(' ')}`, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err
      ? String((err as { stderr: Buffer | string }).stderr ?? err.message)
      : err instanceof Error ? err.message : String(err)
    return { status: 'failed', stderr: `git add failed: ${stderr}` }
  }

  // Check whether anything is actually staged (filter may have included files
  // that were already committed or untouched). `git diff --cached --quiet`
  // exits 0 = no staged changes, 1 = changes staged.
  const cachedCheck = spawn('git', ['diff', '--cached', '--quiet'], {
    cwd: workingDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cachedStatus = await new Promise<number>((res) => {
    cachedCheck.on('close', (code) => res(code ?? 0))
    cachedCheck.on('error', () => res(0))
  })
  if (cachedStatus === 0) {
    return { status: 'no-changes', reason: 'staging-produced-no-diff' }
  }

  // Commit. Hooks fire (no --no-verify) — they're part of the operator's
  // repo contract and gating substrate's auto-commit through them is the
  // correct behavior. Hook failure surfaces in stderr and we return
  // status: 'failed' for the orchestrator to escalate.
  const title = storyTitle ?? 'implementation'
  const message = `feat(story-${storyKey}): ${title}`
  try {
    execSync(`git commit -m ${JSON.stringify(message)}`, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err
      ? String((err as { stderr: Buffer | string }).stderr ?? err.message)
      : err instanceof Error ? err.message : String(err)
    return { status: 'failed', stderr: `git commit failed: ${stderr}` }
  }

  // Resolve the new HEAD SHA so the orchestrator can attribute the merge.
  let sha = ''
  try {
    sha = execSync('git rev-parse HEAD', {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    }).trim()
  } catch (err) {
    // The commit succeeded but rev-parse failed (shouldn't happen). Report
    // as committed without SHA — orchestrator can re-resolve at merge time.
    logger.warn({ storyKey, err }, 'commitDevStoryOutput: commit succeeded but rev-parse HEAD failed')
  }

  logger.info(
    { storyKey, sha, fileCount: insideWorktree.length },
    'commitDevStoryOutput: committed dev-story output',
  )
  return { status: 'committed', sha, filesStaged: insideWorktree }
}

/**
 * Check whether the repo at `cwd` has at least one commit (HEAD resolves).
 * Returns false for fresh repos with no commits, avoiding `fatal: bad revision 'HEAD'`.
 * Synchronous (execSync) to keep it simple — this is a fast local check.
 */
function hasCommits(cwd: string): boolean {
  try {
    execSync('git rev-parse --verify HEAD', { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 })
    return true
  } catch {
    return false
  }
}

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
  if (!hasCommits(workingDirectory)) {
    logger.debug({ cwd: workingDirectory }, 'No commits in repo — returning empty diff')
    return ''
  }
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
  if (!hasCommits(workingDirectory)) {
    logger.debug({ cwd: workingDirectory }, 'No commits in repo — returning empty stat')
    return ''
  }
  return runGitCommand(['diff', '--stat', 'HEAD'], workingDirectory, 'git-diff-stat')
}

// ---------------------------------------------------------------------------
// getGitDiffBetweenCommits
// ---------------------------------------------------------------------------

/**
 * Capture the diff between two commits (e.g., baseline..HEAD).
 * Used when the dev-story agent committed its work, making `git diff HEAD`
 * empty. This shows what was actually changed.
 *
 * @param baseCommit - Starting commit SHA
 * @param endCommit - Ending commit SHA (defaults to 'HEAD')
 * @param workingDirectory - Directory to run git in
 * @returns The diff string, or '' on error
 */
export async function getGitDiffBetweenCommits(
  baseCommit: string,
  endCommit: string = 'HEAD',
  workingDirectory: string = process.cwd(),
): Promise<string> {
  return runGitCommand(['diff', `${baseCommit}..${endCommit}`], workingDirectory, 'git-diff-commits')
}

/**
 * Capture the stat-only diff between two commits.
 */
export async function getGitDiffStatBetweenCommits(
  baseCommit: string,
  endCommit: string = 'HEAD',
  workingDirectory: string = process.cwd(),
): Promise<string> {
  return runGitCommand(['diff', '--stat', `${baseCommit}..${endCommit}`], workingDirectory, 'git-diff-stat-commits')
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
  if (!hasCommits(workingDirectory)) {
    logger.debug({ cwd: workingDirectory }, 'No commits in repo — returning empty diff for files')
    return ''
  }
  // Mark untracked files for intent-to-add so they appear in git diff
  await stageIntentToAdd(files, workingDirectory)
  return runGitCommand(['diff', 'HEAD', '--', ...files], workingDirectory, 'git-diff-files')
}

// ---------------------------------------------------------------------------
// getGitDiffStatForFiles
// ---------------------------------------------------------------------------

/**
 * Capture the file-level stat summary scoped to specific files.
 *
 * Runs `git diff --stat HEAD -- file1.ts file2.ts ...` to produce a condensed
 * stat summary limited to only the specified file paths. Used as a fallback
 * when the scoped full diff exceeds the token budget — ensures the stat-only
 * summary also stays scoped to the story's files rather than showing all
 * uncommitted changes in the repo.
 *
 * @param files - List of file paths to scope the stat summary to
 * @param workingDirectory - Directory to run git in (defaults to process.cwd())
 * @returns The scoped stat summary string, or '' on error/empty
 */
export async function getGitDiffStatForFiles(
  files: string[],
  workingDirectory: string = process.cwd(),
): Promise<string> {
  if (files.length === 0) return ''
  if (!hasCommits(workingDirectory)) {
    logger.debug({ cwd: workingDirectory }, 'No commits in repo — returning empty stat for files')
    return ''
  }
  return runGitCommand(['diff', '--stat', 'HEAD', '--', ...files], workingDirectory, 'git-diff-stat-files')
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
  // Filter out nonexistent files to avoid git errors (AC3 of story 23-2)
  const existing = files.filter((f) => {
    const exists = existsSync(f)
    if (!exists) {
      logger.debug({ file: f }, 'Skipping nonexistent file in stageIntentToAdd')
    }
    return exists
  })
  if (existing.length === 0) return
  // git add -N is safe on already-tracked files (no-op)
  await runGitCommand(['add', '-N', '--', ...existing], workingDirectory, 'git-add-intent')
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
