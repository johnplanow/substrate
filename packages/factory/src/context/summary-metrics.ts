/**
 * Summary quality metrics: compression ratio, key-fact retention, round-trip preservation.
 *
 * Provides pure metric computation functions, a SummaryQualityAnalyzer class, and
 * QualityMetricsPersistence for recording metrics to a JSONL file.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Summary, SummaryLevel } from './summary-types.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QualityReport {
  summaryHash: string
  level: SummaryLevel
  /** [0,1] when available; -1 sentinel when token counts absent */
  compressionRatio: number
  keyFactRetentionRate: number
  /** null when expanded not provided */
  roundTripScore: number | null
  overallScore: number
  /** ISO-8601 */
  computedAt: string
}

export interface PersistedQualityEntry extends QualityReport {
  /** ISO-8601 — time written to disk */
  recordedAt: string
}

export interface QualityThresholds {
  minKeyFactRetentionRate?: number
  minRoundTripScore?: number
  minOverallScore?: number
}

export class QualityBelowThresholdError extends Error {
  constructor(
    public readonly report: QualityReport,
    public readonly failures: string[],
  ) {
    super(`Summary quality below threshold: ${failures.join(', ')}`)
    this.name = 'QualityBelowThresholdError'
  }
}

export interface QualityMetricsPersistenceConfig {
  runId: string
  storageDir: string
}

// ─── Pure Metric Computation Functions ───────────────────────────────────────

/**
 * Compute the compression ratio of a summary.
 * Returns summaryTokenCount / originalTokenCount in [0, 1].
 * Returns -1 as a sentinel when token counts are absent or originalTokenCount is zero.
 */
export function computeCompressionRatio(summary: Summary): number {
  if (
    summary.originalTokenCount === undefined ||
    summary.originalTokenCount === 0 ||
    summary.summaryTokenCount === undefined
  ) {
    return -1
  }
  return summary.summaryTokenCount / summary.originalTokenCount
}

/**
 * Extract key facts from content:
 * - Fenced code blocks (triple-backtick)
 * - File-path tokens matching known extensions
 * - Error-type names
 */
export function extractKeyFacts(content: string): Set<string> {
  const facts = new Set<string>()

  // Extract fenced code blocks
  const codeBlockRegex = /```[\s\S]*?```/g
  let match: RegExpExecArray | null
  while ((match = codeBlockRegex.exec(content)) !== null) {
    facts.add(match[0].trim())
  }

  // Extract file-path tokens
  const filePathRegex = /[\w./]+(\.ts|\.js|\.json|\.md|\.go|\.py|\.yaml|\.yml)\b/g
  while ((match = filePathRegex.exec(content)) !== null) {
    facts.add(match[0])
  }

  // Extract error-type names
  const errorTypeRegex = /\b(Error|Exception|ENOENT|ETIMEDOUT|TypeError|SyntaxError)\b/g
  while ((match = errorTypeRegex.exec(content)) !== null) {
    facts.add(match[0])
  }

  return facts
}

/**
 * Compute the key-fact retention rate between original and summarized content.
 * Returns the fraction of original key facts that appear in the summarized content.
 * Returns 1.0 when the original has no key facts.
 */
export function computeKeyFactRetentionRate(original: string, summarized: string): number {
  const originalFacts = extractKeyFacts(original)
  const summarizedFacts = extractKeyFacts(summarized)

  if (originalFacts.size === 0) {
    return 1.0
  }

  const preserved = [...originalFacts].filter(f => summarizedFacts.has(f)).length
  return preserved / originalFacts.size
}

/**
 * Compute the round-trip preservation score between original and expanded content.
 * Uses Jaccard word-set overlap: intersection / union.
 * Returns 1.0 when both word sets are empty.
 * Returns 0.0 when exactly one set is non-empty.
 */
export function computeRoundTripScore(original: string, expanded: string): number {
  const words = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 0))

  const wordsA = words(original)
  const wordsB = words(expanded)

  if (wordsA.size === 0 && wordsB.size === 0) {
    return 1.0
  }

  const intersection = [...wordsA].filter(w => wordsB.has(w)).length
  const union = new Set([...wordsA, ...wordsB]).size
  return intersection / union
}

// ─── SummaryQualityAnalyzer ───────────────────────────────────────────────────

export class SummaryQualityAnalyzer {
  analyze(original: string, summary: Summary, expanded?: string): QualityReport {
    const compressionRatio = computeCompressionRatio(summary)
    const keyFactRetentionRate = computeKeyFactRetentionRate(original, summary.content)
    const roundTripScore =
      expanded !== undefined ? computeRoundTripScore(original, expanded) : null
    const overallScore =
      roundTripScore !== null
        ? keyFactRetentionRate * 0.6 + roundTripScore * 0.4
        : keyFactRetentionRate

    return {
      summaryHash: summary.originalHash,
      level: summary.level,
      compressionRatio,
      keyFactRetentionRate,
      roundTripScore,
      overallScore,
      computedAt: new Date().toISOString(),
    }
  }

  assertQuality(report: QualityReport, thresholds: QualityThresholds): void {
    const failures: string[] = []

    if (
      thresholds.minKeyFactRetentionRate !== undefined &&
      report.keyFactRetentionRate < thresholds.minKeyFactRetentionRate
    ) {
      failures.push(
        `keyFactRetentionRate ${report.keyFactRetentionRate.toFixed(3)} < ${thresholds.minKeyFactRetentionRate}`,
      )
    }

    if (
      thresholds.minRoundTripScore !== undefined &&
      report.roundTripScore !== null &&
      report.roundTripScore < thresholds.minRoundTripScore
    ) {
      failures.push(
        `roundTripScore ${report.roundTripScore.toFixed(3)} < ${thresholds.minRoundTripScore}`,
      )
    }

    if (
      thresholds.minOverallScore !== undefined &&
      report.overallScore < thresholds.minOverallScore
    ) {
      failures.push(
        `overallScore ${report.overallScore.toFixed(3)} < ${thresholds.minOverallScore}`,
      )
    }

    if (failures.length > 0) {
      throw new QualityBelowThresholdError(report, failures)
    }
  }
}

// ─── QualityMetricsPersistence ────────────────────────────────────────────────

export class QualityMetricsPersistence {
  constructor(private readonly config: QualityMetricsPersistenceConfig) {}

  private metricsPath(): string {
    return join(this.config.storageDir, 'runs', this.config.runId, 'quality-metrics.jsonl')
  }

  async record(report: QualityReport): Promise<void> {
    const dir = join(this.config.storageDir, 'runs', this.config.runId)
    await mkdir(dir, { recursive: true })
    const entry: PersistedQualityEntry = { ...report, recordedAt: new Date().toISOString() }
    await appendFile(this.metricsPath(), JSON.stringify(entry) + '\n', 'utf-8')
  }

  async readAll(): Promise<PersistedQualityEntry[]> {
    try {
      const raw = await readFile(this.metricsPath(), 'utf-8')
      return raw
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as PersistedQualityEntry)
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }
}
