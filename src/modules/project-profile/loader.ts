/**
 * Project Profile loader.
 *
 * Loads the project profile from `.substrate/project-profile.yaml` if the
 * override file exists. Falls back to auto-detection via `detectProjectProfile()`
 * if no override file is found.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { ZodError } from 'zod'
import { ProjectProfileSchema } from './schema.js'
import { detectProjectProfile } from './detect.js'
import type { ProjectProfile } from './types.js'

/** Path to the YAML override file, relative to the project root. */
const PROFILE_RELATIVE_PATH = path.join('.substrate', 'project-profile.yaml')

/**
 * Loads the project profile.
 *
 * Resolution order:
 * 1. If `.substrate/project-profile.yaml` exists at `rootDir`:
 *    - Parse the YAML content
 *    - Validate against `ProjectProfileSchema` (Zod)
 *    - Return the validated profile
 *    - Throw if validation fails, with a descriptive message
 * 2. If the file does not exist:
 *    - Call `detectProjectProfile(rootDir)` and return the result
 *    - The detected profile is NOT written to disk
 *
 * @param rootDir - Absolute path to the project root.
 * @returns A validated `ProjectProfile`.
 * @throws If the YAML file exists but fails Zod validation.
 */
export async function loadProjectProfile(rootDir: string): Promise<ProjectProfile> {
  const profilePath = path.join(rootDir, PROFILE_RELATIVE_PATH)

  // Check if override file exists
  let fileFound = false
  try {
    await fs.access(profilePath)
    fileFound = true
  } catch {
    // File not found — fall through to auto-detection
  }

  if (!fileFound) {
    const detected = await detectProjectProfile(rootDir)
    // detectProjectProfile returns null when no recognizable markers are found.
    // Fall back to a minimal TypeScript/npm default so downstream consumers
    // always receive a valid, non-null profile.
    return (
      detected ?? {
        project: {
          type: 'single',
          tool: null,
          language: 'typescript',
          buildTool: 'npm',
          buildCommand: 'npm run build',
          testCommand: 'npm test',
          packages: [],
        },
      }
    )
  }

  // Read and parse the YAML file
  const content = await fs.readFile(profilePath, 'utf-8')
  const raw = yaml.load(content)

  // Validate against schema
  try {
    return ProjectProfileSchema.parse(raw) as ProjectProfile
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid .substrate/project-profile.yaml: ${err.message}`)
    }
    throw err
  }
}
