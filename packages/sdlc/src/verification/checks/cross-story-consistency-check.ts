/**
 * CrossStoryConsistencyCheck — Story 68-1.
 *
 * Tier B cross-story verification check that detects when concurrent stories
 * modify overlapping file sets, and validates that their interface signatures
 * do not conflict.
 *
 * Motivating incidents:
 *   - Epic 66 run a832487a: 66-1+66-2+66-7 concurrent dispatch — concurrent
 *     stories modifying shared test files caused transient verification failures
 *     when the earlier-committing story's changes affected the later story's
 *     verification gate.
 *   - Epic 67 run a59e4c96: 67-1+67-2 concurrent dispatch —
 *     methodology-pack.test.ts BUDGET_LIMIT constant (30000 vs 32000) was updated
 *     by story 67-1 AFTER 67-2's verification ran on the un-bumped tree, causing
 *     a false pipeline failure verdict despite fully coherent on-disk state.
 *
 * Two detection layers:
 *   Layer 1 — path intersection: detect shared file paths between the current
 *     story's modified files and priorStoryFiles (other concurrent stories).
 *     Runs unconditionally when Tier B context is present.
 *   Layer 2 — diff validation: only runs when buildCheckPassed !== false and
 *     Layer 1 found at least one collision path. Parses git diff output for
 *     type signature changes (export interface/type) and constant reassignments
 *     in the collision file set.
 *
 * Per Story 60-4/60-10 convention: motivating incident citations appear in this
 * header comment rather than inline in the check logic.
 */

import { execSync } from 'child_process'
import {
  CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION,
  renderFindings,
} from '../findings.js'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'

// ---------------------------------------------------------------------------
// Layer 2 diff patterns
// ---------------------------------------------------------------------------

/**
 * Matches added/removed export interface or type declarations.
 * Example: `+export interface Foo {` or `-export type Bar =`
 */
const INTERFACE_CHANGE_PATTERN = /^[+-]\s*(export\s+(?:interface|type)\s+\w+)/

/**
 * Matches added/removed constant assignments.
 * Example: `+const BUDGET_LIMIT = 32000` or `-const BUDGET_LIMIT = 30000`
 * Also matches `export const`, `let`, `var`.
 */
const CONST_CHANGE_PATTERN = /^[+-]\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=/

// ---------------------------------------------------------------------------
// Layer 1: collision path computation
// ---------------------------------------------------------------------------

/**
 * Compute the set of file paths that collide between the current story's
 * modified files and the prior stories' modified files.
 *
 * Uses `context._crossStoryConflictingFiles` as a direct override when
 * supplied (test-hook / runtime-probe path). Otherwise computes the
 * intersection of `devStoryResult.files_modified` ∩ `priorStoryFiles`.
 */
export function computeCollisionPaths(context: VerificationContext): string[] {
  // Test-hook override: use provided collision paths directly
  if (
    context._crossStoryConflictingFiles !== undefined &&
    context._crossStoryConflictingFiles.length > 0
  ) {
    return context._crossStoryConflictingFiles
  }

  const currentFiles = context.devStoryResult?.files_modified ?? []
  const priorFiles = context.priorStoryFiles ?? []

  if (currentFiles.length === 0 || priorFiles.length === 0) {
    return []
  }

  const priorSet = new Set(priorFiles)
  return currentFiles.filter((f) => priorSet.has(f))
}

// ---------------------------------------------------------------------------
// Layer 2: diff validation
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff text for type signature changes or constant reassignments.
 *
 * Returns `true` when the diff contains any added or removed export
 * interface/type declaration OR any added/removed constant assignment —
 * indicating a potential interface-level change that concurrent story authors
 * should review.
 */
export function diffContainsInterfaceOrConstChange(diffText: string): boolean {
  const lines = diffText.split('\n')
  for (const line of lines) {
    if (INTERFACE_CHANGE_PATTERN.test(line)) return true
    if (CONST_CHANGE_PATTERN.test(line)) return true
  }
  return false
}

/**
 * Run `git diff --no-renames <commitSha>^...<commitSha> -- <file>` to get
 * the per-file diff for the story's commit.
 *
 * Returns `null` when git is unavailable or the file wasn't part of the commit.
 */
function getDiffForFile(
  workingDir: string,
  commitSha: string,
  filePath: string,
): string | null {
  try {
    return execSync(
      `git diff --no-renames ${commitSha}~1 ${commitSha} -- ${filePath}`,
      {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch {
    return null
  }
}

/**
 * Get numstat diff for a story commit to confirm a file was modified.
 * Returns lines like: `5\t3\tsrc/foo.ts`
 */
function getNumstatDiff(
  workingDir: string,
  commitSha: string,
): string | null {
  try {
    return execSync(
      `git diff --no-renames --numstat ${commitSha}~1 ${commitSha}`,
      {
        cwd: workingDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Standalone function
// ---------------------------------------------------------------------------

/**
 * Standalone function implementing the cross-story consistency check logic.
 * Exported separately so tests can call it directly without instantiating the class.
 */
export async function runCrossStoryConsistencyCheck(
  context: VerificationContext,
): Promise<VerificationResult> {
  const start = Date.now()
  const findings: VerificationFinding[] = []

  // --- Early exit: no Tier B context ---
  // If priorStoryFiles is absent AND no test-hook override, this is a
  // single-story run. Return pass immediately without any analysis.
  if (
    (context.priorStoryFiles === undefined || context.priorStoryFiles.length === 0) &&
    (context._crossStoryConflictingFiles === undefined ||
      context._crossStoryConflictingFiles.length === 0)
  ) {
    return {
      status: 'pass',
      details:
        'cross-story-consistency: no Tier B context (priorStoryFiles absent) — skipping check',
      duration_ms: Date.now() - start,
      findings: [],
    }
  }

  // --- Layer 1: path intersection ---
  const collisionPaths = computeCollisionPaths(context)

  if (collisionPaths.length > 0) {
    findings.push({
      category: 'cross-story-file-collision',
      severity: 'warn',
      message:
        `Layer 1 collision: story "${context.storyKey}" shares ${collisionPaths.length} file(s) ` +
        `with concurrent stories: ${collisionPaths.join(', ')}. ` +
        `Recommended action: serialize these stories to avoid race conditions. ` +
        `Motivating incidents: Epic 66 (a832487a), Epic 67 (a59e4c96).`,
    })
  }

  // --- Layer 2: diff validation (gated behind buildCheckPassed) ---
  // Only run when build passed AND there are collision paths to analyze.
  // If buildCheckPassed is absent/undefined, treat as true (fail-open).
  const shouldRunLayer2 = context.buildCheckPassed !== false && collisionPaths.length > 0

  if (shouldRunLayer2) {
    const numstat = getNumstatDiff(context.workingDir, context.commitSha)
    // Parse binary file names from numstat (appear as "-\t-\t<file>")
    const binaryFiles = new Set<string>()
    if (numstat !== null) {
      for (const line of numstat.split('\n')) {
        const binMatch = /^-\t-\t(.+)$/.exec(line.trim())
        if (binMatch?.[1]) binaryFiles.add(binMatch[1])
      }
    }

    for (const filePath of collisionPaths) {
      // Skip binary files
      if (binaryFiles.has(filePath)) continue

      // Normalize path for git (always use forward slashes)
      const normalizedPath = filePath.replace(/\\/g, '/')
      const diffText = getDiffForFile(
        context.workingDir,
        context.commitSha,
        normalizedPath,
      )

      if (diffText === null) continue

      if (diffContainsInterfaceOrConstChange(diffText)) {
        findings.push({
          category: CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION,
          severity: 'warn',
          message:
            `Layer 2 interface/constant change in shared file "${filePath}": ` +
            `this story's commit modified export signatures or constants that may ` +
            `conflict with concurrent story changes. Manual review recommended. ` +
            `(Epic 66/67 reconciliation pattern: verify working-tree coherence via ` +
            `build + tests before treating pipeline outcome as definitive.)`,
        })
      }
    }
  }

  // --- Derive status ---
  const status: 'pass' | 'warn' | 'fail' =
    findings.some((f) => f.severity === 'error')
      ? 'fail'
      : findings.some((f) => f.severity === 'warn')
        ? 'warn'
        : 'pass'

  return {
    status,
    details:
      findings.length > 0
        ? renderFindings(findings)
        : 'cross-story-consistency: no file collisions detected between concurrent stories',
    duration_ms: Date.now() - start,
    findings,
  }
}

// ---------------------------------------------------------------------------
// Check class
// ---------------------------------------------------------------------------

/**
 * VerificationCheck class for cross-story consistency analysis.
 *
 * name  = 'cross-story-consistency'
 * tier  = 'B' (requires cross-story context; skipped for single-story runs)
 */
export class CrossStoryConsistencyCheck implements VerificationCheck {
  readonly name = 'cross-story-consistency'
  readonly tier = 'B' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    return runCrossStoryConsistencyCheck(context)
  }
}
