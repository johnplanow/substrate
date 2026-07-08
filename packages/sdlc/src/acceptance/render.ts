/**
 * Acceptance Gate — render executor (story A1.2).
 *
 * RENDER is step 1 of the acceptance stage: bring the product's user-facing
 * surfaces into existence via the project's declared contract, in the story
 * worktree, with real compose/render paths — no mocks on the render side.
 * This is the boundary every surveyed tool stops at and exactly where the
 * income-sources field failure lived (an email nobody could act on).
 *
 * Posture:
 * - argv execution, no shell (see contract.ts — injection-safe by construction)
 * - env scrubbed of inherited git/process location state (H4.1 mirror; same
 *   accident-mitigation-not-containment caveat)
 * - configurable timeout with process-GROUP kill (the FR-V11 / TestSuiteCheck
 *   pattern — a render that spawns children must not orphan them)
 * - failure carries exit code + stderr tail (H0.4 forensics parity)
 * - RETRY POLICY: never retry a render. A render that differs run-to-run is
 *   itself a finding (`renderSurfaceDeterministic` probes exactly that).
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { buildRenderArgv } from './contract.js'
import type { AcceptanceContract, RenderableSurface } from './contract.js'

/** H4.1 mirror (not exported from core's dispatcher): ambient git/location state. */
const GIT_STATE_ENV_KEYS = [
  'PWD',
  'OLDPWD',
  'INIT_CWD',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
] as const

const DEFAULT_RENDER_TIMEOUT_MS = 120_000
const STDERR_TAIL_CHARS = 4_000

export interface RenderSurfaceOptions {
  surface: RenderableSurface
  contract: AcceptanceContract
  /** Story worktree (cwd for the render command). */
  workingDirectory: string
  /** External artifacts dir — created if missing; `{artifacts}` resolves here. */
  artifactsDir: string
  timeoutMs?: number
}

export interface RenderResult {
  status: 'rendered' | 'failed'
  surface: RenderableSurface
  /** argv actually executed (forensics). */
  argv?: string[]
  exitCode: number | null
  /** Last 4k of stderr on failure (H0.4 parity). */
  stderrTail?: string
  /** Named failure reason when the command never ran (bad contract/placeholder/spawn). */
  error?: string
  artifactsDir: string
  /** Files produced under artifactsDir (relative paths), stdout capture included. */
  artifacts: string[]
  durationMs: number
}

async function listFilesRecursive(root: string, base = root): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(abs, base)))
    else out.push(relative(base, abs))
  }
  return out.sort()
}

/**
 * Render one surface per the contract. Returns a structured result — never
 * throws for render failures (spawn errors, timeouts, non-zero exits all
 * come back as `status: 'failed'` with forensics attached).
 */
export async function renderSurface(opts: RenderSurfaceOptions): Promise<RenderResult> {
  const { surface, contract, workingDirectory, artifactsDir } = opts
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
  const started = Date.now()
  const fail = (partial: Partial<RenderResult>): RenderResult => ({
    status: 'failed',
    surface,
    exitCode: null,
    artifactsDir,
    artifacts: [],
    durationMs: Date.now() - started,
    ...partial,
  })

  const surfaceDef = contract.surfaces[surface]
  if (surfaceDef === undefined) {
    return fail({ error: `contract declares no ${surface} surface` })
  }
  const fixturesAbs =
    contract.fixtures !== undefined ? resolve(workingDirectory, contract.fixtures) : undefined
  const argvResult = buildRenderArgv(surfaceDef.render, {
    ...(fixturesAbs !== undefined ? { fixtures: fixturesAbs } : {}),
    artifacts: artifactsDir,
  })
  if (!argvResult.ok) {
    return fail({ error: argvResult.error })
  }
  const argv = argvResult.argv

  try {
    await mkdir(artifactsDir, { recursive: true })
  } catch (err) {
    return fail({ argv, error: `could not create artifacts dir: ${String(err)}` })
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of GIT_STATE_ENV_KEYS) delete env[key]
  env['GIT_CEILING_DIRECTORIES'] = dirname(workingDirectory)

  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: string; timedOut: boolean }>(
    (resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: workingDirectory,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group so a timeout kill reaps render-spawned children too.
        detached: true,
      })
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      child.on('error', (err: Error) => {
        clearTimeout(timer)
        resolvePromise({ code: null, stdout, stderr, spawnError: err.message, timedOut })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolvePromise({ code, stdout, stderr, timedOut })
      })
    },
  )

  if (outcome.spawnError !== undefined) {
    return fail({ argv, error: `render command could not be spawned: ${outcome.spawnError}` })
  }
  if (outcome.timedOut) {
    return fail({
      argv,
      error: `render timed out after ${String(timeoutMs)}ms (process group killed)`,
      stderrTail: outcome.stderr.slice(-STDERR_TAIL_CHARS),
    })
  }
  if (outcome.code !== 0) {
    return fail({
      argv,
      exitCode: outcome.code,
      stderrTail: outcome.stderr.slice(-STDERR_TAIL_CHARS),
    })
  }

  // Capture stdout as a first-class artifact — for CLI surfaces the stdout
  // IS the user-facing surface.
  if (outcome.stdout.length > 0) {
    try {
      await writeFile(join(artifactsDir, `${surface}-stdout.txt`), outcome.stdout, 'utf-8')
    } catch {
      // best-effort; the walk can still read declared artifact files
    }
  }

  return {
    status: 'rendered',
    surface,
    argv,
    exitCode: 0,
    artifactsDir,
    artifacts: await listFilesRecursive(artifactsDir),
    durationMs: Date.now() - started,
  }
}

// ---------------------------------------------------------------------------
// Determinism probe
// ---------------------------------------------------------------------------

export interface DeterminismResult {
  deterministic: boolean
  /** Artifact paths that differ (or exist in only one render). */
  mismatches: string[]
  first: RenderResult
  second: RenderResult
}

async function hashTree(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>()
  for (const rel of await listFilesRecursive(root)) {
    const content = await readFile(join(root, rel))
    hashes.set(rel, createHash('sha256').update(content).digest('hex'))
  }
  return hashes
}

/**
 * Render the same surface twice into sibling dirs and hash-compare the
 * outputs. A divergent render is a WARN finding
 * (`acceptance-render-nondeterministic`) — a judge grounded in an artifact
 * that changes between runs cannot produce a stable verdict.
 *
 * A5.1 F9 note: deliberately NOT wired into the per-story acceptance stage —
 * doubling every render per story is not justified per-run. This is the A6
 * CANARY primitive (render twice around a reverted wiring commit; the verdict
 * must flip), reserved for that use. Not dead code.
 */
export async function renderSurfaceDeterministic(
  opts: Omit<RenderSurfaceOptions, 'artifactsDir'> & { artifactsBaseDir: string },
): Promise<DeterminismResult> {
  const first = await renderSurface({ ...opts, artifactsDir: join(opts.artifactsBaseDir, 'render-1') })
  const second = await renderSurface({ ...opts, artifactsDir: join(opts.artifactsBaseDir, 'render-2') })
  if (first.status !== 'rendered' || second.status !== 'rendered') {
    return { deterministic: false, mismatches: [], first, second }
  }
  const firstHashes = await hashTree(first.artifactsDir)
  const secondHashes = await hashTree(second.artifactsDir)
  const mismatches: string[] = []
  for (const [rel, hash] of firstHashes) {
    if (secondHashes.get(rel) !== hash) mismatches.push(rel)
  }
  for (const rel of secondHashes.keys()) {
    if (!firstHashes.has(rel)) mismatches.push(rel)
  }
  return { deterministic: mismatches.length === 0, mismatches: mismatches.sort(), first, second }
}
