/**
 * Unit tests for TwinRegistry — discovery, validation, and health polling.
 *
 * Story 47-1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createTwinRegistry } from '../registry.js'
import { TwinDefinitionError, TwinRegistryError } from '../types.js'
import type { TwinDefinition } from '../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string

async function writeTwin(dir: string, filename: string, content: string): Promise<void> {
  await writeFile(join(dir, filename), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = join(tmpdir(), randomUUID())
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AC1: YAML Discovery and Full-Field Parsing
// ---------------------------------------------------------------------------

describe('AC1: YAML discovery and full-field parsing', () => {
  it('parses a full-field YAML twin definition correctly', async () => {
    await writeTwin(
      testDir,
      'stripe.yaml',
      `
name: stripe
image: stripe/stripe-mock:latest
ports:
  - "12111:12111"
environment:
  STRIPE_MOCK_PORT: "12111"
healthcheck:
  url: "http://localhost:12111/v1/charges"
  interval_ms: 500
  timeout_ms: 10000
`,
    )

    const registry = createTwinRegistry()
    await registry.discover(testDir)

    const list = registry.list()
    expect(list).toHaveLength(1)

    const twin = list[0]!
    expect(twin.name).toBe('stripe')
    expect(twin.image).toBe('stripe/stripe-mock:latest')
    expect(twin.ports).toEqual([{ host: 12111, container: 12111 }])
    expect(twin.environment).toEqual({ STRIPE_MOCK_PORT: '12111' })
    expect(twin.healthcheck).toEqual({
      url: 'http://localhost:12111/v1/charges',
      interval_ms: 500,
      timeout_ms: 10000,
    })
  })

  it('list() returns exactly one entry matching the file contents', async () => {
    await writeTwin(testDir, 'postgres.yaml', `name: postgres\nimage: postgres:16\n`)

    const registry = createTwinRegistry()
    await registry.discover(testDir)

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]!.name).toBe('postgres')
    expect(registry.list()[0]!.image).toBe('postgres:16')
  })

  it('get() returns the correct definition by name', async () => {
    await writeTwin(testDir, 'stripe.yaml', `name: stripe\nimage: stripe/stripe-mock:latest\n`)

    const registry = createTwinRegistry()
    await registry.discover(testDir)

    const twin = registry.get('stripe')
    expect(twin).toBeDefined()
    expect(twin!.name).toBe('stripe')
    expect(twin!.image).toBe('stripe/stripe-mock:latest')
  })
})

// ---------------------------------------------------------------------------
// AC2: Required Field Validation — Descriptive Error on Missing Fields
// ---------------------------------------------------------------------------

describe('AC2: required field validation', () => {
  it('throws TwinDefinitionError with file path when "name" is missing', async () => {
    await writeTwin(testDir, 'bad.yaml', `image: postgres:16\n`)

    const registry = createTwinRegistry()
    await expect(registry.discover(testDir)).rejects.toThrow(TwinDefinitionError)
    await expect(registry.discover(testDir)).rejects.toThrow(/missing required field: name/)
    await expect(registry.discover(testDir)).rejects.toThrow(/bad\.yaml/)
  })

  it('throws TwinDefinitionError with file path when "image" is missing', async () => {
    await writeTwin(testDir, 'bad.yaml', `name: postgres\n`)

    const registry = createTwinRegistry()
    await expect(registry.discover(testDir)).rejects.toThrow(TwinDefinitionError)
    await expect(registry.discover(testDir)).rejects.toThrow(/missing required field: image/)
    await expect(registry.discover(testDir)).rejects.toThrow(/bad\.yaml/)
  })
})

// ---------------------------------------------------------------------------
// AC3: Malformed YAML and Unknown Field Detection
// ---------------------------------------------------------------------------

describe('AC3: malformed YAML and unknown field detection', () => {
  it('throws TwinDefinitionError on syntactically invalid YAML', async () => {
    await writeTwin(testDir, 'invalid.yaml', `name: [unclosed bracket\nimage: test:latest\n`)

    const registry = createTwinRegistry()
    await expect(registry.discover(testDir)).rejects.toThrow(TwinDefinitionError)
    await expect(registry.discover(testDir)).rejects.toThrow(/invalid\.yaml/)
  })

  it('throws TwinDefinitionError on unrecognised top-level field', async () => {
    await writeTwin(
      testDir,
      'unknown-field.yaml',
      `name: test\nimage: test:latest\nunknownField: oops\n`,
    )

    const registry = createTwinRegistry()
    await expect(registry.discover(testDir)).rejects.toThrow(TwinDefinitionError)
    await expect(registry.discover(testDir)).rejects.toThrow(/unknown-field\.yaml/)
  })

  it('still discovers valid sibling files in the SAME directory when one file is invalid', async () => {
    // Both files in the same temp directory: bad.yaml (invalid YAML) and valid.yaml
    await writeTwin(testDir, 'bad.yaml', `name: [unclosed`)
    await writeTwin(testDir, 'valid.yaml', `name: postgres\nimage: postgres:16\n`)

    const registry = createTwinRegistry()
    let thrownError: Error | undefined
    try {
      await registry.discover(testDir)
    } catch (err) {
      thrownError = err as Error
    }

    // The bad.yaml should cause a TwinDefinitionError to be thrown
    expect(thrownError).toBeInstanceOf(TwinDefinitionError)

    // The valid sibling in the same directory must still be present in the registry (AC3 fail-soft)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]!.name).toBe('postgres')
  })
})

// ---------------------------------------------------------------------------
// AC4: Duplicate Twin Name Detection
// ---------------------------------------------------------------------------

describe('AC4: duplicate twin name detection', () => {
  it('throws TwinRegistryError mentioning both file paths when duplicate names are found', async () => {
    await writeTwin(testDir, 'postgres-a.yaml', `name: postgres\nimage: postgres:16\n`)
    await writeTwin(testDir, 'postgres-b.yaml', `name: postgres\nimage: postgres:15\n`)

    const registry = createTwinRegistry()
    let thrownError: Error | undefined
    try {
      await registry.discover(testDir)
    } catch (err) {
      thrownError = err as Error
    }

    expect(thrownError).toBeDefined()
    expect(thrownError).toBeInstanceOf(TwinRegistryError)
    expect(thrownError!.message).toMatch(/postgres/)
    expect(thrownError!.message).toMatch(/postgres-a\.yaml/)
    expect(thrownError!.message).toMatch(/postgres-b\.yaml/)
  })
})

// ---------------------------------------------------------------------------
// AC5: Port Mapping Parsed into Structured Objects
// ---------------------------------------------------------------------------

describe('AC5: port mapping parsing', () => {
  it('parses "5432:5432" into { host: 5432, container: 5432 }', async () => {
    await writeTwin(
      testDir,
      'postgres.yaml',
      `name: postgres\nimage: postgres:16\nports:\n  - "5432:5432"\n`,
    )

    const registry = createTwinRegistry()
    await registry.discover(testDir)

    const twin = registry.get('postgres')!
    expect(twin.ports).toEqual([{ host: 5432, container: 5432 }])
  })

  it('parses multiple port mappings correctly', async () => {
    await writeTwin(
      testDir,
      'postgres.yaml',
      `name: postgres\nimage: postgres:16\nports:\n  - "5432:5432"\n  - "5433:5433"\n`,
    )

    const registry = createTwinRegistry()
    await registry.discover(testDir)

    const twin = registry.get('postgres')!
    expect(twin.ports).toHaveLength(2)
    expect(twin.ports[0]).toEqual({ host: 5432, container: 5432 })
    expect(twin.ports[1]).toEqual({ host: 5433, container: 5433 })
  })
})

// ---------------------------------------------------------------------------
// AC6: Optional Fields Default Correctly
// ---------------------------------------------------------------------------

describe('AC6: optional fields default correctly', () => {
  it('parses a minimal definition (name + image only) without error', async () => {
    await writeTwin(testDir, 'minimal.yaml', `name: minimal\nimage: minimal:latest\n`)

    const registry = createTwinRegistry()
    await expect(registry.discover(testDir)).resolves.toBeUndefined()

    const twin = registry.get('minimal')
    expect(twin).toBeDefined()
  })

  it('applies correct defaults for missing optional fields', async () => {
    await writeTwin(testDir, 'minimal.yaml', `name: minimal\nimage: minimal:latest\n`)

    const registry = createTwinRegistry()
    await registry.discover(testDir)

    const twin = registry.get('minimal')!
    expect(twin.environment).toEqual({})
    expect(twin.ports).toEqual([])
    expect(twin.healthcheck).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC7: Health Endpoint Polling
// ---------------------------------------------------------------------------

describe('AC7: health endpoint polling', () => {
  it('resolves { healthy: true, attempts: 3 } when mockFetch returns 200 on 3rd call', async () => {
    const registry = createTwinRegistry()
    const twin: TwinDefinition = {
      name: 'test',
      image: 'test:latest',
      ports: [],
      environment: {},
      healthcheck: {
        url: 'http://localhost:9999/health',
        interval_ms: 10,
        timeout_ms: 500,
      },
    }

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) return { ok: false, status: 503 }
      return { ok: true, status: 200 }
    })

    const result = await registry.pollHealth(twin, { fetch: mockFetch as unknown as typeof fetch })
    expect(result).toEqual({ healthy: true, attempts: 3 })
  })

  it('resolves { healthy: false, error: "..." } when mockFetch always fails and timeout elapses', async () => {
    const registry = createTwinRegistry()
    const twin: TwinDefinition = {
      name: 'test',
      image: 'test:latest',
      ports: [],
      environment: {},
      healthcheck: {
        url: 'http://localhost:9999/health',
        interval_ms: 20,
        // Wider margin (500ms vs 100ms) avoids flakiness under CI load while keeping the test fast
        timeout_ms: 500,
      },
    }

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })

    const result = await registry.pollHealth(twin, { fetch: mockFetch as unknown as typeof fetch })
    expect(result).toEqual({
      healthy: false,
      error: 'Health check timed out after 500ms',
    })
  })

  it('resolves { healthy: true, attempts: 0 } when no healthcheck is defined', async () => {
    const registry = createTwinRegistry()
    const twin: TwinDefinition = {
      name: 'test',
      image: 'test:latest',
      ports: [],
      environment: {},
      // healthcheck is intentionally omitted
    }

    const result = await registry.pollHealth(twin)
    expect(result).toEqual({ healthy: true, attempts: 0 })
  })

  it('treats network errors (thrown exceptions) as non-2xx and continues polling', async () => {
    const registry = createTwinRegistry()
    const twin: TwinDefinition = {
      name: 'test',
      image: 'test:latest',
      ports: [],
      environment: {},
      healthcheck: {
        url: 'http://localhost:9999/health',
        interval_ms: 10,
        timeout_ms: 500,
      },
    }

    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount < 3) throw new Error('ECONNREFUSED')
      return { ok: true, status: 200 }
    })

    const result = await registry.pollHealth(twin, { fetch: mockFetch as unknown as typeof fetch })
    expect(result).toEqual({ healthy: true, attempts: 3 })
  })
})
