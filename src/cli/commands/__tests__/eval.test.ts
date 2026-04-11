// src/cli/commands/__tests__/eval.test.ts
//
// Unit tests for pure helpers exported from eval.ts. The runEvalAction
// entry point itself is covered indirectly via integration/e2e tests;
// these tests cover the helpers in isolation so each one can be proved
// independently without DB or pack loader setup.

import { describe, it, expect } from 'vitest'
import { loadPromptTemplateStrict } from '../eval.js'

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
