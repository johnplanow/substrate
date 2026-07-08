/**
 * `substrate acceptance` command group — Acceptance Gate (program epic A0+).
 *
 * A0.1 — operator lint:
 *   substrate acceptance validate                      Lint .substrate/acceptance/journeys.yaml (working tree)
 *   substrate acceptance validate --ref HEAD           Lint the COMMITTED registry at a ref (trusted-tree read)
 *   substrate acceptance validate --output-format json JSON output
 *
 * A0.3 — operator deferral (records the ack the coverage audit honors):
 *   substrate acceptance defer UJ-3 --reason "post-MVP scope cut"
 *
 * Later stories add: override (A6.2), canary (A6.1).
 *
 * Exit codes:
 *   0 - success
 *   1 - registry absent/invalid/unreadable, unknown journey id, or write failure
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { Command } from 'commander'
import {
  JOURNEY_REGISTRY_PATH,
  JOURNEY_DEFERRALS_PATH,
  loadJourneyRegistryFromFile,
  loadJourneyRegistryFromTrustedTree,
  parseJourneyDeferrals,
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

  acceptanceCmd
    .command('defer <journeyId>')
    .description(
      'Record an operator deferral for a journey — the coverage audit reports it `deferred` instead of unclaimed/unwalked. Writes to the working tree; COMMIT the file for the audit (trusted tree) to honor it.',
    )
    .requiredOption('--reason <text>', 'why this journey is deferred (the operator ack is the point)')
    .action(async (journeyId: string, opts: { reason: string }) => {
      const projectRoot = process.cwd()

      // The deferral must reference a real journey — typo-deferrals silently
      // covering nothing are the same silent-skip class this gate exists to kill.
      const registry = await loadJourneyRegistryFromFile(projectRoot)
      if (registry.status !== 'ok') {
        process.stdout.write(
          `cannot defer: journey registry is ${registry.status} at ${JOURNEY_REGISTRY_PATH} — fix it first (substrate acceptance validate)\n`,
        )
        process.exit(ACCEPTANCE_EXIT_ERROR)
      }
      if (!registry.registry.journeys.some((j) => j.id === journeyId)) {
        process.stdout.write(
          `cannot defer: journey "${journeyId}" is not in the registry. Known ids: ${registry.registry.journeys.map((j) => j.id).join(', ')}\n`,
        )
        process.exit(ACCEPTANCE_EXIT_ERROR)
      }

      const deferralsPath = join(projectRoot, JOURNEY_DEFERRALS_PATH)
      let existingContent = ''
      try {
        existingContent = await readFile(deferralsPath, 'utf-8')
      } catch {
        // absent file = first deferral
      }
      const existing = parseJourneyDeferrals(existingContent)
      if (!existing.ok) {
        process.stdout.write(`cannot defer: ${JOURNEY_DEFERRALS_PATH} is invalid:\n`)
        for (const issue of existing.issues) process.stdout.write(`  ${issue.path}: ${issue.message}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
      }
      if (existing.deferrals.some((d) => d.journey === journeyId)) {
        process.stdout.write(`journey ${journeyId} is already deferred — no change\n`)
        process.exit(ACCEPTANCE_EXIT_SUCCESS)
      }

      const deferrals = [
        ...existing.deferrals,
        { journey: journeyId, reason: opts.reason, deferred_at: new Date().toISOString() },
      ]
      const rendered =
        'deferrals:\n' +
        deferrals
          .map(
            (d) =>
              `  - journey: ${d.journey}\n    reason: ${JSON.stringify(d.reason)}\n` +
              (d.deferred_at !== undefined ? `    deferred_at: ${JSON.stringify(d.deferred_at)}\n` : ''),
          )
          .join('')
      try {
        await mkdir(dirname(deferralsPath), { recursive: true })
        await writeFile(deferralsPath, rendered, 'utf-8')
      } catch (err) {
        process.stdout.write(`failed to write ${JOURNEY_DEFERRALS_PATH}: ${String(err)}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
      }
      process.stdout.write(
        `deferred ${journeyId} ("${opts.reason}") → ${JOURNEY_DEFERRALS_PATH}\n` +
          'COMMIT this file — the coverage audit reads the trusted (committed) tree.\n',
      )
      process.exit(ACCEPTANCE_EXIT_SUCCESS)
    })
}
