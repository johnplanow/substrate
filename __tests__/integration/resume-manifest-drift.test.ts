/**
 * Integration tests for Story 66-3: `substrate resume` manifest drift detection.
 *
 * AC5: Integration tests covering:
 *   - Drift detected → non-zero exit + "manifest drift detected" in output
 *   - Drift + --force-from-manifest → bypasses drift, no drift message
 *   - No drift → drift check returns { drifted: false }, resume not blocked (AC6)
 *
 * Uses tmpdir fixtures; calls the resume action handler and drift detector directly
 * (no subprocess spawning) for deterministic assertions.
 *
 * References obs_2026-05-03_022 fix #3.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// ---------------------------------------------------------------------------

// Mock git-root so resolveMainRepoRoot returns the test tmpdir as-is
vi.mock('../../src/utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// Mock database adapter — won't be reached for drift-detected tests
vi.mock('../../src/persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}))

// Mock schema init — won't be reached for drift-detected tests
vi.mock('../../src/persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runResumeAction } from '../../src/cli/commands/resume.js'
import {
  detectManifestDriftAgainstWorkingTree,
  type DriftDetectionResult,
} from '../../src/cli/commands/resume-drift-detector.js'
import type { RunManifestData } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid RunManifestData fixture.
 * `startedAt` is used as the `started_at` for the story entry and as the
 * top-level `updated_at` / `created_at` timestamps.
 */
function buildFakeManifest(
  startedAt: string,
  runId = 'test-run-00000000-0000-0000-0000-000000000000',
  storyPhase = 'IN_STORY_CREATION',
  storyStatus = 'dispatched',
): RunManifestData {
  return {
    run_id: runId,
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {
      'probe-story': {
        phase: storyPhase,
        status: storyStatus as 'dispatched',
        started_at: startedAt,
      },
    },
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    generation: 1,
    created_at: startedAt,
    updated_at: startedAt,
  }
}

/**
 * Write a fake manifest and current-run-id file into a tmpdir.
 * This allows resolveRunManifest to find the manifest during resume.
 */
async function writeFakeManifest(
  dir: string,
  manifest: RunManifestData,
): Promise<void> {
  const runsDir = join(dir, '.substrate', 'runs')
  await mkdir(runsDir, { recursive: true })
  await writeFile(join(runsDir, `${manifest.run_id}.json`), JSON.stringify(manifest))
  await writeFile(join(dir, '.substrate', 'current-run-id'), manifest.run_id)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('resume manifest drift detection', () => {
  let tmpDir: string
  let stderrChunks: string[]
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'substrate-drift-test-'))
    stderrChunks = []
    // Suppress stderr output in tests but capture for assertions
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk))
      return true
    })
    // Suppress stdout output in tests
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    await rm(tmpDir, { recursive: true, force: true })
    delete process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS']
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC5: drift detected → non-zero exit + "manifest drift detected"
  // -------------------------------------------------------------------------

  it('drift detected → non-zero exit with drift message', async () => {
    const staleTs = new Date(Date.now() - 600_000).toISOString()
    const manifest = buildFakeManifest(staleTs)
    await writeFakeManifest(tmpDir, manifest)

    // Write a source file whose mtime is now (newer than the stale manifest timestamp)
    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'newer-probe-file.ts'), '// probe: newer than manifest')

    // Scope the scan to only src/**/*.ts (avoids touching project source files)
    process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS'] = 'src/**/*.ts'

    const exitCode = await runResumeAction({
      outputFormat: 'human',
      projectRoot: tmpDir,
      concurrency: 3,
      pack: 'bmad',
    })

    expect(exitCode).toBe(1)
    const stderrOutput = stderrChunks.join('')
    expect(stderrOutput).toContain('manifest drift detected')
  })

  // -------------------------------------------------------------------------
  // AC5: drift detected + --force-from-manifest → bypass drift check
  // -------------------------------------------------------------------------

  it('drift detected + --force-from-manifest → bypasses drift check', async () => {
    const staleTs = new Date(Date.now() - 600_000).toISOString()
    const manifest = buildFakeManifest(staleTs)
    await writeFakeManifest(tmpDir, manifest)

    // Same drift scenario: newer source file
    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'newer-probe-file.ts'), '// probe: newer than manifest')

    process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS'] = 'src/**/*.ts'

    // With --force-from-manifest, drift check must be bypassed.
    // Process may still exit non-zero for other reasons (no DB, no active run),
    // but must NOT emit "manifest drift detected".
    await runResumeAction({
      outputFormat: 'human',
      projectRoot: tmpDir,
      concurrency: 3,
      pack: 'bmad',
      forceFromManifest: true,
    })

    const stderrOutput = stderrChunks.join('')
    expect(stderrOutput).not.toContain('manifest drift detected')
  })

  // -------------------------------------------------------------------------
  // AC6: no drift → drift check returns { drifted: false }, resume not blocked
  // -------------------------------------------------------------------------

  it('no drift → detectManifestDriftAgainstWorkingTree returns drifted:false', async () => {
    // Manifest updated_at is in the future → all files on disk are older
    const futureTs = new Date(Date.now() + 60_000).toISOString()
    const manifest = buildFakeManifest(futureTs)

    // Write a source file (its mtime will be < futureTs)
    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'existing-file.ts'), '// existing file')

    process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS'] = 'src/**/*.ts'

    const result: DriftDetectionResult = await detectManifestDriftAgainstWorkingTree(
      manifest,
      tmpDir,
    )

    expect(result.drifted).toBe(false)
    expect(result.evidence).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Additional: verifies non-IN_STORY_CREATION / non-dispatched entries are skipped
  // -------------------------------------------------------------------------

  it('does not flag drift for stories not in IN_STORY_CREATION/dispatched phase', async () => {
    const staleTs = new Date(Date.now() - 600_000).toISOString()

    // Story is in IN_DEV phase (not IN_STORY_CREATION) — should NOT trigger drift
    const manifest = buildFakeManifest(staleTs, 'test-run-id', 'IN_DEV', 'dispatched')
    await writeFakeManifest(tmpDir, manifest)

    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'some-file.ts'), '// newer file')

    process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS'] = 'src/**/*.ts'

    const result: DriftDetectionResult = await detectManifestDriftAgainstWorkingTree(
      manifest,
      tmpDir,
    )

    expect(result.drifted).toBe(false)
  })

  it('does not flag drift for IN_STORY_CREATION/complete (not dispatched) entries', async () => {
    const staleTs = new Date(Date.now() - 600_000).toISOString()

    const manifest = buildFakeManifest(staleTs, 'test-run-id', 'IN_STORY_CREATION', 'complete')

    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'some-file.ts'), '// newer file')

    process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS'] = 'src/**/*.ts'

    const result: DriftDetectionResult = await detectManifestDriftAgainstWorkingTree(
      manifest,
      tmpDir,
    )

    expect(result.drifted).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Evidence structure: up to 3 sample files per story
  // -------------------------------------------------------------------------

  it('evidence includes up to 3 sample files per drifted story', async () => {
    const staleTs = new Date(Date.now() - 600_000).toISOString()
    const manifest = buildFakeManifest(staleTs)

    const srcDir = join(tmpDir, 'src')
    await mkdir(srcDir, { recursive: true })

    // Write 5 newer .ts files
    for (let i = 0; i < 5; i++) {
      await writeFile(join(srcDir, `file-${i}.ts`), `// file ${i}`)
    }

    process.env['SUBSTRATE_RESUME_DRIFT_SCAN_GLOBS'] = 'src/**/*.ts'

    const result: DriftDetectionResult = await detectManifestDriftAgainstWorkingTree(
      manifest,
      tmpDir,
    )

    expect(result.drifted).toBe(true)
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0]!.storyKey).toBe('probe-story')
    expect(result.evidence[0]!.sampleFiles.length).toBeLessThanOrEqual(3)
  })
})
