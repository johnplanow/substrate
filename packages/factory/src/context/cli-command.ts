/**
 * CLI subcommand registration for pyramid summary management.
 *
 * Registers:
 *   factory context summarize  --run <id> --iteration <n> --level <level>
 *   factory context expand     --run <id> --iteration <n>
 *   factory context stats      --run <id>
 *
 * Story 49-7.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'
import { SummaryCache, CachingSummaryEngine } from './summary-cache.js'
import type { CachedSummaryRecord } from './summary-cache.js'
import { computeCompressionRatio, computeKeyFactRetentionRate } from './summary-metrics.js'
import type { SummaryLevel, Summary } from './summary-types.js'
import type { SummaryEngine } from './summary-engine.js'

// ---------------------------------------------------------------------------
// CLIJsonOutput — machine-readable output envelope
// ---------------------------------------------------------------------------

/** Machine-readable JSON output envelope for `--output-format json` mode. */
export interface CLIJsonOutput<T> {
  timestamp: string
  version: string
  command: string
  data: T
}

/** Build a CLIJsonOutput envelope. */
export function buildJsonOutput<T>(command: string, data: T, version: string): CLIJsonOutput<T> {
  return {
    timestamp: new Date().toISOString(),
    version,
    command,
    data,
  }
}

// ---------------------------------------------------------------------------
// StubSummaryEngine — minimal passthrough used in production CLI
// ---------------------------------------------------------------------------

/** Minimal stub SummaryEngine used when no engineFactory is provided. */
class StubSummaryEngine implements SummaryEngine {
  readonly name = 'stub'

  async summarize(content: string, targetLevel: SummaryLevel): Promise<Summary> {
    const originalHash = createHash('sha256').update(content).digest('hex')
    return {
      level: targetLevel,
      content,
      originalHash,
      createdAt: new Date().toISOString(),
    }
  }

  async expand(summary: Summary): Promise<string> {
    return summary.content
  }
}

// ---------------------------------------------------------------------------
// Iteration-to-hash resolution helper
// ---------------------------------------------------------------------------

interface FoundSummaryRecord {
  hash: string
  record: CachedSummaryRecord
}

/**
 * Scan all `*.json` summary files in summariesDir to find the most recently
 * stored summary matching the given iteration number.
 *
 * Matches on `record.summary.iterationIndex === iteration`.
 * Returns null if no match is found.
 */
async function findSummaryForIteration(
  summariesDir: string,
  iteration: number,
): Promise<FoundSummaryRecord | null> {
  let allFiles: string[]
  try {
    allFiles = await readdir(summariesDir)
  } catch {
    return null
  }

  const jsonFiles = allFiles.filter((f) => f.endsWith('.json'))
  const matches: Array<{ hash: string; record: CachedSummaryRecord; cachedAt: number }> = []

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(summariesDir, file), 'utf-8')
      const record = JSON.parse(raw) as CachedSummaryRecord
      if (record.summary.iterationIndex === iteration) {
        matches.push({
          hash: record.summary.originalHash,
          record,
          cachedAt: new Date(record.cachedAt).getTime(),
        })
      }
    } catch {
      // Skip malformed files
    }
  }

  if (matches.length === 0) return null

  // Return the most recently stored match
  matches.sort((a, b) => b.cachedAt - a.cachedAt)
  const best = matches[0]!
  return { hash: best.hash, record: best.record }
}

// ---------------------------------------------------------------------------
// summarizeAction
// ---------------------------------------------------------------------------

export interface SummarizeActionOpts {
  run: string
  iteration: string
  level: string
  outputFormat: string
}

export interface SummarizeActionDeps {
  storageDir: string
  version: string
  engineFactory?: () => SummaryEngine
}

/**
 * Core logic for `factory context summarize`.
 *
 * Loads the original content, runs it through CachingSummaryEngine, stores the
 * result, and prints compression statistics.
 *
 * @returns Exit code: 0 on success, 1 on error.
 */
export async function summarizeAction(
  opts: SummarizeActionOpts,
  deps: SummarizeActionDeps,
  output: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const { stdout, stderr } = output

  // Validate iteration — must be a non-negative integer (digits only)
  if (!/^\d+$/.test(opts.iteration)) {
    stderr.write(`Error: --iteration must be a non-negative integer, got: ${opts.iteration}\n`)
    return 1
  }
  const iteration = parseInt(opts.iteration, 10)

  // Validate level
  const validLevels: SummaryLevel[] = ['full', 'high', 'medium', 'low']
  if (!validLevels.includes(opts.level as SummaryLevel)) {
    stderr.write(`Error: --level must be one of: full, high, medium, low. Got: ${opts.level}\n`)
    return 1
  }
  const level = opts.level as SummaryLevel

  const summariesDir = join(deps.storageDir, 'runs', opts.run, 'summaries')

  // Check that the summaries directory exists
  try {
    await stat(summariesDir)
  } catch {
    stderr.write(`Error: Run directory not found: ${summariesDir}\n`)
    return 1
  }

  // Resolve iteration → hash by scanning JSON summary files
  const found = await findSummaryForIteration(summariesDir, iteration)
  if (!found) {
    stderr.write(`Error: No summary found for iteration ${iteration} in run ${opts.run}\n`)
    return 1
  }

  // SummaryCache storageDir = parent of {runId} directory
  const cache = new SummaryCache({ runId: opts.run, storageDir: join(deps.storageDir, 'runs') })

  // Load original content (.orig file)
  const originalContent = await cache.getOriginal(found.hash)
  if (originalContent === null) {
    stderr.write(
      `Error: Original content (.orig) not found for hash ${found.hash.slice(0, 8)} in run ${opts.run}\n`,
    )
    return 1
  }

  // Summarize via CachingSummaryEngine (checks cache first, delegates to inner on miss)
  const innerEngine: SummaryEngine = deps.engineFactory
    ? deps.engineFactory()
    : new StubSummaryEngine()
  const engine = new CachingSummaryEngine(innerEngine, cache)
  const summary = await engine.summarize(originalContent, level)

  // Explicitly store result (AC1: "stored via cache.put()")
  await cache.put(summary, originalContent)

  // Compute and emit metrics
  const compressionRatio = computeCompressionRatio(summary)

  if (opts.outputFormat === 'json') {
    const data = {
      hash: summary.originalHash,
      level: summary.level,
      compressionRatio,
      summaryTokenCount: summary.summaryTokenCount,
      originalTokenCount: summary.originalTokenCount,
    }
    stdout.write(
      JSON.stringify(buildJsonOutput('factory context summarize', data, deps.version)) + '\n',
    )
  } else {
    const ratioStr = compressionRatio >= 0 ? compressionRatio.toFixed(2) : 'n/a'
    stdout.write(
      `Summarized iteration ${iteration} → level ${level} | hash: ${summary.originalHash.slice(0, 8)} | compression: ${ratioStr}\n`,
    )
  }

  return 0
}

// ---------------------------------------------------------------------------
// expandAction
// ---------------------------------------------------------------------------

export interface ExpandActionOpts {
  run: string
  iteration: string
  outputFormat: string
}

export interface ExpandActionDeps {
  storageDir: string
  version: string
  engineFactory?: () => SummaryEngine
}

/**
 * Core logic for `factory context expand`.
 *
 * Finds the stored summary for the given iteration, then expands it back
 * toward full content (lossless if .orig exists, LLM fallback otherwise).
 *
 * @returns Exit code: 0 on success, 1 on error.
 */
export async function expandAction(
  opts: ExpandActionOpts,
  deps: ExpandActionDeps,
  output: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const { stdout, stderr } = output

  // Validate iteration
  if (!/^\d+$/.test(opts.iteration)) {
    stderr.write(`Error: --iteration must be a non-negative integer, got: ${opts.iteration}\n`)
    return 1
  }
  const iteration = parseInt(opts.iteration, 10)

  const summariesDir = join(deps.storageDir, 'runs', opts.run, 'summaries')

  // Check that the summaries directory exists
  try {
    await stat(summariesDir)
  } catch {
    stderr.write(`Error: Run directory not found: ${summariesDir}\n`)
    return 1
  }

  // Find summary for iteration
  const found = await findSummaryForIteration(summariesDir, iteration)
  if (!found) {
    stderr.write(`Error: No summary found for iteration ${iteration} in run ${opts.run}\n`)
    return 1
  }

  // Expand via CachingSummaryEngine (uses lossless .orig path when available)
  const cache = new SummaryCache({ runId: opts.run, storageDir: join(deps.storageDir, 'runs') })
  const innerEngine: SummaryEngine = deps.engineFactory
    ? deps.engineFactory()
    : new StubSummaryEngine()
  const engine = new CachingSummaryEngine(innerEngine, cache)
  const expandedContent = await engine.expand(found.record.summary, 'full')

  if (opts.outputFormat === 'json') {
    const data = {
      hash: found.record.summary.originalHash,
      level: found.record.summary.level,
      expandedLength: expandedContent.length,
      content: expandedContent,
    }
    stdout.write(
      JSON.stringify(buildJsonOutput('factory context expand', data, deps.version)) + '\n',
    )
  } else {
    stdout.write(expandedContent + '\n')
  }

  return 0
}

// ---------------------------------------------------------------------------
// statsAction
// ---------------------------------------------------------------------------

export interface StatsRow {
  hash: string
  level: SummaryLevel
  compressionRatio: number
  keyFactRetentionRate: number
  cachedAt: string
}

export interface StatsActionOpts {
  run: string
  outputFormat: string
}

export interface StatsActionDeps {
  storageDir: string
  version: string
}

/**
 * Core logic for `factory context stats`.
 *
 * Reads all stored summary records for a run, computes compression metrics,
 * and prints a formatted table (or JSON array).
 *
 * @returns Exit code: 0 on success, 1 on error.
 */
export async function statsAction(
  opts: StatsActionOpts,
  deps: StatsActionDeps,
  output: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const { stdout, stderr } = output

  const summariesDir = join(deps.storageDir, 'runs', opts.run, 'summaries')

  // Check that the summaries directory exists
  try {
    await stat(summariesDir)
  } catch {
    stderr.write(`Error: Run directory not found: ${summariesDir}\n`)
    return 1
  }

  // Read all .json files
  let allFiles: string[]
  try {
    allFiles = await readdir(summariesDir)
  } catch {
    stderr.write(`Error: Could not read summaries directory: ${summariesDir}\n`)
    return 1
  }

  const jsonFiles = allFiles.filter((f) => f.endsWith('.json'))
  const rows: StatsRow[] = []

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(summariesDir, file), 'utf-8')
      const record = JSON.parse(raw) as CachedSummaryRecord

      const compressionRatio = computeCompressionRatio(record.summary)

      // Compute keyFactRetentionRate if original content is available
      let keyFactRetentionRate = -1
      try {
        const origPath = join(summariesDir, `${record.summary.originalHash}.orig`)
        const originalContent = await readFile(origPath, 'utf-8')
        keyFactRetentionRate = computeKeyFactRetentionRate(originalContent, record.summary.content)
      } catch {
        // Original not available — sentinel value -1
      }

      rows.push({
        hash: record.summary.originalHash,
        level: record.summary.level,
        compressionRatio,
        keyFactRetentionRate,
        cachedAt: record.cachedAt,
      })
    } catch {
      // Skip malformed files
    }
  }

  // Sort by cachedAt ascending
  rows.sort((a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime())

  if (opts.outputFormat === 'json') {
    stdout.write(
      JSON.stringify(buildJsonOutput('factory context stats', rows, deps.version)) + '\n',
    )
    return 0
  }

  // Text table output
  if (rows.length === 0) {
    stdout.write('No summaries found.\n')
    return 0
  }

  const headers = ['Hash', 'Level', 'CompRatio', 'KeyRetention', 'CachedAt']
  const tableRows = rows.map((row) => ({
    Hash: row.hash.slice(0, 8),
    Level: row.level,
    CompRatio: row.compressionRatio >= 0 ? row.compressionRatio.toFixed(4) : 'n/a',
    KeyRetention: row.keyFactRetentionRate >= 0 ? row.keyFactRetentionRate.toFixed(4) : 'n/a',
    CachedAt: row.cachedAt,
  }))

  // Compute column widths from header + data lengths
  const widths = headers.map((h) => {
    const dataMax = tableRows.reduce((max, row) => {
      const val = row[h as keyof typeof row] ?? ''
      return Math.max(max, val.length)
    }, 0)
    return Math.max(h.length, dataMax)
  })

  const headerLine = headers.map((h, i) => h.padEnd(widths[i]!)).join(' | ')
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-')

  stdout.write(headerLine + '\n')
  stdout.write(separator + '\n')

  for (const row of tableRows) {
    const line = headers
      .map((h, i) => (row[h as keyof typeof row] ?? '').padEnd(widths[i]!))
      .join(' | ')
    stdout.write(line + '\n')
  }

  return 0
}

// ---------------------------------------------------------------------------
// registerContextCommand — Commander wiring
// ---------------------------------------------------------------------------

/**
 * Register the `context` subcommand group on the provided factory command.
 *
 * Subcommands registered:
 *   factory context summarize --run <id> --iteration <n> --level <level>
 *   factory context expand    --run <id> --iteration <n>
 *   factory context stats     --run <id>
 *
 * @param factoryCmd    - The factory Commander command to attach to
 * @param version       - CLI version string for JSON output (e.g. "1.2.3")
 * @param storageDir    - Base storage directory (defaults to `{cwd}/.substrate`)
 * @param engineFactory - Optional SummaryEngine factory for testing injection
 */
export function registerContextCommand(
  factoryCmd: Command,
  version: string,
  storageDir?: string,
  engineFactory?: () => SummaryEngine,
): void {
  const resolvedStorageDir = storageDir ?? join(process.cwd(), '.substrate')

  const contextCmd = factoryCmd
    .command('context')
    .description('Inspect and manage pyramid summaries for factory runs')

  // ---- summarize ----
  contextCmd
    .command('summarize')
    .description('Compress and store a run iteration to the target summary level')
    .requiredOption('--run <id>', 'Run ID')
    .requiredOption('--iteration <n>', 'Iteration number')
    .requiredOption('--level <level>', 'Summary level: high | medium | low')
    .option('--output-format <format>', 'Output format: text | json', 'text')
    .action(
      async (opts: { run: string; iteration: string; level: string; outputFormat: string }) => {
        const code = await summarizeAction(opts, {
          storageDir: resolvedStorageDir,
          version,
          ...(engineFactory !== undefined ? { engineFactory } : {}),
        })
        if (code !== 0) process.exit(code)
      },
    )

  // ---- expand ----
  contextCmd
    .command('expand')
    .description('Expand a stored summary for a run iteration back to full content')
    .requiredOption('--run <id>', 'Run ID')
    .requiredOption('--iteration <n>', 'Iteration number')
    .option('--output-format <format>', 'Output format: text | json', 'text')
    .action(async (opts: { run: string; iteration: string; outputFormat: string }) => {
      const code = await expandAction(opts, {
        storageDir: resolvedStorageDir,
        version,
        ...(engineFactory !== undefined ? { engineFactory } : {}),
      })
      if (code !== 0) process.exit(code)
    })

  // ---- stats ----
  contextCmd
    .command('stats')
    .description('Report per-run compression statistics for all stored summaries')
    .requiredOption('--run <id>', 'Run ID')
    .option('--output-format <format>', 'Output format: text | json', 'text')
    .action(async (opts: { run: string; outputFormat: string }) => {
      const code = await statsAction(opts, {
        storageDir: resolvedStorageDir,
        version,
      })
      if (code !== 0) process.exit(code)
    })
}
