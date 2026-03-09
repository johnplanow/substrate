/**
 * substrate history — Show Dolt commit history for the state repository.
 *
 * Story 26-9: Dolt Diff + History Commands
 */
import type { Command } from 'commander'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createStateStore, FileStateStore } from '../../modules/state/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'

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

        const entries = await store.getHistory(limit)

        if (entries.length === 0) {
          if (store instanceof FileStateStore) {
            console.log('Diff/history not available with the file backend. Initialize Dolt with: substrate init --dolt')
          } else {
            console.log('No history available.')
          }
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
