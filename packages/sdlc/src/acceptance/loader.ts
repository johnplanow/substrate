/**
 * Acceptance Gate — trusted-tree registry loader (story A0.1).
 *
 * TRUSTED-TREE RULE (H7 posture): the registry is read from the main tree at
 * a given ref via `git show` — never from the filesystem of an agent-writable
 * worktree. Worktree isolation is accident-mitigation, not a security
 * boundary; an implementing agent can rewrite its worktree copy of
 * journeys.yaml, but it cannot rewrite the main tree's committed copy that
 * this loader reads. (Divergence between the two is escalated by the A1.3
 * spec-tamper tripwire.)
 *
 * The filesystem loader exists ONLY for operator lint
 * (`substrate acceptance validate`) — gate code must never call it.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNEY_REGISTRY_PATH, parseJourneyRegistry } from './registry.js'
import { JOURNEY_DEFERRALS_PATH, parseJourneyDeferrals } from './coverage.js'
import { ACCEPTANCE_CONTRACT_PROFILE_PATH, parseAcceptanceContract } from './contract.js'
import type { ContractParseResult } from './contract.js'
import type { JourneyDeferral } from './coverage.js'
import type { RegistryLoadResult, RegistryValidationIssue } from './types.js'

/** stderr shapes that mean "the path is not in the tree at this ref" (absent, not an error). */
const GIT_SHOW_ABSENT_PATTERNS = [
  /does not exist in/i,
  /exists on disk, but not in/i,
  /path .* does not exist/i,
]

interface GitShowResult {
  code: number | null
  stdout: string
  stderr: string
  spawnError?: string
}

/** Array-argv spawn — no shell, no interpolation, injection-safe by construction. */
function runGitShow(repoRoot: string, ref: string, relPath: string): Promise<GitShowResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const proc = spawn('git', ['show', `${ref}:${relPath}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    proc.on('error', (err: Error) => {
      resolve({ code: null, stdout, stderr, spawnError: err.message })
    })
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Load the journey registry from the trusted main tree at `ref`.
 *
 * @param repoRoot absolute path of the TRUSTED repo root (the main tree, not a worktree)
 * @param ref git ref to read at — the dispatch snapshot ref (defaults to HEAD)
 */
export async function loadJourneyRegistryFromTrustedTree(
  repoRoot: string,
  ref = 'HEAD',
): Promise<RegistryLoadResult> {
  const result = await runGitShow(repoRoot, ref, JOURNEY_REGISTRY_PATH)
  if (result.spawnError !== undefined) {
    return { status: 'error', message: `git show could not be spawned: ${result.spawnError}` }
  }
  if (result.code !== 0) {
    if (GIT_SHOW_ABSENT_PATTERNS.some((p) => p.test(result.stderr))) {
      return { status: 'absent' }
    }
    return {
      status: 'error',
      message: `git show ${ref}:${JOURNEY_REGISTRY_PATH} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
    }
  }
  const parsed = parseJourneyRegistry(result.stdout)
  if (!parsed.ok) {
    return { status: 'invalid', issues: parsed.issues }
  }
  return { status: 'ok', registry: parsed.registry }
}

/** Result of a trusted-tree deferrals load. Absent file = no deferrals (legal). */
export type DeferralsLoadResult =
  | { status: 'ok'; deferrals: JourneyDeferral[] }
  | { status: 'invalid'; issues: RegistryValidationIssue[] }
  | { status: 'error'; message: string }

/**
 * Load operator journey deferrals from the trusted tree at `ref`.
 * A0.3 note: `HEAD` at run end can include story-merged edits — full
 * tamper-hardening of this input is A1.3 scope (spec-tamper tripwire).
 */
export async function loadJourneyDeferralsFromTrustedTree(
  repoRoot: string,
  ref = 'HEAD',
): Promise<DeferralsLoadResult> {
  const result = await runGitShow(repoRoot, ref, JOURNEY_DEFERRALS_PATH)
  if (result.spawnError !== undefined) {
    return { status: 'error', message: `git show could not be spawned: ${result.spawnError}` }
  }
  if (result.code !== 0) {
    if (GIT_SHOW_ABSENT_PATTERNS.some((p) => p.test(result.stderr))) {
      return { status: 'ok', deferrals: [] }
    }
    return {
      status: 'error',
      message: `git show ${ref}:${JOURNEY_DEFERRALS_PATH} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
    }
  }
  const parsed = parseJourneyDeferrals(result.stdout)
  if (!parsed.ok) return { status: 'invalid', issues: parsed.issues }
  return { status: 'ok', deferrals: parsed.deferrals }
}

/**
 * Load the acceptance contract (the `acceptance:` block of the project
 * profile) from the trusted tree at `ref` (A1.1). Same H7 posture as the
 * registry: the agent-writable worktree copy of the profile is never read.
 */
export async function loadAcceptanceContractFromTrustedTree(
  repoRoot: string,
  ref = 'HEAD',
): Promise<ContractParseResult | { status: 'error'; message: string }> {
  const result = await runGitShow(repoRoot, ref, ACCEPTANCE_CONTRACT_PROFILE_PATH)
  if (result.spawnError !== undefined) {
    return { status: 'error', message: `git show could not be spawned: ${result.spawnError}` }
  }
  if (result.code !== 0) {
    if (GIT_SHOW_ABSENT_PATTERNS.some((p) => p.test(result.stderr))) {
      // No committed profile at all → no contract.
      return { status: 'absent' }
    }
    return {
      status: 'error',
      message: `git show ${ref}:${ACCEPTANCE_CONTRACT_PROFILE_PATH} failed (exit ${String(result.code)}): ${result.stderr.trim()}`,
    }
  }
  return parseAcceptanceContract(result.stdout)
}

/**
 * Filesystem read for OPERATOR LINT ONLY (`substrate acceptance validate`).
 * Gate/judge code paths must use `loadJourneyRegistryFromTrustedTree`.
 */
export async function loadJourneyRegistryFromFile(projectRoot: string): Promise<RegistryLoadResult> {
  const filePath = join(projectRoot, JOURNEY_REGISTRY_PATH)
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent' }
    }
    return { status: 'error', message: `could not read ${filePath}: ${String(err)}` }
  }
  const parsed = parseJourneyRegistry(content)
  if (!parsed.ok) {
    return { status: 'invalid', issues: parsed.issues }
  }
  return { status: 'ok', registry: parsed.registry }
}
