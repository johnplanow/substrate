/**
 * H5.3: docs-match-behavior gate for the consumer CLAUDE.md template.
 *
 * The template (`claude-md-substrate-section.md`) is what every consumer
 * project's Claude session reads before driving substrate — when it drifts
 * from the code, agents act on behavior that no longer exists (the
 * income-sources run repeatedly hit this class). This suite pins the
 * load-bearing claims to their code-side sources of truth:
 *
 *   - every finalization mode in the config schema is documented
 *   - the ff-only merge default and the three-way opt-in are stated
 *   - the external worktree base default (H4.2) is stated
 *   - every `story:*` / `pipeline:*` event the template names exists in
 *     EVENT_TYPE_NAMES (no phantom events)
 *
 * Ship rule (execution-plan H5.3 AC1): a change to finalizeStory /
 * merge-to-main / verification-check registration that alters documented
 * behavior must update the template in the same commit — this suite is the
 * enforcement for the pinned claims; reviewers enforce the rest.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_TYPE_NAMES } from '../../../modules/implementation-orchestrator/event-types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = readFileSync(resolve(HERE, '..', 'claude-md-substrate-section.md'), 'utf-8')
const CONFIG_SCHEMA = readFileSync(
  resolve(HERE, '..', '..', '..', 'modules', 'config', 'config-schema.ts'),
  'utf-8',
)

describe('consumer CLAUDE.md template ↔ behavior parity (H5.3)', () => {
  it('documents every finalization mode the config schema accepts', () => {
    const enumMatch = /finalization:[\s\S]*?mode: z\.enum\(\[([^\]]+)\]\)/.exec(CONFIG_SCHEMA)
    expect(enumMatch).not.toBeNull()
    const modes = [...enumMatch![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
    expect(modes.length).toBeGreaterThanOrEqual(3)
    for (const mode of modes) {
      expect(TEMPLATE, `finalization mode "${mode}" missing from template`).toContain(`\`${mode}\``)
    }
  })

  it('states the ff-only merge default and the three-way opt-in (H3.3)', () => {
    expect(TEMPLATE).toContain('fast-forward-only')
    expect(TEMPLATE).toContain('merge_strategy: three-way')
    expect(TEMPLATE).toContain('ff-only-merge-not-possible')
  })

  it('states the external worktree base default (H4.2)', () => {
    expect(TEMPLATE).toContain('~/.substrate/worktrees/')
    expect(TEMPLATE).toContain('worktree.base: in-repo')
  })

  it('every event name the template cites exists in EVENT_TYPE_NAMES', () => {
    const cited = [...TEMPLATE.matchAll(/`((?:story|pipeline):[a-z-]+)`/g)].map((m) => m[1]!)
    expect(cited.length).toBeGreaterThan(0)
    const known = new Set<string>(EVENT_TYPE_NAMES)
    const phantom = cited.filter((e) => !known.has(e))
    expect(phantom, `template cites events that do not exist: ${phantom.join(', ')}`).toEqual([])
  })

  it('documents the commit-first discipline (H0.1) — the branch is the durable copy', () => {
    expect(TEMPLATE).toContain('commit-first')
    expect(TEMPLATE).toContain('wip(story-')
  })
})
