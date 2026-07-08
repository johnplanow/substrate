/**
 * AcceptanceSpecCheck — Tier A tripwire for acceptance-spec tampering
 * (A1.3, acceptance-gate program).
 *
 * The acceptance gate's inputs (journey registry, operator deferrals, the
 * profile's acceptance contract) are planning/operator-authored and read from
 * the TRUSTED tree — but an implementing agent can still rewrite its WORKTREE
 * copies, and in merge mode those edits would LAND and quietly change every
 * future audit (weaken end-states, defer the journey it didn't wire, launder
 * the render command). This check converts that known H7-class evasion into
 * a deterministic tripwire: any divergence between the worktree copy and the
 * trusted copy FAILS verification, naming the file.
 *
 * Also (AC2): a story diff touching the contract's declared fixtures path is
 * a WARN (`acceptance-fixture-mutation`) — fixture evolution stays possible,
 * it just can't be silent (the judge grounds verdicts in those fixtures).
 *
 * Absent guard context (no worktree dispatch / acceptance not configured) →
 * trivially passes. FR-V9: no LLM; pure content comparison.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationResult,
  VerificationFinding,
} from '../types.js'
import { renderFindings } from '../findings.js'
import { JOURNEY_REGISTRY_PATH } from '../../acceptance/registry.js'
import { JOURNEY_DEFERRALS_PATH } from '../../acceptance/coverage.js'
import { ACCEPTANCE_CONTRACT_PROFILE_PATH, parseAcceptanceContract } from '../../acceptance/contract.js'

async function readWorktreeCopy(workingDir: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(join(workingDir, relPath), 'utf-8')
  } catch {
    return null
  }
}

const norm = (s: string | null): string | null => (s === null ? null : s.replace(/\r\n/g, '\n').trim())

/** Compare only the acceptance BLOCK of the profile (other profile keys are ContaminationCheck/H7 territory). */
function acceptanceBlockFingerprint(profileContent: string | null): string {
  if (profileContent === null) return 'absent'
  const parsed = parseAcceptanceContract(profileContent)
  if (parsed.status === 'absent') return 'absent'
  if (parsed.status === 'invalid') return 'invalid:' + JSON.stringify(parsed.issues)
  return JSON.stringify(parsed.contract)
}

export class AcceptanceSpecCheck implements VerificationCheck {
  readonly name = 'acceptance-spec'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()
    const guard = context.acceptanceSpecGuard
    if (guard === undefined) {
      return {
        status: 'pass',
        details: 'no acceptance spec guard in context (acceptance not configured or non-worktree dispatch)',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }

    const findings: VerificationFinding[] = []

    // Raw-content specs: registry + deferrals. Divergence in EITHER direction
    // is tampering — a worktree-introduced spec would land on merge and change
    // future audits just as surely as an edit.
    const rawSpecs: { path: string; trusted: string | null }[] = [
      { path: JOURNEY_REGISTRY_PATH, trusted: guard.journeysTrusted },
      { path: JOURNEY_DEFERRALS_PATH, trusted: guard.deferralsTrusted },
    ]
    for (const spec of rawSpecs) {
      const worktree = await readWorktreeCopy(context.workingDir, spec.path)
      const trustedNorm = norm(spec.trusted)
      const worktreeNorm = norm(worktree)
      if (trustedNorm === worktreeNorm) continue
      const shape =
        trustedNorm === null
          ? 'INTRODUCED in the story worktree (acceptance specs are planning/operator-authored, never story output)'
          : worktreeNorm === null
            ? 'DELETED in the story worktree'
            : 'DIVERGES from the trusted copy'
      findings.push({
        category: 'acceptance-spec-tampered',
        severity: 'error',
        message:
          `${spec.path} ${shape}. The acceptance gate reads the trusted tree, so this edit cannot fool the ` +
          `current audit — but merging it would change every FUTURE audit. Revert it or make the change ` +
          `through planning (operator commit outside a story).`,
      })
    }

    // Profile: compare only the acceptance block.
    const worktreeProfile = await readWorktreeCopy(context.workingDir, ACCEPTANCE_CONTRACT_PROFILE_PATH)
    const trustedFp = acceptanceBlockFingerprint(guard.profileTrusted)
    const worktreeFp = acceptanceBlockFingerprint(worktreeProfile)
    if (trustedFp !== worktreeFp) {
      findings.push({
        category: 'acceptance-spec-tampered',
        severity: 'error',
        message:
          `the acceptance: contract block in ${ACCEPTANCE_CONTRACT_PROFILE_PATH} differs between the story ` +
          `worktree and the trusted tree (render-command laundering shape). Revert the worktree edit.`,
      })
    }

    // AC2: fixture mutations — warn, never silent.
    if (guard.fixturesPath !== undefined) {
      const prefix = guard.fixturesPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
      const touched = (context.changedFiles ?? []).filter((f) => {
        const n = f.replace(/\\/g, '/')
        return n.startsWith(prefix) || n === prefix.slice(0, -1)
      })
      if (touched.length > 0) {
        findings.push({
          category: 'acceptance-fixture-mutation',
          severity: 'warn',
          message:
            `story modified ${String(touched.length)} file(s) under the declared acceptance fixtures path ` +
            `(${guard.fixturesPath}): ${touched.slice(0, 10).join(', ')}` +
            (touched.length > 10 ? ` (+${String(touched.length - 10)} more)` : '') +
            `. The judge grounds verdicts in these fixtures — review whether the change tilts the walk.`,
        })
      }
    }

    if (findings.length === 0) {
      return {
        status: 'pass',
        details: 'acceptance specs match the trusted tree; no fixture mutations',
        duration_ms: Date.now() - start,
        findings: [],
      }
    }
    const hasError = findings.some((f) => f.severity === 'error')
    return {
      status: hasError ? 'fail' : 'warn',
      details: renderFindings(findings),
      duration_ms: Date.now() - start,
      findings,
    }
  }
}
