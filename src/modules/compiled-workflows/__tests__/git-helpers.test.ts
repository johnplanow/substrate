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
}))

// Import after mocking
import { getGitDiffSummary, getGitDiffStatSummary, getGitDiffForFiles, getGitChangedFiles, stageIntentToAdd } from '../git-helpers.js'
import { spawn } from 'node:child_process'

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

  it('uses process.cwd() as default working directory', async () => {
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
    expect(capturedOpts?.cwd).toBe(process.cwd())
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
})

describe('getGitChangedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
