/**
 * substrate repo-map — Show, update, or query the repo-map symbol index.
 *
 * Story 28-9: CLI Commands, Full-Stack Wiring, and Staleness Detection
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import type { Command } from 'commander'

import { DoltClient } from '../../modules/state/index.js'
import {
  DoltSymbolRepository,
  DoltRepoMapMetaRepository,
  RepoMapQueryEngine,
  RepoMapModule,
  RepoMapStorage,
  GitClient,
  GrammarLoader,
  SymbolParser,
} from '../../modules/repo-map/index.js'
import { RepoMapInjector } from '../../modules/context-compiler/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('cli:repo-map')

interface RepoMapOptions {
  show?: boolean
  update?: boolean
  query?: string
  dryRun?: string
  outputFormat: string
}

/** Validate that a symbol name contains only safe identifier characters. */
function isValidSymbolName(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name)
}

export function registerRepoMapCommand(program: Command): void {
  program
    .command('repo-map')
    .description('Show, update, or query the repo-map symbol index')
    .option('--show', 'Show repo-map staleness status')
    .option('--update', 'Trigger an incremental repo-map update (Dolt backend only)')
    .option('--query <symbol>', 'Query the repo-map for a specific symbol name')
    .option(
      '--dry-run <storyFile>',
      'Preview repo-map context that would be injected for a story file',
    )
    .option('--output-format <format>', 'Output format: text or json', 'text')
    .action(async (options: RepoMapOptions) => {
      // Validate --query symbol name
      if (options.query !== undefined && !isValidSymbolName(options.query)) {
        process.stderr.write(
          `Error: --query value must match /^[a-zA-Z0-9_]+$/ (got: ${options.query})\n`,
        )
        process.exitCode = 1
        return
      }

      const dbRoot = await resolveMainRepoRoot(process.cwd())
      const statePath = join(dbRoot, '.substrate', 'state')
      const doltStatePath = join(statePath, '.dolt')
      const isDolt = existsSync(doltStatePath)

      const notDoltError = (flag: string) => {
        if (options.outputFormat === 'json') {
          console.log(
            JSON.stringify({
              backend: 'file',
              status: 'unavailable',
              hint: 'Repo-map requires the Dolt backend. Run `substrate init --dolt` to enable.',
            }),
          )
        } else {
          process.stderr.write(
            `Error: ${flag} requires the Dolt backend. Run \`substrate init --dolt\` to enable.\n`,
          )
        }
        process.exitCode = 1
      }

      // All sub-commands require Dolt
      if (!isDolt) {
        const flag = options.update ? '--update' : options.query ? '--query' : options.dryRun ? '--dry-run' : '--show'
        notDoltError(flag)
        return
      }

      // Construct Dolt-backed repos
      const doltClient = new DoltClient({ repoPath: statePath })
      const symbolRepo = new DoltSymbolRepository(doltClient, logger)
      const metaRepo = new DoltRepoMapMetaRepository(doltClient)
      const repoMapModule = new RepoMapModule(metaRepo, logger)
      const queryEngine = new RepoMapQueryEngine(symbolRepo, logger)

      // --show: display repo-map summary and staleness
      if (options.show === true || (!options.update && !options.query && !options.dryRun)) {
        const meta = await metaRepo.getMeta()
        const staleResult = await repoMapModule.checkStaleness()

        let staleness: 'current' | 'stale' | 'unknown' = 'unknown'
        if (meta === null) {
          staleness = 'unknown'
        } else if (staleResult !== null) {
          staleness = 'stale'
        } else {
          staleness = 'current'
        }

        const symbolCount = meta !== null
          ? (await symbolRepo.getSymbols()).length
          : 0

        if (options.outputFormat === 'json') {
          console.log(
            JSON.stringify({
              symbolCount,
              commitSha: meta?.commitSha ?? null,
              fileCount: meta?.fileCount ?? 0,
              updatedAt: meta?.updatedAt?.toISOString() ?? null,
              staleness,
            }),
          )
        } else {
          if (meta !== null) {
            console.log(`Repo-map: ${symbolCount} symbols, ${meta.fileCount} files`)
            console.log(`Commit: ${meta.commitSha}`)
            console.log(`Updated: ${meta.updatedAt.toISOString()}`)
            if (staleness === 'stale') {
              console.log('Status: STALE (run `substrate repo-map --update` to refresh)')
            } else {
              console.log('Status: UP TO DATE')
            }
          } else {
            console.log('Repo-map: no data stored yet')
          }
        }
        return
      }

      // --update: trigger incremental update
      if (options.update === true) {
        logger.info('repo-map --update: triggering incremental update')
        const gitClient = new GitClient()
        const grammarLoader = new GrammarLoader()
        const parser = new SymbolParser(grammarLoader)
        const storage = new RepoMapStorage(symbolRepo, metaRepo, gitClient, logger)

        await storage.incrementalUpdate(dbRoot, parser)

        const meta = await metaRepo.getMeta()
        const symbolCount = (await symbolRepo.getSymbols()).length

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify({
            result: 'updated',
            symbolCount,
            fileCount: meta?.fileCount ?? 0,
            commitSha: meta?.commitSha ?? null,
            updatedAt: meta?.updatedAt?.toISOString() ?? null,
          }))
        } else {
          console.log(`Repo-map updated: ${symbolCount} symbols across ${meta?.fileCount ?? 0} files`)
        }
        return
      }

      // --query <symbol>: query symbols by name
      if (options.query !== undefined) {
        logger.debug({ symbol: options.query }, 'repo-map --query')
        const result = await queryEngine.query({ symbols: [options.query], maxTokens: 4000 })

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(result, null, 2))
        } else {
          if (result.symbolCount === 0) {
            console.log(`No symbols found matching '${options.query}'.`)
          } else {
            console.log(`Found ${result.symbolCount} symbol(s) for '${options.query}':`)
            for (const sym of result.symbols) {
              console.log(`  ${sym.filePath}:${sym.lineNumber}  ${sym.symbolType} ${sym.symbolName}`)
            }
          }
        }
        return
      }

      // --dry-run <storyFile>: preview repo-map injection for a story file
      if (options.dryRun !== undefined) {
        let storyContent: string
        try {
          storyContent = await readFile(options.dryRun, 'utf-8')
        } catch {
          process.stderr.write(`Error: Cannot read story file: ${options.dryRun}\n`)
          process.exitCode = 1
          return
        }

        const injector = new RepoMapInjector(queryEngine, logger)
        const injectionResult = await injector.buildContext(storyContent, 2000)

        console.log(
          JSON.stringify({
            text: injectionResult.text,
            symbolCount: injectionResult.symbolCount,
            truncated: injectionResult.truncated,
          }),
        )
        return
      }
    })
}
