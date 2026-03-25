/**
 * Tests for createExecutionEnvironment.
 * Validates SIGKILL timeout enforcement and error handling.
 */

import { describe, it, expect } from 'vitest'
import { createExecutionEnvironment } from '../environment.js'
import { tmpdir } from 'node:os'

describe('createExecutionEnvironment', () => {
  const env = createExecutionEnvironment(tmpdir())

  it('executes a command and returns stdout', async () => {
    const result = await env.exec('echo hello', 5000)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('captures stderr', async () => {
    const result = await env.exec('echo err >&2', 5000)
    expect(result.stderr.trim()).toBe('err')
    expect(result.exitCode).toBe(0)
  })

  it('returns non-zero exit code for failing command', async () => {
    const result = await env.exec('exit 42', 5000)
    expect(result.exitCode).toBe(42)
  })

  it('kills process on timeout with exit code 137', async () => {
    const result = await env.exec('sleep 60', 100) // 100ms timeout on a 60s sleep
    expect(result.exitCode).toBe(137)
    expect(result.stderr).toContain('timeout')
  })

  it('sets workdir property', () => {
    expect(env.workdir).toBe(tmpdir())
  })
})
