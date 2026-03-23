/**
 * RepoMapInjector — extracts file references from story content and builds
 * a repo-map context block for injection into dev-story and code-review prompts.
 */

import type { Logger } from 'pino'

import type { RepoMapQueryEngine, RepoMapQueryResult } from '../repo-map/index.js'
import { RepoMapFormatter } from '../repo-map/index.js'
import type { RepoMapQuery } from '../repo-map/index.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InjectionResult {
  text: string
  symbolCount: number
  truncated: boolean
}

// ---------------------------------------------------------------------------
// RepoMapInjector
// ---------------------------------------------------------------------------

export class RepoMapInjector {
  private readonly _queryEngine: RepoMapQueryEngine
  private readonly _logger: Logger

  constructor(queryEngine: RepoMapQueryEngine, logger: Logger) {
    this._queryEngine = queryEngine
    this._logger = logger
  }

  /**
   * Build repo-map context by extracting file references from the story content,
   * querying the repo-map engine, and formatting the result as text.
   *
   * @param storyContent - Full story file text
   * @param tokenBudget - Maximum token budget for the repo-map block (default: 2000)
   * @returns InjectionResult with text, symbolCount, and truncated flag
   */
  async buildContext(storyContent: string, tokenBudget = 2000): Promise<InjectionResult> {
    // Extract src/ file references from story content
    const matches = storyContent.match(/\bsrc\/[\w/.-]+\.tsx?\b/g) ?? []
    // Only src/ paths are queried — .substrate/, node_modules/, dist/ excluded by design
    const dedupedPaths = [...new Set(matches)].filter(
      (p) => p.startsWith('src/') && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'),
    )

    // No file refs found — skip query
    if (dedupedPaths.length === 0) {
      return { text: '', symbolCount: 0, truncated: false }
    }

    const query: RepoMapQuery = {
      files: dedupedPaths,
      maxTokens: tokenBudget,
    }

    let result: RepoMapQueryResult
    try {
      result = await this._queryEngine.query(query)
    } catch (err) {
      this._logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          storyContent: storyContent.slice(0, 100),
        },
        'repo-map context unavailable',
      )
      return { text: '', symbolCount: 0, truncated: false }
    }

    if (result.symbolCount === 0) {
      return { text: '', symbolCount: 0, truncated: false }
    }

    const text = RepoMapFormatter.toText(result)

    return {
      text,
      symbolCount: result.symbolCount,
      truncated: result.truncated,
    }
  }
}
