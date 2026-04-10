/**
 * Unit tests for SupervisorLock — Story 52-2.
 *
 * Covers:
 * - AC1: Flock success → manifest.update called with supervisor_pid and supervisor_session_id
 * - AC2: ENOSYS from open → PID-file fallback taken, console.warn called
 * - AC3: Live PID-file present, no force → prescribed rejection error
 * - AC4: Force with live PID-file → SIGTERM sent, manifest updated with new PID
 * - AC5: Dead PID (ESRCH) in PID-file → acquisition succeeds without force
 * - AC6: release() clears lock file and manifest fields (both flock and PID-file modes)
 *
 * All filesystem operations and process.kill are mocked — no real disk I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock node:fs/promises before importing SupervisorLock
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  open: vi.fn(),
  unlink: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

import { mkdir, open, unlink, readFile, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { SupervisorLock } from '../supervisor-lock.js'
import type { RunManifest } from '../run-manifest.js'
import type { RunManifestData, CostAccumulation } from '../types.js'

// ---------------------------------------------------------------------------
// Mock RunManifest instance
// ---------------------------------------------------------------------------

function makeManifestData(overrides?: Partial<RunManifestData>): RunManifestData {
  const cost: CostAccumulation = { per_story: {}, run_total: 0 }
  return {
    run_id: 'test-run-abc',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state: {},
    recovery_history: [],
    cost_accumulation: cost,
    pending_proposals: [],
    generation: 1,
    created_at: '2026-04-06T00:00:00.000Z',
    updated_at: '2026-04-06T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Build a minimal mock RunManifest.
 * The `read()` and `update()` methods are stubs so tests do not depend on
 * the real RunManifest implementation.
 */
function makeMockManifest(runId: string, supervisor_pid: number | null = null): RunManifest {
  return {
    runId,
    baseDir: '/fake/.substrate/runs',
    primaryPath: `/fake/.substrate/runs/${runId}.json`,
    bakPath: `/fake/.substrate/runs/${runId}.json.bak`,
    tmpPath: `/fake/.substrate/runs/${runId}.json.tmp`,
    read: vi.fn().mockResolvedValue(makeManifestData({ run_id: runId, supervisor_pid })),
    update: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    patchCLIFlags: vi.fn().mockResolvedValue(undefined),
  } as unknown as RunManifest
}

/** Build a minimal mock FileHandle. */
function makeMockFileHandle(): FileHandle {
  return {
    write: vi.fn().mockResolvedValue({ bytesWritten: 4, buffer: '' }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileHandle
}

// ---------------------------------------------------------------------------
// Typed references to the mocked functions
// ---------------------------------------------------------------------------
const mkdirMock = vi.mocked(mkdir)
const openMock = vi.mocked(open)
const unlinkMock = vi.mocked(unlink)
const readFileMock = vi.mocked(readFile)
const writeFileMock = vi.mocked(writeFile)

// ---------------------------------------------------------------------------
// Helpers for error construction
// ---------------------------------------------------------------------------

function makeErrnoError(code: string, message = code): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  return err
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SupervisorLock', () => {
  const RUN_ID = 'test-run-abc'
  const PID = 42000
  const SESSION_ID = 'session-xyz'
  const EXISTING_PID = 99999

  let manifest: RunManifest
  let lock: SupervisorLock
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()

    manifest = makeMockManifest(RUN_ID)
    lock = new SupervisorLock(RUN_ID, manifest)

    // Default: mkdir succeeds
    mkdirMock.mockResolvedValue(undefined)

    // Default: unlink succeeds
    unlinkMock.mockResolvedValue(undefined)

    // Default: writeFile succeeds
    writeFileMock.mockResolvedValue(undefined)

    // Default: process.kill does nothing (all signals succeed silently)
    killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, _signal) => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // AC1: Flock success path
  // -------------------------------------------------------------------------

  describe('AC1: flock success', () => {
    it('opens lock file exclusively, writes PID, and calls manifest.update with supervisor_pid and supervisor_session_id', async () => {
      const fh = makeMockFileHandle()
      openMock.mockResolvedValueOnce(fh)

      await lock.acquire(PID, SESSION_ID)

      // mkdir called to ensure directory exists
      expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining('.substrate/runs'), {
        recursive: true,
      })

      // open called with lock path and 'wx' flag
      expect(openMock).toHaveBeenCalledWith(expect.stringContaining(`${RUN_ID}.lock`), 'wx')

      // PID written to lock file for diagnostics
      expect(fh.write).toHaveBeenCalledWith(String(PID), 0, 'utf-8')

      // manifest.update called with correct ownership fields
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: PID,
        supervisor_session_id: SESSION_ID,
      })
    })

    it('does not call readFile or writeFile in flock mode', async () => {
      const fh = makeMockFileHandle()
      openMock.mockResolvedValueOnce(fh)

      await lock.acquire(PID, SESSION_ID)

      expect(readFileMock).not.toHaveBeenCalled()
      expect(writeFileMock).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC2: ENOSYS fallback to PID-file
  // -------------------------------------------------------------------------

  describe('AC2: ENOSYS → PID-file fallback', () => {
    it('falls back to PID-file when open throws ENOSYS', async () => {
      openMock.mockRejectedValueOnce(makeErrnoError('ENOSYS'))
      // No existing PID-file
      readFileMock.mockRejectedValueOnce(makeErrnoError('ENOENT'))
      writeFileMock.mockResolvedValueOnce(undefined)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      await lock.acquire(PID, SESSION_ID)

      // Warn logged about flock unavailability
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENOSYS'))

      // PID-file written
      expect(writeFileMock).toHaveBeenCalledWith(
        expect.stringContaining(`${RUN_ID}.pid`),
        String(PID),
        { flag: 'w' }
      )

      // manifest.update called
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: PID,
        supervisor_session_id: SESSION_ID,
      })
    })

    it('falls back to PID-file when open throws EOPNOTSUPP', async () => {
      openMock.mockRejectedValueOnce(makeErrnoError('EOPNOTSUPP'))
      readFileMock.mockRejectedValueOnce(makeErrnoError('ENOENT'))
      writeFileMock.mockResolvedValueOnce(undefined)

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      await lock.acquire(PID, SESSION_ID)

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('EOPNOTSUPP'))
      expect(writeFileMock).toHaveBeenCalledWith(
        expect.stringContaining(`${RUN_ID}.pid`),
        String(PID),
        { flag: 'w' }
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Concurrent supervisor rejected (live PID-file, no force)
  // -------------------------------------------------------------------------

  describe('AC3: concurrent supervisor rejected', () => {
    it('throws prescribed error when live PID-file exists and force is not set', async () => {
      openMock.mockRejectedValueOnce(makeErrnoError('ENOSYS'))
      // PID-file contains an existing supervisor PID
      readFileMock.mockResolvedValueOnce(String(EXISTING_PID))
      // process.kill(EXISTING_PID, 0) → process is alive (default mock does not throw)

      await expect(lock.acquire(PID, SESSION_ID)).rejects.toThrow(
        `Run ${RUN_ID} is already supervised by PID ${EXISTING_PID}. Use --force to take over.`
      )

      // manifest.update should NOT be called
      expect(manifest.update).not.toHaveBeenCalled()
    })

    it('throws prescribed error when EEXIST from open and live PID in manifest (no force)', async () => {
      // Simulate lock file already exists
      openMock.mockRejectedValueOnce(makeErrnoError('EEXIST'))
      // Manifest reports an existing supervisor
      vi.mocked(manifest.read).mockResolvedValueOnce(
        makeManifestData({ supervisor_pid: EXISTING_PID })
      )
      // process.kill(EXISTING_PID, 0) → alive (mock does not throw)

      await expect(lock.acquire(PID, SESSION_ID)).rejects.toThrow(
        `Run ${RUN_ID} is already supervised by PID ${EXISTING_PID}. Use --force to take over.`
      )

      expect(manifest.update).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Force takeover
  // -------------------------------------------------------------------------

  describe('AC4: force takeover via PID-file', () => {
    it('sends SIGTERM to existing supervisor and acquires lock when force: true', async () => {
      vi.useFakeTimers()

      openMock.mockRejectedValueOnce(makeErrnoError('ENOSYS'))
      // PID-file has EXISTING_PID
      readFileMock.mockResolvedValueOnce(String(EXISTING_PID))
      writeFileMock.mockResolvedValueOnce(undefined)

      // kill sequence: call 1 = liveness check (alive), call 2 = SIGTERM, call 3 = dead check
      let callIndex = 0
      killSpy.mockImplementation((pid, signal) => {
        callIndex++
        if (callIndex === 3 && signal === 0) {
          // After SIGTERM, process is dead
          throw makeErrnoError('ESRCH')
        }
        return true
      })

      const acquirePromise = lock.acquire(PID, SESSION_ID, { force: true })
      await vi.advanceTimersByTimeAsync(500)
      await acquirePromise

      // SIGTERM was sent to existing supervisor
      expect(killSpy).toHaveBeenCalledWith(EXISTING_PID, 'SIGTERM')

      // Manifest updated with new PID
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: PID,
        supervisor_session_id: SESSION_ID,
      })
    })

    it('sends SIGTERM to existing supervisor via EEXIST flock path when force: true', async () => {
      vi.useFakeTimers()

      // First call: EEXIST (lock file held by EXISTING_PID)
      openMock.mockRejectedValueOnce(makeErrnoError('EEXIST'))
      // Manifest reports EXISTING_PID as holder
      vi.mocked(manifest.read).mockResolvedValueOnce(
        makeManifestData({ supervisor_pid: EXISTING_PID })
      )

      // After force kill, open succeeds
      const fh = makeMockFileHandle()
      openMock.mockResolvedValueOnce(fh)

      // kill sequence: liveness + SIGTERM + dead check
      let callIndex = 0
      killSpy.mockImplementation((_pid, signal) => {
        callIndex++
        if (callIndex === 3 && signal === 0) {
          throw makeErrnoError('ESRCH')
        }
        return true
      })

      const acquirePromise = lock.acquire(PID, SESSION_ID, { force: true })
      await vi.advanceTimersByTimeAsync(500)
      await acquirePromise

      expect(killSpy).toHaveBeenCalledWith(EXISTING_PID, 'SIGTERM')
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: PID,
        supervisor_session_id: SESSION_ID,
      })
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Stale PID detection in PID-file mode
  // -------------------------------------------------------------------------

  describe('AC5: stale PID-file overwritten without force', () => {
    it('overwrites PID-file when existing PID is dead (ESRCH)', async () => {
      openMock.mockRejectedValueOnce(makeErrnoError('ENOSYS'))
      // PID-file exists with a dead PID
      readFileMock.mockResolvedValueOnce(String(EXISTING_PID))
      writeFileMock.mockResolvedValueOnce(undefined)

      // process.kill(EXISTING_PID, 0) throws ESRCH → dead
      killSpy.mockImplementation((_pid, signal) => {
        if (signal === 0) throw makeErrnoError('ESRCH')
        return true
      })

      // Should not throw
      await expect(lock.acquire(PID, SESSION_ID)).resolves.toBeUndefined()

      // SIGTERM was never sent (not force)
      expect(killSpy).not.toHaveBeenCalledWith(EXISTING_PID, 'SIGTERM')

      // PID-file written with new PID
      expect(writeFileMock).toHaveBeenCalledWith(
        expect.stringContaining(`${RUN_ID}.pid`),
        String(PID),
        { flag: 'w' }
      )

      // Manifest updated
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: PID,
        supervisor_session_id: SESSION_ID,
      })
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Clean release clears ownership
  // -------------------------------------------------------------------------

  describe('AC6: release() clears ownership', () => {
    it('flock mode: unlinks lock file and calls manifest.update with null fields', async () => {
      // Acquire in flock mode first
      const fh = makeMockFileHandle()
      openMock.mockResolvedValueOnce(fh)
      await lock.acquire(PID, SESSION_ID)

      vi.clearAllMocks()
      unlinkMock.mockResolvedValue(undefined)

      await lock.release()

      // Lock file unlinked
      expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining(`${RUN_ID}.lock`))

      // File handle closed
      expect(fh.close).toHaveBeenCalled()

      // Manifest cleared
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: null,
        supervisor_session_id: null,
      })
    })

    it('pid-file mode: unlinks PID-file and calls manifest.update with null fields', async () => {
      // Acquire in PID-file mode (ENOSYS)
      openMock.mockRejectedValueOnce(makeErrnoError('ENOSYS'))
      readFileMock.mockRejectedValueOnce(makeErrnoError('ENOENT'))
      writeFileMock.mockResolvedValueOnce(undefined)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      await lock.acquire(PID, SESSION_ID)

      vi.clearAllMocks()
      unlinkMock.mockResolvedValue(undefined)

      await lock.release()

      // PID-file unlinked
      expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining(`${RUN_ID}.pid`))

      // Manifest cleared
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: null,
        supervisor_session_id: null,
      })
    })

    it('release() is a no-op when called before acquire()', async () => {
      unlinkMock.mockResolvedValue(undefined)

      // Should not throw
      await expect(lock.release()).resolves.toBeUndefined()

      // manifest.update still called (clears null → null, harmless)
      // unlink NOT called because no lock was held
      expect(unlinkMock).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Stale lock file in flock path (EEXIST with null manifest PID)
  // -------------------------------------------------------------------------

  describe('stale lock file in flock path', () => {
    it('removes stale lock file when manifest has no supervisor_pid', async () => {
      // First open attempt: EEXIST (stale lock file)
      openMock.mockRejectedValueOnce(makeErrnoError('EEXIST'))
      // Manifest has no supervisor PID
      vi.mocked(manifest.read).mockResolvedValueOnce(makeManifestData({ supervisor_pid: null }))
      // Unlink stale lock, then open succeeds
      const fh = makeMockFileHandle()
      openMock.mockResolvedValueOnce(fh)

      await lock.acquire(PID, SESSION_ID)

      // Lock file was unlinked (stale cleanup)
      expect(unlinkMock).toHaveBeenCalledWith(expect.stringContaining(`${RUN_ID}.lock`))

      // manifest.update called with ownership
      expect(manifest.update).toHaveBeenCalledWith({
        supervisor_pid: PID,
        supervisor_session_id: SESSION_ID,
      })
    })
  })

  // -------------------------------------------------------------------------
  // Unknown errors are propagated
  // -------------------------------------------------------------------------

  describe('unknown errors are propagated', () => {
    it('propagates unexpected errors from open() other than EEXIST/ENOSYS/EOPNOTSUPP', async () => {
      openMock.mockRejectedValueOnce(makeErrnoError('EACCES'))

      await expect(lock.acquire(PID, SESSION_ID)).rejects.toThrow()
    })

    it('propagates unexpected errors from readFile() in PID-file fallback', async () => {
      openMock.mockRejectedValueOnce(makeErrnoError('ENOSYS'))
      readFileMock.mockRejectedValueOnce(makeErrnoError('EACCES'))
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      await expect(lock.acquire(PID, SESSION_ID)).rejects.toMatchObject({ code: 'EACCES' })
    })
  })
})
