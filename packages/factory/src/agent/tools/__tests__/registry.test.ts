/**
 * Tests for ToolRegistry.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry } from '../registry.js'
import type { ToolDefinition, ExecutionEnvironment } from '../types.js'

function makeEnv(): ExecutionEnvironment {
  return {
    workdir: '/tmp',
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  }
}

function makeTool(overrides?: Partial<ToolDefinition<unknown>>): ToolDefinition<{ input: string }> {
  return {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
      required: ['input'],
    },
    executor: vi.fn().mockResolvedValue('result'),
    ...overrides,
  } as ToolDefinition<{ input: string }>
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('execute success returns content with truncation applied', async () => {
    const longResult = 'x'.repeat(200)
    const tool = makeTool({
      name: 'truncate_tool',
      outputTruncation: 100,
      executor: vi.fn().mockResolvedValue(longResult),
    })
    registry.register(tool as unknown as ToolDefinition<unknown>)

    const result = await registry.execute('truncate_tool', { input: 'test' }, makeEnv())
    expect(result.isError).toBe(false)
    expect(result.content).toBe('x'.repeat(100) + '\n[truncated]')
  })

  it('execute unknown tool returns isError result', async () => {
    const result = await registry.execute('nonexistent_tool', {}, makeEnv())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unknown tool: nonexistent_tool')
  })

  it('schema validation failure returns isError result (consistent with other error paths)', async () => {
    const tool = makeTool({ name: 'strict_tool' })
    registry.register(tool as unknown as ToolDefinition<unknown>)

    // Pass wrong type for 'input' (should be string, passing number)
    const result = await registry.execute('strict_tool', { input: 123 }, makeEnv())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Validation failed')
  })

  it('executor error returns isError result (no throw)', async () => {
    const tool = makeTool({
      name: 'error_tool',
      executor: vi.fn().mockRejectedValue(new Error('executor blew up')),
    })
    registry.register(tool as unknown as ToolDefinition<unknown>)

    const result = await registry.execute('error_tool', { input: 'x' }, makeEnv())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('executor blew up')
  })

  it('getDefinitions returns all registered tools', () => {
    const t1 = makeTool({ name: 'tool_a' })
    const t2 = makeTool({ name: 'tool_b' })
    registry.register(t1 as unknown as ToolDefinition<unknown>)
    registry.register(t2 as unknown as ToolDefinition<unknown>)

    const defs = registry.getDefinitions()
    expect(defs).toHaveLength(2)
    expect(defs.map((d) => d.name)).toContain('tool_a')
    expect(defs.map((d) => d.name)).toContain('tool_b')
  })

  it('get returns tool by name or undefined', () => {
    const tool = makeTool({ name: 'my_tool' })
    registry.register(tool as unknown as ToolDefinition<unknown>)

    expect(registry.get('my_tool')).toBeDefined()
    expect(registry.get('missing')).toBeUndefined()
  })

  it('register overwrites duplicate tool name', async () => {
    const original = makeTool({ name: 'dup', executor: vi.fn().mockResolvedValue('original') })
    const replacement = makeTool({
      name: 'dup',
      executor: vi.fn().mockResolvedValue('replacement'),
    })
    registry.register(original as unknown as ToolDefinition<unknown>)
    registry.register(replacement as unknown as ToolDefinition<unknown>)

    const result = await registry.execute('dup', { input: 'test' }, makeEnv())
    expect(result.content).toBe('replacement')
    expect(registry.getDefinitions()).toHaveLength(1)
  })
})
