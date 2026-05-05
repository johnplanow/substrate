/**
 * SourceAcShelloutCheck — Story 67-3.
 *
 * Tier A static-analysis check that detects bare `npx <package>` invocations
 * (without `--no-install`) in story-modified source files.
 *
 * Motivation: obs_2026-05-03_023 (dependency-confusion attack vector). When
 * `npx <package>` is invoked without `--no-install`, npm silently falls back
 * to the public registry if the package binary is not locally installed —
 * making the binary name a potential dependency-confusion target.
 *
 * This check fires only when the `npx <package>` pattern appears inside a
 * string-literal context (single-quoted, double-quoted, or template-literal),
 * which is the canonical shape of shell-out code in TypeScript/JavaScript.
 * Bare prose in comments is excluded.
 */

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { CATEGORY_SHELLOUT_NPX_FALLBACK, renderFindings } from '../findings.js'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'

// ---------------------------------------------------------------------------
// Detection pattern
// ---------------------------------------------------------------------------

/** Matches `npx <name>` but NOT `npx --no-install <name>`. */
const NPX_PATTERN = /npx\s+(?!--no-install)([a-zA-Z0-9_@\-/]+)/g

// ---------------------------------------------------------------------------
// Line-level classification helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the line (after trimming leading whitespace) starts with
 * a single-line comment marker (`//` or `#`). Block comments (/* … *\/) are not
 * matched here — they are handled by the string-literal context check.
 */
export function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('#')
}

/**
 * Returns `true` when `matchIndex` falls inside a single-quoted (`'...'`),
 * double-quoted (`"..."`), or template-literal (`` `...` ``) region of the line,
 * OR when the line is a shebang (`#!...`).
 *
 * Implementation: scan character-by-character from index 0, toggling
 * `inSingle`, `inDouble`, `inTemplate` flags at unescaped quote characters.
 * An escaped quote is one where the immediately preceding character is `\`.
 * (Note: this is a heuristic — it does not handle `\\` or complex escape
 * sequences correctly. For a static-analysis severity:warn heuristic, the
 * simplification is acceptable.)
 */
export function isInStringLiteralContext(line: string, matchIndex: number): boolean {
  // Shebang lines are shell string context
  if (line.trimStart().startsWith('#!')) return true

  let inSingle = false
  let inDouble = false
  let inTemplate = false

  for (let i = 0; i < matchIndex; i++) {
    const char = line[i]
    const escaped = i > 0 && line[i - 1] === '\\'

    if (!escaped) {
      if (char === "'" && !inDouble && !inTemplate) {
        inSingle = !inSingle
      } else if (char === '"' && !inSingle && !inTemplate) {
        inDouble = !inDouble
      } else if (char === '`' && !inSingle && !inDouble) {
        inTemplate = !inTemplate
      }
    }
  }

  return inSingle || inDouble || inTemplate
}

// ---------------------------------------------------------------------------
// File scanner
// ---------------------------------------------------------------------------

/**
 * Reads the file at `absolutePath` and returns every line/match pair where
 * a bare `npx <name>` (without `--no-install`) appears inside a string-literal
 * context on a non-comment line.
 *
 * Returns 1-indexed line numbers.
 */
export function scanFile(absolutePath: string): Array<{ lineNum: number; name: string }> {
  const content = fs.readFileSync(absolutePath, 'utf-8')
  const lines = content.split('\n')
  const results: Array<{ lineNum: number; name: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    if (isCommentLine(line)) continue

    // Reset regex state for each line
    NPX_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    // Use a fresh copy of the regex for exec (avoids global state issues)
    const linePattern = new RegExp(NPX_PATTERN.source, 'g')
    while ((match = linePattern.exec(line)) !== null) {
      const name = match[1]
      if (name !== undefined && isInStringLiteralContext(line, match.index)) {
        results.push({ lineNum: i + 1, name })
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Check implementation
// ---------------------------------------------------------------------------

/**
 * Standalone function implementing the shellout check logic.
 * Exported separately so tests can call it directly without instantiating the class.
 */
export async function runShelloutCheck(
  context: VerificationContext,
): Promise<VerificationResult> {
  const start = Date.now()
  const findings: VerificationFinding[] = []

  // --- Resolve modified files ---
  let modifiedFiles: string[] = context.devStoryResult?.files_modified ?? []

  if (modifiedFiles.length === 0) {
    // Fallback: git diff HEAD~1
    try {
      const output = execSync('git diff --name-only HEAD~1', {
        cwd: context.workingDir,
        encoding: 'utf-8',
      })
      modifiedFiles = output
        .trim()
        .split('\n')
        .filter((f) => f.length > 0)
    } catch {
      // Git unavailable or no prior commit — skip check
      return {
        status: 'pass',
        details: 'source-ac-shellout: no modified files available — skipping check',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }
  }

  // --- Filter out .md files ---
  const filesToCheck = modifiedFiles.filter((f) => !f.endsWith('.md'))

  if (filesToCheck.length === 0) {
    return {
      status: 'pass',
      details: 'source-ac-shellout: no non-.md modified files — skipping check',
      duration_ms: Date.now() - start,
      findings: [],
    }
  }

  // --- Scan each file ---
  for (const relPath of filesToCheck) {
    const absPath = path.join(context.workingDir, relPath)
    let matches: Array<{ lineNum: number; name: string }>
    try {
      matches = scanFile(absPath)
    } catch {
      // File unreadable or missing — skip silently
      continue
    }

    for (const { lineNum, name } of matches) {
      findings.push({
        category: CATEGORY_SHELLOUT_NPX_FALLBACK,
        severity: 'warn',
        message:
          `npx fallback detected in ${relPath}:${lineNum}: "npx ${name}" — bare \`npx <package>\` without \`--no-install\` falls through to the public npm registry on first use. If \`<package>\` isn't a registered binary in your dev dependencies, this is a dependency-confusion vector. Use absolute path or \`npx --no-install <package>\` instead.`,
      })
    }
  }

  // --- Derive status ---
  const status =
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
        : 'source-ac-shellout: no bare npx fallback patterns detected',
    duration_ms: Date.now() - start,
    findings,
  }
}

/**
 * VerificationCheck class for the shellout static-analysis gate.
 *
 * name  = 'source-ac-shellout'
 * tier  = 'A' (fast — file I/O only, no LLM, no subprocess except optional git fallback)
 */
export class SourceAcShelloutCheck implements VerificationCheck {
  readonly name = 'source-ac-shellout'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    return runShelloutCheck(context)
  }
}
