/**
 * TestMutationCheck — Tier A tripwire for reward-hack-shaped test edits
 * (H1.7, hardening program).
 *
 * Measured agent exploit pattern (2026 reward-hacking studies; exploit rates
 * up to ~14% on weaker models): instead of fixing code, edit or delete the
 * failing tests so the suite goes green. A story that MODIFIES pre-existing
 * test files it didn't create deserves operator attention — sometimes it's a
 * legitimate refactor, which is why this is a WARN (operator-visible in the
 * escalation/report surface), never a lone failure.
 *
 * Input is `context.modifiedTrackedFiles` — the tracked-diff portion of the
 * story's change (files that existed BEFORE the dispatch), captured by the
 * orchestrator. New test files the story wrote never appear there, so adding
 * tests stays silent. FR-V9: no LLM; pure path inspection.
 */

import type {
  VerificationCheck,
  VerificationContext,
  VerificationResult,
  VerificationFinding,
} from '../types.js'
import { renderFindings } from '../findings.js'

/** Heuristic: is this path a test file? Covers the JS/TS/Python/Go idioms. */
export function isTestPath(file: string): boolean {
  const norm = file.replace(/\\/g, '/').toLowerCase()
  const base = norm.split('/').pop() ?? ''
  if (/(^|\/)(__tests__|tests?)\//.test(norm)) return true
  if (/\.(test|spec)\.[a-z]+$/.test(base)) return true
  if (/^test_.*\.py$/.test(base) || /_test\.(py|go)$/.test(base)) return true
  // H7 (gut-shared-fixture-outside-test-namespace, red-team): shared
  // test-support code that tests IMPORT but which lives outside a tests/
  // directory — gutting it weakens the suite without editing a "test file".
  // conftest.py (pytest, any level), and files under fixtures/ factories/
  // testsupport/ test-support/ __mocks__/.
  if (base === 'conftest.py') return true
  if (/(^|\/)(fixtures|factories|testsupport|test-support|test_support|__mocks__|__fixtures__)\//.test(norm)) return true
  return false
}

export class TestMutationCheck implements VerificationCheck {
  readonly name = 'test-mutation'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()
    const modified = context.modifiedTrackedFiles ?? []
    const mutatedTests = modified.filter(isTestPath)

    if (mutatedTests.length === 0) {
      return {
        status: 'pass',
        details: 'no pre-existing test files were modified',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }

    const findings: VerificationFinding[] = [
      {
        category: 'test-mutation',
        severity: 'warn',
        message:
          `story MODIFIED ${String(mutatedTests.length)} pre-existing test file(s): ` +
          `${mutatedTests.slice(0, 10).join(', ')}` +
          (mutatedTests.length > 10 ? ` (+${String(mutatedTests.length - 10)} more)` : '') +
          `. Editing existing tests to satisfy a suite is the measured reward-hack pattern — ` +
          `review whether these edits weaken assertions the story was supposed to satisfy.`,
      },
    ]
    return {
      status: 'warn',
      details: renderFindings(findings),
      duration_ms: Date.now() - start,
      findings,
    }
  }
}
