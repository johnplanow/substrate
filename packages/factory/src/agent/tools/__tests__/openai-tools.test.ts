/**
 * Tests for OpenAI-specific tools (apply_patch wrapper).
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApplyPatchTool } from '../openai-tools.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('createApplyPatchTool', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openai-tool-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('has valid name, description, and inputSchema', () => {
    const tool = createApplyPatchTool()
    expect(tool.name).toBe('apply_patch')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.inputSchema).toHaveProperty('type', 'object')
    expect(tool.inputSchema.required).toContain('patch')
  })

  it('applies a v4a patch via executor with env.workdir', async () => {
    const filePath = join(tmpDir, 'test.ts')
    await writeFile(filePath, 'const x = 1;\nconst y = 2;\n', 'utf-8')

    const tool = createApplyPatchTool()
    const env = { workdir: tmpDir, exec: vi.fn() }

    const patch = [
      '*** Begin Patch',
      `*** Update File: test.ts`,
      '@@ const x = 1;',
      '-const x = 1;',
      '+const x = 42;',
      '*** End Patch',
    ].join('\n')

    const result = await tool.executor({ patch }, env)
    expect(result).toContain('Applied')

    const updated = await readFile(filePath, 'utf-8')
    expect(updated).toContain('const x = 42;')
  })
})

describe('all tool definitions schema validation', () => {
  it('apply_patch has required inputSchema fields', () => {
    const tool = createApplyPatchTool()
    const schema = tool.inputSchema as {
      type: string
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('patch')
    expect(schema.required).toContain('patch')
  })
})
