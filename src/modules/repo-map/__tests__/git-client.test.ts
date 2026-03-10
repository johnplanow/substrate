// @vitest-environment node
/**
 * Unit tests for GitClient.
 * Uses vi.mock to avoid real git calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock child_process before importing GitClient
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Imports (after mock setup)
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { GitClient } from '../git-client.js'
import { AppError } from '../../../errors/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void

function stubExecFile(stdout: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, stdout, '')
    },
  )
}

function stubExecFileError(error: Error): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(error, '', '')
    },
  )
}

function makeLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as import('pino').Logger
}

// ---------------------------------------------------------------------------
// GitClient.getCurrentSha
// ---------------------------------------------------------------------------

describe('GitClient.getCurrentSha', () => {
  let client: GitClient

  beforeEach(() => {
    execFileMock.mockReset()
    client = new GitClient(makeLogger())
  })

  it('returns trimmed stdout from git rev-parse HEAD', async () => {
    stubExecFile('abc123def456\n')
    const sha = await client.getCurrentSha('/project')
    expect(sha).toBe('abc123def456')
  })

  it('passes rev-parse HEAD as args', async () => {
    stubExecFile('abc\n')
    await client.getCurrentSha('/project')
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: '/project' },
      expect.any(Function),
    )
  })

  it('throws AppError with ERR_REPO_MAP_GIT_FAILED on failure', async () => {
    stubExecFileError(new Error('fatal: not a git repository'))
    await expect(client.getCurrentSha('/project')).rejects.toThrow(AppError)
    await expect(client.getCurrentSha('/project')).rejects.toMatchObject({
      code: 'ERR_REPO_MAP_GIT_FAILED',
      exitCode: 2,
    })
  })
})

// ---------------------------------------------------------------------------
// GitClient.getChangedFiles
// ---------------------------------------------------------------------------

describe('GitClient.getChangedFiles', () => {
  let client: GitClient

  beforeEach(() => {
    execFileMock.mockReset()
    client = new GitClient(makeLogger())
  })

  it('returns list of changed files from git diff output', async () => {
    stubExecFile('src/foo.ts\nsrc/bar.ts\n')
    const files = await client.getChangedFiles('/project', 'oldsha')
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts'])
  })

  it('passes correct args to git diff', async () => {
    stubExecFile('')
    await client.getChangedFiles('/project', 'abc123')
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', 'abc123..HEAD'],
      { cwd: '/project' },
      expect.any(Function),
    )
  })

  it('returns empty array when output is empty', async () => {
    stubExecFile('')
    const files = await client.getChangedFiles('/project', 'sha')
    expect(files).toEqual([])
  })

  it('filters out empty lines from output', async () => {
    stubExecFile('src/a.ts\n\nsrc/b.ts\n')
    const files = await client.getChangedFiles('/project', 'sha')
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('throws AppError on git failure', async () => {
    stubExecFileError(new Error('git error'))
    await expect(client.getChangedFiles('/project', 'sha')).rejects.toMatchObject({
      code: 'ERR_REPO_MAP_GIT_FAILED',
    })
  })
})

// ---------------------------------------------------------------------------
// GitClient.listTrackedFiles
// ---------------------------------------------------------------------------

describe('GitClient.listTrackedFiles', () => {
  let client: GitClient

  beforeEach(() => {
    execFileMock.mockReset()
    client = new GitClient(makeLogger())
  })

  it('returns list of tracked files from git ls-files', async () => {
    stubExecFile('src/foo.ts\nsrc/bar.py\nREADME.md\n')
    const files = await client.listTrackedFiles('/project')
    expect(files).toEqual(['src/foo.ts', 'src/bar.py', 'README.md'])
  })

  it('passes ls-files as the git command', async () => {
    stubExecFile('')
    await client.listTrackedFiles('/project')
    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['ls-files'],
      { cwd: '/project' },
      expect.any(Function),
    )
  })

  it('returns empty array when no tracked files', async () => {
    stubExecFile('')
    const files = await client.listTrackedFiles('/project')
    expect(files).toEqual([])
  })

  it('filters out empty lines', async () => {
    stubExecFile('src/a.ts\n\nsrc/b.ts\n')
    const files = await client.listTrackedFiles('/project')
    expect(files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('throws AppError on git failure', async () => {
    stubExecFileError(new Error('permission denied'))
    await expect(client.listTrackedFiles('/project')).rejects.toMatchObject({
      code: 'ERR_REPO_MAP_GIT_FAILED',
    })
  })
})
