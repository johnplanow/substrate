/**
 * RepoMapFormatter — renders RepoMapQueryResult in text or JSON format.
 */

import type { RepoMapQueryResult } from './types.js'

export class RepoMapFormatter {
  /**
   * Renders the result as a compact text block grouped by file.
   *
   * Format:
   *   # repo-map: <symbolCount> symbols
   *
   *   <filePath>:<lineNumber> <symbolType> <symbolName>(<signature>)
   *   ...
   *
   * A blank line separates each file group.
   */
  static toText(result: RepoMapQueryResult): string {
    const lines: string[] = [`# repo-map: ${result.symbolCount} symbols`]

    // Group symbols by filePath (preserving order — already sorted by caller)
    const fileGroups = new Map<string, typeof result.symbols>()
    for (const sym of result.symbols) {
      const group = fileGroups.get(sym.filePath) ?? []
      group.push(sym)
      fileGroups.set(sym.filePath, group)
    }

    for (const [filePath, symbols] of fileGroups) {
      lines.push('')
      for (const sym of symbols) {
        const sig = sym.signature ?? ''
        lines.push(`${filePath}:${sym.lineNumber} ${sym.symbolType} ${sym.symbolName}(${sig})`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Renders the result as a pretty-printed JSON string.
   * Includes all RepoMapSymbol fields plus top-level metadata.
   */
  static toJson(result: RepoMapQueryResult): string {
    return JSON.stringify(result, null, 2)
  }
}
