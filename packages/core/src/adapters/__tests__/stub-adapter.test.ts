/**
 * StubAdapter gating tests (H2.2, hardening program).
 *
 * The stub must be impossible to reach in production: registry inclusion AND
 * healthCheck both require SUBSTRATE_STUB_ADAPTER=1, and health additionally
 * requires a readable scenario script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StubAdapter } from '../stub-adapter.js'
import { AdapterRegistry } from '../adapter-registry.js'

describe('StubAdapter gating (H2.2)', () => {
  beforeEach(() => {
    delete process.env.SUBSTRATE_STUB_ADAPTER
    delete process.env.SUBSTRATE_STUB_SCRIPT
  })
  afterEach(() => {
    delete process.env.SUBSTRATE_STUB_ADAPTER
    delete process.env.SUBSTRATE_STUB_SCRIPT
  })

  it('healthCheck fails without the env gate', async () => {
    const result = await new StubAdapter().healthCheck()
    expect(result.healthy).toBe(false)
    expect(result.error).toContain('SUBSTRATE_STUB_ADAPTER')
  })

  it('healthCheck fails with the gate but no script', async () => {
    process.env.SUBSTRATE_STUB_ADAPTER = '1'
    const result = await new StubAdapter().healthCheck()
    expect(result.healthy).toBe(false)
    expect(result.error).toContain('SUBSTRATE_STUB_SCRIPT')
  })

  it('healthCheck passes with gate + readable script', async () => {
    process.env.SUBSTRATE_STUB_ADAPTER = '1'
    process.env.SUBSTRATE_STUB_SCRIPT = new URL(import.meta.url).pathname // any readable file
    const result = await new StubAdapter().healthCheck()
    expect(result.healthy).toBe(true)
  })

  it('discoverAndRegister never registers the stub without the gate', async () => {
    const registry = new AdapterRegistry()
    await registry.discoverAndRegister()
    expect(registry.get('stub')).toBeUndefined()
  })

  it('buildCommand spawns node on the scenario script in the worktree', () => {
    process.env.SUBSTRATE_STUB_SCRIPT = '/tmp/scenario.mjs'
    process.env.SUBSTRATE_STUB_SCENARIO = 'red-suite'
    const cmd = new StubAdapter().buildCommand('prompt text', {
      worktreePath: '/wt',
      billingMode: 'subscription',
      taskType: 'dev-story',
      storyKey: '1-1',
    })
    expect(cmd.binary).toBe(process.execPath)
    expect(cmd.args).toEqual(['/tmp/scenario.mjs', 'dev-story'])
    expect(cmd.cwd).toBe('/wt')
    expect(cmd.env?.SUBSTRATE_STUB_SCENARIO).toBe('red-suite')
    delete process.env.SUBSTRATE_STUB_SCENARIO
  })
})
