/**
 * RepoMapModule — high-level facade for repo-map staleness detection.
 *
 * Story 28-9: CLI Commands, Full-Stack Wiring, and Staleness Detection
 */
import { execSync } from 'node:child_process'

import pino from 'pino'

import type { IRepoMapMetaRepository } from './interfaces.js'

/**
 * RepoMapModule wraps the meta repository to provide high-level operations
 * such as staleness detection (comparing stored commit SHA against HEAD).
 */
export class RepoMapModule {
  private readonly _metaRepo: IRepoMapMetaRepository
  private readonly _logger: pino.Logger

  constructor(metaRepo: IRepoMapMetaRepository, logger: pino.Logger) {
    this._metaRepo = metaRepo
    this._logger = logger
  }

  /**
   * Check whether the stored repo-map is stale relative to the current HEAD commit.
   *
   * Returns `null` when:
   * - No meta has been stored yet (repo-map has never been built)
   * - The stored commit SHA matches HEAD (repo-map is current)
   * - The git command fails (git not available / not in a repo — silently skipped)
   *
   * Returns `{ storedSha, headSha, fileCount }` when the repo-map is stale.
   */
  async checkStaleness(): Promise<{ storedSha: string; headSha: string; fileCount: number } | null> {
    const meta = await this._metaRepo.getMeta()
    if (!meta?.commitSha) {
      this._logger.debug('checkStaleness: no meta found, skipping')
      return null
    }

    try {
      const headSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
      if (meta.commitSha === headSha) {
        this._logger.debug({ sha: headSha }, 'checkStaleness: repo-map is current')
        return null
      }
      this._logger.debug({ storedSha: meta.commitSha, headSha }, 'checkStaleness: repo-map is stale')
      return {
        storedSha: meta.commitSha,
        headSha,
        fileCount: meta.fileCount ?? 0,
      }
    } catch {
      // git not available or not in a repo — silently skip
      return null
    }
  }
}
