/**
 * ScenarioStore — discovers scenario files and verifies their integrity via SHA-256 checksums.
 */

import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { glob } from 'glob'
import type { ScenarioEntry, ScenarioManifest, ScenarioStoreVerifyResult } from './types.js'

/** Glob pattern matching valid scenario files */
const SCENARIO_GLOB = 'scenario-*.{sh,py,js,ts}'

/**
 * Computes the SHA-256 hex digest of a Buffer.
 */
function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * ScenarioStore — discovers scenario files in `.substrate/scenarios/` and verifies integrity.
 */
export class ScenarioStore {
  /**
   * Discovers scenario files in `<projectRoot>/.substrate/scenarios/`.
   * Returns an empty manifest if the directory does not exist or contains no matching files.
   *
   * @param projectRoot Defaults to `process.cwd()` when omitted.
   */
  async discover(projectRoot?: string): Promise<ScenarioManifest> {
    const root = projectRoot ?? process.cwd()
    const scenariosDir = join(root, '.substrate', 'scenarios')

    // Check if directory exists — return empty manifest if not
    try {
      const dirStat = await stat(scenariosDir)
      if (!dirStat.isDirectory()) {
        return { scenarios: [], capturedAt: Date.now() }
      }
    } catch {
      return { scenarios: [], capturedAt: Date.now() }
    }

    // Discover matching files
    const absolutePaths = await glob(SCENARIO_GLOB, {
      cwd: scenariosDir,
      absolute: true,
    })

    // Sort alphabetically by filename (basename)
    absolutePaths.sort((a, b) => {
      return basename(a).localeCompare(basename(b))
    })

    // Compute SHA-256 checksum per file
    const scenarios: ScenarioEntry[] = await Promise.all(
      absolutePaths.map(async (filePath) => {
        const name = basename(filePath)
        const content = await readFile(filePath)
        const checksum = sha256(content)
        return { name, path: filePath, checksum }
      }),
    )

    return { scenarios, capturedAt: Date.now() }
  }

  /**
   * Pipeline-facing integrity check. Delegates to `verify()`.
   * Call this before dispatching a scenario validation node to confirm no files were tampered
   * with since manifest capture.
   *
   * @param manifest Previously captured manifest from `discover()`.
   */
  async verifyIntegrity(manifest: ScenarioManifest): Promise<ScenarioStoreVerifyResult> {
    return this.verify(manifest)
  }

  /**
   * Verifies the integrity of scenario files against a previously captured manifest.
   * Files that are missing or have changed checksums are listed in `tampered`.
   *
   * @param manifest Previously captured manifest from `discover()`.
   * @param _projectRoot Accepted for API consistency but unused — `ScenarioEntry.path` is already absolute.
   */
  async verify(
    manifest: ScenarioManifest,
    _projectRoot?: string,
  ): Promise<ScenarioStoreVerifyResult> {
    const tampered: string[] = []

    await Promise.all(
      manifest.scenarios.map(async (entry) => {
        try {
          const content = await readFile(entry.path)
          const currentChecksum = sha256(content)
          if (currentChecksum !== entry.checksum) {
            tampered.push(entry.name)
          }
        } catch {
          // File no longer exists or cannot be read — treat as tampered
          tampered.push(entry.name)
        }
      }),
    )

    return { valid: tampered.length === 0, tampered }
  }
}
