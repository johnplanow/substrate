/**
 * substrate history — Show Dolt commit history for the state repository.
 *
 * Story 26-9: Dolt Diff + History Commands
 * Story 26-12: CLI Degraded-Mode Hints (refactored inline hints → shared utility)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { createStateStore, FileStateStore } from '../../modules/state/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { emitDegradedModeHint } from '../../utils/degraded-mode-hint.js'

interface HistoryOptions {
  limit: string
  outputFormat: string
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('Show Dolt commit history for the state repository')
    .option('--limit <n>', 'Maximum number of commits to show', '20')
    .option('--output-format <format>', 'Output format: text or json', 'text')
    .action(async (options: HistoryOptions) => {
      const limit = parseInt(options.limit, 10)

      const dbRoot = await resolveMainRepoRoot(process.cwd())
      const statePath = join(dbRoot, '.substrate', 'state')
      const doltStatePath = join(statePath, '.dolt')
      const storeConfig = existsSync(doltStatePath)
        ? { backend: 'dolt' as const, basePath: statePath }
        : { backend: 'file' as const, basePath: statePath }

      const store = createStateStore(storeConfig)
      try {
        await store.initialize()

        // Degrade gracefully when the file backend is active — Dolt-specific
        // features (diff, history) are not available.
        if (store instanceof FileStateStore) {
          const result = await emitDegradedModeHint({
            outputFormat: options.outputFormat,
            command: 'history',
            statePath,
          })

          if (options.outputFormat === 'json') {
            console.log(JSON.stringify({ backend: 'file', hint: result.hint, entries: [] }))
          }
          // For text mode the hint has already been written to stderr by
          // emitDegradedModeHint; nothing goes to stdout.
          return
        }

        const entries = await store.getHistory(limit)

        if (entries.length === 0) {
          console.log('No history available.')
          return
        }

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(entries, null, 2))
          return
        }

        // Text format: <hash>  <timestamp>  <storyKey|->  <message>
        for (const entry of entries) {
          const storyKeyCol = (entry.storyKey ?? '-').padEnd(8)
          console.log(`${entry.hash}  ${entry.timestamp}  ${storyKeyCol}  ${entry.message}`)
        }
      } finally {
        await store.close()
      }
    })
}
