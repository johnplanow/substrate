/**
 * Tests for WorkerAdapter interface requirements
 *
 * Verifies that:
 * - The interface structure exists as expected
 * - Implementations satisfy all required method signatures
 * - The type contract is enforced
 */

import { describe, it, expect } from 'vitest'
import type { WorkerAdapter } from '@adapters/worker-adapter'
import { ClaudeCodeAdapter } from '@adapters/claude-adapter'
import { CodexCLIAdapter } from '@adapters/codex-adapter'
import { GeminiCLIAdapter } from '@adapters/gemini-adapter'

/**
 * Helper: verify that an object satisfies the WorkerAdapter interface shape
 */
function assertWorkerAdapterShape(adapter: WorkerAdapter): void {
  // Readonly identity properties
  expect(typeof adapter.id).toBe('string')
  expect(adapter.id.length).toBeGreaterThan(0)
  expect(typeof adapter.displayName).toBe('string')
  expect(adapter.displayName.length).toBeGreaterThan(0)
  expect(typeof adapter.adapterVersion).toBe('string')
  expect(adapter.adapterVersion.length).toBeGreaterThan(0)

  // Required methods
  expect(typeof adapter.healthCheck).toBe('function')
  expect(typeof adapter.buildCommand).toBe('function')
  expect(typeof adapter.buildPlanningCommand).toBe('function')
  expect(typeof adapter.parseOutput).toBe('function')
  expect(typeof adapter.parsePlanOutput).toBe('function')
  expect(typeof adapter.estimateTokens).toBe('function')
  expect(typeof adapter.getCapabilities).toBe('function')
}

describe('WorkerAdapter Interface', () => {
  describe('Interface shape enforcement', () => {
    it('ClaudeCodeAdapter satisfies WorkerAdapter interface', () => {
      const adapter: WorkerAdapter = new ClaudeCodeAdapter()
      assertWorkerAdapterShape(adapter)
    })

    it('CodexCLIAdapter satisfies WorkerAdapter interface', () => {
      const adapter: WorkerAdapter = new CodexCLIAdapter()
      assertWorkerAdapterShape(adapter)
    })

    it('GeminiCLIAdapter satisfies WorkerAdapter interface', () => {
      const adapter: WorkerAdapter = new GeminiCLIAdapter()
      assertWorkerAdapterShape(adapter)
    })
  })

  describe('Identity properties are readonly', () => {
    it('ClaudeCodeAdapter has correct identity', () => {
      const adapter = new ClaudeCodeAdapter()
      expect(adapter.id).toBe('claude-code')
      expect(adapter.displayName).toBe('Claude Code')
      expect(adapter.adapterVersion).toBe('1.0.0')
    })

    it('CodexCLIAdapter has correct identity', () => {
      const adapter = new CodexCLIAdapter()
      expect(adapter.id).toBe('codex')
      expect(adapter.displayName).toBe('Codex CLI')
      expect(adapter.adapterVersion).toBe('1.0.0')
    })

    it('GeminiCLIAdapter has correct identity', () => {
      const adapter = new GeminiCLIAdapter()
      expect(adapter.id).toBe('gemini')
      expect(adapter.displayName).toBe('Gemini CLI')
      expect(adapter.adapterVersion).toBe('1.0.0')
    })
  })

  describe('All adapters have unique ids', () => {
    it('built-in adapter ids are all distinct', () => {
      const adapters = [
        new ClaudeCodeAdapter(),
        new CodexCLIAdapter(),
        new GeminiCLIAdapter(),
      ]
      const ids = adapters.map((a) => a.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(adapters.length)
    })
  })

  describe('getCapabilities returns correct shape', () => {
    it.each([
      ['ClaudeCodeAdapter', new ClaudeCodeAdapter()],
      ['CodexCLIAdapter', new CodexCLIAdapter()],
      ['GeminiCLIAdapter', new GeminiCLIAdapter()],
    ] as [string, WorkerAdapter][])('%s capabilities shape', (_name, adapter) => {
      const caps = adapter.getCapabilities()
      expect(typeof caps.supportsJsonOutput).toBe('boolean')
      expect(typeof caps.supportsStreaming).toBe('boolean')
      expect(typeof caps.supportsSubscriptionBilling).toBe('boolean')
      expect(typeof caps.supportsApiBilling).toBe('boolean')
      expect(typeof caps.supportsPlanGeneration).toBe('boolean')
      expect(typeof caps.maxContextTokens).toBe('number')
      expect(caps.maxContextTokens).toBeGreaterThan(0)
      expect(Array.isArray(caps.supportedTaskTypes)).toBe(true)
      expect(caps.supportedTaskTypes.length).toBeGreaterThan(0)
      expect(Array.isArray(caps.supportedLanguages)).toBe(true)
      expect(caps.supportedLanguages.length).toBeGreaterThan(0)
    })
  })

  describe('estimateTokens returns valid token estimate', () => {
    it.each([
      ['ClaudeCodeAdapter', new ClaudeCodeAdapter()],
      ['CodexCLIAdapter', new CodexCLIAdapter()],
      ['GeminiCLIAdapter', new GeminiCLIAdapter()],
    ] as [string, WorkerAdapter][])('%s estimateTokens', (_name, adapter) => {
      const prompt = 'Fix the failing tests in auth.ts'
      const estimate = adapter.estimateTokens(prompt)
      expect(typeof estimate.input).toBe('number')
      expect(typeof estimate.output).toBe('number')
      expect(typeof estimate.total).toBe('number')
      expect(estimate.input).toBeGreaterThan(0)
      expect(estimate.output).toBeGreaterThan(0)
      expect(estimate.total).toBe(estimate.input + estimate.output)
    })
  })
})
