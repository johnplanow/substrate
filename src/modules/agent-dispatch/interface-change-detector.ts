/**
 * Interface Change Detector (Story 24-3)
 *
 * Non-blocking warning system that detects when a dev-story modifies .ts files
 * containing exported interfaces/types, then checks if any test files outside
 * the same module reference those exports (potential stale mock risk).
 *
 * Performance target: <500ms (uses regex extraction + grep, not AST parsing)
 * Error handling: all errors are caught; detection failure never blocks pipeline.
 *
 * Architecture (ADR-001 modular monolith): co-located with dispatcher module.
 */

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('interface-change-detector')

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InterfaceChangeResult {
  /** Exported interface/type names found in modified .ts files */
  modifiedInterfaces: string[]
  /** Test file paths (relative to projectRoot) that reference modified interface names */
  potentiallyAffectedTests: string[]
}

// ---------------------------------------------------------------------------
// extractExportedNames
// ---------------------------------------------------------------------------

/**
 * Extract exported interface and type names from TypeScript source content.
 *
 * Matches:
 *   export interface Foo { ... }  → 'Foo'
 *   export type Bar = ...         → 'Bar'
 *
 * Uses simple regex (not AST) for performance (<500ms target).
 * Does NOT match: re-exports (`export { Foo }`), default exports, internal declarations.
 */
export function extractExportedNames(content: string): string[] {
  const names: string[] = []
  const pattern = /^export\s+(?:interface|type)\s+(\w+)/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    if (match[1] !== undefined) {
      names.push(match[1])
    }
  }
  return names
}

// ---------------------------------------------------------------------------
// detectInterfaceChanges
// ---------------------------------------------------------------------------

/**
 * Detect whether modified .ts files export interfaces/types that are
 * referenced by test files outside the same module.
 *
 * Non-blocking: any errors during detection are caught, logged, and an empty
 * result is returned rather than throwing. Detection failure never blocks pipeline.
 *
 * @param options.filesModified - List of file paths modified by the dev-story (relative to projectRoot)
 * @param options.projectRoot   - Absolute path to the project root
 * @param options.storyKey      - Story key for logging context
 */
export function detectInterfaceChanges(options: {
  filesModified: string[]
  projectRoot: string
  storyKey: string
}): InterfaceChangeResult {
  try {
    const { filesModified, projectRoot, storyKey } = options

    // Step 1: Filter to non-test .ts source files
    const tsSourceFiles = filesModified.filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'),
    )

    if (tsSourceFiles.length === 0) {
      return { modifiedInterfaces: [], potentiallyAffectedTests: [] }
    }

    // Step 2: Extract exported interface/type names and collect source module dirs
    const allNames = new Set<string>()
    const sourceDirs: string[] = []

    for (const relPath of tsSourceFiles) {
      const absPath = join(projectRoot, relPath)
      try {
        const content = readFileSync(absPath, 'utf-8')
        const names = extractExportedNames(content)
        for (const name of names) allNames.add(name)
        sourceDirs.push(dirname(relPath))
      } catch {
        // File not readable (e.g., deleted, permissions) — skip and continue
        logger.debug({ absPath, storyKey }, 'Could not read modified file for interface extraction')
      }
    }

    if (allNames.size === 0) {
      return { modifiedInterfaces: [], potentiallyAffectedTests: [] }
    }

    // Step 3: Grep test files for each interface/type name
    const affectedTests = new Set<string>()

    for (const name of allNames) {
      let grepOutput = ''
      try {
        grepOutput = execSync(
          `grep -r --include="*.test.ts" --include="*.spec.ts" -l "${name}" .`,
          {
            cwd: projectRoot,
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      } catch (grepErr) {
        // grep exits with code 1 when no matches found — that is expected and fine.
        // Any other error (binary not found, permission denied) is also swallowed
        // per AC5 (graceful degradation).
        const e = grepErr as { status?: number; stdout?: string }
        if (typeof e.stdout === 'string' && e.stdout.trim().length > 0) {
          // Partial output on unexpected error — use it
          grepOutput = e.stdout
        } else {
          // No matches or unrecoverable error — continue to next interface name
          continue
        }
      }

      const testFiles = grepOutput
        .split('\n')
        .map((l) => l.trim().replace(/^\.\//, ''))
        .filter((l) => l.length > 0)

      for (const tf of testFiles) {
        // AC4: filter out test files that belong to the same module as the
        // modified source file. A test file is "same module" when its directory
        // starts with the source file's directory (covers __tests__ subdirs).
        const tfDir = dirname(tf)
        const isSameModule = sourceDirs.some(
          (srcDir) => tfDir === srcDir || tfDir.startsWith(srcDir + '/'),
        )
        if (!isSameModule) {
          affectedTests.add(tf)
        }
      }
    }

    return {
      modifiedInterfaces: Array.from(allNames),
      potentiallyAffectedTests: Array.from(affectedTests),
    }
  } catch (err) {
    // AC5: outer catch — graceful degradation for unexpected errors.
    // Log but never block the pipeline.
    logger.warn({ err, storyKey: options.storyKey }, 'Interface change detection failed — skipping')
    return { modifiedInterfaces: [], potentiallyAffectedTests: [] }
  }
}
