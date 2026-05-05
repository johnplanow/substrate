/**
 * Tests for substituteRuntimePlaceholders (Story 66-6) and the end-to-end
 * integration of REPO_ROOT substitution in executeProbeOnHost.
 *
 * Unit tests use inline string fixtures only (no file I/O, no subprocess).
 * The integration test spawns a real shell to verify the full execution path.
 */

import { describe, it, expect } from 'vitest'
import {
  substituteRuntimePlaceholders,
  executeProbeOnHost,
} from '../../../verification/probes/executor.js'

// ---------------------------------------------------------------------------
// Unit tests for substituteRuntimePlaceholders
// ---------------------------------------------------------------------------

describe('substituteRuntimePlaceholders', () => {
  const ROOT = '/home/user/my-project'

  it('substitutes a single <REPO_ROOT> occurrence', () => {
    const input = '<REPO_ROOT>/src/index.ts'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe(`${ROOT}/src/index.ts`)
  })

  it('substitutes a $REPO_ROOT token', () => {
    const input = 'ls $REPO_ROOT/packages'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe(`ls ${ROOT}/packages`)
  })

  it('substitutes both occurrences in a double-<REPO_ROOT> command', () => {
    const input = 'cd <REPO_ROOT> && ls <REPO_ROOT>/src'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe(`cd ${ROOT} && ls ${ROOT}/src`)
  })

  it('returns a command with no placeholders byte-for-byte identical', () => {
    const input = 'echo hello'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe('echo hello')
  })

  it('leaves unknown placeholders untouched while still substituting <REPO_ROOT>', () => {
    const input = 'grep foo <UNKNOWN_PLACEHOLDER>/bar && cat <REPO_ROOT>/README.md'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe(`grep foo <UNKNOWN_PLACEHOLDER>/bar && cat ${ROOT}/README.md`)
  })

  it('does NOT substitute $REPO_ROOT_EXTRA (bounded token check)', () => {
    const input = 'echo $REPO_ROOT_EXTRA'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe('echo $REPO_ROOT_EXTRA')
  })

  it('substitutes $REPO_ROOT at end of string', () => {
    const input = 'cd $REPO_ROOT'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe(`cd ${ROOT}`)
  })

  it('substitutes both <REPO_ROOT> and $REPO_ROOT in the same command', () => {
    const input = 'cd <REPO_ROOT> && echo $REPO_ROOT'
    const result = substituteRuntimePlaceholders(input, ROOT)
    expect(result).toBe(`cd ${ROOT} && echo ${ROOT}`)
  })
})

// ---------------------------------------------------------------------------
// Integration test: full executeProbeOnHost execution with <REPO_ROOT>
// ---------------------------------------------------------------------------

describe('executeProbeOnHost — <REPO_ROOT> substitution integration', () => {
  it(
    'executes a probe containing <REPO_ROOT> and resolves to the project root',
    async () => {
      const probe = {
        name: 'test-repo-root-substitution',
        sandbox: 'host' as const,
        command: 'cd <REPO_ROOT> && pwd',
      }
      const result = await executeProbeOnHost(probe)
      expect(result.outcome).toBe('pass')
      expect(result.stdoutTail.trim()).toBe(process.cwd())
    },
    30_000,
  )
})
