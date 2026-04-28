/**
 * Unit tests for `substrate probe-author dispatch` (Story 60-14e).
 *
 * Tests the CLI surface around the runProbeAuthor wrapper. Cases focus
 * on the SKIP paths (Gate 1: non-event-driven AC; Gate 2: artifact
 * already has probes) which exercise the entire CLI plumbing without
 * needing a real LLM dispatch.
 *
 * The runProbeAuthor function itself is independently covered by 10
 * tests in probe-author-integration.test.ts including dispatch success,
 * timeout retry, invalid-YAML retry, and idempotent append. Testing
 * those paths again here would be duplicate coverage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import { runProbeAuthorDispatch } from '../probe-author.js'

// Silence logs from the CLI subcommand under test.
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NON_EVENT_DRIVEN_STORY = `# Story Z

## Story
Write user config to disk on save.

## Acceptance Criteria
- AC1: Config is written on save.
- AC2: File contains user preferences.
`

const EVENT_DRIVEN_STORY_WITH_PROBES = `# Story Y: Hook fires on merge

## Acceptance Criteria
- AC1: post-merge hook fires when git merge completes

## Runtime Probes

\`\`\`yaml
- name: existing
  sandbox: host
  command: echo existing
\`\`\`
`

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string
let registry: AdapterRegistry

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'probe-author-cli-60-14e-'))
  registry = new AdapterRegistry()
  // Don't call discoverAndRegister — adapters require external CLIs which
  // may not be present in CI. The Gate-1/Gate-2 skip paths short-circuit
  // before the dispatcher is exercised, so an empty registry is fine.
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  vi.restoreAllMocks()
})

const projectRoot = '/home/jplanow/code/jplanow/substrate'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('substrate probe-author dispatch', () => {
  it('Gate 1: skips probe-author when source AC is not event-driven', async () => {
    const storyFile = join(tmpDir, 'story.md')
    writeFileSync(storyFile, NON_EVENT_DRIVEN_STORY, 'utf-8')

    const stdout: string[] = []
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdout.push(chunk.toString())
        return true
      })

    const exitCode = await runProbeAuthorDispatch(
      {
        storyFile,
        storyKey: 'test-z',
        agent: 'claude-code',
        pack: 'bmad',
        outputFormat: 'json',
      },
      projectRoot,
      registry,
    )

    writeSpy.mockRestore()
    expect(exitCode).toBe(1) // skipped is not "success" — exit non-zero
    const json = JSON.parse(stdout.join(''))
    expect(json.result).toBe('skipped')
    expect(json.probesAuthoredCount).toBe(0)
    expect(json.probes).toEqual([])
    // No LLM was dispatched on the skip path → no token usage.
    expect(json.tokenUsage).toEqual({ input: 0, output: 0 })
  })

  it('Gate 2: skips probe-author when artifact already has ## Runtime Probes section', async () => {
    const storyFile = join(tmpDir, 'story.md')
    writeFileSync(storyFile, EVENT_DRIVEN_STORY_WITH_PROBES, 'utf-8')

    const stdout: string[] = []
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdout.push(chunk.toString())
        return true
      })

    const exitCode = await runProbeAuthorDispatch(
      {
        storyFile,
        storyKey: 'test-y',
        agent: 'claude-code',
        pack: 'bmad',
        outputFormat: 'json',
      },
      projectRoot,
      registry,
    )

    writeSpy.mockRestore()
    expect(exitCode).toBe(1)
    const json = JSON.parse(stdout.join(''))
    expect(json.result).toBe('skipped')
    // Even though the artifact has 1 existing probe, runProbeAuthor returns
    // probesAuthoredCount=0 because no NEW probes were authored — the gate
    // fired before dispatch. The CLI's `probes` field reflects whatever was
    // already in the file (the eval consumes only the runProbeAuthor probes).
    expect(json.probesAuthoredCount).toBe(0)
  })

  it('--output-format=append leaves the story file in place + writes status to stderr', async () => {
    const storyFile = join(tmpDir, 'story.md')
    writeFileSync(storyFile, NON_EVENT_DRIVEN_STORY, 'utf-8')

    const stderr: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderr.push(chunk.toString())
        return true
      })

    const exitCode = await runProbeAuthorDispatch(
      {
        storyFile,
        storyKey: 'test-append',
        agent: 'claude-code',
        pack: 'bmad',
        outputFormat: 'append',
      },
      projectRoot,
      registry,
    )

    stderrSpy.mockRestore()
    expect(exitCode).toBe(1) // skipped
    // File unchanged on skip (Gate 1 short-circuited).
    const after = readFileSync(storyFile, 'utf-8')
    expect(after).toBe(NON_EVENT_DRIVEN_STORY)
    // Status line written to stderr (not stdout, so it doesn't pollute --output-format=json consumers).
    expect(stderr.join('')).toContain('skipped')
  })

  it('returns exit 1 + clear stderr when --story-file does not exist', async () => {
    const stderr: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderr.push(chunk.toString())
        return true
      })

    const exitCode = await runProbeAuthorDispatch(
      {
        storyFile: join(tmpDir, 'does-not-exist.md'),
        storyKey: 'test-missing',
        agent: 'claude-code',
        pack: 'bmad',
        outputFormat: 'json',
      },
      projectRoot,
      registry,
    )

    stderrSpy.mockRestore()
    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('failed to read epic file')
  })

  it('returns exit 1 + clear stderr when --pack does not resolve', async () => {
    const storyFile = join(tmpDir, 'story.md')
    writeFileSync(storyFile, NON_EVENT_DRIVEN_STORY, 'utf-8')

    const stderr: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderr.push(chunk.toString())
        return true
      })

    const exitCode = await runProbeAuthorDispatch(
      {
        storyFile,
        storyKey: 'test-bad-pack',
        agent: 'claude-code',
        pack: 'nonexistent-pack-xyz',
        outputFormat: 'json',
      },
      projectRoot,
      registry,
    )

    stderrSpy.mockRestore()
    expect(exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/failed to load methodology pack/)
  })
})
