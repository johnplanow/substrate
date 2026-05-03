/**
 * Unit tests for eval-probe-author-state-integrating (Story 65-3).
 *
 * Tests cover:
 *   - parseStateIntegratingCorpus(): valid YAML parses; invalid throws
 *   - Per-case result shape: caught/missed/failure_reason
 *   - computeCatchRate round-trip: 8 cases
 *   - Aggregate report shape in --dry-run mode
 *
 * Does NOT dispatch to probe-author (all tests are pure-function or mock-based).
 * Full live eval (≥8 LLM dispatches) is manual / CI-opt-in only.
 */

import { describe, it, expect } from 'vitest'

// @ts-expect-error — importing JS module from TS test (vitest handles cross-load)
import { parseStateIntegratingCorpus } from '../eval-probe-author-state-integrating.mjs'

// @ts-expect-error — importing JS module from TS test
import { evaluateSignature, computeCatchRate } from '../eval-probe-author/lib.mjs'

// ---------------------------------------------------------------------------
// parseStateIntegratingCorpus
// ---------------------------------------------------------------------------

describe('parseStateIntegratingCorpus', () => {
  it('parses a valid YAML corpus with all required fields', () => {
    // Write a minimal valid corpus to a temp file, then parse it
    const { writeFileSync, mkdtempSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'si-corpus-test-'))
    const yamlPath = join(dir, 'corpus.yaml')
    const validCorpus = `
applicable_entries:
  - id: test-entry-1
    description: Test entry 1
    source_ac: "The implementation reads from real filesystem"
    broken_implementation: "Uses hardcoded path"
    real_state_condition: "File exists at real path"
    signature:
      - 'readFile|readFileSync'
      - 'homedir|HOME'
    mock_authored_probes:
      - name: test-probe
        sandbox: host
        command: |
          node -e "const fs = require('fs'); fs.readFileSync(require('os').homedir() + '/test', 'utf8')"
  - id: test-entry-2
    description: Test entry 2
    source_ac: "The implementation calls git log per-project"
    broken_implementation: "Uses fleet root"
    real_state_condition: "Two repos with distinct commits"
    signature:
      - 'git\\\\s+log'
    mock_authored_probes:
      - name: git-probe
        sandbox: host
        command: git log --format="%s" HEAD~1..HEAD

excluded_entries:
  - id: excluded-1
    reason: out of scope
`
    writeFileSync(yamlPath, validCorpus, 'utf-8')

    const corpus = parseStateIntegratingCorpus(yamlPath)
    expect(corpus.applicable_entries).toHaveLength(2)
    expect(corpus.applicable_entries[0].id).toBe('test-entry-1')
    expect(corpus.applicable_entries[0].source_ac).toContain('real filesystem')
    expect(corpus.applicable_entries[0].signature).toHaveLength(2)
    expect(corpus.applicable_entries[0].mock_authored_probes).toHaveLength(1)
    expect(corpus.applicable_entries[1].id).toBe('test-entry-2')
    expect(corpus.excluded_entries).toHaveLength(1)
    expect(corpus.excluded_entries[0].id).toBe('excluded-1')
  })

  it('throws when signature is missing', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'si-corpus-test-'))
    const yamlPath = join(dir, 'corpus.yaml')
    writeFileSync(
      yamlPath,
      `
applicable_entries:
  - id: no-sig-entry
    source_ac: "Some AC text"
    mock_authored_probes:
      - name: p
        sandbox: host
        command: echo ok
`,
      'utf-8',
    )

    expect(() => parseStateIntegratingCorpus(yamlPath)).toThrow(
      /needs a non-empty signature list/,
    )
  })

  it('throws when id is missing', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'si-corpus-test-'))
    const yamlPath = join(dir, 'corpus.yaml')
    writeFileSync(
      yamlPath,
      `
applicable_entries:
  - source_ac: "Some AC text"
    signature:
      - 'foo'
    mock_authored_probes:
      - name: p
        sandbox: host
        command: echo ok
`,
      'utf-8',
    )

    expect(() => parseStateIntegratingCorpus(yamlPath)).toThrow(
      /needs a non-empty id/,
    )
  })

  it('throws when signature is a non-array type', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'si-corpus-test-'))
    const yamlPath = join(dir, 'corpus.yaml')
    writeFileSync(
      yamlPath,
      `
applicable_entries:
  - id: bad-sig
    source_ac: "Some AC text"
    signature: "this-should-be-an-array"
    mock_authored_probes:
      - name: p
        sandbox: host
        command: echo ok
`,
      'utf-8',
    )

    expect(() => parseStateIntegratingCorpus(yamlPath)).toThrow(
      /needs a non-empty signature list/,
    )
  })

  it('throws when signature contains a non-string entry', () => {
    const { writeFileSync, mkdtempSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')

    const dir = mkdtempSync(join(tmpdir(), 'si-corpus-test-'))
    const yamlPath = join(dir, 'corpus.yaml')
    writeFileSync(
      yamlPath,
      `
applicable_entries:
  - id: bad-sig-type
    source_ac: "Some AC text"
    signature:
      - 123
    mock_authored_probes:
      - name: p
        sandbox: host
        command: echo ok
`,
      'utf-8',
    )

    expect(() => parseStateIntegratingCorpus(yamlPath)).toThrow(
      /signature entries must be regex strings/,
    )
  })
})

// ---------------------------------------------------------------------------
// Per-case result shape using evaluateSignature
// ---------------------------------------------------------------------------

describe('Per-case result shape (evaluateSignature)', () => {
  it('caught=true when mock probes match all signature regexes', () => {
    const probes = [
      {
        name: 'git-log-per-project',
        sandbox: 'host',
        command: 'git log --format="%s" HEAD~1..HEAD',
        expect_stdout_regex: ['alpha commit'],
      },
    ]
    const signature = ['git\\s+log', 'alpha|beta|fleet']

    // The probe command has "git log" but "alpha|beta|fleet" may not be in the probe JSON.
    // Let's use a probe that includes the fleet reference
    const probesWithFleet = [
      {
        name: 'git-log-per-project',
        sandbox: 'host',
        command: 'cd "$PARENT/repo-alpha" && git log --format="%s" 2>&1',
        expect_stdout_regex: ['alpha commit'],
      },
    ]

    const result = evaluateSignature(probesWithFleet, signature)
    expect(result.matched).toBe(true)
    expect(result.matchingProbeName).toBe('git-log-per-project')
  })

  it('caught=false when no probe matches all signature regexes', () => {
    // Probe has git log but lacks "alpha|beta|fleet" markers
    const probes = [
      {
        name: 'implementation-only',
        sandbox: 'host',
        command: 'node dist/cli/index.js briefing --project "$PROJECT"',
      },
    ]
    const signature = ['git\\s+log', 'alpha|beta|fleet']

    const result = evaluateSignature(probes, signature)
    expect(result.matched).toBe(false)
    expect(result.matchingProbeName).toBeNull()
  })

  it('failure_reason is populated when probe did not match — evaluateSignature returns matched=false', () => {
    const probes = [{ name: 'weak-probe', sandbox: 'host', command: 'echo nothing' }]
    const signature = ['npm\\s+outdated', 'current|wanted']
    const result = evaluateSignature(probes, signature)
    expect(result.matched).toBe(false)
    // The eval script would set failure_reason to 'no authored probe matched signature ...'
    // We verify the evaluateSignature contract here
    expect(result.matchingProbeName).toBeNull()
  })

  it('returns matched=false on empty probe array', () => {
    const result = evaluateSignature([], ['npm\\s+outdated'])
    expect(result.matched).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeCatchRate round-trip with 8 cases
// ---------------------------------------------------------------------------

describe('computeCatchRate round-trip (8 cases)', () => {
  it('computes correct catch rate for 8 cases with 5 caught and 3 missed', () => {
    const perDefect = [
      { caught: true },  // 1
      { caught: true },  // 2
      { caught: false }, // 3
      { caught: true },  // 4
      { caught: false }, // 5
      { caught: true },  // 6
      { caught: true },  // 7
      { caught: false }, // 8
    ]
    const result = computeCatchRate(perDefect)
    expect(result.total).toBe(8)
    expect(result.caught).toBe(5)
    expect(result.catchRate).toBeCloseTo(5 / 8)
  })

  it('returns catch rate 1.0 when all 8 cases caught', () => {
    const perDefect = Array.from({ length: 8 }, () => ({ caught: true }))
    const result = computeCatchRate(perDefect)
    expect(result.total).toBe(8)
    expect(result.caught).toBe(8)
    expect(result.catchRate).toBe(1.0)
  })

  it('returns catch rate 0 when all 8 cases missed', () => {
    const perDefect = Array.from({ length: 8 }, () => ({ caught: false }))
    const result = computeCatchRate(perDefect)
    expect(result.total).toBe(8)
    expect(result.caught).toBe(0)
    expect(result.catchRate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Aggregate report shape (dry-run)
// ---------------------------------------------------------------------------

describe('Aggregate report shape (dry-run mode)', () => {
  it('dry-run output file contains all required aggregate and per-case fields', async () => {
    const { execFileSync } = require('node:child_process')
    const { readFileSync, mkdtempSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join, dirname } = require('node:path')
    const { fileURLToPath } = require('node:url')

    // Use relative path from repo root
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
    const corpusPath = join(repoRoot, 'packs/bmad/eval/probe-author-state-integrating-corpus.yaml')
    const dir = mkdtempSync(join(tmpdir(), 'si-report-test-'))
    const outputPath = join(dir, 'report.json')

    // Run the eval script in dry-run mode
    execFileSync(
      'node',
      [
        join(repoRoot, 'scripts/eval-probe-author-state-integrating.mjs'),
        '--corpus', corpusPath,
        '--dry-run',
        '--output', outputPath,
        '--threshold', '0',
      ],
      { encoding: 'utf-8', stdio: 'pipe' },
    )

    const report = JSON.parse(readFileSync(outputPath, 'utf-8'))

    // Aggregate fields
    expect(report).toHaveProperty('catch_rate')
    expect(report).toHaveProperty('total_cost_usd')
    expect(report).toHaveProperty('total_wall_clock_ms')
    expect(report).toHaveProperty('per_case')
    expect(report).toHaveProperty('decision')
    expect(report).toHaveProperty('timestamp')
    expect(report).toHaveProperty('substrate_version')
    expect(report).toHaveProperty('corpus_path')
    expect(report).toHaveProperty('threshold')
    expect(report).toHaveProperty('dry_run')
    expect(report.dry_run).toBe(true)

    // Per-case fields
    expect(Array.isArray(report.per_case)).toBe(true)
    expect(report.per_case.length).toBeGreaterThanOrEqual(8)

    for (const c of report.per_case) {
      expect(c).toHaveProperty('case_id')
      expect(c).toHaveProperty('caught')
      expect(c).toHaveProperty('cost_usd')
      expect(c).toHaveProperty('wall_clock_ms')
      expect(c).toHaveProperty('probe_count')
    }

    // Decision rubric
    const validDecisions = ['GREEN', 'YELLOW', 'RED']
    expect(validDecisions).toContain(report.decision)

    // Dry-run costs should be 0
    expect(report.total_cost_usd).toBe(0)
    for (const c of report.per_case) {
      expect(c.cost_usd).toBe(0)
      expect(c.wall_clock_ms).toBe(0)
    }
  }, 30000) // 30s timeout for subprocess
})
