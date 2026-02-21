/**
 * PackLoader — loads and discovers methodology packs.
 *
 * Usage:
 *   const loader = createPackLoader()
 *   const pack = await loader.load('/path/to/packs/bmad')
 *   const packs = await loader.discover('/path/to/project')
 */

import { readFile, readdir, stat, access } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'
import { PackManifestSchema } from './schemas.js'
import { MethodologyPackImpl } from './methodology-pack-impl.js'
import type { MethodologyPack, PackInfo } from './types.js'

// ---------------------------------------------------------------------------
// PackLoader interface
// ---------------------------------------------------------------------------

export interface PackLoader {
  /**
   * Load a methodology pack from the given directory path.
   *
   * @param packPath - absolute path to the pack directory (must contain manifest.yaml)
   * @throws if manifest is missing, invalid, or referenced files are missing
   */
  load(packPath: string): Promise<MethodologyPack>

  /**
   * Discover all available packs under `<projectRoot>/packs/`.
   *
   * @param projectRoot - root directory of the project
   * @returns list of pack info objects; empty if no packs/ directory
   */
  discover(projectRoot: string): Promise<PackInfo[]>
}

// ---------------------------------------------------------------------------
// PackLoaderImpl
// ---------------------------------------------------------------------------

class PackLoaderImpl implements PackLoader {
  async load(packPath: string): Promise<MethodologyPack> {
    const manifestPath = join(packPath, 'manifest.yaml')

    // Read manifest file
    let raw: string
    try {
      raw = await readFile(manifestPath, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Cannot load methodology pack at "${packPath}": manifest.yaml not found or unreadable. ${msg}`
      )
    }

    // Parse YAML
    let parsed: unknown
    try {
      parsed = yaml.load(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Cannot load methodology pack at "${packPath}": manifest.yaml contains invalid YAML. ${msg}`
      )
    }

    // Validate against schema
    const result = PackManifestSchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      throw new Error(
        `Methodology pack manifest at "${manifestPath}" failed validation:\n${issues}`
      )
    }

    const manifest = result.data

    // Verify all referenced files exist
    const allRefs: Array<{ type: string; key: string; relPath: string }> = [
      ...Object.entries(manifest.prompts).map(([k, v]) => ({
        type: 'prompt',
        key: k,
        relPath: v,
      })),
      ...Object.entries(manifest.constraints).map(([k, v]) => ({
        type: 'constraint',
        key: k,
        relPath: v,
      })),
      ...Object.entries(manifest.templates).map(([k, v]) => ({
        type: 'template',
        key: k,
        relPath: v,
      })),
    ]

    const missingFiles: string[] = []
    for (const ref of allRefs) {
      const filePath = join(packPath, ref.relPath)
      const exists = await fileExists(filePath)
      if (!exists) {
        missingFiles.push(`  • ${ref.type} "${ref.key}" → ${ref.relPath} (not found)`)
      }
    }

    if (missingFiles.length > 0) {
      throw new Error(
        `Methodology pack at "${packPath}" references missing files:\n${missingFiles.join('\n')}`
      )
    }

    return new MethodologyPackImpl(manifest, packPath)
  }

  async discover(projectRoot: string): Promise<PackInfo[]> {
    const packsDir = join(projectRoot, 'packs')

    // Graceful degradation: if packs/ doesn't exist, return empty
    const exists = await fileExists(packsDir)
    if (!exists) {
      return []
    }

    let entries: string[]
    try {
      entries = await readdir(packsDir)
    } catch {
      return []
    }

    const packs: PackInfo[] = []
    for (const entry of entries) {
      const entryPath = join(packsDir, entry)
      let isDir = false
      try {
        const s = await stat(entryPath)
        isDir = s.isDirectory()
      } catch {
        continue
      }

      if (!isDir) continue

      // Check if manifest.yaml exists in this subdirectory
      const manifestPath = join(entryPath, 'manifest.yaml')
      if (await fileExists(manifestPath)) {
        packs.push({ name: entry, path: entryPath })
      }
    }

    return packs
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new PackLoader instance.
 */
export function createPackLoader(): PackLoader {
  return new PackLoaderImpl()
}
