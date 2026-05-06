/**
 * AC-to-Test Traceability Check — Story 74-1.
 *
 * On-demand heuristic check that maps Acceptance Criteria items from a story
 * spec to test descriptions found in the story's modified test files. The check
 * uses Jaccard word-overlap (≥0.4 threshold) for approximate matching and
 * always reports `confidence: 'approximate'` to signal the heuristic nature.
 *
 * Design notes:
 *   - On-demand ONLY — NOT registered in the default Tier A/B pipeline.
 *     Invoked explicitly via `--verify-ac` on `substrate report` and `substrate run`.
 *   - No LLM call in this module (LLM augmentation deferred to Epic 75 per AC5).
 *   - No package additions — uses only Node.js built-ins and existing codebase.
 *   - File reader is injectable via `_readFile` for unit testing (keeps tests pure).
 *
 * Citation (AC8):
 *   - Phase D Story 54-7 (original spec for AC-to-test traceability concept)
 *   - Epic 71 (substrate report; this story 74-1 extends Epic 71's output)
 */

import { readFile } from 'fs/promises'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single row in the AC traceability matrix. */
export interface AcTraceabilityRow {
  /** The raw AC text (trimmed, with numbering stripped). */
  acText: string
  /** Whether at least one test description scored ≥0.4 word overlap. */
  matched: boolean
  /** Name of the best-matching test description, or null if none matched. */
  testName: string | null
  /** Numeric overlap score of the best match (0–1). */
  score: number
}

/** Input to `runAcTraceabilityCheck`. */
export interface AcTraceabilityInput {
  /** Story key being checked (e.g., '74-1'). */
  storyKey: string
  /** Full raw markdown content of the story spec file. */
  storyContent: string
  /**
   * List of file paths modified by the story's implementation.
   * Sourced from `per_story_state[key].dev_story_signals.files_modified`.
   * Absolute or project-relative paths are both accepted; the check attempts
   * to read each path as-is.
   */
  filesModified: string[]
  /**
   * Optional file reader for dependency injection in tests.
   * When provided, called instead of `fs/promises.readFile` for each test file.
   * Returning null/undefined causes the file to be silently skipped.
   */
  _readFile?: (filePath: string) => Promise<string | null>
}

/** Output from `runAcTraceabilityCheck`. */
export interface AcTraceabilityOutput {
  storyKey: string
  /** Per-AC match rows. */
  matrix: AcTraceabilityRow[]
  /** Always 'approximate' — the matching algorithm is heuristic. */
  confidence: 'approximate'
  /** Advisory messages (e.g., "no test files found in filesModified"). */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Word-overlap algorithm (AC2)
// ---------------------------------------------------------------------------

/**
 * Tokenize a string to a deduplicated set of lowercase alphanumeric tokens.
 * Non-alphanumeric characters are replaced with spaces before splitting.
 */
function tokenize(s: string): Set<string> {
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return new Set(words)
}

/**
 * Compute Jaccard-based word overlap between two strings.
 * Returns 0 when either string has no tokens.
 */
export function wordOverlap(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const w of setA) {
    if (setB.has(w)) intersection++
  }
  const union = new Set([...setA, ...setB]).size
  return intersection / union
}

// ---------------------------------------------------------------------------
// AC section parser (AC2)
// ---------------------------------------------------------------------------

/**
 * Extract numbered AC items from the `## Acceptance Criteria` section of a
 * story spec. Handles both plain `## Acceptance Criteria` headings and the
 * bold-wrapped variant `**Acceptance Criteria:**`.
 *
 * Stops scanning at the next `##` heading (or end-of-file).
 *
 * Returns an array of trimmed AC text strings (numbering stripped).
 */
export function parseAcList(storyContent: string): string[] {
  const lines = storyContent.split('\n')
  const items: string[] = []
  let inAcSection = false

  for (const line of lines) {
    // Detect start of AC section
    if (/^##\s+Acceptance Criteria/i.test(line) || /\*\*Acceptance Criteria:\*\*/i.test(line)) {
      inAcSection = true
      continue
    }

    // Stop at the next level-2 heading (but not level-3+ sub-headings)
    if (inAcSection && /^##\s/.test(line)) {
      break
    }

    if (!inAcSection) continue

    // Match numbered list items: "1." / "1)" / "AC1:" / "AC1." etc.
    // Prefix is required (no trailing ?) to avoid capturing continuation prose.
    const numbered = line.match(/^\s*(?:\d+[.):]|AC\d+[.):])\s*(.+)/)
    if (numbered) {
      const text = (numbered[1] ?? '').trim()
      if (text.length > 0) {
        items.push(text)
      }
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// Test file detection (AC2)
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [/\.test\.ts$/, /\.test\.js$/, /test/i]

/** Returns true when the path matches a known test file pattern. */
export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(path))
}

// ---------------------------------------------------------------------------
// Test description extraction (AC2)
// ---------------------------------------------------------------------------

const TEST_DESC_RE = /(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g

/**
 * Extract all string literals passed to `describe(`, `it(`, or `test(` in the
 * provided source text.
 */
export function extractTestDescriptions(source: string): string[] {
  const results: string[] = []
  let m: RegExpExecArray | null
  // Reset lastIndex to 0 before each scan (the regex has the /g flag)
  TEST_DESC_RE.lastIndex = 0
  while ((m = TEST_DESC_RE.exec(source)) !== null) {
    const desc = m[1]
    if (desc !== undefined && desc.trim().length > 0) {
      results.push(desc.trim())
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Core check function (AC1)
// ---------------------------------------------------------------------------

/**
 * Run the AC-to-test traceability heuristic.
 *
 * Steps:
 *   1. Parse AC list from `input.storyContent`.
 *   2. Filter `input.filesModified` to test files.
 *   3. Read each test file and extract describe/it/test descriptions.
 *   4. For each AC × each test description, compute word-overlap score.
 *   5. A score ≥ 0.4 marks the AC as "matched".
 *   6. Return the matrix with `confidence: 'approximate'`.
 *
 * File I/O errors are silently ignored per file (the file is simply skipped).
 * When no test files are found, all ACs are "not matched" and a warning is emitted.
 */
export async function runAcTraceabilityCheck(
  input: AcTraceabilityInput,
): Promise<AcTraceabilityOutput> {
  const { storyKey, storyContent, filesModified } = input
  const fileReader = input._readFile ?? ((p: string) => readFile(p, 'utf-8'))
  const warnings: string[] = []

  // Step 1: parse AC list
  const acList = parseAcList(storyContent)

  // Step 2: filter to test files
  const testFiles = filesModified.filter(isTestFile)

  if (testFiles.length === 0) {
    warnings.push(
      `No test files found in filesModified for story ${storyKey}. All ACs marked as unmatched.`,
    )
    // Return all ACs as unmatched
    const matrix: AcTraceabilityRow[] = acList.map((acText) => ({
      acText,
      matched: false,
      testName: null,
      score: 0,
    }))
    return { storyKey, matrix, confidence: 'approximate', warnings }
  }

  // Step 3: read test files and extract descriptions
  const allTestDescriptions: string[] = []
  for (const filePath of testFiles) {
    try {
      const source = await fileReader(filePath)
      if (source != null) {
        const descs = extractTestDescriptions(source)
        allTestDescriptions.push(...descs)
      }
    } catch {
      // Silently skip unreadable files
    }
  }

  // Step 4 & 5: score each AC against test descriptions
  const MATCH_THRESHOLD = 0.4

  const matrix: AcTraceabilityRow[] = acList.map((acText) => {
    let bestScore = 0
    let bestTestName: string | null = null

    for (const desc of allTestDescriptions) {
      const score = wordOverlap(acText, desc)
      if (score > bestScore) {
        bestScore = score
        bestTestName = desc
      }
    }

    const matched = bestScore >= MATCH_THRESHOLD
    return {
      acText,
      matched,
      testName: matched ? bestTestName : null,
      score: bestScore,
    }
  })

  return { storyKey, matrix, confidence: 'approximate', warnings }
}
