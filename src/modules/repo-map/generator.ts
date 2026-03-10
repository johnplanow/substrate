/**
 * RepoMapGenerator — formats ParsedSymbol arrays into compact text output.
 */

import { relative } from 'node:path'

import type { ParsedSymbol } from './interfaces.js'

export class RepoMapGenerator {
  /**
   * Formats an array of ParsedSymbol entries into a multi-line text block.
   * Files with zero exported (non-import) symbols are omitted.
   * Import-kind entries are excluded from the text output.
   */
  formatAsText(symbols: ParsedSymbol[], projectRoot: string): string {
    // Group non-import exported symbols by filePath
    const fileMap = new Map<string, ParsedSymbol[]>()

    for (const sym of symbols) {
      if (sym.kind === 'import' || !sym.exported) continue
      const list = fileMap.get(sym.filePath) ?? []
      list.push(sym)
      fileMap.set(sym.filePath, list)
    }

    const lines: string[] = []

    for (const [filePath, fileSymbols] of fileMap) {
      if (fileSymbols.length === 0) continue

      const relPath = relative(projectRoot, filePath)
      lines.push(relPath)

      for (const sym of fileSymbols) {
        if (sym.signature) {
          lines.push(`  ${sym.kind} ${sym.name}(${sym.signature})`)
        } else {
          lines.push(`  ${sym.kind} ${sym.name}`)
        }
      }
    }

    return lines.join('\n')
  }
}
