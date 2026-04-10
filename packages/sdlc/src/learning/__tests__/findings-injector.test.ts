/**
 * Unit tests for FindingsInjector and extractTargetFilesFromStoryContent.
 *
 * Story 53-6: Findings Injector with Relevance Scoring (AC2, AC3, AC4, AC5, AC7)
 */

// Mock node:fs so that lifecycle file-existence checks don't demote test findings
// (test findings use fake paths like 'packages/sdlc/src/foo.ts' that don't exist on disk)
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FindingsInjector, extractTargetFilesFromStoryContent } from '../findings-injector.js'
import type { FindingsInjectorConfig } from '../findings-injector.js'
import type { InjectionContext } from '../relevance-scorer.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import type { Finding } from '../types.js'

// ---------------------------------------------------------------------------
// Mock DatabaseAdapter factory
// ---------------------------------------------------------------------------

function makeMockDb(rows: Array<{ value: string }> = []): DatabaseAdapter {
  return {
    backendType: 'memory',
    query: vi.fn().mockResolvedValue(rows),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn: (db: DatabaseAdapter) => Promise<unknown>) =>
      fn({
        backendType: 'memory',
        query: vi.fn().mockResolvedValue([]),
        exec: vi.fn(),
        transaction: vi.fn(),
        close: vi.fn(),
        queryReadyStories: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseAdapter)
    ),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
  } as unknown as DatabaseAdapter
}

// ---------------------------------------------------------------------------
// Finding factory — uses randomUUID() so Zod's strict UUID validation passes
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: randomUUID(),
    run_id: 'run-1',
    story_key: '53-6',
    root_cause: 'build-failure',
    affected_files: ['packages/sdlc/src/foo.ts'],
    description: 'Build failed after story dispatch',
    confidence: 'high',
    created_at: '2026-04-06T00:00:00.000Z',
    expires_after_runs: 5,
    ...overrides,
  }
}

function findingRow(finding: Finding): { value: string } {
  return { value: JSON.stringify(finding) }
}

// Base injection context: no files, no packageName, no riskProfile
// Score for a finding with non-empty affected_files:
//   jaccardFileOverlap=0 (no targetFiles), packageMatch=0.5 (no packageName),
//   rootCauseMatch=0.5 (no riskProfile) → total=0.25 < default threshold 0.3
const BASE_CONTEXT: InjectionContext = {
  storyKey: '53-6',
  runId: 'run-1',
  targetFiles: [],
}

// Context that gives score 0.5 to findings with packages/sdlc/ + root_cause=build-failure
// packageMatch=1.0, rootCauseMatch=1.0, jaccard=0 → 0.3 + 0.2 = 0.5
const SCORING_CONTEXT: InjectionContext = {
  storyKey: '53-6',
  runId: 'run-1',
  targetFiles: [],
  packageName: 'sdlc',
  riskProfile: ['build-failure'],
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FindingsInjector.inject', () => {
  // --- AC2: empty decisions → '' ---
  it('returns empty string when decisions table is empty', async () => {
    const db = makeMockDb([])
    const result = await FindingsInjector.inject(db, BASE_CONTEXT)
    expect(result).toBe('')
  })

  // --- AC2: malformed JSON rows are skipped ---
  it('skips malformed JSON rows and processes remaining findings', async () => {
    const validFinding = makeFinding({
      description: 'Build failed after story dispatch',
      confidence: 'high',
      root_cause: 'build-failure',
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const db = makeMockDb([
      { value: 'not-valid-json{{{{' }, // malformed — skipped
      findingRow(validFinding),
    ])
    const result = await FindingsInjector.inject(db, SCORING_CONTEXT)
    // Valid finding scores: 0.3*1.0 + 0.2*1.0 = 0.5 ≥ 0.3 → included
    expect(result).toContain('Directive: Build failed after story dispatch')
    expect(result).not.toContain('not-valid-json')
  })

  // --- AC2: threshold exclusion ---
  it('excludes findings with score < threshold (default 0.3)', async () => {
    // Score = 0.5*0 + 0.3*0.5 + 0.2*0.5 = 0.25 < 0.3 → excluded
    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
      // BASE_CONTEXT has no packageName, no riskProfile → score = 0.25 < 0.3
    })
    const db = makeMockDb([findingRow(finding)])
    const result = await FindingsInjector.inject(db, BASE_CONTEXT)
    expect(result).toBe('')
  })

  // --- AC4: confidence=high → Directive framing ---
  it('frames confidence=high finding as Directive', async () => {
    const finding = makeFinding({
      root_cause: 'build-failure',
      description: 'Build failed after story dispatch',
      confidence: 'high',
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const db = makeMockDb([findingRow(finding)])
    const result = await FindingsInjector.inject(db, SCORING_CONTEXT)
    expect(result).toContain('[build-failure] Directive: Build failed after story dispatch')
    expect(result.startsWith('Prior run findings (most relevant first):\n\n')).toBe(true)
  })

  // --- AC4: confidence=low → Note (low confidence) framing ---
  it('frames confidence=low finding as Note (low confidence)', async () => {
    const finding = makeFinding({
      root_cause: 'unclassified',
      description: 'some error text',
      confidence: 'low',
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const db = makeMockDb([findingRow(finding)])
    const ctx: InjectionContext = {
      storyKey: '53-6',
      runId: 'run-1',
      targetFiles: [],
      packageName: 'sdlc',
    }
    const result = await FindingsInjector.inject(db, ctx)
    // packageMatch=1.0 (sdlc matches), rootCauseMatch=0.5 (no riskProfile)
    // score = 0.3 + 0.1 = 0.4 ≥ 0.3 → included
    expect(result).toContain('[unclassified] Note (low confidence): some error text')
  })

  // --- AC4: prefix when at least one finding is serialized ---
  it('prefixes result with "Prior run findings (most relevant first):\\n\\n" when findings exist', async () => {
    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    const db = makeMockDb([findingRow(finding)])
    const result = await FindingsInjector.inject(db, SCORING_CONTEXT)
    expect(result.startsWith('Prior run findings (most relevant first):\n\n')).toBe(true)
  })

  // --- AC3: saturation guard raises threshold ---
  it('raises threshold when more than saturationLimit findings pass initial filter', async () => {
    // 10 findings with score 0.5 (packageMatch=1.0, rootCauseMatch=1.0, jaccard=0)
    // score = 0.3*1.0 + 0.2*1.0 = 0.5
    // Each finding uses a unique file to avoid deduplication
    const highScoreFindings = Array.from({ length: 10 }, (_, i) =>
      makeFinding({
        root_cause: 'build-failure',
        affected_files: [`packages/sdlc/src/high${i}.ts`],
        description: `High score finding ${i + 1}`,
        confidence: 'high',
      })
    )

    // 2 findings with score 0.3 (packageMatch=1.0, rootCauseMatch=0.0, jaccard=0)
    // root_cause='test-failure' doesn't match riskProfile=['build-failure'] → rcMatch=0.0
    // score = 0.3*1.0 + 0.2*0.0 = 0.3
    // Each finding uses a unique file to avoid deduplication
    const lowScoreFindings = Array.from({ length: 2 }, (_, i) =>
      makeFinding({
        root_cause: 'test-failure',
        affected_files: [`packages/sdlc/src/low${i}.ts`],
        description: `Low score finding ${i + 1}`,
        confidence: 'high',
      })
    )

    const allRows = [...highScoreFindings, ...lowScoreFindings].map(findingRow)
    const db = makeMockDb(allRows)

    const result = await FindingsInjector.inject(db, SCORING_CONTEXT)

    // At threshold=0.3: 12 findings ≥ 0.3 → 12 > 10 → guard triggers
    // Raises threshold to 0.4:
    //   - 10 findings with score=0.5 ≥ 0.4 → included
    //   - 2 findings with score=0.3 < 0.4 → excluded
    // 10 ≤ saturationLimit(10) → stop
    expect(result).toContain('High score finding')
    expect(result).not.toContain('Low score finding')
  })

  // --- AC4: budget truncation stops at maxChars ---
  it('omits findings that would exceed maxChars budget', async () => {
    // finding1: score 0.5 (sdlc + build-failure match), short description
    const finding1 = makeFinding({
      root_cause: 'build-failure',
      description: 'A'.repeat(20),
      confidence: 'high',
      affected_files: ['packages/sdlc/src/foo.ts'],
    })
    // finding2: score 0.3 (sdlc match, test-failure ≠ build-failure), long description
    const finding2 = makeFinding({
      root_cause: 'test-failure',
      description: 'B'.repeat(200),
      confidence: 'high',
      affected_files: ['packages/sdlc/src/bar.ts'],
    })
    const db = makeMockDb([findingRow(finding1), findingRow(finding2)])

    // maxChars=100:
    //   prefix = 'Prior run findings (most relevant first):\n\n' = 43 chars
    //   finding1 line: '[build-failure] Directive: ' + 20 As = 47 chars → total 43+47=90 ≤ 100 → included
    //   finding2 line: '[test-failure] Directive: ' + 200 Bs = 226 chars → total 90+1+226=317 > 100 → excluded
    const result = await FindingsInjector.inject(db, SCORING_CONTEXT, { maxChars: 100 })
    expect(result).toContain('A'.repeat(20))
    expect(result).not.toContain('B'.repeat(200))
  })

  // --- AC5: config overrides applied ---
  it('applies config override: lower threshold includes findings normally excluded', async () => {
    // Score with BASE_CONTEXT = 0.25 (below default threshold 0.3)
    const finding = makeFinding({
      affected_files: ['packages/sdlc/src/foo.ts'],
      description: 'Low threshold finding',
      confidence: 'high',
    })
    const db = makeMockDb([findingRow(finding)])
    const config: FindingsInjectorConfig = { threshold: 0.2 } // lower threshold
    // With BASE_CONTEXT: score = 0.25 ≥ 0.2 → included
    const result = await FindingsInjector.inject(db, BASE_CONTEXT, config)
    expect(result).toContain('Low threshold finding')
  })

  it('applies config override: saturationLimit', async () => {
    // 5 high-score findings (score=0.5)
    // Each finding uses a unique file to avoid deduplication
    const highScore = Array.from({ length: 5 }, (_, i) =>
      makeFinding({
        root_cause: 'build-failure',
        affected_files: [`packages/sdlc/src/h${i}.ts`],
        description: `High ${i + 1}`,
        confidence: 'high',
      })
    )
    // 1 low-score finding (score=0.3)
    const lowScore = makeFinding({
      root_cause: 'test-failure',
      affected_files: ['packages/sdlc/src/low.ts'],
      description: 'Low 1',
      confidence: 'high',
    })

    const db = makeMockDb([...highScore, lowScore].map(findingRow))
    const config: FindingsInjectorConfig = { saturationLimit: 5 }
    const result = await FindingsInjector.inject(db, SCORING_CONTEXT, config)
    // 6 findings ≥ 0.3 → 6 > saturationLimit(5) → guard triggers
    // Raises to 0.4: 5 findings with score=0.5 ≥ 0.4, 1 with score=0.3 < 0.4 → 5 remain
    // 5 ≤ saturationLimit(5) → stop
    expect(result).toContain('High 1')
    expect(result).not.toContain('Low 1')
  })

  // --- AC2: DB error → '' ---
  it('returns empty string when DB query rejects', async () => {
    const db = {
      ...makeMockDb(),
      query: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    } as unknown as DatabaseAdapter
    const result = await FindingsInjector.inject(db, BASE_CONTEXT)
    expect(result).toBe('')
  })

  // --- AC2: malformed Zod parse skipped ---
  it('skips rows where FindingSchema.safeParse fails (invalid value structure)', async () => {
    // Missing required fields like `id`, `run_id`, etc.
    const invalidFinding = { description: 'incomplete', root_cause: 'build-failure' }
    const db = makeMockDb([{ value: JSON.stringify(invalidFinding) }])
    const result = await FindingsInjector.inject(db, BASE_CONTEXT)
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// extractTargetFilesFromStoryContent
// ---------------------------------------------------------------------------

describe('extractTargetFilesFromStoryContent', () => {
  it('extracts paths matching packages/ or src/ with code extensions', () => {
    const storyContent = `
      ## Key File Paths
      - **New:** \`packages/sdlc/src/learning/types.ts\` — type definitions
      - **Modify:** \`src/modules/compiled-workflows/dev-story.ts\` — callsite swap
    `
    const result = extractTargetFilesFromStoryContent(storyContent)
    expect(result).toContain('packages/sdlc/src/learning/types.ts')
    expect(result).toContain('src/modules/compiled-workflows/dev-story.ts')
  })

  it('deduplicates repeated paths', () => {
    const storyContent = `
      packages/sdlc/src/foo.ts
      packages/sdlc/src/foo.ts
      packages/sdlc/src/bar.ts
    `
    const result = extractTargetFilesFromStoryContent(storyContent)
    const count = result.filter((p) => p === 'packages/sdlc/src/foo.ts').length
    expect(count).toBe(1)
  })

  it('returns empty array when no matching paths found', () => {
    const storyContent = 'No file references here. Just text.'
    const result = extractTargetFilesFromStoryContent(storyContent)
    expect(result).toEqual([])
  })

  it('returns at most 30 paths', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `packages/sdlc/src/file${i}.ts`).join('\n')
    const result = extractTargetFilesFromStoryContent(lines)
    expect(result.length).toBeLessThanOrEqual(30)
  })

  it('matches .json and .md extensions correctly', () => {
    const storyContent = `
      packages/sdlc/package.json
      src/README.md
    `
    const result = extractTargetFilesFromStoryContent(storyContent)
    expect(result).toContain('packages/sdlc/package.json')
    expect(result).toContain('src/README.md')
  })
})
