// src/modules/eval/reporter.ts
import type { EvalReport, ReportFormat } from './types.js'

export class EvalReporter {
  format(report: EvalReport, fmt: ReportFormat): string {
    switch (fmt) {
      case 'json':
        return this.formatJson(report)
      case 'markdown':
        return this.formatMarkdown(report)
      case 'table':
      default:
        return this.formatTable(report)
    }
  }

  private formatTable(report: EvalReport): string {
    const lines: string[] = []
    lines.push(`substrate eval — run ${report.runId} (${report.depth})`)
    lines.push('')

    const hdr = `${'Phase'.padEnd(20)} ${'Score'.padEnd(8)} ${'Pass'.padEnd(6)} Issues`
    lines.push(hdr)
    lines.push('─'.repeat(70))

    for (const phase of report.phases) {
      const passLabel = phase.pass ? 'yes' : 'FAIL'
      const issueText = phase.issues.length > 0 ? phase.issues[0] : ''
      lines.push(
        `${phase.phase.padEnd(20)} ${phase.score.toFixed(2).padEnd(8)} ${passLabel.padEnd(6)} ${issueText}`,
      )
      for (const issue of phase.issues.slice(1)) {
        lines.push(`${''.padEnd(36)} ${issue}`)
      }
    }

    lines.push('')
    lines.push(
      `Overall: ${report.overallScore.toFixed(2)} (pass threshold: 0.70)`,
    )
    lines.push(
      `Result: ${report.pass ? 'PASS' : 'FAIL'}${!report.pass ? ` — ${report.phases.filter((p) => !p.pass).length} phase(s) below threshold` : ''}`,
    )

    return lines.join('\n')
  }

  private formatJson(report: EvalReport): string {
    return JSON.stringify(report, null, 2)
  }

  private formatMarkdown(report: EvalReport): string {
    const lines: string[] = []
    lines.push(`# Eval Report`)
    lines.push('')
    lines.push(`**Run:** ${report.runId}`)
    lines.push(`**Depth:** ${report.depth}`)
    lines.push(`**Overall:** ${report.overallScore.toFixed(2)} (${report.pass ? 'PASS' : 'FAIL'})`)
    lines.push('')

    lines.push('| Phase | Score | Pass | Issues |')
    lines.push('|---|---|---|---|')
    for (const phase of report.phases) {
      const passLabel = phase.pass ? 'yes' : 'FAIL'
      const issues = phase.issues.join('; ') || '-'
      lines.push(`| ${phase.phase} | ${phase.score.toFixed(2)} | ${passLabel} | ${issues} |`)
    }

    return lines.join('\n')
  }
}
