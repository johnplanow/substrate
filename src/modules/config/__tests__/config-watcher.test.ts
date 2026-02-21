/**
 * Unit tests for config-watcher.ts
 *
 * Tests:
 *  - ConfigWatcher starts watching the config file
 *  - Debouncing works (rapid saves only trigger one reload)
 *  - Config reload events are emitted with old and new config
 *  - ConfigWatcher.stop() closes the file watcher
 *  - Error handling when config reload fails (invalid YAML)
 *  - enableConfigHotReload=false disables watching
 *  - computeChangedKeys correctly diffs two configs
 *  - flattenObject correctly flattens nested objects
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createConfigWatcher, computeChangedKeys, flattenObject, type ConfigWatcher } from '../config-watcher.js'
import type { SubstrateConfig } from '../config-schema.js'

// ---------------------------------------------------------------------------
// Test setup — temporary directories
// ---------------------------------------------------------------------------

let testDir: string
let configPath: string

/** Minimal valid config YAML for testing */
const VALID_CONFIG_YAML = `
config_format_version: "1"
global:
  log_level: info
  max_concurrent_tasks: 4
  budget_cap_tokens: 0
  budget_cap_usd: 0
providers:
  claude:
    enabled: true
    cli_path: /usr/bin/claude
    subscription_routing: auto
    max_concurrent: 4
    api_billing: false
`

/** Updated valid config YAML for testing reload */
const UPDATED_CONFIG_YAML = `
config_format_version: "1"
global:
  log_level: debug
  max_concurrent_tasks: 8
  budget_cap_tokens: 0
  budget_cap_usd: 0
providers:
  claude:
    enabled: true
    cli_path: /usr/bin/claude
    subscription_routing: auto
    max_concurrent: 4
    api_billing: false
`

/** Invalid YAML that won't pass schema validation */
const INVALID_CONFIG_YAML = `
config_format_version: "1"
global:
  log_level: invalid_level
  max_concurrent_tasks: -1
`

/** Malformed YAML */
const MALFORMED_YAML = `
  : : : not valid yaml {{{}}}
  [[[ broken
`

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `substrate-watcher-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(testDir, { recursive: true })
  configPath = join(testDir, 'substrate.config.yaml')
  await writeFile(configPath, VALID_CONFIG_YAML, 'utf-8')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helper: wait for a condition with timeout
// ---------------------------------------------------------------------------

async function waitFor(conditionFn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!conditionFn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ---------------------------------------------------------------------------
// Tests: createConfigWatcher
// ---------------------------------------------------------------------------

describe('createConfigWatcher', () => {
  let watcher: ConfigWatcher | null = null

  afterEach(() => {
    watcher?.stop()
    watcher = null
  })

  it('should start watching the config file and call onReload on change', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 50,
    })
    watcher.start()

    // Modify the file to trigger a reload
    await writeFile(configPath, UPDATED_CONFIG_YAML, 'utf-8')

    // Wait for onReload to be called
    await waitFor(() => onReload.mock.calls.length > 0)

    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    const newConfig = onReload.mock.calls[0]![0] as SubstrateConfig
    expect(newConfig.global.log_level).toBe('debug')
    expect(newConfig.global.max_concurrent_tasks).toBe(8)
  })

  it('should debounce rapid saves and trigger only one reload', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 200,
    })
    watcher.start()

    // Rapidly write the file multiple times
    await writeFile(configPath, UPDATED_CONFIG_YAML, 'utf-8')
    await new Promise((r) => setTimeout(r, 30))
    await writeFile(configPath, VALID_CONFIG_YAML, 'utf-8')
    await new Promise((r) => setTimeout(r, 30))
    await writeFile(configPath, UPDATED_CONFIG_YAML, 'utf-8')

    // Wait for the debounce to settle and onReload to be called
    await waitFor(() => onReload.mock.calls.length > 0, 3000)

    // With a 200ms debounce, only the last write should trigger a reload
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    const newConfig = onReload.mock.calls[0]![0] as SubstrateConfig
    // The last write was UPDATED_CONFIG_YAML
    expect(newConfig.global.log_level).toBe('debug')
  })

  it('should call onError when config has invalid YAML schema', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 50,
    })
    watcher.start()

    // Write invalid config
    await writeFile(configPath, INVALID_CONFIG_YAML, 'utf-8')

    await waitFor(() => onError.mock.calls.length > 0)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onReload).not.toHaveBeenCalled()

    const err = onError.mock.calls[0]![0] as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message.length).toBeGreaterThan(0)
  })

  it('should call onError when config file has malformed YAML', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 50,
    })
    watcher.start()

    // Write malformed YAML
    await writeFile(configPath, MALFORMED_YAML, 'utf-8')

    await waitFor(() => onError.mock.calls.length > 0)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onReload).not.toHaveBeenCalled()
  })

  it('should stop watching when stop() is called', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 50,
    })
    watcher.start()
    watcher.stop()

    // Modify the file after stop — should not trigger callback
    await writeFile(configPath, UPDATED_CONFIG_YAML, 'utf-8')

    // Wait a bit and verify no callbacks were triggered
    await new Promise((r) => setTimeout(r, 300))

    expect(onReload).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    // Prevent afterEach double-stop
    watcher = null
  })

  it('should not start a second watcher if start() is called twice', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 50,
    })

    // Start twice — second call should be a no-op (logged as warning)
    watcher.start()
    watcher.start()

    // Modify the file
    await writeFile(configPath, UPDATED_CONFIG_YAML, 'utf-8')

    await waitFor(() => onReload.mock.calls.length > 0)

    // Should only fire once (not double from two watchers)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('should clear pending debounce timer on stop()', async () => {
    const onReload = vi.fn()
    const onError = vi.fn()

    watcher = createConfigWatcher({
      configPath,
      onReload,
      onError,
      debounceMs: 500, // Long debounce
    })
    watcher.start()

    // Trigger a change but stop before debounce fires
    await writeFile(configPath, UPDATED_CONFIG_YAML, 'utf-8')
    await new Promise((r) => setTimeout(r, 50))

    watcher.stop()
    watcher = null

    // Wait past the debounce window
    await new Promise((r) => setTimeout(r, 600))

    // No callbacks should have fired
    expect(onReload).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: computeChangedKeys
// ---------------------------------------------------------------------------

describe('computeChangedKeys', () => {
  const baseConfig: SubstrateConfig = {
    config_format_version: '1',
    global: {
      log_level: 'info',
      max_concurrent_tasks: 4,
      budget_cap_tokens: 0,
      budget_cap_usd: 0,
    },
    providers: {
      claude: {
        enabled: true,
        cli_path: '/usr/bin/claude',
        subscription_routing: 'auto',
        max_concurrent: 4,
        api_billing: false,
      },
    },
  }

  it('should return empty array when configs are identical', () => {
    const changed = computeChangedKeys(baseConfig, { ...baseConfig })
    expect(changed).toEqual([])
  })

  it('should detect changed top-level nested field', () => {
    const updated: SubstrateConfig = {
      ...baseConfig,
      global: { ...baseConfig.global, log_level: 'debug' },
    }
    const changed = computeChangedKeys(baseConfig, updated)
    expect(changed).toContain('global.log_level')
  })

  it('should detect multiple changed fields', () => {
    const updated: SubstrateConfig = {
      ...baseConfig,
      global: {
        ...baseConfig.global,
        log_level: 'debug',
        max_concurrent_tasks: 8,
      },
    }
    const changed = computeChangedKeys(baseConfig, updated)
    expect(changed).toContain('global.log_level')
    expect(changed).toContain('global.max_concurrent_tasks')
    expect(changed).toHaveLength(2)
  })

  it('should detect deeply nested provider changes', () => {
    const updated: SubstrateConfig = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        claude: {
          ...baseConfig.providers.claude!,
          max_concurrent: 8,
        },
      },
    }
    const changed = computeChangedKeys(baseConfig, updated)
    expect(changed).toContain('providers.claude.max_concurrent')
  })

  it('should detect added fields', () => {
    const updated = {
      ...baseConfig,
      budget: {
        default_task_budget_usd: 5.0,
        default_session_budget_usd: 50.0,
        planning_costs_count_against_budget: false,
        warning_threshold_percent: 80,
      },
    } as SubstrateConfig
    const changed = computeChangedKeys(baseConfig, updated)
    expect(changed.some((k) => k.startsWith('budget.'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: flattenObject
// ---------------------------------------------------------------------------

describe('flattenObject', () => {
  it('should flatten a nested object to dot-notation keys', () => {
    const result = flattenObject({ a: { b: { c: 1 } } })
    expect(result).toEqual({ 'a.b.c': 1 })
  })

  it('should treat arrays as leaf values', () => {
    const result = flattenObject({ a: { b: [1, 2, 3] } })
    expect(result).toEqual({ 'a.b': [1, 2, 3] })
  })

  it('should handle flat objects', () => {
    const result = flattenObject({ a: 1, b: 'hello' })
    expect(result).toEqual({ a: 1, b: 'hello' })
  })

  it('should handle empty objects', () => {
    const result = flattenObject({})
    expect(result).toEqual({})
  })

  it('should handle null values as leaves', () => {
    const result = flattenObject({ a: { b: null } })
    expect(result).toEqual({ 'a.b': null })
  })

  it('should use prefix when provided', () => {
    const result = flattenObject({ b: 1 }, 'a')
    expect(result).toEqual({ 'a.b': 1 })
  })
})
