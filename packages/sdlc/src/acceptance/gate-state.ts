/**
 * Acceptance Gate — operator-local gate state / auto-demotion overlay (A6).
 *
 * When the gate loses trust in itself — a canary miss (A6.1: a planted
 * regression the gate FAILED to catch) or a precision-floor breach (A6.2: it
 * has been blocking too many correct stories) — it AUTO-DEMOTES to advisory
 * regardless of `acceptance.mode`, and stays demoted until an operator clears
 * it. This is design principle 3 made operational: "a gate is distrusted until
 * it catches a planted failure." A distrusted gate must not hold blocking
 * authority over merges.
 *
 * The state lives OUTSIDE git (operator-local, like the smoke history):
 * `.substrate/acceptance/gate-state.json`. It is never an agent-writable
 * worktree artifact — it gates the operator's own blocking decision.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/** Repo-relative path of the operator-local gate state. */
export const GATE_STATE_PATH = '.substrate/acceptance/gate-state.json'

export const GateStateSchema = z.object({
  /** When true, the gate is forced to advisory regardless of acceptance.mode. */
  demoted: z.boolean(),
  /** Why: 'canary-missed' | 'precision-floor' | operator note. */
  reason: z.string(),
  /** ISO-8601 timestamp the demotion was set. */
  since: z.string(),
  /** Optional detail (which journey/canary, or the measured precision). */
  detail: z.string().optional(),
})

export type GateState = z.infer<typeof GateStateSchema>

/** Read the demotion overlay. Absent/unreadable/invalid → not demoted. */
export function readGateState(projectRoot: string): GateState | undefined {
  const path = join(projectRoot, GATE_STATE_PATH)
  if (!existsSync(path)) return undefined
  try {
    const parsed = GateStateSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Is the gate currently auto-demoted (blocking authority suspended)? */
export function isGateDemoted(projectRoot: string): boolean {
  return readGateState(projectRoot)?.demoted === true
}

/** Write the demotion overlay (canary miss / precision breach). Idempotent. */
export function demoteGate(projectRoot: string, reason: string, detail?: string): GateState {
  const state: GateState = {
    demoted: true,
    reason,
    since: new Date().toISOString(),
    ...(detail !== undefined ? { detail } : {}),
  }
  const path = join(projectRoot, GATE_STATE_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
  return state
}

/** Operator clears the demotion (after diagnosing the miss/precision issue). */
export function clearGateDemotion(projectRoot: string): boolean {
  const path = join(projectRoot, GATE_STATE_PATH)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/**
 * Resolve the EFFECTIVE acceptance mode: a demoted gate can never be
 * `blocking`, no matter what the config says. `off` stays off.
 */
export function effectiveAcceptanceMode(
  configured: 'off' | 'advisory' | 'blocking',
  projectRoot: string,
): 'off' | 'advisory' | 'blocking' {
  if (configured === 'off') return 'off'
  if (configured === 'blocking' && isGateDemoted(projectRoot)) return 'advisory'
  return configured
}
