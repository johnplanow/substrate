/**
 * Unit tests for built-in phase definitions.
 *
 * Covers AC2 (entry gates) and AC3 (exit gates) for all four phases:
 * analysis, planning, solutioning, and implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { registerArtifact, createPipelineRun } from '../../../persistence/queries/decisions.js'
import {
  createAnalysisPhaseDefinition,
  createPlanningPhaseDefinition,
  createSolutioningPhaseDefinition,
  createImplementationPhaseDefinition,
} from '../built-in-phases.js'
import { runGates } from '../phase-orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'built-in-phases-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'test', start_phase: 'analysis' })
  return run.id
}

function registerArtifactForRun(
  db: BetterSqlite3Database,
  runId: string,
  phase: string,
  type: string,
): void {
  registerArtifact(db, {
    pipeline_run_id: runId,
    phase,
    type,
    path: `/artifacts/${phase}-${type}.md`,
    summary: `Test ${type} from ${phase}`,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Built-in Phase Definitions', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    tmpDir = result.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Analysis phase
  // -------------------------------------------------------------------------

  describe('Analysis phase', () => {
    it('has no entry gates (first phase)', () => {
      const phase = createAnalysisPhaseDefinition()
      expect(phase.name).toBe('analysis')
      expect(phase.entryGates).toHaveLength(0)
    })

    it('has one exit gate checking for product-brief artifact', () => {
      const phase = createAnalysisPhaseDefinition()
      expect(phase.exitGates).toHaveLength(1)
      expect(phase.exitGates[0].name).toContain('product-brief')
    })

    it('exit gate fails when product-brief artifact is missing', async () => {
      const phase = createAnalysisPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].gate).toContain('product-brief')
    })

    it('exit gate passes when product-brief artifact exists for this run', async () => {
      registerArtifactForRun(db, runId, 'analysis', 'product-brief')

      const phase = createAnalysisPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
      expect(result.failures).toHaveLength(0)
    })

    it('exit gate fails for a different run ID even when artifact exists for another run', async () => {
      // Create a separate run and register the artifact for that run
      const otherRunId = createTestRun(db)
      registerArtifactForRun(db, otherRunId, 'analysis', 'product-brief')

      const phase = createAnalysisPhaseDefinition()
      // Check gates for OUR run (not the other run)
      const result = await runGates(phase.exitGates, db, runId)

      // Should fail because the artifact belongs to a different run
      expect(result.passed).toBe(false)
    })

    it('has onEnter and onExit callbacks', () => {
      const phase = createAnalysisPhaseDefinition()
      expect(typeof phase.onEnter).toBe('function')
      expect(typeof phase.onExit).toBe('function')
    })
  })

  // -------------------------------------------------------------------------
  // Planning phase
  // -------------------------------------------------------------------------

  describe('Planning phase', () => {
    it('has one entry gate checking for product-brief artifact', () => {
      const phase = createPlanningPhaseDefinition()
      expect(phase.name).toBe('planning')
      expect(phase.entryGates).toHaveLength(1)
      expect(phase.entryGates[0].name).toContain('product-brief')
    })

    it('has one exit gate checking for prd artifact', () => {
      const phase = createPlanningPhaseDefinition()
      expect(phase.exitGates).toHaveLength(1)
      expect(phase.exitGates[0].name).toContain('prd')
    })

    it('entry gate fails when product-brief is missing', async () => {
      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures[0].gate).toContain('product-brief')
    })

    it('entry gate passes when product-brief exists for this run', async () => {
      registerArtifactForRun(db, runId, 'analysis', 'product-brief')

      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(true)
    })

    it('exit gate fails when prd is missing', async () => {
      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures[0].gate).toContain('prd')
    })

    it('exit gate passes when prd artifact exists for this run', async () => {
      registerArtifactForRun(db, runId, 'planning', 'prd')

      const phase = createPlanningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Solutioning phase
  // -------------------------------------------------------------------------

  describe('Solutioning phase', () => {
    it('has one entry gate checking for prd artifact', () => {
      const phase = createSolutioningPhaseDefinition()
      expect(phase.name).toBe('solutioning')
      expect(phase.entryGates).toHaveLength(1)
      expect(phase.entryGates[0].name).toContain('prd')
    })

    it('has two exit gates checking for architecture and stories artifacts', () => {
      const phase = createSolutioningPhaseDefinition()
      expect(phase.exitGates).toHaveLength(2)

      const gateNames = phase.exitGates.map((g) => g.name)
      expect(gateNames.some((n) => n.includes('architecture'))).toBe(true)
      expect(gateNames.some((n) => n.includes('stories'))).toBe(true)
    })

    it('entry gate fails when prd is missing', async () => {
      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
    })

    it('entry gate passes when prd exists for this run', async () => {
      registerArtifactForRun(db, runId, 'planning', 'prd')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(true)
    })

    it('exit gates fail when neither architecture nor stories exist', async () => {
      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(2)
    })

    it('exit gates fail when only architecture exists (stories missing)', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].gate).toContain('stories')
    })

    it('exit gates fail when only stories exists (architecture missing)', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'stories')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].gate).toContain('architecture')
    })

    it('exit gates pass when both architecture and stories exist', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')
      registerArtifactForRun(db, runId, 'solutioning', 'stories')

      const phase = createSolutioningPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Implementation phase
  // -------------------------------------------------------------------------

  describe('Implementation phase', () => {
    it('has three entry gates: architecture, stories, and solutioning-readiness', () => {
      const phase = createImplementationPhaseDefinition()
      expect(phase.name).toBe('implementation')
      expect(phase.entryGates).toHaveLength(3)

      const gateNames = phase.entryGates.map((g) => g.name)
      expect(gateNames.some((n) => n.includes('architecture'))).toBe(true)
      expect(gateNames.some((n) => n.includes('stories'))).toBe(true)
      expect(gateNames.some((n) => n.includes('readiness'))).toBe(true)
    })

    it('entry gates fail when architecture and stories are missing', async () => {
      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
      expect(result.failures.length).toBeGreaterThanOrEqual(2)
    })

    it('entry gates fail when only architecture exists (stories missing)', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')

      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(false)
    })

    it('entry gates pass when both architecture and stories exist', async () => {
      registerArtifactForRun(db, runId, 'solutioning', 'architecture')
      registerArtifactForRun(db, runId, 'solutioning', 'stories')

      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.entryGates, db, runId)

      expect(result.passed).toBe(true)
    })

    it('has one exit gate checking for implementation-complete artifact', () => {
      const phase = createImplementationPhaseDefinition()
      expect(phase.exitGates).toHaveLength(1)
      expect(phase.exitGates[0].name).toContain('implementation-complete')
    })

    it('exit gate fails when implementation-complete artifact is missing', async () => {
      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(false)
    })

    it('exit gate passes when implementation-complete artifact exists', async () => {
      registerArtifactForRun(db, runId, 'implementation', 'implementation-complete')

      const phase = createImplementationPhaseDefinition()
      const result = await runGates(phase.exitGates, db, runId)

      expect(result.passed).toBe(true)
    })
  })
})
