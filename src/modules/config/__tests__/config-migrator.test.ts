/**
 * Unit tests for config-migrator.ts (AC: #4, #5)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ConfigMigrator } from '../config-migrator.js'

// ---------------------------------------------------------------------------
// Helper: create a fresh migrator (do not use the singleton in unit tests)
// ---------------------------------------------------------------------------

let migrator: ConfigMigrator

beforeEach(() => {
  migrator = new ConfigMigrator()
})

// ---------------------------------------------------------------------------
// No-op migration (same version)
// ---------------------------------------------------------------------------

describe('ConfigMigrator.migrate — no-op (same version)', () => {
  it('returns success=true when fromVersion equals toVersion', () => {
    const config = { config_format_version: '1', global: { log_level: 'info' } }
    const { result } = migrator.migrate(config, '1', '1')
    expect(result.success).toBe(true)
  })

  it('returns empty migratedKeys when no migration needed', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '1')
    expect(result.migratedKeys).toHaveLength(0)
  })

  it('returns null backupPath for no-op migration', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '1')
    expect(result.backupPath).toBeNull()
  })

  it('returns the original config object unchanged', () => {
    const config = { config_format_version: '1', global: { log_level: 'info' } }
    const { config: migrated } = migrator.migrate(config, '1', '1')
    expect(migrated).toEqual(config)
  })
})

// ---------------------------------------------------------------------------
// Single step migration
// ---------------------------------------------------------------------------

describe('ConfigMigrator.migrate — single step', () => {
  beforeEach(() => {
    migrator.register('1->2', (cfg) => {
      const c = cfg as Record<string, unknown>
      return { ...c, config_format_version: '2', new_field: 'added' }
    })
  })

  it('returns success=true after single step migration', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '2')
    expect(result.success).toBe(true)
  })

  it('applies the migration transformation', () => {
    const config = { config_format_version: '1' }
    const { config: migrated } = migrator.migrate(config, '1', '2')
    const m = migrated as Record<string, unknown>
    expect(m['new_field']).toBe('added')
    expect(m['config_format_version']).toBe('2')
  })

  it('records correct fromVersion and toVersion', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '2')
    expect(result.fromVersion).toBe('1')
    expect(result.toVersion).toBe('2')
  })

  it('reports migratedKeys that changed', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '2')
    expect(result.migratedKeys).toContain('new_field')
  })
})

// ---------------------------------------------------------------------------
// Multi-step migration
// ---------------------------------------------------------------------------

describe('ConfigMigrator.migrate — multi-step', () => {
  beforeEach(() => {
    migrator.register('1->2', (cfg) => {
      const c = cfg as Record<string, unknown>
      return { ...c, config_format_version: '2', step1: true }
    })
    migrator.register('2->3', (cfg) => {
      const c = cfg as Record<string, unknown>
      return { ...c, config_format_version: '3', step2: true }
    })
  })

  it('returns success=true after multi-step migration', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '3')
    expect(result.success).toBe(true)
  })

  it('applies all intermediate transformations in sequence', () => {
    const config = { config_format_version: '1' }
    const { config: migrated } = migrator.migrate(config, '1', '3')
    const m = migrated as Record<string, unknown>
    expect(m['step1']).toBe(true)
    expect(m['step2']).toBe(true)
    expect(m['config_format_version']).toBe('3')
  })

  it('records final fromVersion and toVersion', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '3')
    expect(result.fromVersion).toBe('1')
    expect(result.toVersion).toBe('3')
  })
})

// ---------------------------------------------------------------------------
// Missing step
// ---------------------------------------------------------------------------

describe('ConfigMigrator.migrate — missing step', () => {
  it('returns success=false when step is missing', () => {
    // Register 1->2 but not 2->3
    migrator.register('1->2', (cfg) => cfg)
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '3')
    expect(result.success).toBe(false)
  })

  it('includes a message about the missing step', () => {
    migrator.register('1->2', (cfg) => cfg)
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '3')
    expect(result.manualStepsRequired.length).toBeGreaterThan(0)
    const msg = result.manualStepsRequired.join(' ')
    expect(msg).toContain('2->3')
  })

  it('returns success=false when no steps are registered', () => {
    const config = { config_format_version: '1' }
    const { result } = migrator.migrate(config, '1', '2')
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// canMigrate
// ---------------------------------------------------------------------------

describe('ConfigMigrator.canMigrate', () => {
  it('returns true when fromVersion === toVersion', () => {
    expect(migrator.canMigrate('1', '1')).toBe(true)
  })

  it('returns true when the required step is registered', () => {
    migrator.register('1->2', (cfg) => cfg)
    expect(migrator.canMigrate('1', '2')).toBe(true)
  })

  it('returns false when the required step is missing', () => {
    expect(migrator.canMigrate('1', '2')).toBe(false)
  })

  it('returns true for multi-step when all steps are registered', () => {
    migrator.register('1->2', (cfg) => cfg)
    migrator.register('2->3', (cfg) => cfg)
    expect(migrator.canMigrate('1', '3')).toBe(true)
  })

  it('returns false for multi-step when an intermediate step is missing', () => {
    migrator.register('1->2', (cfg) => cfg)
    // missing '2->3'
    expect(migrator.canMigrate('1', '3')).toBe(false)
  })

  it('returns false when trying to migrate backwards', () => {
    migrator.register('2->1', (cfg) => cfg)
    expect(migrator.canMigrate('2', '1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// register
// ---------------------------------------------------------------------------

describe('ConfigMigrator.register', () => {
  it('stores the migration function for retrieval', () => {
    const fn = (cfg: unknown) => cfg
    migrator.register('1->2', fn)
    expect(migrator.canMigrate('1', '2')).toBe(true)
  })

  it('overwrites an existing migration for the same key', () => {
    const fn1 = (cfg: unknown) => ({ ...(cfg as object), v: 'first' })
    const fn2 = (cfg: unknown) => ({ ...(cfg as object), v: 'second' })
    migrator.register('1->2', fn1)
    migrator.register('1->2', fn2)
    const { config: migrated } = migrator.migrate({}, '1', '2')
    expect((migrated as Record<string, unknown>)['v']).toBe('second')
  })
})
