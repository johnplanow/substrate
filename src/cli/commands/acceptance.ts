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
  runCanary,
  demoteGate,
  clearGateDemotion,
  readGateState,
  recordCanary,
  recordOverride,
  readAcceptanceMetrics,
  computePrecision,
  computeRecall,
  type JourneyRegistry,
  type RegistryLoadResult,
  type CanaryVerdict,
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
    case 'ok': {
      process.stdout.write(`OK — ${summarizeRegistry(result.registry)} (${source})\n`)
      for (const journey of result.registry.journeys) {
        process.stdout.write(
          `  ${journey.id} [${journey.criticality}] ${journey.title} — ` +
            `${String(journey.end_states.length)} end-state(s), surfaces: ${journey.surfaces.join(', ')}\n`,
        )
      }
      // RP0.2: provenance surfacing. Absence is ADVISORY — hand-authored
      // registries are legal; provenance is what enables staleness (RP2) and
      // completeness (RP3) checks.
      const prov = result.registry.provenance
      if (prov !== undefined) {
        const excludedNote = prov.excluded !== undefined && prov.excluded.length > 0 ? `, ${String(prov.excluded.length)} excluded` : ''
        process.stdout.write(
          `provenance: OK — derived from ${prov.derived_from} ` +
            `(sha256 ${prov.source_sha256.slice(0, 12)}…), ratified by ${prov.ratified_by} at ${prov.derived_at}${excludedNote}\n`,
        )
      } else {
        process.stdout.write(
          'provenance: ABSENT (advisory) — no provenance: block. Hand-authored registries are legal; ' +
            'a provenance record is what enables staleness and PRD-completeness checks (registry-provenance design brief).\n',
        )
      }
      return ACCEPTANCE_EXIT_SUCCESS
    }
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
          {
            source,
            ...result,
            contract: { status: contract.status },
            // RP0.2: provenance state as a first-class field (advisory when absent).
            provenance: { status: result.status === 'ok' && result.registry.provenance !== undefined ? 'present' : 'absent' },
          },
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
    .description('Dispatch the acceptance judge over a rendered-artifacts directory (ad-hoc; retro-fit + canary surface). Emits JSON on stdout — set LOG_LEVEL=silent to guarantee clean output when shelling in.')
    .requiredOption('--journey <id>', 'journey id from the registry')
    .requiredOption('--artifacts-dir <path>', 'directory of rendered artifacts to judge')
    .option('--registry-file <path>', `registry YAML (default: ${JOURNEY_REGISTRY_PATH} in cwd)`)
    .option('--agent <id>', 'agent adapter id', 'claude-code')
    .option('--pack <name>', 'methodology pack carrying the judge prompt', 'bmad')
    .action(async (opts: { journey: string; artifactsDir: string; registryFile?: string; agent: string; pack: string }) => {
      // This subcommand reserves stdout for the JSON result. Substrate's pino
      // logger writes to stdout; the judge workflow emits warn-level retry/
      // grounding diagnostics that would pollute the JSON. In the bundled CLI
      // the workflow's module-logger is created at startup, so the reliable
      // silence is LOG_LEVEL=silent in the process env BEFORE launch — set it
      // in child env when shelling in (the retro-fit harness + canary/CI
      // consumers do; see the command description). We also raise it here as a
      // best-effort for lazily-created loggers.
      if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'silent'
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

  // A6.1: canary — revert a walked-pass journey's wiring commit(s) in a
  // scratch clone, re-render + re-judge, require the verdict to FLIP. A miss
  // auto-demotes the gate to advisory.
  acceptanceCmd
    .command('canary <journeyId>')
    .description('Self-test the gate: revert a journey\'s wiring commit(s), re-judge, require the verdict to flip. A miss auto-demotes the gate to advisory. Set LOG_LEVEL=silent for clean JSON.')
    .requiredOption('--wiring-commit <sha...>', 'commit SHA(s) that wired the journey (reverted in a scratch clone)')
    .option('--registry-file <path>', `registry YAML (default: ${JOURNEY_REGISTRY_PATH} in cwd)`)
    .option('--agent <id>', 'agent adapter id', 'claude-code')
    .option('--pack <name>', 'methodology pack carrying the judge prompt', 'bmad')
    .action(async (journeyId: string, opts: { wiringCommit: string[]; registryFile?: string; agent: string; pack: string }) => {
      if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'silent'
      if (registry === undefined) {
        process.stdout.write('acceptance canary: adapter registry unavailable in this invocation context\n')
        process.exit(ACCEPTANCE_EXIT_ERROR)
      }
      const projectRoot = process.cwd()
      const registryPath = opts.registryFile !== undefined ? resolve(opts.registryFile) : join(projectRoot, JOURNEY_REGISTRY_PATH)
      let registryContent: string
      try {
        registryContent = await readFile(registryPath, 'utf-8')
      } catch (err) {
        process.stdout.write(`acceptance canary: cannot read registry at ${registryPath}: ${String(err)}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const parsed = parseJourneyRegistry(registryContent)
      if (!parsed.ok) {
        process.stdout.write(`acceptance canary: registry invalid:\n${parsed.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const journey = parsed.registry.journeys.find((j) => j.id === journeyId)
      if (journey === undefined) {
        process.stdout.write(`acceptance canary: journey "${journeyId}" not in registry\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      // The contract comes from the trusted profile (same source the gate uses).
      const contractLoad = await loadAcceptanceContractFromTrustedTree(projectRoot)
      if (contractLoad.status !== 'ok') {
        process.stdout.write(`acceptance canary: no usable acceptance contract (${contractLoad.status}) — cannot render\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }

      // Judge deps (probe-author CLI pattern).
      const { runAcceptanceJudge } = await import('../../modules/compiled-workflows/acceptance-judge.js')
      const eventBus = createEventBus()
      const adapter = new InMemoryDatabaseAdapter()
      const packLoader = createPackLoader()
      let pack
      try {
        pack = await packLoader.load(join(projectRoot, 'packs', opts.pack))
      } catch (err) {
        process.stdout.write(`acceptance canary: failed to load pack '${opts.pack}': ${String(err)}\n`)
        process.exit(ACCEPTANCE_EXIT_ERROR)
        return
      }
      const contextCompiler = createContextCompiler({ db: adapter })
      const noopLogger = { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {} }
      const dispatcher = createDispatcher({ eventBus, adapterRegistry: registry, logger: noopLogger as never })

      const result = await runCanary({
        repoRoot: projectRoot,
        journey,
        contract: contractLoad.contract,
        wiringCommits: opts.wiringCommit,
        judge: async (jrny, artifactsDir, artifacts) => {
          const j = await runAcceptanceJudge(
            { db: adapter, pack, contextCompiler, dispatcher, agentId: opts.agent } as never,
            { journey: jrny, artifactsDir, artifacts },
          )
          return j.result === 'success' && j.verdicts !== undefined
            ? { ok: true, verdicts: j.verdicts.map((v): CanaryVerdict => ({ end_state_id: v.end_state_id, verdict: v.verdict })) }
            : { ok: false, error: j.error ?? 'judge failed' }
        },
      })
      await dispatcher.shutdown()

      // A6.1 AC2: a genuine MISS (ran, not caught) auto-demotes the gate.
      // A6.2: record the canary outcome toward recall (conclusive runs only).
      let demoted = false
      if (result.inconclusive !== true) {
        recordCanary(projectRoot, result.caught)
        if (!result.caught) {
          demoteGate(projectRoot, 'canary-missed', `journey ${journey.id}: ${result.detail}`)
          demoted = true
        }
      }
      const output = buildJsonOutput('substrate acceptance canary', { ...result, gateDemoted: demoted }, version)
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
      // Exit 0 = caught or inconclusive; 1 = MISS (gate is blind, now demoted).
      process.exit(result.caught || result.inconclusive === true ? ACCEPTANCE_EXIT_SUCCESS : ACCEPTANCE_EXIT_ERROR)
    })

  // A6: operator clears an auto-demotion after diagnosing the miss/precision issue.
  acceptanceCmd
    .command('clear-demotion')
    .description('Clear an acceptance-gate auto-demotion (after diagnosing a canary miss or precision-floor breach), restoring blocking authority.')
    .action(() => {
      const projectRoot = process.cwd()
      const state = readGateState(projectRoot)
      if (state === undefined || !state.demoted) {
        process.stdout.write('acceptance gate is not demoted — nothing to clear.\n')
        process.exit(ACCEPTANCE_EXIT_SUCCESS)
      }
      clearGateDemotion(projectRoot)
      process.stdout.write(`cleared gate demotion (was: ${state.reason}${state.detail !== undefined ? ` — ${state.detail}` : ''}, since ${state.since}). Blocking authority restored.\n`)
      process.exit(ACCEPTANCE_EXIT_SUCCESS)
    })

  // A6.2 AC1: operator overrides a FAIL verdict (marks a block a false
  // positive). Re-checks the precision floor and may auto-demote.
  acceptanceCmd
    .command('override <storyKey>')
    .description('Record an operator override of a journey-critical acceptance FAIL (a false positive). Sustained low precision auto-demotes the gate.')
    .requiredOption('--reason <text>', 'why the block was wrong (the operator judgement)')
    .option('--precision-floor <n>', 'precision floor (default 0.8 or acceptance.precision_floor)', parseFloat)
    .action((storyKey: string, opts: { reason: string; precisionFloor?: number }) => {
      const projectRoot = process.cwd()
      const floor = opts.precisionFloor ?? 0.8
      const result = recordOverride(projectRoot, storyKey, opts.reason, floor)
      process.stdout.write(
        `recorded override for ${storyKey} ("${opts.reason}"). ` +
          `verdict precision now ${result.precision.toFixed(2)} (${result.metrics.overrides.length} overrides / ${String(result.metrics.total_fails)} blocks).\n` +
          (result.demoted
            ? `⚠ precision below floor ${floor.toFixed(2)} — gate AUTO-DEMOTED to advisory. Diagnose, then \`substrate acceptance clear-demotion\`.\n`
            : ''),
      )
      process.exit(ACCEPTANCE_EXIT_SUCCESS)
    })

  // A6.2: standing metrics + demotion state.
  acceptanceCmd
    .command('status')
    .description('Show acceptance-gate health: verdict precision, canary recall, and any active auto-demotion.')
    .option('--output-format <format>', 'text (default) or json', 'text')
    .action((opts: { outputFormat: string }) => {
      const projectRoot = process.cwd()
      const m = readAcceptanceMetrics(projectRoot)
      const precision = computePrecision(m)
      const recall = computeRecall(m)
      const demotion = readGateState(projectRoot)
      if (opts.outputFormat === 'json') {
        const output = buildJsonOutput('substrate acceptance status', {
          verdict_precision: precision,
          canary_recall: recall,
          total_fails: m.total_fails,
          overrides: m.overrides.length,
          canaries: { planted: m.canaries_planted, caught: m.canaries_caught },
          demoted: demotion?.demoted ?? false,
          demotion: demotion ?? null,
        }, version)
        process.stdout.write(JSON.stringify(output, null, 2) + '\n')
        process.exit(ACCEPTANCE_EXIT_SUCCESS)
      }
      process.stdout.write(
        `acceptance gate health:\n` +
          `  verdict precision: ${precision.toFixed(2)} (${String(Math.max(0, m.total_fails - m.overrides.length))} confirmed / ${String(m.total_fails)} blocks, ${String(m.overrides.length)} overrides)\n` +
          `  canary recall:     ${recall.toFixed(2)} (${String(m.canaries_caught)} caught / ${String(m.canaries_planted)} planted)\n` +
          `  status:            ${demotion?.demoted === true ? `DEMOTED to advisory — ${demotion.reason} (${demotion.detail ?? ''}), since ${demotion.since}` : 'trusted (blocking authority intact)'}\n`,
      )
      process.exit(ACCEPTANCE_EXIT_SUCCESS)
    })
}
