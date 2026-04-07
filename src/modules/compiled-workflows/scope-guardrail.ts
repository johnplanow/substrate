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
   * @returns Markdown string listing expected/actual/delta file sets,
   *          or empty string if no violations found
   */
  static buildAnalysis(storyContent: string, filesModified: string[]): string {
    const expectedFiles = ScopeGuardrail.parseExpectedFiles(storyContent)

    // Filter test files from the modified list before computing delta
    const nonTestFiles = filesModified.filter((f) => !isTestFile(f))

    // Compute delta: actual non-test files not in the expected set
    const outOfScope = nonTestFiles.filter((f) => !expectedFiles.has(f))

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
