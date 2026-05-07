/**
 * Integration tests for Interactive Prompt (Story 73-2, AC10).
 *
 * Tests:
 *   1. Full E2E (AC10): runInteractivePrompt (ESM, non-interactive) writes notification
 *      file → substrate report reads "Operator Halts" section → deletes notification.
 *   2. substrate report reads pre-planted notification files and deletes them.
 *   3. substrate report handles missing notification directory gracefully.
 *
 * NOTE: The dist/ is ESM format (tsdown format: 'esm'). All dynamic imports of
 * dist/* modules use import() or a temp .mjs file — never require().
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync, type SpawnSyncReturns } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

/**
 * Build a rich diagnostic for spawnSync failures so flaky-on-CI assertions
 * surface exit reason, signal, spawn error, and (tail of) both streams in
 * the assertion message — a 2026-05-06 macOS CI flake on the missing-notification-directory
 * test exited 1 with no stderr capture, leaving "expected 0, got 1" the only signal.
 */
function spawnDiag(label: string, r: SpawnSyncReturns<Buffer>): string {
  const tail = (s: Buffer | string | undefined, n = 2000): string => {
    const str = typeof s === 'string' ? s : (s?.toString() ?? '')
    return str.length > n ? `…${str.slice(-n)}` : str
  }
  return [
    `${label} failed`,
    `  status: ${r.status}`,
    `  signal: ${r.signal ?? 'null'}`,
    `  error: ${r.error ? `${r.error.name}: ${r.error.message}` : 'none'}`,
    `  stdout: ${tail(r.stdout) || '(empty)'}`,
    `  stderr: ${tail(r.stderr) || '(empty)'}`,
  ].join('\n')
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SUBSTRATE_ROOT = resolve(__dirname, '../..')
const CLI_MJS = join(SUBSTRATE_ROOT, 'dist', 'cli.mjs')
const INTERACTIVE_PROMPT_MODULE = join(SUBSTRATE_ROOT, 'dist', 'modules', 'interactive-prompt', 'index.js')

// Skip all tests if dist/ is not built yet
let distExists = false
try {
  await access(CLI_MJS)
  await access(INTERACTIVE_PROMPT_MODULE)
  distExists = true
} catch {
  distExists = false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_RUN_ID = 'integration-interactive-prompt-test'

async function writeMiniManifest(tmpDir: string, runId: string): Promise<void> {
  const runsDir = join(tmpDir, '.substrate', 'runs')
  await mkdir(runsDir, { recursive: true })

  const manifest = {
    run_id: runId,
    created_at: '2026-05-06T00:00:00.000Z',
    updated_at: '2026-05-06T00:01:00.000Z',
    run_status: 'complete',
    story_scope: [],
    generation: 1,
    supervisor_pid: null,
    supervisor_session_id: null,
    cli_flags: {},
    recovery_history: [],
    cost_accumulation: { per_story: {}, run_total: 0 },
    pending_proposals: [],
    per_story_state: {},
  }
  await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(manifest, null, 2))
}

/** Write a pre-built notification file (simulating what runInteractivePrompt would produce). */
async function writeNotificationFixture(
  tmpDir: string,
  runId: string,
  operatorChoice: string | null = null,
): Promise<string> {
  const notifDir = join(tmpDir, '.substrate', 'notifications')
  await mkdir(notifDir, { recursive: true })

  const timestamp = '2026-05-06T00-00-00-000Z'
  const filename = `${runId}-${timestamp}.json`
  const filePath = join(notifDir, filename)

  const notification = {
    runId,
    timestamp: '2026-05-06T00:00:00.000Z',
    decisionType: 'build-verification-failure',
    severity: 'critical',
    context: {
      summary: 'Build failed after 3 attempts',
      defaultAction: 'escalate-without-halt',
    },
    choices: ['escalate-without-halt', 'retry-with-custom-context', 'propose-re-scope', 'abort-run'],
    operatorChoice,
  }

  await writeFile(filePath, JSON.stringify(notification, null, 2))
  return filePath
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Per-test timeout 90s (was 60s) — accommodates the 60s spawnSync timeout on
// substrate report subprocesses with fixture setup/teardown headroom.
describe('interactive-prompt integration', { timeout: 90000 }, () => {
  let tmpDir: string | undefined

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  it.skipIf(!distExists)(
    'E2E (AC10): runInteractivePrompt (non-interactive) writes notification file; substrate report reads Operator Halts section and deletes the file',
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'substrate-prompt-e2e-'))
      const notifDir = join(tmpDir, '.substrate', 'notifications')
      await mkdir(notifDir, { recursive: true })

      // Set up a minimal run manifest so substrate report can resolve the run
      await writeMiniManifest(tmpDir, FIXTURE_RUN_ID)
      await mkdir(join(tmpDir, '.substrate'), { recursive: true })
      await writeFile(join(tmpDir, '.substrate', 'current-run-id'), FIXTURE_RUN_ID)

      // Write an ESM script (.mjs) to invoke runInteractivePrompt.
      // We use a temp .mjs file instead of `node -e` with require() because
      // dist/ is ESM format and require() would throw ERR_REQUIRE_ESM (Issue 2).
      const scriptPath = join(tmpDir, 'run-prompt.mjs')
      const scriptLines = [
        `import { runInteractivePrompt } from ${JSON.stringify(INTERACTIVE_PROMPT_MODULE)};`,
        `import { readdirSync, readFileSync } from 'fs';`,
        `import { join } from 'path';`,
        ``,
        `// resolveMainRepoRoot() falls back to cwd when git fails`,
        `process.chdir(${JSON.stringify(tmpDir)});`,
        ``,
        `const action = await runInteractivePrompt({`,
        `  runId: ${JSON.stringify(FIXTURE_RUN_ID)},`,
        `  decisionType: 'build-verification-failure',`,
        `  severity: 'critical',`,
        `  summary: 'Build failed in integration test',`,
        `  defaultAction: 'escalate-without-halt',`,
        `  choices: ['escalate-without-halt', 'abort-run'],`,
        `  nonInteractive: true,`,
        `});`,
        ``,
        `const notifDir = join(${JSON.stringify(tmpDir)}, '.substrate', 'notifications');`,
        `const files = readdirSync(notifDir);`,
        `const matching = files.filter(f => f.includes(${JSON.stringify(FIXTURE_RUN_ID)}));`,
        `if (matching.length === 0) {`,
        `  console.error('ERROR: no notification file written');`,
        `  process.exit(1);`,
        `}`,
        `const content = JSON.parse(readFileSync(join(notifDir, matching[0]), 'utf8'));`,
        `// operatorChoice must be null in non-interactive mode (AC5)`,
        `if (content.operatorChoice !== null) {`,
        `  console.error('ERROR: operatorChoice should be null in non-interactive mode, got: ' + content.operatorChoice);`,
        `  process.exit(1);`,
        `}`,
        `console.log(JSON.stringify({ found: true, keys: Object.keys(content), runId: content.runId, action }));`,
      ]
      await writeFile(scriptPath, scriptLines.join('\n'))

      // Step 1: Invoke runInteractivePrompt via ESM — should write notification file
      const promptResult = spawnSync('node', [scriptPath], {
        cwd: tmpDir,
        env: {
          ...process.env,
          SUBSTRATE_NON_INTERACTIVE: 'true',
          // Setting GIT_DIR to a non-existent path causes git to fail,
          // so resolveMainRepoRoot() falls back to cwd (= tmpDir)
          GIT_DIR: join(tmpDir, '.git'),
        },
        timeout: 30000,
      })

      const promptStdout = promptResult.stdout?.toString() ?? ''

      // Script must exit 0 and produce valid JSON output
      expect(promptResult.status, spawnDiag('runInteractivePrompt script', promptResult)).toBe(0)
      const jsonLine = promptStdout.split('\n').find((l) => l.trim().startsWith('{'))
      expect(jsonLine, 'Expected JSON output line from ESM script').toBeDefined()

      const parsed = JSON.parse(jsonLine!) as {
        found: boolean
        keys: string[]
        runId: string
        action: string
      }
      expect(parsed.found).toBe(true)
      expect(parsed.keys).toContain('runId')
      expect(parsed.keys).toContain('operatorChoice')
      expect(parsed.keys).toContain('decisionType')
      expect(parsed.runId).toBe(FIXTURE_RUN_ID)
      // Default action applied in non-interactive mode
      expect(parsed.action).toBe('escalate-without-halt')

      // Step 2: Notification file must exist before substrate report runs
      const beforeReport = await readdir(notifDir)
      expect(beforeReport.some((f) => f.includes(FIXTURE_RUN_ID))).toBe(true)

      // Step 3: Run substrate report — should read notification (Operator Halts) and delete it
      // Subprocess timeout is 60s (was 30s) — earlier runs sat at 29671ms borderline,
      // intermittent ETIMEDOUT on heavier systems. Test-level timeout is 60s already
      // (describe block); subprocess timeout matches that.
      const reportResult = spawnSync(
        'node',
        [CLI_MJS, 'report', '--run', FIXTURE_RUN_ID, '--basePath', tmpDir],
        {
          cwd: SUBSTRATE_ROOT,
          env: { ...process.env },
          timeout: 60000,
        },
      )

      const reportStdout = reportResult.stdout?.toString() ?? ''
      // Report must exit 0 and contain Operator Halts section (AC12)
      expect(reportResult.status, spawnDiag('substrate report (E2E)', reportResult)).toBe(0)
      expect(reportStdout, spawnDiag('substrate report (E2E)', reportResult)).toContain('Operator Halts')
      expect(reportStdout).toContain('build-verification-failure')

      // Step 4: Notification file must be deleted after substrate report reads it (AC6)
      let filesAfterReport: string[] = []
      try {
        filesAfterReport = await readdir(notifDir)
      } catch {
        filesAfterReport = [] // directory deleted is also acceptable
      }
      expect(filesAfterReport.some((f) => f.includes(FIXTURE_RUN_ID))).toBe(false)
    },
  )

  it.skipIf(!distExists)(
    'substrate report reads pre-planted notification files (Operator Halts section) and deletes them',
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'substrate-report-notif-'))

      // Set up a minimal run manifest
      await writeMiniManifest(tmpDir, FIXTURE_RUN_ID)

      // Plant a notification file
      await writeNotificationFixture(tmpDir, FIXTURE_RUN_ID, null)

      // Write current-run-id
      await mkdir(join(tmpDir, '.substrate'), { recursive: true })
      await writeFile(join(tmpDir, '.substrate', 'current-run-id'), FIXTURE_RUN_ID)

      // Verify file exists before report
      const before = await readdir(join(tmpDir, '.substrate', 'notifications'))
      expect(before.length).toBe(1)

      // Run substrate report with --basePath pointing to our tmpDir
      // Subprocess timeout 60s — see E2E test comment.
      const result = spawnSync(
        'node',
        [CLI_MJS, 'report', '--run', FIXTURE_RUN_ID, '--basePath', tmpDir],
        {
          cwd: SUBSTRATE_ROOT,
          env: { ...process.env },
          timeout: 60000,
        },
      )

      const stdout = result.stdout?.toString() ?? ''

      // Report must exit 0 and include "Operator Halts" section (AC12)
      expect(result.status, spawnDiag('substrate report (pre-planted notif)', result)).toBe(0)
      expect(stdout, spawnDiag('substrate report (pre-planted notif)', result)).toContain('Operator Halts')
      expect(stdout).toContain('build-verification-failure')

      // Notification file should be deleted after report reads it (AC6)
      let filesAfter: string[] = []
      try {
        filesAfter = await readdir(join(tmpDir, '.substrate', 'notifications'))
      } catch {
        filesAfter = [] // directory deleted is fine too
      }
      const notifStillExists = filesAfter.some((f) =>
        f.includes(FIXTURE_RUN_ID),
      )
      expect(notifStillExists).toBe(false)
    },
  )

  it.skipIf(!distExists)(
    'substrate report handles missing notification directory gracefully',
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'substrate-report-no-notif-'))

      // Set up minimal manifest — NO notification directory
      await writeMiniManifest(tmpDir, FIXTURE_RUN_ID)
      await writeFile(join(tmpDir, '.substrate', 'current-run-id'), FIXTURE_RUN_ID)

      // Use stdio: ['ignore', 'pipe', 'pipe'] to close child's stdin explicitly
      // (matches the canonical CI/CD invocation pattern). The default 'pipe'
      // mode left an open stdin handle that could interact with readline-based
      // code paths in the report command and cause the process to hang.
      //
      // Strip vitest-specific env vars that previously caused the spawned
      // process to hang at 30s — the cause was the inherited test-runtime
      // signal handlers / module loader interactions, not the report command
      // itself (which works correctly in manual invocation with identical args).
      const cleanEnv: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        USER: process.env['USER'] ?? '',
        SHELL: process.env['SHELL'] ?? '',
      }

      const result = spawnSync(
        'node',
        [CLI_MJS, 'report', '--run', FIXTURE_RUN_ID, '--basePath', tmpDir],
        {
          cwd: SUBSTRATE_ROOT,
          env: cleanEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
        },
      )

      const stdout = result.stdout?.toString() ?? ''
      // Report should succeed (exit 0) and NOT contain "Operator Halts" when there are none
      expect(result.status, spawnDiag('substrate report (missing notif dir)', result)).toBe(0)
      // "Operator Halts" section only appears when there ARE halts
      expect(stdout, spawnDiag('substrate report (missing notif dir)', result)).not.toContain('Operator Halts')
    },
  )
})
