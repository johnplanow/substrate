/**
 * RunManifest — atomic file-backed run state — Story 52-1.
 *
 * Provides typed read/write operations with atomic file replacement
 * so run state survives process crashes without corruption.
 *
 * File layout (relative to baseDir):
 *   {run-id}.json      — primary manifest
 *   {run-id}.json.bak  — backup written before rename
 *   {run-id}.json.tmp  — temporary write target (fsync'd before rename)
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { RunManifestData, Proposal } from './types.js'
import type { RecoveryEntry } from './recovery-history.js'
import { RunManifestSchema, ManifestReadError } from './schemas.js'
import type { CliFlags } from './cli-flags.js'
import type { PerStoryState } from './per-story-state.js'

// ---------------------------------------------------------------------------
// IDoltAdapter — minimal interface for degraded-mode reconstruction
// ---------------------------------------------------------------------------

/**
 * Minimal interface for Dolt query access needed by the degraded-mode fallback.
 * Consumers inject a real `DatabaseAdapter` (from @substrate-ai/core) or null.
 */
export interface IDoltAdapter {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default base directory for run manifests. */
function defaultBaseDir(): string {
  return join(process.cwd(), '.substrate', 'runs')
}

/** Build the primary manifest path for a given run ID. */
function primaryPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.json`)
}

/** Build the backup path. */
function bakPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.json.bak`)
}

/** Build the temporary write path. */
function tmpPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.json.tmp`)
}

/**
 * Attempt to read and parse a manifest file.
 * Returns the parsed data, or null if the file is missing or fails Zod validation.
 */
async function tryReadFile(filePath: string): Promise<RunManifestData | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const result = RunManifestSchema.safeParse(parsed)
    if (!result.success) {
      return null
    }
    return result.data as RunManifestData
  } catch {
    // File missing or unreadable
    return null
  }
}

/**
 * Build a minimal RunManifestData from Dolt pipeline_runs table.
 * Used in degraded-mode when all file sources fail.
 */
async function reconstructFromDolt(
  runId: string,
  adapter: IDoltAdapter,
): Promise<RunManifestData | null> {
  try {
    const rows = await adapter.query<{
      id: string
      config_json: string | null
      created_at: string
      updated_at: string
    }>('SELECT id, config_json, created_at, updated_at FROM pipeline_runs WHERE id = ?', [runId])

    if (rows.length === 0) {
      return null
    }

    const row = rows[0]!
    let cliFlags: Record<string, unknown> = {}
    if (row.config_json) {
      try {
        const parsed = JSON.parse(row.config_json) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cliFlags = parsed as Record<string, unknown>
        }
      } catch {
        // ignore parse failure
      }
    }

    const now = new Date().toISOString()
    const data: RunManifestData = {
      run_id: runId,
      cli_flags: cliFlags,
      story_scope: [],
      supervisor_pid: null,
      supervisor_session_id: null,
      per_story_state: {},
      recovery_history: [],
      cost_accumulation: { per_story: {}, run_total: 0 },
      pending_proposals: [],
      generation: 0,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    }

    return data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// RunManifest class
// ---------------------------------------------------------------------------

/**
 * Typed, atomic file-backed run manifest.
 *
 * Each instance is bound to a specific run ID and base directory.
 * Use `RunManifest.create()` to initialize a new manifest,
 * or `RunManifest.read()` to load an existing one.
 */
export class RunManifest {
  readonly runId: string
  readonly baseDir: string

  /** Optional Dolt adapter for degraded-mode fallback on read. */
  private doltAdapter: IDoltAdapter | null

  /**
   * Serializes all write operations on this instance to prevent lost-update races.
   * Initialized to a resolved promise; each enqueued operation chains off the tail.
   */
  private _writeChain: Promise<void> = Promise.resolve()

  constructor(runId: string, baseDir: string = defaultBaseDir(), doltAdapter: IDoltAdapter | null = null) {
    // Defensive validation — guards against the `[object Object].json` filename
    // bug observed pre-v0.20.66 (an upstream caller passed an object via untyped
    // dispatch path; template literal in primaryPath() coerced via String()).
    // Throws so callers see the bug immediately instead of silently writing a
    // malformed manifest file.
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new TypeError(
        `RunManifest: runId must be a non-empty string (got ${typeof runId}: ${String(runId)})`,
      )
    }
    if (runId.includes('/') || runId.includes('\\') || runId.includes('\0')) {
      throw new TypeError(
        `RunManifest: runId must not contain path separators or null bytes (got: ${runId})`,
      )
    }
    this.runId = runId
    this.baseDir = baseDir
    this.doltAdapter = doltAdapter
  }

  // -------------------------------------------------------------------------
  // Path helpers (instance methods for convenience)
  // -------------------------------------------------------------------------

  get primaryPath(): string {
    return primaryPath(this.baseDir, this.runId)
  }

  get bakPath(): string {
    return bakPath(this.baseDir, this.runId)
  }

  get tmpPath(): string {
    return tmpPath(this.baseDir, this.runId)
  }

  // -------------------------------------------------------------------------
  // read() — instance convenience wrapper
  // -------------------------------------------------------------------------

  /**
   * Read this manifest from disk (multi-tier fallback).
   *
   * Delegates to `RunManifest.read()` with this instance's runId, baseDir,
   * and doltAdapter. Primarily used by `SupervisorLock` (and tests that mock it).
   *
   * @throws ManifestReadError if all sources fail
   */
  async read(): Promise<RunManifestData> {
    return RunManifest.read(this.runId, this.baseDir, this.doltAdapter)
  }

  // -------------------------------------------------------------------------
  // update() — partial atomic update
  // -------------------------------------------------------------------------

  /**
   * Atomically update specific fields in the manifest.
   *
   * Reads the current manifest, merges in the provided partial data (shallow
   * merge), then writes the result atomically. Generation is incremented and
   * `updated_at` is refreshed by `write()`.
   *
   * Callers should pass only the fields they intend to change. Do NOT use this
   * to change `run_id` or `created_at` — those are immutable after creation.
   *
   * @throws ManifestReadError if the current manifest cannot be read
   */
  async update(partial: Partial<Omit<RunManifestData, 'generation' | 'updated_at'>>): Promise<void> {
    const current = await this.read()
    const merged: Omit<RunManifestData, 'generation' | 'updated_at'> = {
      ...current,
      ...partial,
    }
    await this.write(merged)
  }

  // -------------------------------------------------------------------------
  // _enqueue() — private write serializer
  // -------------------------------------------------------------------------

  /**
   * Append `fn` to the per-instance write chain so all write operations execute
   * strictly sequentially, preventing lost-update races on concurrent callers.
   *
   * The chain itself never rejects (errors are swallowed on the chain side);
   * the returned promise resolves or rejects exactly when `fn` settles, so
   * fire-and-forget `.catch()` callers still receive failure signals.
   */
  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this._writeChain.then(() => fn())
    // Keep chain alive even if fn rejects — subsequent enqueues must not stall
    this._writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  // -------------------------------------------------------------------------
  // _writeImpl() — raw atomic write (bypasses enqueue, called within _enqueue)
  // -------------------------------------------------------------------------

  /**
   * Raw implementation of the atomic manifest write.
   * Must only be called from within an `_enqueue`-d function to maintain
   * the serialization invariant.
   *
   * Sequence:
   *   1. Auto-increment `generation`, set `updated_at`
   *   2. Serialize to JSON and validate round-trip
   *   3. Ensure baseDir exists (mkdir -p)
   *   4. Write to `.tmp` via open → write → datasync → close (fsync)
   *   5. If primary exists, copy to `.bak`
   *   6. Rename `.tmp` → primary path
   */
  private async _writeImpl(data: Omit<RunManifestData, 'generation' | 'updated_at'>): Promise<void> {
    // Read current generation from disk to increment correctly
    let currentGeneration = 0
    const existing = await tryReadFile(this.primaryPath)
    if (existing !== null) {
      currentGeneration = existing.generation
    }

    const fullData: RunManifestData = {
      ...data,
      generation: currentGeneration + 1,
      updated_at: new Date().toISOString(),
    }

    // Serialize and validate round-trip
    const json = JSON.stringify(fullData, null, 2)
    // Validate parse round-trip — if this throws, do not proceed
    JSON.parse(json)

    // Ensure base directory exists
    await fs.mkdir(this.baseDir, { recursive: true })

    // Write to .tmp using open → write → datasync → close (NOT writeFile — no fsync)
    const tmp = this.tmpPath
    const fileHandle = await fs.open(tmp, 'w')
    try {
      await fileHandle.write(json, 0, 'utf-8')
      await fileHandle.datasync()
    } finally {
      await fileHandle.close()
    }

    // Backup current primary to .bak (if primary exists)
    try {
      await fs.copyFile(this.primaryPath, this.bakPath)
    } catch {
      // Primary does not exist yet — no backup needed
    }

    // Atomic rename: .tmp → primary
    await fs.rename(tmp, this.primaryPath)
  }

  // -------------------------------------------------------------------------
  // write()
  // -------------------------------------------------------------------------

  /**
   * Atomically write the manifest to disk.
   *
   * Enqueues the write via `_enqueue` so concurrent calls are serialized.
   * The returned promise resolves when this call's write completes.
   */
  async write(data: Omit<RunManifestData, 'generation' | 'updated_at'>): Promise<void> {
    return this._enqueue(() => this._writeImpl(data))
  }

  // -------------------------------------------------------------------------
  // Static factory: open()
  // -------------------------------------------------------------------------

  /**
   * Return a bound `RunManifest` instance without performing any file I/O.
   *
   * Use `open()` when you want to call instance methods (`read()`, `patchCLIFlags()`)
   * on an existing run without reading the manifest upfront.
   *
   * ```typescript
   * await RunManifest.open(runId, runsDir).patchCLIFlags(cliFlags)
   * ```
   */
  static open(
    runId: string,
    baseDir: string = defaultBaseDir(),
    doltAdapter: IDoltAdapter | null = null,
  ): RunManifest {
    return new RunManifest(runId, baseDir, doltAdapter)
  }

  // -------------------------------------------------------------------------
  // Instance: patchCLIFlags()
  // -------------------------------------------------------------------------

  /**
   * Raw implementation — must only be called from within `_enqueue`.
   */
  private async _patchCLIFlagsImpl(flags: CliFlags): Promise<void> {
    let existingData: Omit<RunManifestData, 'generation' | 'updated_at'>

    try {
      const read = await RunManifest.read(this.runId, this.baseDir, this.doltAdapter)
      // Strip generation and updated_at — _writeImpl() re-computes them
      const { generation: _gen, updated_at: _ts, ...rest } = read
      existingData = rest
    } catch {
      // No existing manifest — bootstrap a minimal default
      const now = new Date().toISOString()
      existingData = {
        run_id: this.runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: now,
      }
    }

    await this._writeImpl({
      ...existingData,
      cli_flags: { ...existingData.cli_flags, ...flags },
    })
  }

  /**
   * Read the current manifest (or create a minimal default), merge the provided
   * CLI flags into `cli_flags`, and write the result atomically.
   *
   * Enqueues the operation via `_enqueue` so concurrent calls are serialized.
   * Non-fatal: callers should wrap in try/catch and log a warning on failure.
   * The pipeline must not abort if manifest write fails.
   */
  async patchCLIFlags(flags: CliFlags): Promise<void> {
    return this._enqueue(() => this._patchCLIFlagsImpl(flags))
  }

  // -------------------------------------------------------------------------
  // Instance: patchStoryState() — atomic upsert for per-story lifecycle state
  // -------------------------------------------------------------------------

  /**
   * Raw implementation — must only be called from within `_enqueue`.
   */
  private async _patchStoryStateImpl(storyKey: string, updates: Partial<PerStoryState>): Promise<void> {
    let existingData: Omit<RunManifestData, 'generation' | 'updated_at'>

    try {
      const read = await RunManifest.read(this.runId, this.baseDir, this.doltAdapter)
      // Strip generation and updated_at — _writeImpl() re-computes them
      const { generation: _gen, updated_at: _ts, ...rest } = read
      existingData = rest
    } catch {
      // No existing manifest — bootstrap a minimal default so we can write the entry
      const now = new Date().toISOString()
      existingData = {
        run_id: this.runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: now,
      }
    }

    // Shallow-merge updates into the existing entry (or create if absent).
    // When no existing entry is present, provide sensible defaults for the three
    // required fields (status, phase, started_at) so the merged result passes
    // PerStoryStateSchema validation on read. In normal pipeline operation the
    // orchestrator always creates the entry via the 'dispatched' transition before
    // calling persistVerificationResult or any other partial-patch helper, so
    // `existing` is defined in the vast majority of cases. This guard handles
    // callers that patch verification_result or cost_usd in isolation (e.g. tests).
    const existing = existingData.per_story_state[storyKey]
    const merged: PerStoryState = {
      status: 'pending',
      phase: '',
      started_at: new Date().toISOString(),
      ...existing,
      ...updates,
    } as PerStoryState

    await this._writeImpl({
      ...existingData,
      per_story_state: {
        ...existingData.per_story_state,
        [storyKey]: merged,
      },
    })
  }

  /**
   * Atomically upsert the per-story lifecycle state for a single story key.
   *
   * Reads the current manifest (or creates a minimal default if absent),
   * shallowly merges `updates` into `per_story_state[storyKey]`, and writes
   * the result atomically via a single `write()` call.
   *
   * Fields not included in `updates` on an existing entry are preserved unchanged.
   *
   * Enqueues the operation via `_enqueue` so concurrent calls are serialized.
   * Non-fatal: callers MUST wrap in `.catch((err) => logger.warn(...))`.
   * The pipeline must never abort due to a manifest write failure.
   *
   * @param storyKey - Story key (e.g. '52-4')
   * @param updates  - Partial PerStoryState fields to merge
   */
  async patchStoryState(storyKey: string, updates: Partial<PerStoryState>): Promise<void> {
    return this._enqueue(() => this._patchStoryStateImpl(storyKey, updates))
  }

  // -------------------------------------------------------------------------
  // Instance: patchRunStatus() — atomic run-level status update (Story 58-7)
  // -------------------------------------------------------------------------

  /**
   * Raw implementation — must only be called from within `_enqueue`.
   */
  private async _patchRunStatusImpl(updates: {
    run_status?: RunManifestData['run_status']
    stopped_reason?: string
    stopped_at?: string
  }): Promise<void> {
    let existingData: Omit<RunManifestData, 'generation' | 'updated_at'>

    try {
      const read = await RunManifest.read(this.runId, this.baseDir, this.doltAdapter)
      const { generation: _gen, updated_at: _ts, ...rest } = read
      existingData = rest
    } catch {
      // No existing manifest — bootstrap a minimal default
      const now = new Date().toISOString()
      existingData = {
        run_id: this.runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: now,
      }
    }

    // Build the merged object without spreading optional-undefined values — required
    // because exactOptionalPropertyTypes: true disallows explicit `key: undefined`
    // on types where the field is declared optional (absent is ok; undefined is not).
    const merged: Omit<RunManifestData, 'generation' | 'updated_at'> = { ...existingData }
    if (updates.run_status !== undefined) merged.run_status = updates.run_status
    if (updates.stopped_reason !== undefined) merged.stopped_reason = updates.stopped_reason
    if (updates.stopped_at !== undefined) merged.stopped_at = updates.stopped_at

    await this._writeImpl(merged)
  }

  /**
   * Atomically update the run-level status fields in the manifest.
   *
   * Reads the current manifest (or creates a minimal default if absent),
   * merges the provided status updates at the top level, and writes the
   * result atomically via a single `write()` call.
   *
   * Enqueues the operation via `_enqueue` so concurrent calls are serialized
   * (preserves the single-writer guarantee from Epic 57-1).
   * Non-fatal: callers MUST wrap in `.catch((err) => logger.warn(...))`.
   *
   * @param updates - Top-level status fields to merge (run_status, stopped_reason, stopped_at)
   */
  async patchRunStatus(updates: {
    run_status?: RunManifestData['run_status']
    stopped_reason?: string
    stopped_at?: string
  }): Promise<void> {
    return this._enqueue(() => this._patchRunStatusImpl(updates))
  }

  // -------------------------------------------------------------------------
  // Instance: appendRecoveryEntry() — atomic append and cost update
  // -------------------------------------------------------------------------

  /**
   * Raw implementation — must only be called from within `_enqueue`.
   */
  private async _appendRecoveryEntryImpl(entry: RecoveryEntry): Promise<void> {
    let existingData: Omit<RunManifestData, 'generation' | 'updated_at'>

    try {
      const read = await RunManifest.read(this.runId, this.baseDir, this.doltAdapter)
      const { generation: _gen, updated_at: _ts, ...rest } = read
      existingData = rest
    } catch {
      // No existing manifest — bootstrap a minimal default so we can write the entry
      const now = new Date().toISOString()
      existingData = {
        run_id: this.runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: now,
      }
    }

    const prevStoryCost = existingData.cost_accumulation.per_story[entry.story_key] ?? 0
    const updated: Omit<RunManifestData, 'generation' | 'updated_at'> = {
      ...existingData,
      recovery_history: [...existingData.recovery_history, entry],
      cost_accumulation: {
        per_story: {
          ...existingData.cost_accumulation.per_story,
          [entry.story_key]: prevStoryCost + entry.cost_usd,
        },
        run_total: existingData.cost_accumulation.run_total + entry.cost_usd,
      },
    }

    await this._writeImpl(updated)
  }

  /**
   * Atomically append a recovery entry and update cost accumulation.
   *
   * Reads the current manifest, appends `entry` to `recovery_history[]`,
   * increments `cost_accumulation.per_story[entry.story_key]` by `entry.cost_usd`,
   * increments `cost_accumulation.run_total` by `entry.cost_usd`, then writes
   * atomically via a single `write()` call.
   *
   * Enqueues the operation via `_enqueue` so concurrent calls are serialized.
   * Non-fatal: callers MUST wrap in `.catch((err) => logger.warn(...))`.
   * The pipeline must never abort due to a manifest write failure.
   *
   * `entry.cost_usd` is the cost of this single retry attempt only (NOT cumulative).
   * Cumulative per-story retry cost is tracked in `cost_accumulation.per_story`.
   *
   * @param entry - Recovery entry to append (attempt_number is 1-indexed)
   */
  async appendRecoveryEntry(entry: RecoveryEntry): Promise<void> {
    return this._enqueue(() => this._appendRecoveryEntryImpl(entry))
  }

  // -------------------------------------------------------------------------
  // Instance: appendProposal() — atomic append with storyKey deduplication
  // -------------------------------------------------------------------------

  /**
   * Raw implementation — must only be called from within `_enqueue`.
   */
  private async _appendProposalImpl(proposal: Proposal): Promise<void> {
    let existingData: Omit<RunManifestData, 'generation' | 'updated_at'>

    try {
      const read = await RunManifest.read(this.runId, this.baseDir, this.doltAdapter)
      const { generation: _gen, updated_at: _ts, ...rest } = read
      existingData = rest
    } catch {
      // No existing manifest — bootstrap a minimal default so we can write the entry
      const now = new Date().toISOString()
      existingData = {
        run_id: this.runId,
        cli_flags: {},
        story_scope: [],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [],
        created_at: now,
      }
    }

    // Idempotency guard: deduplicate by storyKey (camelCase Recovery Engine field).
    // Check both storyKey (camelCase) and story_key (snake_case) for full compat.
    const targetKey = proposal.storyKey ?? proposal.story_key
    if (targetKey !== undefined) {
      const alreadyPresent = existingData.pending_proposals.some((p) => {
        const existingKey = p.storyKey ?? p.story_key
        return existingKey === targetKey
      })
      if (alreadyPresent) {
        // Silently return — idempotent no-op
        return
      }
    }

    await this._writeImpl({
      ...existingData,
      pending_proposals: [...existingData.pending_proposals, proposal],
    })
  }

  /**
   * Atomically append a proposal to `pending_proposals`, deduplicating by storyKey.
   *
   * If a proposal with the same `storyKey` (or `story_key`) is already present in
   * `pending_proposals`, the call is a silent no-op (idempotent). This guards
   * against duplicate proposals from concurrent or repeated recovery invocations.
   *
   * Enqueues the operation via `_enqueue` so concurrent calls are serialized.
   * Non-fatal: callers MUST wrap in `.catch((err) => logger.warn(...))`.
   * The pipeline must never abort due to a manifest write failure.
   *
   * Story 73-1 (Recovery Engine). Canonical manifest helper per AC3.
   *
   * @param proposal - Proposal to append (id, created_at, description, type + Epic 73 fields)
   */
  async appendProposal(proposal: Proposal): Promise<void> {
    return this._enqueue(() => this._appendProposalImpl(proposal))
  }

  // -------------------------------------------------------------------------
  // Static factory: create()
  // -------------------------------------------------------------------------

  /**
   * Create a new manifest with `generation: 0` and write it.
   * Returns a bound `RunManifest` instance.
   */
  static async create(
    runId: string,
    initialData: Omit<RunManifestData, 'generation' | 'updated_at' | 'created_at'>,
    baseDir: string = defaultBaseDir(),
    doltAdapter: IDoltAdapter | null = null,
  ): Promise<RunManifest> {
    const instance = new RunManifest(runId, baseDir, doltAdapter)

    const now = new Date().toISOString()
    const data: Omit<RunManifestData, 'generation' | 'updated_at'> = {
      ...initialData,
      created_at: now,
    }

    await instance.write(data)
    return instance
  }

  // -------------------------------------------------------------------------
  // Static: read()
  // -------------------------------------------------------------------------

  /**
   * Read a manifest from disk with multi-tier fallback.
   *
   * Attempts sources in order:
   *   1. Primary `.json`
   *   2. Backup `.json.bak`  (preferred over primary if generation is higher)
   *   3. Temporary `.json.tmp`
   *   4. Dolt degraded reconstruction (if doltAdapter is provided)
   *
   * Generation tiebreak: if `.bak` has a higher `generation` than primary,
   * `.bak` is preferred (indicates primary was overwritten mid-rename).
   *
   * @throws ManifestReadError if all sources fail
   */
  static async read(
    runId: string,
    baseDir: string = defaultBaseDir(),
    doltAdapter: IDoltAdapter | null = null,
  ): Promise<RunManifestData> {
    const attempted: string[] = []
    const primary = primaryPath(baseDir, runId)
    const bak = bakPath(baseDir, runId)
    const tmp = tmpPath(baseDir, runId)

    // Attempt primary and bak, then apply generation tiebreak
    attempted.push(primary)
    const primaryData = await tryReadFile(primary)

    attempted.push(bak)
    const bakData = await tryReadFile(bak)

    // Generation tiebreak: prefer bak if it has a higher generation (newer write)
    if (primaryData !== null && bakData !== null) {
      if (bakData.generation > primaryData.generation) {
        // .bak is newer — use it
        return bakData
      }
      // primary is fine
      return primaryData
    }

    if (primaryData !== null) {
      return primaryData
    }

    if (bakData !== null) {
      return bakData
    }

    // Try .tmp
    attempted.push(tmp)
    const tmpData = await tryReadFile(tmp)
    if (tmpData !== null) {
      return tmpData
    }

    // Dolt degraded reconstruction
    if (doltAdapter !== null) {
      const doltSource = 'dolt:pipeline_runs'
      attempted.push(doltSource)
      const doltData = await reconstructFromDolt(runId, doltAdapter)
      if (doltData !== null) {
        // Log degraded mode warning
        console.warn(
          `[RunManifest] Degraded mode: reconstructed run ${runId} from Dolt pipeline_runs. ` +
            `per_story_state and recovery_history are empty.`,
        )
        return doltData
      }
    }

    throw new ManifestReadError(
      `Failed to read manifest for run ${runId}: all sources exhausted`,
      attempted,
    )
  }
}
