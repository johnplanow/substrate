/**
 * Unit tests for scripts/eval-pack-upgrade/lib.mjs (Story 81-2).
 *
 * All helpers are synchronous and pure — no I/O, no mocks needed.
 */

import { describe, it, expect } from 'vitest'

// @ts-expect-error — importing JS module from TS test (vitest handles cross-load)
import {
  parseOutcomesCorpusForPackUpgrade,
  classifyPairOutcome,
  normalizeDispatchEnvelope,
  buildPackOverride,
} from '../lib.mjs'

// ---------------------------------------------------------------------------
// parseOutcomesCorpusForPackUpgrade
// ---------------------------------------------------------------------------

describe('parseOutcomesCorpusForPackUpgrade', () => {
  it('parses a corpus with fully-populated entries', () => {
    const yaml = `
corpus_version: 1
cases:
  - id: case-1
    story_key: "42-1"
    parent_sha: "abc123"
    story_file_input_path: "/tmp/story-42-1.md"
    expect:
      result_class: SHIP_IT
`
    const { cases, skipped } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases).toHaveLength(1)
    expect(cases[0]).toEqual({
      case_id: 'case-1',
      parent_sha: 'abc123',
      story_key: '42-1',
      story_file_input_path: '/tmp/story-42-1.md',
      commit_sha: null,
    })
    expect(skipped).toHaveLength(0)
  })

  it('returns empty cases and skipped for a corpus with no entries', () => {
    const yaml = 'corpus_version: 1\ncases: []\n'
    const { cases, skipped } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases).toEqual([])
    expect(skipped).toEqual([])
  })

  it('moves entries missing parent_sha to skipped', () => {
    const yaml = `
corpus_version: 1
cases:
  - id: no-sha
    story_key: "1-1"
    story_file_input_path: "/tmp/story.md"
`
    const { cases, skipped } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toEqual({ case_id: 'no-sha', reason: 'missing parent_sha' })
  })

  it('moves entries missing story_file_input_path to skipped', () => {
    const yaml = `
corpus_version: 1
cases:
  - id: no-path
    story_key: "2-2"
    parent_sha: "def456"
`
    const { cases, skipped } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toEqual({ case_id: 'no-path', reason: 'missing story_file_input_path' })
  })

  it('falls back to story_key as case_id when id is absent', () => {
    const yaml = `
corpus_version: 1
cases:
  - story_key: "5-3"
    parent_sha: "aaa"
    story_file_input_path: "/tmp/s.md"
`
    const { cases } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases[0].case_id).toBe('5-3')
  })

  it('falls back to <unknown> as case_id when both id and story_key are absent', () => {
    const yaml = `
corpus_version: 1
cases:
  - parent_sha: "aaa"
`
    // Missing story_file_input_path → skipped with <unknown> case_id
    const { skipped } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(skipped[0].case_id).toBe('<unknown>')
  })

  it('partitions mixed entries into cases and skipped', () => {
    const yaml = `
corpus_version: 1
cases:
  - id: good-1
    story_key: "1-1"
    parent_sha: "aaa"
    story_file_input_path: "/tmp/a.md"
  - id: bad-1
    story_key: "1-2"
  - id: bad-2
    story_key: "1-3"
    parent_sha: "bbb"
  - id: good-2
    story_key: "1-4"
    parent_sha: "ccc"
    story_file_input_path: "/tmp/b.md"
`
    const { cases, skipped } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases).toHaveLength(2)
    expect(skipped).toHaveLength(2)
    expect(cases.map((c: { case_id: string }) => c.case_id)).toEqual(['good-1', 'good-2'])
  })

  it('throws on malformed YAML', () => {
    expect(() => parseOutcomesCorpusForPackUpgrade('{ invalid yaml :')).toThrow(/YAML parse error/)
  })

  it('throws when corpus root is not a mapping', () => {
    expect(() => parseOutcomesCorpusForPackUpgrade('- just\n- a\n- list\n')).toThrow(/mapping/)
  })

  it('throws when cases is not an array', () => {
    expect(() => parseOutcomesCorpusForPackUpgrade('corpus_version: 1\ncases: not-a-list\n')).toThrow(
      /cases/,
    )
  })

  it('reflects corpus entries without id or story_key in case_id as <unknown>', () => {
    const yaml = `
corpus_version: 1
cases:
  - parent_sha: "abc"
    story_file_input_path: "/tmp/x.md"
`
    const { cases } = parseOutcomesCorpusForPackUpgrade(yaml)
    expect(cases[0].case_id).toBe('<unknown>')
  })
})

// ---------------------------------------------------------------------------
// classifyPairOutcome
// ---------------------------------------------------------------------------

describe('classifyPairOutcome', () => {
  const makeEnv = (outcome: string) => ({ dispatch_outcome: outcome })

  it('returns both-completed when both envelopes are completed', () => {
    expect(classifyPairOutcome(makeEnv('completed'), makeEnv('completed'))).toBe('both-completed')
  })

  it('returns one-completed when only A is completed', () => {
    expect(classifyPairOutcome(makeEnv('completed'), makeEnv('error'))).toBe('one-completed')
  })

  it('returns one-completed when only B is completed', () => {
    expect(classifyPairOutcome(makeEnv('error'), makeEnv('completed'))).toBe('one-completed')
  })

  it('returns neither-completed when both failed', () => {
    expect(classifyPairOutcome(makeEnv('failed'), makeEnv('error'))).toBe('neither-completed')
  })

  it('returns neither-completed when both budget-exceeded', () => {
    expect(classifyPairOutcome(makeEnv('budget-exceeded'), makeEnv('budget-exceeded'))).toBe(
      'neither-completed',
    )
  })

  it('returns pair-skipped when envelopeA is null', () => {
    expect(classifyPairOutcome(null, makeEnv('completed'))).toBe('pair-skipped')
  })

  it('returns pair-skipped when envelopeB is null', () => {
    expect(classifyPairOutcome(makeEnv('completed'), null)).toBe('pair-skipped')
  })

  it('returns pair-skipped when both are null', () => {
    expect(classifyPairOutcome(null, null)).toBe('pair-skipped')
  })
})

// ---------------------------------------------------------------------------
// normalizeDispatchEnvelope
// ---------------------------------------------------------------------------

describe('normalizeDispatchEnvelope', () => {
  const PACK_ID = 'current' as const
  const PACK_PATH = '/packs/current'

  function makeRaw(overrides: Record<string, unknown> = {}) {
    return {
      id: 'd1',
      status: 'completed',
      exitCode: 0,
      output: '',
      parsed: null,
      parseError: null,
      durationMs: 2000,
      tokenEstimate: { input: 1000, output: 500 },
      ...overrides,
    }
  }

  it('produces a completed envelope from a successful dispatch result', () => {
    const env = normalizeDispatchEnvelope(makeRaw(), PACK_ID, PACK_PATH, { costUsd: 0.02 })
    expect(env.pack).toBe('current')
    expect(env.pack_path).toBe(PACK_PATH)
    expect(env.dispatch_outcome).toBe('completed')
    expect(env.duration_seconds).toBe(2)
    expect(env.cost_usd).toBe(0.02)
    expect(env.total_tokens).toEqual({ input: 1000, output: 500 })
    expect(env.error_detail).toBeNull()
  })

  it('produces a failed envelope from a dispatch with status=failed', () => {
    const env = normalizeDispatchEnvelope(makeRaw({ status: 'failed' }), PACK_ID, PACK_PATH, {})
    expect(env.dispatch_outcome).toBe('failed')
  })

  it('produces a failed envelope from a dispatch with status=timeout', () => {
    const env = normalizeDispatchEnvelope(makeRaw({ status: 'timeout' }), PACK_ID, PACK_PATH, {})
    expect(env.dispatch_outcome).toBe('failed')
  })

  it('produces an escalated envelope for status=escalated', () => {
    const env = normalizeDispatchEnvelope(makeRaw({ status: 'escalated' }), PACK_ID, PACK_PATH, {})
    expect(env.dispatch_outcome).toBe('escalated')
  })

  it('produces an error envelope when rawResult is null', () => {
    const env = normalizeDispatchEnvelope(null, PACK_ID, PACK_PATH, {})
    expect(env.dispatch_outcome).toBe('error')
    expect(env.total_tokens).toBeNull()
  })

  it('produces an error envelope when errorDetail is set', () => {
    const env = normalizeDispatchEnvelope(makeRaw(), PACK_ID, PACK_PATH, {
      errorDetail: 'agent crashed',
    })
    expect(env.dispatch_outcome).toBe('error')
    expect(env.error_detail).toBe('agent crashed')
  })

  it('produces a budget-exceeded envelope when budgetExceeded is true', () => {
    const env = normalizeDispatchEnvelope(makeRaw(), PACK_ID, PACK_PATH, {
      budgetExceeded: true,
      costUsd: 5.5,
    })
    expect(env.dispatch_outcome).toBe('budget-exceeded')
    expect(env.cost_usd).toBe(5.5)
    expect(env.error_detail).toBeNull()
  })

  it('errorDetail takes precedence over budgetExceeded', () => {
    // error is a harder failure than budget-exceeded
    const env = normalizeDispatchEnvelope(null, PACK_ID, PACK_PATH, {
      errorDetail: 'crash',
      budgetExceeded: true,
    })
    expect(env.dispatch_outcome).toBe('error')
  })

  it('uses durationMs fallback when rawResult.durationMs is absent', () => {
    const raw = makeRaw({ durationMs: undefined })
    const env = normalizeDispatchEnvelope(raw, PACK_ID, PACK_PATH, { durationMs: 3000 })
    expect(env.duration_seconds).toBe(3)
  })

  it('sets total_tokens to null when rawResult has no tokenEstimate', () => {
    const env = normalizeDispatchEnvelope(makeRaw({ tokenEstimate: null }), PACK_ID, PACK_PATH, {})
    expect(env.total_tokens).toBeNull()
  })

  it('extracts verdict from rawResult.parsed.verdict when rawResult.verdict is absent', () => {
    const env = normalizeDispatchEnvelope(
      makeRaw({ parsed: { verdict: 'SHIP_IT' } }),
      PACK_ID,
      PACK_PATH,
      {},
    )
    expect(env.verdict).toBe('SHIP_IT')
  })

  it('populates recovery_history from rawResult.recoveryHistory', () => {
    const history = [{ strategy: 'retry', attempt: 1 }]
    const env = normalizeDispatchEnvelope(
      makeRaw({ recoveryHistory: history }),
      PACK_ID,
      PACK_PATH,
      {},
    )
    expect(env.recovery_history).toEqual(history)
  })

  it('defaults recovery_history to [] when absent', () => {
    const env = normalizeDispatchEnvelope(makeRaw(), PACK_ID, PACK_PATH, {})
    expect(env.recovery_history).toEqual([])
  })

  it('uses the diff from opts when provided', () => {
    const env = normalizeDispatchEnvelope(makeRaw(), PACK_ID, PACK_PATH, {
      diff: ['src/foo.ts', 'src/bar.ts'],
    })
    expect(env.diff).toEqual(['src/foo.ts', 'src/bar.ts'])
  })

  it('extracts escalation_reason from rawResult.escalationReason', () => {
    const env = normalizeDispatchEnvelope(
      makeRaw({ escalationReason: 'build-failure' }),
      PACK_ID,
      PACK_PATH,
      {},
    )
    expect(env.escalation_reason).toBe('build-failure')
  })

  it('extracts escalation_reason from rawResult.escalation_reason (snake_case)', () => {
    const env = normalizeDispatchEnvelope(
      makeRaw({ escalation_reason: 'budget-exceeded' }),
      PACK_ID,
      PACK_PATH,
      {},
    )
    expect(env.escalation_reason).toBe('budget-exceeded')
  })

  it('envelope shape has all AC4 fields', () => {
    const env = normalizeDispatchEnvelope(makeRaw(), PACK_ID, PACK_PATH, {})
    const requiredKeys = [
      'pack',
      'pack_path',
      'dispatch_outcome',
      'diff',
      'total_turns',
      'total_tokens',
      'verdict',
      'recovery_history',
      'escalation_reason',
      'duration_seconds',
      'cost_usd',
      'error_detail',
    ]
    for (const key of requiredKeys) {
      expect(env).toHaveProperty(key)
    }
  })

  it('extracts unknown status as error', () => {
    const env = normalizeDispatchEnvelope(makeRaw({ status: 'unknown-state' }), PACK_ID, PACK_PATH, {})
    expect(env.dispatch_outcome).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// buildPackOverride
// ---------------------------------------------------------------------------

describe('buildPackOverride', () => {
  it('returns { packPath } for the given path', () => {
    expect(buildPackOverride('/packs/bmad-v2')).toEqual({ packPath: '/packs/bmad-v2' })
  })

  it('preserves the exact path string', () => {
    const path = '/home/user/custom-packs/my-pack'
    expect(buildPackOverride(path).packPath).toBe(path)
  })
})
