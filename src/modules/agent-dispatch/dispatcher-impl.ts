/**
 * dispatcher-impl.ts — re-export shim + monolith-only utilities.
 *
 * DispatcherImpl and createDispatcher now live in @substrate-ai/core.
 * This file re-exports those symbols and provides a backward-compatible
 * createDispatcher wrapper that accepts monolith concrete types.
 *
 * Utilities that have NOT yet been extracted to @substrate-ai/core
 * (detectPackageManager, runBuildVerification, checkGitDiffFiles, etc.)
 * remain implemented here until a future migration story.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { DispatcherImpl } from '@substrate-ai/core'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import type { RoutingResolver } from '../../modules/routing/index.js'
import type { DispatchConfig, Dispatcher } from './types.js'
import { DEFAULT_TIMEOUTS } from './types.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('agent-dispatch')

// ---------------------------------------------------------------------------
// Re-export core implementation
// ---------------------------------------------------------------------------

export { DispatcherImpl } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Backward-compatible createDispatcher wrapper
// ---------------------------------------------------------------------------

/**
 * Options for the monolith createDispatcher factory.
 *
 * Accepts concrete monolith types (AdapterRegistry, RoutingResolver) which
 * structurally satisfy the IAdapterRegistry and IRoutingResolver interfaces
 * from @substrate-ai/core.
 */
export interface CreateDispatcherOptions {
  eventBus: TypedEventBus
  adapterRegistry: AdapterRegistry
  config?: Partial<DispatchConfig> & { routingResolver?: RoutingResolver }
}

/**
 * Create a new Dispatcher instance.
 *
 * Backward-compatible factory: accepts the monolith AdapterRegistry and
 * optional RoutingResolver, delegates to DispatcherImpl from @substrate-ai/core.
 *
 * @param options - Required eventBus and adapterRegistry; optional config overrides
 */
export function createDispatcher(options: CreateDispatcherOptions): Dispatcher {
  const config: DispatchConfig = {
    maxConcurrency: options.config?.maxConcurrency ?? 3,
    defaultTimeouts: {
      ...DEFAULT_TIMEOUTS,
      ...(options.config?.defaultTimeouts ?? {}),
    },
    routingResolver: options.config?.routingResolver ?? undefined,
  }

  return new DispatcherImpl(options.eventBus as never, options.adapterRegistry as never, config)
}

// ---------------------------------------------------------------------------
// Build Verification Gate (Story 24-2)
// ---------------------------------------------------------------------------

/** Default command for the build verification gate */
export const DEFAULT_VERIFY_COMMAND = 'npm run build'

// ---------------------------------------------------------------------------
// Package Manager Detection (Story 24-8)
// ---------------------------------------------------------------------------

/** Result returned by detectPackageManager */
export interface PackageManagerDetectionResult {
  /** The detected package manager (or 'none' when no build system is recognized) */
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm' | 'none'
  /** The lockfile/marker that was found, or null when falling back */
  lockfile: string | null
  /** The resolved build command, or empty string to skip verification */
  command: string
}

/**
 * Detect the package manager / build system used in a project.
 *
 * Checks for build system markers in priority order:
 *   0. `.substrate/project-profile.yaml` → `project.buildCommand` field (most explicit, wins)
 *   1. `turbo.json` → `turbo build`
 *   2. Node.js lockfiles → corresponding `<pm> run build`
 *   3. Python markers (pyproject.toml, poetry.lock, setup.py) → skip (no universal build step)
 *   4. Rust (Cargo.toml) → skip
 *   5. Go (go.mod) → skip
 *   6. No markers found → skip (empty command)
 *
 * When a non-Node.js project is detected (or nothing is recognized), the
 * returned command is '' which causes runBuildVerification() to skip.
 */
export function detectPackageManager(projectRoot: string): PackageManagerDetectionResult {
  // Priority 0: read build_command from .substrate/project-profile.yaml (Story 37-3)
  const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
  if (existsSync(profilePath)) {
    try {
      const raw = readFileSync(profilePath, 'utf-8')
      const parsed = yaml.load(raw) as Record<string, unknown> | null
      const buildCommand = (parsed as { project?: { buildCommand?: string } })?.project
        ?.buildCommand
      if (typeof buildCommand === 'string' && buildCommand.length > 0) {
        return { packageManager: 'none', lockfile: 'project-profile.yaml', command: buildCommand }
      }
    } catch {
      // malformed YAML — fall through to auto-detection
    }
  }

  // Priority 1: Turborepo monorepo — detect turbo.json before Node.js lockfiles (Story 37-3)
  if (existsSync(join(projectRoot, 'turbo.json'))) {
    return { packageManager: 'none', lockfile: 'turbo.json', command: 'npx turbo build' }
  }

  // Node.js lockfiles — checked next, return a build command
  const nodeCandidates: Array<{
    file: string
    packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm'
    command: string
  }> = [
    { file: 'pnpm-lock.yaml', packageManager: 'pnpm', command: 'pnpm run build' },
    { file: 'yarn.lock', packageManager: 'yarn', command: 'yarn run build' },
    { file: 'bun.lockb', packageManager: 'bun', command: 'bun run build' },
    { file: 'package-lock.json', packageManager: 'npm', command: 'npm run build' },
  ]

  // Non-Node markers — skip build verification (no universal "build" step)
  const nonNodeMarkers = ['pyproject.toml', 'poetry.lock', 'setup.py', 'Cargo.toml', 'go.mod']

  // Check if a non-Node marker exists. If so, skip even if a package-lock.json
  // also exists (common in projects that use npm for ancillary tooling like bmad).
  for (const marker of nonNodeMarkers) {
    if (existsSync(join(projectRoot, marker))) {
      return { packageManager: 'none', lockfile: marker, command: '' }
    }
  }

  for (const candidate of nodeCandidates) {
    if (existsSync(join(projectRoot, candidate.file))) {
      return {
        packageManager: candidate.packageManager,
        lockfile: candidate.file,
        command: candidate.command,
      }
    }
  }

  // Fallback: no recognized build system — skip verification
  return { packageManager: 'none', lockfile: null, command: '' }
}

/** Default timeout in milliseconds for the build verification gate */
export const DEFAULT_VERIFY_TIMEOUT_MS = 60_000

/** Result returned by runBuildVerification */
export interface BuildVerificationResult {
  /** 'passed' = exit 0; 'failed' = non-zero exit; 'timeout' = exceeded timeout; 'skipped' = gate disabled */
  status: 'passed' | 'failed' | 'skipped' | 'timeout'
  /** Exit code from the process. -1 for timeout, undefined for skipped. */
  exitCode?: number
  /** Combined stdout+stderr output. Empty/undefined for skipped or no output. */
  output?: string
  /** Machine-readable reason for failure/timeout escalation. */
  reason?:
    | 'build-verification-failed'
    | 'build-verification-timeout'
    | 'build-script-not-found'
    | 'pep-668-externally-managed'
}

/**
 * Derive turbo --filter flags from changed file paths.
 *
 * Maps file paths like "apps/web/src/foo.ts" or "packages/db/src/bar.ts"
 * to turbo package filters like "--filter=web" or "--filter=@nextgen/db".
 * Falls back to reading package.json in each directory to get the real
 * package name. Returns empty array if no turbo-scoped packages detected.
 */
export function deriveTurboFilters(changedFiles: string[], projectRoot: string): string[] {
  const packageDirs = new Set<string>()

  for (const file of changedFiles) {
    // Match apps/<name>/... or packages/<name>/...
    const match = file.match(/^((?:apps|packages)\/[^/]+)\//)
    if (match) {
      packageDirs.add(match[1])
    }
  }

  if (packageDirs.size === 0) return []

  const filters: string[] = []
  for (const dir of packageDirs) {
    try {
      const pkgJsonPath = join(projectRoot, dir, 'package.json')
      const raw = readFileSync(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string }
      if (pkg.name) {
        filters.push(`--filter=${pkg.name}`)
      }
    } catch {
      // No package.json (e.g., Go apps) — skip this directory.
      // Turbo can only filter by workspace package names.
    }
  }

  return filters
}

/**
 * Run the build verification gate synchronously.
 *
 * Executes the configured verifyCommand (default: "npm run build") in the
 * project root directory, capturing stdout and stderr. On success (exit 0)
 * returns { status: 'passed' }. On failure or timeout, returns a structured
 * result with status, exitCode, output, and reason.
 *
 * When changedFiles is provided and the command is a turbo build, the build
 * is scoped to only the affected packages via --filter flags. This prevents
 * cascading failures from other concurrent stories' modifications.
 *
 * AC4/5: reads verifyCommand from options (or defaults to 'npm run build').
 * AC6: if verifyCommand is empty string or false, returns { status: 'skipped' }.
 * AC8: timeout is configurable via verifyTimeoutMs (default 60 s).
 */
export function runBuildVerification(options: {
  verifyCommand?: string | false
  verifyTimeoutMs?: number
  projectRoot: string
  changedFiles?: string[]
}): BuildVerificationResult {
  const { verifyCommand, verifyTimeoutMs, projectRoot, changedFiles } = options

  // Resolve the build command:
  // - undefined → auto-detect from lockfile (AC1, AC4, AC5)
  // - string    → use as-is, even if empty (AC2)
  // - false     → skip (AC3)
  let cmd: string | false
  if (verifyCommand === undefined) {
    const detection = detectPackageManager(projectRoot)
    logger.info(
      {
        packageManager: detection.packageManager,
        lockfile: detection.lockfile,
        resolvedCommand: detection.command,
      },
      'Build verification: resolved command via package manager detection'
    )
    cmd = detection.command
  } else {
    cmd = verifyCommand
  }

  // AC6: skip if explicitly disabled (false or empty string)
  if (!cmd) {
    return { status: 'skipped' }
  }

  // Scope turbo builds to only affected packages when changedFiles are available.
  // This prevents cascading build failures from other concurrent stories.
  if (changedFiles && changedFiles.length > 0 && typeof cmd === 'string' && cmd.includes('turbo')) {
    const filters = deriveTurboFilters(changedFiles, projectRoot)
    if (filters.length > 0) {
      cmd = `${cmd} ${filters.join(' ')}`
      logger.info(
        { filters, originalCmd: options.verifyCommand ?? '(auto-detected)' },
        'Build verification: scoped turbo build to affected packages'
      )
    }
  }

  const timeoutMs = verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS

  try {
    // Use bash (not /bin/sh which may be dash) so user-provided commands
    // containing bashisms like `source .venv/bin/activate` work correctly.
    // Prepend node_modules/.bin to PATH so locally-installed tools (turbo, tsc, etc.)
    // are found even when not installed globally. This mirrors how npm/npx scripts work.
    const binPath = join(projectRoot, 'node_modules', '.bin')
    const envPath = `${binPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`

    const stdout = execSync(cmd, {
      cwd: projectRoot,
      timeout: timeoutMs,
      encoding: 'utf-8',
      shell: process.env.SHELL || '/bin/bash',
      env: { ...process.env, PATH: envPath },
    })

    return {
      status: 'passed',
      exitCode: 0,
      output: typeof stdout === 'string' ? stdout : '',
    }
  } catch (err: unknown) {
    if (err != null && typeof err === 'object') {
      const e = err as {
        killed?: boolean
        signal?: string | null
        status?: number | null
        stdout?: unknown
        stderr?: unknown
      }

      const isTimeout = e.killed === true
      const exitCode = typeof e.status === 'number' ? e.status : 1

      const rawStdout = e.stdout
      const rawStderr = e.stderr
      const stdoutStr =
        typeof rawStdout === 'string'
          ? rawStdout
          : Buffer.isBuffer(rawStdout)
            ? rawStdout.toString('utf-8')
            : ''
      const stderrStr =
        typeof rawStderr === 'string'
          ? rawStderr
          : Buffer.isBuffer(rawStderr)
            ? rawStderr.toString('utf-8')
            : ''
      const combinedOutput = [stdoutStr, stderrStr].filter((s) => s.length > 0).join('\n')

      if (isTimeout) {
        return {
          status: 'timeout',
          exitCode: -1,
          output: combinedOutput,
          reason: 'build-verification-timeout',
        }
      }

      // Greenfield detection: if the build script doesn't exist yet
      // (e.g., empty package.json on a new repo), treat as skip rather
      // than failure — the first story is likely the one that creates it.
      const missingScriptPattern = /Missing script[:\s]|No script found|Command "build" not found/i
      if (missingScriptPattern.test(combinedOutput)) {
        logger.warn('Build script not found — skipping pre-flight (greenfield repo)')
        return {
          status: 'skipped',
          exitCode,
          output: combinedOutput,
          reason: 'build-script-not-found',
        }
      }

      // PEP 668 detection: modern Linux distros block system-level pip install
      // with "externally-managed-environment". If the package is a Python project
      // and pip fails with PEP 668, skip rather than abort — the package may
      // already be installed and functional. Users should create a venv.
      const pep668Pattern = /externally-managed-environment|This environment is externally managed/i
      if (pep668Pattern.test(combinedOutput)) {
        logger.warn(
          'PEP 668: pip blocked by externally-managed-environment — skipping pre-flight. Create a .venv to resolve.'
        )
        return {
          status: 'skipped',
          exitCode,
          output: combinedOutput,
          reason: 'pep-668-externally-managed',
        }
      }

      return {
        status: 'failed',
        exitCode,
        output: combinedOutput,
        reason: 'build-verification-failed',
      }
    }

    return {
      status: 'failed',
      exitCode: 1,
      output: String(err),
      reason: 'build-verification-failed',
    }
  }
}

// ---------------------------------------------------------------------------
// Zero-Diff Detection Helper (Story 24-1)
// ---------------------------------------------------------------------------

/**
 * Check git working tree for modified files using `git diff --name-only HEAD`
 * (unstaged + staged changes to tracked files) and `git diff --cached --name-only`
 * (staged new files not yet in HEAD). Returns a deduplicated array of file paths.
 *
 * Returns an empty array when:
 * - No files have been modified or staged
 * - Git commands fail (e.g., not in a git repo, git not installed)
 *
 * Used by the zero-diff detection gate (Story 24-1) to catch phantom completions
 * where a dev-story agent reported COMPLETE but made no actual file changes.
 *
 * @param workingDir - Directory to run git commands in (defaults to process.cwd())
 * @returns Array of changed file paths; empty when nothing changed
 */
export function checkGitDiffFiles(workingDir: string = process.cwd()): string[] {
  const results = new Set<string>()

  // Guard: skip HEAD-based diff on repos with no commits (avoids fatal: bad revision 'HEAD')
  let repoHasCommits = true
  try {
    execSync('git rev-parse --verify HEAD', {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    })
  } catch {
    repoHasCommits = false
  }

  try {
    if (!repoHasCommits) throw new Error('no commits — skip HEAD diff')
    const unstaged = execSync('git diff --name-only HEAD', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    unstaged
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((f) => results.add(f))
  } catch {
    // git not available, not a repo, or diff failed — treat as no changes detected.
  }

  try {
    const staged = execSync('git diff --cached --name-only', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    staged
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((f) => results.add(f))
  } catch {
    // staged diff failed — continue with whatever we have
  }

  // Also capture untracked files (new files created by dev agent that aren't in git yet)
  try {
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: workingDir,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    untracked
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((f) => results.add(f))
  } catch {
    // untracked listing failed — continue with whatever we have
  }

  return Array.from(results)
}
