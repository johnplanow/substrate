/**
 * Tests for GeminiCLIAdapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exec } from 'child_process'
import { GeminiCLIAdapter } from '@adapters/gemini-adapter'
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

describe('GeminiCLIAdapter', () => {
  let adapter: GeminiCLIAdapter

  beforeEach(() => {
    adapter = new GeminiCLIAdapter()
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
      expect(adapter.id).toBe('gemini')
    })

    it('has correct displayName', () => {
      expect(adapter.displayName).toBe('Gemini CLI')
    })

    it('has correct adapterVersion', () => {
      expect(adapter.adapterVersion).toBe('1.0.0')
    })
  })

  // -------------------------------------------------------------------------
  // healthCheck
  // -------------------------------------------------------------------------
  describe('healthCheck', () => {
    it('returns healthy when gemini --version succeeds', async () => {
      mockExecResolve('Gemini CLI 1.0.0\n')   // gemini --version
      mockExecResolve('/usr/local/bin/gemini\n')  // which gemini

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.version).toBe('Gemini CLI 1.0.0')
      expect(result.supportsHeadless).toBe(true)
    })

    it('returns unhealthy when gemini binary is missing', async () => {
      mockExecReject('Command not found: gemini')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(false)
      expect(result.error).toContain('Gemini CLI not available')
      expect(result.supportsHeadless).toBe(false)
    })

    it('handles "which" failure gracefully', async () => {
      mockExecResolve('Gemini 1.0.0\n')
      mockExecReject('which not found')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.cliPath).toBeUndefined()
    })

    it('detects API billing mode from GEMINI_API_KEY env', async () => {
      const originalKey = process.env.GEMINI_API_KEY
      process.env.GEMINI_API_KEY = 'test-api-key'

      mockExecResolve('Gemini 1.0.0\n')
      mockExecResolve('/usr/bin/gemini\n')

      const result = await adapter.healthCheck()

      expect(result.detectedBillingModes).toContain('api')

      if (originalKey === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = originalKey
      }
    })
  })

  // -------------------------------------------------------------------------
  // buildCommand
  // -------------------------------------------------------------------------
  describe('buildCommand', () => {
    it('returns SpawnCommand with binary gemini', () => {
      const cmd = adapter.buildCommand('Fix the bug', defaultOptions)
      expect(cmd.binary).toBe('gemini')
    })

    it('includes -p flag with prompt', () => {
      const prompt = 'Fix the failing integration tests'
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
        model: 'gemini-1.5-pro',
      })
      const modelIdx = cmd.args.indexOf('--model')
      expect(cmd.args[modelIdx + 1]).toBe('gemini-1.5-pro')
    })

    it('sets cwd to worktreePath', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.cwd).toBe('/tmp/worktree')
    })

    it('includes GEMINI_API_KEY in env when apiKey provided with API billing', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        billingMode: 'api',
        apiKey: 'gemini-secret-key',
      })
      expect(cmd.env?.GEMINI_API_KEY).toBe('gemini-secret-key')
    })

    it('does not include env when no apiKey provided', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.env).toBeUndefined()
    })

    it('appends additionalFlags when provided', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        additionalFlags: ['--safety-level', 'none'],
      })
      expect(cmd.args).toContain('--safety-level')
    })
  })

  // -------------------------------------------------------------------------
  // buildPlanningCommand
  // -------------------------------------------------------------------------
  describe('buildPlanningCommand', () => {
    it('returns SpawnCommand with binary gemini', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build REST API' }, defaultOptions)
      expect(cmd.binary).toBe('gemini')
    })

    it('includes goal in the -p prompt arg', () => {
      const goal = 'Build a REST API with authentication'
      const cmd = adapter.buildPlanningCommand({ goal }, defaultOptions)
      const pIdx = cmd.args.indexOf('-p')
      expect(pIdx).toBeGreaterThanOrEqual(0)
      const promptArg = cmd.args[pIdx + 1] ?? ''
      expect(promptArg).toContain(goal)
    })

    it('includes --output-format json', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build auth' }, defaultOptions)
      expect(cmd.args).toContain('json')
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
    it('parses valid JSON with completed status as success', () => {
      const json = JSON.stringify({
        status: 'completed',
        output: 'Fixed successfully',
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe('Fixed successfully')
    })

    it('parses response field when output missing', () => {
      const json = JSON.stringify({
        response: 'Here is the result',
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.output).toBe('Here is the result')
    })

    it('returns failure on non-zero exit code', () => {
      const result = adapter.parseOutput('output', 'error message', 1)
      expect(result.success).toBe(false)
      expect(result.error).toContain('error message')
    })

    it('returns failure when JSON has error field', () => {
      const json = JSON.stringify({ error: 'Quota exceeded', output: '' })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Quota exceeded')
    })

    it('falls back to raw stdout for non-JSON output', () => {
      const raw = 'Plain text Gemini response'
      const result = adapter.parseOutput(raw, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe(raw)
    })

    it('parses tokensUsed from metadata', () => {
      const json = JSON.stringify({
        output: 'Done',
        metadata: {
          tokensUsed: { input: 50, output: 30 },
        },
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.metadata?.tokensUsed?.input).toBe(50)
      expect(result.metadata?.tokensUsed?.output).toBe(30)
    })

    it('parses Gemini native usageMetadata when tokensUsed absent', () => {
      const json = JSON.stringify({
        output: 'Done',
        metadata: {
          usageMetadata: {
            promptTokenCount: 120,
            candidatesTokenCount: 60,
          },
        },
      })
      const result = adapter.parseOutput(json, '', 0)
      expect(result.metadata?.tokensUsed?.input).toBe(120)
      expect(result.metadata?.tokensUsed?.output).toBe(60)
    })
  })

  // -------------------------------------------------------------------------
  // parsePlanOutput
  // -------------------------------------------------------------------------
  describe('parsePlanOutput', () => {
    it('parses valid plan JSON', () => {
      const json = JSON.stringify({
        tasks: [
          { title: 'Setup project', description: 'Init project structure', complexity: 2 },
          { title: 'Implement auth', description: 'Add auth endpoints', complexity: 6, dependencies: ['Setup project'] },
        ],
      })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.success).toBe(true)
      expect(result.tasks).toHaveLength(2)
    })

    it('returns failure for non-zero exit code', () => {
      const result = adapter.parsePlanOutput('', 'fatal error', 1)
      expect(result.success).toBe(false)
      expect(result.tasks).toHaveLength(0)
    })

    it('returns failure for invalid JSON', () => {
      const result = adapter.parsePlanOutput('{bad json}', '', 0)
      expect(result.success).toBe(false)
    })

    it('returns failure when tasks array missing', () => {
      const result = adapter.parsePlanOutput(JSON.stringify({ plan: 'text' }), '', 0)
      expect(result.success).toBe(false)
    })

    it('uses Untitled task for missing title', () => {
      const json = JSON.stringify({ tasks: [{ description: 'No title' }] })
      const result = adapter.parsePlanOutput(json, '', 0)
      expect(result.tasks[0]?.title).toBe('Untitled task')
    })
  })

  // -------------------------------------------------------------------------
  // estimateTokens
  // -------------------------------------------------------------------------
  describe('estimateTokens', () => {
    it('returns positive estimates', () => {
      const estimate = adapter.estimateTokens('Refactor the authentication service')
      expect(estimate.input).toBeGreaterThan(0)
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

    it('supports plan generation', () => {
      expect(adapter.getCapabilities().supportsPlanGeneration).toBe(true)
    })

    it('supports both billing modes', () => {
      const caps = adapter.getCapabilities()
      expect(caps.supportsSubscriptionBilling).toBe(true)
      expect(caps.supportsApiBilling).toBe(true)
    })

    it('has very large maxContextTokens (Gemini 1M)', () => {
      expect(adapter.getCapabilities().maxContextTokens).toBeGreaterThanOrEqual(1_000_000)
    })
  })
})
