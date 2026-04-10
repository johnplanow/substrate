/**
 * PackageSnapshot — captures and restores package.json/lockfile state
 * to prevent node_modules cascade failures during concurrent story execution.
 *
 * When multiple stories run concurrently in a monorepo, one story's
 * `npm install <bad-package>` can pollute the shared node_modules for all
 * subsequent stories. This module snapshots package files before dispatching
 * and restores them when build verification detects pollution.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('package-snapshot')

export interface PackageSnapshotData {
  /** Map of absolute file path to file contents */
  files: Map<string, string>
  /** Timestamp when the snapshot was captured */
  capturedAt: string
  /** The install command to run after restore (e.g., "npm install") */
  installCommand: string
}

export interface RestoreResult {
  restored: boolean
  filesRestored: number
  installExitCode?: number
  error?: string
}

/**
 * Discover all package.json paths in a workspace monorepo.
 * Checks the `workspaces` field in root package.json,
 * falls back to scanning apps/ and packages/ directories.
 */
export function discoverPackageJsonPaths(projectRoot: string): string[] {
  const paths: string[] = []
  const rootPkgPath = join(projectRoot, 'package.json')

  if (!existsSync(rootPkgPath)) return paths
  paths.push(rootPkgPath)

  // Add lockfile
  for (const lockfile of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
    const lockPath = join(projectRoot, lockfile)
    if (existsSync(lockPath)) {
      paths.push(lockPath)
      break // only one lockfile
    }
  }

  // Parse workspaces from root package.json
  let workspaceGlobs: string[] = []
  try {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as {
      workspaces?: string[] | { packages?: string[] }
    }
    if (Array.isArray(rootPkg.workspaces)) {
      workspaceGlobs = rootPkg.workspaces
    } else if (rootPkg.workspaces && Array.isArray(rootPkg.workspaces.packages)) {
      workspaceGlobs = rootPkg.workspaces.packages
    }
  } catch {
    // parse error — fall through to convention-based scanning
  }

  // If no workspaces declared, use convention
  if (workspaceGlobs.length === 0) {
    workspaceGlobs = ['apps/*', 'packages/*']
  }

  // Expand simple globs (dir/*) to find package.json files
  for (const glob of workspaceGlobs) {
    const parts = glob.replace(/\/\*\*?$/, '').split('/')
    if (parts.length === 0) continue

    const parentDir = join(projectRoot, parts[0])
    if (!existsSync(parentDir)) continue

    try {
      const entries = readdirSync(parentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const pkgPath = join(parentDir, entry.name, 'package.json')
        if (existsSync(pkgPath)) {
          paths.push(pkgPath)
        }
      }
    } catch {
      // directory not readable — skip
    }
  }

  return paths
}

/**
 * Capture a snapshot of all package.json and lockfile contents into memory.
 */
export function capturePackageSnapshot(options: {
  projectRoot: string
  installCommand?: string
}): PackageSnapshotData {
  const { projectRoot } = options
  const files = new Map<string, string>()
  const paths = discoverPackageJsonPaths(projectRoot)

  for (const filePath of paths) {
    try {
      files.set(filePath, readFileSync(filePath, 'utf-8'))
    } catch {
      // file disappeared between discovery and read — skip
    }
  }

  // Auto-detect install command
  let installCommand = options.installCommand ?? 'npm install'
  if (!options.installCommand) {
    if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) installCommand = 'pnpm install'
    else if (existsSync(join(projectRoot, 'yarn.lock'))) installCommand = 'yarn install'
    else if (existsSync(join(projectRoot, 'bun.lockb'))) installCommand = 'bun install'
  }

  return { files, capturedAt: new Date().toISOString(), installCommand }
}

/**
 * Check if any package files have changed since the snapshot was captured.
 * Returns true if at least one file differs from its snapshot content.
 */
export function detectPackageChanges(snapshot: PackageSnapshotData, projectRoot: string): boolean {
  for (const [filePath, originalContent] of snapshot.files) {
    try {
      const currentContent = readFileSync(filePath, 'utf-8')
      if (currentContent !== originalContent) return true
    } catch {
      // File deleted or unreadable — counts as a change
      return true
    }
  }
  return false
}

/**
 * Restore package files from snapshot and run install to regenerate node_modules.
 */
export function restorePackageSnapshot(
  snapshot: PackageSnapshotData,
  options: { projectRoot: string; timeoutMs?: number }
): RestoreResult {
  const { projectRoot, timeoutMs = 120_000 } = options
  let filesRestored = 0

  try {
    // Write all files back
    for (const [filePath, content] of snapshot.files) {
      try {
        writeFileSync(filePath, content, 'utf-8')
        filesRestored++
      } catch (err) {
        logger.warn({ filePath, err }, 'Failed to restore file from snapshot')
      }
    }

    // Run install to regenerate node_modules
    const installResult = execSync(snapshot.installCommand, {
      cwd: projectRoot,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    logger.info(
      { filesRestored, installCommand: snapshot.installCommand },
      'Package snapshot restored successfully'
    )

    return { restored: true, filesRestored, installExitCode: 0 }
  } catch (err: unknown) {
    const exitCode = (err as { status?: number }).status ?? 1
    logger.warn(
      { filesRestored, exitCode, err },
      'Package snapshot restore failed during npm install'
    )
    return { restored: false, filesRestored, installExitCode: exitCode, error: String(err) }
  }
}
