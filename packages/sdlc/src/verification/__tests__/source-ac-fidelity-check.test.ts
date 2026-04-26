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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // -------------------------------------------------------------------------
  // Story 58-9c: relative path resolution
  //
  // Strata obs_2026-04-22_005: v0.20.15's path existence check used
  // `join(workingDir, pathOnly)` which for `./discover.ts` resolved to
  // `workingDir/discover.ts` — NOT where the file actually lives
  // (`workingDir/packages/core/src/cli/discover.ts`). False-positive
  // "architectural drift" → error-severity → blocked ship despite code
  // satisfying the AC.
  //
  // Fix: pathSatisfiedByCode handles three strategies in order —
  //   (a) literal `workingDir/path`
  //   (b) strip leading `./` and retry (a)
  //   (c) basename search under workingDir (bounded walk, skip node_modules etc.)
  // -------------------------------------------------------------------------

  describe('Story 58-9c: relative path resolution', () => {
    it('resolves `./file.ts` by stripping `./` and finding the file at top level of workingDir', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The entrypoint is \`./package.json\`.
`
      const storyContent = `
The entrypoint wires subcommands.
`
      // workingDir=repo root; `./package.json` should resolve via dot-strip
      // to repo-root/package.json which exists.
      const repoRoot = new URL('../../../../..', import.meta.url).pathname
      const ctx = makeContext({ storyContent, sourceEpicContent, workingDir: repoRoot })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('stylistic drift')
    })

    it('resolves relative path via basename-search under workingDir when the literal path does not match', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The new check lives at \`./source-ac-fidelity-check.ts\`.
`
      const storyContent = 'Story artifact does not mention the path.'
      // workingDir=repo root; basename is `source-ac-fidelity-check.ts` which
      // exists under packages/sdlc/src/verification/ — the walker should find it.
      const repoRoot = new URL('../../../../..', import.meta.url).pathname
      const ctx = makeContext({ storyContent, sourceEpicContent, workingDir: repoRoot })
      const result = await check.run(ctx)

      expect(result.status).toBe('pass')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('stylistic drift')
    })

    it('still flags genuinely missing relative paths as architectural drift (error)', async () => {
      const sourceEpicContent = `
### Story 58-2: Some Story

The nonexistent file is \`./does-not-exist-anywhere-xyz.ts\`.
`
      const storyContent = 'No mention of the path.'
      const repoRoot = new URL('../../../../..', import.meta.url).pathname
      const ctx = makeContext({ storyContent, sourceEpicContent, workingDir: repoRoot })
      const result = await check.run(ctx)

      expect(result.status).toBe('fail')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('error')
      expect(driftFindings[0].message).toContain('architectural drift')
    })

    it('basename-search skips node_modules / .git / dist so unrelated collisions do not hide real drift', async () => {
      // Craft a source path whose basename only exists in node_modules — the
      // walker must NOT treat that as a code-satisfied match.
      const sourceEpicContent = `
### Story 58-2: Some Story

The package requires \`./package-lock.json\`.
`
      // Use a workingDir that only contains node_modules (tmp dir with
      // node_modules/fake-pkg/package-lock.json). If the walker correctly
      // skips node_modules, the basename search fails → architectural drift.
      // We simulate by pointing at /tmp/test which is empty in practice.
      const ctx = makeContext({
        storyContent: 'story artifact',
        sourceEpicContent,
        workingDir: '/tmp/test-58-9c-skipdirs-' + Math.random().toString(36).slice(2),
      })
      const result = await check.run(ctx)

      expect(result.status).toBe('fail')
      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('error')
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

  // -------------------------------------------------------------------------
  // Story 60-3 (Sprint 11B): under-delivery detection via story-scoped
  // import-reference check
  //
  // Strata obs_2026-04-25_011 (Run 11): create-story dropped `packages/mesh-agent`
  // integration from rendered artifact. The 58-9b code-satisfies check passed
  // because the directory existed in the repo (created by Story 1.17). But
  // 1-10's own code (in `packages/memory-mcp/`) had zero references to
  // `mesh-agent` — under-delivery masked as stylistic drift.
  //
  // Fix: when path exists in code AND modifiedFiles is reported, scan THIS
  // story's modified files for an import / require / use reference to the
  // path's basename. References absent → architectural under-delivery →
  // downgrade severity to error. Conservative when modifiedFiles is empty
  // (preserves existing 58-9b warn behavior).
  // -------------------------------------------------------------------------

  describe('Story 60-3: under-delivery detection via story-scoped import check', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'src-ac-fidelity-60-3-'))
    })

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it('downgrades to error when path exists in code but story\'s modified files do not import it', async () => {
      // Setup: tmp dir containing `packages/mesh-agent/` (created by a prior
      // story) AND `packages/memory-mcp/server.py` that does NOT reference it.
      // This mirrors strata obs_2026-04-25_011 exactly.
      const meshAgentDir = join(tmpDir, 'packages', 'mesh-agent', 'src')
      mkdirSync(meshAgentDir, { recursive: true })
      writeFileSync(join(meshAgentDir, 'index.ts'), '// mesh-agent infrastructure')

      const memoryMcpDir = join(tmpDir, 'packages', 'memory-mcp')
      mkdirSync(memoryMcpDir, { recursive: true })
      const serverPath = 'packages/memory-mcp/server.py'
      writeFileSync(
        join(tmpDir, serverPath),
        `# memory-mcp server\nimport mcp\nimport sys\n`,
      )

      const sourceEpicContent = `### Story 1.10: Strata Memory MCP Server

The server registers as \`packages/mesh-agent\` mesh agent.
`
      const storyContent = `### AC1: Memory MCP server\nServes MCP requests.\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10',
        devStoryResult: { files_modified: [serverPath] },
      })
      const result = await check.run(ctx)

      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('error')
      expect(driftFindings[0].message).toContain('under-delivery')
      expect(driftFindings[0].message).toContain('packages/mesh-agent')
    })

    it('keeps warn (stylistic) when path exists AND story\'s modified files reference it', async () => {
      const meshAgentDir = join(tmpDir, 'packages', 'mesh-agent', 'src')
      mkdirSync(meshAgentDir, { recursive: true })
      writeFileSync(join(meshAgentDir, 'index.ts'), '// mesh-agent')

      const memoryMcpDir = join(tmpDir, 'packages', 'memory-mcp')
      mkdirSync(memoryMcpDir, { recursive: true })
      const serverPath = 'packages/memory-mcp/server.py'
      writeFileSync(
        join(tmpDir, serverPath),
        `# memory-mcp server\nimport mcp\nfrom mesh_agent import MeshAgent\n# IMPORTS mesh-agent\n`,
      )

      const sourceEpicContent = `### Story 1.10: Strata Memory MCP Server\n\nThe server uses \`packages/mesh-agent\`.\n`
      const storyContent = `### AC1: Server scaffolded`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10',
        devStoryResult: { files_modified: [serverPath] },
      })
      const result = await check.run(ctx)

      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('stylistic drift')
    })

    it('preserves existing warn behavior when modifiedFiles is empty (no signal → benefit of doubt)', async () => {
      const meshAgentDir = join(tmpDir, 'packages', 'mesh-agent', 'src')
      mkdirSync(meshAgentDir, { recursive: true })
      writeFileSync(join(meshAgentDir, 'index.ts'), '// mesh-agent')

      const sourceEpicContent = `### Story 1.10\n\nUses \`packages/mesh-agent\`.\n`
      const storyContent = `### AC1: scaffolded`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10',
        // No devStoryResult — preserves backward-compat
      })
      const result = await check.run(ctx)

      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('stylistic drift')
    })

    it('still flags genuinely missing paths as architectural drift (modifiedFiles signal does not interfere)', async () => {
      const sourceEpicContent = `### Story 1.10\n\nUses \`packages/never-existed\`.\n`
      const storyContent = `### AC1: scaffolded`
      const otherPath = 'packages/memory-mcp/server.py'
      mkdirSync(join(tmpDir, 'packages', 'memory-mcp'), { recursive: true })
      writeFileSync(join(tmpDir, otherPath), '# server')

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10',
        devStoryResult: { files_modified: [otherPath] },
      })
      const result = await check.run(ctx)

      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('error')
      expect(driftFindings[0].message).toContain('architectural drift')
      expect(driftFindings[0].message).toContain('missing from code')
    })

    it('package.json reference counts as story-scoped reference (catches dependency-graph wire-ins)', async () => {
      mkdirSync(join(tmpDir, 'packages', 'mesh-agent'), { recursive: true })
      writeFileSync(join(tmpDir, 'packages', 'mesh-agent', 'index.ts'), '// mesh')

      const memoryMcpDir = join(tmpDir, 'packages', 'memory-mcp')
      mkdirSync(memoryMcpDir, { recursive: true })
      const pkgJsonPath = 'packages/memory-mcp/package.json'
      writeFileSync(
        join(tmpDir, pkgJsonPath),
        JSON.stringify({
          name: '@strata/memory-mcp',
          dependencies: { '@strata/mesh-agent': 'workspace:*' },
        }),
      )

      const sourceEpicContent = `### Story 1.10\n\nUses \`packages/mesh-agent\`.\n`
      const storyContent = `### AC1: wired`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10',
        devStoryResult: { files_modified: [pkgJsonPath] },
      })
      const result = await check.run(ctx)

      const driftFindings = result.findings?.filter((f) => f.category === 'source-ac-drift') ?? []
      expect(driftFindings).toHaveLength(1)
      expect(driftFindings[0].severity).toBe('warn')
      expect(driftFindings[0].message).toContain('stylistic drift')
    })
  })

  // -------------------------------------------------------------------------
  // Story 60-5: alternative-option detection (closes obs_2026-04-26_013).
  //
  // Source AC offers two implementation shapes via consecutive `**(a)**` /
  // `**(b)**` markdown list items. Dev correctly takes one option; v0.20.23
  // hard-gated on the un-taken option's path being missing because the
  // check had no concept of optionality. The fix groups path clauses by
  // alternative option and ORs satisfaction across the group: the un-taken
  // option's path is emitted as info-severity, not error.
  // -------------------------------------------------------------------------

  describe('Story 60-5: alternative-option groups (obs_2026-04-26_013)', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'src-ac-fidelity-60-5-'))
    })

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it('emits info (not error) for un-taken option when another option in the group is satisfied', async () => {
      // Mirrors the strata 1-10c case: source AC offers (a) `packages/memory-mcp-mesh/`
      // OR (b) `packages/memory-mcp/src/memory_mcp/mesh_agent.py`. Dev took (b).
      const optionBPath = 'packages/memory-mcp/src/memory_mcp/mesh_agent.py'
      mkdirSync(join(tmpDir, 'packages/memory-mcp/src/memory_mcp'), { recursive: true })
      writeFileSync(join(tmpDir, optionBPath), '# python A2A re-impl\n')

      const sourceEpicContent = `### Story 1-10c: Mesh integration

**Architecture decision:** strata-memory is a Python MCP server. Two integration shapes are acceptable; dev chooses:
- **(a) TypeScript shim** in \`packages/memory-mcp-mesh/\` (TS) consuming the Python MCP server via stdio.
- **(b) Python A2A re-implementation** within \`packages/memory-mcp/src/memory_mcp/mesh_agent.py\` against the same backend.

**Acceptance Criteria:** registers as mesh agent.
`
      // Story artifact does NOT mention either path (verbatim drift typical
      // of dev rewrites; we want the alternative-group logic to handle it).
      const storyContent = `### AC1: registers as mesh agent\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10c',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const altInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-alternative-not-taken',
      )
      // Critical: option (a)'s path is NOT an architectural-drift error.
      expect(driftErrors).toHaveLength(0)
      // Option (a) surfaces as info (visible in finding list, non-blocking).
      expect(altInfo).toHaveLength(1)
      expect(altInfo[0]?.severity).toBe('info')
      expect(altInfo[0]?.message).toContain('packages/memory-mcp-mesh')
      expect(altInfo[0]?.message).toContain('alternative option (a)')
      expect(altInfo[0]?.message).toContain('story implemented option (b)')
      // Verification status must pass (not fail) on this case.
      expect(result.status).toBe('pass')
    })

    it('still errors on both options when NEITHER option is satisfied (no false-pass on broken implementation)', async () => {
      // Neither (a) nor (b) path exists. The check must fall back to existing
      // architectural-drift logic and emit error per option — otherwise a
      // story that implemented NEITHER alternative would silently ship.
      const sourceEpicContent = `### Story 1-10c

**Architecture decision:** dev chooses:
- **(a) TS shim** in \`packages/option-a/\` directory.
- **(b) Python re-impl** in \`packages/option-b/\` directory.
`
      const storyContent = `### AC1: nothing implemented\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10c',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      // Both options' paths missing → existing architectural-drift logic
      // applies to both (no taken option to OR against).
      expect(driftErrors).toHaveLength(2)
      expect(driftErrors.map((f) => f.message).join('|')).toContain('packages/option-a')
      expect(driftErrors.map((f) => f.message).join('|')).toContain('packages/option-b')
      expect(result.status).toBe('fail')
    })

    it('does NOT treat a single isolated `**(a)**` item as an alternative group (need 2+ items)', async () => {
      // A lone `- **(a)**` item is not "alternatives" — there's no second
      // option to compare against. Existing per-path drift logic must apply.
      const sourceEpicContent = `### Story 7-1\n\nDetails:\n- **(a) Single approach** in \`packages/sole/\` directory.\n`
      const storyContent = `### AC1: nothing built\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '7-1',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const altInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-alternative-not-taken',
      )
      expect(driftErrors).toHaveLength(1)
      expect(altInfo).toHaveLength(0)
    })

    it('handles three-option groups: only the satisfied option drives "taken"; others become info', async () => {
      const optionBPath = 'packages/option-b/index.ts'
      mkdirSync(join(tmpDir, 'packages/option-b'), { recursive: true })
      writeFileSync(join(tmpDir, optionBPath), '// option b\n')

      const sourceEpicContent = `### Story X

Choose:
- **(a)** \`packages/option-a/\`
- **(b)** \`packages/option-b/\`
- **(c)** \`packages/option-c/\`
`
      const storyContent = `### AC1: built option b\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: 'X',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const altInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-alternative-not-taken',
      )
      // (a) and (c) are un-taken alternatives → info findings.
      expect(driftErrors).toHaveLength(0)
      expect(altInfo).toHaveLength(2)
      const messages = altInfo.map((f) => f.message).join('\n')
      expect(messages).toContain('packages/option-a')
      expect(messages).toContain('packages/option-c')
      expect(messages).toMatch(/story implemented option \(b\)/g)
      expect(result.status).toBe('pass')
    })

    it('does NOT affect path clauses that are outside any alternative group (backward compat)', async () => {
      // Standalone path NOT inside a `**(letter)**` list item must continue
      // to behave per the existing architectural-drift / stylistic-drift
      // semantics — no spurious alternative tagging.
      const sourceEpicContent = `### Story 1-1\n\nMust create \`packages/required/\` directory.\n`
      const storyContent = `### AC1: built\n`
      // No directory created → architectural drift error (existing behavior).

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-1',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const altInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-alternative-not-taken',
      )
      expect(driftErrors).toHaveLength(1)
      expect(altInfo).toHaveLength(0)
    })

    it('60-5 + 60-6 (strata 1-10c regression): hyphen-form storyKey matches dot-form epic heading and emits exactly one alternative-not-taken finding', async () => {
      // Combines both fixes: separator-tolerant section extraction (60-6) AND
      // alternative-option detection (60-5). Strata's epics.md uses
      // `### Story 1.10c:` (dot); substrate's canonical storyKey is `1-10c`
      // (hyphen). Before 60-6, extractStorySection returned the entire epic
      // when these forms didn't match → cross-story findings exploded. With
      // both fixes, the section is correctly isolated AND the alternative
      // option (a) is emitted as info, not error.
      const optionBPath = 'packages/memory-mcp/src/memory_mcp/mesh_agent.py'
      mkdirSync(join(tmpDir, 'packages/memory-mcp/src/memory_mcp'), { recursive: true })
      writeFileSync(join(tmpDir, optionBPath), '# python A2A re-impl\n')

      // Mirrors strata epics.md structure: dot-separator heading + multiple
      // story sections so the fallback bug would have been visible.
      const sourceEpicContent = `### Story 1.10b: Strata Memory hybrid retrieval

Body for 1.10b. Required: \`packages/some-other/path\`.

### Story 1.10c: Strata Memory mesh-agent integration

**Architecture decision:** dev chooses one:
- **(a) TypeScript shim** in \`packages/memory-mcp-mesh/\`.
- **(b) Python A2A re-impl** within \`packages/memory-mcp/src/memory_mcp/mesh_agent.py\`.

### Story 1.10d: Some next story

Body. Required: \`packages/yet-another\`.
`
      const storyContent = `### AC1: implemented option (b)\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-10c', // hyphen — substrate canonical form
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const altInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-alternative-not-taken',
      )
      // Critical: only ONE finding from this story's section, not from the
      // sibling 1.10b / 1.10d sections (which would have been pulled in by
      // the pre-60-6 silent fallback).
      expect(driftErrors).toHaveLength(0)
      expect(altInfo).toHaveLength(1)
      expect(altInfo[0]?.message).toContain('packages/memory-mcp-mesh')
      // Cross-story leakage check: clauses from 1.10b/1.10d must NOT appear.
      const allMessages = (result.findings ?? []).map((f) => f.message).join('\n')
      expect(allMessages).not.toContain('packages/some-other')
      expect(allMessages).not.toContain('packages/yet-another')
      expect(result.status).toBe('pass')
    })

    it('detects alternative paths even when they appear on continuation lines below the bullet', async () => {
      // Authors sometimes break the option's prose across multiple lines
      // with the path on a subsequent indented line. The continuation must
      // still be considered part of the option's span.
      const optionBPath = 'packages/wrapped-b/file.ts'
      mkdirSync(join(tmpDir, 'packages/wrapped-b'), { recursive: true })
      writeFileSync(join(tmpDir, optionBPath), '// option b\n')

      const sourceEpicContent = `### Story Y

- **(a) First option** with path on a continuation line:
  Implementation lives in \`packages/wrapped-a/\` directory.
- **(b) Second option** with path on a continuation line:
  Implementation lives in \`packages/wrapped-b/\` directory.
`
      const storyContent = `### AC1: implemented b\n`

      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: 'Y',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const altInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-alternative-not-taken',
      )
      expect(driftErrors).toHaveLength(0)
      expect(altInfo).toHaveLength(1)
      expect(altInfo[0]?.message).toContain('packages/wrapped-a')
    })
  })

  // -------------------------------------------------------------------------
  // Story 60-6: separator-tolerant story-section extraction + loud fallback.
  //
  // Substrate's canonical storyKey form is hyphen (e.g., `1-10c`); strata's
  // epics.md uses dots (`### Story 1.10c:`). Before 60-6, extractStorySection
  // silently returned the full epic when these forms didn't match, attributing
  // every story's hard clauses to this one. Mirrors the Story 58-5 fix
  // already shipped in src/modules/compiled-workflows/create-story.ts.
  // -------------------------------------------------------------------------

  describe('Story 60-6: separator-tolerant section extraction + loud fallback', () => {
    it('matches hyphen-form storyKey against dot-form heading (`1-10c` ↔ `### Story 1.10c:`)', async () => {
      const sourceEpicContent = `### Story 1.10c: My story

Required: \`packages/in-scope/\`.

### Story 1.10d: Next story

Required: \`packages/out-of-scope/\`.
`
      const storyContent = `### AC1: built in-scope`
      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: '/tmp/nonexistent',
        storyKey: '1-10c', // hyphen form
      })
      const result = await check.run(ctx)
      // Cross-story leakage: out-of-scope must NOT show up as a drift finding.
      const allMessages = (result.findings ?? []).map((f) => f.message).join('\n')
      expect(allMessages).toContain('packages/in-scope')
      expect(allMessages).not.toContain('packages/out-of-scope')
    })

    it('matches dot-form storyKey against hyphen-form heading (`1.7` ↔ `### Story 1-7:`)', async () => {
      const sourceEpicContent = `### Story 1-7: Mirror direction

Required: \`packages/dot-key/\`.

### Story 1-8: Sibling

Required: \`packages/sibling/\`.
`
      const storyContent = `### AC1: built\n`
      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: '/tmp/nonexistent',
        storyKey: '1.7', // dot form
      })
      const result = await check.run(ctx)
      const allMessages = (result.findings ?? []).map((f) => f.message).join('\n')
      expect(allMessages).toContain('packages/dot-key')
      expect(allMessages).not.toContain('packages/sibling')
    })

    it('emits a `source-ac-section-not-found` warn finding when the storyKey heading is genuinely absent (no silent fallback)', async () => {
      // Story key matches no heading at all — must NOT silently scan the
      // whole epic. Loud warn finding instead, status pass (warn doesn't gate),
      // zero drift findings.
      const sourceEpicContent = `### Story 99-99: Some other story

Required: \`packages/should-not-be-attributed/\`.
`
      const storyContent = `### AC1: a story that doesn't exist in this epic\n`
      const ctx = makeContext({
        storyContent,
        sourceEpicContent,
        workingDir: '/tmp/nonexistent',
        storyKey: '7-7', // does not match any heading
      })
      const result = await check.run(ctx)
      expect(result.status).toBe('pass')
      expect(result.findings).toHaveLength(1)
      const f = result.findings?.[0]
      expect(f?.category).toBe('source-ac-section-not-found')
      expect(f?.severity).toBe('warn')
      expect(f?.message).toContain('7-7')
      expect(f?.message).toContain('separator convention')
      // Critical: cross-story leakage check.
      const allMessages = (result.findings ?? []).map((f) => f.message).join('\n')
      expect(allMessages).not.toContain('packages/should-not-be-attributed')
    })

    it('still matches when the heading uses an underscore separator (`1-7` ↔ `### Story 1_7:`)', async () => {
      const sourceEpicContent = `### Story 1_7: Underscore heading\n\nRequired: \`packages/under/\`.\n`
      const ctx = makeContext({
        storyContent: '### AC1\n',
        sourceEpicContent,
        workingDir: '/tmp/nonexistent',
        storyKey: '1-7',
      })
      const result = await check.run(ctx)
      const allMessages = (result.findings ?? []).map((f) => f.message).join('\n')
      expect(allMessages).toContain('packages/under')
    })

    it('boundary detection still terminates at the next `### Story` heading regardless of separator', async () => {
      // Pre-60-6 boundary regex was `/\n### Story /m` (literal). Confirm 60-6
      // didn't regress this — story 1.10c's section ends at `### Story 1.10d:`.
      const sourceEpicContent = `### Story 1.10c: Mine

Required: \`packages/mine/\`.

### Story 1.10d: Not mine

Required: \`packages/not-mine/\`.
`
      const ctx = makeContext({
        storyContent: '### AC1\n',
        sourceEpicContent,
        workingDir: '/tmp/nonexistent',
        storyKey: '1-10c',
      })
      const result = await check.run(ctx)
      const allMessages = (result.findings ?? []).map((f) => f.message).join('\n')
      expect(allMessages).toContain('packages/mine')
      expect(allMessages).not.toContain('packages/not-mine')
    })
  })

  // -------------------------------------------------------------------------
  // Story 60-7: operational-path heuristic — emit info-severity (not
  // architectural-drift error) when a backtick path matches a known
  // runtime / install / system location pattern. Closes the strata Run
  // a880f201 / Story 1-12 false positive where `.git/hooks/post-merge`
  // (install destination, not deliverable) hard-gated VERIFICATION_FAILED.
  // -------------------------------------------------------------------------

  describe('Story 60-7: operational-path heuristic (strata 1-12 regression)', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'src-ac-fidelity-60-7-'))
    })

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it('strata 1-12 regression: `.git/hooks/post-merge` emits info, not architectural-drift error', async () => {
      const sourceEpicContent = `### Story 1.12: Vault conflict hook

**When** \`.git/hooks/post-merge\` is installed
**Then** the hook resolves conflicts.

**Given** the hook installer ships at \`hooks/install-vault-hooks.sh\`
**Then** running the installer creates the post-merge hook.
`
      // Dev correctly ships the installer; the runtime install location is NOT
      // expected to live at <workdir>/.git/hooks/post-merge.
      mkdirSync(join(tmpDir, 'hooks'), { recursive: true })
      writeFileSync(join(tmpDir, 'hooks/install-vault-hooks.sh'), '#!/bin/bash\n# installer\n')

      const ctx = makeContext({
        storyContent: '### AC1\nInstaller scripts shipped.\n',
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-12',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const opPathInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-operational-path-reference',
      )
      // Critical: NO architectural-drift error on `.git/hooks/post-merge`
      expect(driftErrors).toHaveLength(0)
      expect(opPathInfo).toHaveLength(1)
      expect(opPathInfo[0]?.severity).toBe('info')
      expect(opPathInfo[0]?.message).toContain('.git/hooks/post-merge')
      expect(opPathInfo[0]?.message).toContain('operational-path heuristic')
      expect(result.status).toBe('pass')
    })

    it('matches each operational-path category (`/usr/`, `/etc/`, `/var/`, etc.)', async () => {
      // Verify the heuristic recognizes each documented system-root prefix.
      // Note: the path-extract regex char class `[a-zA-Z0-9_./-]+` does NOT
      // include `~`, so `~/.config/strata/state` captures only as `.config/strata/state`
      // (which doesn't match operational-path patterns and would drift normally).
      // That gap is a separate regex limitation; this test covers the patterns
      // the heuristic is REACHED FOR — system absolute paths and `.git/`.
      const sourceEpicContent = `### Story OP

References:
- Install at \`/usr/local/bin/jarvis\`
- Config at \`/etc/jarvis/config.toml\`
- Tmp file \`/tmp/strata-state\`
- Mount \`/mnt/backup/restic\`
- Var log \`/var/log/strata\`
- Git ref \`.git/refs/heads/main\`
`
      const ctx = makeContext({
        storyContent: '### AC1\nNothing implemented.\n',
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: 'OP',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const opPathInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-operational-path-reference',
      )
      // None of these should architectural-drift; all should be info.
      expect(driftErrors).toHaveLength(0)
      expect(opPathInfo).toHaveLength(6)
      const allOpMessages = opPathInfo.map((f) => f.message).join('\n')
      expect(allOpMessages).toContain('/usr/local/bin/jarvis')
      expect(allOpMessages).toContain('/etc/jarvis/config.toml')
      expect(allOpMessages).toContain('/tmp/strata-state')
      expect(allOpMessages).toContain('/mnt/backup/restic')
      expect(allOpMessages).toContain('/var/log/strata')
      expect(allOpMessages).toContain('.git/refs/heads/main')
    })

    it('legitimate package paths still drift-error (no false-negative regression)', async () => {
      // Critical regression guard: heuristic must NOT downgrade real deliverable
      // paths. `packages/never-existed/` is a normal project path; if missing it
      // remains an architectural-drift error.
      const sourceEpicContent = `### Story 1-1\n\nMust create \`packages/never-existed/\` directory.\n`
      const ctx = makeContext({
        storyContent: '### AC1: nothing built\n',
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-1',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const opPathInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-operational-path-reference',
      )
      expect(driftErrors).toHaveLength(1)
      expect(driftErrors[0]?.message).toContain('packages/never-existed')
      expect(opPathInfo).toHaveLength(0)
    })

    it('`/userland/` does NOT match `/usr/` prefix (no false-positive on lookalike system roots)', async () => {
      // The heuristic uses `^/usr/` (with trailing slash) to avoid matching
      // `/userland/foo` or `/usrbin` etc. — verify this discrimination works.
      const sourceEpicContent = `### Story X\n\nMust create \`/userland/something/dir\` directory.\n`
      const ctx = makeContext({
        storyContent: '### AC1\n',
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: 'X',
      })
      const result = await check.run(ctx)

      const driftErrors = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-drift' && f.severity === 'error',
      )
      const opPathInfo = (result.findings ?? []).filter(
        (f) => f.category === 'source-ac-operational-path-reference',
      )
      // `/userland/something/dir` is NOT operational (not under `/usr/`) — must drift-error
      expect(driftErrors).toHaveLength(1)
      expect(opPathInfo).toHaveLength(0)
    })

    it('verification status passes when only operational-path findings remain (gates open at info)', async () => {
      // Strata 1-12's exact failure mode: only finding was `.git/hooks/post-merge`
      // architectural drift. With the heuristic, that becomes info → status pass.
      const sourceEpicContent = `### Story 1.12

**When** \`.git/hooks/post-merge\` is installed
**Then** the hook works.
`
      const ctx = makeContext({
        storyContent: '### AC1\n',
        sourceEpicContent,
        workingDir: tmpDir,
        storyKey: '1-12',
      })
      const result = await check.run(ctx)
      expect(result.status).toBe('pass')
      // Exactly one info finding, zero errors
      const errors = (result.findings ?? []).filter((f) => f.severity === 'error')
      expect(errors).toHaveLength(0)
    })
  })
})
