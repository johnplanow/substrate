/**
 * GitClient — wraps git subprocess calls for repo-map operations.
 *
 * story 28-2: provides getCurrentSha, getChangedFiles, listTrackedFiles.
 */

import { execFile as execFileCb } from 'node:child_process'

import type pino from 'pino'

import { AppError, ERR_REPO_MAP_GIT_FAILED } from '../../errors/index.js'
import type { IGitClient } from './interfaces.js'

// ---------------------------------------------------------------------------
// runGit helper
// ---------------------------------------------------------------------------

/**
 * Promise-wrapper around execFile for git commands.
 * Resolves to trimmed stdout string on success; rejects with the underlying
 * ChildProcess error on non-zero exit.
 */
function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb('git', args, { cwd }, (err, stdout) => {
      if (err) {
        reject(err)
      } else {
        resolve(stdout)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// GitClient
// ---------------------------------------------------------------------------

/**
 * Implements IGitClient using git subprocess calls.
 */
export class GitClient implements IGitClient {
  private readonly _logger: pino.Logger

  constructor(logger: pino.Logger) {
    this._logger = logger
  }

  /**
   * Returns the current HEAD commit SHA.
   */
  async getCurrentSha(projectRoot: string): Promise<string> {
    try {
      const stdout = await runGit(['rev-parse', 'HEAD'], projectRoot)
      return stdout.trim()
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      this._logger.warn({ projectRoot, err }, 'GitClient.getCurrentSha failed')
      throw new AppError(ERR_REPO_MAP_GIT_FAILED, 2, `git rev-parse HEAD failed: ${detail}`)
    }
  }

  /**
   * Returns the list of files changed between fromSha and HEAD.
   */
  async getChangedFiles(projectRoot: string, fromSha: string): Promise<string[]> {
    try {
      const stdout = await runGit(['diff', '--name-only', `${fromSha}..HEAD`], projectRoot)
      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      this._logger.warn({ projectRoot, fromSha, err }, 'GitClient.getChangedFiles failed')
      throw new AppError(ERR_REPO_MAP_GIT_FAILED, 2, `git diff --name-only failed: ${detail}`)
    }
  }

  /**
   * Returns all files tracked by git in the project.
   */
  async listTrackedFiles(projectRoot: string): Promise<string[]> {
    try {
      const stdout = await runGit(['ls-files'], projectRoot)
      return stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err)
      this._logger.warn({ projectRoot, err }, 'GitClient.listTrackedFiles failed')
      throw new AppError(ERR_REPO_MAP_GIT_FAILED, 2, `git ls-files failed: ${detail}`)
    }
  }
}
