/**
 * `substrate upgrade` command
 *
 * Checks for and performs upgrades of the substrate package.
 *
 * Usage:
 *   substrate upgrade           - Interactive upgrade with confirmation prompt
 *   substrate upgrade --check   - Display version info without upgrading
 *   substrate upgrade --yes     - Non-interactive upgrade, skip confirmation
 *
 * Exit codes:
 *   0   - Success, up-to-date, or check-only
 *   1   - Upgrade failed or unexpected error
 */

import type { Command } from 'commander'
import { execSync, spawn } from 'child_process'
import * as readline from 'readline'
import { createVersionManager } from '../../modules/version-manager/version-manager-impl.js'
import type { VersionManager } from '../../modules/version-manager/version-manager.js'

// ---------------------------------------------------------------------------
// Install mode detection
// ---------------------------------------------------------------------------

/**
 * Detect whether substrate is installed globally.
 */
export function isGlobalInstall(): boolean {
  try {
    execSync('npm list -g substrate --depth=0', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function printVersionTable(
  currentVersion: string,
  latestVersion: string,
  isBreaking: boolean,
  changelog: string
): void {
  console.log('\nSubstrate update available:')
  console.log(`  Current version : v${currentVersion}`)
  console.log(`  Latest version  : v${latestVersion}`)
  console.log(`  Breaking changes: ${isBreaking ? 'Yes (major version bump)' : 'No'}`)
  console.log(`  Changelog       : ${changelog}`)
  console.log()
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------

async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'y')
    })
  })
}

// ---------------------------------------------------------------------------
// npm install runner
// ---------------------------------------------------------------------------

async function runNpmInstall(version: string, global: boolean, spawnFn: SpawnFn = spawn): Promise<void> {
  const args = global
    ? ['install', '-g', `substrate@${version}`]
    : ['install', `substrate@${version}`]

  return new Promise<void>((resolve, reject) => {
    const child = spawnFn('npm', args, { stdio: 'inherit' })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`npm install exited with code ${String(code)}`))
      }
    })
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn npm: ${err.message}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export type SpawnFn = typeof spawn

export interface UpgradeCommandOptions {
  check?: boolean
  yes?: boolean
  versionManager?: VersionManager
  /** Injectable spawn function for testing */
  spawnFn?: SpawnFn
  /** Injectable promptFn that returns true for confirmed, false for aborted */
  promptFn?: (question: string) => Promise<boolean>
}

/**
 * Execute the upgrade command logic.
 * Exported for testability.
 */
export async function runUpgradeCommand(options: UpgradeCommandOptions): Promise<void> {
  const versionManager = options.versionManager ?? createVersionManager()
  const promptFn = options.promptFn ?? promptConfirm
  const spawnFn = options.spawnFn ?? spawn

  // --check mode: display version info and exit 0
  // forceRefresh=true bypasses the cache so --check always shows the latest npm data (AC5)
  if (options.check) {
    let result
    try {
      result = await versionManager.checkForUpdates(true)
    } catch {
      process.stderr.write(
        'Warning: Could not reach npm registry to check for updates. Continuing anyway.\n'
      )
      return
    }

    if (!result.updateAvailable) {
      console.log(`substrate is up to date (v${result.currentVersion})`)
      return
    }

    printVersionTable(
      result.currentVersion,
      result.latestVersion,
      result.isBreaking,
      result.changelog
    )
    return
  }

  // Upgrade mode
  let result
  try {
    result = await versionManager.checkForUpdates()
  } catch {
    process.stderr.write(
      'Warning: Could not reach npm registry to check for updates. Continuing anyway.\n'
    )
    return
  }

  if (!result.updateAvailable) {
    console.log(`substrate is up to date (v${result.currentVersion})`)
    return
  }

  // Display upgrade preview
  const preview = versionManager.getUpgradePreview(result.latestVersion)
  printVersionTable(
    result.currentVersion,
    result.latestVersion,
    result.isBreaking,
    result.changelog
  )

  if (preview.breakingChanges.length > 0) {
    console.log('Breaking changes:')
    for (const change of preview.breakingChanges) {
      console.log(`  - ${change}`)
    }
    console.log()
  }

  if (preview.migrationSteps.length > 0) {
    console.log('Migration steps:')
    for (const step of preview.migrationSteps) {
      console.log(`  - ${step}`)
    }
    console.log()
  }

  // Confirmation in interactive mode
  if (!options.yes) {
    const confirmed = await promptFn(
      `Upgrade substrate from v${result.currentVersion} to v${result.latestVersion}? (y/N) `
    )
    if (!confirmed) {
      console.log('Upgrade aborted.')
      return
    }
  }

  // Run npm install
  const global = isGlobalInstall()
  console.log(
    `Running: npm install ${global ? '-g ' : ''}substrate@${result.latestVersion}`
  )

  try {
    await runNpmInstall(result.latestVersion, global, spawnFn)
    console.log(`\nSuccessfully upgraded to v${result.latestVersion}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Upgrade failed: ${message}\n`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Check for updates and upgrade substrate to the latest version')
    .option('--check', 'Check for updates without upgrading')
    .option('-y, --yes', 'Skip confirmation prompt (non-interactive upgrade)')
    .action(async (options: { check?: boolean; yes?: boolean }) => {
      await runUpgradeCommand(options)
    })
}
