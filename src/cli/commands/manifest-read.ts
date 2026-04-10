/**
 * Manifest-read helper for CLI commands — Story 52-6.
 *
 * Provides `resolveRunManifest` and `readCurrentRunId` utilities so that
 * status, health, and resume commands can consistently read run state from
 * `.substrate/runs/{run-id}.json` without duplicating resolution logic.
 *
 * Resolution order (AC6):
 *   1. Explicit `runId` argument (if provided)
 *   2. `.substrate/current-run-id` file
 *   3. Returns `{ manifest: null, runId: null }` if neither is available
 *
 * On any manifest read error (file missing, parse failure), returns
 * `{ manifest: null, runId }` and emits a debug-level log (AC4).
 */

import { join } from 'path'
import { readFile } from 'fs/promises'
import { RunManifest } from '@substrate-ai/sdlc'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('manifest-read')

// ---------------------------------------------------------------------------
// readCurrentRunId
// ---------------------------------------------------------------------------

/**
 * Read the active run ID from `.substrate/current-run-id`.
 *
 * Returns the trimmed file content, or `null` if the file is absent or empty.
 * Never throws — all I/O errors are suppressed and return `null`.
 */
export async function readCurrentRunId(dbRoot: string): Promise<string | null> {
  try {
    const content = await readFile(join(dbRoot, '.substrate', 'current-run-id'), 'utf8')
    return content.trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// resolveRunManifest
// ---------------------------------------------------------------------------

/**
 * Resolve the active run manifest for CLI commands.
 *
 * Steps:
 *   1. If `runId` is provided, use it directly.
 *   2. Otherwise, read `.substrate/current-run-id`.
 *   3. If neither yields a run ID → return `{ manifest: null, runId: null }`.
 *   4. Construct `RunManifest(resolvedRunId, runsDir)` and call `.read()` to
 *      validate the file exists and parses correctly.
 *   5. On any error (file missing, schema mismatch) → return `{ manifest: null, runId }`.
 *
 * @param dbRoot - Resolved project root (typically from `resolveMainRepoRoot`)
 * @param runId  - Optional explicit run ID; skips `current-run-id` lookup when provided
 */
export async function resolveRunManifest(
  dbRoot: string,
  runId?: string
): Promise<{ manifest: RunManifest | null; runId: string | null }> {
  const resolvedRunId = runId ?? (await readCurrentRunId(dbRoot))
  if (!resolvedRunId) {
    logger.debug('run manifest not found — falling back to Dolt (no current-run-id)')
    return { manifest: null, runId: null }
  }

  const runsDir = join(dbRoot, '.substrate', 'runs')
  try {
    const manifest = new RunManifest(resolvedRunId, runsDir)
    await manifest.read() // validates file exists and parses correctly
    return { manifest, runId: resolvedRunId }
  } catch {
    logger.debug({ runId: resolvedRunId }, 'run manifest not found — falling back to Dolt')
    return { manifest: null, runId: resolvedRunId }
  }
}
