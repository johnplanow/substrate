/**
 * Contract Verifier — Story 25-6: Post-Sprint Contract Verification Gate.
 *
 * Verifies that all declared export/import contract pairs are satisfied after
 * all sprint stories complete. Checks:
 *   1. Exported files exist on disk (AC2)
 *   2. TypeScript type-check passes when tsconfig.json is present (AC3)
 *
 * Returns an array of verification failures. Empty array means all contracts
 * are satisfied (or there were no declarations to check).
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import type { ContractDeclaration } from './conflict-detector.js'
import type { ContractMismatch } from './types.js'

// ---------------------------------------------------------------------------
// verifyContracts
// ---------------------------------------------------------------------------

/**
 * Verify all declared contract export/import pairs after sprint completion.
 *
 * @param declarations - All ContractDeclaration entries from the decision store
 * @param projectRoot  - Absolute path to the project root for file resolution
 * @returns            - Array of ContractMismatch entries (empty = all passed)
 */
export function verifyContracts(
  declarations: ContractDeclaration[],
  projectRoot: string,
): ContractMismatch[] {
  if (declarations.length === 0) return []

  const exports = declarations.filter((d) => d.direction === 'export')
  const imports = declarations.filter((d) => d.direction === 'import')

  if (exports.length === 0) return []

  const mismatches: ContractMismatch[] = []

  // ---------------------------------------------------------------------------
  // Check 1: Exported file existence (AC2)
  // ---------------------------------------------------------------------------
  for (const exp of exports) {
    if (!exp.filePath) continue

    const absPath = join(projectRoot, exp.filePath)
    if (!existsSync(absPath)) {
      // Find all stories that import this contract
      const importers = imports.filter((i) => i.contractName === exp.contractName)

      if (importers.length > 0) {
        for (const imp of importers) {
          mismatches.push({
            exporter: exp.storyKey,
            importer: imp.storyKey,
            contractName: exp.contractName,
            mismatchDescription: `Exported file not found: ${exp.filePath}`,
          })
        }
      } else {
        // No importer declared — still report the missing file
        mismatches.push({
          exporter: exp.storyKey,
          importer: null,
          contractName: exp.contractName,
          mismatchDescription: `Exported file not found: ${exp.filePath}`,
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Check 2: TypeScript type-check (AC3)
  //
  // Only runs when:
  //   - tsconfig.json exists in the project root
  //   - The local tsc binary is available (node_modules/.bin/tsc)
  //
  // Runs tsc --noEmit once for the project and maps errors back to the
  // declared contract file paths.
  // ---------------------------------------------------------------------------
  const tsconfigPath = join(projectRoot, 'tsconfig.json')
  const tscBinPath = join(projectRoot, 'node_modules', '.bin', 'tsc')

  if (existsSync(tsconfigPath) && existsSync(tscBinPath)) {
    let tscOutput = ''
    let tscFailed = false

    try {
      execSync(`"${tscBinPath}" --noEmit`, {
        cwd: projectRoot,
        timeout: 120_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err: unknown) {
      tscFailed = true
      if (err != null && typeof err === 'object') {
        const e = err as { stdout?: unknown; stderr?: unknown; message?: string }
        const stdoutStr =
          typeof e.stdout === 'string'
            ? e.stdout
            : Buffer.isBuffer(e.stdout)
              ? e.stdout.toString('utf-8')
              : ''
        const stderrStr =
          typeof e.stderr === 'string'
            ? e.stderr
            : Buffer.isBuffer(e.stderr)
              ? e.stderr.toString('utf-8')
              : ''
        tscOutput = [stdoutStr, stderrStr].filter((s) => s.length > 0).join('\n')
        if (!tscOutput && e.message) tscOutput = e.message
      }
    }

    if (tscFailed) {
      const truncatedOutput = tscOutput.slice(0, 1000)

      // Map tsc errors to specific contract file paths where possible.
      // For each export declaration, check if tsc output mentions its file path.
      const matchedExports = new Set<string>()

      for (const exp of exports) {
        if (!exp.filePath) continue
        if (tscOutput.includes(exp.filePath)) {
          matchedExports.add(exp.contractName)
          const importers = imports.filter((i) => i.contractName === exp.contractName)

          if (importers.length > 0) {
            for (const imp of importers) {
              mismatches.push({
                exporter: exp.storyKey,
                importer: imp.storyKey,
                contractName: exp.contractName,
                mismatchDescription: `TypeScript type-check failed for ${exp.filePath}: ${truncatedOutput}`,
              })
            }
          } else {
            mismatches.push({
              exporter: exp.storyKey,
              importer: null,
              contractName: exp.contractName,
              mismatchDescription: `TypeScript type-check failed for ${exp.filePath}: ${truncatedOutput}`,
            })
          }
        }
      }

      // If tsc failed but no specific file matched, report for all export/import pairs
      if (matchedExports.size === 0) {
        const reportedPairs = new Set<string>()

        for (const exp of exports) {
          const importers = imports.filter((i) => i.contractName === exp.contractName)

          if (importers.length > 0) {
            for (const imp of importers) {
              const pairKey = `${exp.storyKey}:${imp.storyKey}:${exp.contractName}`
              if (!reportedPairs.has(pairKey)) {
                reportedPairs.add(pairKey)
                mismatches.push({
                  exporter: exp.storyKey,
                  importer: imp.storyKey,
                  contractName: exp.contractName,
                  mismatchDescription: `TypeScript type-check failed: ${truncatedOutput}`,
                })
              }
            }
          } else {
            const pairKey = `${exp.storyKey}:null:${exp.contractName}`
            if (!reportedPairs.has(pairKey)) {
              reportedPairs.add(pairKey)
              mismatches.push({
                exporter: exp.storyKey,
                importer: null,
                contractName: exp.contractName,
                mismatchDescription: `TypeScript type-check failed: ${truncatedOutput}`,
              })
            }
          }
        }
      }
    }
  }

  return mismatches
}
