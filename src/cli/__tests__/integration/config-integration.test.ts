/**
 * Integration tests for config system end-to-end
 *
 * Tests the full round-trip: init creates files → config show reads them →
 * config set modifies them → reload shows updated values.
 *
 * These tests use real temp directories but mock AdapterRegistry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { runInitAction } from '../../commands/init.js'
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

function createMockRegistry(report: DiscoveryReport = NO_ADAPTERS_REPORT): AdapterRegistry {
  return {
    discoverAndRegister: vi.fn().mockResolvedValue(report),
    register: vi.fn(),
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
  } as unknown as AdapterRegistry
}

/** Discovery report where only Codex is detected/registered (claude+gemini absent). */
const CODEX_ONLY_REPORT: DiscoveryReport = {
  registeredCount: 1,
  failedCount: 0,
  results: [
    {
      adapterId: 'codex',
      displayName: 'Codex',
      registered: true,
      healthResult: { healthy: true, supportsHeadless: true, cliPath: '/usr/bin/codex' },
    },
  ],
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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

  it('writes a Codex-only routing-policy.yaml when only Codex is enabled', async () => {
    const restore = silenceOutput()
    try {
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
        yes: true,
        registry: createMockRegistry(CODEX_ONLY_REPORT),
      })

      const routing = await readFile(join(substrateDir, 'routing-policy.yaml'), 'utf-8')
      // The bug: routing-policy.yaml must not prefer a disabled provider.
      expect(routing).toContain('default_provider: codex')
      expect(routing).not.toContain('claude')
      expect(routing).not.toContain('gemini')

      // config.yaml and routing-policy.yaml must agree: codex enabled.
      const config = await readFile(join(substrateDir, 'config.yaml'), 'utf-8')
      expect(config).toContain('codex')
    } finally {
      restore()
    }
  })

  it('re-init preserves an existing .substrate/config.yaml unless --force', async () => {
    // The reported regression: a user with an interactively-disabled-Claude
    // config (Codex-only) ran `substrate init --yes` and saw their config
    // overwritten with all providers enabled. Re-init must NOT clobber the
    // operator config — the user's edits are authoritative.
    const restore = silenceOutput()
    try {
      await mkdir(substrateDir, { recursive: true })
      const sentinel = '# CUSTOM: codex-only handed-edited config\nproviders:\n  codex:\n    enabled: true\n'
      await writeFile(join(substrateDir, 'config.yaml'), sentinel, 'utf-8')

      // Re-init without --force: must preserve.
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
        yes: true,
        registry: createMockRegistry(),
      })

      const after = await readFile(join(substrateDir, 'config.yaml'), 'utf-8')
      expect(after).toBe(sentinel)
    } finally {
      restore()
    }
  })

  it('--force resets the existing .substrate/config.yaml', async () => {
    const restore = silenceOutput()
    try {
      await mkdir(substrateDir, { recursive: true })
      await writeFile(
        join(substrateDir, 'config.yaml'),
        '# CUSTOM: should be overwritten by --force\n',
        'utf-8',
      )

      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
        yes: true,
        force: true,
        registry: createMockRegistry(),
      })

      const after = await readFile(join(substrateDir, 'config.yaml'), 'utf-8')
      expect(after).not.toContain('CUSTOM')
      expect(after).toContain('config_format_version')
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
      await runInitAction({
        pack: 'bmad',
        projectRoot: testDir,
        outputFormat: 'human',
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
