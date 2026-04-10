/**
 * substrate migrate — Migrate historical SQLite data into Dolt.
 *
 * Story 26-13: SQLite → Dolt Migration Command
 *
 * Reads story_metrics rows from .substrate/substrate.db (SQLite) and
 * upserts them into the Dolt `metrics` table using ON DUPLICATE KEY UPDATE
 * semantics.  The migration is idempotent and can be re-run safely.
 *
 * Exit codes:
 *   0 — success (or nothing to migrate)
 *   1 — Dolt not installed / not initialized
 *   2 — unexpected error
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import {
  checkDoltInstalled,
  createDoltClient,
  DoltNotInstalled,
} from '../../modules/state/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  dryRun: boolean
  outputFormat: string
  projectRoot: string
}

interface StoryMetricRow {
  story_key: string | null
  result: string | null
  completed_at: string | null
  created_at: string | null
  wall_clock_seconds: number | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  review_cycles: number | null
}

interface SqliteSnapshot {
  storyMetrics: StoryMetricRow[]
}

interface MigrationResult {
  metricsWritten: number
  skipped: number
}

// ---------------------------------------------------------------------------
// SQLite reader
// ---------------------------------------------------------------------------

/**
 * Reads the SQLite snapshot for migration.
 *
 * NOTE (Epic 29): SQLite support has been removed from Substrate.
 *
 * If you need to migrate historical SQLite data, downgrade to a pre-Epic-29
 * version of Substrate (v0.4.x or earlier), run `substrate migrate`, then
 * upgrade. The Dolt database will retain the migrated data across upgrades.
 *
 * This function now always returns an empty snapshot.
 */
export async function readSqliteSnapshot(dbPath: string): Promise<SqliteSnapshot> {
  // Check if a legacy SQLite file exists and warn the user
  const { existsSync: fileExists } = await import('node:fs')
  if (fileExists(dbPath)) {
    process.stderr.write(
      `Warning: Legacy SQLite database found at ${dbPath} but SQLite support has been\n` +
        `removed in Epic 29. To migrate historical data, downgrade to Substrate v0.4.x,\n` +
        `run 'substrate migrate', then upgrade back to this version.\n`
    )
  }
  return { storyMetrics: [] }
}

// ---------------------------------------------------------------------------
// Dolt writer
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100

/**
 * Upsert story_metrics rows into the Dolt `metrics` table.
 * When `dryRun` is `true`, no queries are executed.
 */
export async function migrateDataToDolt(
  client: ReturnType<typeof createDoltClient>,
  rows: StoryMetricRow[],
  dryRun: boolean
): Promise<MigrationResult> {
  let metricsWritten = 0
  let skipped = 0

  // Filter out rows with NULL/empty story_key or NULL recorded_at candidate
  const valid: StoryMetricRow[] = []
  for (const row of rows) {
    if (!row.story_key) {
      skipped++
      continue
    }
    const recordedAt = row.completed_at ?? row.created_at
    if (!recordedAt) {
      skipped++
      continue
    }
    valid.push(row)
  }

  if (dryRun) {
    return { metricsWritten: valid.length, skipped }
  }

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE)

    // Build parameterised multi-row INSERT
    const placeholderRow = '(?,?,?,?,?,?,?,?,?,?,?,?)'
    const placeholders = batch.map(() => placeholderRow).join(', ')

    const sql =
      `INSERT INTO metrics ` +
      `(story_key, task_type, recorded_at, model, tokens_in, tokens_out, ` +
      `cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result) ` +
      `VALUES ${placeholders} ` +
      `ON DUPLICATE KEY UPDATE ` +
      `cost_usd = VALUES(cost_usd), ` +
      `wall_clock_ms = VALUES(wall_clock_ms), ` +
      `result = VALUES(result)`

    const params: unknown[] = []
    for (const row of batch) {
      params.push(
        row.story_key,
        'pipeline-run',
        row.completed_at ?? row.created_at,
        null,
        row.input_tokens ?? 0,
        row.output_tokens ?? 0,
        0,
        row.cost_usd ?? 0,
        Math.round((row.wall_clock_seconds ?? 0) * 1000),
        row.review_cycles ?? 0,
        0,
        row.result
      )
    }

    await client.query(sql, params)
    metricsWritten += batch.length
  }

  return { metricsWritten, skipped }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Migrate historical SQLite data into Dolt')
    .option('--dry-run', 'Show counts without writing any data', false)
    .option('--output-format <format>', 'Output format: text or json', 'text')
    .option('--project-root <path>', 'Project root directory (defaults to cwd)', process.cwd())
    .action(async (options: MigrateOptions) => {
      const projectRoot = await resolveMainRepoRoot(options.projectRoot ?? process.cwd())
      const statePath = join(projectRoot, '.substrate', 'state')
      const doltStatePath = join(statePath, '.dolt')

      const doltNotInitializedMsg = "Dolt not initialized. Run 'substrate init --dolt' first."

      // AC5: Dolt not installed
      try {
        await checkDoltInstalled()
      } catch (err: unknown) {
        if (err instanceof DoltNotInstalled) {
          if (options.outputFormat === 'json') {
            console.log(
              JSON.stringify({ error: 'ERR_DOLT_NOT_INITIALIZED', message: doltNotInitializedMsg })
            )
          } else {
            process.stderr.write(doltNotInitializedMsg + '\n')
          }
          process.exitCode = 1
          return
        }
        process.stderr.write(
          `Unexpected error checking Dolt: ${err instanceof Error ? err.message : String(err)}\n`
        )
        process.exitCode = 2
        return
      }

      // AC5: Dolt not initialized (binary present but repo absent)
      if (!existsSync(doltStatePath)) {
        if (options.outputFormat === 'json') {
          console.log(
            JSON.stringify({ error: 'ERR_DOLT_NOT_INITIALIZED', message: doltNotInitializedMsg })
          )
        } else {
          process.stderr.write(doltNotInitializedMsg + '\n')
        }
        process.exitCode = 1
        return
      }

      // Read SQLite snapshot
      const dbPath = join(projectRoot, '.substrate', 'substrate.db')
      const snapshot = await readSqliteSnapshot(dbPath)

      // AC4: No SQLite database
      if (snapshot.storyMetrics.length === 0) {
        if (options.outputFormat === 'json') {
          console.log(JSON.stringify({ migrated: false, reason: 'no-sqlite-data' }))
        } else {
          console.log('No SQLite data found — nothing to migrate')
        }
        return
      }

      // Connect Dolt client
      const repoPath = statePath
      const client = createDoltClient({ repoPath })
      try {
        await client.connect()

        // AC7: dry-run
        if (options.dryRun) {
          // Count valid rows without writing
          const result = await migrateDataToDolt(client, snapshot.storyMetrics, true)
          if (options.outputFormat === 'json') {
            console.log(
              JSON.stringify({
                migrated: false,
                dryRun: true,
                counts: { metrics: result.metricsWritten },
              })
            )
          } else {
            console.log(
              `Would migrate ${result.metricsWritten} story metrics (dry run — no changes written)`
            )
          }
          return
        }

        // AC1 / AC2: write rows
        const result = await migrateDataToDolt(client, snapshot.storyMetrics, false)

        // AC3: Dolt commit after successful migration
        if (result.metricsWritten > 0) {
          try {
            await client.execArgs(['add', '.'])
            await client.execArgs(['commit', '-m', 'Migrate historical data from SQLite'])
          } catch (execErr: unknown) {
            const msg = execErr instanceof Error ? execErr.message : String(execErr)
            process.stderr.write(`Warning: Dolt commit failed (non-fatal): ${msg}\n`)
          }
        }

        // AC1: warn about skipped rows
        if (result.skipped > 0) {
          process.stderr.write(
            `Warning: Skipped ${result.skipped} row(s) — missing story_key or recorded_at.\n`
          )
        }

        // AC6: progress output
        if (options.outputFormat === 'json') {
          console.log(
            JSON.stringify({
              migrated: true,
              counts: { metrics: result.metricsWritten },
              skipped: result.skipped,
            })
          )
        } else {
          console.log(`Migrated ${result.metricsWritten} story metrics.`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Migration failed: ${msg}\n`)
        process.exitCode = 2
      } finally {
        await client.close()
      }
    })
}
