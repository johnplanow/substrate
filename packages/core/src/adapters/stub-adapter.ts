/**
 * StubAdapter — deterministic scripted agent for the pipeline e2e harness
 * (H2.2, hardening program).
 *
 * Drives the REAL pipeline (worktrees, commit-first, verification, merge)
 * without an LLM: `buildCommand` spawns node on an operator-supplied scenario
 * script that emits scripted phase outputs (and writes scripted files) per
 * SUBSTRATE_STUB_SCENARIO. This is how the fixture matrix proves, on every
 * PR, that a Python/uv (or Node, or Go) consumer flows through dispatch →
 * gates → finalization correctly — the class of coverage whose absence let
 * the 2026-07-04 field-failure family ship.
 *
 * SAFETY: never registered unless SUBSTRATE_STUB_ADAPTER=1 is set in the
 * orchestrator's environment (see AdapterRegistry.discoverAndRegister), and
 * its healthCheck also fails without the gate + a readable script path in
 * SUBSTRATE_STUB_SCRIPT. Production runs can never route to it accidentally.
 */

import { access } from 'node:fs/promises'
import type { AgentId } from '../types.js'
import type { WorkerAdapter } from './worker-adapter.js'
import type {
  AdapterCapabilities,
  AdapterHealthResult,
  AdapterOptions,
  PlanParseResult,
  PlanRequest,
  SpawnCommand,
  TaskResult,
  TokenEstimate,
} from './types.js'

export class StubAdapter implements WorkerAdapter {
  readonly id: AgentId = 'stub'
  readonly displayName = 'Stub Agent (e2e harness)'
  readonly adapterVersion = '1.0.0'

  async healthCheck(): Promise<AdapterHealthResult> {
    if (process.env.SUBSTRATE_STUB_ADAPTER !== '1') {
      return {
        healthy: false,
        error: 'stub adapter is gated behind SUBSTRATE_STUB_ADAPTER=1 (e2e harness only)',
        supportsHeadless: true,
      }
    }
    const script = process.env.SUBSTRATE_STUB_SCRIPT
    if (script === undefined || script === '') {
      return {
        healthy: false,
        error: 'SUBSTRATE_STUB_SCRIPT must point at the scenario script',
        supportsHeadless: true,
      }
    }
    try {
      await access(script)
    } catch {
      return {
        healthy: false,
        error: `SUBSTRATE_STUB_SCRIPT not readable: ${script}`,
        supportsHeadless: true,
      }
    }
    return { healthy: true, version: 'stub-1.0.0', supportsHeadless: true }
  }

  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand {
    return {
      binary: process.execPath,
      args: [
        process.env.SUBSTRATE_STUB_SCRIPT ?? '/nonexistent-stub-script',
        options.taskType ?? 'unknown',
      ],
      env: {
        SUBSTRATE_STUB_SCENARIO: process.env.SUBSTRATE_STUB_SCENARIO ?? 'success',
        SUBSTRATE_STUB_STORY_KEY: options.storyKey ?? '',
      },
      cwd: options.worktreePath,
      stdin: prompt,
    }
  }

  buildPlanningCommand(_request: PlanRequest, options: AdapterOptions): SpawnCommand {
    return {
      binary: process.execPath,
      args: [process.env.SUBSTRATE_STUB_SCRIPT ?? '/nonexistent-stub-script', 'planning'],
      env: {
        SUBSTRATE_STUB_SCENARIO: process.env.SUBSTRATE_STUB_SCENARIO ?? 'success',
      },
      cwd: options.worktreePath,
      stdin: '',
    }
  }

  parseOutput(stdout: string, stderr: string, exitCode: number): TaskResult {
    if (exitCode !== 0) {
      return {
        success: false,
        output: stdout,
        error: stderr || `stub exited with code ${String(exitCode)}`,
        exitCode,
      }
    }
    return { success: true, output: stdout, exitCode }
  }

  parsePlanOutput(stdout: string, stderr: string, exitCode: number): PlanParseResult {
    if (exitCode !== 0) {
      return { success: false, tasks: [], error: stderr || `stub exited ${String(exitCode)}` }
    }
    return { success: false, tasks: [], error: 'stub adapter does not generate plans' }
  }

  estimateTokens(text: string): TokenEstimate {
    // Same heuristic the other adapters use: ~4 chars per token.
    const input = Math.ceil(text.length / 4)
    return { input, output: 0, total: input }
  }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsJsonOutput: false,
      supportsStreaming: false,
      supportsSubscriptionBilling: true,
      supportsApiBilling: false,
      supportsPlanGeneration: false,
      maxContextTokens: 1_000_000,
      supportedTaskTypes: [
        'create-story',
        'dev-story',
        'code-review',
        'fix-story',
        'test-plan',
        'probe-author',
        'test-expansion',
      ],
      supportedLanguages: ['python', 'typescript', 'go'],
      timeoutMultiplier: 1.0,
      defaultModel: 'stub',
    }
  }
}
