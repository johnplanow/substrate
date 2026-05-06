/**
 * Integration tests for `substrate report` — Story 71-1.
 *
 * Uses a real fixture manifest written to a temp directory.
 * Invokes the CLI via spawnSync against the compiled dist/ build.
 *
 * Skipped when dist/cli.mjs is not present (pre-build environments).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SUBSTRATE_ROOT = resolve(__dirname, '../..')
// Probes reference dist/cli.mjs (created by postbuild: cp dist/cli/index.js dist/cli.mjs)
// Fallback to dist/cli/index.js if .mjs doesn't exist (pre-symlink builds)
const CLI_MJS = join(SUBSTRATE_ROOT, 'dist', 'cli.mjs')
const CLI_FALLBACK = join(SUBSTRATE_ROOT, 'dist', 'cli', 'index.js')
const CLI_PATH = CLI_MJS

// ---------------------------------------------------------------------------
// Fixture manifest helpers
// ---------------------------------------------------------------------------

const FIXTURE_RUN_ID = 'integration-report-fixture'

/**
 * Write a fixture run manifest with three mixed-outcome stories:
 *   71-1: verified (complete + verification_ran + no errors + 0 cycles)
 *   71-2: recovered (complete + review_cycles > 0)
 *   71-3: escalated (checkpoint-retry-timeout)
 */
async function writeFixtureManifest(tmpDir: string, runId: string): Promise<void> {
  const runsDir = join(tmpDir, '.substrate', 'runs')
  await mkdir(runsDir, { recursive: true })

  const manifest = {
    run_id: runId,
    created_at: '2026-05-05T10:00:00.000Z',
    updated_at: '2026-05-05T10:30:00.000Z',
    run_status: 'completed',
    story_scope: ['71-1', '71-2', '71-3'],
    generation: 5,
    supervisor_pid: null,
    supervisor_session_id: null,
    cli_flags: {},
    recovery_history: [],
    cost_accumulation: {
      per_story: { '71-1': 0.05, '71-2': 0.03, '71-3': 0.02 },
      run_total: 0.10,
    },
    pending_proposals: [],
    per_story_state: {
      '71-1': {
        status: 'complete',
        phase: 'COMPLETE',
        started_at: '2026-05-05T10:00:00.000Z',
        completed_at: '2026-05-05T10:10:00.000Z',
        verification_result: {
          status: 'pass',
          findings: [],
          verification_ran: true,
          error_count: 0,
          warn_count: 0,
          info_count: 0,
        },
        cost_usd: 0.05,
        review_cycles: 0,
        dispatches: 1,
      },
      '71-2': {
        status: 'complete',
        phase: 'COMPLETE',
        started_at: '2026-05-05T10:10:00.000Z',
        completed_at: '2026-05-05T10:20:00.000Z',
        verification_result: {
          status: 'pass',
          findings: [],
          verification_ran: true,
          error_count: 0,
          warn_count: 1,
          info_count: 0,
        },
        cost_usd: 0.03,
        review_cycles: 1,
        dispatches: 2,
      },
      '71-3': {
        status: 'escalated',
        phase: 'ESCALATED',
        started_at: '2026-05-05T10:20:00.000Z',
        completed_at: '2026-05-05T10:30:00.000Z',
        escalation_reason: 'checkpoint-retry-timeout',
        cost_usd: 0.02,
        review_cycles: 2,
        dispatches: 1,
      },
    },
  }

  await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(manifest, null, 2))
  // Story 71-2 hot-fix: write canonical `current-run-id` file (production format)
  // so resolveRunManifest finds it. Story 71-1's draft used an invented
  // `manifest.json` aggregate format that does not exist in production.
  await writeFile(join(tmpDir, '.substrate', 'current-run-id'), runId)
}

// ---------------------------------------------------------------------------
// CLI invocation helper
// ---------------------------------------------------------------------------

interface CliResult {
  stdout: string
  stderr: string
  status: number | null
}

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  // Use a minimal environment to avoid inheriting test-runner env vars that
  // might cause adapter health checks (claude --version, codex, gemini) to hang.
  // Pass only essential variables (PATH, HOME, NODE_*, TMPDIR, TEMP).
  const minimalEnv: Record<string, string> = {}
  const passThrough = ['PATH', 'HOME', 'NODE_PATH', 'NODE_OPTIONS', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
  for (const key of passThrough) {
    const val = process.env[key]
    if (val !== undefined) minimalEnv[key] = val
  }

  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: {
      ...minimalEnv,
      ...env,
      // Suppress update check noise
      SUBSTRATE_NO_UPDATE_CHECK: '1',
      // Suppress pino-pretty color codes that vary by terminal
      NO_COLOR: '1',
    },
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('substrate report integration', () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
      tmpDir = undefined
    }
  })

  it('human output: mixed-outcome fixture produces correct summary line and escalation detail', async () => {
    // Skip if dist/cli.mjs doesn't exist (pre-build)
    try {
      await access(CLI_PATH)
    } catch {
      console.log('Skipping integration test: dist/cli.mjs not found (run npm run build first)')
      return
    }

    tmpDir = await mkdtemp(join(tmpdir(), 'report-integration-'))
    await writeFixtureManifest(tmpDir, FIXTURE_RUN_ID)

    const result = runCli(['report', '--run', FIXTURE_RUN_ID], {
      SUBSTRATE_PROJECT_ROOT: tmpDir,
    })

    // Should exit successfully
    expect(result.status).toBe(0)

    // Summary line with correct counts
    expect(result.stdout).toContain('1 verified')
    expect(result.stdout).toContain('1 recovered')
    expect(result.stdout).toContain('1 escalated')
    expect(result.stdout).toContain('3 total')

    // Escalation detail block
    expect(result.stdout).toContain('checkpoint-retry-timeout')
    expect(result.stdout).toContain('reconcile-from-disk')
  })

  it('JSON output: well-formed with all required top-level keys', async () => {
    try {
      await access(CLI_PATH)
    } catch {
      console.log('Skipping integration test: dist/cli.mjs not found (run npm run build first)')
      return
    }

    tmpDir = await mkdtemp(join(tmpdir(), 'report-integration-json-'))
    await writeFixtureManifest(tmpDir, FIXTURE_RUN_ID)

    const result = runCli(['report', '--run', FIXTURE_RUN_ID, '--output-format', 'json'], {
      SUBSTRATE_PROJECT_ROOT: tmpDir,
    })

    expect(result.status).toBe(0)
    let parsed: Record<string, unknown>
    expect(() => {
      parsed = JSON.parse(result.stdout) as Record<string, unknown>
    }).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!).toHaveProperty('runId')
    expect(parsed!).toHaveProperty('summary')
    expect(parsed!).toHaveProperty('stories')
    expect(parsed!).toHaveProperty('escalations')
    expect(parsed!).toHaveProperty('cost')
    expect(parsed!).toHaveProperty('duration')
  })

  it('no-runs-exist: exits 1 with friendly error', async () => {
    try {
      await access(CLI_PATH)
    } catch {
      console.log('Skipping integration test: dist/cli.mjs not found (run npm run build first)')
      return
    }

    // Create a tmpDir with NO runs
    tmpDir = await mkdtemp(join(tmpdir(), 'report-integration-empty-'))
    await mkdir(join(tmpDir, '.substrate', 'runs'), { recursive: true })
    // No manifest.json pointer → no runs found

    const result = runCli(['report', '--run', 'latest'], {
      SUBSTRATE_PROJECT_ROOT: tmpDir,
    })

    expect(result.status).not.toBe(0)
    // Error message should appear on stderr
    expect(result.stderr).toContain('No runs found')
  })
})
