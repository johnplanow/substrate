/**
 * Tests for Anthropic edit_file tool executor.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEditFileTool } from '../anthropic-tools.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mockEnv = { workdir: '/tmp', exec: vi.fn() }

describe('createEditFileTool — executor', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'edit-tool-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('replaces old_string with new_string when unique match exists', async () => {
    const filePath = join(tmpDir, 'test.ts')
    await writeFile(filePath, 'const x = 1;\nconst y = 2;\n', 'utf-8')

    const tool = createEditFileTool()
    const result = await tool.executor(
      { path: filePath, old_string: 'const x = 1;', new_string: 'const x = 42;' },
      mockEnv
    )

    expect(result).toContain('Edited')
    const updated = await readFile(filePath, 'utf-8')
    expect(updated).toContain('const x = 42;')
    expect(updated).toContain('const y = 2;')
  })

  it('throws when old_string is not found', async () => {
    const filePath = join(tmpDir, 'test.ts')
    await writeFile(filePath, 'const x = 1;\n', 'utf-8')

    const tool = createEditFileTool()
    await expect(
      tool.executor(
        { path: filePath, old_string: 'nonexistent', new_string: 'replacement' },
        mockEnv
      )
    ).rejects.toThrow('old_string not found in file')
  })

  it('throws when old_string is ambiguous (multiple matches)', async () => {
    const filePath = join(tmpDir, 'test.ts')
    await writeFile(filePath, 'foo\nfoo\nbar\n', 'utf-8')

    const tool = createEditFileTool()
    await expect(
      tool.executor({ path: filePath, old_string: 'foo', new_string: 'baz' }, mockEnv)
    ).rejects.toThrow('ambiguous (found 2 times)')
  })

  it('has valid inputSchema and description', () => {
    const tool = createEditFileTool()
    expect(tool.name).toBe('edit_file')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.inputSchema).toHaveProperty('type', 'object')
    expect(tool.inputSchema).toHaveProperty('required')
  })
})
