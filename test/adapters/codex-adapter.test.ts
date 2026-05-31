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

    it('surfaces compatibilityWarning when CLI version is below substrate\'s tested range', async () => {
      // Codex tested range is [0.135.0, 0.135.0]; 0.111.0 is the lower version
      // the substrate v0.20.131-137 arc was originally (mis-)tested against —
      // this is the exact drift this infrastructure exists to catch.
      mockExecResolve('codex-cli 0.111.0\n')
      mockExecResolve('/usr/local/bin/codex\n')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.compatibilityWarning).toMatch(/codex/)
      expect(result.compatibilityWarning).toMatch(/below substrate's tested range/i)
    })

    it('surfaces the in-range note (the hardcoded approval_policy=Never structural truth)', async () => {
      mockExecResolve('codex-cli 0.135.0\n')
      mockExecResolve('/usr/local/bin/codex\n')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.compatibilityWarning).toMatch(/approval_policy=Never/)
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

    it('runs with --sandbox workspace-write (Codex\'s documented form post-v0.128.0 `--full-auto` deprecation)', () => {
      const cmd = adapter.buildCommand('Fix the tests', defaultOptions)
      // `--sandbox workspace-write` is the form Codex's deprecation hint
      // explicitly tells users to migrate to: `warning: --full-auto is
      // deprecated; use --sandbox workspace-write instead.` Empirically
      // verified parsing on codex-cli 0.135.0.
      //
      // Note: `codex exec` hardcodes approval_policy=Never (codex-rs/exec/src/
      // lib.rs:407) — no substrate flag combination can override it. We do NOT
      // try to set approval_policy via -c, because the harness override beats
      // any TOML/CLI override (per Codex source and issue #10949).
      const sandboxIdx = cmd.args.indexOf('--sandbox')
      expect(sandboxIdx).toBeGreaterThanOrEqual(0)
      expect(cmd.args[sandboxIdx + 1]).toBe('workspace-write')
      // Wrong forms from prior ships must not be used.
      expect(cmd.args).not.toContain('--full-auto')               // deprecated since Codex v0.128.0
      expect(cmd.args).not.toContain('--ask-for-approval')        // top-level only; errored after `exec`
      expect(cmd.args).not.toContain('approval_policy=never')     // silently overridden by harness
      expect(cmd.args).not.toContain('approval_policy=on-request') // silently overridden by harness
      expect(cmd.args).not.toContain('--dangerously-bypass-approvals-and-sandbox') // org-blocked dangerous-bypass
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
