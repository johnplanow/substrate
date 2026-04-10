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

import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { ContractDeclaration } from './conflict-detector.js'
import type { ContractMismatch } from './types.js'

// ---------------------------------------------------------------------------
// shouldRunTscCheck
// ---------------------------------------------------------------------------

/**
 * Reads .substrate/project-profile.yaml (Story 37-1) and determines whether
 * TypeScript type-checking is appropriate for this project.
 *
 * Detection order:
 *   1. No profile → true (preserve pre-37-4 behavior)
 *   2. `packages` array non-empty → true iff any package is typescript/javascript
 *   3. `packages` empty/absent → infer from `buildCommand` — true for npm/pnpm/yarn/bun/turbo/tsc
 *   4. Parse error → true (conservative, allow tsc)
 *
 * Uses synchronous I/O to avoid making verifyContracts async (Story 37-3 pattern).
 * Does NOT import from src/modules/project-profile/ to avoid circular-dependency risk.
 */
function shouldRunTscCheck(projectRoot: string): boolean {
  const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) return true

  try {
    const raw = readFileSync(profilePath, 'utf-8')
    const parsed = yaml.load(raw) as Record<string, unknown> | null
    if (!parsed) return true

    const project = (parsed as { project?: Record<string, unknown> })?.project
    if (!project) return true

    // Tier 1: explicit packages list — any TypeScript/JavaScript package → keep tsc
    const packages = project['packages'] as Array<{ language?: string }> | undefined
    if (Array.isArray(packages) && packages.length > 0) {
      return packages.some((p) => p.language === 'typescript' || p.language === 'javascript')
    }

    // Tier 2: no packages array — infer from buildCommand
    const buildCommand = project['buildCommand'] as string | undefined
    if (typeof buildCommand === 'string' && buildCommand.length > 0) {
      const tsIndicators = ['npm', 'pnpm', 'yarn', 'bun', 'tsc', 'turbo']
      return tsIndicators.some((ind) => buildCommand.includes(ind))
    }

    return true // unknown shape → conservative
  } catch {
    return true // parse failure → conservative
  }
}

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
  projectRoot: string
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

    // Strip backticks — LLM agents sometimes emit paths wrapped in markdown code ticks
    const cleanPath = exp.filePath.replace(/`/g, '')
    const absPath = join(projectRoot, cleanPath)
    if (!existsSync(absPath)) {
      // Find all stories that import this contract
      const importers = imports.filter((i) => i.contractName === exp.contractName)

      if (importers.length > 0) {
        for (const imp of importers) {
          mismatches.push({
            exporter: exp.storyKey,
            importer: imp.storyKey,
            contractName: exp.contractName,
            mismatchDescription: `Exported file not found: ${cleanPath}`,
          })
        }
      } else {
        // No importer declared — still report the missing file
        mismatches.push({
          exporter: exp.storyKey,
          importer: null,
          contractName: exp.contractName,
          mismatchDescription: `Exported file not found: ${cleanPath}`,
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Check 2: TypeScript type-check (AC3)
  //
  // Only runs when:
  //   - Project profile indicates TypeScript is in use (or no profile exists)
  //   - tsconfig.json exists in the project root
  //   - The local tsc binary is available (node_modules/.bin/tsc)
  //
  // Runs tsc --noEmit once for the project and maps errors back to the
  // declared contract file paths.
  // ---------------------------------------------------------------------------
  if (shouldRunTscCheck(projectRoot)) {
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
  } // end shouldRunTscCheck guard

  return mismatches
}
