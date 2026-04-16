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
  VerificationResult,
} from '../types.js'

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
  const start = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line.trim()))
  if (start === -1) return undefined

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i] ?? '')) {
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
 * `AC: #1`, and plain numbered criteria inside the Acceptance Criteria section.
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
      return {
        status: 'warn',
        details: 'acceptance-criteria-evidence: story content unavailable - skipping AC evidence check',
        duration_ms: Date.now() - start,
      }
    }

    const expectedIds = extractAcceptanceCriteriaIds(storyContent)
    if (expectedIds.length === 0) {
      return {
        status: 'warn',
        details: 'acceptance-criteria-evidence: no numbered acceptance criteria found in story',
        duration_ms: Date.now() - start,
      }
    }

    const devResult = context.devStoryResult
    if (devResult === undefined) {
      return {
        status: 'warn',
        details: `acceptance-criteria-evidence: dev-story result unavailable for ${formatIds(expectedIds)}`,
        duration_ms: Date.now() - start,
      }
    }

    const acFailures = devResult.ac_failures ?? []
    if (acFailures.length > 0) {
      return {
        status: 'fail',
        details: `acceptance-criteria-evidence: dev-story reported AC failures: ${acFailures.join('; ')}`,
        duration_ms: Date.now() - start,
      }
    }

    const testOutcome = normalizeTestOutcome(devResult.tests)
    if (testOutcome === 'fail') {
      return {
        status: 'fail',
        details: 'acceptance-criteria-evidence: dev-story reported failing tests',
        duration_ms: Date.now() - start,
      }
    }

    const claimedIds = new Set(extractClaimedAcceptanceCriteriaIds(devResult.ac_met))
    const missingIds = expectedIds.filter((id) => !claimedIds.has(id))
    if (missingIds.length > 0) {
      return {
        status: 'fail',
        details:
          `acceptance-criteria-evidence: missing dev-story AC evidence for ${formatIds(missingIds)}` +
          `; expected ${formatIds(expectedIds)}, claimed ${formatIds(sortAcIds(claimedIds)) || 'none'}`,
        duration_ms: Date.now() - start,
      }
    }

    if (testOutcome === undefined) {
      return {
        status: 'warn',
        details: `acceptance-criteria-evidence: AC evidence covers ${formatIds(expectedIds)} but test outcome is unavailable`,
        duration_ms: Date.now() - start,
      }
    }

    return {
      status: 'pass',
      details: `acceptance-criteria-evidence: AC evidence covers ${formatIds(expectedIds)}; tests=${testOutcome}`,
      duration_ms: Date.now() - start,
    }
  }
}
