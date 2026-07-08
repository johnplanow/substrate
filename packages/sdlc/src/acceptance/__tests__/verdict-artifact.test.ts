/**
 * A2.2 — verdict HTML artifact.
 *
 * The escaping test is the security-relevant one: evidence excerpts are
 * UNTRUSTED product output rendered into the operator's review page.
 */

import { describe, it, expect } from 'vitest'
import { renderVerdictHtml } from '../verdict-artifact.js'

describe('renderVerdictHtml', () => {
  it('renders journey sections, verdicts, evidence, and state summary', () => {
    const html = renderVerdictHtml({
      scope: 'run-abc final',
      generatedAt: '2026-07-08T00:00:00Z',
      journeys: [
        {
          journeyId: 'UJ-2',
          title: 'Operator decides on an emailed Dossier',
          criticality: 'critical',
          state: 'walked-fail',
          ownerStories: ['6-1'],
          verdicts: [
            { end_state_id: 'UJ-2.a', verdict: 'PASS', artifact: 'email.html', excerpt: 'Yes link present' },
            { end_state_id: 'UJ-2.b', verdict: 'UNREACHABLE', artifact: 'email.html', excerpt: 'no decision endpoint' },
          ],
        },
        {
          journeyId: 'UJ-5',
          title: 'Weekly report',
          criticality: 'standard',
          state: 'unclaimed',
          ownerStories: [],
          verdicts: [],
        },
      ],
    })

    expect(html).toContain('UJ-2')
    expect(html).toContain('UNREACHABLE')
    expect(html).toContain('never wired')
    expect(html).toContain('NO story claims this journey')
    expect(html).toContain('walked-fail: 1')
    expect(html).toContain('unclaimed: 1')
    expect(html).toContain('not walked — no judge verdicts recorded')
  })

  it('SECURITY: escapes hostile excerpt/artifact content — no script reaches the operator page', () => {
    const html = renderVerdictHtml({
      scope: 'x',
      generatedAt: 'now',
      journeys: [
        {
          journeyId: 'UJ-1',
          title: '<script>alert("t")</script>',
          criticality: 'critical',
          state: 'walked-pass',
          ownerStories: ['1-1'],
          verdicts: [
            {
              end_state_id: 'UJ-1.a',
              verdict: 'PASS',
              artifact: '"><img src=x onerror=alert(1)>',
              excerpt: '<script>document.location="https://evil"</script>',
            },
          ],
        },
      ],
    })

    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>document.location')
    expect(html).toContain('&lt;script&gt;')
  })
})
