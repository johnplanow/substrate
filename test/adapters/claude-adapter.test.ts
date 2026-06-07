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

    it('surfaces compatibilityWarning when the live CLI version is below the tested range', async () => {
      // Substrate's tested range for Claude Code is [2.1.152, 2.1.158]; 1.0.0
      // is well below it. Operator should see a noisy first-dispatch hint
      // pointing at the drift instead of a silent unexpected behavior.
      mockExecResolve('1.0.0\n')
      mockExecResolve('/usr/local/bin/claude\n')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.compatibilityWarning).toMatch(/claude-code/)
      expect(result.compatibilityWarning).toMatch(/below substrate's tested range/i)
    })

    it('surfaces the in-range note when version is compatible but the range carries a caveat', async () => {
      // 2.1.158 IS within range; the range note ("--max-turns silently ignored")
      // is still surfaced as informational.
      mockExecResolve('2.1.158\n')
      mockExecResolve('/usr/local/bin/claude\n')

      const result = await adapter.healthCheck()

      expect(result.healthy).toBe(true)
      expect(result.compatibilityWarning).toMatch(/--max-turns/)
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

    it('includes -p flag but not prompt in args (prompt delivered via stdin)', () => {
      const prompt = 'Fix the bug in auth.ts'
      const cmd = adapter.buildCommand(prompt, defaultOptions)
      expect(cmd.args).toContain('-p')
      // Prompt must NOT be in args — avoids E2BIG on large prompts
      expect(cmd.args).not.toContain(prompt)
    })

    it('uses --output-format stream-json (not json) so YAML extraction receives plain text via parseStreamOutput', () => {
      // Story 81-9: buildCommand now emits --output-format stream-json so that
      // parseStreamOutput() can extract both the agent text and the turn count
      // (num_turns) from the NDJSON stream's terminal result event.
      //
      // The plain `--output-format json` form is intentionally avoided: it wraps
      // the entire response in a single JSON envelope and breaks extractYamlBlock.
      // stream-json is safe because parseStreamOutput extracts the `result` field
      // (identical to raw text mode) before YAML extraction runs.
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      const fmtIdx = cmd.args.indexOf('--output-format')
      expect(fmtIdx).toBeGreaterThanOrEqual(0)
      expect(cmd.args[fmtIdx + 1]).toBe('stream-json')
      // Must NOT use plain 'json' format (causes JSON envelope that breaks YAML extraction)
      expect(cmd.args).not.toContain('json')
    })

    it('passes --verbose alongside stream-json (required by claude -p; hard-errors without it)', () => {
      // Claude Code 2.1.168: `claude -p --output-format stream-json` exits
      // immediately with "When using --print, --output-format=stream-json
      // requires --verbose". Empirically confirmed 2026-06-07 — every Phase 4.2
      // v5 eval dispatch failed in <1s until --verbose was added. This test
      // pins the pairing so the flag cannot be dropped independently.
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.args).toContain('--output-format')
      expect(cmd.args).toContain('--verbose')
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

    it('returns empty env when no apiKey provided', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.env).toEqual({})
    })

    it('includes unsetEnvKeys with CLAUDECODE', () => {
      const cmd = adapter.buildCommand('Fix it', defaultOptions)
      expect(cmd.unsetEnvKeys).toContain('CLAUDECODE')
    })

    it('unsets ANTHROPIC_API_KEY when not in API billing mode', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        billingMode: 'subscription',
      })
      expect(cmd.unsetEnvKeys).toContain('ANTHROPIC_API_KEY')
      expect(cmd.env?.ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('sets OTEL_EXPORTER_OTLP_TIMEOUT when otlpEndpoint provided', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        otlpEndpoint: 'http://localhost:4318',
      })
      expect(cmd.env?.OTEL_EXPORTER_OTLP_TIMEOUT).toBe('5000')
    })

    it('sets all OTLP env vars when otlpEndpoint provided', () => {
      const cmd = adapter.buildCommand('Fix it', {
        ...defaultOptions,
        otlpEndpoint: 'http://localhost:4318',
        storyKey: '5-1',
      })
      expect(cmd.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
      expect(cmd.env?.OTEL_LOGS_EXPORTER).toBe('otlp')
      expect(cmd.env?.OTEL_METRICS_EXPORTER).toBe('otlp')
      expect(cmd.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json')
      expect(cmd.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318')
      expect(cmd.env?.OTEL_RESOURCE_ATTRIBUTES).toBe('substrate.story_key=5-1')
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

    it('does not include --output-format json (causes Claude event envelope wrapping)', () => {
      const cmd = adapter.buildPlanningCommand(
        { goal: 'Build auth' },
        defaultOptions
      )
      expect(cmd.args).not.toContain('--output-format')
    })

    it('does not include goal in CLI args (prompt delivered via stdin)', () => {
      const goal = 'Implement user authentication'
      const cmd = adapter.buildPlanningCommand({ goal }, defaultOptions)
      expect(cmd.args).toContain('-p')
      // Goal must NOT be in args — avoids E2BIG on large prompts
      const argsJoined = cmd.args.join(' ')
      expect(argsJoined).not.toContain(goal)
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
  // parseStreamOutput (Story 81-9)
  // -------------------------------------------------------------------------
  describe('parseStreamOutput', () => {
    /**
     * Build a minimal NDJSON stream as Claude Code CLI emits with --output-format stream-json.
     * Each argument becomes one line (JSON-stringified).
     */
    function makeNdjson(...events: object[]): string {
      return events.map((e) => JSON.stringify(e)).join('\n')
    }

    it('(AC5a) extracts totalTurns from a well-formed stream-json result event', () => {
      const agentText = '```yaml\nresult: success\nac_met:\n  - AC1\n```'
      const ndjson = makeNdjson(
        { type: 'system', subtype: 'init', session_id: 'abc123' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } },
        { type: 'result', subtype: 'success', result: agentText, num_turns: 7, is_error: false },
      )
      const out = adapter.parseStreamOutput(ndjson)
      expect(out.totalTurns).toBe(7)
      expect(out.extractedText).toBe(agentText)
    })

    it('(AC5a) extracts extractedText and passes it through for YAML extraction', () => {
      const agentText = 'Some response text with\n```yaml\nresult: success\n```'
      const ndjson = makeNdjson(
        { type: 'result', subtype: 'success', result: agentText, num_turns: 3 },
      )
      const out = adapter.parseStreamOutput(ndjson)
      expect(out.extractedText).toBe(agentText)
      expect(out.extractedText).toContain('result: success')
    })

    it('(AC5b) returns absent totalTurns (not 0, not fabricated) when num_turns is missing from event', () => {
      const ndjson = makeNdjson(
        { type: 'result', subtype: 'success', result: 'some output' },
      )
      const out = adapter.parseStreamOutput(ndjson)
      // Field must be ABSENT — not 0, not null, never fabricated
      expect(out.totalTurns).toBeUndefined()
      expect('totalTurns' in out).toBe(false)
    })

    it('(AC5b) returns absent totalTurns when the stream has no result event', () => {
      const ndjson = makeNdjson(
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: {} },
      )
      const out = adapter.parseStreamOutput(ndjson)
      expect(out.totalTurns).toBeUndefined()
    })

    it('falls back to raw stdout as extractedText when no result event is found', () => {
      const rawStdout = 'No JSON events here, just raw text with ```yaml\nresult: success\n```'
      const out = adapter.parseStreamOutput(rawStdout)
      expect(out.extractedText).toBe(rawStdout)
      expect(out.totalTurns).toBeUndefined()
    })

    it('falls back gracefully when result event has empty result field', () => {
      const ndjson = makeNdjson(
        { type: 'result', subtype: 'success', result: '', num_turns: 5 },
      )
      const out = adapter.parseStreamOutput(ndjson)
      // Empty result field → fall back to raw stdout (the NDJSON itself)
      expect(out.extractedText.length).toBeGreaterThan(0)
      // Turn count still extracted even if text extraction fell back
      expect(out.totalTurns).toBe(5)
    })

    it('skips malformed JSON lines and still finds the result event', () => {
      const agentText = '```yaml\nresult: success\n```'
      const ndjson = [
        '{not valid json}',
        JSON.stringify({ type: 'result', subtype: 'success', result: agentText, num_turns: 4 }),
      ].join('\n')
      const out = adapter.parseStreamOutput(ndjson)
      expect(out.totalTurns).toBe(4)
      expect(out.extractedText).toBe(agentText)
    })

    it('handles zero num_turns (valid: agent made 0 agentic turns)', () => {
      const ndjson = makeNdjson(
        { type: 'result', subtype: 'success', result: 'output', num_turns: 0 },
      )
      const out = adapter.parseStreamOutput(ndjson)
      // 0 is a valid turn count (not fabricated) — include it
      expect(out.totalTurns).toBe(0)
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
