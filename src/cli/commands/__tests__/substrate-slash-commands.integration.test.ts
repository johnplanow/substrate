/**
 * H5.2 (field finding #2): scaffoldSubstrateSlashCommands — real-fs tests.
 *
 * Pre-fix, `substrate init`'s summary banner advertised /substrate-run,
 * /substrate-supervisor and /substrate-metrics under `.claude/commands/`
 * but nothing ever wrote them (the bmad generator populates .claude/skills/
 * only) — operators found an empty or user-files-only commands dir.
 *
 * Separate file from auto-claude-commands-scaffold.test.ts because that
 * suite mocks 'fs' globally; this scaffolder's contract (pre-existing dirs,
 * user-file preservation, idempotence) is exactly about real fs behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldSubstrateSlashCommands } from '../init.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'substrate-slash-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scaffoldSubstrateSlashCommands (H5.2 / finding #2)', () => {
  it('writes the three advertised substrate commands into .claude/commands/', () => {
    const written = scaffoldSubstrateSlashCommands(root)

    expect(written).toBe(3)
    for (const f of ['substrate-run.md', 'substrate-supervisor.md', 'substrate-metrics.md']) {
      expect(existsSync(join(root, '.claude', 'commands', f)), f).toBe(true)
    }
  })

  it('preserves pre-existing user files in .claude/commands/ (finding #2 repro shape)', () => {
    mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(root, '.claude', 'commands', 'my-command.md'), 'user content')

    const written = scaffoldSubstrateSlashCommands(root)

    expect(written).toBe(3)
    expect(readFileSync(join(root, '.claude', 'commands', 'my-command.md'), 'utf-8')).toBe('user content')
  })

  it('is idempotent — re-running overwrites only substrate-*.md', () => {
    scaffoldSubstrateSlashCommands(root)
    writeFileSync(join(root, '.claude', 'commands', 'substrate-run.md'), 'stale edited copy')

    const written = scaffoldSubstrateSlashCommands(root)

    expect(written).toBe(3)
    expect(readFileSync(join(root, '.claude', 'commands', 'substrate-run.md'), 'utf-8')).not.toBe('stale edited copy')
  })
})
