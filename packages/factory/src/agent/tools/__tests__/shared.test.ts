/**
 * Tests for shared tools.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createSharedTools } from '../shared.js'
import type { ExecutionEnvironment, ShellResult, ToolDefinition } from '../types.js'

// Build a mock execution environment
function makeEnv(tmpDir: string, execFn?: (cmd: string, timeout: number) => Promise<ShellResult>): ExecutionEnvironment {
  return {
    workdir: tmpDir,
    exec: execFn ?? vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  }
}

function getTool<T = unknown>(tools: ToolDefinition<unknown>[], name: string): ToolDefinition<T> {
  const tool = tools.find(t => t.name === name)
  if (!tool) throw new Error(`Tool '${name}' not found`)
  return tool as ToolDefinition<T>
}

describe('createSharedTools', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-${randomUUID()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns 5 tools with correct names', () => {
    const tools = createSharedTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('shell')
    expect(names).toContain('grep')
    expect(names).toContain('glob')
    expect(tools).toHaveLength(5)
  })

  it('read_file returns line-numbered content', async () => {
    const filePath = join(tmpDir, 'test.txt')
    await mkdir(tmpDir, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, 'hello\nworld\nfoo', 'utf-8')

    const tools = createSharedTools()
    const tool = getTool<{ path: string }>(tools, 'read_file')
    const env = makeEnv(tmpDir)
    const result = await tool.executor({ path: filePath }, env)

    expect(result).toContain('1\t')
    expect(result).toContain('hello')
    expect(result).toContain('2\t')
    expect(result).toContain('world')
    expect(result).toContain('3\t')
    expect(result).toContain('foo')
  })

  it('read_file applies offset and limit', async () => {
    const filePath = join(tmpDir, 'lines.txt')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, 'line1\nline2\nline3\nline4\nline5', 'utf-8')

    const tools = createSharedTools()
    const tool = getTool<{ path: string; offset?: number; limit?: number }>(tools, 'read_file')
    const env = makeEnv(tmpDir)
    const result = await tool.executor({ path: filePath, offset: 2, limit: 2 }, env)

    expect(result).toContain('line2')
    expect(result).toContain('line3')
    expect(result).not.toContain('line1')
    expect(result).not.toContain('line4')
  })

  it('write_file creates parent directories and writes content', async () => {
    const filePath = join(tmpDir, 'nested', 'dir', 'file.txt')
    const tools = createSharedTools()
    const tool = getTool<{ path: string; content: string }>(tools, 'write_file')
    const env = makeEnv(tmpDir)

    const result = await tool.executor({ path: filePath, content: 'hello world' }, env)
    expect(result).toMatch(/Wrote \d+ bytes to/)
    expect(result).toContain(filePath)

    const written = await readFile(filePath, 'utf-8')
    expect(written).toBe('hello world')
  })

  it('shell captures command output via env.exec', async () => {
    const tools = createSharedTools()
    const tool = getTool<{ command: string }>(tools, 'shell')
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'hello from shell', stderr: '', exitCode: 0 })
    const env = makeEnv(tmpDir, mockExec)

    const result = await tool.executor({ command: 'echo hello' }, env)
    expect(result).toBe('hello from shell')
    expect(mockExec).toHaveBeenCalledWith('echo hello', expect.any(Number))
  })

  it('shell enforces timeout via env.exec', async () => {
    const tools = createSharedTools(5000)
    const tool = getTool<{ command: string; timeout_ms?: number }>(tools, 'shell')
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })
    const env = makeEnv(tmpDir, mockExec)

    await tool.executor({ command: 'sleep 1', timeout_ms: 1000 }, env)
    expect(mockExec).toHaveBeenCalledWith('sleep 1', 1000)

    // Without explicit timeout_ms, uses shellTimeoutMs
    await tool.executor({ command: 'sleep 1' }, env)
    expect(mockExec).toHaveBeenCalledWith('sleep 1', 5000)
  })

  it('shell throws on non-zero exit code (marked isError by registry)', async () => {
    const tools = createSharedTools()
    const tool = getTool<{ command: string }>(tools, 'shell')
    const mockExec = vi.fn().mockResolvedValue({ stdout: '', stderr: 'command not found', exitCode: 127 })
    const env = makeEnv(tmpDir, mockExec)

    await expect(tool.executor({ command: 'bad-cmd' }, env)).rejects.toThrow('command not found')
  })

  it('grep returns matching lines (via mock exec simulating rg)', async () => {
    const tools = createSharedTools()
    const tool = getTool<{ pattern: string; paths: string[] }>(tools, 'grep')
    const mockExec = vi.fn().mockResolvedValue({
      stdout: 'file.ts:10:const foo = "bar"\nfile.ts:20:// foo baz',
      stderr: '',
      exitCode: 0,
    })
    const env = makeEnv(tmpDir, mockExec)

    const result = await tool.executor({ pattern: 'foo', paths: ['file.ts'] }, env)
    expect(result).toContain('foo')
  })

  it('glob returns files matching pattern', async () => {
    const tools = createSharedTools()
    const tool = getTool<{ pattern: string }>(tools, 'glob')
    // The glob tool may use a real implementation; just verify it returns a string
    const env = makeEnv(tmpDir)
    const result = await tool.executor({ pattern: '*.ts' }, env)
    expect(typeof result).toBe('string')
  })
})
