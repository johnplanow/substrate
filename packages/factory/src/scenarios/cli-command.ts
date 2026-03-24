/**
 * CLI subcommand registration for scenario management.
 *
 * Registers `substrate scenarios run --format <format>` which discovers all
 * scenario files in `.substrate/scenarios/`, executes them, and writes results
 * to stdout.
 *
 * Story 44-5.
 */

import type { Command } from 'commander'
import { ScenarioStore } from './store.js'
import { createScenarioRunner } from './runner.js'

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the `scenarios` subcommand group on the provided Commander program.
 *
 * Subcommands registered:
 *   scenarios run [--format json|text]
 *
 * @param program - The root Commander program to attach the subcommand to.
 */
export function registerScenariosCommand(program: Command): void {
  const scenariosCmd = program
    .command('scenarios')
    .description('Manage and run factory validation scenarios')

  scenariosCmd
    .command('run')
    .description('Run all scenario files in .substrate/scenarios/')
    .option('--format <format>', 'Output format: "json" or "text"', 'text')
    .action(async (opts: { format: string }) => {
      const store = new ScenarioStore()
      const runner = createScenarioRunner()

      const manifest = await store.discover(process.cwd())
      const results = await runner.run(manifest, process.cwd())

      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(results) + '\n')
      } else {
        const { total, passed, failed } = results.summary
        process.stdout.write(`Scenarios: ${passed} passed, ${failed} failed, ${total} total\n`)
        for (const scenario of results.scenarios) {
          const statusMark = scenario.status === 'pass' ? 'PASS' : 'FAIL'
          process.stdout.write(`  [${statusMark}] ${scenario.name} (${scenario.durationMs}ms)\n`)
          if (scenario.status === 'fail' && scenario.stderr) {
            process.stdout.write(`         Error: ${scenario.stderr}\n`)
          }
        }
      }
    })

  scenariosCmd
    .command('list')
    .description('List discovered scenario files with SHA-256 checksums')
    .action(async () => {
      const store = new ScenarioStore()
      const manifest = await store.discover(process.cwd())

      if (manifest.scenarios.length === 0) {
        process.stdout.write('No scenarios found in .substrate/scenarios/\n')
        return
      }

      for (const entry of manifest.scenarios) {
        process.stdout.write(`${entry.name}\t${entry.checksum}\n`)
      }
    })
}
