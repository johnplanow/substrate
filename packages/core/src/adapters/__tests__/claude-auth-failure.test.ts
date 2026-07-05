/**
 * H0.4 (hardening program, field finding #10): auth-failure classification.
 *
 * An agent dying on "Invalid API key" surfaced as `create-story-no-file`
 * (qualityScore 40) or a 600s timeout — never as an auth error — costing
 * ~25 minutes and two runs in the 2026-07-04 income-sources field run.
 * These tests pin the classifier signatures and the planning-command
 * env-scrub parity fix.
 */

import { describe, it, expect } from 'vitest'
import { detectClaudeAuthFailure, CLAUDE_AUTH_FAILURE_HINT } from '../claude-adapter.js'
import { ClaudeCodeAdapter } from '../claude-adapter.js'
import type { PlanRequest } from '../../types.js'

describe('detectClaudeAuthFailure (H0.4)', () => {
  it('matches the field-verified stale-API-key refusal', () => {
    const output =
      'auth source takes precedence over claude.ai login · Invalid API key'
    expect(detectClaudeAuthFailure(output)).toBe('invalid api key')
  })

  it('matches each known signature case-insensitively', () => {
    const samples: Array<[string, string]> = [
      ['Error: Invalid API Key provided', 'invalid api key'],
      ['Your auth source takes precedence over subscription login', 'auth source takes precedence'],
      ['Not logged in. Please run /login to authenticate.', 'please run /login'],
      ['OAuth token has expired. Refresh required.', 'oauth token has expired'],
      ['OAuth token is invalid.', 'oauth token is invalid'],
      ['{"type":"error","error":{"type":"authentication_error"}}', 'authentication_error'],
      ['Your credit balance is too low to access the API.', 'credit balance is too low'],
    ]
    for (const [output, expected] of samples) {
      expect(detectClaudeAuthFailure(output)).toBe(expected)
    }
  })

  it('returns null for ordinary failures, empty, and nullish input', () => {
    expect(detectClaudeAuthFailure('TypeError: cannot read properties of undefined')).toBeNull()
    expect(detectClaudeAuthFailure('Test suite failed: 3 tests failing')).toBeNull()
    expect(detectClaudeAuthFailure('')).toBeNull()
    expect(detectClaudeAuthFailure(undefined)).toBeNull()
    expect(detectClaudeAuthFailure(null)).toBeNull()
  })

  it('does NOT fire on prose that merely discusses authentication', () => {
    // An agent implementing an auth feature will mention these words —
    // signatures must be specific error phrasings, not topic words.
    expect(detectClaudeAuthFailure('Implemented the login endpoint and API key validation logic')).toBeNull()
    expect(detectClaudeAuthFailure('added test for oauth token refresh flow')).toBeNull()
  })

  it('hint names the causes and remediations in leverage order', () => {
    expect(CLAUDE_AUTH_FAILURE_HINT).toContain('ANTHROPIC_API_KEY')
    expect(CLAUDE_AUTH_FAILURE_HINT).toContain('claude login')
    expect(CLAUDE_AUTH_FAILURE_HINT).toContain('halted')
  })
})

describe('buildPlanningCommand env-scrub parity (H0.4)', () => {
  const adapter = new ClaudeCodeAdapter()
  const planRequest = { epicContent: 'epic', stories: [] } as unknown as PlanRequest

  it('unsets ANTHROPIC_API_KEY under subscription billing (parity with buildCommand)', () => {
    const cmd = adapter.buildPlanningCommand(planRequest, {
      worktreePath: '/wt',
      billingMode: 'subscription',
    })
    expect(cmd.unsetEnvKeys).toContain('ANTHROPIC_API_KEY')
    expect(cmd.unsetEnvKeys).toContain('CLAUDECODE')
  })

  it('keeps the key under api billing with an explicit apiKey', () => {
    const cmd = adapter.buildPlanningCommand(planRequest, {
      worktreePath: '/wt',
      billingMode: 'api',
      apiKey: 'sk-test',
    })
    expect(cmd.env?.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(cmd.unsetEnvKeys ?? []).not.toContain('ANTHROPIC_API_KEY')
  })
})
