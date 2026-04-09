/**
 * Project Profile auto-detection logic.
 *
 * Provides functions to detect the project's language stack and build system
 * by inspecting marker files (go.mod, package.json, turbo.json, etc.) in the
 * project directory. No files are written to disk — detection is in-memory only.
 */

import { execFile as execFileCb } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Language, BuildTool, PackageEntry, ProjectProfile } from './types.js'

function execFileAsync(cmd: string, args: string[], opts: { cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, { ...opts, timeout: 5_000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

// ---------------------------------------------------------------------------
// Stack marker detection table
// ---------------------------------------------------------------------------

interface StackMarker {
  file: string
  language: Language
  buildTool: BuildTool
  buildCommand: string
  testCommand: string
  installCommand: string
}

/**
 * Ordered array of build system markers. Detection checks them in priority
 * order — the first matching marker wins at the single-project level.
 */
const STACK_MARKERS: StackMarker[] = [
  {
    file: 'go.mod',
    language: 'go',
    buildTool: 'go',
    buildCommand: 'go build ./...',
    testCommand: 'go test ./...',
    installCommand: 'go get <package>',
  },
  {
    file: 'build.gradle.kts',
    language: 'kotlin',
    buildTool: 'gradle',
    buildCommand: './gradlew build',
    testCommand: './gradlew test',
    installCommand: 'add dependency to build.gradle.kts',
  },
  {
    file: 'build.gradle',
    language: 'java',
    buildTool: 'gradle',
    buildCommand: './gradlew build',
    testCommand: './gradlew test',
    installCommand: 'add dependency to build.gradle',
  },
  {
    file: 'pom.xml',
    language: 'java',
    buildTool: 'maven',
    buildCommand: 'mvn compile',
    testCommand: 'mvn test',
    installCommand: 'add dependency to pom.xml',
  },
  {
    file: 'Cargo.toml',
    language: 'rust',
    buildTool: 'cargo',
    buildCommand: 'cargo build',
    testCommand: 'cargo test',
    installCommand: 'cargo add <package>',
  },
  {
    file: 'pyproject.toml',
    language: 'python',
    // buildTool resolved at runtime via poetry.lock check
    buildTool: 'pip',
    buildCommand: 'pip install -e .',
    testCommand: 'pytest',
    installCommand: 'pip install <package>',
  },
  {
    file: 'package.json',
    language: 'typescript',
    // buildTool resolved at runtime via lock file check
    buildTool: 'npm',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    installCommand: 'npm install <package>',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Derives the Node.js build tool from lock file markers.
 * Mirrors the existing package manager detection logic (dispatcher-impl.ts).
 */
async function detectNodeBuildTool(dir: string): Promise<{
  buildTool: BuildTool
  buildCommand: string
  testCommand: string
  installCommand: string
}> {
  if (await fileExists(path.join(dir, 'pnpm-lock.yaml'))) {
    return { buildTool: 'pnpm', buildCommand: 'pnpm run build', testCommand: 'pnpm test', installCommand: 'pnpm add <package>' }
  }
  if (await fileExists(path.join(dir, 'yarn.lock'))) {
    return { buildTool: 'yarn', buildCommand: 'yarn build', testCommand: 'yarn test', installCommand: 'yarn add <package>' }
  }
  if (await fileExists(path.join(dir, 'bun.lockb'))) {
    return { buildTool: 'bun', buildCommand: 'bun run build', testCommand: 'bun test', installCommand: 'bun add <package>' }
  }
  return { buildTool: 'npm', buildCommand: 'npm run build', testCommand: 'npm test', installCommand: 'npm install <package>' }
}

// ---------------------------------------------------------------------------
// Task runner overlay detection (just, make, task)
// ---------------------------------------------------------------------------

interface TaskRunnerMarker {
  /** File that indicates this task runner is in use. */
  file: string
  /** Name of the runner binary. */
  runner: string
  /** Command to list available targets/recipes. */
  listCommand: string[]
}

const TASK_RUNNER_MARKERS: TaskRunnerMarker[] = [
  { file: 'justfile', runner: 'just', listCommand: ['just', '--list'] },
  { file: 'Justfile', runner: 'just', listCommand: ['just', '--list'] },
  { file: 'Makefile', runner: 'make', listCommand: [] }, // make targets require parsing
  { file: 'Taskfile.yml', runner: 'task', listCommand: ['task', '--list'] },
]

/** Known build-related target names, in preference order. */
const BUILD_TARGETS = ['build-skip-tests', 'build-no-tests', 'compile', 'build']
/** Known unit-test target names, in preference order. */
const TEST_TARGETS = ['test-unit', 'test-fast', 'test']

/**
 * Detect a task runner (justfile, Makefile, Taskfile.yml) in the given directory
 * and extract build/test command overrides from its available targets.
 *
 * Returns overrides for buildCommand and testCommand, or null if no task runner found.
 */
export async function detectTaskRunner(dir: string): Promise<{
  runner: string
  buildCommand?: string
  testCommand?: string
} | null> {
  for (const marker of TASK_RUNNER_MARKERS) {
    if (!(await fileExists(path.join(dir, marker.file)))) continue

    // For justfile: parse available recipes from the file content
    if (marker.runner === 'just') {
      return detectJustTargets(dir, marker.file)
    }

    // For Makefile: parse targets from file content
    if (marker.runner === 'make') {
      return detectMakeTargets(dir)
    }

    // For Taskfile.yml: just note it exists (basic support)
    return { runner: 'task' }
  }
  return null
}

async function detectJustTargets(dir: string, _filename: string): Promise<{
  runner: string
  buildCommand?: string
  testCommand?: string
}> {
  const result: { runner: string; buildCommand?: string; testCommand?: string } = { runner: 'just' }
  try {
    // Use `just --summary` for reliable recipe listing — outputs space-separated
    // recipe names without formatting, parameters, or descriptions.
    const stdout = await execFileAsync('just', ['--summary'], { cwd: dir })
    const recipes = stdout.trim().split(/\s+/)

    for (const target of BUILD_TARGETS) {
      if (recipes.includes(target)) {
        result.buildCommand = `just ${target}`
        break
      }
    }
    for (const target of TEST_TARGETS) {
      if (recipes.includes(target)) {
        result.testCommand = `just ${target}`
        break
      }
    }
  } catch {
    // just binary not available or failed — fall back to file parsing
    try {
      const content = await fs.readFile(path.join(dir, _filename), 'utf-8')
      // Match recipe declarations: name, optionally followed by params, then ':'
      const recipes = content
        .split('\n')
        .map(line => line.match(/^([a-zA-Z_][\w-]*)(?:\s+[^:]*)?:/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map(m => m[1]!)

      for (const target of BUILD_TARGETS) {
        if (recipes.includes(target)) {
          result.buildCommand = `just ${target}`
          break
        }
      }
      for (const target of TEST_TARGETS) {
        if (recipes.includes(target)) {
          result.testCommand = `just ${target}`
          break
        }
      }
    } catch {
      // Can't read justfile either — report runner with no command overrides
    }
  }
  return result
}

async function detectMakeTargets(dir: string): Promise<{
  runner: string
  buildCommand?: string
  testCommand?: string
}> {
  const result: { runner: string; buildCommand?: string; testCommand?: string } = { runner: 'make' }
  try {
    const content = await fs.readFile(path.join(dir, 'Makefile'), 'utf-8')
    // Extract target names: lines matching "target:" at start of line
    const targets = content
      .split('\n')
      .map(line => line.match(/^([a-zA-Z_][\w-]*):/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1]!)

    for (const target of BUILD_TARGETS) {
      if (targets.includes(target)) {
        result.buildCommand = `make ${target}`
        break
      }
    }
    for (const target of TEST_TARGETS) {
      if (targets.includes(target)) {
        result.testCommand = `make ${target}`
        break
      }
    }
  } catch {
    // Can't read Makefile — still report the runner but no command overrides
  }
  return result
}

// ---------------------------------------------------------------------------
// Single-project detection
// ---------------------------------------------------------------------------

/**
 * Detects the language and build tool for a single project directory.
 *
 * Iterates `STACK_MARKERS` in priority order, calling `fs.access()` for each
 * marker file. Returns the first match, or falls back to TypeScript/npm if no
 * marker file is found.
 *
 * @param dir - Absolute path to the directory to inspect.
 * @returns A `PackageEntry` describing the detected stack.
 */
export async function detectSingleProjectStack(dir: string): Promise<PackageEntry> {
  let baseEntry: PackageEntry | undefined

  for (const marker of STACK_MARKERS) {
    const markerPath = path.join(dir, marker.file)
    if (!(await fileExists(markerPath))) {
      continue
    }

    // package.json: detect build tool from lock files
    if (marker.file === 'package.json') {
      const nodeInfo = await detectNodeBuildTool(dir)
      baseEntry = {
        path: dir,
        language: 'typescript',
        buildTool: nodeInfo.buildTool,
        buildCommand: nodeInfo.buildCommand,
        testCommand: nodeInfo.testCommand,
        installCommand: nodeInfo.installCommand,
      }
      break
    }

    // pyproject.toml: detect poetry vs pip from poetry.lock presence.
    // For pip projects, auto-detect .venv and prepend activation to avoid
    // PEP 668 "externally-managed-environment" errors on modern distros.
    if (marker.file === 'pyproject.toml') {
      const hasPoetry = await fileExists(path.join(dir, 'poetry.lock'))
      if (hasPoetry) {
        baseEntry = {
          path: dir,
          language: 'python',
          buildTool: 'poetry',
          buildCommand: 'poetry build',
          testCommand: 'poetry run pytest',
          installCommand: 'poetry add <package>',
        }
        break
      }
      const hasVenv = await fileExists(path.join(dir, '.venv', 'bin', 'activate'))
      const venvPrefix = hasVenv ? 'source .venv/bin/activate && ' : ''
      baseEntry = {
        path: dir,
        language: 'python',
        buildTool: 'pip',
        buildCommand: `${venvPrefix}pip install -e .`,
        testCommand: `${venvPrefix}pytest`,
        installCommand: `${venvPrefix}pip install <package>`,
      }
      break
    }

    // All other markers: direct mapping
    baseEntry = {
      path: dir,
      language: marker.language,
      buildTool: marker.buildTool,
      buildCommand: marker.buildCommand,
      testCommand: marker.testCommand,
      installCommand: marker.installCommand,
    }
    break
  }

  // Fallback: no marker found — assume TypeScript/npm
  if (!baseEntry) {
    baseEntry = {
      path: dir,
      language: 'typescript',
      buildTool: 'npm',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
      installCommand: 'npm install <package>',
    }
  }

  // Apply task runner overlay (just/make/task) — overrides build/test commands
  // if a task runner file exists with matching targets.
  return applyTaskRunnerOverlay(dir, baseEntry)
}

/**
 * Apply task runner overlay to a detected PackageEntry.
 * If a justfile/Makefile/Taskfile.yml exists with matching targets,
 * override the buildCommand and testCommand with task runner commands.
 */
async function applyTaskRunnerOverlay(dir: string, entry: PackageEntry): Promise<PackageEntry> {
  const runner = await detectTaskRunner(dir)
  if (!runner) return entry
  return {
    ...entry,
    ...(runner.buildCommand && { buildCommand: runner.buildCommand }),
    ...(runner.testCommand && { testCommand: runner.testCommand }),
  }
}

// ---------------------------------------------------------------------------
// Monorepo (Turborepo) detection
// ---------------------------------------------------------------------------

/**
 * Detects if the project root is a Turborepo monorepo.
 *
 * Checks for `turbo.json` at the root, then enumerates package directories
 * under `apps/` and `packages/`, calling `detectSingleProjectStack()` for each.
 *
 * @param rootDir - Absolute path to the project root.
 * @returns A `ProjectProfile` if Turborepo is detected, otherwise `null`.
 */
export async function detectMonorepoProfile(rootDir: string): Promise<ProjectProfile | null> {
  const turboJsonPath = path.join(rootDir, 'turbo.json')

  if (!(await fileExists(turboJsonPath))) {
    return null
  }

  // Enumerate packages under apps/* and packages/*
  const packageDirs: string[] = []

  for (const subdir of ['apps', 'packages']) {
    const fullSubdir = path.join(rootDir, subdir)
    try {
      const entries = await fs.readdir(fullSubdir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          packageDirs.push(path.join(subdir, entry.name))
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  // Detect stack for each package directory
  const packages: PackageEntry[] = []
  for (const relPath of packageDirs) {
    const absPath = path.join(rootDir, relPath)
    const stackEntry = await detectSingleProjectStack(absPath)
    packages.push({
      ...stackEntry,
      path: relPath,
    })
  }

  return {
    project: {
      type: 'monorepo',
      tool: 'turborepo',
      buildCommand: 'npx turbo build',
      testCommand: 'npx turbo test',
      installCommand: 'npm install <package>',
      packages,
    },
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Auto-detects the project profile for the given root directory.
 *
 * First attempts Turborepo monorepo detection. If `turbo.json` is not found,
 * falls back to single-project stack detection.
 *
 * The result is NOT written to disk — detection is purely in-memory.
 *
 * @param rootDir - Absolute path to the project root.
 * @returns A fully populated `ProjectProfile`, or `null` if no recognizable
 *   stack markers are found (enabling callers to implement AC7-style
 *   graceful no-detection behaviour).
 */
export async function detectProjectProfile(rootDir: string): Promise<ProjectProfile | null> {
  // Monorepo takes precedence
  const monorepoProfile = await detectMonorepoProfile(rootDir)
  if (monorepoProfile !== null) {
    return monorepoProfile
  }

  // Single-project: require at least one recognizable stack marker.
  // If none are present, return null so the caller can skip the write step
  // (AC7) rather than silently writing a TypeScript/npm fallback profile.
  let anyMarkerFound = false
  for (const marker of STACK_MARKERS) {
    if (await fileExists(path.join(rootDir, marker.file))) {
      anyMarkerFound = true
      break
    }
  }
  if (!anyMarkerFound) {
    return null
  }

  // Single-project fallback (marker found — detectSingleProjectStack will
  // resolve to the same marker, so no redundant I/O in the happy path).
  const stackEntry = await detectSingleProjectStack(rootDir)
  return {
    project: {
      type: 'single',
      tool: null,
      language: stackEntry.language,
      buildTool: stackEntry.buildTool,
      framework: stackEntry.framework,
      buildCommand: stackEntry.buildCommand ?? 'npm run build',
      testCommand: stackEntry.testCommand ?? 'npm test',
      installCommand: stackEntry.installCommand ?? 'npm install <package>',
      packages: [],
    },
  }
}
