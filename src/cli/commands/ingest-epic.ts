/**
 * substrate ingest-epic — Parse an epic planning doc and load it into the
 * Dolt work-graph tables.
 *
 * Story 31-2: Epic Doc Ingestion
 *
 * Usage:
 *   substrate ingest-epic <epic-doc-path>
 *
 * Example:
 *   substrate ingest-epic _bmad-output/planning-artifacts/epic-31-dolt-work-graph.md
 */

import { readFileSync, existsSync } from 'node:fs'

import type { Command } from 'commander'

import { createDatabaseAdapter } from '../../persistence/adapter.js'
import {
  CREATE_STORIES_TABLE,
  CREATE_STORY_DEPENDENCIES_TABLE,
} from '../../modules/work-graph/schema.js'
import { EpicParser } from '../../modules/work-graph/epic-parser.js'
import { EpicIngester } from '../../modules/work-graph/epic-ingester.js'

export function registerIngestEpicCommand(program: Command): void {
  program
    .command('ingest-epic <epic-doc-path>')
    .description('Parse an epic planning doc and upsert story metadata into the work-graph')
    .action(async (epicDocPath: string) => {
      // -----------------------------------------------------------------------
      // 1. Validate the file exists and is readable
      // -----------------------------------------------------------------------
      if (!existsSync(epicDocPath)) {
        process.stderr.write(`Error: File not found: ${epicDocPath}\n`)
        process.exitCode = 1
        return
      }

      let content: string
      try {
        content = readFileSync(epicDocPath, 'utf-8')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: Cannot read file ${epicDocPath}: ${msg}\n`)
        process.exitCode = 1
        return
      }

      // -----------------------------------------------------------------------
      // 2. Parse stories and dependencies
      // -----------------------------------------------------------------------
      const parser = new EpicParser()
      let stories
      let dependencies

      try {
        stories = parser.parseStories(content)
        dependencies = parser.parseDependencies(content)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exitCode = 1
        return
      }

      // -----------------------------------------------------------------------
      // 3. Ingest into database
      // -----------------------------------------------------------------------
      const adapter = createDatabaseAdapter({ backend: 'auto', basePath: process.cwd() })

      try {
        // Ensure the required tables exist before ingesting
        await adapter.exec(CREATE_STORIES_TABLE)
        await adapter.exec(CREATE_STORY_DEPENDENCIES_TABLE)

        const ingester = new EpicIngester(adapter)
        const result = await ingester.ingest(stories, dependencies)

        const epicNum = stories[0]!.epic_num
        process.stdout.write(
          `Ingested ${result.storiesUpserted} stories and ${result.dependenciesReplaced} dependencies from epic ${epicNum}\n`,
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exitCode = 1
      } finally {
        await adapter.close()
      }
    })
}
