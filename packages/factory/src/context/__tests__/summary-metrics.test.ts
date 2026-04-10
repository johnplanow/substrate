import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import type { Summary } from '../summary-types.js'
import {
  computeCompressionRatio,
  extractKeyFacts,
  computeKeyFactRetentionRate,
  computeRoundTripScore,
  SummaryQualityAnalyzer,
  QualityMetricsPersistence,
} from '../summary-metrics.js'

function makeSummary(overrides?: Partial<Summary>): Summary {
  return {
    level: 'medium',
    content: 'summary content',
    originalHash: 'abc123',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ─── computeCompressionRatio ──────────────────────────────────────────────────

describe('computeCompressionRatio', () => {
  it('returns summaryTokenCount / originalTokenCount when both are present', () => {
    const summary = makeSummary({ originalTokenCount: 100, summaryTokenCount: 50 })
    expect(computeCompressionRatio(summary)).toBe(0.5)
  })

  it('returns -1 when originalTokenCount is absent', () => {
    // Omit originalTokenCount to test undefined branch (exactOptionalPropertyTypes)
    const summary = makeSummary()
    expect(computeCompressionRatio(summary)).toBe(-1)
  })

  it('returns -1 when originalTokenCount is zero', () => {
    const summary = makeSummary({ originalTokenCount: 0, summaryTokenCount: 50 })
    expect(computeCompressionRatio(summary)).toBe(-1)
  })

  it('returns -1 when summaryTokenCount is absent', () => {
    // Omit summaryTokenCount to test undefined branch (exactOptionalPropertyTypes)
    const summary = makeSummary({ originalTokenCount: 100 })
    expect(computeCompressionRatio(summary)).toBe(-1)
  })
})

// ─── extractKeyFacts ──────────────────────────────────────────────────────────

describe('extractKeyFacts', () => {
  it('detects fenced code blocks', () => {
    const content = 'Some text\n```\nconst x = 1;\n```\nMore text'
    const facts = extractKeyFacts(content)
    const entries = [...facts]
    expect(entries.some((e) => e.includes('const x = 1'))).toBe(true)
  })

  it('detects file-path tokens', () => {
    // Note: the spec regex [\w./]+ does not match hyphens, so use a hyphen-free path
    const content = 'See packages/factory/src/context/index.ts for details'
    const facts = extractKeyFacts(content)
    expect(facts.has('packages/factory/src/context/index.ts')).toBe(true)
  })

  it('detects error-type names', () => {
    const content = 'The operation failed with ENOENT'
    const facts = extractKeyFacts(content)
    expect(facts.has('ENOENT')).toBe(true)
  })

  it('returns empty set for plain prose text', () => {
    const content = 'hello world no facts here'
    const facts = extractKeyFacts(content)
    expect(facts.size).toBe(0)
  })
})

// ─── computeKeyFactRetentionRate ──────────────────────────────────────────────

describe('computeKeyFactRetentionRate', () => {
  it('returns 1.0 when original and summarized both contain the same file path', () => {
    const original = 'See src/index.ts for implementation'
    const summarized = 'Refer to src/index.ts'
    expect(computeKeyFactRetentionRate(original, summarized)).toBe(1.0)
  })

  it('returns 1.0 when original has no key facts', () => {
    const original = 'plain prose with no structured facts'
    const summarized = 'a different summary'
    expect(computeKeyFactRetentionRate(original, summarized)).toBe(1.0)
  })

  it('returns approximately 0.5 when original has two file paths and summarized retains only one', () => {
    const original = 'Check src/index.ts and src/utils.ts for details'
    const summarized = 'Look at src/index.ts only'
    const rate = computeKeyFactRetentionRate(original, summarized)
    expect(rate).toBeCloseTo(0.5)
  })
})

// ─── computeRoundTripScore ────────────────────────────────────────────────────

describe('computeRoundTripScore', () => {
  it('returns 1.0 for identical strings', () => {
    const s = 'alpha beta gamma delta'
    expect(computeRoundTripScore(s, s)).toBe(1.0)
  })

  it('returns 0.0 for completely disjoint word sets', () => {
    expect(computeRoundTripScore('alpha beta', 'gamma delta')).toBe(0.0)
  })

  it('returns a value strictly between 0 and 1 for partial overlap', () => {
    const score = computeRoundTripScore('alpha beta gamma', 'alpha beta delta')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })
})

// ─── SummaryQualityAnalyzer ───────────────────────────────────────────────────

describe('SummaryQualityAnalyzer', () => {
  const analyzer = new SummaryQualityAnalyzer()

  it('returns roundTripScore null and overallScore === keyFactRetentionRate when no expanded provided', () => {
    const original = 'some original content with src/index.ts'
    const summary = makeSummary({ content: 'summary with src/index.ts' })
    const report = analyzer.analyze(original, summary)
    expect(report.roundTripScore).toBeNull()
    expect(report.overallScore).toBe(report.keyFactRetentionRate)
  })

  it('returns non-null roundTripScore and correct overallScore when expanded equals original', () => {
    const original = 'some original content with src/index.ts'
    const summary = makeSummary({ content: 'summary with src/index.ts' })
    const report = analyzer.analyze(original, summary, original)
    expect(report.roundTripScore).toBe(1.0)
    const expected = report.keyFactRetentionRate * 0.6 + 1.0 * 0.4
    expect(report.overallScore).toBeCloseTo(expected)
  })

  it('includes summaryHash from summary.originalHash', () => {
    const summary = makeSummary({ originalHash: 'deadbeef' })
    const report = analyzer.analyze('content', summary)
    expect(report.summaryHash).toBe('deadbeef')
  })

  it('includes level from summary.level', () => {
    const summary = makeSummary({ level: 'low' })
    const report = analyzer.analyze('content', summary)
    expect(report.level).toBe('low')
  })

  it('sets computedAt as ISO-8601 string', () => {
    const summary = makeSummary()
    const report = analyzer.analyze('content', summary)
    expect(() => new Date(report.computedAt)).not.toThrow()
    expect(report.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// ─── QualityMetricsPersistence ────────────────────────────────────────────────

describe('QualityMetricsPersistence', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'summary-metrics-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  function makeReport() {
    const analyzer = new SummaryQualityAnalyzer()
    const summary = makeSummary({ originalHash: 'test-hash-001' })
    return analyzer.analyze('original content', summary)
  }

  it('record() then readAll() returns array of length 1 with correct summaryHash and recordedAt', async () => {
    const persistence = new QualityMetricsPersistence({ runId: 'run-1', storageDir: tmpDir })
    const report = makeReport()
    await persistence.record(report)
    const entries = await persistence.readAll()
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.summaryHash).toBe(report.summaryHash)
    expect(typeof entry.recordedAt).toBe('string')
    expect(entry.recordedAt.length).toBeGreaterThan(0)
  })

  it('readAll() returns [] when no file exists at the metrics path', async () => {
    const persistence = new QualityMetricsPersistence({ runId: 'run-2', storageDir: tmpDir })
    const entries = await persistence.readAll()
    expect(entries).toEqual([])
  })

  it('multiple records are returned in insertion order', async () => {
    const persistence = new QualityMetricsPersistence({ runId: 'run-3', storageDir: tmpDir })
    const report1 = makeReport()
    const report2 = { ...makeReport(), summaryHash: 'second-hash' }
    await persistence.record(report1)
    await persistence.record(report2)
    const entries = await persistence.readAll()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.summaryHash).toBe(report1.summaryHash)
    expect(entries[1]!.summaryHash).toBe('second-hash')
  })
})
