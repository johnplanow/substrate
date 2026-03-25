/**
 * Tests for applyV4aPatch.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { applyV4aPatch } from '../openai-tools.js'

describe('applyV4aPatch', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `patch-test-${randomUUID()}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('updates an existing file with one removed and one added line', async () => {
    const filePath = join(tmpDir, 'hello.ts')
    await writeFile(filePath, 'const x = 1\nconst y = 2\nconst z = 3\n', 'utf-8')

    const patch = [
      '*** Begin Patch',
      '*** Update File: hello.ts',
      '@@ context',
      '-const y = 2',
      '+const y = 99',
      '*** End Patch',
    ].join('\n')

    const result = await applyV4aPatch(patch, tmpDir)
    expect(result).toContain('hello.ts')

    const updated = await readFile(filePath, 'utf-8')
    expect(updated).toContain('const y = 99')
    expect(updated).not.toContain('const y = 2')
  })

  it('adds a new file from *** Add File block', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new-file.ts',
      '+export const version = 1',
      '+export const name = "test"',
      '*** End Patch',
    ].join('\n')

    const result = await applyV4aPatch(patch, tmpDir)
    expect(result).toContain('new-file.ts')

    const created = await readFile(join(tmpDir, 'new-file.ts'), 'utf-8')
    expect(created).toContain('export const version = 1')
    expect(created).toContain('export const name = "test"')
  })

  it('handles multiple hunks in one file', async () => {
    const filePath = join(tmpDir, 'multi.ts')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf-8')

    const patch = [
      '*** Begin Patch',
      '*** Update File: multi.ts',
      '@@ first hunk',
      '-a',
      '+A',
      '@@ second hunk',
      '-c',
      '+C',
      '*** End Patch',
    ].join('\n')

    const result = await applyV4aPatch(patch, tmpDir)
    expect(result).toContain('multi.ts')

    const updated = await readFile(filePath, 'utf-8')
    expect(updated).toContain('A')
    expect(updated).toContain('C')
  })

  it('throws error when file not found in update block', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: nonexistent.ts',
      '@@ hunk',
      '-old line',
      '+new line',
      '*** End Patch',
    ].join('\n')

    await expect(applyV4aPatch(patch, tmpDir)).rejects.toThrow()
  })

  it('throws error for malformed patch (missing Begin Patch)', async () => {
    const patch = '*** Update File: foo.ts\n@@ hunk\n-old\n+new\n*** End Patch'
    await expect(applyV4aPatch(patch, tmpDir)).rejects.toThrow(/Malformed patch/)
  })

  it('throws error for malformed patch (missing End Patch)', async () => {
    const patch = '*** Begin Patch\n*** Update File: foo.ts\n@@ hunk\n-old\n+new'
    await expect(applyV4aPatch(patch, tmpDir)).rejects.toThrow(/Malformed patch/)
  })

  it('handles patch with multiple files', async () => {
    const file1 = join(tmpDir, 'file1.ts')
    const file2 = join(tmpDir, 'file2.ts')
    await writeFile(file1, 'original1\n', 'utf-8')
    await writeFile(file2, 'original2\n', 'utf-8')

    const patch = [
      '*** Begin Patch',
      '*** Update File: file1.ts',
      '@@ hunk',
      '-original1',
      '+updated1',
      '*** Update File: file2.ts',
      '@@ hunk',
      '-original2',
      '+updated2',
      '*** End Patch',
    ].join('\n')

    const result = await applyV4aPatch(patch, tmpDir)
    expect(result).toContain('file1.ts')
    expect(result).toContain('file2.ts')

    const c1 = await readFile(file1, 'utf-8')
    const c2 = await readFile(file2, 'utf-8')
    expect(c1).toContain('updated1')
    expect(c2).toContain('updated2')
  })
})
