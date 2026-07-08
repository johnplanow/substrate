/**
 * A0.2 — create-story journey tags (acceptance-gate program).
 *
 * Covers:
 * - AC1: prompt receives registry ids+titles from the TRUSTED tree when a
 *   committed registry exists; empty otherwise; worktree tampering invisible
 * - AC1: unknown journey id in the artifact frontmatter → the existing
 *   schema_validation_failed classification path, details naming the ids
 * - AC2: valid tags pass; untagged artifacts stay legal
 * - best-effort: invalid committed registry → untagged, never a hard fail here
 *
 * Registry reads use REAL tmp git repos (the trusted-tree read is the contract).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { WorkflowDeps, CreateStoryParams } from '../types.js'
import { runCreateStory } from '../create-story.js'

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('../../../persistence/queries/decisions.js', () => ({
  getDecisionsByPhase: vi.fn(),
  getDecisionsByPhaseForRun: vi.fn().mockResolvedValue([]),
}))

import { getDecisionsByPhase } from '../../../persistence/queries/decisions.js'
const mockGetDecisionsByPhase = vi.mocked(getDecisionsByPhase)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REGISTRY_YAML = `version: 1
journeys:
  - id: UJ-1
    title: Operator reads the daily report
    criticality: critical
    epic: 1
    surfaces: [cli]
    end_states:
      - { id: UJ-1.a, given: fixture, walk: run report, then: fields present }
  - id: UJ-2
    title: Operator decides on an emailed Dossier
    criticality: standard
    surfaces: [email]
    end_states:
      - { id: UJ-2.a, given: fixture, walk: open email, then: affordance present }
`

let repo: string

function git(cmd: string): void {
  execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
}

function commitRegistry(content: string): void {
  const abs = join(repo, '.substrate', 'acceptance', 'journeys.yaml')
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  git('add -A')
  git('commit -qm registry')
}

/** Write a story artifact into the repo and return its absolute path. */
function writeArtifact(name: string, content: string): string {
  const abs = join(repo, name)
  writeFileSync(abs, content)
  return abs
}

function makeSuccessDispatchResult(storyFile: string): DispatchResult {
  return {
    id: 'dispatch-1',
    status: 'completed',
    exitCode: 0,
    output: `result: success\nstory_file: ${storyFile}\nstory_key: 10-2\nstory_title: T\n`,
    parsed: { result: 'success', story_file: storyFile, story_key: '10-2', story_title: 'T' },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 500, output: 100 },
  }
}

function makeDispatcher(result: DispatchResult): { dispatcher: Dispatcher; prompts: string[] } {
  const prompts: string[] = []
  const handle: DispatchHandle & { result: Promise<DispatchResult> } = {
    id: 'dispatch-1',
    status: 'queued',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  const dispatcher: Dispatcher = {
    dispatch: vi.fn().mockImplementation((cmd: { prompt: string }) => {
      prompts.push(cmd.prompt)
      return handle
    }),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
  return { dispatcher, prompts }
}

function makePack(): MethodologyPack {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      phases: [],
      prompts: { 'create-story': 'prompts/create-story.md' },
      constraints: {},
      templates: { story: 'templates/story.md' },
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue('Epic: {{epic_shard}}\nJourneys:\n{{journey_registry}}\nTemplate: {{story_template}}'),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue('# Story Template'),
  } as unknown as MethodologyPack
}

function makeDeps(dispatcher: Dispatcher): WorkflowDeps {
  return {
    db: {
      query: vi.fn().mockResolvedValue([]),
      exec: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter,
    pack: makePack(),
    contextCompiler: {
      compile: vi.fn().mockReturnValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
      registerTemplate: vi.fn(),
      getTemplate: vi.fn().mockReturnValue(undefined),
    } as unknown as WorkflowDeps['contextCompiler'],
    dispatcher,
    // The trusted tree — worktree dispatch would set projectRoot to the
    // worktree; the registry must come from here regardless.
    parentProjectRoot: repo,
  }
}

const params: CreateStoryParams = { epicId: 'epic-10', storyKey: '10-2', pipelineRunId: 'run-1' }

beforeEach(() => {
  vi.clearAllMocks()
  repo = mkdtempSync(join(tmpdir(), 'a02-journeys-'))
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  execSync('git add -A && git commit -qm seed', { cwd: repo })
  mockGetDecisionsByPhase.mockImplementation((_db: unknown, phase: string) => {
    if (phase === 'implementation') {
      return Promise.resolve([
        {
          id: 'd1',
          pipeline_run_id: null,
          phase: 'implementation',
          category: 'epic-shard',
          key: 'epic-10',
          value: 'Epic 10: Things',
          rationale: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ])
    }
    return Promise.resolve([])
  })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AC1: prompt injection from the trusted tree
// ---------------------------------------------------------------------------

describe('A0.2 journey registry prompt injection', () => {
  it('injects committed registry ids+titles into {{journey_registry}}', async () => {
    commitRegistry(REGISTRY_YAML)
    const artifact = writeArtifact('story.md', '# Story\n')
    const { dispatcher, prompts } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('success')
    expect(prompts[0]).toContain('- UJ-1 [critical]: Operator reads the daily report')
    expect(prompts[0]).toContain('- UJ-2 [standard]: Operator decides on an emailed Dossier')
  })

  it('leaves {{journey_registry}} empty when no registry is committed', async () => {
    const artifact = writeArtifact('story.md', '# Story\n')
    const { dispatcher, prompts } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('success')
    expect(prompts[0]).not.toContain('UJ-1')
  })

  it('H7: a tampered WORKING-TREE registry is invisible — only the committed copy is injected', async () => {
    commitRegistry(REGISTRY_YAML)
    // Agent-side tamper: rewrite the working-tree copy with an extra journey.
    writeFileSync(
      join(repo, '.substrate', 'acceptance', 'journeys.yaml'),
      REGISTRY_YAML + '  - id: UJ-99\n    title: Injected\n    criticality: standard\n    surfaces: [cli]\n    end_states:\n      - { id: UJ-99.a, given: g, walk: w, then: t }\n',
    )
    const artifact = writeArtifact('story.md', '# Story\n')
    const { dispatcher, prompts } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('success')
    expect(prompts[0]).toContain('UJ-1')
    expect(prompts[0]).not.toContain('UJ-99')
  })

  it('treats an invalid committed registry as no registry (untagged; escalation is A0.3 audit scope)', async () => {
    commitRegistry('version: 1\njourneys:\n  - id: UJ-1\n    title: broken\n    criticality: critical\n    surfaces: [cli]\n    end_states: []\n')
    const artifact = writeArtifact('story.md', '# Story\n')
    const { dispatcher, prompts } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('success')
    expect(prompts[0]).not.toContain('UJ-1')
  })
})

// ---------------------------------------------------------------------------
// AC1/AC2: artifact tag validation
// ---------------------------------------------------------------------------

describe('A0.2 journey tag validation', () => {
  it('accepts an artifact tagged with a known journey id', async () => {
    commitRegistry(REGISTRY_YAML)
    const artifact = writeArtifact('story.md', '---\njourneys:\n  - UJ-2\n---\n# Story\n')
    const { dispatcher } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('success')
  })

  it('fails through the schema_validation_failed path on an unknown journey id, naming it', async () => {
    commitRegistry(REGISTRY_YAML)
    const artifact = writeArtifact('story.md', '---\njourneys:\n  - UJ-2\n  - UJ-99\n---\n# Story\n')
    const { dispatcher } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('failed')
    expect(result.error).toBe('schema_validation_failed')
    expect(result.details).toContain('UJ-99')
    expect(result.details).not.toContain('UJ-2,')
    expect(result.details).toContain('registry v1')
  })

  it('untagged artifacts stay legal when a registry exists (the epic-close invariant is the backstop)', async () => {
    commitRegistry(REGISTRY_YAML)
    const artifact = writeArtifact('story.md', '---\nexternal_state_dependencies:\n  - git\n---\n# Story\n')
    const { dispatcher } = makeDispatcher(makeSuccessDispatchResult(artifact))

    const result = await runCreateStory(makeDeps(dispatcher), params)

    expect(result.result).toBe('success')
  })
})
