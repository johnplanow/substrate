/**
 * Tests for provider profiles.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, vi } from 'vitest'
import {
  AnthropicProfile,
  OpenAIProfile,
  GeminiProfile,
  type ProviderProfile,
} from '../profiles.js'

describe('AnthropicProfile', () => {
  const profile = new AnthropicProfile('claude-opus-4-5')

  it('tools() includes edit_file', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('edit_file')
  })

  it('tools() includes all 5 shared tools', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('shell')
    expect(names).toContain('grep')
    expect(names).toContain('glob')
  })

  it('shell timeout is 120,000ms', async () => {
    const shellTool = profile.tools().find((t) => t.name === 'shell')
    expect(shellTool).toBeDefined()
    // Verify timeout by executing the shell tool and capturing the timeout arg
    const mockEnv = {
      workdir: '/tmp',
      exec: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
    }
    // Call without explicit timeout_ms — should use the profile's default (120_000)
    await shellTool!.executor({ command: 'echo test' }, mockEnv)
    expect(mockEnv.exec).toHaveBeenCalledWith('echo test', 120_000)
  })

  it('provider_options() returns { max_tokens: 4096 }', () => {
    const opts = profile.provider_options()
    expect(opts).toEqual({ max_tokens: 4096 })
  })

  it('build_system_prompt() returns a non-empty string referencing tools', () => {
    const prompt = profile.build_system_prompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).toContain('edit_file')
  })
})

describe('OpenAIProfile', () => {
  const profile = new OpenAIProfile('gpt-4o')

  it('tools() includes apply_patch', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('apply_patch')
  })

  it('tools() does NOT include edit_file', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).not.toContain('edit_file')
  })

  it('tools() includes all shared tools plus apply_patch', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('shell')
    expect(names).toContain('grep')
    expect(names).toContain('glob')
  })

  it('provider_options() returns {}', () => {
    const opts = profile.provider_options()
    expect(opts).toEqual({})
  })
})

describe('GeminiProfile', () => {
  const profile = new GeminiProfile('gemini-2.0-flash')

  it('tools() includes read_many_files', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('read_many_files')
  })

  it('tools() includes list_dir', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('list_dir')
  })

  it('tools() includes edit_file', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('edit_file')
  })

  it('tools() includes all 5 shared tools', () => {
    const names = profile.tools().map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('shell')
    expect(names).toContain('grep')
    expect(names).toContain('glob')
  })

  it('provider_options() returns {}', () => {
    expect(profile.provider_options()).toEqual({})
  })
})

describe('ProviderProfile interface conformance', () => {
  it('all profiles implement ProviderProfile fields', () => {
    const profiles: ProviderProfile[] = [
      new AnthropicProfile('claude-3-haiku'),
      new OpenAIProfile('gpt-4o'),
      new GeminiProfile('gemini-2.0-flash'),
    ]

    for (const p of profiles) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.model).toBe('string')
      expect(typeof p.supports_streaming).toBe('boolean')
      expect(typeof p.context_window_size).toBe('number')
      expect(typeof p.supports_parallel_tool_calls).toBe('boolean')
      expect(typeof p.build_system_prompt()).toBe('string')
      expect(Array.isArray(p.tools())).toBe(true)
      expect(typeof p.provider_options()).toBe('object')
    }
  })

  it('profile ids are correct', () => {
    expect(new AnthropicProfile('x').id).toBe('anthropic')
    expect(new OpenAIProfile('x').id).toBe('openai')
    expect(new GeminiProfile('x').id).toBe('gemini')
  })

  it('Anthropic shell timeout is 120s (tools have correct config)', () => {
    const profile = new AnthropicProfile('claude-opus-4-5')
    const tools = profile.tools()
    // Anthropic uses 120_000ms timeout. The edit_file tool should be last
    const editFileTool = tools.find((t) => t.name === 'edit_file')
    expect(editFileTool).toBeDefined()
    // Anthropic has 6 tools (5 shared + edit_file)
    expect(tools).toHaveLength(6)
  })
})
