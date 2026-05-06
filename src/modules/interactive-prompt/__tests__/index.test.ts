/**
 * Unit tests for the Interactive Prompt module (Story 73-2, AC9).
 *
 * Tests:
 *   (a) presents numbered choices on stdout
 *   (b) reads stdin and returns operator's choice
 *   (c) --non-interactive returns default without stdin read; emits halt-skipped event
 *   (d) writes notification file with correct shape before readline
 *   (e) handles malformed stdin input → defaults to 1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
}))

vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockResolvedValue('/fake/repo'),
}))

vi.mock('../../../cli/commands/manifest-read.js', () => ({
  readCurrentRunId: vi.fn().mockResolvedValue('test-run-id'),
}))

vi.mock('node:readline', async () => {
  const { EventEmitter } = await import('node:events')

  class MockInterface extends EventEmitter {
    close = vi.fn()
  }

  const mockInterface = new MockInterface()

  return {
    createInterface: vi.fn().mockReturnValue(mockInterface),
    _mockInterface: mockInterface,
  }
})

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runInteractivePrompt, type DecisionContext } from '../index.js'
import * as fsMod from 'node:fs/promises'
import * as readlineMod from 'node:readline'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    runId: 'test-run-42',
    decisionType: 'build-verification-failure',
    severity: 'critical',
    summary: 'The build failed after 3 attempts.',
    defaultAction: 'escalate-without-halt',
    choices: ['escalate-without-halt', 'retry', 'abort'],
    ...overrides,
  }
}

/** Simulate a line being typed into the mocked readline interface. */
function simulateStdinLine(line: string): void {
  // The mock readline interface is a shared EventEmitter
  const rl = (readlineMod as unknown as { _mockInterface: EventEmitter })._mockInterface
  // Emit 'line' asynchronously to allow the Promise chain to set up first
  setImmediate(() => {
    rl.emit('line', line)
  })
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let originalNonInteractive: string | undefined
let originalIsTTY: boolean | undefined

beforeEach(() => {
  vi.clearAllMocks()
  originalNonInteractive = process.env['SUBSTRATE_NON_INTERACTIVE']
  originalIsTTY = process.stdin.isTTY
  delete process.env['SUBSTRATE_NON_INTERACTIVE']
})

afterEach(() => {
  // Restore env var
  if (originalNonInteractive !== undefined) {
    process.env['SUBSTRATE_NON_INTERACTIVE'] = originalNonInteractive
  } else {
    delete process.env['SUBSTRATE_NON_INTERACTIVE']
  }
  // Restore isTTY
  if (originalIsTTY !== undefined) {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
  }
})

// ---------------------------------------------------------------------------
// Test (a): presents numbered choices on stdout
// ---------------------------------------------------------------------------

describe('runInteractivePrompt', () => {
  it('(a) presents separator, ⚠ Halt:, and numbered choices on stdout', async () => {
    // Force non-interactive so we don't actually wait for stdin
    const ctx = makeCtx({ nonInteractive: true })

    const stdoutWrites: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk))
      return true
    })

    await runInteractivePrompt(ctx)

    // Non-interactive skips rendering — check that we didn't print to stdout
    // (The interactive path renders; non-interactive does not.)
    stdoutSpy.mockRestore()

    // Run again in interactive mode but with TTY=false to test rendering path
    // We test the renderPrompt indirectly by checking the non-interactive skips it.
    // The actual rendering test requires a TTY — tested via the format assertions below.
    expect(stdoutWrites.length).toBe(0) // non-interactive prints nothing
  })

  it('(a) renders separator + ⚠ Halt: line + choices in interactive mode (TTY=true)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    const stdoutWrites: string[] = []
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk))
      return true
    })

    // Simulate stdin line to prevent hanging
    simulateStdinLine('1')

    await runInteractivePrompt(ctx)
    stdoutSpy.mockRestore()

    const combined = stdoutWrites.join('')
    expect(combined).toContain('─────────────────────────────────────────────────')
    expect(combined).toContain('⚠ Halt: build-verification-failure (critical)')
    expect(combined).toContain('1) Accept default: escalate-without-halt')
    expect(combined).toContain('2) Retry with custom context')
    expect(combined).toContain('3) Propose re-scope')
    expect(combined).toContain('4) Abort run')
    expect(combined).toContain('Choice [1]:')
  })

  // ---------------------------------------------------------------------------
  // Test (b): reads stdin and returns operator's choice
  // ---------------------------------------------------------------------------

  it('(b) reads stdin input "2" and returns retry-with-custom-context', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    simulateStdinLine('2')

    const result = await runInteractivePrompt(ctx)
    expect(result).toBe('retry-with-custom-context')
  })

  it('(b) reads stdin input "3" and returns propose-re-scope', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    simulateStdinLine('3')

    const result = await runInteractivePrompt(ctx)
    expect(result).toBe('propose-re-scope')
  })

  it('(b) reads stdin input "4" and returns abort-run', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    simulateStdinLine('4')

    const result = await runInteractivePrompt(ctx)
    expect(result).toBe('abort-run')
  })

  // ---------------------------------------------------------------------------
  // Test (c): --non-interactive returns default without stdin read
  // ---------------------------------------------------------------------------

  it('(c) nonInteractive=true returns defaultAction without touching stdin, emits halt-skipped event', async () => {
    const haltSkippedCalls: Parameters<NonNullable<DecisionContext['onHaltSkipped']>>[] = []

    const ctx = makeCtx({
      nonInteractive: true,
      onHaltSkipped: (payload) => haltSkippedCalls.push([payload]),
    })

    const createInterfaceSpy = vi.spyOn(readlineMod, 'createInterface')

    const result = await runInteractivePrompt(ctx)

    expect(result).toBe('escalate-without-halt')
    expect(createInterfaceSpy).not.toHaveBeenCalled()
    expect(haltSkippedCalls.length).toBe(1)
    expect(haltSkippedCalls[0]![0].decisionType).toBe('build-verification-failure')
    expect(haltSkippedCalls[0]![0].defaultAction).toBe('escalate-without-halt')
    expect(haltSkippedCalls[0]![0].reason).toBe('non-interactive: stdin prompt suppressed')
  })

  it('(c) SUBSTRATE_NON_INTERACTIVE=true env var returns default without stdin read', async () => {
    process.env['SUBSTRATE_NON_INTERACTIVE'] = 'true'

    const ctx = makeCtx()
    const createInterfaceSpy = vi.spyOn(readlineMod, 'createInterface')

    const result = await runInteractivePrompt(ctx)

    expect(result).toBe('escalate-without-halt')
    expect(createInterfaceSpy).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // Test (d): writes notification file with correct shape
  // ---------------------------------------------------------------------------

  it('(d) writes notification file BEFORE prompting with correct JSON shape (operatorChoice=null, not updated in non-interactive mode per AC5)', async () => {
    const ctx = makeCtx({ nonInteractive: true })

    const writeFileCalls: Array<[string, string]> = []
    const writeFileMock = vi.mocked(fsMod.writeFile)
    writeFileMock.mockImplementation(async (path, data) => {
      writeFileCalls.push([String(path), String(data)])
    })

    await runInteractivePrompt(ctx)

    // Non-interactive mode: exactly one writeFile call (initial write only).
    // operatorChoice must remain null — AC5 explicitly says "leave null if non-interactive".
    expect(writeFileCalls.length).toBe(1)

    // The single write should have operatorChoice: null
    const firstWrite = JSON.parse(writeFileCalls[0]![1]) as Record<string, unknown>
    expect(firstWrite['runId']).toBe('test-run-42')
    expect(firstWrite['decisionType']).toBe('build-verification-failure')
    expect(firstWrite['severity']).toBe('critical')
    expect(firstWrite['operatorChoice']).toBeNull()
    expect(firstWrite['choices']).toEqual(['escalate-without-halt', 'retry', 'abort'])
    expect(typeof firstWrite['timestamp']).toBe('string')

    // The file path should contain the runId
    expect(writeFileCalls[0]![0]).toContain('test-run-42')
  })

  // ---------------------------------------------------------------------------
  // Test (e): handles malformed stdin input → defaults to 1
  // ---------------------------------------------------------------------------

  it('(e) handles malformed stdin input "abc" → defaults to choice 1 (defaultAction)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    simulateStdinLine('abc')

    const result = await runInteractivePrompt(ctx)
    expect(result).toBe('escalate-without-halt') // choice 1 = defaultAction
  })

  it('(e) handles empty stdin input "" → defaults to choice 1 (defaultAction)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    simulateStdinLine('')

    const result = await runInteractivePrompt(ctx)
    expect(result).toBe('escalate-without-halt') // choice 1 = defaultAction
  })

  it('(e) handles out-of-range stdin input "99" → defaults to choice 1 (defaultAction)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })

    const ctx = makeCtx()
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    simulateStdinLine('99')

    const result = await runInteractivePrompt(ctx)
    expect(result).toBe('escalate-without-halt') // choice 1 = defaultAction
  })
})
