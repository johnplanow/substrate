// src/modules/eval/reporter.ts
import type { EvalReport, ReportFormat, ThresholdConfig } from './types.js'
import { DEFAULT_PASS_THRESHOLD } from './types.js'
import { resolveThreshold } from './eval-engine.js'
import type { CompareReport } from './comparer.js'

export interface ReporterOptions {
  thresholds?: ThresholdConfig
}

export class EvalReporter {
  format(report: EvalReport, fmt: ReportFormat, options?: ReporterOptions): string {
    switch (fmt) {
      case 'json':
        return this.formatJson(report)
      case 'markdown':
        return this.formatMarkdown(report, options)
      case 'table':
      default:
        return this.formatTable(report, options)
    }
  }

  private formatTable(report: EvalReport, options?: ReporterOptions): string {
    const lines: string[] = []
    lines.push(`substrate eval — run ${report.runId} (${report.depth})`)
    lines.push('')

    const hdr = `${'Phase'.padEnd(20)} ${'Score'.padEnd(8)} ${'Thresh'.padEnd(8)} ${'Pass'.padEnd(6)} Issues`
    lines.push(hdr)
    lines.push('─'.repeat(78))

    for (const phase of report.phases) {
      const threshold = resolveThreshold(phase.phase, options?.thresholds)
      const passLabel = phase.pass ? 'yes' : 'FAIL'
      const issueText = phase.issues.length > 0 ? phase.issues[0] : ''
      lines.push(
        `${phase.phase.padEnd(20)} ${phase.score.toFixed(2).padEnd(8)} ${threshold.toFixed(2).padEnd(8)} ${passLabel.padEnd(6)} ${issueText}`,
      )
      for (const issue of phase.issues.slice(1)) {
        lines.push(`${''.padEnd(44)} ${issue}`)
      }
    }

    const defaultThreshold = options?.thresholds?.default ?? DEFAULT_PASS_THRESHOLD
    lines.push('')
    lines.push(
      `Overall: ${report.overallScore.toFixed(2)} (default threshold: ${defaultThreshold.toFixed(2)})`,
    )
    lines.push(
      `Result: ${report.pass ? 'PASS' : 'FAIL'}${!report.pass ? ` — ${report.phases.filter((p) => !p.pass).length} phase(s) below threshold` : ''}`,
    )

    return lines.join('\n')
  }

  private formatJson(report: EvalReport): string {
    return JSON.stringify(report, null, 2)
  }

  formatComparison(report: CompareReport, fmt: ReportFormat): string {
    switch (fmt) {
      case 'json':
        return JSON.stringify(report, null, 2)
      case 'markdown':
        return this.formatComparisonMarkdown(report)
      case 'table':
      default:
        return this.formatComparisonTable(report)
    }
  }

  private formatComparisonTable(report: CompareReport): string {
    const lines: string[] = []
    lines.push(`substrate eval --compare ${report.runIdA} vs ${report.runIdB}`)
    lines.push('')

    if (report.metadataDiff && (report.metadataDiff.rubricHashesChanged || report.metadataDiff.judgeModelChanged)) {
      lines.push('WARNING: eval configuration differs between runs (rubric or judge model changed)')
      lines.push('')
    }

    const hdr = `${'Phase'.padEnd(20)} ${'Run A'.padEnd(8)} ${'Run B'.padEnd(8)} ${'Delta'.padEnd(8)} Verdict`
    lines.push(hdr)
    lines.push('─'.repeat(60))

    for (const p of report.phases) {
      const scoreA = p.scoreA !== undefined ? p.scoreA.toFixed(2) : 'n/a'
      const scoreB = p.scoreB !== undefined ? p.scoreB.toFixed(2) : 'n/a'
      const delta = p.delta !== undefined ? (p.delta >= 0 ? `+${p.delta.toFixed(2)}` : p.delta.toFixed(2)) : 'n/a'
      lines.push(
        `${p.phase.padEnd(20)} ${scoreA.padEnd(8)} ${scoreB.padEnd(8)} ${delta.padEnd(8)} ${p.verdict}`,
      )
    }

    lines.push('')
    lines.push(`Result: ${report.hasRegression ? 'REGRESSION DETECTED' : 'No regressions'}`)

    return lines.join('\n')
  }

  private formatComparisonMarkdown(report: CompareReport): string {
    const lines: string[] = []
    lines.push('# Eval Comparison')
    lines.push('')
    lines.push(`**Run A:** ${report.runIdA}`)
    lines.push(`**Run B:** ${report.runIdB}`)
    lines.push(`**Result:** ${report.hasRegression ? 'REGRESSION DETECTED' : 'No regressions'}`)
    lines.push('')

    if (report.metadataDiff && (report.metadataDiff.rubricHashesChanged || report.metadataDiff.judgeModelChanged)) {
      lines.push('> **Warning:** eval configuration differs between runs')
      lines.push('')
    }

    lines.push('| Phase | Run A | Run B | Delta | Verdict |')
    lines.push('|---|---|---|---|---|')
    for (const p of report.phases) {
      const scoreA = p.scoreA !== undefined ? p.scoreA.toFixed(2) : 'n/a'
      const scoreB = p.scoreB !== undefined ? p.scoreB.toFixed(2) : 'n/a'
      const delta = p.delta !== undefined ? (p.delta >= 0 ? `+${p.delta.toFixed(2)}` : p.delta.toFixed(2)) : 'n/a'
      lines.push(`| ${p.phase} | ${scoreA} | ${scoreB} | ${delta} | ${p.verdict} |`)
    }

    return lines.join('\n')
  }

  private formatMarkdown(report: EvalReport, options?: ReporterOptions): string {
    const lines: string[] = []
    lines.push(`# Eval Report`)
    lines.push('')
    lines.push(`**Run:** ${report.runId}`)
    lines.push(`**Depth:** ${report.depth}`)
    lines.push(`**Overall:** ${report.overallScore.toFixed(2)} (${report.pass ? 'PASS' : 'FAIL'})`)
    lines.push('')

    lines.push('| Phase | Score | Threshold | Pass | Issues |')
    lines.push('|---|---|---|---|---|')
    for (const phase of report.phases) {
      const threshold = resolveThreshold(phase.phase, options?.thresholds)
      const passLabel = phase.pass ? 'yes' : 'FAIL'
      const issues = phase.issues.join('; ') || '-'
      lines.push(`| ${phase.phase} | ${phase.score.toFixed(2)} | ${threshold.toFixed(2)} | ${passLabel} | ${issues} |`)
    }

    return lines.join('\n')
  }
}
