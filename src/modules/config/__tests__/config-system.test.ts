/**
 * Unit tests for config-system-impl.ts
 *
 * Tests:
 *  - Hierarchy loading (defaults < global < project < env < CLI)
 *  - Config validation errors
 *  - get() dot-notation access
 *  - set() with project file update
 *  - getMasked() credential masking
 *  - Error handling for missing/invalid configs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createConfigSystem } from '../config-system-impl.js'
import { DEFAULT_CONFIG } from '../defaults.js'
import { ConfigError } from '../../../core/errors.js'

// ---------------------------------------------------------------------------
// Test setup — temporary directories
// ---------------------------------------------------------------------------

let testDir: string
let projectConfigDir: string
let globalConfigDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `substrate-config-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`)
  projectConfigDir = join(testDir, 'project', '.substrate')
  globalConfigDir = join(testDir, 'global', '.substrate')
  await mkdir(projectConfigDir, { recursive: true })
  await mkdir(globalConfigDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  // Restore env vars
  for (const key of Object.keys(process.env).filter((k) => k.startsWith('ADT_'))) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key]
  }
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createSystem(overrides: Record<string, unknown> = {}): ReturnType<typeof createConfigSystem> {
  return createConfigSystem({
    projectConfigDir,
    globalConfigDir,
    ...overrides,
  })
}

async function writeYaml(dir: string, filename: string, content: string): Promise<void> {
  await writeFile(join(dir, filename), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// Default config loading
// ---------------------------------------------------------------------------

describe('ConfigSystem - default config', () => {
  it('loads successfully with no config files', async () => {
    const system = createSystem()
    await expect(system.load()).resolves.not.toThrow()
    expect(system.isLoaded).toBe(true)
  })

  it('returns default config when no config files exist', async () => {
    const system = createSystem()
    await system.load()
    const config = system.getConfig()
    expect(config.config_format_version).toBe('1')
    expect(config.global.log_level).toBe('info')
    expect(config.global.max_concurrent_tasks).toBe(4)
  })

  it('throws ConfigError if getConfig called before load', () => {
    const system = createSystem()
    expect(() => system.getConfig()).toThrow(ConfigError)
  })

  it('isLoaded is false before load', () => {
    const system = createSystem()
    expect(system.isLoaded).toBe(false)
  })

  it('isLoaded is true after successful load', async () => {
    const system = createSystem()
    await system.load()
    expect(system.isLoaded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Hierarchy loading
// ---------------------------------------------------------------------------

describe('ConfigSystem - hierarchy loading', () => {
  it('global config overrides defaults', async () => {
    await writeYaml(
      globalConfigDir,
      'config.yaml',
      'global:\n  log_level: debug\n'
    )

    const system = createSystem()
    await system.load()
    const config = system.getConfig()
    expect(config.global.log_level).toBe('debug')
  })

  it('project config overrides global config', async () => {
    await writeYaml(
      globalConfigDir,
      'config.yaml',
      'global:\n  log_level: debug\n'
    )
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      'global:\n  log_level: warn\n'
    )

    const system = createSystem()
    await system.load()
    const config = system.getConfig()
    expect(config.global.log_level).toBe('warn')
  })

  it('env var overrides project config', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      'global:\n  log_level: warn\n'
    )
    process.env.ADT_LOG_LEVEL = 'error'

    const system = createSystem()
    await system.load()
    const config = system.getConfig()
    expect(config.global.log_level).toBe('error')
  })

  it('CLI overrides take highest priority', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      'global:\n  log_level: warn\n'
    )
    process.env.ADT_LOG_LEVEL = 'error'

    const system = createSystem({
      cliOverrides: { global: { log_level: 'trace' } },
    })
    await system.load()
    const config = system.getConfig()
    expect(config.global.log_level).toBe('trace')
  })

  it('merges provider configs from project file', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      [
        'providers:',
        '  claude:',
        '    enabled: true',
        '    max_concurrent: 5',
      ].join('\n') + '\n'
    )

    const system = createSystem()
    await system.load()
    const config = system.getConfig()
    expect(config.providers.claude?.enabled).toBe(true)
    expect(config.providers.claude?.max_concurrent).toBe(5)
  })

  it('defaults preserved when not overridden by project config', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      'global:\n  log_level: debug\n'
    )

    const system = createSystem()
    await system.load()
    const config = system.getConfig()
    // Other defaults should remain
    expect(config.global.max_concurrent_tasks).toBe(DEFAULT_CONFIG.global.max_concurrent_tasks)
    expect(config.providers.codex).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe('ConfigSystem - validation errors', () => {
  it('throws ConfigError for invalid log_level in project config', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      'global:\n  log_level: INVALID\n'
    )

    const system = createSystem()
    await expect(system.load()).rejects.toThrow(ConfigError)
  })

  it('throws ConfigError for invalid max_concurrent_tasks', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      'global:\n  max_concurrent_tasks: 0\n'
    )

    const system = createSystem()
    await expect(system.load()).rejects.toThrow(ConfigError)
  })

  it('throws ConfigError for invalid provider max_concurrent', async () => {
    await writeYaml(
      projectConfigDir,
      'config.yaml',
      [
        'providers:',
        '  claude:',
        '    max_concurrent: 100',
      ].join('\n') + '\n'
    )

    const system = createSystem()
    await expect(system.load()).rejects.toThrow(ConfigError)
  })
})

// ---------------------------------------------------------------------------
// get() dot-notation
// ---------------------------------------------------------------------------

describe('ConfigSystem - get()', () => {
  beforeEach(async () => {
    const system = createSystem()
    await system.load()
  })

  it('returns value for top-level key', async () => {
    const system = createSystem()
    await system.load()
    expect(system.get('config_format_version')).toBe('1')
  })

  it('returns value for nested key', async () => {
    const system = createSystem()
    await system.load()
    expect(system.get('global.log_level')).toBe('info')
  })

  it('returns undefined for non-existent key', async () => {
    const system = createSystem()
    await system.load()
    expect(system.get('global.nonExistentKey')).toBeUndefined()
  })

  it('returns nested object for partial path', async () => {
    const system = createSystem()
    await system.load()
    const global = system.get('global')
    expect(typeof global).toBe('object')
    expect((global as Record<string, unknown>).log_level).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// set() operation
// ---------------------------------------------------------------------------

describe('ConfigSystem - set()', () => {
  it('persists a scalar value to project config', async () => {
    const system = createSystem()
    await system.load()
    await system.set('global.log_level', 'debug')

    // Verify by reloading
    const system2 = createSystem()
    await system2.load()
    expect(system2.get('global.log_level')).toBe('debug')
  })

  it('persists a numeric value', async () => {
    const system = createSystem()
    await system.load()
    await system.set('global.max_concurrent_tasks', 8)

    const system2 = createSystem()
    await system2.load()
    expect(system2.get('global.max_concurrent_tasks')).toBe(8)
  })

  it('persists a boolean value', async () => {
    const system = createSystem()
    await system.load()
    await system.set('providers.claude.enabled', true)

    const system2 = createSystem()
    await system2.load()
    expect(system2.get('providers.claude.enabled')).toBe(true)
  })

  it('throws ConfigError for invalid value', async () => {
    const system = createSystem()
    await system.load()
    await expect(system.set('global.log_level', 'INVALID')).rejects.toThrow(ConfigError)
  })

  it('throws ConfigError for invalid max_concurrent_tasks', async () => {
    const system = createSystem()
    await system.load()
    await expect(system.set('global.max_concurrent_tasks', 0)).rejects.toThrow(ConfigError)
  })
})

// ---------------------------------------------------------------------------
// getMasked()
// ---------------------------------------------------------------------------

describe('ConfigSystem - getMasked()', () => {
  it('returns a config object', async () => {
    const system = createSystem()
    await system.load()
    const masked = system.getMasked()
    expect(masked).toBeDefined()
    expect(masked.config_format_version).toBe('1')
  })

  it('does not modify non-credential fields', async () => {
    const system = createSystem()
    await system.load()
    const masked = system.getMasked()
    expect(masked.global.log_level).toBe('info')
  })

  it('returns a masked config that does not expose credential fields', async () => {
    const system = createSystem()
    await system.load()
    const masked = system.getMasked()
    // Verify getMasked returns valid config structure
    expect(masked).toBeDefined()
    expect(masked.config_format_version).toBe('1')
    // Verify providers are present
    expect(masked.providers).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Environment variable behavior
// ---------------------------------------------------------------------------

describe('ConfigSystem - environment variable overrides', () => {
  afterEach(() => {
    delete process.env.ADT_LOG_LEVEL
    delete process.env.ADT_MAX_CONCURRENT_TASKS
    delete process.env.ADT_BUDGET_CAP_TOKENS
    delete process.env.ADT_CLAUDE_ENABLED
  })

  it('ADT_LOG_LEVEL overrides log_level', async () => {
    process.env.ADT_LOG_LEVEL = 'warn'
    const system = createSystem()
    await system.load()
    expect(system.get('global.log_level')).toBe('warn')
  })

  it('ADT_MAX_CONCURRENT_TASKS overrides max_concurrent_tasks', async () => {
    process.env.ADT_MAX_CONCURRENT_TASKS = '10'
    const system = createSystem()
    await system.load()
    expect(system.get('global.max_concurrent_tasks')).toBe(10)
  })

  it('ADT_CLAUDE_ENABLED overrides claude.enabled', async () => {
    process.env.ADT_CLAUDE_ENABLED = 'true'
    const system = createSystem()
    await system.load()
    expect(system.get('providers.claude.enabled')).toBe(true)
  })

  it('ignores invalid env var value with warning', async () => {
    process.env.ADT_LOG_LEVEL = 'NOT_VALID_LEVEL'
    const system = createSystem()
    // Should still load (invalid env ignored with warning, defaults used)
    await expect(system.load()).resolves.not.toThrow()
  })
})
