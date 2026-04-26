/**
 * SourceAcFidelityCheck — Story 58-2.
 *
 * Tier A verification check that cross-references the rendered story artifact
 * against the source epic's hard clauses (MUST/SHALL keywords, backtick-wrapped
 * paths, and Runtime Probes sections). AC rewrites introduced by the
 * create-story agent are hard-gated before the story can reach COMPLETE.
 *
 * Scoring contract:
 *   - sourceEpicContent absent/empty → warn finding (source-ac-source-unavailable), status pass
 *   - All hard clauses present in storyContent → status pass
 *   - Any hard clause absent → one error finding per missing clause (source-ac-drift), status fail
 *
 * No LLM calls, no shell execution — pure in-memory literal substring matching.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from './types.js'
import { renderFindings } from './findings.js'

// ---------------------------------------------------------------------------
// Path resolution helpers — Story 58-9c
// ---------------------------------------------------------------------------

/**
 * Directory names that should never be searched when doing the basename-glob
 * fallback for a relative path clause. Prevents the check from spending time
 * in the node_modules tree (which frequently has files whose basenames
 * collide with project source) and from descending into build or VCS output.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.substrate', '_bmad-output', 'coverage', '.next', '.cache'])

/** Max depth for the basename walk. Prevents pathological traversal. */
const MAX_WALK_DEPTH = 8

/**
 * Return true if `base` (a filename like `discover.ts`) exists somewhere under
 * `root` within MAX_WALK_DEPTH levels, skipping SKIP_DIRS. The walk is
 * synchronous and bounded; finding a single match exits early.
 */
function existsAnywhereUnderRoot(root: string, base: string): boolean {
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!
    if (depth > MAX_WALK_DEPTH) continue
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      if (entry === base) return true
      const full = join(path, entry)
      try {
        const s = statSync(full)
        if (s.isDirectory()) stack.push({ path: full, depth: depth + 1 })
      } catch {
        continue
      }
    }
  }
  return false
}

/**
 * Check whether a path clause extracted from the source AC is satisfied by
 * the actual code under `workingDir`. Story 58-9c: handles relative paths
 * (e.g., `./discover.ts`) that the v0.20.15 literal `join(workingDir, path)`
 * check mis-resolved.
 *
 * Resolution strategy (in order):
 *   1. Literal `workingDir/path` — handles absolute paths and dot-stripped relatives.
 *   2. If the original started with `./`, strip the prefix and retry step 1.
 *   3. Basename search under workingDir — finds paths that live in an
 *      unstated directory context (common for relative imports in ACs).
 *
 * Any hit is treated as "code satisfies" (stylistic drift → warn). No hit
 * means architectural drift → error.
 */
function pathSatisfiedByCode(workingDir: string, pathClause: string): boolean {
  // Strip surrounding backticks
  const raw = pathClause.replace(/^`/, '').replace(/`$/, '')

  // Step 1: literal join (covers absolute-style paths like `packages/foo.ts`)
  if (existsSync(join(workingDir, raw))) return true

  // Step 2: strip leading `./` and retry (covers `./foo.ts` where the path is
  // relative to some directory context in the source AC)
  if (raw.startsWith('./')) {
    if (existsSync(join(workingDir, raw.slice(2)))) return true
  }

  // Step 3: basename search. Limited to relative-looking paths (contains no
  // absolute-from-project-root signal) so we don't do a costly walk for a
  // genuinely missing fully-qualified path.
  const isLikelyRelative = raw.startsWith('./') || !raw.includes('/')
  if (isLikelyRelative) {
    return existsAnywhereUnderRoot(workingDir, basename(raw))
  }

  return false
}

/**
 * Story 60-3 (Sprint 11B): check whether the path clause is referenced from
 * THIS story's modified files. Strata obs_2026-04-25_011 surfaced a case where
 * `pathSatisfiedByCode` returned true (path exists in repo) but the story's
 * own code did not actually use the path — the directory was created earlier
 * by a different story (1-17 in strata's case) and 1-10's `packages/memory-mcp/`
 * code never imported `packages/mesh-agent`. The fidelity check then annotated
 * the missing path as "stylistic drift — code satisfies it", obscuring real
 * under-delivery.
 *
 * This check closes that gap: when path exists in repo AND a list of
 * modified files is available, scan those modified files for an import /
 * require / use reference to the path's basename. If references exist, the
 * story's code does use the path → genuinely stylistic drift. If references
 * are absent, the story's code does not use the path → architectural
 * under-delivery (downgrade severity from warn to error).
 *
 * Conservative behavior: when modifiedFiles is empty (dev didn't report a
 * file list, or a Tier B re-verification context), preserves the existing
 * "code satisfies → warn" behavior. Only TIGHTENS when authoritative
 * file-list signal is present.
 */
function pathReferencedInModifiedFiles(
  workingDir: string,
  pathClause: string,
  modifiedFiles: string[],
): boolean {
  if (modifiedFiles.length === 0) return true // no signal → benefit of doubt

  const raw = pathClause.replace(/^`/, '').replace(/`$/, '')
  // Use the final non-extension segment as the lookup token. For
  // `packages/mesh-agent` → token `mesh-agent`. For `path/to/foo.ts` → token `foo`.
  const baseWithExt = basename(raw)
  const token = baseWithExt.replace(/\.[a-z]+$/i, '')
  // Tokens shorter than 3 chars are too generic to be meaningful (e.g., `db`,
  // `ts`) — give benefit of doubt to avoid false negatives.
  if (token.length < 3) return true

  // Build a separator-tolerant regex pattern. Cross-language imports normalize
  // separators differently:
  //   TS/JS: `from '@foo/mesh-agent'` (kebab preserved)
  //   Python: `from mesh_agent import` (snake — Python identifiers can't have hyphens)
  //   Go: `import ".../mesh-agent"` (kebab preserved)
  //   Rust: `use mesh_agent::` (snake — Rust identifier rule)
  // Replace `-` and `_` in the token with `[-_]` so kebab tokens match snake imports
  // and vice versa. Escape other regex metacharacters.
  const escapedSeparatorTolerant = token
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[-_]/g, '[-_]')
  // Import-style reference: line begins with import/from/require/use/mod
  // (whitespace tolerated) and contains the token. Anchored to line start
  // to avoid false-positives where the comment text "import" appears
  // alongside a token reference (e.g., a comment like "# does NOT import X").
  const importPattern = new RegExp(
    `^\\s*(?:import|from|require|use|mod)\\b[^\\n]*\\b${escapedSeparatorTolerant}\\b`,
    'mi',
  )
  // Also catch package.json deps and other bare references that aren't
  // imports per se but still indicate the story wired the path in.
  const barePattern = new RegExp(`\\b${escapedSeparatorTolerant}\\b`, 'i')

  for (const filePath of modifiedFiles) {
    let content: string
    try {
      content = readFileSync(join(workingDir, filePath), 'utf-8')
    } catch {
      continue
    }
    if (importPattern.test(content)) return true
    // For package.json or yaml config files, accept bare reference.
    if (filePath.endsWith('package.json') || filePath.endsWith('.yaml') || filePath.endsWith('.yml') || filePath.endsWith('.toml')) {
      if (barePattern.test(content)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Hard-clause extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the story's section from the full epic content.
 *
 * Uses the same heading pattern as `isImplicitlyCovered` in the monolith:
 *   `### Story <storyKey>:` or `### Story <storyKey> ` or `### Story <storyKey>\n`
 *
 * Returns the extracted section text (from the heading match through to the
 * next `### Story` heading or end of file), or the full content if no
 * matching heading is found.
 */
function extractStorySection(epicContent: string, storyKey: string): string {
  const escapedKey = storyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingPattern = new RegExp(`^###\\s+Story\\s+${escapedKey}[:\\s]`, 'm')
  const match = headingPattern.exec(epicContent)
  if (!match) {
    // No matching heading — return full content so clauses can still be found
    return epicContent
  }
  const start = match.index
  // Find the next `### Story ` heading after the match
  const nextHeading = /\n### Story /m.exec(epicContent.slice(start + 1))
  if (nextHeading) {
    return epicContent.slice(start, start + 1 + nextHeading.index)
  }
  return epicContent.slice(start)
}

type HardClause = {
  type: 'MUST NOT' | 'MUST' | 'SHALL NOT' | 'SHALL' | 'path' | 'runtime-probes-section'
  /** The raw text of the clause (used for substring matching against storyContent) */
  text: string
}

/**
 * Extract hard clauses from a story section of an epic file.
 *
 * Hard clauses:
 *   1. Lines containing MUST NOT / MUST / SHALL NOT / SHALL as standalone keywords (case-sensitive)
 *   2. Backtick-wrapped paths with at least one `/` (excludes bare filenames)
 *   3. The presence of `## Runtime Probes` heading followed by a fenced yaml block
 *      (represented as a single "runtime-probes-section" clause)
 */
function extractHardClauses(sectionContent: string): HardClause[] {
  const clauses: HardClause[] = []

  // --- MUST NOT / MUST / SHALL NOT / SHALL lines ---
  // Word-boundary match, case-sensitive, captures the whole line.
  // Order matters: MUST NOT before MUST, SHALL NOT before SHALL to avoid double-matching.
  const mustPattern = /\b(MUST NOT|MUST|SHALL NOT|SHALL)\b/
  const lines = sectionContent.split('\n')
  for (const line of lines) {
    const match = mustPattern.exec(line)
    if (match) {
      const keyword = match[1] as HardClause['type']
      clauses.push({ type: keyword, text: line.trim() })
    }
  }

  // --- Backtick-wrapped paths with at least one slash ---
  // Match `path/with/at-least-one-slash` — excludes bare `filename.ts`
  const pathPattern = /`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_./-]+)`/g
  let pathMatch: RegExpExecArray | null
  while ((pathMatch = pathPattern.exec(sectionContent)) !== null) {
    // The full backtick-wrapped expression (including backticks) is the clause text
    // so the literal substring match against storyContent checks the exact same form.
    clauses.push({ type: 'path', text: `\`${pathMatch[1]}\`` })
  }

  // --- Runtime Probes section ---
  // Detect ## Runtime Probes heading followed by a fenced yaml block
  const probesPattern = /^##\s+Runtime Probes[\s\S]*?```yaml/m
  if (probesPattern.test(sectionContent)) {
    clauses.push({ type: 'runtime-probes-section', text: '## Runtime Probes' })
  }

  return clauses
}

// ---------------------------------------------------------------------------
// SourceAcFidelityCheck
// ---------------------------------------------------------------------------

export class SourceAcFidelityCheck implements VerificationCheck {
  readonly name = 'source-ac-fidelity'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    // AC2: When sourceEpicContent is absent or empty, emit warn and pass.
    if (!context.sourceEpicContent) {
      const findings: VerificationFinding[] = [
        {
          category: 'source-ac-source-unavailable',
          severity: 'warn',
          message: 'source epic content unavailable — skipping fidelity check',
        },
      ]
      return {
        status: 'pass',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // Extract the story's section from the epic content
    const storySection = extractStorySection(context.sourceEpicContent, context.storyKey)

    // Extract all hard clauses from the story section
    const hardClauses = extractHardClauses(storySection)

    const findings: VerificationFinding[] = []
    const storyContent = context.storyContent ?? ''

    for (const clause of hardClauses) {
      if (clause.type === 'runtime-probes-section') {
        // Special handling: check whether the story artifact contains ## Runtime Probes
        if (!storyContent.includes('## Runtime Probes')) {
          const truncated = clause.text.length > 120 ? clause.text.slice(0, 120) : clause.text
          findings.push({
            category: 'source-ac-drift',
            // Story 58-9: source-ac-fidelity findings are advisory (warn)
            // during calibration. Strata observation obs_2026-04-21_004 flagged
            // false positives where the dev-produced CODE satisfied the source
            // AC but the rendered artifact paraphrased a MUST clause or
            // omitted a path string — the substring matcher flagged drift
            // that wasn't a real correctness issue. Keeping findings visible
            // (in verification_findings.warn counters) but non-blocking until
            // the matcher distinguishes architectural drift from stylistic
            // paraphrase. Flip back to 'error' once false-positive rate is
            // low (see 58-9b: path-in-code cross-reference).
            severity: 'warn',
            message: `runtime-probes-section: "${truncated}" present in epics source but absent in story artifact`,
          })
        }
      } else {
        // Literal substring match for MUST/SHALL lines and path clauses
        if (!storyContent.includes(clause.text)) {
          const truncated = clause.text.length > 120 ? clause.text.slice(0, 120) : clause.text

          // Story 58-9b: for path clauses, distinguish architectural drift
          // (path missing from BOTH artifact and code) from stylistic drift
          // (path exists in code — artifact paraphrased). Architectural
          // drift hard-gates at error-severity; stylistic drift stays
          // advisory at warn-severity. MUST/SHALL keyword clauses have no
          // code-observable signal, so they remain advisory warn.
          //
          // The 58-9b cross-reference closes the calibration loop started
          // in 58-9: now real drift (like strata 1-9's missing
          // `adjacency-store.ts`) hard-gates, while artifact-paraphrase
          // false positives (like strata 1-7's unquoted `./discover.ts`)
          // pass through as advisory.
          if (clause.type === 'path') {
            // Story 58-9c: delegated to pathSatisfiedByCode which handles
            // literal / dot-stripped / basename-search resolution so
            // relative-path source ACs (e.g., `./discover.ts`) are correctly
            // classified. v0.20.15's literal `join(workingDir, path)` check
            // false-positive-errored on relative paths; this restores the
            // stylistic-vs-architectural distinction across path styles.
            const existsInCode = pathSatisfiedByCode(context.workingDir, clause.text)

            // Story 60-3 (Sprint 11B): tighten "code satisfies → stylistic
            // drift" annotation. Strata obs_2026-04-25_011: path
            // `packages/mesh-agent` existed in repo (created by Story 1.17)
            // but 1-10's code never imported it; the check annotated the
            // miss as stylistic drift, masking real under-delivery. When
            // the dev-story result reports a list of modified files, check
            // whether THIS story's code references the path. References
            // present → genuinely stylistic. References absent → path
            // exists from prior work but this story didn't wire it →
            // architectural under-delivery.
            const modifiedFiles = context.devStoryResult?.files_modified ?? []
            const referencedByStory = pathReferencedInModifiedFiles(
              context.workingDir,
              clause.text,
              modifiedFiles,
            )

            let severity: 'warn' | 'error'
            let driftMessage: string
            if (!existsInCode) {
              severity = 'error'
              driftMessage = `${clause.type}: "${truncated}" present in epics source but absent in story artifact AND missing from code (architectural drift)`
            } else if (!referencedByStory) {
              severity = 'error'
              driftMessage = `${clause.type}: "${truncated}" present in epics source but absent in story artifact AND code path exists in repo but THIS story's modified files do not reference it (under-delivery — code path was created by a different story; this story did not wire it in)`
            } else {
              severity = 'warn'
              driftMessage = `${clause.type}: "${truncated}" present in epics source but absent in story artifact (code satisfies it — stylistic drift)`
            }
            findings.push({
              category: 'source-ac-drift',
              severity,
              message: driftMessage,
            })
          } else {
            // MUST/SHALL keyword clauses — no code-observable signal, stay advisory.
            findings.push({
              category: 'source-ac-drift',
              severity: 'warn',
              message: `${clause.type}: "${truncated}" present in epics source but absent in story artifact`,
            })
          }
        }
      }
    }

    const status = findings.some((f) => f.severity === 'error') ? 'fail' : 'pass'

    return {
      status,
      details:
        findings.length > 0
          ? renderFindings(findings)
          : `source-ac-fidelity: ${hardClauses.length} hard clause(s) verified — all present`,
      duration_ms: Date.now() - start,
      findings,
    }
  }
}
