import { describe, it, expect } from 'vitest'
import { computeSubstrateGitignore } from '../substrate-gitignore.js'

/** Trimmed, non-empty lines of the result, for order-sensitive assertions. */
function lines(s: string): string[] {
  return s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
}

/** config.yaml is tracked iff the last config.yaml-matching pattern is the negation. */
function configIsTracked(content: string): boolean {
  const ls = lines(content)
  // A wholesale dir-ignore anywhere defeats the negation (git won't recurse).
  if (ls.some((l) => l === '.substrate' || l === '.substrate/' || l === '/.substrate' || l === '/.substrate/')) {
    return false
  }
  const lastStar = ls.lastIndexOf('.substrate/*')
  const lastNeg = ls.lastIndexOf('!.substrate/config.yaml')
  return lastNeg !== -1 && lastNeg > lastStar
}

describe('computeSubstrateGitignore', () => {
  it('writes the canonical block for an empty .gitignore', () => {
    const { content, changed } = computeSubstrateGitignore('')
    expect(changed).toBe(true)
    const ls = lines(content)
    expect(ls).toContain('.substrate/*')
    expect(ls).toContain('!.substrate/config.yaml')
    expect(ls).toContain('.codex/prompts/')
    expect(ls).toContain('.codex/skills/')
    expect(configIsTracked(content)).toBe(true)
  })

  it('repairs a pre-existing wholesale `.substrate/` dir-ignore', () => {
    // The reported bug: `.substrate/` ignores the dir, so !config.yaml can't work.
    const existing = 'node_modules/\n.substrate/\ndist/\n'
    const { content, changed } = computeSubstrateGitignore(existing)
    expect(changed).toBe(true)
    expect(lines(content)).not.toContain('.substrate/') // converted
    expect(lines(content)).toContain('.substrate/*')
    expect(configIsTracked(content)).toBe(true)
    // unrelated entries preserved
    expect(lines(content)).toContain('node_modules/')
    expect(lines(content)).toContain('dist/')
  })

  it('repairs the no-trailing-slash `.substrate` form too', () => {
    const { content } = computeSubstrateGitignore('.substrate\n')
    expect(lines(content)).not.toContain('.substrate')
    expect(configIsTracked(content)).toBe(true)
  })

  it('is idempotent on its own canonical output', () => {
    const first = computeSubstrateGitignore('').content
    const second = computeSubstrateGitignore(first)
    expect(second.changed).toBe(false)
    expect(second.content).toBe(first)
  })

  it('fixes a degenerate negation-before-star ordering', () => {
    // negation appears before a wholesale ignore → after repair the star would
    // sit after the negation and re-ignore config.yaml; helper must re-assert it.
    const existing = '!.substrate/config.yaml\n.substrate/\n'
    const { content } = computeSubstrateGitignore(existing)
    expect(configIsTracked(content)).toBe(true)
  })

  it('does not duplicate codex entries already present', () => {
    const existing = '.substrate/*\n!.substrate/config.yaml\n!.substrate/project-profile.yaml\n.codex/prompts/\n.codex/skills/\n'
    const { changed } = computeSubstrateGitignore(existing)
    expect(changed).toBe(false)
  })

  it('H1.1: repairs a pre-profile-negation gitignore by appending the profile negation', () => {
    // Consumers initialized before H1.1 have the old canonical set — the
    // repair pass must add the project-profile negation so the profile
    // reaches per-story worktrees (it is the source of truth for the
    // project's build/test commands).
    const existing = '.substrate/*\n!.substrate/config.yaml\n.codex/prompts/\n.codex/skills/\n'
    const { content, changed } = computeSubstrateGitignore(existing)
    expect(changed).toBe(true)
    expect(lines(content)).toContain('!.substrate/project-profile.yaml')
    // last-match-wins: negation must sit after the star
    const ls = lines(content)
    expect(ls.lastIndexOf('!.substrate/project-profile.yaml')).toBeGreaterThan(ls.lastIndexOf('.substrate/*'))
  })

  it('leaves legacy enumerated entries but still makes config.yaml trackable', () => {
    const existing = '.substrate/runs/\n.substrate/state/\n.substrate/kv-metrics.json\n'
    const { content } = computeSubstrateGitignore(existing)
    expect(configIsTracked(content)).toBe(true)
    expect(lines(content)).toContain('.substrate/runs/') // preserved, harmless
  })
})
