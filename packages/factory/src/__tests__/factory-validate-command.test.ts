/**
 * Unit tests for `substrate factory validate` CLI subcommand.
 *
 * AC1 — Valid graph → "13/13 rules passed, 0 errors, 0 warnings", exit 0
 * AC2 — Error diagnostic → summary shows failing rule, lists diagnostic, exit 1
 * AC3 — Warning-only → lists warning, summary, exit 0
 * AC4 — --output-format json → JSON array of ValidationDiagnostic[], no summary
 * AC5 — Missing file → stderr "file not found", exit 2
 * AC6 — Malformed DOT → stderr "failed to parse graph", exit 2
 * AC7 — 2 diagnostics from 1 ruleId + 1 from another → correct unique-rule pass count
 *
 * Story 46-7.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { registerFactoryCommand } from '../factory-command.js'

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports in vitest)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

vi.mock('../graph/parser.js', () => ({
  parseGraph: vi.fn(),
}))

vi.mock('../graph/validator.js', () => ({
  createValidator: vi.fn(() => ({
    validate: vi.fn().mockReturnValue([]),
    validateOrRaise: vi.fn(),
    registerRule: vi.fn(),
  })),
}))

vi.mock('../graph/executor.js', () => ({
  createGraphExecutor: vi.fn(),
}))

vi.mock('../handlers/index.js', () => ({
  createDefaultRegistry: vi.fn(),
  HandlerRegistry: vi.fn(),
}))

vi.mock('../config.js', () => ({
  loadFactoryConfig: vi.fn(),
}))

vi.mock('../scenarios/cli-command.js', () => ({
  registerScenariosCommand: vi.fn(),
}))

vi.mock('../graph/run-state.js', () => ({
  RunStateManager: vi.fn().mockImplementation(() => ({
    initRun: vi.fn().mockResolvedValue(undefined),
    writeNodeArtifacts: vi.fn().mockResolvedValue(undefined),
    writeScenarioIteration: vi.fn().mockResolvedValue(undefined),
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock graph */
const mockGraph = {
  nodes: new Map([
    ['start', { id: 'start', type: 'start', label: 'Start' }],
    ['exit', { id: 'exit', type: 'exit', label: 'Exit' }],
  ]),
  edges: [],
  startNode: () => ({ id: 'start', type: 'start', label: 'Start' }),
  exitNode: () => ({ id: 'exit', type: 'exit', label: 'Exit' }),
}

/**
 * Run `substrate factory validate <graphFile> [...extraArgs]`
 * via a fresh Commander program instance.
 */
async function runValidateCmd(graphFile: string, extraArgs: string[] = []) {
  const program = new Command()
  program.exitOverride()
  registerFactoryCommand(program)
  await program.parseAsync(['node', 'substrate', 'factory', 'validate', graphFile, ...extraArgs])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('substrate factory validate command', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any

  beforeEach(async () => {
    vi.clearAllMocks()

    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as () => never)

    // Default happy-path: file reads successfully, graph parses, no diagnostics
    const { readFile } = await import('node:fs/promises')
    vi.mocked(readFile).mockResolvedValue('digraph G { start -> exit }')

    const { parseGraph } = await import('../graph/parser.js')
    vi.mocked(parseGraph).mockReturnValue(mockGraph as never)

    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // AC1: Valid graph reports full pass
  // -------------------------------------------------------------------------

  it('AC1: valid graph prints "13/13 rules passed, 0 errors, 0 warnings" and exits 0', async () => {
    await runValidateCmd('pipeline.dot')

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(output).toContain('13/13 rules passed, 0 errors, 0 warnings')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC2: Error diagnostics reported with non-zero exit
  // -------------------------------------------------------------------------

  it('AC2: error diagnostic — lists diagnostic with ruleId and exits with code 1', async () => {
    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([
        {
          ruleId: 'start_node',
          severity: 'error' as const,
          message: 'Expected exactly one start node, found 2',
        },
      ]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    await expect(runValidateCmd('pipeline.dot')).rejects.toThrow('process.exit called')

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(output).toContain('error')
    expect(output).toContain('start_node')
    expect(output).toContain('12/13 rules passed, 1 error, 0 warnings')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  // -------------------------------------------------------------------------
  // AC3: Warning-only graphs exit 0
  // -------------------------------------------------------------------------

  it('AC3: warning-only graph lists warning, shows summary, and exits 0', async () => {
    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([
        {
          ruleId: 'prompt_on_llm_nodes',
          severity: 'warning' as const,
          message: "Codergen node 'generate' has no prompt or label",
          nodeId: 'generate',
        },
      ]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    await runValidateCmd('pipeline.dot')

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(output).toContain('warning')
    expect(output).toContain('prompt_on_llm_nodes')
    expect(output).toContain('12/13 rules passed')
    expect(output).toContain('0 errors')
    expect(output).toContain('1 warning')
    expect(exitSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC4: JSON output format emits ValidationDiagnostic array
  // -------------------------------------------------------------------------

  it('AC4: --output-format json with error diagnostic emits JSON array', async () => {
    const diagnostic = {
      ruleId: 'start_node',
      severity: 'error' as const,
      message: 'Expected exactly one start node, found 2',
    }
    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([diagnostic]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    await expect(runValidateCmd('pipeline.dot', ['--output-format', 'json'])).rejects.toThrow(
      'process.exit called',
    )

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    const parsed = JSON.parse(output)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      ruleId: 'start_node',
      severity: 'error',
      message: 'Expected exactly one start node, found 2',
    })
  })

  it('AC4: --output-format json with valid graph emits empty array []', async () => {
    await runValidateCmd('pipeline.dot', ['--output-format', 'json'])

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    const parsed = JSON.parse(output)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(0)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('AC4: --output-format json does not print summary line', async () => {
    await runValidateCmd('pipeline.dot', ['--output-format', 'json'])

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(output).not.toContain('rules passed')
  })

  // -------------------------------------------------------------------------
  // AC5: Missing file exits with code 2
  // -------------------------------------------------------------------------

  it('AC5: file not found prints error to stderr and exits with code 2', async () => {
    const { readFile } = await import('node:fs/promises')
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    )

    await expect(runValidateCmd('missing.dot')).rejects.toThrow('process.exit called')

    const stderrOutput = vi
      .mocked(process.stderr.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(stderrOutput).toContain('file not found: missing.dot')
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  // -------------------------------------------------------------------------
  // AC6: Malformed DOT file parse error exits with code 2
  // -------------------------------------------------------------------------

  it('AC6: malformed DOT file prints parse error to stderr and exits with code 2', async () => {
    const { parseGraph } = await import('../graph/parser.js')
    vi.mocked(parseGraph).mockImplementation(() => {
      throw new Error('unexpected token at line 3')
    })

    await expect(runValidateCmd('bad.dot')).rejects.toThrow('process.exit called')

    const stderrOutput = vi
      .mocked(process.stderr.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(stderrOutput).toContain('failed to parse graph: unexpected token at line 3')
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  // -------------------------------------------------------------------------
  // AC7: Summary counts reflect unique fired rules
  // -------------------------------------------------------------------------

  it('AC7: 2 diagnostics from 1 ruleId + 1 from another → "11/13 rules passed, 1 error, 1 warning"', async () => {
    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([
        // Two diagnostics from the same ruleId 'reachability' (1 unique rule)
        {
          ruleId: 'reachability',
          severity: 'error' as const,
          message: 'Node "orphan1" is unreachable',
          nodeId: 'orphan1',
        },
        {
          ruleId: 'reachability',
          severity: 'error' as const,
          message: 'Node "orphan2" is unreachable',
          nodeId: 'orphan2',
        },
        // One diagnostic from 'fidelity_valid' (1 unique rule)
        {
          ruleId: 'fidelity_valid',
          severity: 'warning' as const,
          message: "Node 'x' has unrecognised fidelity value",
          nodeId: 'x',
        },
      ]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    await expect(runValidateCmd('pipeline.dot')).rejects.toThrow('process.exit called')

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    // 13 - 2 unique ruleIds = 11 passed
    expect(output).toContain('11/13 rules passed, 2 errors, 1 warning')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  // -------------------------------------------------------------------------
  // Additional: node/edge annotation in text output
  // -------------------------------------------------------------------------

  it('text output includes [node: <id>] annotation when nodeId is present', async () => {
    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([
        {
          ruleId: 'prompt_on_llm_nodes',
          severity: 'warning' as const,
          message: 'Missing prompt',
          nodeId: 'generate',
        },
      ]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    await runValidateCmd('pipeline.dot')

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(output).toContain('[node: generate]')
  })

  it('text output includes [edge: <index>] annotation when edgeIndex is present', async () => {
    const { createValidator } = await import('../graph/validator.js')
    vi.mocked(createValidator).mockReturnValue({
      validate: vi.fn().mockReturnValue([
        {
          ruleId: 'some_edge_rule',
          severity: 'warning' as const,
          message: 'Edge condition problem',
          edgeIndex: 3,
        },
      ]),
      validateOrRaise: vi.fn(),
      registerRule: vi.fn(),
    })

    await runValidateCmd('pipeline.dot')

    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => String(args[0]))
      .join('')

    expect(output).toContain('[edge: 3]')
  })
})
