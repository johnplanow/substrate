/**
 * Tests for AdapterRegistry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { exec } from 'child_process'
import { AdapterRegistry } from '@adapters/adapter-registry'
import { ClaudeCodeAdapter } from '@adapters/claude-adapter'
import { CodexCLIAdapter } from '@adapters/codex-adapter'
import { GeminiCLIAdapter } from '@adapters/gemini-adapter'
import type { WorkerAdapter } from '@adapters/worker-adapter'
import type { AdapterCapabilities, AdapterHealthResult } from '@adapters/types'

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

function mockExecRejectAll(): void {
  mockExec.mockImplementation(
    (_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string } | null) => void) => {
      cb(new Error('not found'), null)
    }
  )
}

// ---------------------------------------------------------------------------
// Stub adapter for testing registry CRUD
// ---------------------------------------------------------------------------
function createStubAdapter(
  id: string,
  healthy: boolean,
  planningCapable = true
): WorkerAdapter {
  return {
    id,
    displayName: `${id} Display`,
    adapterVersion: '1.0.0',
    healthCheck: vi.fn().mockResolvedValue({
      healthy,
      supportsHeadless: healthy,
      error: healthy ? undefined : `${id} not found`,
    } as AdapterHealthResult),
    buildCommand: vi.fn(),
    buildPlanningCommand: vi.fn(),
    parseOutput: vi.fn(),
    parsePlanOutput: vi.fn(),
    estimateTokens: vi.fn(),
    getCapabilities: vi.fn().mockReturnValue({
      supportsJsonOutput: true,
      supportsStreaming: false,
      supportsSubscriptionBilling: false,
      supportsApiBilling: true,
      supportsPlanGeneration: planningCapable,
      maxContextTokens: 10_000,
      supportedTaskTypes: ['code'],
      supportedLanguages: ['*'],
    } as AdapterCapabilities),
  }
}

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry

  beforeEach(() => {
    registry = new AdapterRegistry()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // register / get
  // -------------------------------------------------------------------------
  describe('register and get', () => {
    it('registers an adapter and retrieves it by id', () => {
      const adapter = createStubAdapter('test-agent', true)
      registry.register(adapter)
      expect(registry.get('test-agent')).toBe(adapter)
    })

    it('returns undefined for unknown adapter id', () => {
      expect(registry.get('unknown-id')).toBeUndefined()
    })

    it('overwrites existing adapter with same id', () => {
      const v1 = createStubAdapter('my-agent', true)
      const v2 = createStubAdapter('my-agent', true)
      registry.register(v1)
      registry.register(v2)
      expect(registry.get('my-agent')).toBe(v2)
    })
  })

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------
  describe('getAll', () => {
    it('returns empty array when no adapters registered', () => {
      expect(registry.getAll()).toEqual([])
    })

    it('returns all registered adapters', () => {
      const a1 = createStubAdapter('agent-1', true)
      const a2 = createStubAdapter('agent-2', true)
      registry.register(a1)
      registry.register(a2)
      const all = registry.getAll()
      expect(all).toHaveLength(2)
      expect(all).toContain(a1)
      expect(all).toContain(a2)
    })
  })

  // -------------------------------------------------------------------------
  // getPlanningCapable
  // -------------------------------------------------------------------------
  describe('getPlanningCapable', () => {
    it('returns empty array when no adapters registered', () => {
      expect(registry.getPlanningCapable()).toEqual([])
    })

    it('returns only adapters with supportsPlanGeneration true', () => {
      const planning = createStubAdapter('planning-agent', true, true)
      const nonPlanning = createStubAdapter('no-plan-agent', true, false)
      registry.register(planning)
      registry.register(nonPlanning)

      const capable = registry.getPlanningCapable()
      expect(capable).toContain(planning)
      expect(capable).not.toContain(nonPlanning)
    })

    it('returns all adapters if all support planning', () => {
      registry.register(createStubAdapter('a1', true, true))
      registry.register(createStubAdapter('a2', true, true))
      expect(registry.getPlanningCapable()).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // discoverAndRegister - with mocked execSync
  // -------------------------------------------------------------------------
  describe('discoverAndRegister', () => {
    it('registers all healthy adapters', async () => {
      // All three adapters will succeed (each does --version + which)
      // ClaudeCodeAdapter
      mockExecResolve('1.0.0\n')
      mockExecResolve('/usr/bin/claude\n')
      // CodexCLIAdapter
      mockExecResolve('codex 0.1.0\n')
      mockExecResolve('/usr/bin/codex\n')
      // GeminiCLIAdapter
      mockExecResolve('Gemini 1.0.0\n')
      mockExecResolve('/usr/bin/gemini\n')

      const report = await registry.discoverAndRegister()

      expect(report.registeredCount).toBe(3)
      expect(report.failedCount).toBe(0)
      expect(registry.get('claude-code')).toBeInstanceOf(ClaudeCodeAdapter)
      expect(registry.get('codex')).toBeInstanceOf(CodexCLIAdapter)
      expect(registry.get('gemini')).toBeInstanceOf(GeminiCLIAdapter)
    })

    it('excludes unhealthy adapters from registry but reports them', async () => {
      // Claude succeeds
      mockExecResolve('1.0.0\n')
      mockExecResolve('/usr/bin/claude\n')
      // Codex fails
      mockExecReject('codex not found')
      // Gemini fails
      mockExecReject('gemini not found')

      const report = await registry.discoverAndRegister()

      expect(report.registeredCount).toBe(1)
      expect(report.failedCount).toBe(2)
      expect(registry.get('claude-code')).toBeInstanceOf(ClaudeCodeAdapter)
      expect(registry.get('codex')).toBeUndefined()
      expect(registry.get('gemini')).toBeUndefined()
    })

    it('handles all adapters unhealthy without throwing', async () => {
      mockExecRejectAll()

      const report = await registry.discoverAndRegister()

      expect(report.registeredCount).toBe(0)
      expect(report.failedCount).toBe(3)
      expect(registry.getAll()).toHaveLength(0)
    })

    it('returns detailed per-adapter results', async () => {
      // Claude succeeds
      mockExecResolve('1.0.0\n')
      mockExecResolve('/usr/bin/claude\n')
      // Codex fails
      mockExecReject('codex not found')
      // Gemini fails
      mockExecReject('gemini not found')

      const report = await registry.discoverAndRegister()

      expect(report.results).toHaveLength(3)

      const claudeResult = report.results.find((r) => r.adapterId === 'claude-code')
      expect(claudeResult?.registered).toBe(true)
      expect(claudeResult?.healthResult.healthy).toBe(true)

      const codexResult = report.results.find((r) => r.adapterId === 'codex')
      expect(codexResult?.registered).toBe(false)
      expect(codexResult?.healthResult.healthy).toBe(false)
    })

    it('handles unexpected error during healthCheck without throwing', async () => {
      // Simulate an adapter whose healthCheck itself throws (unexpected)
      const registry2 = new AdapterRegistry()

      // Override with a patched adapter that throws from healthCheck
      const claudeProto = ClaudeCodeAdapter.prototype
      const origHealthCheck = claudeProto.healthCheck.bind(claudeProto)
      vi.spyOn(claudeProto, 'healthCheck').mockRejectedValueOnce(
        new Error('Unexpected internal error')
      )

      // Codex and Gemini succeed
      mockExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
          cb(null, { stdout: '1.0.0\n', stderr: '' })
        }
      )

      const report = await registry2.discoverAndRegister()
      // Claude health check threw — should be counted as failed
      const claudeResult = report.results.find((r) => r.adapterId === 'claude-code')
      expect(claudeResult?.registered).toBe(false)

      vi.spyOn(claudeProto, 'healthCheck').mockImplementation(origHealthCheck)
    })
  })

  // -------------------------------------------------------------------------
  // Integration: register manual adapter then discover
  // -------------------------------------------------------------------------
  describe('manual registration + discovery', () => {
    it('can manually register adapter before discovery', () => {
      const custom = createStubAdapter('custom-agent', true)
      registry.register(custom)
      expect(registry.get('custom-agent')).toBe(custom)
    })

    it('manual adapter survives after discoverAndRegister (different id)', async () => {
      const custom = createStubAdapter('custom-agent', true)
      registry.register(custom)

      // All built-in adapters fail
      mockExecRejectAll()

      await registry.discoverAndRegister()

      // Custom adapter should still be there
      expect(registry.get('custom-agent')).toBe(custom)
    })
  })
})
