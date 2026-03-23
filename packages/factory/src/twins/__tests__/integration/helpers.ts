/**
 * Shared test helpers for Epic 47 integration tests.
 *
 * All factory functions create fresh instances so each test gets independent mocks.
 * No vi.fn() calls at module level — all stubs are created inside factory functions.
 *
 * Story 47-8, Task 1.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type { TwinDefinition, TwinManager } from '../../index.js'
import type { ScenarioManifest } from '../../../scenarios/types.js'

/**
 * Creates a mock TwinManager with vi.fn() stubs for start, stop, and getComposeDir.
 * Both start and stop resolve to undefined — no Docker, no network.
 */
export function makeMockTwinManager(): TwinManager {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getComposeDir: vi.fn().mockReturnValue(null),
  } as unknown as TwinManager
}

/**
 * Returns a standard LocalStack TwinDefinition with healthcheck configured.
 */
export function makeLocalstackTwinDef(): TwinDefinition {
  return {
    name: 'localstack',
    image: 'localstack/localstack:latest',
    ports: [{ host: 4566, container: 4566 }],
    environment: { SERVICES: 's3' },
    healthcheck: { url: 'http://localhost:4566/health', timeout_ms: 5000 },
  }
}

/**
 * Creates a temporary shell script that echoes '{}' and exits with the given exit code.
 * The script is placed in a fresh mkdtempSync directory prefixed with 'tw-integ-'.
 *
 * @param twins    - Optional twin names to include in the manifest.
 * @param exitCode - Exit code for the script (default 0).
 * @returns manifest and a cleanup function that removes the temp directory.
 */
export function makeTmpScenario(
  twins?: string[],
  exitCode: number = 0,
): { manifest: ScenarioManifest; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-integ-'))
  const scriptPath = path.join(tmpDir, 'scenario-test.sh')
  const scriptContent = `#!/bin/sh\necho "{}"\nexit ${exitCode}\n`
  fs.writeFileSync(scriptPath, scriptContent)
  fs.chmodSync(scriptPath, 0o755)
  const checksum = crypto
    .createHash('sha256')
    .update(fs.readFileSync(scriptPath))
    .digest('hex')

  const manifest: ScenarioManifest = {
    scenarios: [{ name: 'scenario-test.sh', path: scriptPath, checksum }],
    capturedAt: Date.now(),
    ...(twins !== undefined ? { twins } : {}),
  }

  return {
    manifest,
    cleanup: (): void => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}
