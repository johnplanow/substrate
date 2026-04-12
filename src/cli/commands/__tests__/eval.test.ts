// src/cli/commands/__tests__/eval.test.ts
//
// Unit tests for pure helpers exported from eval.ts. The runEvalAction
// entry point itself is covered indirectly via integration/e2e tests;
// these tests cover the helpers in isolation so each one can be proved
// independently without DB or pack loader setup.

import { createHash } from 'node:crypto'
import { join } from 'path'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { loadPromptTemplateStrict, getGitSha, hashRubricFiles, collectEvalMetadata, loadThresholds } from '../eval.js'

type PackLike = { getPrompt(taskType: string): Promise<string> }

describe('loadPromptTemplateStrict (G7 — make degraded runs loud)', () => {
  it('returns the template when pack.getPrompt succeeds', async () => {
    const pack: PackLike = {
      getPrompt: async () => '## Mission\nDo the thing.',
    }
    const result = await loadPromptTemplateStrict(pack, 'analysis')
    expect(result).toBe('## Mission\nDo the thing.')
  })

  it('throws a clear error naming the phase when the pack cannot resolve the prompt', async () => {
    const pack: PackLike = {
      getPrompt: async () => {
        throw new Error('no such file')
      },
    }
    // Error must surface: the phase name, the task type key, and the
    // underlying cause, so the user has enough info to diagnose without
    // re-running.
    await expect(loadPromptTemplateStrict(pack, 'analysis')).rejects.toThrow(
      /phase 'analysis'/,
    )
    await expect(loadPromptTemplateStrict(pack, 'analysis')).rejects.toThrow(
      /no such file/,
    )
  })

  it('surfaces the mapped pack task type (not the phase name) for solutioning', async () => {
    // PHASE_TO_PROMPT_KEY maps solutioning -> 'architecture'. The error
    // must name 'architecture' so the user knows which prompt file the
    // pack is expected to define.
    const pack: PackLike = {
      getPrompt: async () => {
        throw new Error('missing')
      },
    }
    await expect(loadPromptTemplateStrict(pack, 'solutioning')).rejects.toThrow(
      /'architecture'/,
    )
  })

  it('does not swallow errors as empty strings (regression guard for pre-G7 behavior)', async () => {
    const pack: PackLike = {
      getPrompt: async () => {
        throw new Error('boom')
      },
    }
    // The pre-G7 code path returned '' on error. Prove the new code does
    // NOT return an empty string silently — it throws.
    let returned: string | undefined
    let threw: Error | undefined
    try {
      returned = await loadPromptTemplateStrict(pack, 'planning')
    } catch (err) {
      threw = err as Error
    }
    expect(returned).toBeUndefined()
    expect(threw).toBeDefined()
    expect(threw?.message).not.toBe('')
  })
})

describe('getGitSha (V1b-1)', () => {
  it('returns a non-empty string in a git repo', () => {
    // This test runs inside the substrate repo, so git is available
    const sha = getGitSha()
    expect(sha).toBeDefined()
    expect(sha!.length).toBeGreaterThanOrEqual(7)
    // Should be a hex string
    expect(sha).toMatch(/^[0-9a-f]+$/)
  })
})

describe('hashRubricFiles (V1b-1)', () => {
  it('returns SHA-256 hashes for existing rubric files', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-rubric-'))
    const rubricsDir = join(tmpDir, 'rubrics')
    await mkdir(rubricsDir)

    const content = 'dimensions:\n  - name: test\n    weight: 1.0\n'
    await writeFile(join(rubricsDir, 'analysis.yaml'), content)

    const hashes = await hashRubricFiles(tmpDir, ['analysis', 'planning'])

    // analysis should have a hash
    expect(hashes.analysis).toBeDefined()
    expect(hashes.analysis).toBe(
      createHash('sha256').update(content).digest('hex'),
    )
    // planning has no file — should be absent (not undefined value)
    expect('planning' in hashes).toBe(false)
  })

  it('returns empty object when no rubric files exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-rubric-'))
    const hashes = await hashRubricFiles(tmpDir, ['analysis'])
    expect(hashes).toEqual({})
  })
})

describe('collectEvalMetadata (V1b-1)', () => {
  it('returns metadata with schemaVersion 1b', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-meta-'))
    const meta = await collectEvalMetadata(tmpDir, ['analysis'])

    expect(meta.schemaVersion).toBe('1b')
  })

  it('includes gitSha when running in a git repo', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-meta-'))
    const meta = await collectEvalMetadata(tmpDir, ['analysis'])

    expect(meta.gitSha).toBeDefined()
    expect(meta.gitSha).toMatch(/^[0-9a-f]+$/)
  })

  it('includes rubricHashes when rubric files exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-meta-'))
    const rubricsDir = join(tmpDir, 'rubrics')
    await mkdir(rubricsDir)
    await writeFile(join(rubricsDir, 'analysis.yaml'), 'test-content')

    const meta = await collectEvalMetadata(tmpDir, ['analysis'])

    expect(meta.rubricHashes).toBeDefined()
    expect(meta.rubricHashes!.analysis).toBeDefined()
  })

  it('omits rubricHashes when no rubric files exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-meta-'))
    const meta = await collectEvalMetadata(tmpDir, [])

    expect(meta.rubricHashes).toBeUndefined()
  })
})

describe('loadThresholds (V1b-3)', () => {
  it('loads thresholds from YAML file', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-thresh-'))
    await writeFile(
      join(tmpDir, 'thresholds.yaml'),
      'default: 0.75\nregression: 0.05\nphases:\n  implementation: 0.60\n',
    )
    const config = await loadThresholds(tmpDir)

    expect(config).toBeDefined()
    expect(config!.default).toBe(0.75)
    expect(config!.regression).toBe(0.05)
    expect(config!.phases?.implementation).toBe(0.60)
  })

  it('returns undefined when file does not exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-thresh-'))
    const config = await loadThresholds(tmpDir)
    expect(config).toBeUndefined()
  })

  it('loads partial config without phases', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'eval-thresh-'))
    await writeFile(join(tmpDir, 'thresholds.yaml'), 'default: 0.65\n')
    const config = await loadThresholds(tmpDir)

    expect(config).toBeDefined()
    expect(config!.default).toBe(0.65)
    expect(config!.phases).toBeUndefined()
  })
})
