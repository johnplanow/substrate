/**
 * Unit tests for the `substrate upgrade` CLI command.
 *
 * Mocks VersionManager, spawn, and promptFn to avoid real network calls and npm execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { VersionManager, VersionCheckResult, UpgradePreview } from '../../../modules/version-manager/version-manager.js'
import { runUpgradeCommand } from '../upgrade.js'
import type { SpawnFn } from '../upgrade.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function buildMockVersionManager(overrides: Partial<{
  checkResult: VersionCheckResult
  checkError: Error
  preview: UpgradePreview
}>): VersionManager {
  const defaultResult: VersionCheckResult = {
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateAvailable: true,
    isBreaking: false,
    changelog: 'https://example.com/releases/v1.1.0',
  }

  const defaultPreview: UpgradePreview = {
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    breakingChanges: [],
    migrationSteps: ['See changelog'],
    automaticMigrations: [],
    manualStepsRequired: [],
  }

  return {
    getCurrentVersion: vi.fn(() => '1.0.0'),
    checkForUpdates: overrides.checkError
      ? vi.fn().mockRejectedValue(overrides.checkError)
      : vi.fn().mockResolvedValue(overrides.checkResult ?? defaultResult),
    getUpgradePreview: vi.fn().mockReturnValue(overrides.preview ?? defaultPreview),
    migrateConfiguration: vi.fn(),
    migrateTaskGraphFormat: vi.fn(),
    isConfigCompatible: vi.fn(() => true),
    isTaskGraphCompatible: vi.fn(() => true),
  } as unknown as VersionManager
}

function buildMockSpawn(exitCode = 0): SpawnFn {
  return vi.fn((_cmd: string, _args: string[], _opts?: object) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: null
      stderr: null
    }
    child.stdout = null
    child.stderr = null
    setImmediate(() => {
      child.emit('close', exitCode)
    })
    return child as ReturnType<SpawnFn>
  }) as unknown as SpawnFn
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upgrade command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${String(_code)})`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // --check mode
  // -------------------------------------------------------------------------

  describe('--check mode', () => {
    it('prints version table and exits 0 when update is available', async () => {
      const vm = buildMockVersionManager({})
      await runUpgradeCommand({ check: true, versionManager: vm })

      const logged = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logged).toContain('v1.0.0')
      expect(logged).toContain('v1.1.0')
    })

    it('prints up-to-date message when no update is available', async () => {
      const vm = buildMockVersionManager({
        checkResult: {
          currentVersion: '1.0.0',
          latestVersion: '1.0.0',
          updateAvailable: false,
          isBreaking: false,
          changelog: '',
        },
      })
      await runUpgradeCommand({ check: true, versionManager: vm })

      const logged = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logged).toContain('up to date')
      expect(logged).toContain('v1.0.0')
    })

    it('prints warning and exits 0 when network error occurs', async () => {
      const vm = buildMockVersionManager({ checkError: new Error('ECONNREFUSED') })
      await runUpgradeCommand({ check: true, versionManager: vm })

      const written = stderrSpy.mock.calls.flat().join('\n')
      expect(written).toContain('Warning')
    })

    it('calls checkForUpdates with forceRefresh=true to bypass cache', async () => {
      const vm = buildMockVersionManager({})
      await runUpgradeCommand({ check: true, versionManager: vm })

      expect(vm.checkForUpdates).toHaveBeenCalledWith(true)
    })
  })

  // -------------------------------------------------------------------------
  // upgrade --yes mode
  // -------------------------------------------------------------------------

  describe('upgrade --yes', () => {
    it('is a no-op when already up to date', async () => {
      const vm = buildMockVersionManager({
        checkResult: {
          currentVersion: '1.0.0',
          latestVersion: '1.0.0',
          updateAvailable: false,
          isBreaking: false,
          changelog: '',
        },
      })
      await runUpgradeCommand({ yes: true, versionManager: vm })

      const logged = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logged).toContain('up to date')
    })

    it('calls npm install with correct arguments when update is available', async () => {
      const vm = buildMockVersionManager({})
      const mockSpawn = buildMockSpawn(0)

      await runUpgradeCommand({ yes: true, versionManager: vm, spawnFn: mockSpawn })

      expect(mockSpawn).toHaveBeenCalled()
      const [cmd, args] = (mockSpawn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
      expect(cmd).toBe('npm')
      expect(args).toContain('install')
      expect(args.join(' ')).toContain('substrate@1.1.0')
    })

    it('prints success message after successful upgrade', async () => {
      const vm = buildMockVersionManager({})
      const mockSpawn = buildMockSpawn(0)

      await runUpgradeCommand({ yes: true, versionManager: vm, spawnFn: mockSpawn })

      const logged = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logged).toContain('Successfully upgraded')
    })

    it('sets process.exitCode = 1 when npm install fails', async () => {
      const vm = buildMockVersionManager({})
      const mockSpawn = buildMockSpawn(1) // non-zero exit code

      await runUpgradeCommand({ yes: true, versionManager: vm, spawnFn: mockSpawn })
      expect(process.exitCode).toBe(1)
      // Reset for other tests
      process.exitCode = undefined
    })
  })

  // -------------------------------------------------------------------------
  // Interactive mode
  // -------------------------------------------------------------------------

  describe('interactive mode', () => {
    it('aborts when user answers "n"', async () => {
      const vm = buildMockVersionManager({})
      const mockPrompt = vi.fn().mockResolvedValue(false)

      await runUpgradeCommand({ versionManager: vm, promptFn: mockPrompt })

      const logged = consoleLogSpy.mock.calls.flat().join('\n')
      expect(logged).toContain('aborted')
    })

    it('proceeds with upgrade when user answers "y"', async () => {
      const vm = buildMockVersionManager({})
      const mockPrompt = vi.fn().mockResolvedValue(true)
      const mockSpawn = buildMockSpawn(0)

      await runUpgradeCommand({
        versionManager: vm,
        promptFn: mockPrompt,
        spawnFn: mockSpawn,
      })

      expect(mockSpawn).toHaveBeenCalled()
    })
  })
})
