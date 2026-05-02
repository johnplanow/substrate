/**
 * Tests for Story 64-2: external_state_dependencies frontmatter escalation.
 *
 * Covers:
 *   - parseStoryFrontmatter: valid field, no-frontmatter fallback, empty list
 *   - RuntimeProbeCheck.run(): round-trip pass (AC6)
 *   - RuntimeProbeCheck.run(): negative escalation to error (AC7)
 *   - RuntimeProbeCheck.run(): backward-compat no-field pass (AC5)
 *   - RuntimeProbeCheck.run(): backward-compat empty-field pass (AC5)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  parseStoryFrontmatter,
  StoryFrontmatterSchema,
} from '../../run-model/story-artifact-schema.js'
import {
  RuntimeProbeCheck,
  type RuntimeProbeExecutors,
} from '../../verification/checks/runtime-probe-check.js'
import type { VerificationContext } from '../../verification/types.js'
import type { ProbeResult, RuntimeProbe } from '../../verification/probes/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(storyContent: string): VerificationContext {
  return {
    storyKey: '64-2',
    workingDir: '/tmp',
    commitSha: 'abc',
    timeout: 30_000,
    storyContent,
  }
}

/**
 * Build a story string with YAML frontmatter + optional ## Runtime Probes.
 */
function storyWithFrontmatter(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n${body}`
}

function withRuntimeProbes(body: string): string {
  return `## Runtime Probes\n\n\`\`\`yaml\n${body}\n\`\`\`\n`
}

/**
 * Fake host executor that returns pass for any probe.
 */
function fakePassExecutor(): RuntimeProbeExecutors['host'] {
  return vi.fn(async (probe: RuntimeProbe): Promise<ProbeResult> => ({
    outcome: 'pass',
    command: probe.command,
    exitCode: 0,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 1,
  }))
}

// ---------------------------------------------------------------------------
// parseStoryFrontmatter tests
// ---------------------------------------------------------------------------

describe('parseStoryFrontmatter', () => {
  it('returns external_state_dependencies array when frontmatter is valid', () => {
    const content = storyWithFrontmatter(
      'external_state_dependencies:\n  - git\n  - subprocess',
      '# Story\n',
    )
    const result = parseStoryFrontmatter(content)
    expect(result.external_state_dependencies).toEqual(['git', 'subprocess'])
  })

  it('returns empty array when no frontmatter block is present (backward-compat)', () => {
    const content = '# Story\n\nNo frontmatter here.\n'
    const result = parseStoryFrontmatter(content)
    expect(result).toEqual({ external_state_dependencies: [] })
  })

  it('returns empty array when frontmatter has empty external_state_dependencies list', () => {
    const content = storyWithFrontmatter('external_state_dependencies: []', '# Story\n')
    const result = parseStoryFrontmatter(content)
    expect(result.external_state_dependencies).toEqual([])
  })

  it('returns empty array when frontmatter has no external_state_dependencies key at all', () => {
    const content = storyWithFrontmatter('some_other_field: value', '# Story\n')
    const result = parseStoryFrontmatter(content)
    expect(result.external_state_dependencies).toEqual([])
  })

  it('returns empty array when frontmatter YAML is malformed (backward-compat)', () => {
    const content = '---\n: invalid: yaml: [unclosed\n---\n# Story\n'
    const result = parseStoryFrontmatter(content)
    expect(result.external_state_dependencies).toEqual([])
  })

  it('schema default produces empty array when parsed with empty object', () => {
    const result = StoryFrontmatterSchema.parse({})
    expect(result.external_state_dependencies).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RuntimeProbeCheck escalation tests
// ---------------------------------------------------------------------------

describe('RuntimeProbeCheck — external_state_dependencies escalation (Story 64-2)', () => {
  it('AC6 round-trip: story with external_state_dependencies AND ## Runtime Probes passes cleanly', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const probeBody = '- name: git-log-check\n  sandbox: host\n  command: "git log --oneline -1"'
    const storyContent =
      storyWithFrontmatter(
        'external_state_dependencies:\n  - git\n  - subprocess',
        `# Story 64-2 Round-Trip\n\n${withRuntimeProbes(probeBody)}`,
      )
    const result = await check.run(makeContext(storyContent))
    expect(result.status).toBe('pass')
    const errorFindings = (result.findings ?? []).filter((f) => f.severity === 'error')
    expect(errorFindings).toHaveLength(0)
  })

  it('AC7 negative: story with external_state_dependencies and NO ## Runtime Probes → error finding, fail', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const storyContent = storyWithFrontmatter(
      'external_state_dependencies:\n  - git',
      '# Story 64-2 No Probes\n\nSome implementation content.\n',
    )
    const result = await check.run(makeContext(storyContent))
    expect(result.status).toBe('fail')
    const errorFindings = (result.findings ?? []).filter(
      (f) => f.category === 'runtime-probe-missing-declared-probes',
    )
    expect(errorFindings).toHaveLength(1)
    expect(errorFindings[0]?.severity).toBe('error')
    expect(errorFindings[0]?.message).toContain('story declares external_state_dependencies')
    expect(errorFindings[0]?.message).toContain('## Runtime Probes')
  })

  it('AC5 backward-compat: story with NO frontmatter and NO ## Runtime Probes → pass (existing behavior)', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const storyContent = '# Story Without Frontmatter\n\nBody content.\n'
    const result = await check.run(makeContext(storyContent))
    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
  })

  it('AC5 backward-compat: story with empty external_state_dependencies and NO ## Runtime Probes → pass', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const storyContent = storyWithFrontmatter(
      'external_state_dependencies: []',
      '# Story With Empty Deps\n\nBody content.\n',
    )
    const result = await check.run(makeContext(storyContent))
    expect(result.status).toBe('pass')
    expect(result.findings).toEqual([])
  })

  it('finding category is exactly runtime-probe-missing-declared-probes', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const storyContent = storyWithFrontmatter(
      'external_state_dependencies:\n  - network',
      '# Story\n\nNo probes.\n',
    )
    const result = await check.run(makeContext(storyContent))
    expect(result.findings?.[0]?.category).toBe('runtime-probe-missing-declared-probes')
  })

  it('finding message contains obs_2026-05-01_017 reference', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const storyContent = storyWithFrontmatter(
      'external_state_dependencies:\n  - database',
      '# Story\n',
    )
    const result = await check.run(makeContext(storyContent))
    expect(result.findings?.[0]?.message).toContain('obs_2026-05-01_017')
  })

  it('no escalation when storyContent is undefined (pre-existing warn path unaffected)', async () => {
    const check = new RuntimeProbeCheck({ host: fakePassExecutor() })
    const ctx: VerificationContext = {
      storyKey: '64-2',
      workingDir: '/tmp',
      commitSha: 'abc',
      timeout: 30_000,
      // storyContent intentionally absent
    }
    const result = await check.run(ctx)
    expect(result.status).toBe('warn')
    expect(result.findings?.[0]?.category).toBe('runtime-probe-skip')
  })
})
