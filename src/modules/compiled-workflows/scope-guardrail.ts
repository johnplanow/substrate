/**
 * ScopeGuardrail — utility for detecting out-of-scope file modifications in code review.
 *
 * Parses the expected file set from a story spec and compares it against the
 * actual files modified by the dev agent. Returns a pre-computed scope analysis
 * markdown string that can be injected into the code-review prompt so the LLM
 * reviewer does not need to re-parse the spec sections manually.
 *
 * Architecture constraints:
 * - Pure utility: no imports from packages/sdlc/, packages/core/, or persistence layer
 * - Takes plain strings in, returns plain strings out
 * - Test-file exemption patterns must match countTestMetrics() in code-review.ts
 */

import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * File extensions that qualify a token as a "path-like" string in task bullets.
 * Any token containing `/` and one of these extensions is treated as a file path.
 */
const RECOGNIZED_EXTENSIONS = [
  '.ts', '.js', '.tsx', '.jsx',
  '.md', '.json', '.yaml', '.yml',
  '.py', '.go', '.java', '.rb', '.rs',
  '.sh', '.css', '.scss', '.html',
]

/**
 * Section headings that explicitly list expected file paths.
 */
const FILE_PATH_SECTION_PATTERNS = [
  /^#{1,4}\s*(file paths to create|files? to create)/i,
  /^#{1,4}\s*(file paths to modify|files? to modify)/i,
  /^#{1,4}\s*(key file paths?)/i,
]

/**
 * The heading that marks the start of tasks/subtasks section.
 */
const TASKS_SECTION_PATTERN = /^#{1,4}\s*(tasks?\s*\/?\s*subtasks?|tasks?)/i

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

/**
 * Returns true if the given file path is a test file.
 * Patterns must be consistent with countTestMetrics() in code-review.ts,
 * which checks for `.test.`, `.spec.`, and `__tests__`. We also add `__mocks__/`.
 */
export function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('__tests__/') ||
    filePath.includes('__tests__\\') ||
    filePath.includes('/__tests__') ||
    filePath.includes('\\__tests__') ||
    filePath.includes('__mocks__/') ||
    filePath.includes('__mocks__\\') ||
    filePath.includes('/__mocks__') ||
    filePath.includes('\\__mocks__')
  )
}

// ---------------------------------------------------------------------------
// ScopeGuardrail
// ---------------------------------------------------------------------------

export class ScopeGuardrail {
  /**
   * Extract expected file paths from a story spec's raw text content.
   *
   * Scans for paths under sections:
   *  - "### File Paths to Create" / "### Files to Create"
   *  - "### File Paths to Modify" / "### Files to Modify"
   *  - "### Key File Paths"
   *  - Path-like tokens in "### Tasks / Subtasks" bullets
   *
   * A "path-like" token is any token containing `/` and a recognized extension.
   * Backtick wrappers and leading `- ` list markers are stripped.
   *
   * @param storyContent - Raw story spec markdown text
   * @returns Set of file path strings extracted from the spec
   */
  static parseExpectedFiles(storyContent: string): Set<string> {
    const paths = new Set<string>()
    const lines = storyContent.split('\n')

    let mode: 'none' | 'file-list' | 'tasks' = 'none'

    for (const rawLine of lines) {
      const line = rawLine.trimEnd()

      // Check if we're entering a new section
      if (/^#{1,4}\s/.test(line)) {
        // Reset mode first
        mode = 'none'

        // Check if this is a file-path section
        for (const pattern of FILE_PATH_SECTION_PATTERNS) {
          if (pattern.test(line)) {
            mode = 'file-list'
            break
          }
        }

        // Check if this is the tasks section
        if (mode === 'none' && TASKS_SECTION_PATTERN.test(line)) {
          mode = 'tasks'
        }

        continue
      }

      if (mode === 'file-list') {
        // Extract any path from list items or plain lines
        const extracted = extractPathsFromLine(line)
        for (const p of extracted) {
          paths.add(p)
        }
      } else if (mode === 'tasks') {
        // Only extract path-like tokens (tokens with `/` + known extension)
        const extracted = extractPathLikeTokens(line)
        for (const p of extracted) {
          paths.add(p)
        }
      }
    }

    return paths
  }

  /**
   * Build a pre-computed scope analysis markdown string for injection into
   * the code-review prompt context.
   *
   * Returns empty string if no out-of-scope violations are detected (so the
   * assemblePrompt optional-section drop behavior applies automatically).
   *
   * @param storyContent - Raw story spec markdown text
   * @param filesModified - List of file paths from the git diff
   * @param fileDiffs - Optional per-file diff map. When provided, transitive
   *                   re-exports (Story 61-5) whose `from` source IS in
   *                   expectedFiles are excluded from the out-of-scope set.
   * @returns Markdown string listing expected/actual/delta file sets,
   *          or empty string if no violations found
   */
  static buildAnalysis(
    storyContent: string,
    filesModified: string[],
    fileDiffs?: Map<string, string>,
  ): string {
    const expectedFiles = ScopeGuardrail.parseExpectedFiles(storyContent)

    // Filter test files from the modified list before computing delta
    const nonTestFiles = filesModified.filter((f) => !isTestFile(f))

    // Compute delta: actual non-test files not in the expected set
    let outOfScope = nonTestFiles.filter((f) => !expectedFiles.has(f))

    // Story 61-5: when per-file diffs are available, exclude transitive
    // re-export modifications. An `index.ts` (or any file outside Key File
    // Paths) whose diff is purely re-exports of symbols from files that ARE
    // in Key File Paths is a structural necessity, not scope creep.
    if (fileDiffs !== undefined) {
      outOfScope = outOfScope.filter(
        (filePath) => !isPureTransitiveReExport(filePath, fileDiffs.get(filePath), expectedFiles),
      )
    }

    if (outOfScope.length === 0) {
      return ''
    }

    const expectedList =
      expectedFiles.size > 0
        ? Array.from(expectedFiles)
            .map((f) => `  - ${f}`)
            .join('\n')
        : '  (none specified)'

    // Display only non-test files in the "Actual files" list — test files are
    // unconditionally exempt and don't need to appear in scope analysis output
    const actualList =
      nonTestFiles.length > 0
        ? nonTestFiles.map((f) => `  - ${f}`).join('\n')
        : '  (none)'

    const deltaList = outOfScope.map((f) => `  - ${f}`).join('\n')

    return [
      '## Pre-Computed Scope Analysis',
      '',
      'Expected files (from spec):',
      expectedList,
      '',
      'Actual files (from diff):',
      actualList,
      '',
      'Out-of-scope files (excluding tests):',
      deltaList,
      '',
      'Note: Test files (*.test.ts, *.spec.ts, __tests__/, __mocks__/) are excluded from scope checking.',
    ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Extract all path-like strings from a line (for file-list sections).
 * Handles both backtick-wrapped paths and plain paths.
 * Strips leading `- ` list markers.
 */
function extractPathsFromLine(line: string): string[] {
  const paths: string[] = []

  // Strip leading whitespace and list marker
  const trimmed = line.trim().replace(/^[-*]\s+/, '')

  if (!trimmed) return paths

  // Try backtick-wrapped paths first: `src/foo/bar.ts`
  const backtickMatches = trimmed.matchAll(/`([^`]+)`/g)
  for (const match of backtickMatches) {
    const candidate = match[1].trim()
    if (isFilePath(candidate)) {
      paths.push(candidate)
    }
  }

  if (paths.length > 0) return paths

  // Try the whole trimmed line (could be a plain file path)
  // Only accept if the line itself looks like a path (no spaces, has extension)
  const noSpaces = trimmed.split(/\s/)[0]
  if (noSpaces && isFilePath(noSpaces)) {
    paths.push(noSpaces)
  }

  return paths
}

/**
 * Extract path-like tokens from a line (for tasks/subtasks sections).
 * A path-like token contains `/` and a recognized extension.
 */
function extractPathLikeTokens(line: string): string[] {
  const paths: string[] = []

  // Extract backtick-wrapped tokens first
  const backtickMatches = line.matchAll(/`([^`]+)`/g)
  for (const match of backtickMatches) {
    const candidate = match[1].trim()
    if (isFilePath(candidate)) {
      paths.push(candidate)
    }
  }

  // Also scan whitespace-delimited tokens (not in backticks)
  // Remove backtick content to avoid double-counting
  const withoutBackticks = line.replace(/`[^`]+`/g, ' ')
  const tokens = withoutBackticks.split(/\s+/)
  for (const token of tokens) {
    // Strip trailing punctuation
    const clean = token.replace(/[,;:()\[\]{}'"]+$/g, '').replace(/^[,;:()\[\]{}'"]+/g, '')
    if (clean && isFilePath(clean)) {
      paths.push(clean)
    }
  }

  return paths
}

/**
 * Returns true if the candidate string looks like a file path:
 * - Contains at least one `/`
 * - Has a recognized file extension
 * - Does not contain spaces
 */
function isFilePath(candidate: string): boolean {
  if (!candidate.includes('/')) return false
  if (/\s/.test(candidate)) return false
  return RECOGNIZED_EXTENSIONS.some((ext) => candidate.endsWith(ext))
}

// ---------------------------------------------------------------------------
// Story 61-5: parse a combined `git diff` blob into per-file diff sections
// ---------------------------------------------------------------------------

/**
 * Split a combined `git diff` output into per-file diff sections, keyed by
 * the post-image (`b/`) path. Returns an empty map if the input is empty.
 *
 * Used by callers that need to feed per-file diffs into
 * `ScopeGuardrail.buildAnalysis` for transitive re-export detection.
 */
export function parseDiffByFile(combinedDiff: string): Map<string, string> {
  const result = new Map<string, string>()
  if (combinedDiff.trim() === '') return result

  let currentPath: string | null = null
  let currentLines: string[] = []

  for (const line of combinedDiff.split('\n')) {
    const headerMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (headerMatch !== null) {
      if (currentPath !== null) {
        result.set(currentPath, currentLines.join('\n'))
      }
      currentPath = headerMatch[2] ?? null
      currentLines = [line]
      continue
    }
    if (currentPath !== null) {
      currentLines.push(line)
    }
  }

  if (currentPath !== null) {
    result.set(currentPath, currentLines.join('\n'))
  }

  return result
}

// ---------------------------------------------------------------------------
// Story 61-5: transitive re-export detection
// ---------------------------------------------------------------------------

/**
 * Single-line re-export pattern. Matches:
 *   export { Foo } from './bar.js'
 *   export { Foo, Bar as Baz } from './bar'
 *   export type { Foo } from './bar.js'
 *   export { type Foo, Bar } from './bar.js'
 *
 * Captures the relative `from` path (group 1). Path must start with `./`
 * (downward re-exports only — the canonical pattern is package barrel files
 * re-exporting submodule symbols). `../` paths are not tolerated; those
 * suggest cross-package coupling that warrants real review.
 */
const REEXPORT_LINE_RE = /^\s*export\s+(?:type\s+)?\{[^}]+\}\s+from\s+['"](\.\/[^'"]+)['"]\s*;?\s*$/

/**
 * Returns true if `diffContent` represents a pure transitive re-export
 * change for `modifiedFilePath` — meaning every added/removed line is a
 * re-export whose `from` source resolves to a file in `expectedFiles`.
 *
 * Story 61-5: surfaced by 60-13 dispatch where dev added a 2-line re-export
 * of `detectsEventDrivenAC` to `verification/index.ts` (an `index.ts`
 * re-export hop required for cross-package access via `@substrate-ai/sdlc`).
 * scope-guardrail flagged it as out-of-scope, reviewer admitted "the change
 * is clearly required" but flagged anyway, story timed out → escalated.
 *
 * Returns false when:
 *  - diff content unavailable
 *  - any non-re-export, non-comment, non-blank change exists
 *  - any re-export's resolved `from` source is NOT in expectedFiles
 *  - diff is empty (no changes — preserve existing behavior)
 */
function isPureTransitiveReExport(
  modifiedFilePath: string,
  diffContent: string | undefined,
  expectedFiles: Set<string>,
): boolean {
  if (diffContent === undefined || diffContent.trim() === '') {
    return false
  }

  let sawChange = false

  for (const line of diffContent.split('\n')) {
    // Skip diff metadata lines
    if (
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('@@') ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('new file ') ||
      line.startsWith('deleted file ') ||
      line.startsWith('Binary ') ||
      line.startsWith('\\ No newline')
    ) {
      continue
    }

    // Only added/removed lines are evaluated; context lines ignored
    if (!line.startsWith('+') && !line.startsWith('-')) continue

    const content = line.slice(1)
    const trimmed = content.trim()

    // Blank line additions/removals are tolerable
    if (trimmed === '') continue
    // Single-line comment additions/removals are tolerable (doc cleanup)
    if (trimmed.startsWith('//')) continue

    sawChange = true

    const match = trimmed.match(REEXPORT_LINE_RE)
    if (match === null) {
      // Non-re-export change — not pure transitive
      return false
    }

    const fromPath = match[1] ?? ''
    if (!resolvesIntoExpected(modifiedFilePath, fromPath, expectedFiles)) {
      return false
    }
  }

  return sawChange
}

/**
 * Resolve a `from './x.js'` path relative to `modifiedFilePath`'s directory
 * and check if the resolved path (or its `.ts` sibling) is in `expectedFiles`.
 *
 * ESM convention: source files are `.ts`, but imports use `.js` extensions.
 * We accept either extension when matching against expectedFiles.
 */
function resolvesIntoExpected(
  modifiedFilePath: string,
  relativePath: string,
  expectedFiles: Set<string>,
): boolean {
  const dir = path.posix.dirname(modifiedFilePath)
  const resolved = path.posix.normalize(path.posix.join(dir, relativePath))

  const candidates = new Set<string>([resolved])

  // .js → .ts swap (ESM source convention)
  if (resolved.endsWith('.js')) {
    candidates.add(resolved.slice(0, -3) + '.ts')
    candidates.add(resolved.slice(0, -3) + '.tsx')
  }
  // .ts → .js swap (defensive)
  if (resolved.endsWith('.ts')) {
    candidates.add(resolved.slice(0, -3) + '.js')
  }
  // Extension-less imports: try common source extensions
  if (!/\.(t|j)sx?$/.test(resolved)) {
    candidates.add(resolved + '.ts')
    candidates.add(resolved + '.tsx')
    candidates.add(resolved + '.js')
    candidates.add(resolved + '/index.ts')
  }

  for (const candidate of candidates) {
    if (expectedFiles.has(candidate)) return true
  }
  return false
}
