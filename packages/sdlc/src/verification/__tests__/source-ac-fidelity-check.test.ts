/**
 * Unit tests for SourceAcFidelityCheck — Story 58-2 (AC8).
 *
 * Covers:
 * - (a) All MUST clauses present → pass (AC5, AC8a)
 * - (b) One MUST NOT clause missing → fail with single source-ac-drift finding (AC4, AC8b)
 * - (c) Multiple missing clauses → one finding per missing clause (AC4, AC8c)
 * - (d) sourceEpicContent undefined → warn finding source-ac-source-unavailable, status pass (AC2, AC8d)
 * - (e) Runtime Probes block in source but absent in storyContent → fail (AC3, AC8e)
 */

import { describe, it, expect } from 'vitest'
import { SourceAcFidelityCheck } from '../source-ac-fidelity-check.js'
import type { VerificationContext } from '../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal VerificationContext for tests. */
function makeContext(overrides?: Partial<VerificationContext>): VerificationContext {
  return {
    storyKey: '58-2',
    workingDir: '/tmp/test',
    commitSha: 'abc',
    timeout: 60000,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SourceAcFidelityCheck', () => {
  const check = new SourceAcFidelityCheck()

  it('has name "source-ac-fidelity" and tier "A"', () => {
    expect(check.name).toBe('source-ac-fidelity')
    expect(check.tier).toBe('A')
  })

  // AC8d: sourceEpicContent undefined → warn finding, status pass
  describe('when sourceEpicContent is undefined', () => {
    it('returns status pass with a warn finding (source-ac-source-unavailable)', async () => {
      const ctx = makeContext({ storyContent: 'some story content', sourceEpicContent: undefined })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      expect(result.findings).toHaveLength(1)
      expect(result.findings![0].severity).toBe('warn')
      expect(result.findings![0].category).toBe('source-ac-source-unavailable')
    })
  })

  // AC8d variant: sourceEpicContent empty string → same as undefined
  describe('when sourceEpicContent is empty string', () => {
    it('returns status pass with a warn finding (source-ac-source-unavailable)', async () => {
      const ctx = makeContext({ storyContent: 'some story content', sourceEpicContent: '' })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      expect(result.findings).toHaveLength(1)
      expect(result.findings![0].category).toBe('source-ac-source-unavailable')
    })
  })

  // AC8a: All MUST clauses present → pass
  describe('when all MUST clauses are present in storyContent', () => {
    it('returns status pass with zero error findings', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The implementation MUST use the new API.
The system MUST NOT retain legacy config.
Files SHALL be placed in the correct directory.
`
      const storyContent = `
The implementation MUST use the new API.
The system MUST NOT retain legacy config.
Files SHALL be placed in the correct directory.
`
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      const errorFindings = result.findings?.filter((f) => f.severity === 'error') ?? []
      expect(errorFindings).toHaveLength(0)
    })
  })

  // AC8b: One MUST NOT clause absent → pass with one advisory source-ac-drift finding
  // Story 58-9: fidelity drift is now advisory (warn-severity); status stays `pass`
  // so the pipeline doesn't hard-gate on paraphrase-class false positives while
  // the matcher is being calibrated (obs_2026-04-21_004).
  describe('when one MUST NOT clause is absent from storyContent', () => {
    it('returns status pass with exactly one source-ac-drift warn finding', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The system MUST NOT retain legacy config.
`
      const storyContent = `
This story does something completely different.
`
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].category).toBe('source-ac-drift')
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('MUST NOT')
      expect(driftFindings[0].message).toContain('present in epics source but absent in story artifact')
    })
  })

  // AC8c: Multiple missing clauses → one finding per missing clause
  // Story 58-9b: path clauses whose target file doesn't exist in workingDir
  // are architectural drift → error-severity. MUST/SHALL keyword clauses
  // have no code-observable signal → warn-severity. Mixed-severity example.
  describe('when multiple clauses are absent from storyContent', () => {
    it('returns one source-ac-drift finding per missing clause with mixed severity', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The implementation MUST validate input.
The system MUST NOT skip authentication.
Files SHALL be placed in \`src/auth/validator.ts\`.
`
      const storyContent = `
This story is about something unrelated.
`
      // workingDir=/tmp/test doesn't contain src/auth/validator.ts → path clause
      // is architectural drift → error. Status flips to fail.
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      expect(result.status).toBe('fail')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      // Three clauses: MUST line, MUST NOT line, path `src/auth/validator.ts`
      expect(driftFindings.length).toBeGreaterThanOrEqual(3)
      // MUST/SHALL clauses stay advisory warn
      const keywordFindings = driftFindings.filter((f) => f.message.startsWith('MUST:') || f.message.startsWith('MUST NOT:') || f.message.startsWith('SHALL:') || f.message.startsWith('SHALL NOT:'))
      expect(keywordFindings.every((f) => f.severity === 'warn')).toBe(true)
      // Path clauses become error when architecturally drifted (missing from code)
      const pathFindings = driftFindings.filter((f) => f.message.startsWith('path:'))
      expect(pathFindings.every((f) => f.severity === 'error')).toBe(true)
    })
  })

  // AC8e: Runtime Probes block in source but absent in storyContent → fail
  describe('when source has ## Runtime Probes block but storyContent lacks it', () => {
    it('returns status fail with a source-ac-drift finding for runtime-probes-section', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The implementation MUST be verified.

## Runtime Probes
\`\`\`yaml
- name: health-check
  sandbox: host
  run: curl -sf http://localhost:3000/health
\`\`\`
`
      const storyContent = `
The implementation MUST be verified.
No runtime probes section here.
`
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      // Story 58-9: advisory-mode; drift findings emit as warn and status stays pass.
      expect(result.status).toBe('pass')
      const driftFindings = result.findings?.filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'warn',
      ) ?? []
      expect(driftFindings.length).toBeGreaterThanOrEqual(1)
      const probesFinding = driftFindings.find((f) => f.message.includes('runtime-probes-section'))
      expect(probesFinding).toBeDefined()
      expect(probesFinding?.message).toContain('present in epics source but absent in story artifact')
    })
  })

  // Backtick path clauses
  describe('when backtick-wrapped paths are in source', () => {
    it('passes when the path is present in storyContent', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

New file \`packages/sdlc/src/verification/source-ac-fidelity-check.ts\` implements the check.
`
      const storyContent = `
New file \`packages/sdlc/src/verification/source-ac-fidelity-check.ts\` implements the check.
`
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
    })

    it('fails with error-severity when the path is absent from storyContent AND missing from code (architectural drift, 58-9b)', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The check lives at \`some/nonexistent/path/source-ac-fidelity-check.ts\`.
`
      const storyContent = `
The check lives somewhere else entirely.
`
      // workingDir=/tmp/test; path doesn't exist there → architectural drift → error.
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      expect(result.status).toBe('fail')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('error')
      expect(driftFindings[0].message).toContain('path')
      expect(driftFindings[0].message).toContain('architectural drift')
      expect(driftFindings[0].message).toContain('some/nonexistent/path/source-ac-fidelity-check.ts')
    })

    // Story 58-9b: the critical calibration test — path exists in code but
    // not in the artifact. This is the strata 1-7 class of false positive
    // that 58-9b specifically resolves.
    it('passes with warn-severity when the path is absent from storyContent BUT present in code (stylistic drift, 58-9b)', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The check lives at \`packages/sdlc/src/verification/source-ac-fidelity-check.ts\`.
`
      const storyContent = `
The check lives somewhere else entirely.
`
      // workingDir=repo root; the path exists in code → stylistic drift → warn,
      // status stays pass. The drift signal is still emitted for operator
      // visibility, but doesn't hard-gate the pipeline.
      const repoRoot = new URL('../../../../..', import.meta.url).pathname
      const ctx = makeContext({ storyContent, sourceEpicContent, workingDir: repoRoot })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('path')
      expect(driftFindings[0].message).toContain('stylistic drift')
      expect(driftFindings[0].message).toContain('packages/sdlc/src/verification/source-ac-fidelity-check.ts')
    })
  })

  // Clause truncation — message should not exceed 120 chars for the clause portion
  describe('clause truncation', () => {
    it('truncates very long clause text to 120 chars in the finding message', async () => {
      const longClause = `The system MUST ${'x'.repeat(200)} do something`
      const sourceEpicContent = `
### Story 58-2: Some Story

${longClause}
`
      const storyContent = 'Short story with no matching clause.'
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      // Story 58-9: advisory-mode; drift findings emit as warn and status stays pass.
      expect(result.status).toBe('pass')
      const finding = result.findings?.find((f) => f.category === 'source-ac-drift')
      expect(finding).toBeDefined()
      expect(finding?.severity).toBe('warn')
      // The clause portion inside the quotes should be truncated
      // Full message format: `MUST: "<truncated>" present in...`
      // The truncated portion should be at most 120 chars
      const messageMatch = finding!.message.match(/"([^"]+)"/)
      if (messageMatch) {
        expect(messageMatch[1].length).toBeLessThanOrEqual(120)
      }
    })
  })

  // Verify runtime probes pass when present in storyContent
  describe('when Runtime Probes block is in both source and storyContent', () => {
    it('returns pass for the runtime-probes-section clause', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

## Runtime Probes
\`\`\`yaml
- name: health-check
  sandbox: host
  run: curl -sf http://localhost:3000/health
\`\`\`
`
      const storyContent = `
## Runtime Probes
\`\`\`yaml
- name: health-check
  sandbox: host
  run: curl -sf http://localhost:3000/health
\`\`\`
`
      const ctx = makeContext({ storyContent, sourceEpicContent })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
    })
  })
})
