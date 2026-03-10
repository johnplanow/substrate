/**
 * substrate routing — Show routing history and auto-tune log.
 *
 * Story 28-9: CLI Commands, Full-Stack Wiring, and Staleness Detection
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { createStateStore } from '../../modules/state/index.js'
import type { TuneLogEntry } from '../../modules/routing/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cli:routing')

interface RoutingOptions {
  history?: boolean
  outputFormat: string
}

export function registerRoutingCommand(program: Command): void {
  program
    .command('routing')
    .description('Show routing configuration and auto-tune history')
    .option('--history', 'Show the routing auto-tune log (model changes applied)')
    .option('--output-format <format>', 'Output format: text or json', 'text')
    .action(async (options: RoutingOptions) => {
      const dbRoot = await resolveMainRepoRoot(process.cwd())
      const statePath = join(dbRoot, '.substrate', 'state')
      const doltStatePath = join(statePath, '.dolt')
      const storeConfig = existsSync(doltStatePath)
        ? { backend: 'dolt' as const, basePath: statePath }
        : { backend: 'file' as const, basePath: statePath }

      const store = createStateStore(storeConfig)

      try {
        await store.initialize()

        if (options.history === true) {
          logger.debug('routing --history: fetching tune log')
          const raw = await store.getMetric('global', 'routing_tune_log')

          let entries: TuneLogEntry[] = []
          if (Array.isArray(raw)) {
            entries = (raw as TuneLogEntry[]).sort((a, b) =>
              b.appliedAt.localeCompare(a.appliedAt),
            )
          }

          if (options.outputFormat === 'json') {
            console.log(JSON.stringify({ entries }, null, 2))
            return
          }

          if (entries.length === 0) {
            console.log('No routing auto-tune history found.')
            return
          }

          console.log('Routing auto-tune history:')
          for (const entry of entries) {
            console.log(
              `  ${entry.appliedAt}  phase=${entry.phase}  ${entry.oldModel} → ${entry.newModel}  savings=${entry.estimatedSavingsPct.toFixed(1)}%  run=${entry.runId}`,
            )
          }
          return
        }

        // Default: show brief status
        const raw = await store.getMetric('global', 'routing_tune_log')
        const entryCount = Array.isArray(raw) ? raw.length : 0

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify({ tuneLogEntries: entryCount }))
        } else {
          console.log(`Routing auto-tune log: ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`)
          if (entryCount === 0) {
            console.log('No auto-tune changes applied yet. Use --history for details.')
          } else {
            console.log('Run `substrate routing --history` to see full history.')
          }
        }
      } finally {
        await store.close()
      }
    })
}
