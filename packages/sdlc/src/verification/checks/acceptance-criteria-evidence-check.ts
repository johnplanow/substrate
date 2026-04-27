/**
 * AcceptanceCriteriaEvidenceCheck.
 *
 * Tier A verification check that compares a story's declared acceptance
 * criteria against structured dev-story output. The check is deterministic
 * (no LLM calls, no shell commands) but as of Story 61-7 it may inspect
 * `dev_story_signals.files_modified` content and the working tree filesystem
 * to find code-evidence for ACs the dev under-claimed. Repository inspection
 * is bounded to files explicitly listed in files_modified — no crawling.
 */

import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import type {
  DevStorySignals,
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from '../types.js'
import { renderFindings } from '../findings.js'

const EXPLICIT_AC_REF = /\bAC\s*:?\s*#?\s*(\d+)\b/gi
const NUMBERED_CRITERION = /^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(\d+)[.)]\s+\S/

function normalizeAcId(value: string): string | undefined {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return `AC${parsed}`
}

function sortAcIds(ids: Iterable<string>): string[] {
  return Array.from(ids).sort((a, b) => {
    const aNum = Number.parseInt(a.replace(/^AC/i, ''), 10)
    const bNum = Number.parseInt(b.replace(/^AC/i, ''), 10)
    return aNum - bNum
  })
}

function addExplicitAcRefs(text: string, ids: Set<string>): void {
  EXPLICIT_AC_REF.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EXPLICIT_AC_REF.exec(text)) !== null) {
    const id = normalizeAcId(match[1] ?? '')
    if (id !== undefined) ids.add(id)
  }
}

function extractAcceptanceSection(storyContent: string): string | undefined {
  const lines = storyContent.split(/\r?\n/)
  // Story 61-4: section detection now also recognizes the bold-paragraph
  // form `**Acceptance Criteria**:` (with optional trailing colon and
  // text on the same line) in addition to the heading form
  // `## Acceptance Criteria`. The bold form is common in per-epic
  // planning files (substrate's own _bmad-output/planning-artifacts/
  // convention) where the AC section is a paragraph under a `### Story
  // X:` heading rather than its own `##` heading.
  //
  // Boundary mode tracks how the section started so the end-detection can
  // use the right rule: heading-started sections end at next `##` or
  // `### Story`; bold-paragraph sections end at next `**Bold**:` paragraph
  // OR next `##`/`### Story`.
  let mode: 'heading' | 'bold' | undefined
  const start = lines.findIndex((line) => {
    const trimmed = line.trim()
    if (/^##\s+Acceptance Criteria\s*$/i.test(trimmed)) {
      mode = 'heading'
      return true
    }
    if (/^\*\*Acceptance Criteria\*\*:?/i.test(trimmed)) {
      mode = 'bold'
      return true
    }
    return false
  })
  if (start === -1) return undefined

  let end = lines.length
  // Section ends at the next ## heading OR the next ### Story heading
  // (Story 61-4: per-epic files have ### Story siblings as the natural
  // section boundary; without this, AC-section bleeds into the next
  // story's content). Bold-paragraph sections additionally end at the
  // next `**SomethingElse**:` bold-paragraph marker — that's the natural
  // sibling boundary in the per-epic-file convention.
  const BOLD_PARA_BOUNDARY = /^\*\*[A-Za-z][A-Za-z\s]*\*\*:/
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (/^##\s+\S/.test(line)) {
      end = i
      break
    }
    if (/^###\s+Story\s+/i.test(line)) {
      end = i
      break
    }
    if (mode === 'bold' && BOLD_PARA_BOUNDARY.test(line.trim())) {
      end = i
      break
    }
  }

  return lines.slice(start + 1, end).join('\n')
}

/**
 * Extract normalized AC ids from story markdown.
 *
 * Supports the BMAD default format (`### AC1:`), explicit references such as
 * `AC: #1`, plain numbered criteria inside the Acceptance Criteria section,
 * and (Story 61-4) bullet-format ACs where each bullet line under the
 * Acceptance Criteria section becomes an implicit AC numbered by position
 * (first bullet → AC1, second → AC2, etc.). Bullet-format inference fires
 * only when no numbered or explicit-ref ACs were found, so projects mixing
 * conventions favor the explicit signal.
 */
export function extractAcceptanceCriteriaIds(storyContent: string): string[] {
  const ids = new Set<string>()
  const acceptanceSection = extractAcceptanceSection(storyContent)
  const textToScan = acceptanceSection ?? storyContent

  addExplicitAcRefs(textToScan, ids)

  if (acceptanceSection !== undefined) {
    for (const line of acceptanceSection.split(/\r?\n/)) {
      const match = line.match(NUMBERED_CRITERION)
      if (match?.[1] !== undefined) {
        const id = normalizeAcId(match[1])
        if (id !== undefined) ids.add(id)
      }
    }

    // Story 61-4: bullet-format inference. When no explicit AC refs and
    // no numbered criteria were found, count `- ...` bullets in the
    // section as implicit AC1, AC2, AC3 in order. Closes the case
    // surfaced by the 60-12 dispatch where bullet-format ACs in the
    // story file produced a `no numbered acceptance criteria found`
    // warn even though the dev signaled all 9 ACs met.
    if (ids.size === 0) {
      let bulletPosition = 0
      for (const line of acceptanceSection.split(/\r?\n/)) {
        // Match bullet lines but NOT lines like `**Bold**:` continuations,
        // checkbox lines, or numbered items (already handled above).
        if (/^\s*[-*]\s+\S/.test(line) && !NUMBERED_CRITERION.test(line)) {
          bulletPosition += 1
          const id = normalizeAcId(String(bulletPosition))
          if (id !== undefined) ids.add(id)
        }
      }
    }
  }

  return sortAcIds(ids)
}

function extractClaimedAcceptanceCriteriaIds(values: string[] | undefined): string[] {
  const ids = new Set<string>()

  for (const value of values ?? []) {
    addExplicitAcRefs(value, ids)

    const bareNumber = value.trim().match(/^#?(\d+)\b/)
    if (bareNumber?.[1] !== undefined) {
      const id = normalizeAcId(bareNumber[1])
      if (id !== undefined) ids.add(id)
    }
  }

  return sortAcIds(ids)
}

function normalizeTestOutcome(value: DevStorySignals['tests']): 'pass' | 'fail' | undefined {
  if (value === undefined) return undefined
  return value.toLowerCase().includes('fail') ? 'fail' : 'pass'
}

function formatIds(ids: string[]): string {
  return ids.join(', ')
}

export class AcceptanceCriteriaEvidenceCheck implements VerificationCheck {
  readonly name = 'acceptance-criteria-evidence'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()
    const storyContent = context.storyContent?.trim()

    if (!storyContent) {
      const findings: VerificationFinding[] = [
        {
          category: 'ac-context-missing',
          severity: 'warn',
          message: 'story content unavailable - skipping AC evidence check',
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const expectedIds = extractAcceptanceCriteriaIds(storyContent)
    if (expectedIds.length === 0) {
      const findings: VerificationFinding[] = [
        {
          category: 'ac-context-missing',
          severity: 'warn',
          message: 'no numbered acceptance criteria found in story',
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const devResult = context.devStoryResult
    if (devResult === undefined) {
      const findings: VerificationFinding[] = [
        {
          category: 'ac-context-missing',
          severity: 'warn',
          message: `dev-story result unavailable for ${formatIds(expectedIds)}`,
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const acFailures = devResult.ac_failures ?? []
    if (acFailures.length > 0) {
      // Story 55-2 AC3: one finding per claimed failure, each naming the AC
      const findings: VerificationFinding[] = acFailures.map((failure) => ({
        category: 'ac-explicit-failure',
        severity: 'error',
        message: `dev-story reported AC failure: ${failure}`,
      }))
      return {
        status: 'fail',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const testOutcome = normalizeTestOutcome(devResult.tests)
    if (testOutcome === 'fail') {
      const findings: VerificationFinding[] = [
        {
          category: 'ac-test-failure',
          severity: 'error',
          message: 'dev-story reported failing tests',
        },
      ]
      return {
        status: 'fail',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    const claimedIds = new Set(extractClaimedAcceptanceCriteriaIds(devResult.ac_met))
    const missingIds = expectedIds.filter((id) => !claimedIds.has(id))
    if (missingIds.length > 0) {
      // Story 61-7: when an AC is missing from the dev's claim list, look for
      // code-evidence in files_modified before failing. This avoids
      // false-positive escalations where the dev under-claimed but the
      // implementation IS done. Surfaced by 60-12 round 4: dev claimed
      // AC1-AC9 of 10 spec bullets; AC10's deliverable
      // (probe-author.test.ts) was demonstrably present.
      //
      // Evidence sources (any one suffices to downgrade error→info):
      //  1. AC text mentions a file path that's in dev_story_signals.files_modified
      //  2. A test file in files_modified mentions the AC by id (e.g., AC10:)
      //  3. AC text mentions a path that exists in the working tree
      const acceptanceTexts = extractAcceptanceCriteriaTexts(storyContent)
      const filesModified = devResult.files_modified ?? []
      const claimedSummary = formatIds(sortAcIds(claimedIds)) || 'none'

      // Story 55-2 AC3: one finding per missing AC id so consumers can address them individually
      const findings: VerificationFinding[] = missingIds.map((id) => {
        const acText = acceptanceTexts.get(id) ?? ''
        const evidence = findCodeEvidence({
          acId: id,
          acText,
          filesModified,
          workingDir: context.workingDir,
        })

        if (evidence.found) {
          return {
            category: 'ac-missing-evidence-claim',
            severity: 'info' as const,
            message:
              `dev-story did not claim ${id} but code-evidence was found: ${evidence.reason}` +
              ` (expected ${formatIds(expectedIds)}, claimed ${claimedSummary})`,
          }
        }

        return {
          category: 'ac-missing-evidence',
          severity: 'error' as const,
          message:
            `missing dev-story AC evidence for ${id}` +
            ` (expected ${formatIds(expectedIds)}, claimed ${claimedSummary})`,
        }
      })

      const hasErrorFinding = findings.some((f) => f.severity === 'error')
      return {
        status: hasErrorFinding ? 'fail' : 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    if (testOutcome === undefined) {
      const findings: VerificationFinding[] = [
        {
          category: 'ac-test-outcome-missing',
          severity: 'warn',
          message: `AC evidence covers ${formatIds(expectedIds)} but test outcome is unavailable`,
        },
      ]
      return {
        status: 'warn',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    return {
      status: 'pass',
      details: `acceptance-criteria-evidence: AC evidence covers ${formatIds(expectedIds)}; tests=${testOutcome}`,
      duration_ms: Date.now() - start,
      findings: [],
    }
  }
}

// ---------------------------------------------------------------------------
// Story 61-7: per-AC text extraction + code-evidence detection
// ---------------------------------------------------------------------------

/**
 * Build a per-AC text map (id → AC body text). Used by the code-evidence
 * fallback (Story 61-7) when an AC is missing from the dev's claim list —
 * the AC's text drives path-token extraction so we can look for evidence
 * that the work was done despite the under-claim.
 *
 * Resolution order per AC id:
 *  1. Lines in the acceptance section that explicitly mention `AC<N>` or
 *     `AC: #<N>` are concatenated.
 *  2. If no explicit mention, fall back to position: the Nth bullet
 *     (`- ...`) under the section is AC<N>'s text.
 *  3. If no bullets, the Nth numbered item (`<N>. ...`).
 */
export function extractAcceptanceCriteriaTexts(storyContent: string): Map<string, string> {
  const result = new Map<string, string>()
  const section = extractAcceptanceSection(storyContent)
  if (section === undefined) return result

  const lines = section.split(/\r?\n/)

  // Explicit refs: collect all lines mentioning each AC id
  const explicitByNum = new Map<number, string[]>()
  const explicitRefRe = /\bAC\s*:?\s*#?\s*(\d+)\b/gi
  for (const line of lines) {
    explicitRefRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = explicitRefRe.exec(line)) !== null) {
      const n = Number.parseInt(m[1] ?? '', 10)
      if (!Number.isFinite(n) || n <= 0) continue
      const list = explicitByNum.get(n) ?? []
      if (!list.includes(line)) list.push(line)
      explicitByNum.set(n, list)
    }
  }

  // Position-based bullets and numbered items
  const bulletLines: string[] = []
  const numberedLines: string[] = []
  for (const line of lines) {
    if (/^\s*[-*]\s+\S/.test(line) && !/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(\d+)[.)]\s+\S/.test(line)) {
      bulletLines.push(line)
    }
    if (/^\s*(?:[-*]\s*)?(?:\[[ xX]\]\s*)?(\d+)[.)]\s+\S/.test(line)) {
      numberedLines.push(line)
    }
  }

  // Merge results: explicit refs win, fall through to position-based otherwise
  const allNums = new Set<number>([
    ...Array.from(explicitByNum.keys()),
    ...Array.from({ length: Math.max(bulletLines.length, numberedLines.length) }, (_, i) => i + 1),
  ])
  for (const n of allNums) {
    const explicit = explicitByNum.get(n)
    if (explicit && explicit.length > 0) {
      result.set(`AC${n}`, explicit.join('\n'))
      continue
    }
    if (n - 1 < bulletLines.length) {
      result.set(`AC${n}`, bulletLines[n - 1] ?? '')
      continue
    }
    if (n - 1 < numberedLines.length) {
      result.set(`AC${n}`, numberedLines[n - 1] ?? '')
    }
  }

  return result
}

/**
 * Recognized source/test extensions for path-token extraction. Mirrors
 * scope-guardrail.ts's RECOGNIZED_EXTENSIONS but lives here to avoid a
 * cross-package import (sdlc cannot depend on src/modules).
 */
const PATH_TOKEN_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx',
  '.md', '.json', '.yaml', '.yml',
  '.py', '.go', '.java', '.rb', '.rs',
  '.sh', '.css', '.scss', '.html',
]

/**
 * Extract path-like tokens from arbitrary text. A path-like token contains
 * `/`, has a recognized extension, and contains no whitespace.
 */
function extractPathTokens(text: string): string[] {
  if (text === '') return []
  const tokens = new Set<string>()

  // Backtick-wrapped paths
  const backtickRe = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = backtickRe.exec(text)) !== null) {
    const candidate = (m[1] ?? '').trim()
    if (looksLikePath(candidate)) tokens.add(candidate)
  }

  // Whitespace-delimited tokens (after stripping backtick content to avoid double-counting)
  const stripped = text.replace(/`[^`]+`/g, ' ')
  for (const raw of stripped.split(/\s+/)) {
    const clean = raw.replace(/[,;:()\[\]{}'"]+$/g, '').replace(/^[,;:()\[\]{}'"]+/g, '')
    if (looksLikePath(clean)) tokens.add(clean)
  }

  return Array.from(tokens)
}

function looksLikePath(candidate: string): boolean {
  if (candidate === '' || /\s/.test(candidate)) return false
  if (!candidate.includes('/')) return false
  return PATH_TOKEN_EXTENSIONS.some((ext) => candidate.endsWith(ext))
}

function isTestFilePath(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('__tests__/') ||
    filePath.includes('__tests__\\') ||
    filePath.includes('/__tests__') ||
    filePath.includes('\\__tests__')
  )
}

/**
 * Find code-evidence that an unclaimed AC was actually implemented.
 *
 * Returns `{ found: true, reason }` when any of the three checks succeeds:
 *  1. AC text mentions a file path that's in `filesModified` (exact or basename match)
 *  2. AC text mentions a path that exists in the working tree
 *  3. A test file in `filesModified` contains the AC id (e.g., `AC10`)
 *
 * Returns `{ found: false }` otherwise.
 */
function findCodeEvidence(opts: {
  acId: string
  acText: string
  filesModified: string[]
  workingDir: string
}): { found: boolean; reason?: string } {
  const { acId, acText, filesModified, workingDir } = opts

  const tokens = extractPathTokens(acText)

  // Check 1: AC text mentions a path in files_modified (exact match)
  for (const token of tokens) {
    if (filesModified.includes(token)) {
      return { found: true, reason: `AC text references ${token}, which is in files_modified` }
    }
  }

  // Check 1b: basename match (more lenient — AC mentions `probe-author.test.ts`,
  // files_modified contains `src/.../probe-author.test.ts`)
  for (const token of tokens) {
    const base = path.basename(token)
    const match = filesModified.find((f) => path.basename(f) === base)
    if (match !== undefined) {
      return { found: true, reason: `AC text references ${token}; matching basename ${match} is in files_modified` }
    }
  }

  // Check 2: AC text mentions a path that exists in the working tree
  for (const token of tokens) {
    try {
      if (existsSync(path.join(workingDir, token))) {
        return { found: true, reason: `AC text references ${token}, which exists in working tree` }
      }
    } catch {
      // ignore — defensive against unusable workingDir or permission errors
    }
  }

  // Check 3: any test file in files_modified mentions the AC id
  const num = acId.replace(/^AC/i, '')
  if (num !== '') {
    const acMentionRe = new RegExp(`\\bAC\\s*:?\\s*#?\\s*${num}\\b`, 'i')
    const testFiles = filesModified.filter(isTestFilePath)
    for (const testFile of testFiles) {
      try {
        const content = readFileSync(path.join(workingDir, testFile), 'utf-8')
        if (acMentionRe.test(content)) {
          return { found: true, reason: `${testFile} mentions ${acId}` }
        }
      } catch {
        // file unreadable / nonexistent — skip
      }
    }
  }

  return { found: false }
}
