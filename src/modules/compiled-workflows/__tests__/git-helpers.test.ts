/**
 * Tests for git-helpers — getGitDiffSummary and getGitDiffStatSummary.
 *
 * Uses vi.mock to simulate child_process.spawn with fake processes
 * so no real git processes are spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

type SpawnCallback = {
  proc: ReturnType<typeof createFakeProcess>
}

const spawnCalls: SpawnCallback[] = []

function createFakeProcess() {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  const proc = Object.assign(emitter, {
    stdin: null,
    stdout,
    stderr,
    pid: 12345,
    kill: vi.fn(),
  })

  return {
    proc,
    writeStdout(data: string) {
      stdout.push(data)
    },
    writeStderr(data: string) {
      stderr.push(data)
    },
    emitClose(code: number | null) {
      emitter.emit('close', code)
    },
    emitError(err: Error) {
      emitter.emit('error', err)
    },
  }
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, _args: string[], _opts: object) => {
    const fp = createFakeProcess()
    spawnCalls.push({ proc: fp })
    return fp.proc
  }),
  // hasCommits() uses execSync('git rev-parse --verify HEAD') — return a truthy
  // value to simulate a repo that has at least one commit.
  execSync: vi.fn(() => 'abc123\n'),
}))

// Mock node:fs — existsSync defaults to true so stageIntentToAdd passes files through
const mockExistsSync = vi.fn(() => true)
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...args) }
})

// Import after mocking
import { getGitDiffSummary, getGitDiffStatSummary, getGitDiffForFiles, getGitChangedFiles, stageIntentToAdd, commitDevStoryOutput } from '../git-helpers.js'
import { spawn, execSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getGitDiffSummary', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    vi.clearAllMocks()
  })

  it('returns diff output on success (exit code 0)', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>

    // Set up the fake process before calling getGitDiffSummary
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      expect(args).toEqual(['diff', 'HEAD'])
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const diffPromise = getGitDiffSummary('/some/dir')

    // Emit stdout data and close the process
    if (capturedFp) {
      capturedFp.writeStdout('diff --git a/foo.ts b/foo.ts\n+line added\n')
      capturedFp.emitClose(0)
    }

    const result = await diffPromise
    expect(result).toBe('diff --git a/foo.ts b/foo.ts\n+line added\n')
  })

  it('returns empty string on non-zero exit code', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      expect(args).toEqual(['diff', 'HEAD'])
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const diffPromise = getGitDiffSummary('/no/git/repo')

    if (capturedFp) {
      capturedFp.writeStderr('fatal: not a git repository\n')
      capturedFp.emitClose(128)
    }

    const result = await diffPromise
    expect(result).toBe('')
  })

  it('returns empty string on spawn error', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const diffPromise = getGitDiffSummary('/some/dir')

    if (capturedFp) {
      capturedFp.emitError(new Error('spawn git ENOENT'))
    }

    const result = await diffPromise
    expect(result).toBe('')
  })

  it('handles null exit code (process killed)', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const diffPromise = getGitDiffSummary('/some/dir')

    if (capturedFp) {
      capturedFp.emitClose(null)
    }

    const result = await diffPromise
    expect(result).toBe('')
  })

  it('uses a string working directory as default', async () => {
    // Story 75-4: with worktrees default-on (Story 75-1+), the default cwd
    // may be a worktree path rather than process.cwd(). Use expect.any(String)
    // so this assertion remains valid once worktree mode changes the default.
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedOpts: { cwd?: string } | undefined

    mockSpawn.mockImplementationOnce((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      capturedOpts = opts
      const fp = createFakeProcess()
      // Close immediately with success
      setImmediate(() => fp.emitClose(0))
      return fp.proc
    })

    await getGitDiffSummary()
    expect(capturedOpts?.cwd).toEqual(expect.any(String))
  })
})

describe('getGitDiffStatSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs git diff --stat HEAD~1 and returns output', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined
    let capturedArgs: string[] | undefined

    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const statPromise = getGitDiffStatSummary('/repo')

    if (capturedFp) {
      capturedFp.writeStdout('src/foo.ts | 10 +++++++---\n1 file changed, 7 insertions(+), 3 deletions(-)\n')
      capturedFp.emitClose(0)
    }

    const result = await statPromise
    expect(capturedArgs).toEqual(['diff', '--stat', 'HEAD'])
    expect(result).toContain('1 file changed')
  })

  it('returns empty string on git error for stat', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const statPromise = getGitDiffStatSummary('/no/git')

    if (capturedFp) {
      capturedFp.emitClose(128)
    }

    const result = await statPromise
    expect(result).toBe('')
  })
})

describe('getGitDiffForFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('stages intent-to-add then runs git diff HEAD -- file1 file2', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    const allArgs: string[][] = []

    // First call: git add -N (intent-to-add), Second call: git diff
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      allArgs.push([...args])
      const fp = createFakeProcess()
      if (args[0] === 'add') {
        // git add -N completes immediately
        setImmediate(() => fp.emitClose(0))
      } else {
        // git diff returns content
        setImmediate(() => {
          fp.writeStdout('diff --git a/src/foo.ts b/src/foo.ts\n+new line\n')
          fp.emitClose(0)
        })
      }
      return fp.proc
    })

    const result = await getGitDiffForFiles(['src/foo.ts', 'src/bar.ts'], '/repo')

    expect(allArgs[0]).toEqual(['add', '-N', '--', 'src/foo.ts', 'src/bar.ts'])
    expect(allArgs[1]).toEqual(['diff', 'HEAD', '--', 'src/foo.ts', 'src/bar.ts'])
    expect(result).toContain('+new line')
  })

  it('returns empty string for empty files array without spawning', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>

    const result = await getGitDiffForFiles([], '/repo')

    expect(result).toBe('')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('returns empty string on non-zero exit code from diff', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const fp = createFakeProcess()
      if (args[0] === 'add') {
        setImmediate(() => fp.emitClose(0))
      } else {
        setImmediate(() => fp.emitClose(128))
      }
      return fp.proc
    })

    const result = await getGitDiffForFiles(['src/foo.ts'], '/repo')
    expect(result).toBe('')
  })
})

describe('stageIntentToAdd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('runs git add -N with provided files', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedArgs: string[] | undefined

    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(0))
      return fp.proc
    })

    await stageIntentToAdd(['src/new.ts', 'src/other.ts'], '/repo')
    expect(capturedArgs).toEqual(['add', '-N', '--', 'src/new.ts', 'src/other.ts'])
  })

  it('does nothing for empty files array', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>

    await stageIntentToAdd([], '/repo')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('skips nonexistent files and only stages existing ones', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedArgs: string[] | undefined

    mockExistsSync.mockImplementation((f: unknown) => String(f) === 'src/exists.ts')

    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(0))
      return fp.proc
    })

    await stageIntentToAdd(['src/exists.ts', 'src/gone.ts'], '/repo')
    expect(capturedArgs).toEqual(['add', '-N', '--', 'src/exists.ts'])
  })

  it('does nothing when all files are nonexistent', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    mockExistsSync.mockReturnValue(false)

    await stageIntentToAdd(['src/gone1.ts', 'src/gone2.ts'], '/repo')
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})

describe('getGitChangedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('parses mixed git status --porcelain output (M, A, ??, D)', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined
    let capturedArgs: string[] | undefined

    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs = args
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const promise = getGitChangedFiles('/repo')

    if (capturedFp) {
      capturedFp.writeStdout(
        ' M src/modified.ts\n' +
        'A  src/added.ts\n' +
        '?? src/new-file.ts\n' +
        ' D src/deleted.ts\n',
      )
      capturedFp.emitClose(0)
    }

    const result = await promise
    expect(capturedArgs).toEqual(['status', '--porcelain'])
    expect(result).toEqual([
      'src/modified.ts',
      'src/added.ts',
      'src/new-file.ts',
      'src/deleted.ts',
    ])
  })

  it('returns empty array for clean repo (empty output)', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const promise = getGitChangedFiles('/repo')

    if (capturedFp) {
      capturedFp.emitClose(0)
    }

    const result = await promise
    expect(result).toEqual([])
  })

  it('returns empty array on non-zero exit code', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const promise = getGitChangedFiles('/not-a-repo')

    if (capturedFp) {
      capturedFp.writeStderr('fatal: not a git repository\n')
      capturedFp.emitClose(128)
    }

    const result = await promise
    expect(result).toEqual([])
  })

  it('handles renamed files (R  old -> new) and extracts new path', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const promise = getGitChangedFiles('/repo')

    if (capturedFp) {
      capturedFp.writeStdout('R  src/old-name.ts -> src/new-name.ts\n')
      capturedFp.emitClose(0)
    }

    const result = await promise
    expect(result).toEqual(['src/new-name.ts'])
  })

  it('includes untracked files (??) for agent-created source files', async () => {
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    let capturedFp: ReturnType<typeof createFakeProcess> | undefined

    mockSpawn.mockImplementationOnce(() => {
      capturedFp = createFakeProcess()
      return capturedFp.proc
    })

    const promise = getGitChangedFiles('/repo')

    if (capturedFp) {
      capturedFp.writeStdout(
        '?? src/state/play-vs-ai-machine.ts\n' +
        '?? src/state/play-vs-ai-machine.test.ts\n' +
        '?? src/ui/components/game/mode-selection.tsx\n',
      )
      capturedFp.emitClose(0)
    }

    const result = await promise
    expect(result).toEqual([
      'src/state/play-vs-ai-machine.ts',
      'src/state/play-vs-ai-machine.test.ts',
      'src/ui/components/game/mode-selection.tsx',
    ])
  })
})

describe('commitDevStoryOutput (Path E Bug #5 — substrate-side auto-commit)', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    vi.clearAllMocks()
  })

  it('AC1: stages declared files + commits with feat(story-X-Y): <title> message; returns committed status with SHA', async () => {
    const mockExecSync = execSync as ReturnType<typeof vi.fn>
    const calls: { cmd: string; opts?: { cwd?: string } }[] = []
    mockExecSync.mockImplementation((cmd: string, opts?: { cwd?: string }) => {
      calls.push({ cmd, opts })
      if (cmd.startsWith('git rev-parse HEAD')) return 'newshawxyz123\n'
      return ''
    })
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    // `git diff --cached --quiet` returns exit 1 when staged changes exist
    mockSpawn.mockImplementationOnce(() => {
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(1))
      return fp.proc
    })

    const result = await commitDevStoryOutput(
      '10-2',
      'Implement the thing',
      ['src/foo.ts', 'src/bar.ts'],
      '/repo',
    )

    expect(result.status).toBe('committed')
    if (result.status === 'committed') {
      expect(result.sha).toBe('newshawxyz123')
      expect(result.filesStaged).toEqual(['src/foo.ts', 'src/bar.ts'])
    }
    // Verify the commands invoked
    expect(calls.find((c) => c.cmd.startsWith('git add'))?.cmd).toContain('"src/foo.ts"')
    expect(calls.find((c) => c.cmd.startsWith('git add'))?.cmd).toContain('"src/bar.ts"')
    const commitCall = calls.find((c) => c.cmd.startsWith('git commit'))
    expect(commitCall?.cmd).toContain('"feat(story-10-2): Implement the thing"')
  })

  it('AC2: filters out paths absolute-outside the worktree (e.g. /tmp/foo.log) to avoid `fatal: outside repository`', async () => {
    const mockExecSync = execSync as ReturnType<typeof vi.fn>
    const calls: { cmd: string }[] = []
    mockExecSync.mockImplementation((cmd: string) => {
      calls.push({ cmd })
      if (cmd.startsWith('git rev-parse HEAD')) return 'sha2\n'
      return ''
    })
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    mockSpawn.mockImplementationOnce(() => {
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(1)) // staged changes
      return fp.proc
    })

    const result = await commitDevStoryOutput(
      '10-3',
      'thin',
      ['src/foo.ts', '/tmp/test-output.log', '/var/folders/T/random-temp-file'],
      '/repo',
    )

    expect(result.status).toBe('committed')
    const addCall = calls.find((c) => c.cmd.startsWith('git add'))!
    // The tmp paths must NOT appear in the add command
    expect(addCall.cmd).toContain('"src/foo.ts"')
    expect(addCall.cmd).not.toContain('/tmp/test-output.log')
    expect(addCall.cmd).not.toContain('/var/folders/T/random-temp-file')
  })

  it('AC3: when ALL files are outside the worktree, returns no-changes (does not call git add)', async () => {
    const mockExecSync = execSync as ReturnType<typeof vi.fn>
    const calls: { cmd: string }[] = []
    mockExecSync.mockImplementation((cmd: string) => {
      calls.push({ cmd })
      return ''
    })

    const result = await commitDevStoryOutput(
      '10-4',
      'all tmp',
      ['/tmp/x.log', '/tmp/y.log'],
      '/repo',
    )

    expect(result.status).toBe('no-changes')
    expect(calls.find((c) => c.cmd.startsWith('git add'))).toBeUndefined()
    expect(calls.find((c) => c.cmd.startsWith('git commit'))).toBeUndefined()
  })

  it('AC4: when `git diff --cached --quiet` reports no staged changes (exit 0), returns no-changes (does not call git commit)', async () => {
    const mockExecSync = execSync as ReturnType<typeof vi.fn>
    const calls: { cmd: string }[] = []
    mockExecSync.mockImplementation((cmd: string) => {
      calls.push({ cmd })
      return ''
    })
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    // `git diff --cached --quiet` returns 0 = no staged changes
    mockSpawn.mockImplementationOnce(() => {
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(0))
      return fp.proc
    })

    const result = await commitDevStoryOutput(
      '10-5',
      'unchanged',
      ['src/already-committed.ts'],
      '/repo',
    )

    expect(result.status).toBe('no-changes')
    // git add still runs (we can't know it'll be a no-op without trying)
    expect(calls.find((c) => c.cmd.startsWith('git add'))).toBeDefined()
    // but git commit must NOT run when there's nothing staged
    expect(calls.find((c) => c.cmd.startsWith('git commit'))).toBeUndefined()
  })

  it('AC5: when `git commit` fails (pre-commit hook rejected), returns failed status with stderr surfaced', async () => {
    const mockExecSync = execSync as ReturnType<typeof vi.fn>
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git commit')) {
        const err: Error & { stderr?: string } = new Error('Command failed')
        err.stderr = 'eslint failed on src/foo.ts\nERROR: unused variable `bar`\nhusky - pre-commit hook exited with code 1\n'
        throw err
      }
      return ''
    })
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    mockSpawn.mockImplementationOnce(() => {
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(1))
      return fp.proc
    })

    const result = await commitDevStoryOutput(
      '10-6',
      'rejected by hook',
      ['src/foo.ts'],
      '/repo',
    )

    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.stderr).toContain('git commit failed')
      expect(result.stderr).toContain('eslint failed')
      expect(result.stderr).toContain('husky - pre-commit hook')
    }
  })

  it('AC6: uses fallback title "implementation" when storyTitle is undefined', async () => {
    const mockExecSync = execSync as ReturnType<typeof vi.fn>
    const calls: { cmd: string }[] = []
    mockExecSync.mockImplementation((cmd: string) => {
      calls.push({ cmd })
      if (cmd.startsWith('git rev-parse HEAD')) return 'sha6\n'
      return ''
    })
    const mockSpawn = spawn as ReturnType<typeof vi.fn>
    mockSpawn.mockImplementationOnce(() => {
      const fp = createFakeProcess()
      setImmediate(() => fp.emitClose(1))
      return fp.proc
    })

    const result = await commitDevStoryOutput('10-7', undefined, ['src/foo.ts'], '/repo')

    expect(result.status).toBe('committed')
    const commitCall = calls.find((c) => c.cmd.startsWith('git commit'))!
    expect(commitCall.cmd).toContain('"feat(story-10-7): implementation"')
  })
})
