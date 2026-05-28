/**
 * Single source of truth for where substrate looks for epic/story planning docs.
 *
 * Historically discovery was hard-coded to `_bmad-output/...`, so projects that
 * keep their epics elsewhere (e.g. `docs/planning/epics.md`, declared canonical
 * in AGENTS.md) resolved to empty scope. This module:
 *   - extends the default candidate set to include `docs/planning/`, and
 *   - honors an `epics_path` override from `.substrate/config.yaml`.
 *
 * The list-builders are pure (unit-tested); `resolveEpicsPathOverride` does a
 * best-effort config read so the override is honored everywhere the builders are
 * used, without threading config through every discovery call site.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import * as yaml from 'js-yaml'

/** Default planning directories scanned for per-epic/glob files, priority order. */
export const DEFAULT_PLANNING_DIRS = [
  '_bmad-output/planning-artifacts',
  '_bmad-output',
  'docs/planning',
] as const

/** Default consolidated-epics file candidates (relative), priority order. */
export const DEFAULT_EPICS_FILES = [
  '_bmad-output/planning-artifacts/epics.md',
  '_bmad-output/epics.md',
  'docs/planning/epics.md',
] as const

function normalizeOverride(projectRoot: string, override?: string): string | undefined {
  if (override === undefined || override.trim().length === 0) return undefined
  const trimmed = override.trim()
  return isAbsolute(trimmed) ? trimmed : join(projectRoot, trimmed)
}

/**
 * Ordered absolute candidate paths for the consolidated epics file. An override
 * (if any) is highest priority, followed by the built-in defaults.
 */
export function buildEpicsFileCandidates(projectRoot: string, epicsPathOverride?: string): string[] {
  const out: string[] = []
  const abs = normalizeOverride(projectRoot, epicsPathOverride)
  if (abs !== undefined) out.push(abs)
  for (const rel of DEFAULT_EPICS_FILES) out.push(join(projectRoot, rel))
  return out
}

/**
 * Ordered absolute planning directories to scan for per-epic/glob files. When an
 * override file is given, its parent directory is searched first.
 */
export function buildPlanningDirs(projectRoot: string, epicsPathOverride?: string): string[] {
  const out: string[] = []
  const abs = normalizeOverride(projectRoot, epicsPathOverride)
  if (abs !== undefined) out.push(dirname(abs))
  for (const rel of DEFAULT_PLANNING_DIRS) out.push(join(projectRoot, rel))
  return out
}

/**
 * Best-effort read of `epics_path` from `<projectRoot>/.substrate/config.yaml`.
 * Returns undefined on any error (missing file, parse failure, wrong type) so
 * discovery silently falls back to the defaults.
 */
export function resolveEpicsPathOverride(projectRoot: string): string | undefined {
  try {
    const configPath = join(projectRoot, '.substrate', 'config.yaml')
    if (!existsSync(configPath)) return undefined
    const parsed = yaml.load(readFileSync(configPath, 'utf-8')) as { epics_path?: unknown } | null
    const value = parsed?.epics_path
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  } catch {
    return undefined
  }
}
