/**
 * Unit tests for eval-probe-author lib (Story 60-14d).
 *
 * Targets the three pure functions powering the A/B validation harness:
 *   - parseMachineCorpus(): extracts the YAML machine corpus from
 *     defect-replay corpus markdown
 *   - evaluateSignature(): "any probe matches all regexes" predicate
 *   - computeCatchRate(): aggregates per-defect flags into rate metric
 *
 * The script's outer shell (CLI parsing, dispatch, file I/O) is left
 * un-tested at unit level — its behaviour is end-to-end and would
 * require LLM dispatch fixtures to test meaningfully.
 */

import { describe, expect, it } from 'vitest'

// @ts-expect-error — importing JS module from TS test (vitest handles the cross-load)
import { computeCatchRate, evaluateSignature, parseMachineCorpus } from '../eval-probe-author/lib.mjs'

// ---------------------------------------------------------------------------
// parseMachineCorpus
// ---------------------------------------------------------------------------

describe('parseMachineCorpus', () => {
  it('extracts applicable_entries and excluded_entries from a well-formed corpus', () => {
    const md = `
# Some doc

## Machine corpus (eval input)

\`\`\`yaml
applicable_entries:
  - id: foo
    story_key: '1-1'
    source_ac: 'foo description'
    signature:
      - 'tools/list'
      - 'strata_'
  - id: bar
    story_key: '1-2'
    source_ac: 'bar description'
    signature:
      - 'git\\\\s+merge'

excluded_entries:
  - id: baz
    reason: 'out of scope'
\`\`\`
`
    const corpus = parseMachineCorpus(md)
    expect(corpus.applicable_entries).toHaveLength(2)
    expect(corpus.applicable_entries[0].id).toBe('foo')
    expect(corpus.applicable_entries[0].signature).toEqual(['tools/list', 'strata_'])
    expect(corpus.applicable_entries[1].id).toBe('bar')
    expect(corpus.excluded_entries).toHaveLength(1)
    expect(corpus.excluded_entries[0].id).toBe('baz')
  })

  it('throws when the markdown lacks the Machine corpus section', () => {
    expect(() => parseMachineCorpus('# Just some doc\n\nNo machine corpus.')).toThrow(
      /lacks a "## Machine corpus" section/,
    )
  })

  it('throws when an entry has empty signature list', () => {
    const md = `
## Machine corpus

\`\`\`yaml
applicable_entries:
  - id: empty-sig
    story_key: '1-1'
    signature: []
\`\`\`
`
    expect(() => parseMachineCorpus(md)).toThrow(/needs a non-empty signature list/)
  })
})

// ---------------------------------------------------------------------------
// evaluateSignature
// ---------------------------------------------------------------------------

describe('evaluateSignature', () => {
  it('returns matched=true when one probe satisfies all signature regexes', () => {
    const probes = [
      { name: 'wrong-probe', sandbox: 'host', command: 'echo nothing' },
      {
        name: 'good-probe',
        sandbox: 'host',
        command: 'mcp-client call tools/list',
        expect_stdout_regex: ['strata_semantic_search', 'strata_get_related'],
      },
    ]
    const signature = ['tools/list', 'strata_']
    const result = evaluateSignature(probes, signature)
    expect(result.matched).toBe(true)
    expect(result.matchingProbeName).toBe('good-probe')
  })

  it('returns matched=false when no single probe satisfies all regexes', () => {
    // First probe matches "tools/list"; second matches "strata_" — but
    // the predicate requires ONE probe to match BOTH.
    const probes = [
      { name: 'p1', sandbox: 'host', command: 'curl tools/list' },
      { name: 'p2', sandbox: 'host', command: 'echo strata_thing' },
    ]
    const signature = ['tools/list', 'strata_']
    const result = evaluateSignature(probes, signature)
    expect(result.matched).toBe(false)
    expect(result.matchingProbeName).toBeNull()
  })

  it('returns matched=false on empty probe array', () => {
    const result = evaluateSignature([], ['anything'])
    expect(result.matched).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeCatchRate
// ---------------------------------------------------------------------------

describe('computeCatchRate', () => {
  it('returns rate=0/0/total=0 on empty per-defect array', () => {
    const result = computeCatchRate([])
    expect(result).toEqual({ catchRate: 0, caught: 0, total: 0 })
  })

  it('counts caught entries; ignores caught=false and undefined', () => {
    const perDefect = [
      { id: 'a', caught: true },
      { id: 'b', caught: false },
      { id: 'c', caught: true },
      { id: 'd' }, // no caught flag → not counted as caught
    ]
    const result = computeCatchRate(perDefect)
    expect(result.caught).toBe(2)
    expect(result.total).toBe(4)
    expect(result.catchRate).toBe(0.5)
  })

  it('returns 1.0 when all entries caught', () => {
    const perDefect = [
      { id: 'a', caught: true },
      { id: 'b', caught: true },
    ]
    expect(computeCatchRate(perDefect).catchRate).toBe(1)
  })
})
