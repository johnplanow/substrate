/**
 * Unit tests for the `twins start`, `stop`, `status`, and `list` CLI command logic.
 *
 * Follows the same extracted-helper pattern used in templates-cli.test.ts (story 47-4):
 * action logic is replicated as standalone async functions so Commander overhead and
 * `process.exit` are avoided.  All external dependencies are mocked.
 *
 * Story 47-5 — Task 7.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TwinDefinition } from '../types.js'
import type { TwinRunState } from '../run-state.js'

// ---------------------------------------------------------------------------
// Module-level mocks — vi.mock is hoisted above imports by vitest
// ---------------------------------------------------------------------------

vi.mock('../index.js', () => ({
  createTwinRegistry: vi.fn(),
  getTwinTemplate: vi.fn(),
  listTwinTemplates: vi.fn().mockReturnValue([]),
}))

vi.mock('../docker-compose.js', () => {
  class TwinError extends Error {
    constructor(msg: string) {
      super(msg)
      this.name = 'TwinError'
    }
  }
  return {
    createTwinManager: vi.fn(),
    TwinError,
  }
})

vi.mock('../run-state.js', () => ({
  readRunState: vi.fn(),
  writeRunState: vi.fn().mockResolvedValue(undefined),
  clearRunState: vi.fn().mockResolvedValue(undefined),
  runStatePath: vi.fn().mockReturnValue('/project/.substrate/twins/.run-state.json'),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked functions after vi.mock declarations
// ---------------------------------------------------------------------------

import { createTwinRegistry } from '../index.js'
import { createTwinManager, TwinError } from '../docker-compose.js'
import { readRunState, writeRunState, clearRunState } from '../run-state.js'
import { execSync } from 'node:child_process'
import { rmSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Helpers — mirror factory-command.ts action handlers
// ---------------------------------------------------------------------------

interface ActionResult {
  exitCode: number
  stdout: string
  stderr: string
}

function makeTwin(name: string = 'localstack', image?: string): TwinDefinition {
  return {
    name,
    image: image ?? `${name}/image:latest`,
    ports: [{ host: 4566, container: 4566 }],
    environment: {},
  }
}

function makeRunState(twinNames: string[] = ['localstack']): TwinRunState {
  return {
    composeDir: '/tmp/compose-dir',
    twinNames,
    startedAt: '2026-03-23T12:00:00.000Z',
  }
}

function makeRegistry(twins: TwinDefinition[] = []) {
  return {
    discover: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue(twins),
    get: vi.fn(),
    pollHealth: vi.fn(),
  }
}

function makeManager(composeDir: string = '/tmp/compose-dir') {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getComposeDir: vi.fn().mockReturnValue(composeDir),
  }
}

/** Mirrors the `twins start` action handler */
async function startTwinsAction(projectDir: string): Promise<ActionResult> {
  let stdout = ''
  let stderr = ''

  const twinsDir = `${projectDir}/.substrate/twins`

  const registry = createTwinRegistry()
  try {
    await (registry as unknown as ReturnType<typeof makeRegistry>).discover(twinsDir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr = `Error: ${msg}\n`
    return { exitCode: 1, stdout, stderr }
  }

  const twins = (registry as unknown as ReturnType<typeof makeRegistry>).list()
  if (twins.length === 0) {
    stderr = 'No twin definitions found in .substrate/twins/\n'
    return { exitCode: 1, stdout, stderr }
  }

  // Use a real-ish event bus that captures and fires listeners so that the
  // twin:started listener path is exercised — mirrors TypedEventBusImpl behaviour
  type Handler = (e: Record<string, unknown>) => void
  const listenerMap = new Map<string, Handler[]>()
  const eventBus = {
    emit: vi.fn((event: string, payload: Record<string, unknown>) => {
      for (const h of listenerMap.get(event) ?? []) h(payload)
    }),
    on: vi.fn((event: string, handler: Handler) => {
      listenerMap.set(event, [...(listenerMap.get(event) ?? []), handler])
    }),
    off: vi.fn(),
  }

  // Register twin:started listener — mirrors the real action handler
  eventBus.on('twin:started', (e) => {
    stdout += `  Started: ${e.twinName as string}\n`
  })

  const manager = createTwinManager(eventBus as never)

  try {
    await (manager as ReturnType<typeof makeManager>).start(twins)
    // Simulate the twin:started events that the real TwinManager emits per twin
    for (const twin of twins) {
      eventBus.emit('twin:started', { twinName: twin.name })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stderr = `Error: ${msg}\n`
    return { exitCode: 1, stdout, stderr }
  }

  const composeDir = (manager as ReturnType<typeof makeManager>).getComposeDir()!
  await writeRunState(projectDir, {
    composeDir,
    twinNames: twins.map((t: TwinDefinition) => t.name),
    startedAt: new Date().toISOString(),
  })

  stdout += '\nAll twins started successfully.\n'
  return { exitCode: 0, stdout, stderr }
}

/** Mirrors the `twins stop` action handler */
async function stopTwinsAction(projectDir: string): Promise<ActionResult> {
  let stdout = ''
  let stderr = ''

  const state = await readRunState(projectDir)
  if (!state) {
    stderr = 'No twins are currently running\n'
    return { exitCode: 1, stdout, stderr }
  }

  try {
    execSync('docker compose down --remove-orphans', {
      cwd: state.composeDir,
      stdio: 'pipe',
    })
  } catch {
    // Best-effort shutdown; still proceed to cleanup
  }

  rmSync(state.composeDir, { recursive: true, force: true })
  await clearRunState(projectDir)

  stdout = `Stopped twins: ${state.twinNames.join(', ')}\n`
  return { exitCode: 0, stdout, stderr }
}

/** Mirrors the `twins status` action handler */
async function statusTwinsAction(projectDir: string): Promise<ActionResult> {
  let stdout = ''
  let stderr = ''

  const state = await readRunState(projectDir)
  const runningNames = new Set(state?.twinNames ?? [])

  const registry = createTwinRegistry()
  let twins: TwinDefinition[] = []
  try {
    await (registry as unknown as ReturnType<typeof makeRegistry>).discover(
      `${projectDir}/.substrate/twins`,
    )
    twins = (registry as unknown as ReturnType<typeof makeRegistry>).list()
  } catch {
    // Discovery failure — show empty list
  }

  if (twins.length === 0) {
    stdout = 'No twin definitions found in .substrate/twins/\n'
    return { exitCode: 0, stdout, stderr }
  }

  for (const twin of twins) {
    const status = runningNames.has(twin.name) ? 'running' : 'stopped'
    const portsStr =
      twin.ports.length > 0
        ? twin.ports.map((p) => `${p.host}:${p.container}`).join(', ')
        : '—'
    stdout += `  ${twin.name.padEnd(20)}  ${status.padEnd(10)}  ${portsStr}\n`
  }

  return { exitCode: 0, stdout, stderr }
}

/** Mirrors the `twins list` action handler */
async function listTwinsAction(projectDir: string): Promise<ActionResult> {
  let stdout = ''
  let stderr = ''

  const registry = createTwinRegistry()
  let twins: TwinDefinition[] = []
  try {
    await (registry as unknown as ReturnType<typeof makeRegistry>).discover(
      `${projectDir}/.substrate/twins`,
    )
    twins = (registry as unknown as ReturnType<typeof makeRegistry>).list()
  } catch {
    // Discovery failure — treat as no twins found
  }

  if (twins.length === 0) {
    stdout = 'No twin definitions found in .substrate/twins/\n'
    return { exitCode: 0, stdout, stderr }
  }

  stdout +=
    '  NAME                 IMAGE                                  PORTS           HEALTHCHECK\n'
  for (const twin of twins) {
    const ports =
      twin.ports.length > 0
        ? twin.ports.map((p) => `${p.host}:${p.container}`).join(', ')
        : '—'
    const healthcheck = twin.healthcheck?.url ?? '—'
    stdout += `  ${twin.name.padEnd(20)}  ${twin.image.padEnd(38)}  ${ports.padEnd(16)}  ${healthcheck}\n`
  }

  return { exitCode: 0, stdout, stderr }
}

// ---------------------------------------------------------------------------
// beforeEach: reset all mocks
// ---------------------------------------------------------------------------

const PROJECT_DIR = '/test/project'

beforeEach(() => {
  vi.resetAllMocks()
  // Restore default mock implementations that resetAllMocks clears
  vi.mocked(writeRunState).mockResolvedValue(undefined)
  vi.mocked(clearRunState).mockResolvedValue(undefined)
  vi.mocked(execSync).mockReturnValue(Buffer.from(''))
  vi.mocked(rmSync).mockReturnValue(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('twins start — happy path', () => {
  it('calls manager.start() with discovered twins and writes run state', async () => {
    const twin = makeTwin('localstack')
    const registry = makeRegistry([twin])
    const manager = makeManager('/tmp/compose-abc')

    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)
    vi.mocked(createTwinManager).mockReturnValue(manager as never)

    const result = await startTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(0)
    expect(manager.start).toHaveBeenCalledWith([twin])
    expect(writeRunState).toHaveBeenCalledWith(
      PROJECT_DIR,
      expect.objectContaining({ twinNames: ['localstack'], composeDir: '/tmp/compose-abc' }),
    )
    expect(result.stdout).toContain('Started: localstack')
    expect(result.stdout).toContain('All twins started successfully')
  })
})

describe('twins start — no twins found', () => {
  it('exits with code 1 when registry.list() returns empty array', async () => {
    const registry = makeRegistry([])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await startTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('No twin definitions found in .substrate/twins/')
    expect(writeRunState).not.toHaveBeenCalled()
  })
})

describe('twins start — manager.start() throws TwinError', () => {
  it('exits with code 1 and writes error message to stderr', async () => {
    const twin = makeTwin()
    const registry = makeRegistry([twin])
    const manager = makeManager()
    vi.mocked(manager.start).mockRejectedValue(new TwinError('Docker not found'))

    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)
    vi.mocked(createTwinManager).mockReturnValue(manager as never)

    const result = await startTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Docker not found')
    expect(writeRunState).not.toHaveBeenCalled()
  })
})

describe('twins stop — happy path', () => {
  it('executes docker compose down and calls clearRunState', async () => {
    const state = makeRunState(['localstack', 'wiremock'])
    vi.mocked(readRunState).mockResolvedValue(state)

    const result = await stopTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(0)
    expect(execSync).toHaveBeenCalledWith('docker compose down --remove-orphans', {
      cwd: state.composeDir,
      stdio: 'pipe',
    })
    expect(rmSync).toHaveBeenCalledWith(state.composeDir, { recursive: true, force: true })
    expect(clearRunState).toHaveBeenCalledWith(PROJECT_DIR)
    expect(result.stdout).toContain('localstack')
    expect(result.stdout).toContain('wiremock')
  })
})

describe('twins stop — no run state', () => {
  it('exits with code 1 when readRunState returns null', async () => {
    vi.mocked(readRunState).mockResolvedValue(null)

    const result = await stopTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('No twins are currently running')
    expect(execSync).not.toHaveBeenCalled()
    expect(clearRunState).not.toHaveBeenCalled()
  })
})

describe('twins status — running', () => {
  it('shows "running" for twins listed in run state', async () => {
    const state = makeRunState(['localstack'])
    vi.mocked(readRunState).mockResolvedValue(state)

    const twin = makeTwin('localstack')
    const registry = makeRegistry([twin])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await statusTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('running')
    expect(result.stdout).toContain('localstack')
  })
})

describe('twins status — stopped', () => {
  it('shows "stopped" when readRunState returns null', async () => {
    vi.mocked(readRunState).mockResolvedValue(null)

    const twin = makeTwin('localstack')
    const registry = makeRegistry([twin])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await statusTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('stopped')
  })
})

describe('twins list — happy path', () => {
  it('shows both twin names and images in output', async () => {
    const twin1 = makeTwin('localstack', 'localstack/localstack:latest')
    const twin2 = makeTwin('wiremock', 'wiremock/wiremock:latest')
    const registry = makeRegistry([twin1, twin2])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await listTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('localstack')
    expect(result.stdout).toContain('localstack/localstack:latest')
    expect(result.stdout).toContain('wiremock')
    expect(result.stdout).toContain('wiremock/wiremock:latest')
  })

  it('includes a healthcheck URL when configured', async () => {
    const twin: TwinDefinition = {
      name: 'localstack',
      image: 'localstack/localstack:latest',
      ports: [{ host: 4566, container: 4566 }],
      environment: {},
      healthcheck: { url: 'http://localhost:4566/_localstack/health' },
    }
    const registry = makeRegistry([twin])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await listTwinsAction(PROJECT_DIR)

    expect(result.stdout).toContain('http://localhost:4566/_localstack/health')
  })

  it('shows — for healthcheck when no healthcheck is configured', async () => {
    const twin = makeTwin('localstack') // no healthcheck
    const registry = makeRegistry([twin])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await listTwinsAction(PROJECT_DIR)

    expect(result.stdout).toContain('—')
  })
})

describe('twins list — no twins', () => {
  it('shows no-twins message when registry discovers nothing', async () => {
    const registry = makeRegistry([])
    vi.mocked(createTwinRegistry).mockReturnValue(registry as never)

    const result = await listTwinsAction(PROJECT_DIR)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('No twin definitions found')
  })
})
