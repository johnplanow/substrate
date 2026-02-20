/**
 * Tests for CodexCLIAdapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exec } from 'child_process'
import { CodexCLIAdapter } from '@adapters/codex-adapter'
import type { AdapterOptions } from '@adapters/types'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

const mockExec = vi.mocked(exec) as unknown as ReturnType<typeof vi.fn>

function mockExecResolve(stdout: string, stderr = ''): void {
  mockExec.mockImplementationOnce(
    (_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr })
    }
  )
}

function mockExecReject(message: string): void {
  mockExec.mockImplementationOnce(
    (_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string } | null) => void) => {
      cb(new Error(message), null)
    }
  )
}

const defaultOptions: AdapterOptions = {
  worktreePath: '/tmp/worktree',
  billingMode: 'api',
}

describe('CodexCLIAdapter', () => {
  let adapter: CodexCLIAdapter

  beforeEach(() => {
    adapter = new CodexCLIAdapter()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------
  describe('identity', () => {
    it('has correct id', () => {
      expect(adapter.id).toBe('codex')
    })

    it('has correct displayName', () => {
      expect(adapter.displayName).toBe('Codex CLI')
    })

    it('has correct adapterVersion', () => {
      expect(adapter.adapterVersion).toBe('1.0.0')
    })
  })

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------
  describe('healthCheck', () => {
    it('returns healthy when codex --version succeeds', async () => {
      mockExecResolve('codex 0.1.0\n')   // codex --version
      mockExecResolve('/usr/local/bin/codex\n')  // which codex

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.version).toBe('codex 0.1.0')
      expect(result.detectedBillingModes).toEqual(['api'])
      expect(result.supportsHeadless).toBe(true)
    })

    it('returns unhealthy when codex binary is missing', async () => {
      mockExecReject('Command not found: codex')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(false)
      expect(result.error).toContain('Codex CLI not available')
      expect(result.supportsHeadless).toBe(false)
    })

    it('handles "which" failure gracefully', async () => {
      mockExecResolve('codex 0.1.0\n')
      mockExecReject('which not found')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.cliPath).toBeUndefined()
    })

    it('always returns api billing mode (Codex is API-only)', async () => {
      mockExecResolve('codex 0.1.0\n')
      mockExecResolve('/usr/local/bin/codex\n')

      const result = await adapter.healthCheck()

      expect(result.detectedBillingModes).toEqual(['api'])
    })
  })

  // -------------------------------------------------------------------------
  // buildCommand
  // -------------------------------------------------------------------------
  describe('buildCommand', () => {
    it('returns SpawnCommand with binary codex', () => {
      const cmd = adapter.buildCommand('Fix the tests', defaultOptions)
      expect(cmd.binary).toBe('codex')
    })

    it('includes exec and --json flags', () => {
      const cmd = adapter.buildCommand('Fix the tests', defaultOptions)
      expect(cmd.args).toContain('exec')
      expect(cmd.args).toContain('--json')
    })

    it('passes prompt via stdin (not args)', () => {
      const prompt = 'Fix the failing auth tests'
      const cmd = adapter.buildCommand(prompt, defaultOptions)
      expect(cmd.stdin).toBe(prompt)
    })

    it('prompt is NOT in args array', () => {
      const prompt = 'Fix the tests'
      const cmd = adapter.buildCommand(prompt, defaultOptions)
      expect(cmd.args).not.toContain(prompt)
    })

    it('sets cwd to worktreePath', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.cwd).toBe('/tmp/worktree')
    })

    it('includes OPENAI_API_KEY in env when apiKey provided', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        apiKey: 'sk-openai-key',
      })
      expect(cmd.env?.OPENAI_API_KEY).toBe('sk-openai-key')
    })

    it('does not include env when no apiKey provided', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.env).toBeUndefined()
    })

    it('appends additionalFlags', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        additionalFlags: ['--max-tokens', '4096'],
      })
      expect(cmd.args).toContain('--max-tokens')
      expect(cmd.args).toContain('4096')
    })
  })

  // -------------------------------------------------------------------------
  // buildPlanningCommand
  // -------------------------------------------------------------------------
  describe('buildPlanningCommand', () => {
    it('returns SpawnCommand with binary codex', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build auth' }, defaultOptions)
      expect(cmd.binary).toBe('codex')
    })

    it('uses stdin for the planning prompt', () => {
      const goal = 'Build user authentication'
      const cmd = adapter.buildPlanningCommand({ goal }, defaultOptions)
      expect(cmd.stdin).toContain(goal)
    })

    it('includes --json flag', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build auth' }, defaultOptions)
      expect(cmd.args).toContain('--json')
    })

    it('sets cwd to worktreePath', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build auth' }, defaultOptions)
      expect(cmd.cwd).toBe('/tmp/worktree')
    })
  })

  // -------------------------------------------------------------------------
  // parseOutput
  // -------------------------------------------------------------------------
  describe('parseOutput', () => {
    it('parses successful Codex JSON output', () => {
      const json = JSON.stringify({
        status: 'success',
        output: 'Fixed the auth tests',
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe('Fixed the auth tests')
    })

    it('parses "completed" status as success', () => {
      const json = JSON.stringify({ status: 'completed', output: 'Done' })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(true)
    })

    it('parses result field as output when output missing', () => {
      const json = JSON.stringify({ status: 'success', result: 'All fixed' })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.output).toBe('All fixed')
    })

    it('returns failure on non-zero exit code', () => {
      const result = adapter.parseOutput('output', 'error', 1)
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(1)
    })

    it('returns failure when JSON has error field', () => {
      const json = JSON.stringify({ status: 'error', error: 'Rate limit', output: '' })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Rate limit')
    })

    it('falls back to raw stdout for non-JSON output', () => {
      const raw = 'plain text output'
      const result = adapter.parseOutput(raw, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe(raw)
    })

    it('parses token metadata from tokens field', () => {
      const json = JSON.stringify({
        status: 'success',
        output: 'Done',
        tokens: { input: 200, output: 100, total: 300 },
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.metadata?.tokensUsed?.input).toBe(200)
      expect(result.metadata?.tokensUsed?.output).toBe(100)
      expect(result.metadata?.tokensUsed?.total).toBe(300)
    })
  })

  // -------------------------------------------------------------------------
  // parsePlanOutput
  // -------------------------------------------------------------------------
  describe('parsePlanOutput', () => {
    it('parses valid plan with tasks array', () => {
      const json = JSON.stringify({
        tasks: [
          { title: 'Setup DB', description: 'Configure database' },
          { title: 'Auth', description: 'Implement auth', dependencies: ['Setup DB'] },
        ],
      })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.tasks).toHaveLength(2)
    })

    it('accepts plan array as alternative key', () => {
      const json = JSON.stringify({
        plan: [
          { title: 'Task 1', description: 'Do something' },
        ],
      })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.tasks).toHaveLength(1)
    })

    it('returns failure for non-zero exit code', () => {
      const result = adapter.parsePlanOutput('', 'error', 1)
      expect(result.success).toBe(false)
    })

    it('returns failure for invalid JSON', () => {
      const result = adapter.parsePlanOutput('invalid json {', '', 0)
      expect(result.success).toBe(false)
    })

    it('returns failure when neither tasks nor plan found', () => {
      const json = JSON.stringify({ other: 'data' })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.success).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // estimateTokens
  // -------------------------------------------------------------------------
  describe('estimateTokens', () => {
    it('returns positive estimates for non-empty prompt', () => {
      const estimate = adapter.estimateTokens('Write unit tests for the auth module')
      expect(estimate.input).toBeGreaterThan(0)
      expect(estimate.output).toBeGreaterThan(0)
      expect(estimate.total).toBe(estimate.input + estimate.output)
    })

    it('returns zero total for empty string', () => {
      const estimate = adapter.estimateTokens('')
      expect(estimate.total).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------
  describe('getCapabilities', () => {
    it('supports JSON output', () => {
      expect(adapter.getCapabilities().supportsJsonOutput).toBe(true)
    })

    it('is API-only (no subscription billing)', () => {
      const caps = adapter.getCapabilities()
      expect(caps.supportsApiBilling).toBe(true)
      expect(caps.supportsSubscriptionBilling).toBe(false)
    })

    it('supports plan generation', () => {
      expect(adapter.getCapabilities().supportsPlanGeneration).toBe(true)
    })

    it('has positive maxContextTokens', () => {
      expect(adapter.getCapabilities().maxContextTokens).toBeGreaterThan(0)
    })
  })
})
