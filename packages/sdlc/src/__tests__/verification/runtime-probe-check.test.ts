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

// ---------------------------------------------------------------------------
// Story 60-4: assertion-fail finding category routes exit-0-with-bad-payload
// distinctly from non-zero-exit failures, so retry prompts and post-run
// analysis can distinguish "tool crashed politely" from "tool errored loudly".
// ---------------------------------------------------------------------------

describe('RuntimeProbeCheck — stdout assertion failures (Story 60-4)', () => {
  it('emits runtime-probe-assertion-fail when ProbeResult.assertionFailures is populated', async () => {
    const host = fakeHostExecutor({
      mcp: {
        outcome: 'fail',
        command: 'mcp-client call strata_semantic_search',
        exitCode: 0,
        stdoutTail: '{"isError": true, "text": "Error: ..."}\n',
        stderrTail: '',
        durationMs: 12,
        assertionFailures: [
          'expect_stdout_no_regex: stdout matched forbidden pattern "\\"isError\\"\\\\s*:\\\\s*true"',
        ],
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const body = [
      '- name: mcp',
      '  sandbox: host',
      '  command: "mcp-client call strata_semantic_search"',
      '  expect_stdout_no_regex:',
      '    - \'"isError"\\s*:\\s*true\'',
    ].join('\n')
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.status).toBe('fail')
    expect(result.findings).toHaveLength(1)
    const f = result.findings?.[0]
    expect(f?.category).toBe('runtime-probe-assertion-fail')
    expect(f?.severity).toBe('error')
    expect(f?.exitCode).toBe(0) // distinguishes this from exit-code failure
    expect(f?.message).toContain('"mcp"')
    expect(f?.message).toContain('exit 0 but stdout assertion failed')
    expect(f?.message).toContain('expect_stdout_no_regex')
    expect(f?.stdoutTail).toContain('isError')
  })

  it('routes non-assertion exit-code failures to runtime-probe-fail (not assertion-fail)', async () => {
    const host = fakeHostExecutor({
      bad: {
        outcome: 'fail',
        command: 'false',
        exitCode: 1,
        stdoutTail: '',
        stderrTail: 'nope',
        durationMs: 3,
        // assertionFailures intentionally undefined
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const body = '- name: bad\n  sandbox: host\n  command: "false"'
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.findings?.[0]?.category).toBe('runtime-probe-fail')
  })
})

// ---------------------------------------------------------------------------
// Story 60-11: event-driven AC + missing-trigger heuristic.
//
// Closes the strata Run 13 / Story 1-12 trust event: vault conflict hook
// shipped SHIP_IT non-functional because the dev's probe ran the hook
// script directly with `bash .git/hooks/post-merge` — git only fires
// post-merge on a successful merge, so under conflict (the hook's actual
// use case) the production trigger never fires.
// ---------------------------------------------------------------------------

describe('RuntimeProbeCheck — event-driven trigger heuristic (Story 60-11)', () => {
  function makeContextWithEpic(
    storyContent: string,
    sourceEpicContent: string,
  ): VerificationContext {
    return {
      storyKey: '1-12',
      workingDir: '/tmp',
      commitSha: 'abc',
      timeout: 30_000,
      storyContent,
      sourceEpicContent,
    }
  }

  it('emits runtime-probe-missing-production-trigger when AC mentions post-merge hook and no probe invokes git merge', async () => {
    // The strata 1-12 case: AC says "post-merge hook" but probe just runs
    // the resolver script directly.
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: resolver-direct-call\n  sandbox: host\n  command: "bash hooks/vault-conflict-resolver.sh"'
    const ac = `### Story 1.12: Post-pull Obsidian vault conflict hook
**When** \`.git/hooks/post-merge\` is installed
**Then** the hook resolves conflicts on git merge.
`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(1)
    expect(triggerWarns[0]?.severity).toBe('warn')
    expect(triggerWarns[0]?.message).toContain('event-driven mechanism')
    expect(triggerWarns[0]?.message).toContain('strata Run 13')
  })

  it('does NOT emit the trigger warn when at least one probe invokes git merge', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: real-merge-fires-hook\n  sandbox: host\n  command: "git merge --no-ff branch-jarvis"'
    const ac = `### Story 1.12: post-merge hook\n**When** the hook runs\n**Then** conflict resolved.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(0)
  })

  it('does NOT emit the trigger warn when AC is not event-driven (regular code story)', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: build-check\n  sandbox: host\n  command: "podman pull ghcr.io/foo/bar:latest"'
    const ac = `### Story 1.4: Container image\n**Then** image is pullable.\n` // no event-driven keywords
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(0)
  })

  it('detects systemd-driven AC and warns when no probe invokes systemctl', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body = '- name: binary-runs\n  sandbox: host\n  command: "/usr/local/bin/jarvis --help"'
    const ac = `### Story X\n**Given** the systemd unit is installed\n**Then** the service starts.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(1)
  })

  it('does NOT emit the trigger warn when systemd AC is paired with a systemctl probe', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: unit-starts\n  sandbox: host\n  command: "systemctl --user start jarvis.service && systemctl --user is-active jarvis.service"'
    const ac = `### Story X\n**Given** the systemd unit is installed\n**Then** the service starts.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(0)
  })

  it('detects webhook-driven AC and warns when no probe invokes curl POST', async () => {
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body = '- name: handler-direct\n  sandbox: host\n  command: "node lib/handler.js test-payload.json"'
    const ac = `### Story X\n**Given** the webhook receiver is registered\n**Then** POST events fire it.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(1)
  })

  it('does NOT emit when AC is event-driven but sourceEpicContent is undefined (no signal to scan)', async () => {
    // No false-positive when source AC isn't passed in (e.g. from contexts
    // that don't have epic content).
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body = '- name: ok\n  sandbox: host\n  command: "true"'
    const ctx: VerificationContext = {
      storyKey: '1-12',
      workingDir: '/tmp',
      commitSha: 'abc',
      timeout: 30_000,
      storyContent: withRuntimeProbes(body),
      // sourceEpicContent intentionally absent
    }
    const result = await check.run(ctx)
    const triggerWarns = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerWarns).toHaveLength(0)
  })

  it('warn does not block: status remains pass when only the trigger warn is emitted', async () => {
    // Verify severity policy: missing-trigger is warn (advisory), not error.
    // Story status should be pass when only this finding is present.
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: resolver-direct\n  sandbox: host\n  command: "bash resolver.sh"'
    const ac = `### Story X\n**Given** post-merge hook\n**Then** runs.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    expect(result.status).toBe('warn') // warn aggregate, but no error → not 'fail'
    const errors = (result.findings ?? []).filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(0)
  })
})
