/**
 * Unit tests for the `substrate init` command
 *
 * Tests:
 *  - Creates .substrate/ directory and config files
 *  - Handles existing .substrate/ directory
 *  - Integrates with adapter discovery
 *  - Uses defaults for providers not found
 *  - --yes flag skips prompts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runInit, INIT_EXIT_SUCCESS, INIT_EXIT_ALREADY_EXISTS, INIT_EXIT_ERROR } from '../init.js'
import type { AdapterRegistry, DiscoveryReport } from '../../../adapters/adapter-registry.js'

// ---------------------------------------------------------------------------
// Test directory management
// ---------------------------------------------------------------------------

let testDir: string

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `substrate-init-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRegistry(report: Partial<DiscoveryReport> = {}): AdapterRegistry {
  const fullReport: DiscoveryReport = {
    registeredCount: 0,
    failedCount: 0,
    results: [],
    ...report,
  }
  return {
    discoverAndRegister: vi.fn().mockResolvedValue(fullReport),
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry
}

const NO_ADAPTERS_REPORT: DiscoveryReport = {
  registeredCount: 0,
  failedCount: 3,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: false,
      healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: false,
      healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
    },
    {
      adapterId: 'gemini',
      displayName: 'Gemini CLI',
      registered: false,
      healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
    },
  ],
}

const CLAUDE_ONLY_REPORT: DiscoveryReport = {
  registeredCount: 1,
  failedCount: 2,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: true,
      healthResult: {
        healthy: true,
        version: '1.0.0',
        cliPath: '/usr/bin/claude',
        detectedBillingModes: ['subscription'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: false,
      healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
    },
    {
      adapterId: 'gemini',
      displayName: 'Gemini CLI',
      registered: false,
      healthResult: { healthy: false, error: 'not found', supportsHeadless: false },
    },
  ],
}

const ALL_ADAPTERS_REPORT: DiscoveryReport = {
  registeredCount: 3,
  failedCount: 0,
  results: [
    {
      adapterId: 'claude-code',
      displayName: 'Claude Code',
      registered: true,
      healthResult: {
        healthy: true,
        version: '1.0.0',
        cliPath: '/usr/bin/claude',
        detectedBillingModes: ['subscription'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'codex',
      displayName: 'Codex CLI',
      registered: true,
      healthResult: {
        healthy: true,
        version: '0.2.0',
        cliPath: '/usr/bin/codex',
        detectedBillingModes: ['api'],
        supportsHeadless: true,
      },
    },
    {
      adapterId: 'gemini',
      displayName: 'Gemini CLI',
      registered: true,
      healthResult: {
        healthy: true,
        version: '2.0.0',
        cliPath: '/usr/bin/gemini',
        detectedBillingModes: ['api'],
        supportsHeadless: true,
      },
    },
  ],
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function captureStdout(): { getOutput: () => string; restore: () => void } {
  let output = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    output += typeof data === 'string' ? data : data.toString()
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    getOutput: () => output,
    restore: (): void => { spy.mockRestore(); },
  }
}

// ---------------------------------------------------------------------------
// Tests: no existing .substrate/ directory
// ---------------------------------------------------------------------------

describe('runInit - no existing .substrate/ directory', () => {
  it('creates .substrate/ directory', async () => {
    const { restore } = captureStdout()
    try {
      const exitCode = await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
      expect(await fileExists(join(testDir, '.substrate'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('creates config.yaml', async () => {
    const { restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      expect(await fileExists(join(testDir, '.substrate', 'config.yaml'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('creates routing-policy.yaml', async () => {
    const { restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      expect(await fileExists(join(testDir, '.substrate', 'routing-policy.yaml'))).toBe(true)
    } finally {
      restore()
    }
  })

  it('config.yaml includes config_format_version: 1', async () => {
    const { restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      const { readFile } = await import('fs/promises')
      const content = await readFile(join(testDir, '.substrate', 'config.yaml'), 'utf-8')
      expect(content).toContain('config_format_version')
      expect(content).toContain('1')
    } finally {
      restore()
    }
  })

  it('returns INIT_EXIT_SUCCESS exit code', async () => {
    const { restore } = captureStdout()
    try {
      const exitCode = await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      expect(exitCode).toBe(INIT_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: adapter discovery integration
// ---------------------------------------------------------------------------

describe('runInit - adapter discovery integration', () => {
  it('calls discoverAndRegister on the registry', async () => {
    const { restore } = captureStdout()
    const registry = createMockRegistry(NO_ADAPTERS_REPORT)
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry,
      })
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.discoverAndRegister).toHaveBeenCalledOnce()
    } finally {
      restore()
    }
  })

  it('includes detected provider in config with enabled: true', async () => {
    const { restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(CLAUDE_ONLY_REPORT),
      })
      const { readFile } = await import('fs/promises')
      const content = await readFile(join(testDir, '.substrate', 'config.yaml'), 'utf-8')
      // Claude was detected, should be enabled
      expect(content).toContain('claude')
    } finally {
      restore()
    }
  })

  it('outputs message about detected providers', async () => {
    const { getOutput, restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(ALL_ADAPTERS_REPORT),
      })
      const output = getOutput()
      expect(output).toContain('Detected')
      expect(output).toContain('3')
    } finally {
      restore()
    }
  })

  it('outputs message about no agents when none detected', async () => {
    const { getOutput, restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      const output = getOutput()
      expect(output).toContain('No AI agents detected')
    } finally {
      restore()
    }
  })

  it('handles registry throwing an error', async () => {
    const failingRegistry: AdapterRegistry = {
      discoverAndRegister: vi.fn().mockRejectedValue(new Error('network error')),
      register: vi.fn(),
      get: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      getPlanningCapable: vi.fn().mockReturnValue([]),
    } as unknown as AdapterRegistry

    const { restore } = captureStdout()
    try {
      const exitCode = await runInit({
        directory: testDir,
        yes: true,
        registry: failingRegistry,
      })
      expect(exitCode).toBe(INIT_EXIT_ERROR)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: existing .substrate/ directory
// ---------------------------------------------------------------------------

describe('runInit - existing .substrate/ directory', () => {
  beforeEach(async () => {
    await mkdir(join(testDir, '.substrate'), { recursive: true })
  })

  it('returns INIT_EXIT_ALREADY_EXISTS in non-interactive mode with --yes', async () => {
    const { restore } = captureStdout()
    try {
      const exitCode = await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      expect(exitCode).toBe(INIT_EXIT_ALREADY_EXISTS)
    } finally {
      restore()
    }
  })

  it('outputs message about skipping when already exists', async () => {
    const { getOutput, restore } = captureStdout()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(NO_ADAPTERS_REPORT),
      })
      const output = getOutput()
      expect(output).toContain('.substrate/ already exists')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Tests: exit code constants
// ---------------------------------------------------------------------------

describe('runInit - exit code constants', () => {
  it('INIT_EXIT_SUCCESS is 0', () => {
    expect(INIT_EXIT_SUCCESS).toBe(0)
  })

  it('INIT_EXIT_ERROR is 1', () => {
    expect(INIT_EXIT_ERROR).toBe(1)
  })

  it('INIT_EXIT_ALREADY_EXISTS is 2', () => {
    expect(INIT_EXIT_ALREADY_EXISTS).toBe(2)
  })
})
