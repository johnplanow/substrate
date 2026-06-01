/**
 * Unit tests for the pack-upgrade CLI (Story 81-4).
 *
 * Covers AC13 scenarios:
 *   - Threshold parsing: well-formed, malformed, multiple axes
 *   - Ground-truth resolution: correct args, failure produces error
 *   - Pack identity inference: version read, sha resolved, graceful degradation
 *   - Report formatters: markdown shape (AC3), JSON shape (AC4), plain shape (AC5)
 *   - dryRunCorpus: ready corpus → all green; pollution → per-pair error
 *   - buildGraderThresholds: maps CLI axes to grader format, fail defaults to 2× warn
 *   - Exit codes via runPackUpgradeEval: GREEN → 0, YELLOW → 1, RED → 2, usage error → 3
 *   - End-to-end via runPackUpgradeEval with mocked deps producing canned pair envelopes
 *
 * No I/O, no live model calls, no git ops — all deps are injected stubs.
 */

import { describe, it, expect, vi } from 'vitest'

// @ts-expect-error — importing JS modules from TS test (vitest handles cross-load)
import {
  parseThresholdString,
  buildGraderThresholds,
  resolveGroundTruth,
  inferPackIdentity,
  dryRunCorpus,
  formatMarkdownReport,
  formatJsonReport,
  formatPlainReport,
} from '../cli-lib.mjs'

// @ts-expect-error
import { runPackUpgradeEval } from '../../eval-pack-upgrade.mjs'

// @ts-expect-error
import { parseOutcomesCorpusForPackUpgrade } from '../lib.mjs'

// ---------------------------------------------------------------------------
// parseThresholdString
// ---------------------------------------------------------------------------

describe('parseThresholdString', () => {
  it('parses a well-formed single-axis string', () => {
    const result = parseThresholdString('code-quality:0.05')
    expect(result).toEqual({ 'code-quality': 0.05 })
  })

  it('parses multiple axes', () => {
    const result = parseThresholdString('code-quality:0.05,cost-turns:0.10,verdict-tv:0.10,recovery-tv:0.10')
    expect(result).toEqual({
      'code-quality': 0.05,
      'cost-turns': 0.10,
      'verdict-tv': 0.10,
      'recovery-tv': 0.10,
    })
  })

  it('handles spaces around delimiters', () => {
    const result = parseThresholdString(' code-quality : 0.05 , cost-turns : 0.10 ')
    expect(result['code-quality']).toBe(0.05)
    expect(result['cost-turns']).toBe(0.10)
  })

  it('throws on malformed segment without colon', () => {
    expect(() => parseThresholdString('code-quality-0.05')).toThrow('malformed segment')
  })

  it('throws on non-numeric value', () => {
    expect(() => parseThresholdString('code-quality:notanumber')).toThrow('invalid value')
  })

  it('throws on empty string', () => {
    expect(() => parseThresholdString('')).toThrow()
  })

  it('throws on empty axis name', () => {
    expect(() => parseThresholdString(':0.05')).toThrow('empty axis name')
  })

  it('throws on no valid pairs', () => {
    expect(() => parseThresholdString(',,')).toThrow('no valid axis:value pairs')
  })
})

// ---------------------------------------------------------------------------
// buildGraderThresholds
// ---------------------------------------------------------------------------

describe('buildGraderThresholds', () => {
  it('maps code-quality to codeQuality with 2× fail default', () => {
    const result = buildGraderThresholds({ 'code-quality': 0.05 }, {})
    expect(result.codeQuality?.warn).toBe(0.05)
    expect(result.codeQuality?.fail).toBe(0.10)
  })

  it('respects explicit fail threshold', () => {
    const result = buildGraderThresholds({ 'code-quality': 0.05 }, { 'code-quality': 0.20 })
    expect(result.codeQuality?.warn).toBe(0.05)
    expect(result.codeQuality?.fail).toBe(0.20)
  })

  it('maps cost-turns to cost.warnTurns', () => {
    const result = buildGraderThresholds({ 'cost-turns': 0.10 }, {})
    expect(result.cost?.warnTurns).toBe(0.10)
    expect(result.cost?.failTurns).toBe(0.20)
  })

  it('maps verdict-tv to verdict.warnTV', () => {
    const result = buildGraderThresholds({ 'verdict-tv': 0.08 }, {})
    expect(result.verdict?.warnTV).toBe(0.08)
    expect(result.verdict?.failTV).toBeCloseTo(0.16)
  })

  it('maps recovery-tv to recovery.warnTV', () => {
    const result = buildGraderThresholds({ 'recovery-tv': 0.12 }, {})
    expect(result.recovery?.warnTV).toBe(0.12)
    expect(result.recovery?.failTV).toBeCloseTo(0.24)
  })

  it('returns empty object when no thresholds provided', () => {
    const result = buildGraderThresholds({}, {})
    expect(Object.keys(result)).toHaveLength(0)
  })

  it('handles fail-only with no warn', () => {
    const result = buildGraderThresholds({}, { 'code-quality': 0.15 })
    expect(result.codeQuality?.fail).toBe(0.15)
    expect(result.codeQuality?.warn).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveGroundTruth
// ---------------------------------------------------------------------------

describe('resolveGroundTruth', () => {
  it('calls deps.gitDiff with correct arguments', () => {
    const gitDiff = vi.fn().mockReturnValue('diff output')
    const entry = { id: 'case-1', parent_sha: 'abc123', commit_sha: 'def456' }
    const result = resolveGroundTruth(entry, '/repo/root', { gitDiff })
    expect(gitDiff).toHaveBeenCalledWith('/repo/root', 'abc123', 'def456')
    expect(result).toBe('diff output')
  })

  it('resolves repo root from a map using entry.repo', () => {
    const gitDiff = vi.fn().mockReturnValue('diff')
    const entry = { id: 'c1', parent_sha: 'p1', commit_sha: 'c1sha', repo: 'myrepo' }
    resolveGroundTruth(entry, { myrepo: '/path/to/myrepo' }, { gitDiff })
    expect(gitDiff).toHaveBeenCalledWith('/path/to/myrepo', 'p1', 'c1sha')
  })

  it('throws when parent_sha is missing', () => {
    const gitDiff = vi.fn()
    const entry = { id: 'c1', commit_sha: 'c1sha' }
    expect(() => resolveGroundTruth(entry, '/root', { gitDiff })).toThrow('missing parent_sha')
  })

  it('throws when commit_sha is missing', () => {
    const gitDiff = vi.fn()
    const entry = { id: 'c1', parent_sha: 'p1' }
    expect(() => resolveGroundTruth(entry, '/root', { gitDiff })).toThrow('missing commit_sha')
  })

  it('wraps gitDiff errors with corpus-error context', () => {
    const gitDiff = vi.fn().mockImplementation(() => { throw new Error('git not found') })
    const entry = { id: 'c1', parent_sha: 'p1', commit_sha: 'c1sha' }
    expect(() => resolveGroundTruth(entry, '/root', { gitDiff }))
      .toThrow('git diff failed for case c1')
  })

  it('throws when repoRoots is null', () => {
    const gitDiff = vi.fn()
    const entry = { id: 'c1', parent_sha: 'p1', commit_sha: 'c1sha' }
    expect(() => resolveGroundTruth(entry, null, { gitDiff })).toThrow('could not resolve repo root')
  })
})

// ---------------------------------------------------------------------------
// inferPackIdentity
// ---------------------------------------------------------------------------

describe('inferPackIdentity', () => {
  it('reads version from manifest.yaml', () => {
    const readFile = vi.fn().mockReturnValue('version: 1.2.3\nname: test-pack\n')
    const gitRevParse = vi.fn().mockReturnValue(null)
    const result = inferPackIdentity('/path/to/pack', { readFile, gitRevParse })
    expect(result.version).toBe('1.2.3')
    expect(readFile).toHaveBeenCalledWith('/path/to/pack/manifest.yaml')
  })

  it('resolves git sha via gitRevParse', () => {
    const readFile = vi.fn().mockReturnValue('version: 1.0.0\n')
    const gitRevParse = vi.fn().mockReturnValue('abc123def456')
    const result = inferPackIdentity('/packs/bmad', { readFile, gitRevParse })
    expect(result.sha).toBe('abc123def456')
    expect(gitRevParse).toHaveBeenCalledWith('/packs/bmad')
  })

  it('gracefully degrades version to null on read error', () => {
    const readFile = vi.fn().mockImplementation(() => { throw new Error('file not found') })
    const gitRevParse = vi.fn().mockReturnValue('sha123')
    const result = inferPackIdentity('/missing/pack', { readFile, gitRevParse })
    expect(result.version).toBeNull()
    expect(result.sha).toBe('sha123')
  })

  it('gracefully degrades sha to null when gitRevParse returns null', () => {
    const readFile = vi.fn().mockReturnValue('version: 2.0.0\n')
    const gitRevParse = vi.fn().mockReturnValue(null)
    const result = inferPackIdentity('/packs/bmad', { readFile, gitRevParse })
    expect(result.version).toBe('2.0.0')
    expect(result.sha).toBeNull()
  })

  it('gracefully degrades sha to null on gitRevParse error', () => {
    const readFile = vi.fn().mockReturnValue('version: 1.0.0\n')
    const gitRevParse = vi.fn().mockImplementation(() => { throw new Error('not a git repo') })
    const result = inferPackIdentity('/packs/bmad', { readFile, gitRevParse })
    expect(result.sha).toBeNull()
    expect(result.version).toBe('1.0.0')
  })

  it('returns both null when pack directory is missing', () => {
    const readFile = vi.fn().mockImplementation(() => { throw new Error('ENOENT') })
    const gitRevParse = vi.fn().mockImplementation(() => { throw new Error('not a git repo') })
    const result = inferPackIdentity('/nonexistent', { readFile, gitRevParse })
    expect(result.version).toBeNull()
    expect(result.sha).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// dryRunCorpus
// ---------------------------------------------------------------------------

describe('dryRunCorpus', () => {
  it('marks all entries ready when all required fields present', () => {
    const corpus = {
      cases: [
        { case_id: 'c1', parent_sha: 'p1', story_file_input_path: '/story/1.md', commit_sha: 'cmt1' },
        { case_id: 'c2', parent_sha: 'p2', story_file_input_path: '/story/2.md', commit_sha: 'cmt2' },
      ],
      skipped: [],
    }
    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(true)
    expect(perPair).toHaveLength(2)
    expect(perPair[0].status).toBe('ready')
    expect(perPair[1].status).toBe('ready')
  })

  it('marks entries with missing commit_sha as errors', () => {
    const corpus = {
      cases: [
        { case_id: 'c1', parent_sha: 'p1', story_file_input_path: '/story/1.md' },
      ],
      skipped: [],
    }
    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(false)
    expect(perPair[0].status).toBe('error')
    expect(perPair[0].error).toContain('missing commit_sha')
  })

  it('marks entries with missing parent_sha as errors', () => {
    const corpus = {
      cases: [
        { case_id: 'c1', story_file_input_path: '/story/1.md', commit_sha: 'cmt1' },
      ],
      skipped: [],
    }
    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(false)
    expect(perPair[0].error).toContain('missing parent_sha')
  })

  it('reports pre-skipped entries as errors', () => {
    const corpus = {
      cases: [],
      skipped: [{ case_id: 's1', reason: 'missing parent_sha' }],
    }
    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(false)
    expect(perPair[0].caseId).toBe('s1')
    expect(perPair[0].status).toBe('error')
    expect(perPair[0].error).toContain('missing parent_sha')
  })

  it('returns ready=false when corpus has mixed ready and error entries', () => {
    const corpus = {
      cases: [
        { case_id: 'c1', parent_sha: 'p1', story_file_input_path: '/s/1.md', commit_sha: 'cmt1' },
        { case_id: 'c2', parent_sha: 'p2', story_file_input_path: '/s/2.md' }, // missing commit_sha
      ],
      skipped: [],
    }
    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(false)
    expect(perPair[0].status).toBe('ready')
    expect(perPair[1].status).toBe('error')
  })

  it('returns ready=false for empty corpus (no pairs)', () => {
    const { ready } = dryRunCorpus({ cases: [], skipped: [] })
    expect(ready).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration path: parseOutcomesCorpusForPackUpgrade → dryRunCorpus
// ---------------------------------------------------------------------------

describe('parseOutcomesCorpusForPackUpgrade → dryRunCorpus integration', () => {
  it('preserves commit_sha through parse and reports ready=true', () => {
    const yamlContent = `corpus_version: 1
cases:
  - id: story-1
    story_key: "42-1"
    parent_sha: abc123
    commit_sha: def456
    story_file_input_path: /story/42-1.md
`
    const corpus = parseOutcomesCorpusForPackUpgrade(yamlContent)
    expect(corpus.cases).toHaveLength(1)
    expect(corpus.cases[0].commit_sha).toBe('def456')

    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(true)
    expect(perPair[0].status).toBe('ready')
  })

  it('reports ready=false when commit_sha is absent from YAML', () => {
    const yamlContent = `corpus_version: 1
cases:
  - id: story-2
    story_key: "42-2"
    parent_sha: abc123
    story_file_input_path: /story/42-2.md
`
    const corpus = parseOutcomesCorpusForPackUpgrade(yamlContent)
    expect(corpus.cases[0].commit_sha).toBeNull()

    const { ready, perPair } = dryRunCorpus(corpus)
    expect(ready).toBe(false)
    expect(perPair[0].error).toContain('missing commit_sha')
  })
})

// ---------------------------------------------------------------------------
// Shared fixture builders for format tests
// ---------------------------------------------------------------------------

function makeGradeResult(overallVerdict: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN') {
  return {
    overall_verdict: overallVerdict,
    axes: {
      code_quality: {
        verdict: overallVerdict,
        mean_delta: -0.04,
        median_delta: -0.02,
        regression_count: 2,
        improvement_count: 5,
        ungradable_count: 1,
        per_pair: [
          { gradable: true, current_score: 0.9, candidate_score: 0.85, delta: -0.05 },
          { gradable: true, current_score: 0.7, candidate_score: 0.67, delta: -0.03 },
        ],
      },
      cost: {
        verdict: 'GREEN',
        mean_delta_turns: 0.8,
        mean_delta_input_tokens: 100,
        mean_delta_output_tokens: -50,
        p95s: { turns: 3, input_tokens: 500, output_tokens: 200 },
        ungradable_count: 0,
        per_pair: [],
      },
      verdict: {
        verdict: 'YELLOW',
        tv_distance: 0.12,
        current_distribution: { SHIP_IT: 8, LGTM_WITH_NOTES: 2 },
        candidate_distribution: { SHIP_IT: 6, LGTM_WITH_NOTES: 3, NEEDS_MINOR_FIXES: 1 },
        ungradable_count: 0,
        per_pair: [
          { gradable: true, current_verdict: 'SHIP_IT', candidate_verdict: 'LGTM_WITH_NOTES', shift: 'shifted-down' },
        ],
      },
      recovery: {
        verdict: 'GREEN',
        tv_distance: 0.04,
        current_distribution: { retry: 3 },
        candidate_distribution: { retry: 4 },
        ungradable_count: 2,
        per_pair: [],
      },
    },
    thresholds_used: {
      codeQuality: { warn: 0.05, fail: 0.15 },
      cost: { warnTurns: 0.10, failTurns: 0.25 },
      verdict: { warnTV: 0.10, failTV: 0.20 },
      recovery: { warnTV: 0.10, failTV: 0.20 },
    },
    pair_count: 10,
    pair_outcomes: { 'both-completed': 8, 'one-completed': 1, 'both-incomplete': 1 },
  }
}

function makePackIdentities() {
  return {
    current: { path: '/packs/bmad', version: '1.0.0', sha: 'abc123def456' },
    candidate: { path: '/packs/bmad-candidate', version: '1.1.0', sha: 'def456abc789' },
  }
}

function makeCorpusInfo() {
  return {
    path: '/corpus/outcomes-corpus.yaml',
    version: 1,
    pairCount: 10,
    completedBoth: 8,
    ungradable: 1,
  }
}

// ---------------------------------------------------------------------------
// formatMarkdownReport (AC3)
// ---------------------------------------------------------------------------

describe('formatMarkdownReport', () => {
  it('returns a string starting with the report title', () => {
    const result = formatMarkdownReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(typeof result).toBe('string')
    expect(result).toContain('# Pack-upgrade evaluation report')
  })

  it('includes pack paths and versions in the header', () => {
    const result = formatMarkdownReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('**Current pack**')
    expect(result).toContain('/packs/bmad')
    expect(result).toContain('**Candidate pack**')
    expect(result).toContain('/packs/bmad-candidate')
  })

  it('includes the overall verdict', () => {
    const result = formatMarkdownReport(makeGradeResult('RED'), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('**Overall verdict**')
    expect(result).toContain('RED')
  })

  it('includes the axis verdicts table with required headers', () => {
    const result = formatMarkdownReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('## Axis verdicts')
    expect(result).toContain('| Axis | Verdict | Headline |')
    expect(result).toContain('Code quality')
    expect(result).toContain('Verdict distribution')
    expect(result).toContain('Recovery taxonomy')
  })

  it('includes per-axis detail section', () => {
    const result = formatMarkdownReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('## Per-axis detail')
    expect(result).toContain('### Code quality')
    expect(result).toContain('### Cost')
    expect(result).toContain('### Verdict distribution')
    expect(result).toContain('### Recovery taxonomy')
  })

  it('includes corpus info in the header', () => {
    const result = formatMarkdownReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('**Corpus**')
    expect(result).toContain('10 pairs')
    expect(result).toContain('8 completed both')
  })

  it('includes configuration section', () => {
    const result = formatMarkdownReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('## Configuration')
  })

  it('uses emoji for verdict icons', () => {
    const result = formatMarkdownReport(makeGradeResult('GREEN'), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('🟢')
  })

  it('uses RED emoji for RED verdict', () => {
    const result = formatMarkdownReport(makeGradeResult('RED'), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('🔴')
  })
})

// ---------------------------------------------------------------------------
// formatJsonReport (AC4)
// ---------------------------------------------------------------------------

describe('formatJsonReport', () => {
  it('returns an object with report_version 1.0.0', () => {
    const result = formatJsonReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result.report_version).toBe('1.0.0')
  })

  it('includes generated_at ISO timestamp', () => {
    const result = formatJsonReport(
      makeGradeResult(),
      makePackIdentities(),
      makeCorpusInfo(),
      { generatedAt: '2026-05-31T12:00:00.000Z' },
    )
    expect(result.generated_at).toBe('2026-05-31T12:00:00.000Z')
  })

  it('includes pack_current with path, version, sha', () => {
    const result = formatJsonReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result.pack_current).toMatchObject({
      path: '/packs/bmad',
      version: '1.0.0',
      sha: 'abc123def456',
    })
  })

  it('includes pack_candidate with path, version, sha', () => {
    const result = formatJsonReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result.pack_candidate).toMatchObject({
      path: '/packs/bmad-candidate',
      version: '1.1.0',
      sha: 'def456abc789',
    })
  })

  it('includes corpus info', () => {
    const result = formatJsonReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result.corpus).toMatchObject({
      path: '/corpus/outcomes-corpus.yaml',
      version: 1,
      pair_count: 10,
    })
  })

  it('includes grade_result as the PackUpgradeGradeResult', () => {
    const gradeResult = makeGradeResult('YELLOW')
    const result = formatJsonReport(gradeResult, makePackIdentities(), makeCorpusInfo())
    expect(result.grade_result).toBe(gradeResult)
    expect(result.grade_result.overall_verdict).toBe('YELLOW')
  })

  it('handles null pack identities gracefully', () => {
    const result = formatJsonReport(makeGradeResult(), null, makeCorpusInfo())
    expect(result.pack_current.path).toBeNull()
    expect(result.pack_candidate.path).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// formatPlainReport (AC5)
// ---------------------------------------------------------------------------

describe('formatPlainReport', () => {
  it('returns a string without emoji', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(typeof result).toBe('string')
    // No emoji characters
    expect(result).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u)
  })

  it('starts with PACK-UPGRADE EVALUATION REPORT', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result.trimStart()).toMatch(/^PACK-UPGRADE EVALUATION REPORT/)
  })

  it('includes the four axis verdicts', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('Code quality')
    expect(result).toContain('Cost')
    expect(result).toContain('Verdict dist')
    expect(result).toContain('Recovery tax')
  })

  it('includes overall verdict', () => {
    const result = formatPlainReport(makeGradeResult('RED'), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('Overall verdict: RED')
  })

  it('stays under 80 lines', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    const lines = result.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBeLessThanOrEqual(80)
  })

  it('contains no markdown markers (no #, |, **)', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).not.toContain('# ')
    expect(result).not.toContain('| ')
    expect(result).not.toContain('**')
  })

  it('includes TOP REGRESSIONS section', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('TOP REGRESSIONS')
  })

  it('includes pack paths', () => {
    const result = formatPlainReport(makeGradeResult(), makePackIdentities(), makeCorpusInfo())
    expect(result).toContain('/packs/bmad')
    expect(result).toContain('/packs/bmad-candidate')
  })
})

// ---------------------------------------------------------------------------
// Exit codes via runPackUpgradeEval
// ---------------------------------------------------------------------------

/** Build a minimal fake gradeResult with the given overall_verdict. */
function fakGradeResult(verdict: 'GREEN' | 'YELLOW' | 'RED') {
  return {
    overall_verdict: verdict,
    axes: {
      code_quality: {
        verdict,
        mean_delta: 0,
        median_delta: 0,
        regression_count: 0,
        improvement_count: 0,
        ungradable_count: 0,
        per_pair: [],
      },
      cost: {
        verdict: 'GREEN',
        mean_delta_turns: 0,
        mean_delta_input_tokens: 0,
        mean_delta_output_tokens: 0,
        p95s: { turns: 0, input_tokens: 0, output_tokens: 0 },
        ungradable_count: 0,
        per_pair: [],
      },
      verdict: {
        verdict: 'GREEN',
        tv_distance: 0,
        current_distribution: {},
        candidate_distribution: {},
        ungradable_count: 0,
        per_pair: [],
      },
      recovery: {
        verdict: 'GREEN',
        tv_distance: 0,
        current_distribution: {},
        candidate_distribution: {},
        ungradable_count: 0,
        per_pair: [],
      },
    },
    thresholds_used: {},
    pair_count: 0,
    pair_outcomes: { 'both-completed': 0, 'one-completed': 0, 'both-incomplete': 0 },
  }
}

/** Minimal valid corpus YAML for tests. */
const MINIMAL_CORPUS_YAML = `corpus_version: 99
cases: []
`

/** Build minimal deps for runPackUpgradeEval tests. */
function makeMinimalDeps(verdictOverride: 'GREEN' | 'YELLOW' | 'RED' = 'GREEN') {
  return {
    loadPack: vi.fn().mockResolvedValue(undefined),
    readCorpus: vi.fn().mockReturnValue(MINIMAL_CORPUS_YAML),
    runHarness: vi.fn().mockResolvedValue([]),
    gradeAll: vi.fn().mockResolvedValue(fakGradeResult(verdictOverride)),
    gitDiff: vi.fn().mockReturnValue(''),
    gitRevParse: vi.fn().mockReturnValue(null),
    writeOutput: vi.fn(),
    stdout: { write: vi.fn() },
  }
}

describe('runPackUpgradeEval exit codes', () => {
  it('returns exitCode 0 for GREEN verdict', async () => {
    const deps = makeMinimalDeps('GREEN')
    const result = await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(result.exitCode).toBe(0)
    expect(result.gradeResult?.overall_verdict).toBe('GREEN')
  })

  it('returns exitCode 1 for YELLOW verdict', async () => {
    const deps = makeMinimalDeps('YELLOW')
    const result = await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(result.exitCode).toBe(1)
  })

  it('returns exitCode 2 for RED verdict', async () => {
    const deps = makeMinimalDeps('RED')
    const result = await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(result.exitCode).toBe(2)
  })

  it('returns exitCode 3 when pack loading fails', async () => {
    const deps = makeMinimalDeps('GREEN')
    deps.loadPack = vi.fn().mockRejectedValue(new Error('manifest not found'))
    const result = await runPackUpgradeEval({
      packCurrent: '/nonexistent/pack',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(result.exitCode).toBe(3)
    expect(result.error).toContain('cannot load')
  })

  it('returns exitCode 3 when corpus reading fails', async () => {
    const deps = makeMinimalDeps('GREEN')
    deps.readCorpus = vi.fn().mockImplementation(() => { throw new Error('ENOENT') })
    const result = await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/missing/corpus.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(result.exitCode).toBe(3)
  })

  it('returns exitCode 3 when corpus YAML is malformed', async () => {
    const deps = makeMinimalDeps('GREEN')
    deps.readCorpus = vi.fn().mockReturnValue('not: valid: yaml: {{{{')
    const result = await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(result.exitCode).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// End-to-end via runPackUpgradeEval with mocked deps
// ---------------------------------------------------------------------------

describe('runPackUpgradeEval end-to-end', () => {
  const CORPUS_YAML_WITH_CASES = `corpus_version: 7
cases:
  - id: case-1
    story_key: "42-1"
    run_id: run-001
    parent_sha: abc123
    commit_sha: def456
    story_file_input_path: /story/42-1.md
    expect:
      result_class: SHIP_IT
`

  it('calls loadPack for both packs', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(deps.loadPack).toHaveBeenCalledWith('/packs/current')
    expect(deps.loadPack).toHaveBeenCalledWith('/packs/candidate')
    expect(deps.loadPack).toHaveBeenCalledTimes(2)
  })

  it('calls readCorpus with the corpus path', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/special.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(deps.readCorpus).toHaveBeenCalledWith('/corpus/special.yaml')
  })

  it('calls runHarness with pack paths and budget', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain', budgetPerCaseUsd: 1.5 },
      deps,
    })
    expect(deps.runHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        packCurrent: '/packs/current',
        packCandidate: '/packs/candidate',
        budgetPerCaseUsd: 1.5,
      }),
    )
  })

  it('calls gradeAll with the pairs from runHarness', async () => {
    const cannedPairs = [
      { case_id: 'c1', pair_outcome: 'both-completed', current: { dispatch_outcome: 'completed' }, candidate: { dispatch_outcome: 'completed' } },
    ]
    const deps = makeMinimalDeps('GREEN')
    deps.runHarness = vi.fn().mockResolvedValue(cannedPairs)
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    expect(deps.gradeAll).toHaveBeenCalledWith(cannedPairs, expect.any(Object))
  })

  it('writes to stdout when format=plain and no --output given', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })
    // Should write report content to stdout
    expect(deps.stdout.write).toHaveBeenCalled()
  })

  it('writes to stdout when format=markdown and no --output given', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'markdown' },
      deps,
    })
    expect(deps.stdout.write).toHaveBeenCalled()
    // At least one write should contain markdown heading
    const allWrites = (deps.stdout.write as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(allWrites).toContain('# Pack-upgrade evaluation report')
  })

  it('calls writeOutput with path for format=json', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'json' },
      deps,
    })
    expect(deps.writeOutput).toHaveBeenCalledTimes(1)
    const [path, content] = (deps.writeOutput as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(path).toContain('pack-upgrade-')
    const parsed = JSON.parse(content)
    expect(parsed.report_version).toBe('1.0.0')
    expect(parsed.grade_result.overall_verdict).toBe('GREEN')
  })

  it('calls writeOutput with explicit --output path', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain', output: '/tmp/myreport.txt' },
      deps,
    })
    expect(deps.writeOutput).toHaveBeenCalledWith('/tmp/myreport.txt', expect.any(String))
  })

  it('resolves ground-truth diffs for both-completed pairs when corpus entry has commit_sha', async () => {
    const cannedPairs = [
      {
        case_id: 'case-1',
        pair_outcome: 'both-completed',
        current: { dispatch_outcome: 'completed' },
        candidate: { dispatch_outcome: 'completed' },
      },
    ]
    const deps = makeMinimalDeps('GREEN')
    deps.readCorpus = vi.fn().mockReturnValue(CORPUS_YAML_WITH_CASES)
    deps.runHarness = vi.fn().mockResolvedValue(cannedPairs)
    deps.gitDiff = vi.fn().mockReturnValue('ground truth diff')

    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: { format: 'plain' },
      deps,
    })

    // gitDiff should have been called with the corpus entry's parent and commit sha
    expect(deps.gitDiff).toHaveBeenCalledWith(
      expect.any(String), // repoRoot
      'abc123',
      'def456',
    )
  })

  it('passes warnThresholds through to gradeAll', async () => {
    const deps = makeMinimalDeps('GREEN')
    await runPackUpgradeEval({
      packCurrent: '/packs/current',
      packCandidate: '/packs/candidate',
      corpus: '/corpus/test.yaml',
      options: {
        format: 'plain',
        warnThresholds: { 'code-quality': 0.05 },
      },
      deps,
    })
    expect(deps.gradeAll).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        thresholds: expect.objectContaining({
          codeQuality: expect.objectContaining({ warn: 0.05 }),
        }),
      }),
    )
  })
})
