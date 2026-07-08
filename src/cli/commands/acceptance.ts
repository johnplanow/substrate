/**
 * `substrate acceptance` command group — Acceptance Gate (program epic A0+).
 *
 * Story A0.1 ships the operator lint:
 *   substrate acceptance validate                      Lint .substrate/acceptance/journeys.yaml (working tree)
 *   substrate acceptance validate --ref HEAD           Lint the COMMITTED registry at a ref (trusted-tree read)
 *   substrate acceptance validate --output-format json JSON output
 *
 * Later stories add: defer (A0.3), override (A6.2), canary (A6.1).
 *
 * Exit codes:
 *   0 - registry present and valid
 *   1 - registry absent, invalid, or unreadable
 */

import type { Command } from 'commander'
import {
  JOURNEY_REGISTRY_PATH,
  loadJourneyRegistryFromFile,
  loadJourneyRegistryFromTrustedTree,
  type JourneyRegistry,
  type RegistryLoadResult,
} from '@substrate-ai/sdlc'
import { buildJsonOutput } from '../utils/formatting.js'

export const ACCEPTANCE_EXIT_SUCCESS = 0
export const ACCEPTANCE_EXIT_ERROR = 1

function summarizeRegistry(registry: JourneyRegistry): string {
  const journeyCount = registry.journeys.length
  const endStateCount = registry.journeys.reduce((n, j) => n + j.end_states.length, 0)
  const criticalCount = registry.journeys.filter((j) => j.criticality === 'critical').length
  return (
    `journey registry v${String(registry.version)}: ` +
    `${String(journeyCount)} journeys (${String(criticalCount)} critical), ` +
    `${String(endStateCount)} end-states`
  )
}

/** Render a load result for humans. Returns the exit code. */
function renderHuman(result: RegistryLoadResult, source: string): number {
  switch (result.status) {
    case 'ok':
      process.stdout.write(`OK — ${summarizeRegistry(result.registry)} (${source})\n`)
      for (const journey of result.registry.journeys) {
        process.stdout.write(
          `  ${journey.id} [${journey.criticality}] ${journey.title} — ` +
            `${String(journey.end_states.length)} end-state(s), surfaces: ${journey.surfaces.join(', ')}\n`,
        )
      }
      return ACCEPTANCE_EXIT_SUCCESS
    case 'absent':
      process.stdout.write(
        `NO REGISTRY — ${JOURNEY_REGISTRY_PATH} not found (${source}).\n` +
          `Author it at planning time; see the acceptance-gate design brief for the schema.\n`,
      )
      return ACCEPTANCE_EXIT_ERROR
    case 'invalid':
      process.stdout.write(`INVALID — ${JOURNEY_REGISTRY_PATH} failed validation (${source}):\n`)
      for (const issue of result.issues) {
        process.stdout.write(`  ${issue.path}: ${issue.message}\n`)
      }
      return ACCEPTANCE_EXIT_ERROR
    case 'error':
      process.stdout.write(`ERROR — could not read the registry (${source}): ${result.message}\n`)
      return ACCEPTANCE_EXIT_ERROR
  }
}

export function registerAcceptanceCommand(program: Command, version: string): void {
  const acceptanceCmd = program
    .command('acceptance')
    .description('Acceptance Gate — journey registry tools (the missing sprint demo)')

  acceptanceCmd
    .command('validate')
    .description(`Lint ${JOURNEY_REGISTRY_PATH} with actionable, pathed errors`)
    .option('--ref <ref>', 'validate the COMMITTED registry at a git ref (trusted-tree read) instead of the working tree')
    .option('--output-format <format>', 'Output format: text (default) or json', 'text')
    .action(async (opts: { ref?: string; outputFormat: string }) => {
      const projectRoot = process.cwd()
      const source = opts.ref !== undefined ? `committed @ ${opts.ref}` : 'working tree'
      const result =
        opts.ref !== undefined
          ? await loadJourneyRegistryFromTrustedTree(projectRoot, opts.ref)
          : await loadJourneyRegistryFromFile(projectRoot)

      if (opts.outputFormat === 'json') {
        const output = buildJsonOutput('substrate acceptance validate', { source, ...result }, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        process.exit(result.status === 'ok' ? ACCEPTANCE_EXIT_SUCCESS : ACCEPTANCE_EXIT_ERROR)
      }

      process.exit(renderHuman(result, source))
    })
}
