/**
 * ConflictDetector — file-overlap and namespace-collision detection.
 *
 * Story 53-9: Dispatch Pre-Condition Gating
 *
 * Provides pure utility functions for:
 *   - extracting target symbol names from story content
 *   - finding file-level overlap between pending and completed story file sets
 *   - detecting namespace collisions in overlapping files
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// ConflictDetector
// ---------------------------------------------------------------------------

export class ConflictDetector {
  /**
   * Extract exported/declared symbol names from story content using regex.
   *
   * Matches the primary pattern for TypeScript exports and class/interface
   * declarations. Returns unique symbol names only.
   *
   * AC3: Symbol extraction uses regex (no AST).
   *
   * @param storyContent - Raw text content of the story file.
   * @returns Unique array of symbol names found in the content.
   */
  static extractTargetSymbols(storyContent: string): string[] {
    // Primary extraction pattern from dev notes
    const pattern =
      /(export\s+(?:class|interface|const|function)|(?:^|\s)class|(?:^|\s)interface)\s+(\w+)/gm

    const names = new Set<string>()
    let match: RegExpExecArray | null

    while ((match = pattern.exec(storyContent)) !== null) {
      const name = match[2]
      if (name !== undefined && name.length > 0) {
        names.add(name)
      }
    }

    return Array.from(names)
  }

  /**
   * Return the intersection of two file-path arrays.
   *
   * AC2: identifies file-level overlap for the warn path.
   *
   * @param pendingFiles - File paths targeted by the pending story.
   * @param completedFiles - File paths modified by a completed story.
   * @returns Paths present in both arrays.
   */
  static findOverlappingFiles(pendingFiles: string[], completedFiles: string[]): string[] {
    const completedSet = new Set(completedFiles)
    return pendingFiles.filter((f) => completedSet.has(f))
  }

  /**
   * Search overlapping files for a namespace collision on the given symbol.
   *
   * Reads each file and looks for patterns like:
   *   - `class ${symbol}`
   *   - `interface ${symbol}`
   *   - `export const ${symbol}`
   *   - `export class ${symbol}`
   *
   * Returns the first match found, or null if no collision exists.
   * Each file read is wrapped in its own try-catch so a single unreadable
   * file does not abort the entire check.
   *
   * AC3: async file reads; per-file try-catch.
   *
   * @param symbol - Symbol name to search for.
   * @param files - Relative file paths to search.
   * @param projectRoot - Absolute project root directory.
   * @returns First collision found `{ file, symbol }`, or null.
   */
  static async detectNamespaceCollision(
    symbol: string,
    files: string[],
    projectRoot: string
  ): Promise<{ file: string; symbol: string } | null> {
    // Patterns that indicate the symbol is declared in the file
    const patterns = [
      new RegExp(`export\\s+class\\s+${symbol}\\b`),
      new RegExp(`export\\s+interface\\s+${symbol}\\b`),
      new RegExp(`export\\s+const\\s+${symbol}\\b`),
      new RegExp(`(?:^|\\s)class\\s+${symbol}\\b`),
      new RegExp(`(?:^|\\s)interface\\s+${symbol}\\b`),
    ]

    for (const filePath of files) {
      try {
        const absolutePath = join(projectRoot, filePath)
        const content = await readFile(absolutePath, 'utf-8')

        for (const pattern of patterns) {
          if (pattern.test(content)) {
            return { file: filePath, symbol }
          }
        }
      } catch {
        // Non-fatal: unreadable file skipped — proceed to next
        continue
      }
    }

    return null
  }
}
