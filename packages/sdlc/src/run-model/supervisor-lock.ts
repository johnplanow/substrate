/**
 * SupervisorLock — advisory lock preventing concurrent supervisor attachment.
 *
 * Story 52-2: Supervisor Locking and Ownership.
 *
 * Primary path: uses atomic exclusive file creation (`O_CREAT | O_EXCL` via
 * the `'wx'` flag) on `.substrate/runs/{run-id}.lock` to simulate advisory
 * flock. On filesystems that do not support this (ENOSYS / EOPNOTSUPP), the
 * implementation automatically degrades to a PID-file at
 * `.substrate/runs/{run-id}.pid`.
 *
 * Error message format (AC3, FR-R3 — must be exact):
 *   "Run {run-id} is already supervised by PID {pid}. Use --force to take over."
 */

import { mkdir, open, unlink, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import type { ILogger } from '@substrate-ai/core'
import type { RunManifest } from './run-manifest.js'

// Module-level default logger — consumers may inject their own via the constructor.
const defaultLogger: ILogger = console

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for `SupervisorLock.acquire()`.
 */
export interface SupervisorLockOptions {
  /** When true, forcefully evict an existing supervisor (SIGTERM + wait). */
  force?: boolean
}

/** Internal lock mode — 'flock' uses exclusive file creation; 'pid-file' is fallback. */
type LockMode = 'flock' | 'pid-file'

// ---------------------------------------------------------------------------
// SupervisorLock
// ---------------------------------------------------------------------------

/**
 * Advisory lock for the supervisor process.
 *
 * Usage:
 * ```ts
 * const lock = new SupervisorLock(runId, manifest)
 * await lock.acquire(process.pid, sessionId, { force: opts.force })
 * // ... supervisor work ...
 * await lock.release()
 * ```
 *
 * The lock is automatically released on process exit if `registerExitHandlers()`
 * is called, or if the consuming code registers `process.once('exit', ...)`.
 */
export class SupervisorLock {
  readonly runId: string
  private readonly manifest: RunManifest
  private readonly baseDir: string
  private readonly logger: ILogger

  /** Current lock mode — null until `acquire()` succeeds. */
  private mode: LockMode | null = null

  /** File handle held open to maintain the advisory lock (flock mode only). */
  private lockHandle: FileHandle | null = null

  constructor(runId: string, manifest: RunManifest, logger?: ILogger) {
    this.runId = runId
    this.manifest = manifest
    // Co-locate lock files with the manifest
    this.baseDir = manifest.baseDir
    this.logger = logger ?? defaultLogger
  }

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  /** Advisory lock file path (primary path). */
  get lockPath(): string {
    return join(this.baseDir, `${this.runId}.lock`)
  }

  /** PID-file path (fallback path). */
  get pidPath(): string {
    return join(this.baseDir, `${this.runId}.pid`)
  }

  // -------------------------------------------------------------------------
  // acquire()
  // -------------------------------------------------------------------------

  /**
   * Acquire exclusive ownership of the run.
   *
   * Attempts to open `.substrate/runs/{run-id}.lock` with `O_CREAT | O_EXCL`
   * (the `'wx'` flag), which succeeds atomically only if the file does not
   * exist. On success, writes `supervisor_pid` and `supervisor_session_id` to
   * the manifest.
   *
   * On EEXIST (file exists → contended): reads the manifest's `supervisor_pid`,
   * checks if the holder process is alive, and either throws a prescribed
   * rejection error or evicts the holder (if `force: true`).
   *
   * On ENOSYS or EOPNOTSUPP (filesystem does not support exclusive open): logs
   * a `warn`-level message and falls back to PID-file ownership.
   *
   * @throws Error with exact message: "Run {id} is already supervised by PID {pid}. Use --force to take over."
   */
  async acquire(pid: number, sessionId: string, opts?: SupervisorLockOptions): Promise<void> {
    const force = opts?.force ?? false

    // Ensure the run directory exists
    await mkdir(this.baseDir, { recursive: true })

    let fh: FileHandle
    try {
      // 'wx' = O_CREAT | O_EXCL | O_WRONLY — atomic exclusive creation
      // Succeeds only if the file does not already exist (no wait).
      fh = await open(this.lockPath, 'wx')
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException

      if (e.code === 'ENOSYS' || e.code === 'EOPNOTSUPP') {
        // Filesystem does not support exclusive file creation → PID-file fallback
        this.logger.warn(
          `[SupervisorLock] flock not available on this filesystem (${e.code}). ` +
            `Falling back to PID-file for run ${this.runId}.`
        )
        await this.acquireViaPidFile(pid, sessionId, opts)
        return
      }

      if (e.code === 'EEXIST') {
        // Lock file already exists — determine if the holder is alive
        let existingPid: number | null = null
        try {
          const data = await this.manifest.read()
          existingPid = data.supervisor_pid
        } catch {
          // Manifest unreadable — treat as stale lock
        }

        if (existingPid === null) {
          // No PID in manifest → stale lock file from a crashed supervisor.
          // Remove it and retry acquisition.
          await unlink(this.lockPath).catch(() => undefined)
          await this.acquire(pid, sessionId, opts)
          return
        }

        // Check if the recorded PID is still alive
        const isAlive = this.isPidAlive(existingPid)

        if (!isAlive) {
          // Stale lock — dead process left the lock file behind
          await unlink(this.lockPath).catch(() => undefined)
          await this.acquire(pid, sessionId, opts)
          return
        }

        // Live holder — force eviction or reject
        if (force) {
          await this.forceKillOwner(existingPid)
          await unlink(this.lockPath).catch(() => undefined)
          await this.acquire(pid, sessionId, opts)
          return
        }

        throw new Error(
          `Run ${this.runId} is already supervised by PID ${existingPid}. Use --force to take over.`
        )
      }

      // Unknown error — propagate
      throw err
    }

    // Assign handle and mode before any post-open operations so that release()
    // can always clean up if manifest.update() throws.
    this.lockHandle = fh
    this.mode = 'flock'

    try {
      // Write our PID to the lock file for diagnostics (best-effort)
      await fh.write(String(pid), 0, 'utf-8')
      // Record ownership in the manifest
      await this.manifest.update({ supervisor_pid: pid, supervisor_session_id: sessionId })
    } catch (postOpenErr: unknown) {
      // Cleanup: close handle and remove the lock file so we don't leave
      // a stale exclusive file behind on partial failure.
      try {
        await fh.close()
      } catch {
        /* ignore close error */
      }
      this.lockHandle = null
      this.mode = null
      await unlink(this.lockPath).catch(() => undefined)
      throw postOpenErr
    }
  }

  // -------------------------------------------------------------------------
  // release()
  // -------------------------------------------------------------------------

  /**
   * Release ownership of the run.
   *
   * Removes the lock file (flock mode) or PID-file (fallback mode) and clears
   * `supervisor_pid` / `supervisor_session_id` in the manifest atomically.
   *
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  async release(): Promise<void> {
    if (this.mode === 'flock') {
      // Close the file handle first, then unlink
      if (this.lockHandle !== null) {
        try {
          await this.lockHandle.close()
        } catch {
          // Best-effort — handle may already be closed
        }
        this.lockHandle = null
      }
      await unlink(this.lockPath).catch(() => undefined)
    } else if (this.mode === 'pid-file') {
      await this.releaseViaPidFile()
    }

    this.mode = null

    // Clear ownership fields in the manifest
    await this.manifest.update({ supervisor_pid: null, supervisor_session_id: null })
  }

  // -------------------------------------------------------------------------
  // Private: PID-file fallback (AC2, AC5)
  // -------------------------------------------------------------------------

  /**
   * Acquire ownership using a PID-file at `.substrate/runs/{run-id}.pid`.
   *
   * If the PID-file exists:
   *   - Dead PID (ESRCH from `kill(pid, 0)`) → overwrite without force (AC5)
   *   - Alive PID without force → throw prescribed rejection error (AC3)
   *   - Alive PID with force → SIGTERM + wait, then proceed (AC4)
   */
  private async acquireViaPidFile(
    pid: number,
    sessionId: string,
    opts?: SupervisorLockOptions
  ): Promise<void> {
    const force = opts?.force ?? false
    let existingPid: number | null = null

    // Attempt to read an existing PID-file
    try {
      const content = await readFile(this.pidPath, 'utf-8')
      const parsed = parseInt(content.trim(), 10)
      if (!isNaN(parsed)) {
        existingPid = parsed
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      if (err.code !== 'ENOENT') {
        throw e // Unexpected error reading PID-file
      }
      // ENOENT: no PID-file → proceed to create one
    }

    if (existingPid !== null) {
      const isAlive = this.isPidAlive(existingPid)

      if (!isAlive) {
        // AC5: stale PID-file (process crashed) → overwrite silently
      } else if (force) {
        // AC4: force takeover — evict the existing supervisor
        await this.forceKillOwner(existingPid)
      } else {
        // AC3: live supervisor, no force → reject
        throw new Error(
          `Run ${this.runId} is already supervised by PID ${existingPid}. Use --force to take over.`
        )
      }
    }

    // Write PID-file atomically (flag 'w' truncates or creates)
    await writeFile(this.pidPath, String(pid), { flag: 'w' })
    await this.manifest.update({ supervisor_pid: pid, supervisor_session_id: sessionId })
    this.mode = 'pid-file'
  }

  private async releaseViaPidFile(): Promise<void> {
    await unlink(this.pidPath).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Private: force eviction (AC4)
  // -------------------------------------------------------------------------

  /**
   * Send SIGTERM to the existing supervisor and wait up to 500ms for it to exit.
   *
   * @throws Error if the process is still alive after 500ms.
   */
  private async forceKillOwner(existingPid: number): Promise<void> {
    process.kill(existingPid, 'SIGTERM')

    // Brief settle period — give the process time to clean up
    await new Promise<void>((resolve) => setTimeout(resolve, 500))

    // Confirm the process has exited
    const stillAlive = this.isPidAlive(existingPid)
    if (stillAlive) {
      throw new Error(
        `Existing supervisor PID ${existingPid} did not exit after SIGTERM. Kill manually and retry.`
      )
    }
  }

  // -------------------------------------------------------------------------
  // Private: liveness check
  // -------------------------------------------------------------------------

  /**
   * Test whether a PID is alive by sending signal 0.
   *
   * Returns true if the process exists, false if ESRCH (not found).
   * Other errors (e.g. EPERM) are treated as "alive" to avoid false stale
   * detections when we lack permission to signal the process.
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException
      return err.code !== 'ESRCH'
    }
  }
}
