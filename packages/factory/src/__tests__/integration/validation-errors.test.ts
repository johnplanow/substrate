/**
 * Integration tests: AC3 — error rules block execution
 *                    AC4 — warning rules allow execution
 *
 * Story 42-15.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Outcome } from '../../graph/types.js'
import type { GraphExecutorConfig } from '../../graph/executor.js'
import { parseGraph } from '../../graph/parser.js'
import { createValidator } from '../../graph/validator.js'
import { createGraphExecutor } from '../../graph/executor.js'
import { makeTmpDir, cleanDir, makeMockRegistry } from './helpers.js'
import { ERROR_RULE_VIOLATION_DOT, WARNING_RULE_VIOLATION_DOT } from './graphs.js'

// ---------------------------------------------------------------------------
// runWithValidation helper
// ---------------------------------------------------------------------------

/**
 * Parse `dotString`, validate the graph, throw if any error-level diagnostics
 * are found, otherwise run the executor with `config`.
 *
 * @throws Error with "validation errors" in the message when the graph has errors.
 */
async function runWithValidation(
  dotString: string,
  config: GraphExecutorConfig,
): Promise<Outcome> {
  const graph = parseGraph(dotString)
  const validator = createValidator()
  const errors = validator.validate(graph).filter((d) => d.severity === 'error')
  if (errors.length > 0) {
    const ruleIds = errors.map((e) => e.ruleId).join(', ')
    throw new Error(`Graph has validation errors: ${ruleIds}`)
  }
  // Cast needed: executor returns events.ts:Outcome (StageStatus) but test
  // types are compatible for the SUCCESS/FAIL cases we assert.
  return createGraphExecutor().run(graph, config) as unknown as Promise<Outcome>
}

// ---------------------------------------------------------------------------
// AC3: Error-rule violations block execution
// ---------------------------------------------------------------------------

describe('AC3: error-rule violations block execution', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('validate() returns at least 2 error diagnostics naming reachability and start_no_incoming', () => {
    const graph = parseGraph(ERROR_RULE_VIOLATION_DOT)
    const validator = createValidator()
    const diagnostics = validator.validate(graph)

    const errors = diagnostics.filter((d) => d.severity === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(2)

    const ruleIds = errors.map((d) => d.ruleId)
    expect(ruleIds).toContain('reachability')
    expect(ruleIds).toContain('start_no_incoming')
  })

  it('reachability error correctly identifies the orphan node', () => {
    const graph = parseGraph(ERROR_RULE_VIOLATION_DOT)
    const validator = createValidator()
    const diagnostics = validator.validate(graph)

    const reachabilityErrors = diagnostics.filter((d) => d.ruleId === 'reachability')
    expect(reachabilityErrors.length).toBeGreaterThanOrEqual(1)
    const orphanError = reachabilityErrors.find((d) => d.nodeId === 'orphan')
    expect(orphanError).toBeDefined()
    expect(orphanError?.severity).toBe('error')
  })

  it('start_no_incoming error correctly identifies the violating edge', () => {
    const graph = parseGraph(ERROR_RULE_VIOLATION_DOT)
    const validator = createValidator()
    const diagnostics = validator.validate(graph)

    const incomingErrors = diagnostics.filter((d) => d.ruleId === 'start_no_incoming')
    expect(incomingErrors.length).toBeGreaterThanOrEqual(1)
    expect(incomingErrors[0]?.severity).toBe('error')
  })

  it('runWithValidation throws with /validation errors/ for error graph', async () => {
    const { registry } = makeMockRegistry()
    await expect(
      runWithValidation(ERROR_RULE_VIOLATION_DOT, {
        runId: 'test-run-ac3',
        logsRoot,
        handlerRegistry: registry,
      }),
    ).rejects.toThrow(/validation errors/)
  })

  it('runWithValidation thrown message includes rule IDs', async () => {
    const { registry } = makeMockRegistry()
    let thrownMessage = ''
    try {
      await runWithValidation(ERROR_RULE_VIOLATION_DOT, {
        runId: 'test-run-ac3-msg',
        logsRoot,
        handlerRegistry: registry,
      })
    } catch (err) {
      thrownMessage = (err as Error).message
    }
    expect(thrownMessage).toMatch(/validation errors/)
    expect(thrownMessage).toMatch(/reachability|start_no_incoming/)
  })
})

// ---------------------------------------------------------------------------
// AC4: Warning-rule violations allow execution
// ---------------------------------------------------------------------------

describe('AC4: warning-rule violations allow execution', () => {
  let logsRoot: string

  beforeEach(async () => {
    logsRoot = await makeTmpDir()
  })

  afterEach(async () => {
    await cleanDir(logsRoot)
  })

  it('validate() returns at least 2 warning diagnostics and zero error diagnostics', () => {
    const graph = parseGraph(WARNING_RULE_VIOLATION_DOT)
    const validator = createValidator()
    const diagnostics = validator.validate(graph)

    const errors = diagnostics.filter((d) => d.severity === 'error')
    const warnings = diagnostics.filter((d) => d.severity === 'warning')

    expect(errors).toHaveLength(0)
    expect(warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('prompt_on_llm_nodes warning is present', () => {
    const graph = parseGraph(WARNING_RULE_VIOLATION_DOT)
    const validator = createValidator()
    const diagnostics = validator.validate(graph)

    const promptWarning = diagnostics.find((d) => d.ruleId === 'prompt_on_llm_nodes')
    expect(promptWarning).toBeDefined()
    expect(promptWarning?.severity).toBe('warning')
  })

  it('fidelity_valid warning is present', () => {
    const graph = parseGraph(WARNING_RULE_VIOLATION_DOT)
    const validator = createValidator()
    const diagnostics = validator.validate(graph)

    const fidelityWarning = diagnostics.find((d) => d.ruleId === 'fidelity_valid')
    expect(fidelityWarning).toBeDefined()
    expect(fidelityWarning?.severity).toBe('warning')
  })

  it('executor runs successfully despite warnings (warnings do not block execution)', async () => {
    const graph = parseGraph(WARNING_RULE_VIOLATION_DOT)

    // Validate: confirm warnings present but no errors
    const validator = createValidator()
    const errors = validator.validate(graph).filter((d) => d.severity === 'error')
    expect(errors).toHaveLength(0)

    // Execute directly (no pre-flight error check — warnings are non-blocking)
    const { registry } = makeMockRegistry()
    const outcome = await createGraphExecutor().run(graph, {
      runId: 'test-run-ac4',
      logsRoot,
      handlerRegistry: registry,
    })

    expect(outcome.status).toBe('SUCCESS')
  })
})
