/**
 * Integration test for Recovery Engine — Story 73-1 (AC12).
 *
 * Uses a real temp-dir RunManifest (no mock for manifest I/O) pre-populated
 * with 1 proposed story and 2 ready stories (one dependent, one independent).
 *
 * Verifies:
 *   - Recovery engine correctly reads proposals from a real manifest file
 *   - Back-pressure with work graph correctly computes pause/continue sets
 *   - Independent story continues dispatching; dependent story is paused
 *
 * Per Story 70-1 / 72-x integration test discipline: real temp-dir manifest,
 * mock the dev-story dispatcher and work-graph query adapter only.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { RunManifest } from '@substrate-ai/sdlc'
import { runRecoveryEngine } from '../../src/modules/recovery-engine/index.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tempDir: string

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Integration test: back-pressure with real manifest and work graph
// ---------------------------------------------------------------------------

describe('Recovery Engine — integration (real RunManifest, mocked work graph)', () => {
  it('(AC12) 1 proposed story + 2 ready stories: dependent paused, independent continues', async () => {
    // -- Setup: create temp dir and real RunManifest -------------------------
    tempDir = await mkdtemp(join(tmpdir(), 'substrate-re-test-'))
    const runId = 'integration-run-001'
    const manifest = new RunManifest(runId, tempDir)

    // Bootstrap manifest with a pre-existing proposal for story 72-1
    await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: ['72-1', '73-2', '73-3'],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {
          '72-1': {
            status: 'escalated',
            phase: 'ESCALATED',
            started_at: new Date().toISOString(),
          },
          '73-2': {
            status: 'dispatched',
            phase: 'IN_DEV',
            started_at: new Date().toISOString(),
          },
          '73-3': {
            status: 'dispatched',
            phase: 'IN_DEV',
            started_at: new Date().toISOString(),
          },
        },
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [
          {
            id: 'prop-existing-001',
            created_at: new Date().toISOString(),
            description: 'Pre-existing proposal for 72-1',
            type: 'escalate',
            storyKey: '72-1',
            story_key: '72-1',
            rootCause: 'scope-violation',
            attempts: 2,
            suggestedAction: 'Split story 72-1',
            blastRadius: [],
          },
        ],
      },
      tempDir,
      null,
    )

    // -- Mock event bus -------------------------------------------------------
    const bus = { emit: vi.fn() } as unknown as Parameters<typeof runRecoveryEngine>[0]['bus']

    // -- Mock adapter: 73-2 depends on 73-1 (proposed in this call) ----------
    // 73-3 is independent
    const adapter = {
      query: vi.fn().mockResolvedValue([
        // 73-2 depends on 73-1 (the story being proposed now)
        { story_key: '73-2', depends_on: '73-1' },
      ]),
    } as unknown as Parameters<typeof runRecoveryEngine>[0]['adapter']

    // -- Execute recovery engine on story 73-1 failure -----------------------
    const result = await runRecoveryEngine({
      runId,
      storyKey: '73-1',
      failure: {
        rootCause: 'scope-violation',
        findings: ['Story 73-1 scope exceeds single-story budget'],
      },
      budget: { remaining: 2, max: 3 },
      bus,
      manifest,
      adapter,
      engine: 'graph',
      pendingStoryKeys: ['73-2', '73-3'],
    })

    // -- Assertions -----------------------------------------------------------

    // Result should be 'propose' (scope-violation → Tier B)
    expect(result.action).toBe('propose')

    if (result.action !== 'propose') {
      throw new Error(`Expected action 'propose', got '${result.action}'`)
    }

    // pendingProposalsCount should be 2 (pre-existing + new)
    expect(result.pendingProposalsCount).toBe(2)

    // Back-pressure: 73-2 depends on proposed 73-1 → should be paused
    expect(result.pause).toBeDefined()
    expect(result.pause).toContain('73-2')

    // 73-3 is independent → should continue
    expect(result.continue).toBeDefined()
    expect(result.continue).toContain('73-3')

    // Not a full pause-all (we have work graph data)
    expect(result.pauseAll).toBeUndefined()

    // -- Verify manifest was updated -----------------------------------------
    const finalManifest = await manifest.read()
    const proposals = finalManifest.pending_proposals

    // Should have 2 proposals: pre-existing 72-1 + new 73-1
    expect(proposals).toHaveLength(2)

    const newProposal = proposals.find((p) => (p.storyKey ?? p.story_key) === '73-1')
    expect(newProposal).toBeDefined()
    expect(newProposal?.rootCause).toBe('scope-violation')
    expect(newProposal?.type).toBe('escalate')

    // -- Verify events emitted -----------------------------------------------
    expect(bus.emit).toHaveBeenCalledWith('recovery:tier-b-proposal', expect.objectContaining({
      runId,
      storyKey: '73-1',
      rootCause: 'scope-violation',
    }))

    // Tier A event should NOT be emitted for scope-violation
    expect(bus.emit).not.toHaveBeenCalledWith('recovery:tier-a-retry', expect.anything())

    // Safety valve NOT triggered (only 2 proposals, need >= 5)
    expect(bus.emit).not.toHaveBeenCalledWith('pipeline:halted-pending-proposals', expect.anything())
  })

  it('idempotency: re-running recovery on story already proposed is a no-op', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'substrate-re-idempotent-'))
    const runId = 'idempotent-run-001'
    const manifest = new RunManifest(runId, tempDir)

    // Bootstrap manifest with 73-1 already proposed
    await RunManifest.create(
      runId,
      {
        run_id: runId,
        cli_flags: {},
        story_scope: ['73-1'],
        supervisor_pid: null,
        supervisor_session_id: null,
        per_story_state: {},
        recovery_history: [],
        cost_accumulation: { per_story: {}, run_total: 0 },
        pending_proposals: [
          {
            id: 'prop-existing-73-1',
            created_at: new Date().toISOString(),
            description: 'Proposal for 73-1',
            type: 'escalate',
            storyKey: '73-1',
            story_key: '73-1',
            rootCause: 'scope-violation',
            attempts: 1,
            suggestedAction: 'Split story',
            blastRadius: [],
          },
        ],
      },
      tempDir,
      null,
    )

    const bus = { emit: vi.fn() } as unknown as Parameters<typeof runRecoveryEngine>[0]['bus']
    const adapter = { query: vi.fn().mockResolvedValue([]) } as unknown as Parameters<typeof runRecoveryEngine>[0]['adapter']

    // Run recovery again on the same story
    await runRecoveryEngine({
      runId,
      storyKey: '73-1',
      failure: { rootCause: 'scope-violation' },
      budget: { remaining: 0, max: 3 },
      bus,
      manifest,
      adapter,
    })

    // Manifest should still have only 1 proposal (idempotent)
    const finalManifest = await manifest.read()
    const count73_1 = finalManifest.pending_proposals.filter(
      (p) => (p.storyKey ?? p.story_key) === '73-1',
    ).length
    expect(count73_1).toBe(1)
  })
})
