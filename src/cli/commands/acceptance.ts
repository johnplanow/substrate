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

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname, resolve, relative } from 'node:path'
import type { Command } from 'commander'
import {
  JOURNEY_REGISTRY_PATH,
  JOURNEY_DEFERRALS_PATH,
  ACCEPTANCE_CONTRACT_PROFILE_PATH,
  loadJourneyRegistryFromFile,
  loadJourneyRegistryFromTrustedTree,
  loadAcceptanceContractFromTrustedTree,
  parseAcceptanceContract,
  parseJourneyDeferrals,
  parseJourneyRegistry,
  type JourneyRegistry,
  type RegistryLoadResult,
} from '@substrate-ai/sdlc'
import type { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { createEventBus } from '../../core/event-bus.js'
import { createDispatcher } from '../../modules/agent-dispatch/index.js'
import { createContextCompiler } from '../../modules/context-compiler/index.js'
import { createPackLoader } from '../../modules/methodology-pack/pack-loader.js'
import { InMemoryDatabaseAdapter } from '../../persistence/memory-adapter.js'
import { runAcceptanceJudge } from '../../modules/compiled-workflows/acceptance-judge.js'
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

async function listFilesRecursive(root: string, base = root): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(abs, base)))
    else out.push(relative(base, abs))
  }
  return out.sort()
}

export function registerAcceptanceCommand(program: Command, version: string, registry?: AdapterRegistry): void {
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

      // A1.1: contract status alongside the registry — a registry without a
      // contract means claimed journeys can never be walked
      // (acceptance-unrunnable in blocking mode).
      let contract: Awaited<ReturnType<typeof loadAcceptanceContractFromTrustedTree>>
      if (opts.ref !== undefined) {
        contract = await loadAcceptanceContractFromTrustedTree(projectRoot, opts.ref)
      } else {
        try {
          const profileContent = await readFile(join(projectRoot, ACCEPTANCE_CONTRACT_PROFILE_PATH), 'utf-8')
          contract = parseAcceptanceContract(profileContent)
        } catch {
          contract = { status: 'absent' }
        }
      }

      if (opts.outputFormat === 'json') {
        const output = buildJsonOutput(
          'substrate acceptance validate',
          { source, ...result, contract: { status: contract.status } },
          version,
        )
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        process.exit(result.status === 'ok' ? ACCEPTANCE_EXIT_SUCCESS : ACCEPTANCE_EXIT_ERROR)
      }

      const exitCode = renderHuman(result, source)
      if (contract.status === 'ok') {
        const surfaces = Object.keys(contract.contract.surfaces).join(', ')
        process.stdout.write(`contract: OK — surfaces declared: ${surfaces}\n`)
      } else if (contract.status === 'invalid') {
        process.stdout.write(`contract: INVALID (${ACCEPTANCE_CONTRACT_PROFILE_PATH} acceptance: block):\n`)
        for (const issue of contract.issues) process.stdout.write(`  ${issue.path}: ${issue.message}\n`)
      } else if (contract.status === 'absent') {
        process.stdout.write(
          `contract: ABSENT — no acceptance: block in ${ACCEPTANCE_CONTRACT_PROFILE_PATH}. ` +
            'Claimed journeys can never be walked (acceptance-unrunnable in blocking mode).\n',
        )
      }
      process.exit(exitCode)
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

  // A3.2 (retro-fit) / A6.1 (canaries): ad-hoc judge over an artifacts dir.
  // Dispatches the REAL separate-lineage judge against already-rendered
  // artifacts — no pipeline, no render step. Verdicts print as JSON.
  acceptanceCmd
    .command('judge')
    .description('Dispatch the acceptance judge over a rendered-artifacts directory (ad-hoc; retro-fit + canary surface)')
    .requiredOption('--journey <id>', 'journey id from the registry')
    .requiredOption('--artifacts-dir <path>', 'directory of rendered artifacts to judge')
    .option('--registry-file <path>', `registry YAML (default: ${JOURNEY_REGISTRY_PATH} in cwd)`)
    .option('--agent <id>', 'agent adapter id', 'claude-code')
    .option('--pack <name>', 'methodology pack carrying the judge prompt', 'bmad')
    .action(async (opts: { journey: string; artifactsDir: string; registryFile?: string; agent: string; pack: string }) => {
      if (registry === undefined) {
        process.stdout.write('acceptance judge: adapter registry unavailable in this invocation context\n')
        process.exit(ACCEPTANCE_EXIT_ERROR)
      }
      const registryPath = opts.registryFile !== undefined ? resolve(opts.registryFile) : join(process.cwd(), JOURNEY_REGISTRY_PATH)
      let registryContent: string
      try {
        registryContent = await readFile(registryPath, 'utf-8')
      } catch (err) {
        process.stdout.write(`acceptance judge: cannot read registry at ${registryPath}: ${String(err)}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const parsed = parseJourneyRegistry(registryContent)
      if (!parsed.ok) {
        process.stdout.write(`acceptance judge: registry invalid:\n${parsed.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const journey = parsed.registry.journeys.find((j) => j.id === opts.journey)
      if (journey === undefined) {
        process.stdout.write(`acceptance judge: journey "${opts.journey}" not in registry (known: ${parsed.registry.journeys.map((j) => j.id).join(', ')})\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const artifactsDir = resolve(opts.artifactsDir)
      const artifacts = await listFilesRecursive(artifactsDir)
      if (artifacts.length === 0) {
        process.stdout.write(`acceptance judge: no artifacts under ${artifactsDir}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }

      // Minimum-viable WorkflowDeps (the probe-author CLI pattern).
      const eventBus = createEventBus()
      const adapter = new InMemoryDatabaseAdapter()
      const packLoader = createPackLoader()
      let pack
      try {
        pack = await packLoader.load(join(process.cwd(), 'packs', opts.pack))
      } catch (err) {
        process.stdout.write(`acceptance judge: failed to load pack '${opts.pack}' from ${join(process.cwd(), 'packs', opts.pack)}: ${String(err)}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const contextCompiler = createContextCompiler({ db: adapter })
      const stderrLogger = {
        debug: (): void => {},
        info: (...args: unknown[]): void => { process.stderr.write(`[acceptance-judge] ${JSON.stringify(args[0] ?? '')}\n`) },
        warn: (...args: unknown[]): void => { process.stderr.write(`[acceptance-judge][warn] ${JSON.stringify(args[0] ?? '')}\n`) },
        error: (...args: unknown[]): void => { process.stderr.write(`[acceptance-judge][error] ${JSON.stringify(args[0] ?? '')}\n`) },
      }
      const dispatcher = createDispatcher({ eventBus, adapterRegistry: registry, logger: stderrLogger as never })

      const result = await runAcceptanceJudge(
        { db: adapter, pack, contextCompiler, dispatcher, agentId: opts.agent } as never,
        { journey, artifactsDir, artifacts },
      )
      await dispatcher.shutdown()

      const output = buildJsonOutput('substrate acceptance judge', {
        journey: journey.id,
        artifactsDir,
        artifacts,
        ...result,
      }, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      process.exit(result.result === 'success' ? ACCEPTANCE_EXIT_SUCCESS : ACCEPTANCE_EXIT_ERROR)
    })
}
