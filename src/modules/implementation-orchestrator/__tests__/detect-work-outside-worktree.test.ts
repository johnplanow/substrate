/**
 * Unit tests for detectWorkOutsideWorktree (obs_2026-05-26_028).
 *
 * When a dev-story reports COMPLETE but its worktree shows zero diff, the work
 * may have landed in the MAIN checkout instead (a cwd misroute) — the output
 * isn't lost, it's in the wrong tree, and reconcile-from-disk (which inspects
 * the branch) won't find it. This helper detects that signature so the zero-diff
 * escalation can surface the real, actionable cause. The orchestrator call site
 * is deep in the dev-story path, so the detection is extracted and tested here.
 */

import { describe, it, expect, vi } from 'vitest'
import { detectWorkOutsideWorktree } from '../orchestrator-impl.js'

describe('detectWorkOutsideWorktree', () => {
  it('returns the main-checkout changes when in worktree mode and main is dirty (misroute)', () => {
    const checkDiff = vi.fn(() => ['packages/calendar-mcp/index.ts', 'Taskfile.yml'])
    const result = detectWorkOutsideWorktree('/repo/.substrate-worktrees/5-1', '/repo', checkDiff)
    expect(result).toEqual(['packages/calendar-mcp/index.ts', 'Taskfile.yml'])
    expect(checkDiff).toHaveBeenCalledWith('/repo') // probes the MAIN root, not the worktree
  })

  it('returns [] when in worktree mode but the main checkout is clean (normal)', () => {
    const checkDiff = vi.fn(() => [])
    expect(detectWorkOutsideWorktree('/repo/.substrate-worktrees/5-1', '/repo', checkDiff)).toEqual([])
  })

  it('returns [] (and does not probe) when NOT in worktree mode (effective === project root)', () => {
    const checkDiff = vi.fn(() => ['should-not-be-returned.ts'])
    expect(detectWorkOutsideWorktree('/repo', '/repo', checkDiff)).toEqual([])
    expect(checkDiff).not.toHaveBeenCalled()
  })

  it('returns [] when either root is undefined (no-worktree / unknown)', () => {
    const checkDiff = vi.fn(() => ['x.ts'])
    expect(detectWorkOutsideWorktree(undefined, '/repo', checkDiff)).toEqual([])
    expect(detectWorkOutsideWorktree('/repo/wt', undefined, checkDiff)).toEqual([])
    expect(checkDiff).not.toHaveBeenCalled()
  })

  it('is best-effort: a probe failure yields [] rather than throwing', () => {
    const checkDiff = vi.fn(() => {
      throw new Error('git failed')
    })
    expect(detectWorkOutsideWorktree('/repo/wt', '/repo', checkDiff)).toEqual([])
  })
})
