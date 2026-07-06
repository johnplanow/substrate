/**
 * TestMutationCheck tests (H1.7, hardening program — reward-hack tripwire).
 */

import { describe, it, expect } from 'vitest'
import { TestMutationCheck, isTestPath } from '../../verification/checks/test-mutation-check.js'
import type { VerificationContext } from '../../verification/types.js'

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return { storyKey: 'h1-7', workingDir: '/wt', commitSha: 'x', timeout: 30_000, ...overrides }
}

describe('isTestPath', () => {
  it('recognizes the cross-language test idioms', () => {
    for (const p of [
      'src/__tests__/foo.test.ts',
      'tests/test_ledger.py',
      'machine/red_team/tests/runner_test.py',
      'pkg/api/handler_test.go',
      'src/foo.spec.tsx',
    ]) {
      expect(isTestPath(p), p).toBe(true)
    }
  })

  it('does not flag non-test paths', () => {
    for (const p of ['src/testing-utils.ts', 'docs/test-plan.md', 'src/attest.py', 'contest/rules.go']) {
      expect(isTestPath(p), p).toBe(false)
    }
  })

  it('H7: recognizes shared test-support files outside tests/ namespaces', () => {
    for (const p of [
      'conftest.py',
      'src/conftest.py',
      'tests/factories/user.py',
      'fixtures/data.py',
      'testsupport/helpers.ts',
      'src/__mocks__/api.ts',
    ]) {
      expect(isTestPath(p), p).toBe(true)
    }
  })
})

describe('TestMutationCheck', () => {
  it('passes when no pre-existing tests were touched (new tests are silent)', async () => {
    const check = new TestMutationCheck()
    const result = await check.run(
      makeContext({ modifiedTrackedFiles: ['src/ledger.py'], changedFiles: ['src/ledger.py', 'tests/test_new_feature.py'] }),
    )
    expect(result.status).toBe('pass')
  })

  it('warns (operator-visible) when a pre-existing test file was modified', async () => {
    const check = new TestMutationCheck()
    const result = await check.run(
      makeContext({ modifiedTrackedFiles: ['src/ledger.py', 'tests/test_pause.py'] }),
    )
    expect(result.status).toBe('warn')
    expect(result.findings[0]?.category).toBe('test-mutation')
    expect(result.findings[0]?.message).toContain('tests/test_pause.py')
    expect(result.findings[0]?.message).toContain('reward-hack')
  })

  it('passes trivially when the signal is absent', async () => {
    const check = new TestMutationCheck()
    const result = await check.run(makeContext())
    expect(result.status).toBe('pass')
  })
})
