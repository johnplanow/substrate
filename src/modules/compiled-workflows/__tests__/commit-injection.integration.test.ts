/**
 * H7 review (bug_007): shell command injection via agent-controlled commit
 * title / checkpoint reason. Pre-fix, commitDevStoryOutput / checkpointStoryWorktree
 * built `git commit -m ${JSON.stringify(msg)}` and ran it via execSync (shell) —
 * and JSON.stringify does NOT escape `$(...)` / backticks, so a story title like
 * `$(touch pwned)` executed on the host with the operator's credentials. The fix
 * is argv form (execFileSync) — no shell, no metacharacter evaluation.
 *
 * Real git repo; asserts the payload is stored LITERALLY and never executed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitDevStoryOutput, checkpointStoryWorktree } from '../git-helpers.js'

let repo: string
const canary = join(tmpdir(), `h7-inj-canary-${process.pid}`)

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: 'utf-8' })
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'h7-inj-'))
  git('init -q -b main')
  git('config user.email t@t && git config user.name t')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  git('add -A && git commit -qm base')
  rmSync(canary, { force: true })
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(canary, { force: true })
})

const PAYLOAD = `pwn $(touch ${canary}) \`touch ${canary}\` done`

describe('commit injection (H7 / bug_007)', () => {
  it('commitDevStoryOutput does NOT execute a command-substitution title', async () => {
    writeFileSync(join(repo, 'impl.py'), 'x = 1\n')
    const result = await commitDevStoryOutput('1-1', PAYLOAD, ['impl.py'], repo)

    expect(result.status).toBe('committed')
    expect(existsSync(canary), 'injection canary must NOT exist').toBe(false)
    // The payload is stored verbatim as the commit subject.
    expect(git('log -1 --pretty=%s').trim()).toBe(`feat(story-1-1): ${PAYLOAD}`)
  })

  it('checkpointStoryWorktree does NOT execute a command-substitution reason', async () => {
    writeFileSync(join(repo, 'wip.py'), 'y = 2\n')
    const result = await checkpointStoryWorktree('2-1', PAYLOAD, repo)

    expect(result.status).toBe('committed')
    expect(existsSync(canary), 'injection canary must NOT exist').toBe(false)
    expect(git('log -1 --pretty=%s').trim()).toContain('wip(story-2-1)')
  })
})
