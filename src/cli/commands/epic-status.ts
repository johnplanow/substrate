/**
 * substrate epic-status — Display a generated view of all stories in an epic
 * from the Dolt work graph.
 *
 * Story 31-9: substrate epic-status Command
 *
 * Usage:
 *   substrate epic-status <epic>
 *   substrate epic-status <epic> --output-format json
 *
 * Examples:
 *   substrate epic-status 31
 *   substrate epic-status 31 --output-format json
 */

import type { Command } from 'commander'

import { createDatabaseAdapter } from '../../persistence/adapter.js'
import {
  WorkGraphRepository,
} from '../../modules/state/index.js'
import type { BlockedStoryInfo } from '../../modules/state/index.js'
import type { WgStory } from '../../modules/state/index.js'
import {
  CREATE_STORIES_TABLE,
  CREATE_STORY_DEPENDENCIES_TABLE,
} from '../../modules/work-graph/schema.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutputFormat = 'human' | 'json'

export interface EpicStatusOptions {
  outputFormat: OutputFormat
}

// ---------------------------------------------------------------------------
// Natural sort helper
// ---------------------------------------------------------------------------

function sortByStoryKey(stories: WgStory[]): WgStory[] {
  return [...stories].sort((a, b) => {
    const numA = parseInt(a.story_key.split('-')[1] ?? '0', 10)
    const numB = parseInt(b.story_key.split('-')[1] ?? '0', 10)
    return numA - numB
  })
}

// ---------------------------------------------------------------------------
// Badge formatting helpers
// ---------------------------------------------------------------------------

const BADGE_WIDTH = 12 // e.g. '[complete  ]' = 12 chars

const STATUS_LABELS: Record<string, string> = {
  complete: 'complete  ',
  in_progress: 'in_progress',
  ready: 'ready     ',
  planned: 'planned   ',
  escalated: 'escalated ',
  blocked: 'blocked   ',
}

function getBadge(status: string, isBlocked: boolean): string {
  if (isBlocked) return `[${STATUS_LABELS['blocked'] ?? 'blocked   '}]`
  const label = STATUS_LABELS[status] ?? status.padEnd(BADGE_WIDTH - 2)
  return `[${label}]`
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------

export async function runEpicStatusAction(
  epicNum: string,
  opts: EpicStatusOptions,
): Promise<void> {
  const adapter = createDatabaseAdapter({ backend: 'auto', basePath: process.cwd() })

  try {
    // Ensure tables exist (idempotent schema init)
    await adapter.exec(CREATE_STORIES_TABLE)
    await adapter.exec(CREATE_STORY_DEPENDENCIES_TABLE)

    const repo = new WorkGraphRepository(adapter)

    // Fetch stories for this epic
    const rawStories = await repo.listStories({ epic: epicNum })

    if (rawStories.length === 0) {
      process.stderr.write(
        `No stories found for epic ${epicNum} (work graph not populated — run \`substrate ingest-epic\` first)\n`,
      )
      process.exitCode = 1
      return
    }

    const stories = sortByStoryKey(rawStories)

    // Fetch blocked stories and filter to this epic
    const allBlocked = await repo.getBlockedStories()
    const epicBlockedMap = new Map<string, BlockedStoryInfo>(
      allBlocked
        .filter((b) => b.story.epic === epicNum)
        .map((b) => [b.story.story_key, b]),
    )

    // Fetch ready stories and filter to this epic
    const allReady = await repo.getReadyStories()
    const epicReadySet = new Set<string>(
      allReady.filter((s) => s.epic === epicNum).map((s) => s.story_key),
    )

    // Build summary counts
    const summary = {
      total: stories.length,
      complete: stories.filter((s) => s.status === 'complete').length,
      inProgress: stories.filter((s) => s.status === 'in_progress').length,
      escalated: stories.filter((s) => s.status === 'escalated').length,
      blocked: epicBlockedMap.size,
      ready: epicReadySet.size - epicBlockedMap.size,
      planned: stories.filter(
        (s) =>
          (s.status === 'planned' || s.status === 'ready') &&
          !epicBlockedMap.has(s.story_key) &&
          !epicReadySet.has(s.story_key),
      ).length,
    }

    if (opts.outputFormat === 'json') {
      const output = {
        epic: epicNum,
        stories: stories.map((s) => {
          const blockedInfo = epicBlockedMap.get(s.story_key)
          const entry: {
            key: string
            title: string | null
            status: string
            blockers?: Array<{ key: string; title: string; status: string }>
          } = {
            key: s.story_key,
            title: s.title ?? null,
            status: blockedInfo ? 'blocked' : s.status,
          }
          if (blockedInfo) {
            entry.blockers = blockedInfo.blockers.map((b) => ({
              key: b.key,
              title: b.title,
              status: b.status,
            }))
          }
          return entry
        }),
        summary,
      }
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      // Human-readable output
      process.stdout.write(`Epic ${epicNum} — ${stories.length} stories\n\n`)

      for (const story of stories) {
        const isBlocked = epicBlockedMap.has(story.story_key)
        const badge = getBadge(story.status, isBlocked)
        const keyPadded = story.story_key.padEnd(6)
        const displayTitle = story.title ?? story.story_key

        let line = `  ${badge} ${keyPadded}  ${displayTitle}`

        if (isBlocked) {
          const blockedInfo = epicBlockedMap.get(story.story_key)!
          const blockerList = blockedInfo.blockers
            .map((b) => `${b.key} (${b.status})`)
            .join(', ')
          line += `  [waiting on: ${blockerList}]`
        }

        process.stdout.write(line + '\n')
      }

      process.stdout.write('\n')

      process.stdout.write(
        `Epic ${epicNum}: ${summary.complete} complete · ${summary.inProgress} in_progress · ${summary.ready} ready · ${summary.blocked} blocked · ${summary.planned} planned · ${summary.escalated} escalated\n`,
      )
    }
  } finally {
    await adapter.close()
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerEpicStatusCommand(program: Command): void {
  program
    .command('epic-status <epic>')
    .description('Show a generated status view of an epic from the Dolt work graph')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(async (epic: string, options: { outputFormat: string }) => {
      const fmt = options.outputFormat === 'json' ? 'json' : 'human'
      await runEpicStatusAction(epic, { outputFormat: fmt })
    })
}
