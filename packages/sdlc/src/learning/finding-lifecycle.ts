/**
 * FindingLifecycleManager — validation, deduplication, expiry, and retirement
 * for learning loop findings.
 *
 * Story 53-7: Finding Validation, Deduplication, and Expiry
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { createDecision, getDecisionsByCategory, LEARNING_FINDING } from '@substrate-ai/core'
import type { Finding } from './types.js'
import { FindingSchema } from './types.js'

// ---------------------------------------------------------------------------
// SuccessContext
// ---------------------------------------------------------------------------

/** Context supplied when a story completes successfully. */
export interface SuccessContext {
  modifiedFiles: string[]
  runId: string
}

// ---------------------------------------------------------------------------
// FindingLifecycleManager
// ---------------------------------------------------------------------------

export class FindingLifecycleManager {
  /**
   * Validate file existence for a finding's affected_files.
   *
   * - Returns finding unchanged if affected_files is empty or all files exist.
   * - Returns finding with confidence: 'low' if some files are missing.
   * - Returns finding with confidence: 'low' + contradicted_by: 'all-files-deleted'
   *   if ALL files are missing.
   *
   * AC1: pure synchronous function — no I/O beyond fs.existsSync
   */
  static validateFiles(finding: Finding, projectRoot: string): Finding {
    if (finding.affected_files.length === 0) {
      return finding
    }

    const existingCount = finding.affected_files.filter((f) =>
      existsSync(join(projectRoot, f))
    ).length

    if (existingCount === 0) {
      return { ...finding, confidence: 'low', contradicted_by: 'all-files-deleted' }
    }
    if (existingCount < finding.affected_files.length) {
      return { ...finding, confidence: 'low' }
    }
    return finding
  }

  /**
   * Deduplicate findings by fingerprint: `${root_cause}:${affected_files.sort().join(',')}`.
   *
   * For each group of duplicates, only the most recently created finding
   * (highest created_at lexicographically) is retained.
   *
   * AC2: pure synchronous function — no I/O
   */
  static deduplicate(findings: Finding[]): Finding[] {
    const groups = new Map<string, Finding[]>()

    for (const finding of findings) {
      const fingerprint = `${finding.root_cause}:${[...finding.affected_files].sort().join(',')}`
      const group = groups.get(fingerprint)
      if (group === undefined) {
        groups.set(fingerprint, [finding])
      } else {
        group.push(finding)
      }
    }

    const result: Finding[] = []
    for (const group of groups.values()) {
      // Keep the finding with the highest created_at (ISO strings compare correctly lexicographically)
      const best = group.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
      result.push(best)
    }

    return result
  }

  /**
   * Count the number of distinct pipeline runs since this finding was created.
   *
   * Returns 0 on any DB error (non-fatal — never marks as expired on error).
   *
   * AC3: async — interacts with the DB
   */
  static async countRunsSinceCreation(finding: Finding, db: DatabaseAdapter): Promise<number> {
    try {
      const result = await db.query<{ cnt: unknown }>(
        `SELECT COUNT(DISTINCT pipeline_run_id) AS cnt
         FROM decisions
         WHERE created_at > ? AND pipeline_run_id != ?`,
        [finding.created_at, finding.run_id]
      )
      return Number(result[0]?.cnt ?? 0)
    } catch {
      return 0
    }
  }

  /**
   * Check if a finding has expired based on the run count since its creation.
   *
   * AC3: pure synchronous function — no I/O
   */
  static isExpired(finding: Finding, runCount: number): boolean {
    return runCount >= finding.expires_after_runs
  }

  /**
   * Archive a finding by persisting a tombstone record in the decisions table.
   *
   * Non-fatal — any DB error is swallowed silently.
   *
   * AC4: async — interacts with the DB
   */
  static async archiveFinding(
    finding: Finding,
    currentRunId: string,
    db: DatabaseAdapter
  ): Promise<void> {
    try {
      await createDecision(db, {
        category: LEARNING_FINDING,
        key: `${finding.id}:archived`,
        pipeline_run_id: currentRunId,
        phase: 'implementation',
        value: JSON.stringify({ ...finding, contradicted_by: 'expired' }),
      })
    } catch {
      // Non-fatal: swallow DB errors per AC4
    }
  }

  /**
   * Retire findings that are contradicted by a successful story run.
   *
   * Loads all findings from Dolt, checks each for file overlap with the
   * success context, and persists a tombstone for overlapping findings.
   *
   * Entirely non-fatal — DB errors and parse failures are swallowed silently.
   *
   * AC5: async — interacts with the DB
   */
  static async retireContradictedFindings(
    successContext: SuccessContext,
    db: DatabaseAdapter
  ): Promise<void> {
    try {
      const rows = await getDecisionsByCategory(db, LEARNING_FINDING)

      for (const row of rows) {
        try {
          const parsed: unknown = JSON.parse(row.value)
          const result = FindingSchema.safeParse(parsed)
          if (!result.success) continue

          const finding = result.data

          // Only retire findings that have not yet been contradicted/archived
          // AND have at least one file overlapping the success context
          const hasOverlap =
            finding.contradicted_by === undefined &&
            finding.affected_files.some((f) => successContext.modifiedFiles.includes(f))

          if (!hasOverlap) continue

          try {
            await createDecision(db, {
              category: LEARNING_FINDING,
              key: `${finding.id}:archived`,
              pipeline_run_id: successContext.runId,
              phase: 'implementation',
              value: JSON.stringify({ ...finding, contradicted_by: successContext.runId }),
            })
          } catch {
            // Non-fatal: swallow individual write errors per AC5
          }
        } catch {
          // Non-fatal: swallow parse failures per AC5
        }
      }
    } catch {
      // Non-fatal: swallow outer DB/load errors per AC5
    }
  }
}
