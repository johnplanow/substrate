// src/modules/eval/__tests__/impl-verifier.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ImplVerifier } from '../layers/impl-verifier.js'
import type { EvalAssertion } from '../types.js'

describe('ImplVerifier', () => {
  it('builds compile check assertion for modified files', () => {
    const verifier = new ImplVerifier()

    const storySpec = {
      files: ['src/components/Button.tsx', 'src/utils/format.ts'],
      acceptanceCriteria: [
        'Button renders with primary and secondary variants',
        'Format function handles null inputs gracefully',
      ],
    }

    const assertions = verifier.buildAssertions(storySpec)

    const buildCheck = assertions.find((a: EvalAssertion) => a.label === 'build-evidence')
    expect(buildCheck).toBeDefined()
    expect(buildCheck!.type).toBe('llm-rubric')

    const acCheck = assertions.find((a: EvalAssertion) => a.label === 'acceptance-criteria')
    expect(acCheck).toBeDefined()
    expect(acCheck!.type).toBe('llm-rubric')
    expect(acCheck!.value).toContain('Button renders with primary and secondary variants')
  })

  it('creates file coverage check as llm-rubric', () => {
    const verifier = new ImplVerifier()

    const storySpec = {
      files: ['src/new-file.ts'],
      acceptanceCriteria: ['New file exists'],
    }

    const assertions = verifier.buildAssertions(storySpec)
    const fileCheck = assertions.find((a: EvalAssertion) => a.label === 'file-coverage')
    expect(fileCheck).toBeDefined()
    expect(fileCheck!.type).toBe('llm-rubric')
    expect(fileCheck!.value).toContain('src/new-file.ts')
  })

  it('returns empty for empty story spec', () => {
    const verifier = new ImplVerifier()
    const assertions = verifier.buildAssertions({ files: [], acceptanceCriteria: [] })
    expect(assertions).toEqual([])
  })
})
