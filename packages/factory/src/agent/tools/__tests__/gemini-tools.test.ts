/**
 * Tests for Gemini-specific tool executors.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createReadManyFilesTool, createListDirTool, createGeminiEditFileTool } from '../gemini-tools.js'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mockEnv = { workdir: '/tmp', exec: vi.fn() }

describe('createReadManyFilesTool — executor', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemini-tool-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('reads multiple files with headers and line numbers', async () => {
    await writeFile(join(tmpDir, 'a.ts'), 'line1\nline2\n', 'utf-8')
    await writeFile(join(tmpDir, 'b.ts'), 'hello\n', 'utf-8')

    const tool = createReadManyFilesTool()
    const result = await tool.executor({ paths: [join(tmpDir, 'a.ts'), join(tmpDir, 'b.ts')] }, mockEnv)

    expect(result).toContain('=== ' + join(tmpDir, 'a.ts') + ' ===')
    expect(result).toContain('=== ' + join(tmpDir, 'b.ts') + ' ===')
    expect(result).toContain('line1')
    expect(result).toContain('hello')
  })

  it('handles missing files gracefully with error message', async () => {
    const tool = createReadManyFilesTool()
    const result = await tool.executor({ paths: [join(tmpDir, 'missing.ts')] }, mockEnv)

    expect(result).toContain('error reading file')
  })
})

describe('createListDirTool — executor', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemini-tool-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('lists directories first, then files, both sorted alphabetically', async () => {
    await mkdir(join(tmpDir, 'bDir'))
    await mkdir(join(tmpDir, 'aDir'))
    await writeFile(join(tmpDir, 'zFile.ts'), '', 'utf-8')
    await writeFile(join(tmpDir, 'aFile.ts'), '', 'utf-8')

    const tool = createListDirTool()
    const result = await tool.executor({ path: tmpDir }, mockEnv)
    const lines = result.split('\n')

    // Dirs first, sorted
    expect(lines[0]).toBe('[DIR] aDir')
    expect(lines[1]).toBe('[DIR] bDir')
    // Files next, sorted
    expect(lines[2]).toBe('[FILE] aFile.ts')
    expect(lines[3]).toBe('[FILE] zFile.ts')
  })
})

describe('createGeminiEditFileTool — executor', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemini-tool-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('uses file_path parameter (not path) for Gemini convention', async () => {
    const filePath = join(tmpDir, 'test.ts')
    await writeFile(filePath, 'const x = 1;\n', 'utf-8')

    const tool = createGeminiEditFileTool()
    expect(tool.inputSchema.required).toContain('file_path')

    const result = await tool.executor({ file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 42;' }, mockEnv)

    expect(result).toContain('Edited')
    const updated = await readFile(filePath, 'utf-8')
    expect(updated).toContain('const x = 42;')
  })

  it('has valid inputSchema and description', () => {
    const tool = createGeminiEditFileTool()
    expect(tool.name).toBe('edit_file')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.inputSchema).toHaveProperty('type', 'object')
  })
})

describe('all tool definitions have valid schema and description', () => {
  const allTools = [
    createReadManyFilesTool(),
    createListDirTool(),
    createGeminiEditFileTool(),
  ]

  for (const tool of allTools) {
    it(`${tool.name} has non-empty description and valid inputSchema`, () => {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema).toHaveProperty('type', 'object')
      expect(tool.inputSchema).toHaveProperty('properties')
    })
  }
})
