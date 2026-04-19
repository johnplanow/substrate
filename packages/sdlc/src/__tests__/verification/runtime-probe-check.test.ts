/**
 * Unit tests for RuntimeProbeCheck — Epic 55 / Phase 2.
 *
 * Host execution is injected via the RuntimeProbeExecutors constructor
 * parameter so the test suite can assert behavior deterministically
 * without spawning real shells. Parser + real host executor are covered
 * separately in their own unit tests.
 *
 * Covers:
 *   - name === 'runtime-probes', tier === 'A'
 *   - no storyContent → warn with runtime-probe-skip
 *   - no ## Runtime Probes section → pass, findings: []
 *   - empty probe list → pass, findings: []
 *   - parse error → fail, one finding with category 'runtime-probe-parse-error'
 *   - host probe pass → status pass for that probe (no finding emitted)
 *   - host probe fail (non-zero exit) → fail finding with command/exitCode/tails
 *   - host probe timeout → fail finding with category 'runtime-probe-timeout'
 *   - sandbox: twin → warn finding with category 'runtime-probe-deferred'
 *   - mixed results: one probe passes, one twin → status warn, one finding
 *   - mixed results: one probe passes, one fails → status fail, one finding
 *   - findings carry the stdoutTail / stderrTail / durationMs from ProbeResult
 */

import { describe, it, expect, vi } from 'vitest'
import { RuntimeProbeCheck, type RuntimeProbeExecutors } from '../../verification/checks/runtime-probe-check.js'
import type { VerificationContext } from '../../verification/types.js'
import type { ProbeResult, RuntimeProbe } from '../../verification/probes/index.js'

function makeContext(storyContent?: string): VerificationContext {
  return {
    storyKey: '55-probe',
    workingDir: '/tmp',
    commitSha: 'abc',
    timeout: 30_000,
    ...(storyContent !== undefined ? { storyContent } : {}),
  }
}

function withRuntimeProbes(body: string): string {
  return `# Story\n\n## Runtime Probes\n\n\`\`\`yaml\n${body}\n\`\`\`\n`
}

/**
 * Build a fake host executor that returns pre-canned ProbeResults keyed
 * by probe name. Any probe not in the map produces a pass by default so
 * tests only have to specify the interesting probes.
 */
function fakeHostExecutor(
  byName: Record<string, ProbeResult> = {},
): RuntimeProbeExecutors['host'] {
  return vi.fn(async (probe: RuntimeProbe): Promise<ProbeResult> => {
    return (
      byName[probe.name] ?? {
        outcome: 'pass',
        command: probe.command,
        exitCode: 0,
        stdoutTail: '',
        stderrTail: '',
        durationMs: 1,
      }
    )
  })
}

describe('RuntimeProbeCheck — identity', () => {
  it('has name "runtime-probes" and tier "A"', () => {
    const check = new RuntimeProbeCheck({ host: fakeHostExecutor() })
    expect(check.name).toBe('runtime-probes')
    expect(check.tier).toBe('A')
  })
})

describe('RuntimeProbeCheck — no probes declared', () => {
  it('returns warn when storyContent is unavailable', async () => {
    const check = new RuntimeProbeCheck({ host: fakeHostExecutor() })
    const result = await check.run(makeContext(undefined))
    expect(result.status).toBe('warn')
    expect(result.findings).toHaveLength(1)
    expect(result.findings?.[0]?.category).toBe('runtime-probe-skip')
  })

  it('returns pass with empty findings when the story has no ## Runtime Probes section', async () => {
    const check = new RuntimeProbeCheck({ host: fakeHostExecutor() })
    const result = await check.run(makeContext('# Story\n\nBody with no probes.\n'))
    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
  })

  it('returns pass with empty findings when the probe list is explicitly empty', async () => {
    const check = new RuntimeProbeCheck({ host: fakeHostExecutor() })
    const result = await check.run(makeContext(withRuntimeProbes('[]')))
    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
  })
})

describe('RuntimeProbeCheck — parse errors', () => {
  it('emits a runtime-probe-parse-error fail finding when the yaml is malformed', async () => {
    const check = new RuntimeProbeCheck({ host: fakeHostExecutor() })
    const result = await check.run(makeContext(withRuntimeProbes('- name: x\n  command: [unclosed')))
    expect(result.status).toBe('fail')
    expect(result.findings).toHaveLength(1)
    expect(result.findings?.[0]?.category).toBe('runtime-probe-parse-error')
    expect(result.findings?.[0]?.severity).toBe('error')
  })
})

describe('RuntimeProbeCheck — host execution', () => {
  it('emits no finding for a passing probe and returns status pass', async () => {
    const host = fakeHostExecutor({
      ok: { outcome: 'pass', command: 'true', exitCode: 0, stdoutTail: '', stderrTail: '', durationMs: 2 },
    })
    const check = new RuntimeProbeCheck({ host })
    const result = await check.run(
      makeContext(withRuntimeProbes('- name: ok\n  sandbox: host\n  command: "true"')),
    )
    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
    expect(host).toHaveBeenCalledOnce()
  })

  it('emits a fail finding with exitCode, stdoutTail, stderrTail, durationMs for a failing probe', async () => {
    const host = fakeHostExecutor({
      bad: {
        outcome: 'fail',
        command: 'false',
        exitCode: 1,
        stdoutTail: 'partial stdout\n',
        stderrTail: 'error msg\n',
        durationMs: 42,
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const result = await check.run(
      makeContext(
        withRuntimeProbes('- name: bad\n  sandbox: host\n  command: "false"\n  description: probe X'),
      ),
    )
    expect(result.status).toBe('fail')
    expect(result.findings).toHaveLength(1)
    const f = result.findings?.[0]
    expect(f?.category).toBe('runtime-probe-fail')
    expect(f?.severity).toBe('error')
    expect(f?.message).toContain('"bad"')
    expect(f?.message).toContain('probe X')
    expect(f?.command).toBe('false')
    expect(f?.exitCode).toBe(1)
    expect(f?.stdoutTail).toBe('partial stdout\n')
    expect(f?.stderrTail).toBe('error msg\n')
    expect(f?.durationMs).toBe(42)
  })

  it('emits a runtime-probe-timeout finding when the probe times out', async () => {
    const host = fakeHostExecutor({
      slow: {
        outcome: 'timeout',
        command: 'sleep',
        stdoutTail: '',
        stderrTail: '',
        durationMs: 150,
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const result = await check.run(
      makeContext(withRuntimeProbes('- name: slow\n  sandbox: host\n  command: sleep 1')),
    )
    expect(result.status).toBe('fail')
    expect(result.findings?.[0]?.category).toBe('runtime-probe-timeout')
    expect(result.findings?.[0]?.exitCode).toBeUndefined()
  })
})

describe('RuntimeProbeCheck — sandbox: twin is deferred', () => {
  it('emits a runtime-probe-deferred warn finding for sandbox: twin probes', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const result = await check.run(
      makeContext(withRuntimeProbes('- name: future\n  sandbox: twin\n  command: "true"')),
    )
    expect(result.status).toBe('warn')
    expect(result.findings).toHaveLength(1)
    expect(result.findings?.[0]?.category).toBe('runtime-probe-deferred')
    expect(result.findings?.[0]?.severity).toBe('warn')
    expect(host).not.toHaveBeenCalled()
  })
})

describe('RuntimeProbeCheck — mixed outcomes', () => {
  it('aggregates status=warn when one probe passes and another is deferred', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body = [
      '- name: ok',
      '  sandbox: host',
      '  command: "true"',
      '- name: future',
      '  sandbox: twin',
      '  command: "true"',
    ].join('\n')
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.status).toBe('warn')
    expect(result.findings).toHaveLength(1)
    expect(result.findings?.[0]?.category).toBe('runtime-probe-deferred')
  })

  it('aggregates status=fail when at least one probe fails, regardless of other passes', async () => {
    const host = fakeHostExecutor({
      bad: { outcome: 'fail', command: 'false', exitCode: 1, stdoutTail: '', stderrTail: 'nope', durationMs: 3 },
    })
    const check = new RuntimeProbeCheck({ host })
    const body = [
      '- name: ok',
      '  sandbox: host',
      '  command: "true"',
      '- name: bad',
      '  sandbox: host',
      '  command: "false"',
    ].join('\n')
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.status).toBe('fail')
    expect(result.findings).toHaveLength(1)
    expect(result.findings?.[0]?.category).toBe('runtime-probe-fail')
  })
})
