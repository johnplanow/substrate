/**
 * Tests for the startup version notification behavior.
 *
 * The notification logic fires a non-blocking checkForUpdates() and prints
 * to stderr when an update is available. Tests verify notification suppression
 * and behavior via the VersionManager mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VersionCheckResult } from '../../../modules/version-manager/version-manager.js'

// ---------------------------------------------------------------------------
// Helpers — simulate the startup notification pattern
// ---------------------------------------------------------------------------

/**
 * Simulates the startup notification pattern from index.ts:
 *   versionManager.checkForUpdates()
 *     .then(result => { if (result.updateAvailable && !notificationShown) { ... } })
 *     .catch(() => {})
 */
async function simulateStartupNotification(
  checkForUpdates: () => Promise<VersionCheckResult>,
  suppressCheck: boolean,
  notificationShown: boolean
): Promise<{ shownAfter: boolean; stderrOutput: string }> {
  let shownAfter = notificationShown
  let stderrOutput = ''

  if (!suppressCheck) {
    await checkForUpdates()
      .then((result) => {
        if (result.updateAvailable && !notificationShown) {
          shownAfter = true
          stderrOutput =
            `\nUpdate available: v${result.currentVersion} → v${result.latestVersion}. ` +
            `Run \`substrate upgrade\` to update.\n\n`
        }
      })
      .catch(() => {
        // never block
      })
  }

  return { shownAfter, stderrOutput }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startup version notification', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('prints notification to stderr when update is available', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      isBreaking: false,
      changelog: '',
    } satisfies VersionCheckResult)

    const { stderrOutput } = await simulateStartupNotification(checkForUpdates, false, false)

    expect(stderrOutput).toContain('Update available')
    expect(stderrOutput).toContain('v1.0.0')
    expect(stderrOutput).toContain('v1.1.0')
    expect(stderrOutput).toContain('substrate upgrade')
  })

  it('does NOT print notification when update is not available', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
      isBreaking: false,
      changelog: '',
    } satisfies VersionCheckResult)

    const { stderrOutput } = await simulateStartupNotification(checkForUpdates, false, false)

    expect(stderrOutput).toBe('')
  })

  it('does NOT print notification when suppressCheck is true', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      isBreaking: false,
      changelog: '',
    } satisfies VersionCheckResult)

    const { stderrOutput } = await simulateStartupNotification(checkForUpdates, true, false)

    expect(stderrOutput).toBe('')
    expect(checkForUpdates).not.toHaveBeenCalled()
  })

  it('does NOT print notification when notificationShown is already true (once-per-session)', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      isBreaking: false,
      changelog: '',
    } satisfies VersionCheckResult)

    const { stderrOutput, shownAfter } = await simulateStartupNotification(
      checkForUpdates,
      false,
      true // already shown
    )

    expect(stderrOutput).toBe('')
    expect(shownAfter).toBe(true)
  })

  it('silently swallows errors from version check (never blocks CLI)', async () => {
    const checkForUpdates = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    // Should not throw
    const { stderrOutput } = await simulateStartupNotification(checkForUpdates, false, false)

    expect(stderrOutput).toBe('')
  })

  it('marks notificationShown = true after first notification', async () => {
    const checkForUpdates = vi.fn().mockResolvedValue({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      isBreaking: false,
      changelog: '',
    } satisfies VersionCheckResult)

    const { shownAfter } = await simulateStartupNotification(checkForUpdates, false, false)

    expect(shownAfter).toBe(true)
  })
})
