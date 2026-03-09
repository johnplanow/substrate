/**
 * substrate contracts — Show contract declarations and verification status.
 */
import type { Command } from 'commander'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createStateStore } from '../../modules/state/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'

export function registerContractsCommand(program: Command): void {
  program
    .command('contracts')
    .description('Show contract declarations and verification status')
    .option('--output-format <format>', 'Output format: text or json', 'text')
    .action(async (options: { outputFormat: string }) => {
      // Detect storage backend from project layout (Issue 1: was called with no args).
      const dbRoot = await resolveMainRepoRoot(process.cwd())
      const statePath = join(dbRoot, '.substrate', 'state')
      const doltStatePath = join(statePath, '.dolt')
      const storeConfig = existsSync(doltStatePath)
        ? { backend: 'dolt' as const, basePath: statePath }
        : { backend: 'file' as const, basePath: statePath }

      const store = createStateStore(storeConfig)
      // Issue 2: initialize() is inside try so finally always calls close().
      try {
        await store.initialize()
        const contracts = await store.queryContracts()

        if (contracts.length === 0) {
          console.log('No contracts stored. Run a pipeline to populate contract data.')
          return
        }

        // Collect verifications for all unique story keys
        const storyKeys = [...new Set(contracts.map((c) => c.storyKey))]
        const verificationMap = new Map<string, Map<string, string>>()

        for (const sk of storyKeys) {
          const verifications = await store.getContractVerification(sk)
          const contractVerdicts = new Map<string, string>()
          for (const v of verifications) {
            contractVerdicts.set(v.contractName, v.verdict)
          }
          verificationMap.set(sk, contractVerdicts)
        }

        // Build merged records
        const mergedRecords = contracts.map((c) => {
          const verdicts = verificationMap.get(c.storyKey)
          const verdict = verdicts?.get(c.contractName)
          return {
            storyKey: c.storyKey,
            contractName: c.contractName,
            direction: c.direction,
            schemaPath: c.schemaPath,
            verificationStatus: verdict === 'pass' ? '✓ pass' : verdict === 'fail' ? '✗ fail' : '? pending',
            verdict: verdict ?? 'pending',
          }
        })

        if (options.outputFormat === 'json') {
          console.log(JSON.stringify(mergedRecords, null, 2))
          return
        }

        // Table output
        const headers = ['Story Key', 'Contract Name', 'Direction', 'Schema Path', 'Status']
        const rows = mergedRecords.map((r) => [r.storyKey, r.contractName, r.direction, r.schemaPath, r.verificationStatus])

        const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))

        const formatRow = (cells: string[]) => cells.map((c, i) => c.padEnd(colWidths[i]!)).join('  ')

        console.log(formatRow(headers))
        console.log(colWidths.map((w) => '-'.repeat(w)).join('  '))
        for (const row of rows) {
          console.log(formatRow(row))
        }
      } finally {
        await store.close()
      }
    })
}
