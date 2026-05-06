/**
 * Unit tests for Story 72-2: --non-interactive flag behavior.
 *
 * Tests:
 *   (a) --non-interactive suppresses stdin reads (routeDecision returns defaultAction
 *       without prompting — callers apply it without consulting stdin)
 *   (b) exit code 0 when all stories succeed
 *   (c) exit code 1 when any story escalates (none failed)
 *   (d) exit code 2 when run-level failure (stories failed)
 *
 * Phase D Story 54-6 (2026-04-05): original headless CI/CD spec.
 * Story 72-1: Decision Router providing routeDecision defaultAction authority.
 * Story 72-2: --non-interactive flag that enables CI/CD non-blocking invocations.
 */

import { describe, it, expect, vi } from 'vitest'
import * as readline from 'node:readline'
import { routeDecision, deriveExitCode } from '../index.js'
import type { PipelineOutcome } from '../index.js'

// Mock readline at module level so any accidental createInterface call in
// routeDecision (or any module it imports) is detectable.
// routeDecision is a pure function — it must never touch stdin/readline.
// If a regression re-introduces I/O, the spy below will catch it.
vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({ question: vi.fn(), close: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Case (a): --non-interactive suppresses stdin reads
// routeDecision is the authority for defaultAction when stdin is suppressed.
// ---------------------------------------------------------------------------

describe('routeDecision — used for stdin suppression in non-interactive mode', () => {
  it('(a) does not call readline.createInterface — pure function, no stdin I/O', () => {
    // This is the core non-interactive guarantee: when the CLI layer calls
    // routeDecision() instead of prompting stdin, no readline.createInterface
    // calls must occur. If a regression re-introduces I/O in routeDecision
    // or any module it imports, vi.mocked(readline.createInterface) will catch it.
    vi.mocked(readline.createInterface).mockClear()
    const result = routeDecision('cost-ceiling-exhausted', 'critical')
    expect(result.defaultAction).toBeTruthy()
    // Pure function: readline must NOT have been called
    expect(readline.createInterface).not.toHaveBeenCalled()
  })

  it('(a) returns a defaultAction for cost-ceiling-exhausted at critical policy', () => {
    // When --non-interactive is set, callers invoke routeDecision to get the
    // defaultAction to apply WITHOUT prompting stdin. This is the core stdin
    // suppression mechanism: instead of reading from stdin, apply defaultAction.
    const result = routeDecision('cost-ceiling-exhausted', 'critical')

    // Must return a defined action — no stdin read required
    expect(result).toBeDefined()
    expect(result.defaultAction).toBeTruthy()
    expect(typeof result.defaultAction).toBe('string')
  })

  it('(a) returns a defaultAction for build-verification-failure at critical policy', () => {
    const result = routeDecision('build-verification-failure', 'critical')
    expect(result.defaultAction).toBeTruthy()
    // halt=true means it WOULD have prompted — non-interactive applies defaultAction instead
    expect(result.halt).toBe(true)
  })

  it('(a) routeDecision is a pure synchronous function — no stdin/readline I/O', () => {
    // routeDecision must not touch stdin — it is purely computational.
    // This verifies the stdin-suppression guarantee: calling routeDecision()
    // never blocks on stdin reads.
    const before = Date.now()

    const result = routeDecision('escalation', 'critical')

    const elapsed = Date.now() - before

    // Synchronous return — no async I/O whatsoever
    expect(elapsed).toBeLessThan(10)
    expect(result).toBeDefined()
    // Unknown types ('escalation' not in registry) default to severity 'critical'
    expect(result.severity).toBe('critical')
  })

  it('halt=true under critical policy for critical decisions', () => {
    // This is the condition that would have triggered a prompt in interactive mode.
    // Non-interactive mode skips the prompt and applies defaultAction.
    const result = routeDecision('cost-ceiling-exhausted', 'critical')
    expect(result.halt).toBe(true)
    expect(result.severity).toBe('critical')
  })

  it('halt=false under none policy for non-fatal decisions', () => {
    // Under halt-on:none, only fatal decisions would halt. Non-interactive
    // with --halt-on none means no halts at all (except fatal).
    const result = routeDecision('cost-ceiling-exhausted', 'none')
    expect(result.halt).toBe(false)
  })

  it('halt=true under all policy for any decision', () => {
    const result = routeDecision('recovery-retry-attempt', 'all')
    expect(result.halt).toBe(true)
  })

  it('fatal decisions always halt regardless of policy', () => {
    const noneResult = routeDecision('scope-violation', 'none')
    expect(noneResult.halt).toBe(true)
    expect(noneResult.severity).toBe('fatal')
  })

  it('returns defaultAction for all known decision types', () => {
    const types = [
      'cost-ceiling-exhausted',
      'build-verification-failure',
      'recovery-retry-attempt',
      're-scope-proposal',
      'scope-violation',
      'cross-story-race-recovered',
      'cross-story-race-still-failed',
    ]
    for (const decisionType of types) {
      const result = routeDecision(decisionType, 'critical')
      expect(result.defaultAction).toBeTruthy()
    }
  })

  it('returns defaultAction for unknown decision types (safe fallback)', () => {
    const result = routeDecision('some-unknown-future-decision', 'critical')
    expect(result.defaultAction).toBeTruthy()
    // Unknown types default to 'critical' severity
    expect(result.severity).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// Cases (b), (c), (d): exit code derivation
// ---------------------------------------------------------------------------

describe('deriveExitCode', () => {
  it('(b) returns 0 when all stories succeeded', () => {
    const outcome: PipelineOutcome = {
      succeeded: ['1-1', '1-2', '1-3'],
      escalated: [],
      failed: [],
      total: 3,
    }
    expect(deriveExitCode(outcome)).toBe(0)
  })

  it('(b) returns 0 when all stories recovered (succeeded + recovered === total)', () => {
    const outcome: PipelineOutcome = {
      succeeded: ['1-1', '1-2'],
      recovered: ['1-3'],
      escalated: [],
      failed: [],
      total: 3,
    }
    expect(deriveExitCode(outcome)).toBe(0)
  })

  it('(b) returns 0 when there are no stories (empty run)', () => {
    const outcome: PipelineOutcome = {
      succeeded: [],
      escalated: [],
      failed: [],
      total: 0,
    }
    expect(deriveExitCode(outcome)).toBe(0)
  })

  it('(c) returns 1 when some stories escalated and none failed', () => {
    const outcome: PipelineOutcome = {
      succeeded: ['1-1'],
      escalated: ['1-2', '1-3'],
      failed: [],
      total: 3,
    }
    expect(deriveExitCode(outcome)).toBe(1)
  })

  it('(c) returns 1 when all stories escalated and none failed', () => {
    const outcome: PipelineOutcome = {
      succeeded: [],
      escalated: ['1-1', '1-2'],
      failed: [],
      total: 2,
    }
    expect(deriveExitCode(outcome)).toBe(1)
  })

  it('(d) returns 2 when stories failed', () => {
    const outcome: PipelineOutcome = {
      succeeded: ['1-1'],
      escalated: [],
      failed: ['1-2'],
      total: 2,
    }
    expect(deriveExitCode(outcome)).toBe(2)
  })

  it('(d) returns 2 when stories failed even if some escalated', () => {
    const outcome: PipelineOutcome = {
      succeeded: [],
      escalated: ['1-1'],
      failed: ['1-2'],
      total: 2,
    }
    expect(deriveExitCode(outcome)).toBe(2)
  })

  it('(d) returns 2 when cost ceiling was exhausted', () => {
    const outcome: PipelineOutcome = {
      succeeded: ['1-1'],
      escalated: [],
      failed: [],
      total: 2,
      costCeilingExhausted: true,
    }
    expect(deriveExitCode(outcome)).toBe(2)
  })

  it('(d) returns 2 when fatal halt reached', () => {
    const outcome: PipelineOutcome = {
      succeeded: [],
      escalated: [],
      failed: [],
      total: 1,
      fatalHaltReached: true,
    }
    expect(deriveExitCode(outcome)).toBe(2)
  })

  it('(d) returns 2 when orchestrator died', () => {
    const outcome: PipelineOutcome = {
      succeeded: [],
      escalated: [],
      failed: [],
      total: 1,
      orchestratorDied: true,
    }
    expect(deriveExitCode(outcome)).toBe(2)
  })

  it('(d) returns 2 even when escalated stories exist alongside run-level failure', () => {
    // failed.length > 0 takes precedence over escalated (exit 2, not exit 1)
    const outcome: PipelineOutcome = {
      succeeded: [],
      escalated: ['1-1'],
      failed: ['1-2'],
      total: 2,
      fatalHaltReached: false,
    }
    expect(deriveExitCode(outcome)).toBe(2)
  })
})
