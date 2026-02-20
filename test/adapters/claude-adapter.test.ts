/**
 * Tests for ClaudeCodeAdapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exec } from 'child_process'
import { ClaudeCodeAdapter } from '@adapters/claude-adapter'
import type { AdapterOptions } from '@adapters/types'

vi.mock('child_process', () => ({
  exec: vi.fn(),
}))

const mockExec = vi.mocked(exec) as unknown as ReturnType<typeof vi.fn>

/** Helper to make mockExec resolve like promisified exec */
function mockExecResolve(stdout: string, stderr = ''): void {
  mockExec.mockImplementationOnce(
    (_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout, stderr })
    }
  )
}

/** Helper to make mockExec reject like promisified exec */
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

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter()
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
      expect(adapter.id).toBe('claude-code')
    })

    it('has correct displayName', () => {
      expect(adapter.displayName).toBe('Claude Code')
    })

    it('has correct adapterVersion', () => {
      expect(adapter.adapterVersion).toBe('1.0.0')
    })
  })

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------
  describe('healthCheck', () => {
    it('returns healthy when claude --version succeeds', async () => {
      mockExecResolve('1.0.0\n')   // claude --version
      mockExecResolve('/usr/local/bin/claude\n')  // which claude

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.version).toBe('1.0.0')
      expect(result.supportsHeadless).toBe(true)
    })

    it('returns unhealthy when claude binary is missing', async () => {
      mockExecReject('Command not found: claude')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(false)
      expect(result.error).toContain('Claude CLI not available')
      expect(result.supportsHeadless).toBe(false)
    })

    it('handles "which" failure gracefully (no cliPath)', async () => {
      mockExecResolve('1.2.3\n')   // claude --version
      mockExecReject('which: not found')  // which fails

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.cliPath).toBeUndefined()
    })

    it('detects API billing mode from ANTHROPIC_API_KEY env', async () => {
      const originalEnv = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = 'sk-test-key'

      mockExecResolve('1.0.0\n')
      mockExecResolve('/usr/local/bin/claude\n')

      const result = await adapter.healthCheck()

      expect(result.detectedBillingModes).toContain('api')

      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalEnv
      }
    })
  })

  // -------------------------------------------------------------------------
  // buildCommand
  // -------------------------------------------------------------------------
  describe('buildCommand', () => {
    it('returns SpawnCommand with correct binary', () => {
      const cmd = adapter.buildCommand('Fix the bug', defaultOptions)
      expect(cmd.binary).toBe('claude')
    })

    it('includes -p flag with prompt', () => {
      const prompt = 'Fix the bug in auth.ts'
      const cmd = adapter.buildCommand(prompt, defaultOptions)
      const pIdx = cmd.args.indexOf('-p')
      expect(pIdx).toBeGreaterThanOrEqual(0)
      expect(cmd.args[pIdx + 1]).toBe(prompt)
    })

    it('includes --output-format json', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      const fmtIdx = cmd.args.indexOf('--output-format')
      expect(fmtIdx).toBeGreaterThanOrEqual(0)
      expect(cmd.args[fmtIdx + 1]).toBe('json')
    })

    it('includes --model flag', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      const modelIdx = cmd.args.indexOf('--model')
      expect(modelIdx).toBeGreaterThanOrEqual(0)
      expect(cmd.args[modelIdx + 1]).toBeTruthy()
    })

    it('uses provided model override', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        model: 'claude-3-opus',
      })
      const modelIdx = cmd.args.indexOf('--model')
      expect(cmd.args[modelIdx + 1]).toBe('claude-3-opus')
    })

    it('sets cwd to worktreePath', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.cwd).toBe('/tmp/worktree')
    })

    it('appends additionalFlags when provided', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        additionalFlags: ['--verbose', '--dry-run'],
      })
      expect(cmd.args).toContain('--verbose')
      expect(cmd.args).toContain('--dry-run')
    })

    it('includes ANTHROPIC_API_KEY in env when apiKey provided with API billing', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        billingMode: 'api',
        apiKey: 'sk-secret',
      })
      expect(cmd.env?.ANTHROPIC_API_KEY).toBe('sk-secret')
    })

    it('does not include env when no apiKey provided', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.env).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // buildPlanningCommand
  // -------------------------------------------------------------------------
  describe('buildPlanningCommand', () => {
    it('returns SpawnCommand with binary claude', () => {
      const cmd = adapter.buildPlanningCommand(
        { goal: 'Build a REST API' },
        defaultOptions
      )
      expect(cmd.binary).toBe('claude')
    })

    it('includes --output-format json', () => {
      const cmd = adapter.buildPlanningCommand(
        { goal: 'Build auth' },
        defaultOptions
      )
      expect(cmd.args).toContain('--output-format')
      expect(cmd.args).toContain('json')
    })

    it('includes the goal in the prompt arg', () => {
      const goal = 'Implement user authentication'
      const cmd = adapter.buildPlanningCommand({ goal }, defaultOptions)
      const pIdx = cmd.args.indexOf('-p')
      expect(pIdx).toBeGreaterThanOrEqual(0)
      const promptArg = cmd.args[pIdx + 1] ?? ''
      expect(promptArg).toContain(goal)
    })

    it('sets cwd to worktreePath', () => {
      const cmd = adapter.buildPlanningCommand(
        { goal: 'Build auth' },
        defaultOptions
      )
      expect(cmd.cwd).toBe('/tmp/worktree')
    })
  })

  // -------------------------------------------------------------------------
  // parseOutput
  // -------------------------------------------------------------------------
  describe('parseOutput', () => {
    it('parses valid JSON with completed status as success', () => {
      const json = JSON.stringify({
        status: 'completed',
        output: 'All tests fixed',
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe('All tests fixed')
      expect(result.exitCode).toBe(0)
    })

    it('parses valid JSON with no status field as success', () => {
      const json = JSON.stringify({ output: 'Done' })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(true)
    })

    it('returns failure on non-zero exit code', () => {
      const result = adapter.parseOutput('partial output', 'error msg', 1)
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(1)
      expect(result.error).toContain('error msg')
    })

    it('returns failure when JSON has error field', () => {
      const json = JSON.stringify({ status: 'completed', error: 'Something went wrong', output: '' })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Something went wrong')
    })

    it('falls back to raw stdout for non-JSON output', () => {
      const raw = 'This is not JSON output'
      const result = adapter.parseOutput(raw, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe(raw)
    })

    it('parses token metadata when present', () => {
      const json = JSON.stringify({
        status: 'completed',
        output: 'Done',
        metadata: {
          executionTime: 1234,
          tokensUsed: { input: 100, output: 50 },
        },
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.metadata?.tokensUsed?.input).toBe(100)
      expect(result.metadata?.tokensUsed?.output).toBe(50)
      expect(result.metadata?.tokensUsed?.total).toBe(150)
      expect(result.metadata?.executionTime).toBe(1234)
    })

    it('uses stderr as error when exit code is non-zero and no stderr', () => {
      const result = adapter.parseOutput('output', '', 2)
      expect(result.success).toBe(false)
      expect(result.error).toContain('2')
    })
  })

  // -------------------------------------------------------------------------
  // parsePlanOutput
  // -------------------------------------------------------------------------
  describe('parsePlanOutput', () => {
    it('parses valid plan JSON', () => {
      const json = JSON.stringify({
        tasks: [
          { title: 'Setup DB', description: 'Configure database', complexity: 3 },
          { title: 'Auth endpoints', description: 'Create auth routes', complexity: 5, dependencies: ['Setup DB'] },
        ],
      })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.tasks).toHaveLength(2)
      expect(result.tasks[0]?.title).toBe('Setup DB')
      expect(result.tasks[1]?.dependencies).toContain('Setup DB')
    })

    it('returns failure for non-zero exit code', () => {
      const result = adapter.parsePlanOutput('', 'error', 1)
      expect(result.success).toBe(false)
      expect(result.tasks).toHaveLength(0)
    })

    it('returns failure for invalid JSON', () => {
      const result = adapter.parsePlanOutput('not-json', '', 0)
      expect(result.success).toBe(false)
      expect(result.error).toContain('JSON')
    })

    it('returns failure when tasks array missing', () => {
      const result = adapter.parsePlanOutput(JSON.stringify({ data: 'no tasks' }), '', 0)
      expect(result.success).toBe(false)
      expect(result.error).toContain('tasks')
    })

    it('uses Untitled task for missing titles', () => {
      const json = JSON.stringify({
        tasks: [{ description: 'No title task' }],
      })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.tasks[0]?.title).toBe('Untitled task')
    })
  })

  // -------------------------------------------------------------------------
  // estimateTokens
  // -------------------------------------------------------------------------
  describe('estimateTokens', () => {
    it('returns positive input token estimate', () => {
      const estimate = adapter.estimateTokens('Fix the tests')
      expect(estimate.input).toBeGreaterThan(0)
    })

    it('total equals input + output', () => {
      const estimate = adapter.estimateTokens('A longer prompt that needs more tokens')
      expect(estimate.total).toBe(estimate.input + estimate.output)
    })

    it('returns zero total for empty string', () => {
      const estimate = adapter.estimateTokens('')
      expect(estimate.input).toBe(0)
      expect(estimate.total).toBe(0)
    })

    it('larger prompts produce larger estimates', () => {
      const short = adapter.estimateTokens('Fix it')
      const long = adapter.estimateTokens('Fix all the failing tests in the authentication module and ensure the JWT validation works correctly with all edge cases')
      expect(long.input).toBeGreaterThan(short.input)
    })
  })

  // -------------------------------------------------------------------------
  // getCapabilities
  // -------------------------------------------------------------------------
  describe('getCapabilities', () => {
    it('supports JSON output', () => {
      expect(adapter.getCapabilities().supportsJsonOutput).toBe(true)
    })

    it('supports plan generation', () => {
      expect(adapter.getCapabilities().supportsPlanGeneration).toBe(true)
    })

    it('supports both billing modes', () => {
      const caps = adapter.getCapabilities()
      expect(caps.supportsSubscriptionBilling).toBe(true)
      expect(caps.supportsApiBilling).toBe(true)
    })

    it('has positive maxContextTokens', () => {
      expect(adapter.getCapabilities().maxContextTokens).toBeGreaterThan(0)
    })

    it('supports multiple task types', () => {
      const caps = adapter.getCapabilities()
      expect(caps.supportedTaskTypes).toContain('code')
    })
  })
})
