/**
 * substrate diff — Show stat-based diff for a story or sprint.
 *
 * Story 26-9: Dolt Diff + History Commands
 * Story 26-12: CLI Degraded-Mode Hints (refactored inline hints → shared utility)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { createStateStore, FileStateStore } from '../../modules/state/index.js'
import type { TableDiff } from '../../modules/state/types.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { emitDegradedModeHint } from '../../utils/degraded-mode-hint.js'

interface DiffOptions {
  sprint?: string
  outputFormat: string
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff [storyKey]')
    .description('Show stat-based diff of database changes for a story or sprint')
    .option('--sprint <sprintId>', 'Diff all stories in the specified sprint')
    .option('--output-format <format>', 'Output format: text or json', 'text')
    .action(async (storyKey: string | undefined, options: DiffOptions) => {
      if (storyKey === undefined && options.sprint === undefined) {
        console.error('Error: provide a story key or --sprint <sprintId>')
        process.exitCode = 1
        return
      }

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
            command: 'diff',
            statePath,
          })

          if (options.outputFormat === 'json') {
            console.log(JSON.stringify({ backend: 'file', hint: result.hint, diff: null }))
          }
          // For text mode the hint has already been written to stderr by
          // emitDegradedModeHint; nothing goes to stdout.
          return
        }

        if (storyKey !== undefined) {
          // Single-story diff
          const diff = await store.diffStory(storyKey)

          if (options.outputFormat === 'json') {
            console.log(JSON.stringify(diff, null, 2))
            return
          }

          console.log(`Diff for story ${storyKey}:`)
          if (diff.tables.length === 0) {
            console.log('  (no changes)')
          } else {
            for (const t of diff.tables) {
              console.log(`  ${t.table}: +${t.added.length} -${t.deleted.length} ~${t.modified.length}`)
            }
          }
        } else {
          // Sprint diff — aggregate across all stories in the sprint
          const stories = await store.queryStories({ sprint: options.sprint! })
          const tableMap = new Map<string, TableDiff>()

          for (const story of stories) {
            const diff = await store.diffStory(story.storyKey)
            for (const t of diff.tables) {
              const existing = tableMap.get(t.table)
              if (existing === undefined) {
                tableMap.set(t.table, { table: t.table, added: [...t.added], deleted: [...t.deleted], modified: [...t.modified] })
              } else {
                existing.added = [...existing.added, ...t.added]
                existing.deleted = [...existing.deleted, ...t.deleted]
                existing.modified = [...existing.modified, ...t.modified]
              }
            }
          }

          const aggregated = Array.from(tableMap.values())

          if (options.outputFormat === 'json') {
            console.log(JSON.stringify({ sprint: options.sprint, tables: aggregated }, null, 2))
            return
          }

          console.log(`Diff for sprint ${options.sprint}:`)
          if (aggregated.length === 0) {
            console.log('  (no changes)')
          } else {
            for (const t of aggregated) {
              console.log(`  ${t.table}: +${t.added.length} -${t.deleted.length} ~${t.modified.length}`)
            }
          }
        }
      } finally {
        await store.close()
      }
    })
}
