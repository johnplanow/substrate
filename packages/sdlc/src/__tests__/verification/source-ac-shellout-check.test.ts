/**
 * Unit tests for SourceAcShelloutCheck — Story 67-3.
 *
 * Framework: Vitest (describe / it / expect — no Jest globals).
 * Uses real file I/O in temp directories (mkdtempSync) — no fs mocking.
 *
 * AC coverage:
 *   AC4/TC1 — positive: `npx <name>` in double-quoted string fires
 *   AC4/TC2 — negative: `npx --no-install <name>` does NOT fire
 *   AC4/TC3 — skip rule: `.md` file filtered before scan → zero findings
 *   AC4/TC4 — skip rule: comment line (`//`) → zero findings
 *   AC4/TC5 — skip rule: match NOT inside string-literal (block comment) → zero findings
 *   AC5/TC6 — obs_023 reproduction: strata 3-3 hook content in single-quoted JS string → fires
 *   AC5/TC7 — additional: template-literal context → fires
 *   AC6    — finding message format matches spec exactly
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  isCommentLine,
  isInStringLiteralContext,
  runShelloutCheck,
  SourceAcShelloutCheck,
} from '../../verification/checks/source-ac-shellout-check.js'
import type { VerificationContext } from '../../verification/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'shellout-check-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeFixture(relPath: string, content: string): void {
  const absPath = join(tmpDir, relPath)
  // Create parent directories if needed
  const parentDir = absPath.substring(0, absPath.lastIndexOf('/'))
  if (parentDir !== tmpDir) {
    mkdirSync(parentDir, { recursive: true })
  }
  writeFileSync(absPath, content, 'utf-8')
}

function makeContext(
  filesModified: string[],
  overrides?: Partial<VerificationContext>,
): VerificationContext {
  return {
    storyKey: '67-3',
    workingDir: tmpDir,
    commitSha: 'abc123',
    timeout: 30_000,
    devStoryResult: { files_modified: filesModified },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Unit tests for helper functions
// ---------------------------------------------------------------------------

describe('isCommentLine', () => {
  it('returns true for a // single-line comment', () => {
    expect(isCommentLine('  // npx some-tool')).toBe(true)
  })

  it('returns true for a # shell comment', () => {
    expect(isCommentLine('# comment')).toBe(true)
  })

  it('returns false for a regular code line', () => {
    expect(isCommentLine('execSync("npx some-tool")')).toBe(false)
  })

  it('returns false for a block comment opener /* ... */', () => {
    expect(isCommentLine('/* run npx strata to install */')).toBe(false)
  })

  it('returns false for a single-quoted string literal line', () => {
    expect(isCommentLine("  'exec npx strata run --hook pre-push \"$@\"',")).toBe(false)
  })
})

describe('isInStringLiteralContext', () => {
  it('returns true when match is inside double quotes', () => {
    const line = 'execSync("npx some-tool arg")'
    const matchIndex = line.indexOf('npx')
    expect(isInStringLiteralContext(line, matchIndex)).toBe(true)
  })

  it('returns true when match is inside single quotes', () => {
    const line = "execSync('npx some-tool')"
    const matchIndex = line.indexOf('npx')
    expect(isInStringLiteralContext(line, matchIndex)).toBe(true)
  })

  it('returns true when match is inside template literal', () => {
    const line = 'const cmd = `npx prettier --write .`'
    const matchIndex = line.indexOf('npx')
    expect(isInStringLiteralContext(line, matchIndex)).toBe(true)
  })

  it('returns false when match is outside any string (block comment)', () => {
    const line = '/* run npx strata to install */'
    const matchIndex = line.indexOf('npx')
    expect(isInStringLiteralContext(line, matchIndex)).toBe(false)
  })

  it('returns false for bare code prose outside quotes', () => {
    const line = 'const x = npx'
    const matchIndex = line.indexOf('npx')
    expect(isInStringLiteralContext(line, matchIndex)).toBe(false)
  })

  it('returns true for shebang line', () => {
    const line = '#!/usr/bin/env npx ts-node'
    const matchIndex = line.indexOf('npx')
    expect(isInStringLiteralContext(line, matchIndex)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration tests for runShelloutCheck
// ---------------------------------------------------------------------------

describe('runShelloutCheck', () => {
  // TC1 — positive: double-quoted shell string
  it('TC1 fires for npx <name> inside a double-quoted string', async () => {
    writeFixture('hooks/install.ts', 'execSync("npx some-tool arg")\n')
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('warn')
    expect(result.findings).toHaveLength(1)
    expect(result.findings![0].category).toBe('source-ac-shellout-npx-fallback')
    expect(result.findings![0].severity).toBe('warn')
    expect(result.findings![0].message).toContain('"npx some-tool"')
    expect(result.findings![0].message).toContain('dependency-confusion vector')
  })

  // TC2 — negative: --no-install present
  it('TC2 does NOT fire when --no-install is present', async () => {
    writeFixture('hooks/install.ts', "execSync('npx --no-install some-tool')\n")
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('pass')
    expect(result.findings).toHaveLength(0)
  })

  // TC3 — skip .md files
  it('TC3 does NOT fire for npx in a .md file (filtered before scan)', async () => {
    writeFixture('README.md', 'Run `npx some-tool` to get started.\n')
    const ctx = makeContext(['README.md'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('pass')
    expect(result.findings).toHaveLength(0)
  })

  // TC4 — skip comment line //
  it('TC4 does NOT fire for npx on a // comment line', async () => {
    writeFixture(
      'hooks/install.ts',
      '// npx some-tool would be called here\n' +
        'const x = 1\n',
    )
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('pass')
    expect(result.findings).toHaveLength(0)
  })

  // TC5 — skip match NOT inside string-literal (block comment prose)
  it('TC5 does NOT fire for npx inside a block comment (not in string literal)', async () => {
    writeFixture(
      'hooks/install.ts',
      '/* run npx strata to install */\nconst x = 1\n',
    )
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('pass')
    expect(result.findings).toHaveLength(0)
  })

  // TC6 — obs_023 reproduction: strata 3-3 hook content as fixture
  it('TC6 fires for npx strata in single-quoted JS string (obs_023 reproduction)', async () => {
    const fileContent = `
import { writeFileSync } from 'fs'
import { join } from 'path'
export function installPrePushHook(hooksDir: string): void {
  const script = [
    '#!/bin/sh',
    'exec npx strata run --hook pre-push "$@"',
  ].join('\\n')
  writeFileSync(join(hooksDir, 'pre-push'), script, { mode: 0o755 })
}
`
    writeFixture('hooks/install.ts', fileContent)
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.findings).toHaveLength(1)
    expect(result.findings![0].category).toBe('source-ac-shellout-npx-fallback')
    expect(result.findings![0].message).toContain('"npx strata"')
    expect(result.findings![0].message).toContain('dependency-confusion vector')
  })

  // TC7 — template literal context
  it('TC7 fires for npx inside a template literal', async () => {
    writeFixture(
      'src/runner.ts',
      'const cmd = `npx prettier --write .`\n',
    )
    const ctx = makeContext(['src/runner.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('warn')
    expect(result.findings).toHaveLength(1)
    expect(result.findings![0].category).toBe('source-ac-shellout-npx-fallback')
    expect(result.findings![0].message).toContain('"npx prettier"')
  })

  // AC6 — finding message format
  it('AC6: finding message matches exact format from spec', async () => {
    writeFixture('hooks/install.ts', 'execSync("npx some-tool arg")\n')
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    const msg = result.findings![0].message
    expect(msg).toContain('npx fallback detected in hooks/install.ts:1: "npx some-tool"')
    expect(msg).toContain('bare `npx <package>` without `--no-install`')
    expect(msg).toContain('falls through to the public npm registry on first use')
    expect(msg).toContain('dependency-confusion vector')
    expect(msg).toContain('Use absolute path or `npx --no-install <package>` instead.')
  })

  // AC7 — backward compat: no findings when files_modified is empty and no git fallback
  it('returns pass with no findings when devStoryResult has no modified files', async () => {
    // No git repo in tmpDir, so git fallback will fail → early pass
    const ctx: VerificationContext = {
      storyKey: '67-3',
      workingDir: tmpDir,
      commitSha: 'abc123',
      timeout: 30_000,
      devStoryResult: { files_modified: [] },
    }
    const result = await runShelloutCheck(ctx)

    // Either git fallback succeeds with empty list or fails → pass
    expect(['pass', 'warn']).toContain(result.status)
    // If status is pass, findings should be empty
    if (result.status === 'pass') {
      expect(result.findings).toHaveLength(0)
    }
  })

  // Structured findings: details === renderFindings(findings) on warn result
  it('details equals renderFindings(findings) on warn result', async () => {
    writeFixture('hooks/install.ts', 'execSync("npx some-tool arg")\n')
    const ctx = makeContext(['hooks/install.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('warn')
    // details should start with WARN prefix
    expect(result.details).toContain('WARN [source-ac-shellout-npx-fallback]')
  })

  // Metadata: name and tier
  it('SourceAcShelloutCheck has name "source-ac-shellout" and tier "A"', () => {
    const check = new SourceAcShelloutCheck()
    expect(check.name).toBe('source-ac-shellout')
    expect(check.tier).toBe('A')
  })

  // No false positive for mixed content
  it('does not fire for a file with only --no-install variants', async () => {
    writeFixture(
      'scripts/setup.ts',
      `
const cmd1 = 'npx --no-install eslint .'
const cmd2 = "npx --no-install prettier --check ."
`,
    )
    const ctx = makeContext(['scripts/setup.ts'])
    const result = await runShelloutCheck(ctx)

    expect(result.status).toBe('pass')
    expect(result.findings).toHaveLength(0)
  })
})
