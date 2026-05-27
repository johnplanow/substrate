/**
 * Unit tests for summarizeEscalationIssues (obs_2026-05-27_032).
 *
 * Escalation diagnostic output (build-failure text, review findings) was only
 * captured in the ephemeral .substrate/notifications/ file that `substrate
 * report` deletes — so once a report ran, the only durable trace was the short
 * `escalation_reason` and escalations couldn't be root-caused post-hoc. This
 * helper renders the escalation `issues[]` into a durable `escalation_detail`
 * string for per_story_state.
 */

import { describe, it, expect } from 'vitest'
import { summarizeEscalationIssues } from '../orchestrator-impl.js'

describe('summarizeEscalationIssues', () => {
  it('joins string issues (e.g. build-failure output) with newlines', () => {
    expect(summarizeEscalationIssues(['error: externally-managed-environment', 'pip failed'])).toBe(
      'error: externally-managed-environment\npip failed',
    )
  })

  it('renders finding objects as severity + file + description', () => {
    expect(
      summarizeEscalationIssues([{ severity: 'blocker', file: 'src/foo.ts', description: 'broken architecture' }]),
    ).toBe('blocker src/foo.ts broken architecture')
  })

  it('omits absent fields when rendering a finding object', () => {
    expect(summarizeEscalationIssues([{ description: 'just a description' }])).toBe('just a description')
  })

  it('falls back to JSON for objects without a description', () => {
    expect(summarizeEscalationIssues([{ code: 'E123', count: 2 }])).toBe('{"code":"E123","count":2}')
  })

  it('returns undefined for an empty or non-array issues list', () => {
    expect(summarizeEscalationIssues([])).toBeUndefined()
    expect(summarizeEscalationIssues(undefined as unknown as unknown[])).toBeUndefined()
  })

  it('returns undefined when all issues render to empty strings', () => {
    expect(summarizeEscalationIssues(['', '   '])).toBeUndefined()
  })

  it('caps overly long detail (keeps the manifest lean) with an ellipsis', () => {
    const huge = 'x'.repeat(10_000)
    const result = summarizeEscalationIssues([huge], 4000)!
    expect(result.length).toBe(4000)
    expect(result.endsWith('…')).toBe(true)
  })

  it('preserves the real build-verification-failed shape (truncated output as a single issue)', () => {
    // Mirrors orchestrator: emitEscalation({ issues: [truncatedOutput] }) for build-verification-failed.
    const buildOutput = '/bin/sh: 1: python: command not found\nbuild failed with exit code 127'
    expect(summarizeEscalationIssues([buildOutput])).toBe(buildOutput)
  })
})
