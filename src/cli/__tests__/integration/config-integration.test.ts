/**
 * Integration tests for config system end-to-end
 *
 * Tests the full round-trip: init creates files → config show reads them →
 * config set modifies them → reload shows updated values.
 *
 * These tests use real temp directories but mock AdapterRegistry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runInit } from '../../commands/init.js'
import { runConfigShow, runConfigSet } from '../../commands/config.js'
import type { AdapterRegistry, DiscoveryReport } from '../../../adapters/adapter-registry.js'
import { createConfigSystem } from '../../../modules/config/config-system-impl.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string
let substrateDir: string

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `substrate-int-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  )
  substrateDir = join(testDir, '.substrate')
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  for (const key of Object.keys(process.env).filter((k) => k.startsWith('ADT_'))) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key]
  }
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_ADAPTERS_REPORT: DiscoveryReport = {
  registeredCount: 0,
  failedCount: 0,
  results: [],
}

function createMockRegistry(): AdapterRegistry {
  return {
    discoverAndRegister: vi.fn().mockResolvedValue(NO_ADAPTERS_REPORT),
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry
}

function silenceOutput(): () => void {
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return () => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  }
}

// ---------------------------------------------------------------------------
// Integration: init → verify files created
// ---------------------------------------------------------------------------

describe('init creates valid config files', () => {
  it('creates config.yaml with valid format', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })

      const content = await readFile(join(substrateDir, 'config.yaml'), 'utf-8')
      expect(content).toContain('config_format_version')
      expect(content).toContain('global')
      expect(content).toContain('providers')
    } finally {
      restore()
    }
  })

  it('created config.yaml is loadable by ConfigSystem', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })

      const system = createConfigSystem({ projectConfigDir: substrateDir })
      await expect(system.load()).resolves.not.toThrow()
      const config = system.getConfig()
      expect(config.config_format_version).toBe('1')
    } finally {
      restore()
    }
  })

  it('creates routing-policy.yaml with default provider', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })

      const content = await readFile(join(substrateDir, 'routing-policy.yaml'), 'utf-8')
      expect(content).toContain('default_provider')
      expect(content).toContain('claude')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: init → config show
// ---------------------------------------------------------------------------

describe('init → config show', () => {
  it('config show returns SUCCESS after init', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })

      const exitCode = await runConfigShow({
        projectConfigDir: substrateDir,
        globalConfigDir: join(testDir, 'global', '.substrate'),
      })
      expect(exitCode).toBe(0)
    } finally {
      restore()
    }
  })

  it('config show JSON contains config_format_version after init', async () => {
    let stdoutOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === 'string' ? data : data.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })

      stdoutOutput = '' // reset after init

      await runConfigShow({
        projectConfigDir: substrateDir,
        globalConfigDir: join(testDir, 'global', '.substrate'),
        format: 'json',
      })

      const parsed = JSON.parse(stdoutOutput) as { config_format_version: string }
      expect(parsed.config_format_version).toBe('1')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: init → config set → config show
// ---------------------------------------------------------------------------

describe('init → config set → config show', () => {
  it('shows updated log_level after config set', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })

      await runConfigSet('global.log_level', 'debug', {
        projectConfigDir: substrateDir,
        globalConfigDir: join(testDir, 'global', '.substrate'),
      })
    } finally {
      restore()
    }

    // Now capture the show output
    let stdoutOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === 'string' ? data : data.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await runConfigShow({
        projectConfigDir: substrateDir,
        globalConfigDir: join(testDir, 'global', '.substrate'),
      })
      expect(stdoutOutput).toContain('debug')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: environment variable overrides
// ---------------------------------------------------------------------------

describe('environment variable overrides', () => {
  it('ADT_LOG_LEVEL overrides config file value', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })
    } finally {
      restore()
    }

    process.env.ADT_LOG_LEVEL = 'fatal'

    const system = createConfigSystem({ projectConfigDir: substrateDir })
    await system.load()
    expect(system.get('global.log_level')).toBe('fatal')
  })
})

// ---------------------------------------------------------------------------
// Integration: credential masking in config show
// ---------------------------------------------------------------------------

describe('credential masking', () => {
  it('config show does not reveal environment variable values in output', async () => {
    const restore = silenceOutput()
    try {
      await runInit({
        directory: testDir,
        yes: true,
        registry: createMockRegistry(),
      })
    } finally {
      restore()
    }

    // Set a fake API key in env
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-secret-key-12345'

    let stdoutOutput = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === 'string' ? data : data.toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await runConfigShow({
        projectConfigDir: substrateDir,
        globalConfigDir: join(testDir, 'global', '.substrate'),
      })
      // The API key value should not appear in the YAML output
      expect(stdoutOutput).not.toContain('sk-ant-fake-secret-key-12345')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      vi.restoreAllMocks()
    }
  })
})
