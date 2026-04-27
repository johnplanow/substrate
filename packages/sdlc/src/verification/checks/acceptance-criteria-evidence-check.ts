/**
 * AcceptanceCriteriaEvidenceCheck.
 *
 * Tier A verification check that compares a story's declared acceptance
 * criteria against structured dev-story output. The check is intentionally
 * deterministic: no LLM calls, no shell commands, no repository inspection.
 */

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
      // Story 55-2 AC3: one finding per missing AC id so consumers can address them individually
      const claimedSummary = formatIds(sortAcIds(claimedIds)) || 'none'
      const findings: VerificationFinding[] = missingIds.map((id) => ({
        category: 'ac-missing-evidence',
        severity: 'error',
        message:
          `missing dev-story AC evidence for ${id}` +
          ` (expected ${formatIds(expectedIds)}, claimed ${claimedSummary})`,
      }))
      return {
        status: 'fail',
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
