/**
 * Unit tests for TwinManager Docker Compose orchestration.
 *
 * Story 47-2.
 *
 * Mock strategy:
 *   - node:child_process → vi.mock to avoid real Docker
 *   - node:fs → vi.mock to avoid real filesystem writes
 *   - node:os + node:path → real (tmpdir returns a real path; path.join is pure logic)
 *   - fetch → vi.stubGlobal to mock health check polling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTwinManager, TwinError } from '../docker-compose.js'
import type { TwinDefinition } from '../types.js'

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked functions after vi.mock declarations
// ---------------------------------------------------------------------------

// Using dynamic imports after mocking to get the mocked versions
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeTwin(overrides?: Partial<TwinDefinition>): TwinDefinition {
  return {
    name: 'localstack',
    image: 'localstack/localstack',
    ports: [{ host: 4566, container: 4566 }],
    environment: { SERVICES: 's3' },
    ...overrides,
  }
}

function makeHealthyTwin(): TwinDefinition {
  return makeTwin({
    healthcheck: { url: 'http://localhost:4566/_localstack/health' },
  })
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks()
  // Default: execSync succeeds (no-op)
  vi.mocked(execSync).mockReturnValue(Buffer.from(''))
  // Default: fs functions are no-ops
  vi.mocked(mkdirSync).mockReturnValue(undefined)
  vi.mocked(writeFileSync).mockReturnValue(undefined)
  vi.mocked(rmSync).mockReturnValue(undefined)
  // Default: fetch returns 200
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response))
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TwinManager — Docker Compose orchestration', () => {
  // AC1: verify execSync is called with 'docker compose up -d' and compose file is written
  it('AC1: calls docker compose up -d and writes compose file', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin()

    await manager.start([twin])

    // docker info check
    expect(execSync).toHaveBeenCalledWith('docker info', { stdio: 'ignore' })
    // compose file written
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('docker-compose.yml'),
      expect.stringContaining('localstack'),
      'utf-8'
    )
    // docker compose up -d
    expect(execSync).toHaveBeenCalledWith(
      'docker compose up -d',
      expect.objectContaining({ stdio: 'pipe' })
    )
  })

  // AC2: generated YAML contains correct service mapping
  it('AC2: generated YAML has correct image, port mapping, and environment', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin()

    await manager.start([twin])

    const writeCall = vi.mocked(writeFileSync).mock.calls[0]
    expect(writeCall).toBeDefined()
    const yamlContent = writeCall![1] as string

    expect(yamlContent).toContain('localstack/localstack')
    expect(yamlContent).toContain('"4566:4566"')
    expect(yamlContent).toContain('SERVICES: s3')
  })

  // AC3: health check polling retries until success
  it('AC3: polls health endpoint and resolves after 2nd successful attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus, { healthIntervalMs: 0 })
    const twin = makeHealthyTwin()

    await expect(manager.start([twin])).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // AC3 timeout: all health check attempts fail → throws TwinError
  it('AC3 timeout: throws TwinError when health check exhausts all attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)

    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus, {
      maxHealthAttempts: 3,
      healthIntervalMs: 0,
    })
    const twin = makeHealthyTwin()

    // Single call — capture error and assert type + message in one block
    const error = (await manager.start([twin]).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(TwinError)
    expect(error.message).toBe("Twin 'localstack' failed health check after 3 attempts")
  })

  // AC4: Docker not installed → throws descriptive TwinError
  it('AC4: throws TwinError("Docker not found") when docker info fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if ((cmd as string) === 'docker info') throw new Error('docker: command not found')
      return Buffer.from('')
    })

    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)

    // Single call — capture error and assert type + message in one block
    const error = (await manager.start([makeTwin()]).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(TwinError)
    expect(error.message).toBe('Docker not found — twins require Docker')
  })

  // AC5: twin:started event emitted per twin with correct payload
  it('AC5: emits twin:started with correct twinName, ports, and healthStatus', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin()

    await manager.start([twin])

    expect(eventBus.emit).toHaveBeenCalledWith('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
    })
  })

  // AC5: twin:started emitted for each twin when multiple twins started
  it('AC5: emits twin:started for each twin in the array', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin1 = makeTwin({ name: 'localstack', image: 'localstack/localstack' })
    const twin2 = makeTwin({
      name: 'redis',
      image: 'redis:7',
      ports: [{ host: 6379, container: 6379 }],
    })

    await manager.start([twin1, twin2])

    expect(eventBus.emit).toHaveBeenCalledTimes(2)
    expect(eventBus.emit).toHaveBeenCalledWith(
      'twin:started',
      expect.objectContaining({ twinName: 'localstack' })
    )
    expect(eventBus.emit).toHaveBeenCalledWith(
      'twin:started',
      expect.objectContaining({ twinName: 'redis' })
    )
  })

  // AC6: stop() executes docker compose down --remove-orphans
  it('AC6: stop() calls docker compose down --remove-orphans', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin()

    await manager.start([twin])
    vi.mocked(execSync).mockClear()
    await manager.stop()

    expect(execSync).toHaveBeenCalledWith(
      'docker compose down --remove-orphans',
      expect.objectContaining({ stdio: 'pipe' })
    )
  })

  // AC6 cleanup: stop() deletes the temp compose directory
  it('AC6 cleanup: stop() calls fs.rmSync on the compose temp dir', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin()

    // Capture the temp dir from mkdirSync
    let capturedDir: string | undefined
    vi.mocked(mkdirSync).mockImplementation((dir) => {
      capturedDir = dir as string
      return undefined
    })

    await manager.start([twin])
    await manager.stop()

    expect(capturedDir).toBeDefined()
    expect(rmSync).toHaveBeenCalledWith(capturedDir, { recursive: true, force: true })
  })

  // AC6: stop() emits twin:stopped for each started twin
  it('AC6: stop() emits twin:stopped for each started twin', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin()

    await manager.start([twin])
    eventBus.emit.mockClear()
    await manager.stop()

    expect(eventBus.emit).toHaveBeenCalledWith('twin:stopped', { twinName: 'localstack' })
  })

  // AC7: createTwinManager is a function and TwinError is a class
  it('AC7: createTwinManager is a function and TwinError is a constructor', () => {
    expect(typeof createTwinManager).toBe('function')
    expect(typeof TwinError).toBe('function')
  })

  // AC7: createTwinManager returns an object with start() and stop() methods
  it('AC7: createTwinManager returns TwinManager with start() and stop()', () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)

    expect(typeof manager.start).toBe('function')
    expect(typeof manager.stop).toBe('function')
  })

  // No-op stop: stop() before start() does not throw and does not call execSync
  it('no-op stop: stop() before start() is a no-op', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)

    await expect(manager.stop()).resolves.toBeUndefined()
    expect(execSync).not.toHaveBeenCalled()
    expect(rmSync).not.toHaveBeenCalled()
  })

  // TwinError: has correct name and message
  it('TwinError: name is "TwinError" and message is preserved', () => {
    const error = new TwinError('test error message')

    expect(error.name).toBe('TwinError')
    expect(error.message).toBe('test error message')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(TwinError)
  })

  // AC3: no health check defined → start() resolves immediately without polling
  it('AC3: twin without healthcheck resolves without polling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    const twin = makeTwin() // no healthcheck property

    await expect(manager.start([twin])).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // AC2: compose file uses version 3.8
  it('AC2: generated YAML has version 3.8', async () => {
    const eventBus = makeEventBus()
    const manager = createTwinManager(eventBus)
    await manager.start([makeTwin()])

    const yamlContent = vi.mocked(writeFileSync).mock.calls[0]![1] as string
    expect(yamlContent).toContain("version: '3.8'")
  })
})
