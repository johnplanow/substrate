/**
 * Tests for CodexCLIAdapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exec } from 'child_process'
import { CodexCLIAdapter, detectCodexSandboxBlock, CODEX_SANDBOX_BLOCK_HINT } from '@adapters/codex-adapter'
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
      expect(result.detectedBillingModes).toEqual(['subscription', 'api'])
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

    it('returns subscription and api billing modes', async () => {
      mockExecResolve('codex 0.1.0\n')
      mockExecResolve('/usr/local/bin/codex\n')

      const result = await adapter.healthCheck()

      expect(result.detectedBillingModes).toEqual(['subscription', 'api'])
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

    it('includes exec flag without --json (raw text output)', () => {
      const cmd = adapter.buildCommand('Fix the tests', defaultOptions)
      expect(cmd.args).toContain('exec')
      expect(cmd.args).not.toContain('--json')
    })

    it('runs in workspace-write sandbox with approval_policy=never (so exec can write files)', () => {
      const cmd = adapter.buildCommand('Fix the tests', defaultOptions)
      // Required so non-interactive `codex exec` can write files without an
      // approval prompt it cannot service. NOT the org-blocked dangerous-bypass.
      const sandboxIdx = cmd.args.indexOf('--sandbox')
      expect(sandboxIdx).toBeGreaterThanOrEqual(0)
      expect(cmd.args[sandboxIdx + 1]).toBe('workspace-write')
      // `-c approval_policy=never` is the form that parses on the `exec`
      // subcommand. The `--ask-for-approval` flag is top-level only in modern
      // Codex CLI versions — placing it after `exec` errors with
      // `unexpected argument '--ask-for-approval' found` (the v0.20.131–133
      // regression). `-c` is the documented config-override on every Codex
      // subcommand and writes the same underlying `approval_policy` setting.
      const dashCIdxs = cmd.args
        .map((a, i) => (a === '-c' ? i : -1))
        .filter((i) => i >= 0)
      const dashCValues = dashCIdxs.map((i) => cmd.args[i + 1])
      expect(dashCValues).toContain('approval_policy=never')
      // The wrong form (rejected by Codex's exec subcommand) must not be used.
      expect(cmd.args).not.toContain('--ask-for-approval')
      expect(cmd.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
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

    it('passes prompt as positional arg (not stdin)', () => {
      const goal = 'Build user authentication'
      const cmd = adapter.buildPlanningCommand({ goal }, defaultOptions)
      // Positional arg avoids execFileAsync stdin limitation
      expect(cmd.stdin).toBeUndefined()
      expect(cmd.args.some((a) => a.includes(goal))).toBe(true)
    })

    it('does not include --json flag (produces JSONL event stream, not plain JSON)', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build auth' }, defaultOptions)
      expect(cmd.args).not.toContain('--json')
    })

    it('includes --sandbox read-only for plan generation', () => {
      const cmd = adapter.buildPlanningCommand({ goal: 'Build auth' }, defaultOptions)
      expect(cmd.args).toContain('--sandbox')
      expect(cmd.args).toContain('read-only')
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
    it('returns raw stdout as output on success (raw text mode)', () => {
      const raw = 'I fixed the auth tests.\n\n```yaml\nresult: success\nac_met:\n  - AC1\n```'
      const result = adapter.parseOutput(raw, '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe(raw)
    })

    it('returns failure on non-zero exit code', () => {
      const result = adapter.parseOutput('output', 'error', 1)
      expect(result.success).toBe(false)
      expect(result.exitCode).toBe(1)
    })

    it('includes stderr in error on non-zero exit', () => {
      const result = adapter.parseOutput('', 'Rate limit exceeded', 1)
      expect(result.success).toBe(false)
      expect(result.error).toBe('Rate limit exceeded')
    })

    it('returns success for empty stdout', () => {
      const result = adapter.parseOutput('', '', 0)
      expect(result.success).toBe(true)
      expect(result.output).toBe('')
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

    it('supports both subscription and API billing', () => {
      const caps = adapter.getCapabilities()
      expect(caps.supportsApiBilling).toBe(true)
      expect(caps.supportsSubscriptionBilling).toBe(true)
    })

    it('supports plan generation', () => {
      expect(adapter.getCapabilities().supportsPlanGeneration).toBe(true)
    })

    it('has positive maxContextTokens', () => {
      expect(adapter.getCapabilities().maxContextTokens).toBeGreaterThan(0)
    })
  })
})

describe('detectCodexSandboxBlock', () => {
  it('detects the "approval is not supported in exec mode" signature', () => {
    const out = 'thinking...\nfile change approval is not supported in exec mode\n'
    expect(detectCodexSandboxBlock(out)).toBe(CODEX_SANDBOX_BLOCK_HINT)
  })

  it('detects the org-policy "disallowed by requirements" signature', () => {
    const out = 'warning: Configured value for `approval_policy` is disallowed by requirements'
    expect(detectCodexSandboxBlock(out)).toBe(CODEX_SANDBOX_BLOCK_HINT)
  })

  it('detects the command-execution-approval variant', () => {
    expect(
      detectCodexSandboxBlock('command execution approval is not supported in exec mode'),
    ).toBe(CODEX_SANDBOX_BLOCK_HINT)
  })

  it('is case-insensitive', () => {
    expect(detectCodexSandboxBlock('FILE CHANGE APPROVAL IS NOT SUPPORTED')).toBe(
      CODEX_SANDBOX_BLOCK_HINT,
    )
  })

  it('returns null for unrelated output', () => {
    expect(detectCodexSandboxBlock('Story file written successfully')).toBeNull()
  })

  it('returns null for empty/undefined/null', () => {
    expect(detectCodexSandboxBlock('')).toBeNull()
    expect(detectCodexSandboxBlock(undefined)).toBeNull()
    expect(detectCodexSandboxBlock(null)).toBeNull()
  })
})
