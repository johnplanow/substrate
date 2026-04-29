/**
 * Unit tests for `substrate annotate` (Story 60-15).
 *
 * Covers the validation surface (judgment-flag exclusivity, missing
 * runs, story-not-found, no-verification-result-to-annotate) and the
 * happy-path round-trip through the run manifest. Real RunManifest
 * I/O — the manifest module is well-tested elsewhere (Story 57-1's
 * concurrent-writes regression test, Story 52-7's verification_result
 * round-trip), so testing against an actual temp manifest validates
 * the integration without mocking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RunManifest } from '@substrate-ai/sdlc'

// Mock resolveMainRepoRoot so the annotate action uses the test's tmpDir
// rather than walking to the substrate repo's git root. Must be hoisted
// (vi.mock pattern) before the action under test imports the util.
let mockedRepoRoot = ''
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: async (_p: string) => mockedRepoRoot,
}))

import { runAnnotateAction } from '../annotate.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'annotate-60-15-'))
  mockedRepoRoot = tmpDir
})

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
  vi.restoreAllMocks()
})

async function seedManifestWithVerificationResult(runId: string, storyKey: string): Promise<void> {
  // Match the action's path resolution: dbRoot=tmpDir → join(dbRoot, 'runs')
  const manifest = RunManifest.open(runId, join(tmpDir, 'runs'))
  await manifest.patchStoryState(storyKey, {
    status: 'verified',
    phase: 'verification',
    started_at: new Date().toISOString(),
    verification_result: {
      storyKey,
      status: 'fail',
      duration_ms: 100,
      checks: [
        {
          checkName: 'RuntimeProbeCheck',
          status: 'fail',
          details: 'probe failed',
          duration_ms: 50,
          findings: [
            {
              category: 'runtime-probe-fail',
              severity: 'error',
              message: 'probe "test" failed',
              _authoredBy: 'probe-author',
            },
          ],
        },
      ],
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('substrate annotate', () => {
  it('rejects when zero judgment flags provided', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runAnnotateAction({
      story: '1-1',
      findingCategory: 'runtime-probe-fail',
      runId: 'fake-run',
      outputFormat: 'human',
      projectRoot: tmpDir,
    })
    expect(exitCode).toBe(1)
    expect(errSpy.mock.calls.flat().join('')).toMatch(/exactly one of/)
  })

  it('rejects when multiple judgment flags provided', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runAnnotateAction({
      story: '1-1',
      findingCategory: 'runtime-probe-fail',
      runId: 'fake-run',
      confirmedDefect: true,
      falsePositive: true,
      outputFormat: 'human',
      projectRoot: tmpDir,
    })
    expect(exitCode).toBe(1)
    expect(errSpy.mock.calls.flat().join('')).toMatch(/exactly one of/)
  })

  it('writes confirmed-defect annotation to manifest end-to-end', async () => {
    const runId = 'run-test-1'
    const storyKey = '1-1'
    await seedManifestWithVerificationResult(runId, storyKey)

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const exitCode = await runAnnotateAction({
      story: storyKey,
      findingCategory: 'runtime-probe-fail',
      probeName: 'test',
      note: 'real defect — probe caught the wiring bug',
      runId,
      confirmedDefect: true,
      outputFormat: 'json',
      projectRoot: tmpDir,
    })

    expect(exitCode).toBe(0)
    const stdoutText = stdoutSpy.mock.calls.flat().join('')
    const out = JSON.parse(stdoutText)
    expect(out.success).toBe(true)
    expect(out.annotation.judgment).toBe('confirmed-defect')
    expect(out.annotation.findingCategory).toBe('runtime-probe-fail')
    expect(out.annotation.probeName).toBe('test')
    expect(out.totalAnnotations).toBe(1)

    // Read back the manifest and confirm persistence
    const manifest = RunManifest.open(runId, join(tmpDir, 'runs'))
    const data = await manifest.read()
    const annotations = data.per_story_state[storyKey]?.verification_result?.annotations
    expect(annotations).toHaveLength(1)
    expect(annotations?.[0]?.judgment).toBe('confirmed-defect')
    expect(annotations?.[0]?.note).toContain('real defect')
  })

  it('appends to existing annotations array (does not overwrite)', async () => {
    const runId = 'run-test-2'
    const storyKey = '1-2'
    await seedManifestWithVerificationResult(runId, storyKey)

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    // First annotation
    await runAnnotateAction({
      story: storyKey,
      findingCategory: 'runtime-probe-fail',
      runId,
      confirmedDefect: true,
      outputFormat: 'json',
      projectRoot: tmpDir,
    })
    // Second annotation
    await runAnnotateAction({
      story: storyKey,
      findingCategory: 'runtime-probe-error-response',
      runId,
      falsePositive: true,
      outputFormat: 'json',
      projectRoot: tmpDir,
    })

    const manifest = RunManifest.open(runId, join(tmpDir, 'runs'))
    const data = await manifest.read()
    const annotations = data.per_story_state[storyKey]?.verification_result?.annotations ?? []
    expect(annotations).toHaveLength(2)
    expect(annotations[0]?.judgment).toBe('confirmed-defect')
    expect(annotations[1]?.judgment).toBe('false-positive')
  })

  it('rejects when story has no verification_result to annotate', async () => {
    const runId = 'run-test-3'
    // Create manifest with story state but no verification_result
    const manifest = RunManifest.open(runId, join(tmpDir, 'runs'))
    await manifest.patchStoryState('1-3', {
      status: 'pending',
      phase: 'planning',
      started_at: new Date().toISOString(),
    })

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runAnnotateAction({
      story: '1-3',
      findingCategory: 'runtime-probe-fail',
      runId,
      confirmedDefect: true,
      outputFormat: 'human',
      projectRoot: tmpDir,
    })

    expect(exitCode).toBe(1)
    expect(errSpy.mock.calls.flat().join('')).toMatch(/no verification_result/)
  })

  it('rejects when story not found in manifest', async () => {
    const runId = 'run-test-4'
    await seedManifestWithVerificationResult(runId, 'real-story')

    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runAnnotateAction({
      story: 'nonexistent-story',
      findingCategory: 'runtime-probe-fail',
      runId,
      confirmedDefect: true,
      outputFormat: 'human',
      projectRoot: tmpDir,
    })

    expect(exitCode).toBe(1)
    expect(errSpy.mock.calls.flat().join('')).toMatch(/not found/)
  })
})
