/**
 * Acceptance Gate — minutes-scale verdict artifact (A2.2).
 *
 * One self-contained HTML page per audit: journey × end-state verdict table,
 * every FAIL/UNREACHABLE anchored to its cited evidence. Target: an operator
 * verdicts it in under a minute (the morning-review surface for
 * journey-critical PASS branches).
 *
 * SECURITY: evidence excerpts are UNTRUSTED product output rendered into
 * HTML — everything is escaped; a hostile artifact cannot script the
 * operator's review page.
 */

import type { JourneyCoverageEntry } from './coverage.js'

export interface VerdictArtifactEndState {
  end_state_id: string
  verdict: 'PASS' | 'FAIL' | 'UNREACHABLE'
  artifact: string
  excerpt: string
  reasoning?: string
}

export interface VerdictArtifactJourney {
  journeyId: string
  title: string
  criticality: 'critical' | 'standard'
  state: JourneyCoverageEntry['state'] | 'unknown'
  ownerStories: string[]
  verdicts: VerdictArtifactEndState[]
}

export interface VerdictArtifactInput {
  /** e.g. run id or "epic-2 close" */
  scope: string
  generatedAt: string
  journeys: VerdictArtifactJourney[]
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STATE_COLORS: Record<string, string> = {
  'walked-pass': '#1a7f37',
  'walked-fail': '#cf222e',
  deferred: '#9a6700',
  unclaimed: '#cf222e',
  unwalked: '#9a6700',
  unknown: '#6e7781',
}

const VERDICT_COLORS: Record<string, string> = {
  PASS: '#1a7f37',
  FAIL: '#cf222e',
  UNREACHABLE: '#a40e26',
}

/** Render the verdict page. Pure — caller writes it wherever it belongs. */
export function renderVerdictHtml(input: VerdictArtifactInput): string {
  const rows = input.journeys
    .map((j) => {
      const stateColor = STATE_COLORS[j.state] ?? '#6e7781'
      const verdictRows =
        j.verdicts.length > 0
          ? j.verdicts
              .map(
                (v) => `
      <tr>
        <td><code>${esc(v.end_state_id)}</code></td>
        <td style="color:${VERDICT_COLORS[v.verdict] ?? '#000'};font-weight:bold">${esc(v.verdict)}${v.verdict === 'UNREACHABLE' ? ' ⚠ never wired' : ''}</td>
        <td><code>${esc(v.artifact)}</code></td>
        <td><pre>${esc(v.excerpt)}</pre>${v.reasoning !== undefined ? `<div class="why">${esc(v.reasoning)}</div>` : ''}</td>
      </tr>`,
              )
              .join('')
          : `
      <tr><td colspan="4" class="nowalk">not walked — no judge verdicts recorded</td></tr>`
      return `
  <section>
    <h2>${esc(j.journeyId)} <small>[${esc(j.criticality)}]</small> — ${esc(j.title)}</h2>
    <p>state: <strong style="color:${stateColor}">${esc(j.state)}</strong>${
      j.ownerStories.length > 0 ? ` · claimed by ${esc(j.ownerStories.join(', '))}` : ' · <strong>NO story claims this journey</strong>'
    }</p>
    <table>
      <thead><tr><th>end-state</th><th>verdict</th><th>artifact</th><th>evidence</th></tr></thead>
      <tbody>${verdictRows}
      </tbody>
    </table>
  </section>`
    })
    .join('\n')

  const counts = input.journeys.reduce<Record<string, number>>((acc, j) => {
    acc[j.state] = (acc[j.state] ?? 0) + 1
    return acc
  }, {})
  const summary = Object.entries(counts)
    .map(([state, n]) => `${esc(state)}: ${String(n)}`)
    .join(' · ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Acceptance verdicts — ${esc(input.scope)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; color: #1f2328; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }
  th, td { border: 1px solid #d0d7de; padding: .4rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 8rem; overflow-y: auto; background: #f6f8fa; padding: .3rem; }
  .why { color: #57606a; font-size: .85rem; margin-top: .25rem; }
  .nowalk { color: #9a6700; font-style: italic; }
  h1 small, h2 small { color: #57606a; font-weight: normal; }
</style>
</head>
<body>
<h1>Acceptance verdicts <small>${esc(input.scope)} · ${esc(input.generatedAt)}</small></h1>
<p>${summary}</p>
${rows}
</body>
</html>
`
}
