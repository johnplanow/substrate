/**
 * Unit tests for probes-diff (Story 60-14b).
 *
 * Tests the pure-function diff API:
 *   - extractProbesFromArtifact() reads + parses an artifact file
 *   - computeProbesDiff() partitions two probe sets by name
 *
 * The CLI registration itself is exercised by integration via the
 * substrate executable; the unit tests focus on the pure logic so they
 * run fast + deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { computeProbesDiff, extractProbesFromArtifact } from '../probes-diff.js'
import type { RuntimeProbe } from '@substrate-ai/sdlc'

function probe(name: string, command = 'true'): RuntimeProbe {
  return {
    name,
    sandbox: 'host',
    command,
  }
}

function artifactWithProbes(probesYaml: string): string {
  return `# Story\n\nSome content.\n\n## Runtime Probes\n\n\`\`\`yaml\n${probesYaml}\`\`\`\n`
}

describe('computeProbesDiff', () => {
  it('returns empty diff when both inputs are empty', () => {
    const diff = computeProbesDiff([], [])
    expect(diff.onlyInA).toEqual([])
    expect(diff.onlyInB).toEqual([])
    expect(diff.inBoth).toEqual([])
  })

  it('partitions probes by name across A, B, and both', () => {
    const a = [probe('shared'), probe('only-a')]
    const b = [probe('shared'), probe('only-b-1'), probe('only-b-2')]

    const diff = computeProbesDiff(a, b)

    expect(diff.onlyInA.map((p) => p.name)).toEqual(['only-a'])
    expect(diff.onlyInB.map((p) => p.name).sort()).toEqual(['only-b-1', 'only-b-2'])
    expect(diff.inBoth.map((m) => m.name)).toEqual(['shared'])
  })

  it('handles complete overlap (identical probe sets)', () => {
    const a = [probe('p1'), probe('p2')]
    const b = [probe('p1'), probe('p2')]
    const diff = computeProbesDiff(a, b)
    expect(diff.onlyInA).toEqual([])
    expect(diff.onlyInB).toEqual([])
    expect(diff.inBoth).toHaveLength(2)
  })

  it('handles full disjoint (no shared probes)', () => {
    const a = [probe('a1'), probe('a2')]
    const b = [probe('b1'), probe('b2')]
    const diff = computeProbesDiff(a, b)
    expect(diff.onlyInA).toHaveLength(2)
    expect(diff.onlyInB).toHaveLength(2)
    expect(diff.inBoth).toEqual([])
  })

  it('preserves the full RuntimeProbe shape on inBoth so callers can compare command/timeout/assertions', () => {
    const a = [probe('shared', 'echo a-side')]
    const b = [probe('shared', 'echo b-side')]
    const diff = computeProbesDiff(a, b)
    expect(diff.inBoth).toHaveLength(1)
    expect(diff.inBoth[0]?.a.command).toBe('echo a-side')
    expect(diff.inBoth[0]?.b.command).toBe('echo b-side')
  })
})

describe('extractProbesFromArtifact', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'probes-diff-60-14b-'))
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('returns parsed probes when artifact has a valid Runtime Probes section', () => {
    const path = join(tmpDir, 'artifact.md')
    writeFileSync(
      path,
      artifactWithProbes(`- name: foo
  sandbox: host
  command: echo foo
- name: bar
  sandbox: twin
  command: echo bar
`),
    )
    const probes = extractProbesFromArtifact(path)
    expect(probes.map((p) => p.name)).toEqual(['foo', 'bar'])
    expect(probes[0]?.sandbox).toBe('host')
    expect(probes[1]?.sandbox).toBe('twin')
  })

  it('returns empty array when artifact has no Runtime Probes section (disabled-arm shape)', () => {
    const path = join(tmpDir, 'no-probes.md')
    writeFileSync(path, '# Story 1\n\nNo runtime probes section here.\n')
    const probes = extractProbesFromArtifact(path)
    expect(probes).toEqual([])
  })

  it('throws when artifact file does not exist', () => {
    expect(() => extractProbesFromArtifact(join(tmpDir, 'missing.md'))).toThrow(
      /artifact file not found/,
    )
  })

  it('throws when Runtime Probes section is malformed (parse error surfaces, not silent empty)', () => {
    const path = join(tmpDir, 'broken.md')
    writeFileSync(
      path,
      `# Story\n\n## Runtime Probes\n\n\`\`\`yaml\n- name: missing-required-fields
  command: x
\`\`\`\n`,
    )
    // Missing `sandbox` field → schema validation fails inside parseRuntimeProbes.
    expect(() => extractProbesFromArtifact(path)).toThrow(/malformed/)
  })
})

describe('end-to-end: extract + diff (the CLI workflow)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'probes-diff-e2e-60-14b-'))
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('replicates the A/B harness workflow: enabled-arm vs disabled-arm artifact diff', () => {
    // Enabled arm (probe-author ran): rich probe set
    const enabledPath = join(tmpDir, 'enabled-arm.md')
    writeFileSync(
      enabledPath,
      artifactWithProbes(`- name: post-merge-hook-fires-on-real-conflict
  sandbox: twin
  command: |
    set -e
    git merge --no-edit branch-with-conflicts || true
- name: hook-script-installed
  sandbox: host
  command: test -x .git/hooks/post-merge
`),
    )
    // Disabled arm (probe-author skipped): empty / no probes
    const disabledPath = join(tmpDir, 'disabled-arm.md')
    writeFileSync(disabledPath, '# Story 1-12\n\nDev-authored implementation only; no probes.\n')

    const probesA = extractProbesFromArtifact(enabledPath)
    const probesB = extractProbesFromArtifact(disabledPath)
    const diff = computeProbesDiff(probesA, probesB)

    expect(diff.onlyInA.map((p) => p.name).sort()).toEqual([
      'hook-script-installed',
      'post-merge-hook-fires-on-real-conflict',
    ])
    expect(diff.onlyInB).toEqual([])
    expect(diff.inBoth).toEqual([])
  })
})
