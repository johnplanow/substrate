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

import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from './types.js'
import { renderFindings } from './findings.js'

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
            severity: 'error',
            message: `runtime-probes-section: "${truncated}" present in epics source but absent in story artifact`,
          })
        }
      } else {
        // Literal substring match for MUST/SHALL lines and path clauses
        if (!storyContent.includes(clause.text)) {
          const truncated = clause.text.length > 120 ? clause.text.slice(0, 120) : clause.text
          findings.push({
            category: 'source-ac-drift',
            severity: 'error',
            message: `${clause.type}: "${truncated}" present in epics source but absent in story artifact`,
          })
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
