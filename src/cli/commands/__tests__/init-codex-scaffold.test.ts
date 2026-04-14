/**
 * Unit tests for project-scoped and user-scoped Codex scaffolding.
 *
 * Covers:
 *   - scaffoldCodexProject mirrors .claude/{commands,skills}/ to .codex/{prompts,skills}/
 *   - scaffoldCodexUser writes namespaced substrate-* entries to a home-dir .codex/
 *   - Both functions are resilient when the source .claude/ dirs are absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scaffoldCodexProject, scaffoldCodexUser } from '../init.js'

function seedClaudeScaffold(projectRoot: string): void {
  const commandsDir = join(projectRoot, '.claude', 'commands')
  const skillsDir = join(projectRoot, '.claude', 'skills')
  mkdirSync(commandsDir, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })

  writeFileSync(join(commandsDir, 'bmad-agent-pm.md'), '# PM agent command\n')
  writeFileSync(join(commandsDir, 'substrate-run.md'), '# substrate-run\n')
  // Non-markdown file should be ignored
  writeFileSync(join(commandsDir, 'notes.txt'), 'ignore me')

  const skillDir = join(skillsDir, 'bmad-agent-pm')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: bmad-agent-pm\n---\n# skill\n')
  writeFileSync(join(skillDir, 'helper.md'), '# helper\n')
}

describe('scaffoldCodexProject', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'codex-scaffold-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('copies .claude/commands/*.md to .codex/prompts/*.md, skipping non-md files', () => {
    seedClaudeScaffold(tempRoot)

    scaffoldCodexProject(tempRoot, 'json')

    const promptsDir = join(tempRoot, '.codex', 'prompts')
    expect(existsSync(promptsDir)).toBe(true)

    const entries = readdirSync(promptsDir).sort()
    expect(entries).toEqual(['bmad-agent-pm.md', 'substrate-run.md'])
    expect(readFileSync(join(promptsDir, 'bmad-agent-pm.md'), 'utf-8')).toBe('# PM agent command\n')
  })

  it('copies skill directories (with nested files) to .codex/skills/', () => {
    seedClaudeScaffold(tempRoot)

    scaffoldCodexProject(tempRoot, 'json')

    const copied = join(tempRoot, '.codex', 'skills', 'bmad-agent-pm')
    expect(existsSync(copied)).toBe(true)
    expect(existsSync(join(copied, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(copied, 'helper.md'))).toBe(true)
  })

  it('is a no-op and does not throw when .claude/ does not exist', () => {
    expect(() => scaffoldCodexProject(tempRoot, 'json')).not.toThrow()
    expect(existsSync(join(tempRoot, '.codex'))).toBe(false)
  })

  it('overwrites existing .codex/skills/<name> on re-scaffold (idempotent)', () => {
    seedClaudeScaffold(tempRoot)

    const staleDir = join(tempRoot, '.codex', 'skills', 'bmad-agent-pm')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'stale.md'), 'stale')

    scaffoldCodexProject(tempRoot, 'json')

    expect(existsSync(join(staleDir, 'stale.md'))).toBe(false)
    expect(existsSync(join(staleDir, 'SKILL.md'))).toBe(true)
  })
})

describe('scaffoldCodexUser', () => {
  let tempRoot: string
  let fakeHome: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'codex-user-proj-'))
    fakeHome = mkdtempSync(join(tmpdir(), 'codex-user-home-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('writes substrate-prefixed prompts and skills into ~/.codex/', () => {
    seedClaudeScaffold(tempRoot)

    scaffoldCodexUser(tempRoot, fakeHome, 'json')

    const promptsDir = join(fakeHome, '.codex', 'prompts')
    const skillsDir = join(fakeHome, '.codex', 'skills')

    expect(readdirSync(promptsDir).sort()).toEqual([
      'substrate-bmad-agent-pm.md',
      'substrate-run.md', // already substrate-prefixed, not double-prefixed
    ])
    expect(readdirSync(skillsDir)).toEqual(['substrate-bmad-agent-pm'])
    expect(existsSync(join(skillsDir, 'substrate-bmad-agent-pm', 'SKILL.md'))).toBe(true)
  })

  it('is a no-op and does not throw when .claude/ does not exist', () => {
    expect(() => scaffoldCodexUser(tempRoot, fakeHome, 'json')).not.toThrow()
    expect(existsSync(join(fakeHome, '.codex'))).toBe(false)
  })
})
