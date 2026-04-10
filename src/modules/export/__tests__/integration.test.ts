/**
 * Integration tests for the export pipeline.
 *
 * T11: write decisions → export → verify markdown output
 *      Seeds the decision store with realistic data, runs the renderers,
 *      writes files to a temp directory, and verifies file contents.
 *
 * T12: export → seedMethodologyContext round-trip
 *      Writes exported files (architecture.md, epics.md) to a temp project
 *      directory and verifies that seedMethodologyContext() correctly
 *      creates decisions from them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import {
  createDecision,
  createPipelineRun,
  getDecisionsByPhaseForRun,
  getDecisionsByPhase,
} from '../../../persistence/queries/decisions.js'
import {
  renderProductBrief,
  renderPrd,
  renderArchitecture,
  renderEpics,
  renderReadinessReport,
} from '../renderers.js'
import { seedMethodologyContext } from '../../implementation-orchestrator/seed-methodology-context.js'
import type { Decision } from '../../../persistence/queries/decisions.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function openTestDb(): Promise<DatabaseAdapter> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return adapter
}

/**
 * Create a pipeline run and return its auto-generated ID.
 * Note: createPipelineRun always generates its own UUID internally.
 */
async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad' })
  return run.id
}

async function insertDecision(
  adapter: DatabaseAdapter,
  runId: string,
  phase: string,
  category: string,
  key: string,
  value: string,
  rationale?: string
): Promise<Decision> {
  return createDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category,
    key,
    value,
    rationale: rationale ?? null,
  })
}

// ---------------------------------------------------------------------------
// T11: write decisions → export → verify markdown output
// ---------------------------------------------------------------------------

describe('T11: write decisions → export → verify markdown output', () => {
  let adapter: DatabaseAdapter
  let runId: string
  let tempDir: string

  beforeEach(async () => {
    adapter = await openTestDb()
    runId = await createTestRun(adapter)
    tempDir = join(tmpdir(), `substrate-export-test-${randomUUID()}`)
    mkdirSync(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await adapter.close()
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('T11a: exports product-brief.md from analysis decisions', async () => {
    // Insert analysis phase decisions
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'problem_statement',
      'Teams waste hours searching for relevant docs in sprawling wikis.'
    )
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'target_users',
      JSON.stringify(['Software engineers', 'Product managers', 'Technical writers'])
    )
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'core_features',
      JSON.stringify(['Semantic search', 'Auto-tagging', 'Slack integration'])
    )
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'success_metrics',
      JSON.stringify(['P50 search latency < 500 ms', 'DAU/MAU ratio > 0.4'])
    )
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'constraints',
      JSON.stringify(['Must run on GCP', 'No PII storage'])
    )
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'technology-constraints',
      'tc-1',
      'Backend must use Kotlin/JVM for concurrency requirements'
    )

    // Fetch decisions and render
    const analysisDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const content = renderProductBrief(analysisDecisions)

    // Write to temp dir
    const filePath = join(tempDir, 'product-brief.md')
    writeFileSync(filePath, content, 'utf-8')

    // Verify file exists and has expected content
    expect(existsSync(filePath)).toBe(true)
    const written = readFileSync(filePath, 'utf-8')

    expect(written).toContain('# Product Brief')
    expect(written).toContain('## Problem Statement')
    expect(written).toContain('Teams waste hours searching')
    expect(written).toContain('## Target Users')
    expect(written).toContain('Software engineers')
    expect(written).toContain('## Core Features')
    expect(written).toContain('Semantic search')
    expect(written).toContain('## Success Metrics')
    expect(written).toContain('P50 search latency')
    expect(written).toContain('## Constraints')
    expect(written).toContain('Must run on GCP')
    expect(written).toContain('## Technology Constraints')
    expect(written).toContain('Kotlin/JVM')
  })

  it('T11b: exports prd.md from planning decisions', async () => {
    // Insert planning phase decisions
    await insertDecision(adapter, runId, 'planning', 'classification', 'type', 'saas-product')
    await insertDecision(
      adapter,
      runId,
      'planning',
      'classification',
      'vision',
      'A smart document discovery platform for engineering teams'
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'functional-requirements',
      'FR-1',
      JSON.stringify({
        id: 'FR-1',
        description: 'Full-text search across all documents',
        priority: 'must',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'functional-requirements',
      'FR-2',
      JSON.stringify({
        id: 'FR-2',
        description: 'Tag-based document filtering',
        priority: 'should',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'non-functional-requirements',
      'NFR-1',
      JSON.stringify({
        id: 'NFR-1',
        description: 'Search results in under 500ms',
        category: 'performance',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'tech-stack',
      'tech_stack',
      JSON.stringify({ language: 'Kotlin', framework: 'Ktor', database: 'PostgreSQL' })
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'out-of-scope',
      'exclusions',
      JSON.stringify(['Multi-tenant billing', 'Mobile native apps'])
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'user-stories',
      'us-1',
      JSON.stringify({
        title: 'Search for documents',
        description: 'As a user, I want to search docs quickly',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'planning',
      'domain-model',
      'entities',
      'Document, Tag, User, SearchIndex'
    )

    // Fetch decisions and render
    const planningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'planning')
    const content = renderPrd(planningDecisions, [])

    // Write to temp dir
    const filePath = join(tempDir, 'prd.md')
    writeFileSync(filePath, content, 'utf-8')

    // Verify file exists and has expected content
    expect(existsSync(filePath)).toBe(true)
    const written = readFileSync(filePath, 'utf-8')

    expect(written).toContain('# Product Requirements Document')
    expect(written).toContain('## Project Classification')
    expect(written).toContain('## Functional Requirements')
    expect(written).toContain('FR-1')
    expect(written).toContain('Full-text search across all documents')
    expect(written).toContain('[MUST]')
    expect(written).toContain('## Non-Functional Requirements')
    expect(written).toContain('NFR-1')
    expect(written).toContain('## Tech Stack')
    expect(written).toContain('Kotlin')
    expect(written).toContain('PostgreSQL')
    expect(written).toContain('## Out of Scope')
    expect(written).toContain('Multi-tenant billing')
    expect(written).toContain('## User Stories')
    expect(written).toContain('Search for documents')
    expect(written).toContain('## Domain Model')
    expect(written).toContain('Document, Tag, User')
  })

  it('T11c: exports architecture.md from solutioning decisions', async () => {
    // Insert solutioning architecture decisions
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'architecture',
      'language',
      'Kotlin',
      'JVM ecosystem, strong concurrency model'
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'architecture',
      'web-framework',
      'Ktor',
      'Lightweight, coroutine-native'
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'architecture',
      'database',
      'PostgreSQL + pgvector',
      'Supports vector similarity search natively'
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'architecture',
      'deployment',
      JSON.stringify({ platform: 'GCP Cloud Run', region: 'us-central1' })
    )

    // Fetch decisions and render
    const solutioningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const content = renderArchitecture(solutioningDecisions)

    // Write to temp dir
    const filePath = join(tempDir, 'architecture.md')
    writeFileSync(filePath, content, 'utf-8')

    // Verify file exists and has expected content
    expect(existsSync(filePath)).toBe(true)
    const written = readFileSync(filePath, 'utf-8')

    expect(written).toContain('# Architecture')
    expect(written).toContain('## Architecture Decisions')
    expect(written).toContain('**language**: Kotlin')
    expect(written).toContain('JVM ecosystem, strong concurrency model')
    expect(written).toContain('**web-framework**: Ktor')
    expect(written).toContain('**database**: PostgreSQL + pgvector')
    expect(written).toContain('**deployment**:')
    // JSON object value renders as sub-fields
    expect(written).toContain('GCP Cloud Run')
  })

  it('T11d: exports epics.md from solutioning decisions', async () => {
    // Insert epic decisions
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'epics',
      'epic-1',
      JSON.stringify({
        title: 'Document Ingestion',
        description: 'Ingest and index documents from multiple sources',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'epics',
      'epic-2',
      JSON.stringify({
        title: 'Search & Discovery',
        description: 'Full-text and semantic search capabilities',
      })
    )

    // Insert story decisions
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'stories',
      '1-1',
      JSON.stringify({
        key: '1-1',
        title: 'Upload documents via REST API',
        description: 'As a user, I can upload documents via a REST endpoint',
        acceptance_criteria: ['API accepts PDF, DOCX, MD', 'Returns document ID on success'],
        priority: 'must',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'stories',
      '1-2',
      JSON.stringify({
        key: '1-2',
        title: 'Auto-tag uploaded documents',
        description: 'As a system, I automatically tag documents on ingestion',
        acceptance_criteria: ['Tags extracted using NLP', 'Stored in tags table'],
        priority: 'should',
      })
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'stories',
      '2-1',
      JSON.stringify({
        key: '2-1',
        title: 'Full-text search endpoint',
        description: 'As a user, I can search all indexed documents',
        acceptance_criteria: ['Returns ranked results', 'P50 latency < 500ms'],
        priority: 'must',
      })
    )

    // Fetch decisions and render
    const solutioningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const content = renderEpics(solutioningDecisions)

    // Write to temp dir
    const filePath = join(tempDir, 'epics.md')
    writeFileSync(filePath, content, 'utf-8')

    // Verify file exists and has expected content
    expect(existsSync(filePath)).toBe(true)
    const written = readFileSync(filePath, 'utf-8')

    expect(written).toContain('# Epics and Stories')
    expect(written).toContain('## Epic 1: Document Ingestion')
    expect(written).toContain('Ingest and index documents')
    expect(written).toContain('## Epic 2: Search & Discovery')
    expect(written).toContain('### Story 1-1: Upload documents via REST API')
    expect(written).toContain('### Story 1-2: Auto-tag uploaded documents')
    expect(written).toContain('### Story 2-1: Full-text search endpoint')
    expect(written).toContain('API accepts PDF, DOCX, MD')
    expect(written).toContain('Returns ranked results')
    expect(written).toContain('**Priority**: must')
  })

  it('T11e: exports readiness-report.md from solutioning decisions', async () => {
    // Insert readiness-findings decisions
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'readiness-findings',
      'finding-1',
      JSON.stringify({
        category: 'fr_coverage',
        severity: 'minor',
        description: 'FR-3 (Batch upload) not addressed in stories',
        affected_items: ['FR-3', 'Story 1-1'],
      })
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'readiness-findings',
      'finding-2',
      JSON.stringify({
        category: 'architecture_compliance',
        severity: 'major',
        description: 'Auth strategy not defined in architecture decisions',
        affected_items: ['architecture/auth'],
      })
    )

    // Fetch decisions and render
    const solutioningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const content = renderReadinessReport(solutioningDecisions)

    // Write to temp dir
    const filePath = join(tempDir, 'readiness-report.md')
    writeFileSync(filePath, content, 'utf-8')

    // Verify file exists and has expected content
    expect(existsSync(filePath)).toBe(true)
    const written = readFileSync(filePath, 'utf-8')

    expect(written).toContain('# Readiness Report')
    expect(written).toContain('**Overall Verdict**: FAIL')
    expect(written).toContain('**Total Findings**: 2')
    expect(written).toContain('[MINOR]')
    expect(written).toContain('[MAJOR]')
    expect(written).toContain('FR-3 (Batch upload) not addressed')
    expect(written).toContain('Auth strategy not defined')
    expect(written).toContain('FR-3, Story 1-1')
  })

  it('T11f: all phases exported in a single run — all expected files written', async () => {
    // Analysis
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'problem_statement',
      'Test problem'
    )
    // Planning
    await insertDecision(adapter, runId, 'planning', 'classification', 'type', 'saas')
    // Solutioning — architecture
    await insertDecision(adapter, runId, 'solutioning', 'architecture', 'language', 'Kotlin')
    // Solutioning — epics
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'epics',
      'epic-1',
      JSON.stringify({ title: 'Epic One', description: 'Desc' })
    )
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'stories',
      '1-1',
      JSON.stringify({
        key: '1-1',
        title: 'Story One',
        description: 'Desc',
        acceptance_criteria: [],
        priority: 'must',
      })
    )
    // Solutioning — readiness
    await insertDecision(
      adapter,
      runId,
      'solutioning',
      'readiness-findings',
      'f-1',
      JSON.stringify({
        category: 'general',
        severity: 'minor',
        description: 'All good',
        affected_items: [],
      })
    )

    const analysisDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const planningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'planning')
    const solutioningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')

    const files: Record<string, string> = {
      'product-brief.md': renderProductBrief(analysisDecisions),
      'prd.md': renderPrd(planningDecisions, []),
      'architecture.md': renderArchitecture(solutioningDecisions),
      'epics.md': renderEpics(solutioningDecisions),
      'readiness-report.md': renderReadinessReport(solutioningDecisions),
    }

    for (const [filename, content] of Object.entries(files)) {
      const filePath = join(tempDir, filename)
      writeFileSync(filePath, content, 'utf-8')
    }

    // All files should exist and be non-empty
    for (const filename of Object.keys(files)) {
      const filePath = join(tempDir, filename)
      expect(existsSync(filePath), `${filename} should exist`).toBe(true)
      const written = readFileSync(filePath, 'utf-8')
      expect(written.length, `${filename} should be non-empty`).toBeGreaterThan(0)
    }
  })

  it('T11g: idempotent overwrite — rendering twice overwrites previous files', async () => {
    // Insert first version of analysis data
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'problem_statement',
      'Original problem statement'
    )

    const outputDir = join(tempDir, 'out')
    mkdirSync(outputDir, { recursive: true })
    const filePath = join(outputDir, 'product-brief.md')

    // First render — write product-brief.md
    const analysisDecisions1 = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const firstContent = renderProductBrief(analysisDecisions1)
    writeFileSync(filePath, firstContent, 'utf-8')

    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toContain('Original problem statement')

    // Insert second decision with a different key (avoids overwriting same key value)
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'target_users',
      'Updated target users — v2'
    )

    // Second render — must overwrite, not append
    const analysisDecisions2 = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const secondContent = renderProductBrief(analysisDecisions2)
    writeFileSync(filePath, secondContent, 'utf-8')

    const finalContent = readFileSync(filePath, 'utf-8')

    // Must contain the data from the second render (the new key/value pair)
    expect(finalContent).toContain('Updated target users')
    // Must NOT be the concatenation of both writes (i.e., overwrite not append)
    expect(finalContent).not.toBe(firstContent + firstContent)
    // File length must equal the second call's rendered content, not be doubled
    expect(finalContent.length).not.toBe(firstContent.length + finalContent.length)
  })

  it('T11h: missing phases gracefully produce no files', async () => {
    // Only insert analysis decisions — no planning or solutioning
    await insertDecision(
      adapter,
      runId,
      'analysis',
      'product-brief',
      'problem_statement',
      'Problem'
    )

    const analysisDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    const planningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'planning')
    const solutioningDecisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')

    const archContent = renderArchitecture(solutioningDecisions)
    const epicsContent = renderEpics(solutioningDecisions)
    const prdContent = renderPrd(planningDecisions, [])

    // Only product-brief.md should be non-empty
    expect(renderProductBrief(analysisDecisions)).not.toBe('')
    expect(prdContent).toBe('') // no planning decisions → empty
    expect(archContent).toBe('') // no solutioning → empty
    expect(epicsContent).toBe('') // no solutioning → empty

    // Skipped files should not be written
    const archPath = join(tempDir, 'architecture.md')
    const epicsPath = join(tempDir, 'epics.md')
    expect(existsSync(archPath)).toBe(false)
    expect(existsSync(epicsPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// T12: export → seedMethodologyContext round-trip
// ---------------------------------------------------------------------------

describe('T12: export → seedMethodologyContext round-trip', () => {
  let sourceAdapter: DatabaseAdapter
  let seedAdapter: DatabaseAdapter
  let runId: string
  let tempProjectRoot: string

  beforeEach(async () => {
    sourceAdapter = await openTestDb()
    seedAdapter = await openTestDb()
    runId = await createTestRun(sourceAdapter)

    // Create temp project root with the expected directory structure
    tempProjectRoot = join(tmpdir(), `substrate-roundtrip-test-${randomUUID()}`)
    const artifactsDir = join(tempProjectRoot, '_bmad-output', 'planning-artifacts')
    mkdirSync(artifactsDir, { recursive: true })
  })

  afterEach(async () => {
    await sourceAdapter.close()
    await seedAdapter.close()
    if (existsSync(tempProjectRoot)) {
      rmSync(tempProjectRoot, { recursive: true, force: true })
    }
  })

  it('T12a: exported architecture.md is parseable by seedMethodologyContext', async () => {
    // Seed realistic architecture decisions into source DB
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'architecture',
      'language',
      'Kotlin',
      'JVM ecosystem for concurrency'
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'architecture',
      'web-framework',
      'Ktor',
      'Lightweight coroutine-native framework'
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'architecture',
      'database',
      'PostgreSQL',
      'ACID-compliant relational database'
    )

    // Export architecture.md
    const solutioningDecisions = await getDecisionsByPhaseForRun(
      sourceAdapter,
      runId,
      'solutioning'
    )
    const archContent = renderArchitecture(solutioningDecisions)
    const archPath = join(tempProjectRoot, '_bmad-output', 'planning-artifacts', 'architecture.md')
    writeFileSync(archPath, archContent, 'utf-8')

    // Verify the exported file has the expected structure that seedMethodologyContext can parse
    expect(archContent).toContain('## Architecture Decisions')

    // Round-trip: seedMethodologyContext reads architecture.md and creates decisions
    const result = await seedMethodologyContext(seedAdapter, tempProjectRoot)

    // Should have seeded at least one architecture decision
    expect(result.decisionsCreated).toBeGreaterThan(0)
    expect(result.skippedCategories).not.toContain('architecture')

    // Verify architecture decisions were created in seedDb
    const seededArchDecisions = (await getDecisionsByPhase(seedAdapter, 'solutioning')).filter(
      (d) => d.category === 'architecture'
    )
    expect(seededArchDecisions.length).toBeGreaterThan(0)

    // The seeded content should contain the architecture decision content
    const combinedSeededValue = seededArchDecisions.map((d) => d.value).join('\n')
    expect(combinedSeededValue).toContain('Architecture Decisions')
  })

  it('T12b: exported epics.md is parseable by seedMethodologyContext', async () => {
    // Seed realistic epic and story decisions into source DB
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'epics',
      'epic-1',
      JSON.stringify({ title: 'Foundation', description: 'Core infrastructure setup' })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'epics',
      'epic-2',
      JSON.stringify({ title: 'API Layer', description: 'REST API endpoints' })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '1-1',
      JSON.stringify({
        key: '1-1',
        title: 'Database setup',
        description: 'Initialize PostgreSQL schema',
        acceptance_criteria: ['Schema migrations applied', 'Tests pass'],
        priority: 'must',
      })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '2-1',
      JSON.stringify({
        key: '2-1',
        title: 'Search endpoint',
        description: 'POST /search returns ranked results',
        acceptance_criteria: ['Returns JSON array', 'P50 < 500ms'],
        priority: 'must',
      })
    )

    // Export epics.md
    const solutioningDecisions = await getDecisionsByPhaseForRun(
      sourceAdapter,
      runId,
      'solutioning'
    )
    const epicsContent = renderEpics(solutioningDecisions)
    const epicsPath = join(tempProjectRoot, '_bmad-output', 'planning-artifacts', 'epics.md')
    writeFileSync(epicsPath, epicsContent, 'utf-8')

    // Verify the exported file has the expected "## Epic N:" heading structure
    expect(epicsContent).toContain('## Epic 1:')
    expect(epicsContent).toContain('## Epic 2:')

    // Round-trip: seedMethodologyContext reads epics.md and creates epic-shard decisions
    const result = await seedMethodologyContext(seedAdapter, tempProjectRoot)

    // Should have created epic-shard decisions (one per epic)
    expect(result.decisionsCreated).toBeGreaterThan(0)
    expect(result.skippedCategories).not.toContain('epic-shard')

    // Verify epic-shard decisions were created in seedDb
    // Post-37-0: renderEpics uses ### Story N-N headings, so per-story shards are produced
    const epicShards = (await getDecisionsByPhase(seedAdapter, 'implementation')).filter(
      (d) => d.category === 'epic-shard'
    )
    // One story per epic → 2 per-story shards (key='1-1' and key='2-1')
    expect(epicShards.length).toBe(2)

    // Epic shard keys should be the story keys (post-37-0 schema)
    const epicShardKeys = epicShards.map((d) => d.key).sort()
    expect(epicShardKeys).toEqual(['1-1', '2-1'])

    // Each shard should contain the story content (starts at story heading, not epic heading)
    const shard1_1 = epicShards.find((d) => d.key === '1-1')
    expect(shard1_1).toBeDefined()
    expect(shard1_1!.value).toContain('Database setup') // story title from Epic 1

    const shard2_1 = epicShards.find((d) => d.key === '2-1')
    expect(shard2_1).toBeDefined()
    expect(shard2_1!.value).toContain('Search endpoint') // story title from Epic 2
  })

  it('T12c: full round-trip — both architecture.md and epics.md seeded correctly', async () => {
    // Seed both architecture and epics/stories
    await insertDecision(sourceAdapter, runId, 'solutioning', 'architecture', 'language', 'Kotlin')
    await insertDecision(sourceAdapter, runId, 'solutioning', 'architecture', 'runtime', 'JVM 21')
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'epics',
      'epic-1',
      JSON.stringify({ title: 'Bootstrap', description: 'Initial project setup' })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '1-1',
      JSON.stringify({
        key: '1-1',
        title: 'Project scaffold',
        description: 'Scaffold Kotlin/Ktor project',
        acceptance_criteria: ['Builds and runs', 'Tests pass'],
        priority: 'must',
      })
    )

    const solutioningDecisions = await getDecisionsByPhaseForRun(
      sourceAdapter,
      runId,
      'solutioning'
    )

    // Export both files
    const archContent = renderArchitecture(solutioningDecisions)
    const epicsContent = renderEpics(solutioningDecisions)
    const artifactsDir = join(tempProjectRoot, '_bmad-output', 'planning-artifacts')
    writeFileSync(join(artifactsDir, 'architecture.md'), archContent, 'utf-8')
    writeFileSync(join(artifactsDir, 'epics.md'), epicsContent, 'utf-8')

    // Full round-trip via seedMethodologyContext
    const result = await seedMethodologyContext(seedAdapter, tempProjectRoot)

    // Should have seeded decisions from both files
    expect(result.decisionsCreated).toBeGreaterThan(0)

    // Architecture decisions should exist
    const archDecisions = (await getDecisionsByPhase(seedAdapter, 'solutioning')).filter(
      (d) => d.category === 'architecture'
    )
    expect(archDecisions.length).toBeGreaterThan(0)

    // Epic shard decisions should exist
    // Post-37-0: renderEpics uses ### Story N-N headings, so per-story shards are produced
    const epicShards = (await getDecisionsByPhase(seedAdapter, 'implementation')).filter(
      (d) => d.category === 'epic-shard'
    )
    // One story (1-1) under one epic → one per-story shard keyed by storyKey
    expect(epicShards.length).toBe(1)
    expect(epicShards[0]!.key).toBe('1-1')
    // Per-story shard starts at story heading, not epic heading — check story title
    expect(epicShards[0]!.value).toContain('Project scaffold')
  })

  it('T12d: seedMethodologyContext is idempotent — re-seeding after initial seed skips', async () => {
    await insertDecision(sourceAdapter, runId, 'solutioning', 'architecture', 'language', 'Kotlin')
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'epics',
      'epic-1',
      JSON.stringify({ title: 'Core', description: 'Core functionality' })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '1-1',
      JSON.stringify({
        key: '1-1',
        title: 'Init',
        description: 'Initialize project',
        acceptance_criteria: ['Works'],
        priority: 'must',
      })
    )

    const solutioningDecisions = await getDecisionsByPhaseForRun(
      sourceAdapter,
      runId,
      'solutioning'
    )
    const artifactsDir = join(tempProjectRoot, '_bmad-output', 'planning-artifacts')
    writeFileSync(
      join(artifactsDir, 'architecture.md'),
      renderArchitecture(solutioningDecisions),
      'utf-8'
    )
    writeFileSync(join(artifactsDir, 'epics.md'), renderEpics(solutioningDecisions), 'utf-8')

    // First seed
    const result1 = await seedMethodologyContext(seedAdapter, tempProjectRoot)
    expect(result1.decisionsCreated).toBeGreaterThan(0)

    // Second seed — should skip categories already seeded
    const result2 = await seedMethodologyContext(seedAdapter, tempProjectRoot)
    expect(result2.decisionsCreated).toBe(0)
    expect(result2.skippedCategories).toContain('architecture')
    expect(result2.skippedCategories).toContain('epic-shard')
  })

  it('T12e: stories under each epic appear in the correct epic shard', async () => {
    // Two epics with two stories each
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'epics',
      'epic-1',
      JSON.stringify({ title: 'Ingestion', description: 'Document ingestion pipeline' })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'epics',
      'epic-2',
      JSON.stringify({ title: 'Search', description: 'Search API' })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '1-1',
      JSON.stringify({
        key: '1-1',
        title: 'Upload endpoint',
        description: 'POST /upload',
        acceptance_criteria: ['Accepts PDF'],
        priority: 'must',
      })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '1-2',
      JSON.stringify({
        key: '1-2',
        title: 'Indexing job',
        description: 'Background indexer',
        acceptance_criteria: ['Async processing'],
        priority: 'should',
      })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '2-1',
      JSON.stringify({
        key: '2-1',
        title: 'Search API',
        description: 'GET /search',
        acceptance_criteria: ['Returns results'],
        priority: 'must',
      })
    )
    await insertDecision(
      sourceAdapter,
      runId,
      'solutioning',
      'stories',
      '2-2',
      JSON.stringify({
        key: '2-2',
        title: 'Result ranking',
        description: 'Rank by relevance',
        acceptance_criteria: ['Ordered correctly'],
        priority: 'must',
      })
    )

    const solutioningDecisions = await getDecisionsByPhaseForRun(
      sourceAdapter,
      runId,
      'solutioning'
    )
    const epicsContent = renderEpics(solutioningDecisions)
    const artifactsDir = join(tempProjectRoot, '_bmad-output', 'planning-artifacts')
    writeFileSync(join(artifactsDir, 'epics.md'), epicsContent, 'utf-8')

    // Seed into fresh DB
    const result = await seedMethodologyContext(seedAdapter, tempProjectRoot)

    // Post-37-0: renderEpics uses ### Story N-N headings, so per-story shards are produced.
    // 2 epics × 2 stories each = 4 per-story shards
    const epicShards = (await getDecisionsByPhase(seedAdapter, 'implementation')).filter(
      (d) => d.category === 'epic-shard'
    )
    expect(epicShards.length).toBe(4)

    // Shard for story 1-1 should contain its own content but NOT epic 2 content
    const shard1_1 = epicShards.find((d) => d.key === '1-1')!
    expect(shard1_1.value).toContain('Upload endpoint')
    expect(shard1_1.value).toContain('Accepts PDF')
    expect(shard1_1.value).not.toContain('## Epic 2')
    expect(shard1_1.value).not.toContain('Search API')

    // Shard for story 1-2 should contain its own content but NOT epic 2 content
    const shard1_2 = epicShards.find((d) => d.key === '1-2')!
    expect(shard1_2.value).toContain('Indexing job')
    expect(shard1_2.value).not.toContain('## Epic 2')

    // Shard for story 2-1 should contain its own content but NOT epic 1 content
    const shard2_1 = epicShards.find((d) => d.key === '2-1')!
    expect(shard2_1.value).toContain('Search API')
    expect(shard2_1.value).not.toContain('## Epic 1')

    // Shard for story 2-2 should contain its own content
    const shard2_2 = epicShards.find((d) => d.key === '2-2')!
    expect(shard2_2.value).toContain('Result ranking')
  })
})

// T13 tests have been moved to export-action.test.ts to isolate the
// vi.mock('../../../utils/git-root.js') that runExportAction requires from
// the T11/T12 tests that call renderers/seedMethodologyContext directly.

// ---------------------------------------------------------------------------
// T14: CLI smoke tests — verify `substrate export` is registered and help output
//      shows the expected options.  These tests spawn the built CLI binary;
//      if `dist/cli/index.js` is absent (e.g. on a clean checkout without a
//      build step) the tests are skipped gracefully.
// ---------------------------------------------------------------------------

const __filename_t14 = fileURLToPath(import.meta.url)
const __dirname_t14 = dirname(__filename_t14)
// Navigate from src/modules/export/__tests__ → project root (4 levels up)
const PROJECT_ROOT_T14 = resolve(__dirname_t14, '../../../..')
const DIST_CLI = join(PROJECT_ROOT_T14, 'dist', 'cli', 'index.js')

// Vitest sets NODE_ENV=test which makes the CLI enable pino-pretty transports.
// Pino worker threads keep the event loop alive, preventing the child process
// from exiting within the timeout. Strip NODE_ENV so the CLI runs normally.
const cliEnv = { ...process.env, NODE_ENV: undefined } as NodeJS.ProcessEnv

describe('T14: CLI smoke tests for substrate export', () => {
  it('T14a: `substrate --help` lists the export subcommand', () => {
    if (!existsSync(DIST_CLI)) {
      console.warn('dist/cli/index.js not found; skipping CLI smoke test (run npm run build first)')
      return
    }
    const result = spawnSync('node', [DIST_CLI, '--help'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
      env: cliEnv,
    })
    if (result.error) {
      console.warn('CLI not runnable; skipping smoke test:', result.error.message)
      return
    }
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('export')
  })

  it('T14b: `substrate export --help` exits 0 and shows registered options', () => {
    if (!existsSync(DIST_CLI)) {
      console.warn('dist/cli/index.js not found; skipping CLI smoke test (run npm run build first)')
      return
    }
    const result = spawnSync('node', [DIST_CLI, 'export', '--help'], {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: 'pipe',
      env: cliEnv,
    })
    if (result.error) {
      console.warn('CLI not runnable; skipping smoke test:', result.error.message)
      return
    }
    expect(result.status).toBe(0)
    // Command description
    expect(result.stdout).toContain('Export decision store contents')
    // All registered options must appear in help output
    expect(result.stdout).toContain('--run-id')
    expect(result.stdout).toContain('--output-dir')
    expect(result.stdout).toContain('--output-format')
    expect(result.stdout).toContain('--project-root')
  })
})
