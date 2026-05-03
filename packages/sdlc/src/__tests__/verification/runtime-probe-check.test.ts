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
import { RuntimeProbeCheck, type RuntimeProbeExecutors, detectsStateIntegratingAC } from '../../verification/checks/runtime-probe-check.js'
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
// Story 63-2: error-shape auto-detection routing
//
// When the executor returns errorShapeIndicators (probe exit 0 but stdout
// contained `"isError": true` / `"status": "error"`), RuntimeProbeCheck
// routes the failure to category `runtime-probe-error-response` — distinct
// from runtime-probe-fail (exit non-zero) and runtime-probe-assertion-fail
// (author-declared assertion). Defense-in-depth for obs_012 REOPENED.
// ---------------------------------------------------------------------------

describe('RuntimeProbeCheck — error-shape auto-detection (Story 63-2)', () => {
  it('emits runtime-probe-error-response when ProbeResult.errorShapeIndicators is populated', async () => {
    const host = fakeHostExecutor({
      mcp: {
        outcome: 'fail',
        command: 'mcp-client call strata_semantic_search',
        exitCode: 0,
        stdoutTail: '{"isError": true, "text": "Error: AttributeError"}\n',
        stderrTail: '',
        durationMs: 18,
        errorShapeIndicators: [
          '"isError": true (MCP / Anthropic tool error envelope)',
        ],
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const body = [
      '- name: mcp',
      '  sandbox: host',
      '  command: "mcp-client call strata_semantic_search"',
      // Note: NO author assertions — tests the defense-in-depth path
    ].join('\n')
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.status).toBe('fail')
    expect(result.findings).toHaveLength(1)
    const f = result.findings?.[0]
    expect(f?.category).toBe('runtime-probe-error-response')
    expect(f?.severity).toBe('error')
    expect(f?.exitCode).toBe(0)
    expect(f?.message).toContain('"mcp"')
    expect(f?.message).toContain('error envelope')
    expect(f?.message).toContain('isError')
    // Operator guidance to add explicit assertion in author-controlled form
    expect(f?.message).toContain('expect_stdout_no_regex')
  })

  it('passes when stdout has no error-shape indicators (regression guard)', async () => {
    const host = fakeHostExecutor({
      clean: {
        outcome: 'pass',
        command: 'mcp-client call strata_get_related',
        exitCode: 0,
        stdoutTail: '{"isError": false, "content": [{"text": "ok"}]}\n',
        stderrTail: '',
        durationMs: 11,
        // No errorShapeIndicators — clean response
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const body = '- name: clean\n  sandbox: host\n  command: "mcp-client call strata_get_related"'
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
  })

  it('author-declared assertion takes precedence over error-shape detection (60-4 wins on category routing)', async () => {
    // Executor populates assertionFailures (author's assertion tripped)
    // but does NOT populate errorShapeIndicators (executor short-circuits
    // when an assertion already caught the error). Verify the check
    // routes to runtime-probe-assertion-fail not runtime-probe-error-response.
    const host = fakeHostExecutor({
      mcp: {
        outcome: 'fail',
        command: 'mcp-client call x',
        exitCode: 0,
        stdoutTail: '{"isError": true}\n',
        stderrTail: '',
        durationMs: 10,
        assertionFailures: [
          'expect_stdout_no_regex: stdout matched forbidden pattern: "isError":\\s*true',
        ],
      },
    })
    const check = new RuntimeProbeCheck({ host })
    const body = [
      '- name: mcp',
      '  sandbox: host',
      '  command: "mcp-client call x"',
      '  expect_stdout_no_regex:',
      '    - \'"isError"\\s*:\\s*true\'',
    ].join('\n')
    const result = await check.run(makeContext(withRuntimeProbes(body)))
    expect(result.findings?.[0]?.category).toBe('runtime-probe-assertion-fail')
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
    // Story 60-16: severity flipped from warn to error after Epic 60 Phase 2's
    // GREEN eval (4/4 catch rate, v0.20.39). Gate is now blocking on event-driven
    // ACs whose probes don't invoke the production trigger.
    expect(triggerWarns).toHaveLength(1)
    expect(triggerWarns[0]?.severity).toBe('error')
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

  it('Story 60-16: missing-trigger now blocks (severity error → status fail)', async () => {
    // Severity policy flipped from warn to error after Epic 60 Phase 2's
    // GREEN eval result. When AC is event-driven and no probe invokes a
    // known production trigger, verification HARD-GATES — story cannot
    // SHIP_IT until probes invoke the trigger (or probe-author authors
    // probes that do).
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: resolver-direct\n  sandbox: host\n  command: "bash resolver.sh"'
    const ac = `### Story X\n**Given** post-merge hook\n**Then** runs.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    expect(result.status).toBe('fail') // error severity → status fail
    const errors = (result.findings ?? []).filter((f) => f.severity === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.category).toBe('runtime-probe-missing-production-trigger')
  })

  it('Story 60-16: probe-author probes invoking a trigger satisfy the gate (no missing-trigger finding)', async () => {
    // When probe-author authored probes that invoke the production trigger
    // (probes carry `_authoredBy: 'probe-author'` metadata), the gate is
    // satisfied — no missing-trigger finding emits even when the AC is
    // event-driven. The metadata is preserved through the parser per
    // Story 60-15; the gate-pass logic relies on the same
    // probesInvokeProductionTrigger heuristic that checks ALL probes for
    // a trigger pattern, regardless of authorship.
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: hook-fires-on-real-merge\n  sandbox: host\n  command: "git merge --no-ff side-branch"\n  _authoredBy: probe-author'
    const ac = `### Story 1.12: post-merge hook\n**When** the hook runs\n**Then** conflict resolved.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerFindings = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-production-trigger',
    )
    expect(triggerFindings).toHaveLength(0)
  })

  it('Story 60-16: probe-author skipped + dev probes miss trigger + event-driven AC → error + fail', async () => {
    // Failure-mode test per the spec. Probe-author was disabled (probes have
    // no `_authoredBy` metadata, indicating create-story-ac-transfer path)
    // AND the dev's probes don't invoke the production trigger AND the AC
    // is event-driven. Hard gate fires.
    const host = fakeHostExecutor()
    const check = new RuntimeProbeCheck({ host })
    const body =
      '- name: dev-direct-call\n  sandbox: host\n  command: "bash hooks/post-merge"' // no _authoredBy
    const ac = `### Story 1.12\n**When** \`.git/hooks/post-merge\` is installed\n**Then** the hook resolves conflicts on git merge.\n`
    const result = await check.run(makeContextWithEpic(withRuntimeProbes(body), ac))
    const triggerErrors = (result.findings ?? []).filter(
      (f) =>
        f.category === 'runtime-probe-missing-production-trigger' && f.severity === 'error',
    )
    expect(triggerErrors).toHaveLength(1)
    expect(result.status).toBe('fail')
  })
})

// ---------------------------------------------------------------------------
// Story 65-1: state-integrating AC detection heuristic
//
// Closes the obs_2026-05-01_017 gap where state-integrating TypeScript/JS
// stories (e.g., strata Story 2-4 "morning briefing generator") shipped
// without runtime probes because probe-author only dispatched for
// event-driven ACs. The new heuristic covers subprocess, filesystem, git,
// database, network, and registry interactions.
// ---------------------------------------------------------------------------

// Strata Story 2-4 fixture (obs_017 reproduction scenario).
// The morning briefing generator's `fetchGitLog` ran `git log --oneline -30`
// with `cwd` set to per-project roots to retrieve commits, then attributed
// each commit by author pattern match. Shipped SHIP_IT with two architectural
// defects (wrong cwd, substring attribution) because no runtime probes
// exercised real git state. This fixture directly exercises the obs_017
// reproduction scenario: the heuristic must fire on this AC text.
const storyTwoFourACText = `
## Story 2-4: Morning Briefing Generator

### Acceptance Criteria

1. \`fetchGitLog(projectRoot)\` calls \`git log --oneline -30\` with \`cwd\` set to each
   individual project root (not the fleet root) to retrieve commits per project.
2. Commit attribution uses exact author-email match (not substring) against the known-authors map.
3. The rendered briefing is written to the briefing artifact path via \`fs.writeFile\`.
4. When a project root does not exist, \`fetchGitLog\` logs a warning and returns an empty list.
`

// Purely-algorithmic sibling AC from the same epic — sort/format operations only.
// The heuristic must discriminate: this AC describes no state-integrating operations
// and must return false, confirming the heuristic doesn't fire on prose phrasing alone.
const storyTwoFourAlgorithmicSiblingACText = `
## Story 2-5: Morning Briefing Formatter

### Acceptance Criteria

1. The formatter transforms a list of CommitRecord objects into a Markdown string.
2. Projects with no commits are excluded from the formatted output.
3. The formatter sorts projects by total commit count in descending order.
4. Each project section is prefixed with a heading and the project name.
5. The function returns the formatted string to the caller — no I/O.
`

describe('detectsStateIntegratingAC — positive cases (subprocess)', () => {
  it('returns true for execSync( (subprocess code identifier)', () => {
    expect(detectsStateIntegratingAC(
      "calls `execSync('git log --oneline -30', { cwd: projectRoot })` to retrieve commits",
    )).toBe(true)
  })

  it('returns true for spawn( (subprocess code identifier)', () => {
    expect(detectsStateIntegratingAC(
      "uses `spawn('npm', ['run', 'build'])` to execute the build",
    )).toBe(true)
  })

  it('returns true for exec( (subprocess code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'invokes `exec(command, { cwd: projectRoot })` to run the script',
    )).toBe(true)
  })

  it('returns true for child_process (subprocess code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'imports `execFileSync` from `child_process` to invoke the CLI binary',
    )).toBe(true)
  })

  it('returns true for "spawns" (subprocess natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the function spawns a worker process for each project in the fleet',
    )).toBe(true)
  })

  it('returns true for "invokes" (subprocess natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the module invokes the binary with the correct arguments',
    )).toBe(true)
  })
})

describe('detectsStateIntegratingAC — positive cases (filesystem)', () => {
  it('returns true for fs.read (filesystem code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'uses `fs.readFile` to load the story artifact at the given path',
    )).toBe(true)
  })

  it('returns true for fs.write (filesystem code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'writes the rendered output via `fs.writeFile` to the project artifacts directory',
    )).toBe(true)
  })

  it('returns true for readFile standalone (filesystem code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'calls `readFile(configPath, "utf-8")` to load the configuration',
    )).toBe(true)
  })

  it('returns true for writeFile standalone (filesystem code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'persists the result by calling `writeFile(outputPath, content)`',
    )).toBe(true)
  })

  it('returns true for path.join (filesystem code identifier)', () => {
    expect(detectsStateIntegratingAC(
      "reads the config file from `path.join(homedir(), '.config/substrate/config.json')`",
    )).toBe(true)
  })

  it('returns true for homedir() (filesystem code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'constructs the config path using `homedir()` as the root',
    )).toBe(true)
  })

  it('returns true for "reads from disk" (filesystem natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the function reads from disk to load the persisted state',
    )).toBe(true)
  })

  it('returns true for "writes to disk" (filesystem natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the briefing result writes to disk at the artifact path',
    )).toBe(true)
  })

  it('returns true for "scans filesystem" (filesystem natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the discovery phase scans the filesystem for project roots',
    )).toBe(true)
  })
})

describe('detectsStateIntegratingAC — positive cases (git)', () => {
  it('returns true for git log (git command)', () => {
    expect(detectsStateIntegratingAC(
      'runs `git log --oneline -30` to retrieve the last 30 commits',
    )).toBe(true)
  })

  it('returns true for git push (git command)', () => {
    expect(detectsStateIntegratingAC(
      'executes `git push origin main` after committing the artifact',
    )).toBe(true)
  })

  it('returns true for git pull (git command)', () => {
    expect(detectsStateIntegratingAC(
      'pulls the latest changes with `git pull --rebase origin main`',
    )).toBe(true)
  })

  it('returns true for git merge (git command)', () => {
    expect(detectsStateIntegratingAC(
      'invokes `git merge --no-ff feature-branch` to integrate the story branch',
    )).toBe(true)
  })

  it('returns true for "queries git" (git natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the function queries git to build the commit history for each project',
    )).toBe(true)
  })

  it('returns true for "runs git" (git natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the module runs git with the per-project cwd to retrieve commit data',
    )).toBe(true)
  })
})

describe('detectsStateIntegratingAC — positive cases (database)', () => {
  it('returns true for Dolt (database technology name)', () => {
    expect(detectsStateIntegratingAC(
      'queries the Dolt database using the SDLC adapter to retrieve pipeline run records',
    )).toBe(true)
  })

  it('returns true for mysql (database technology name, case-insensitive)', () => {
    expect(detectsStateIntegratingAC(
      'opens a mysql connection to the state store and reads per-story state rows',
    )).toBe(true)
  })

  it('returns true for pg (PostgreSQL client library)', () => {
    expect(detectsStateIntegratingAC(
      'uses the `pg` client to open a connection to the pipeline database',
    )).toBe(true)
  })

  it('returns true for sqlite (database technology name, case-insensitive)', () => {
    expect(detectsStateIntegratingAC(
      'stores run state in a sqlite database at the project root',
    )).toBe(true)
  })

  it('returns true for INSERT SQL keyword (uppercase)', () => {
    expect(detectsStateIntegratingAC(
      'executes `INSERT INTO briefing_entries (story_key, content) VALUES (?, ?)` to persist',
    )).toBe(true)
  })

  it('returns true for SELECT SQL keyword (uppercase)', () => {
    expect(detectsStateIntegratingAC(
      'runs `SELECT * FROM pipeline_runs WHERE date > ?` against the Dolt database',
    )).toBe(true)
  })

  it('returns true for "queries the database" (database natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the adapter queries the database to build the per-story metrics rollup',
    )).toBe(true)
  })

  it('returns true for "writes to Dolt" (database natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the function writes to Dolt to persist the updated pipeline state',
    )).toBe(true)
  })
})

describe('detectsStateIntegratingAC — positive cases (network)', () => {
  it('returns true for fetch( (network code identifier)', () => {
    expect(detectsStateIntegratingAC(
      "calls `fetch('https://api.example.com/briefings')` to retrieve the daily briefing",
    )).toBe(true)
  })

  it('returns true for axios (network library, case-insensitive)', () => {
    expect(detectsStateIntegratingAC(
      'uses `axios.get(apiEndpoint)` to retrieve the fleet status',
    )).toBe(true)
  })

  it('returns true for http.get( (network code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'calls `http.get(endpoint, callback)` to retrieve the health status',
    )).toBe(true)
  })

  it('returns true for https.get( (network code identifier)', () => {
    expect(detectsStateIntegratingAC(
      'calls `https.get(apiUrl, callback)` to fetch the remote config',
    )).toBe(true)
  })

  it('returns true for "fetches" (network natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the module fetches the run record from the remote registry',
    )).toBe(true)
  })

  it('returns true for "POSTs to" (network natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the function POSTs to the webhook endpoint with the event payload',
    )).toBe(true)
  })

  it('returns true for "calls the API" (network natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'calls the API with the story key to retrieve the current verification status',
    )).toBe(true)
  })
})

describe('detectsStateIntegratingAC — positive cases (registry)', () => {
  it('returns true for "queries registry" (registry natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the function queries the registry to check for available updates',
    )).toBe(true)
  })

  it('returns true for "scans the registry" (registry natural-language phrase)', () => {
    expect(detectsStateIntegratingAC(
      'the discovery pass scans the registry for registered pipeline handlers',
    )).toBe(true)
  })
})

describe('detectsStateIntegratingAC — strata Story 2-4 fixture (obs_017 reproduction)', () => {
  it('returns true for strata Story 2-4 AC text (fetchGitLog + git log — obs_017 canonical case)', () => {
    // The morning briefing generator shipped SHIP_IT with two architectural defects
    // because no probes exercised real git state. This fixture fires on `git log`
    // AND `fs.writeFile`, confirming the heuristic covers both the git and filesystem
    // signal categories.
    expect(detectsStateIntegratingAC(storyTwoFourACText)).toBe(true)
  })

  it('returns false for purely-algorithmic sibling AC (sort/format/transform — obs_017 discriminator)', () => {
    // The sibling story 2-5 formats and sorts in-memory data only — no I/O.
    // The heuristic must return false here to confirm it discriminates within
    // the same epic corpus and doesn't fire on generic prose.
    expect(detectsStateIntegratingAC(storyTwoFourAlgorithmicSiblingACText)).toBe(false)
  })
})

describe('detectsStateIntegratingAC — negative cases (pure-algorithmic verbs)', () => {
  it('returns false for "parse the input" (no state signal)', () => {
    expect(detectsStateIntegratingAC(
      'parses the input JSON string and extracts the story key field',
    )).toBe(false)
  })

  it('returns false for "format as JSON" (no state signal)', () => {
    expect(detectsStateIntegratingAC(
      'formats the internal record as JSON and returns it to the caller',
    )).toBe(false)
  })

  it('returns false for "sort by score" (no state signal)', () => {
    expect(detectsStateIntegratingAC(
      'sorts the candidate list by relevance score in descending order',
    )).toBe(false)
  })

  it('returns false for "transform the array" (no state signal)', () => {
    expect(detectsStateIntegratingAC(
      'transforms the input array of story keys into a flat list of AC identifiers',
    )).toBe(false)
  })

  it('returns false for "calculate the score" (no state signal)', () => {
    expect(detectsStateIntegratingAC(
      'calculates the coverage score for each epic based on the story count',
    )).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(detectsStateIntegratingAC('')).toBe(false)
  })

  it('returns false for purely-algorithmic multiline AC with no state signals', () => {
    const pureFunctionAC = `
## Story X: Briefing Formatter

### Acceptance Criteria

1. The formatter accepts a list of CommitRecord objects.
2. It returns a formatted Markdown string with each project as a heading.
3. Projects with no commits are excluded.
4. The function is pure — no side effects, no I/O.
`
    expect(detectsStateIntegratingAC(pureFunctionAC)).toBe(false)
  })
})

describe('detectsStateIntegratingAC — mock-exclusion cases (AC #4)', () => {
  it('returns false when only match is "mocks the database" (mock-qualifier guard)', () => {
    expect(detectsStateIntegratingAC(
      'the test harness mocks the database using INSERT and SELECT return values',
    )).toBe(false)
  })

  it('returns false when only match is "stubs the registry" (mock-qualifier guard)', () => {
    expect(detectsStateIntegratingAC(
      'the test stubs the registry to return predefined handler entries',
    )).toBe(false)
  })

  it('returns false when only match involves "mock " prefix (mock-qualifier guard)', () => {
    expect(detectsStateIntegratingAC(
      'the test setup creates a mock fetch( response with a 200 status',
    )).toBe(false)
  })

  it('returns false when only match involves "stub " prefix (mock-qualifier guard)', () => {
    expect(detectsStateIntegratingAC(
      'the test uses a stub axios client to avoid real network calls',
    )).toBe(false)
  })

  it('returns true when a non-mock line also matches (mock guard does not suppress all)', () => {
    // First line: mock context (guard fires → skip)
    // Second line: real state (no mock qualifier → returns true)
    const mixedContent = [
      'the test mocks the database with in-memory Dolt fixtures',
      'the production path runs `git log --oneline` against the real project root',
    ].join('\n')
    expect(detectsStateIntegratingAC(mixedContent)).toBe(true)
  })
})

describe('detectsStateIntegratingAC — ambiguous cases', () => {
  it('returns false for vague filesystem description without specific code signals', () => {
    // "The module interacts with the filesystem" — no fs.read, fs.write, etc.
    expect(detectsStateIntegratingAC(
      'The module interacts with the filesystem to manage project files.',
    )).toBe(false)
  })

  it('returns false for vague database description without specific technology name', () => {
    // "handles database operations" — no Dolt, mysql, pg, etc.
    expect(detectsStateIntegratingAC(
      'The component handles database operations for persistent storage.',
    )).toBe(false)
  })

  it('returns false for vague network description without specific code signals', () => {
    // "makes network requests" — no fetch(, axios, http.get, etc.
    expect(detectsStateIntegratingAC(
      'The service makes network requests to external APIs.',
    )).toBe(false)
  })
})
