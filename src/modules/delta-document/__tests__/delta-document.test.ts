/**
 * Unit tests for the delta-document module.
 *
 * Tests:
 * - generateDeltaDocument() produces a complete DeltaDocument
 * - validateDeltaDocument() rejects missing/short executive summaries
 * - formatDeltaDocument() produces valid Markdown with all sections
 * - buildImpactAnalysisPrompt() includes all decisions and ranking instructions
 * - dispatch failure degrades gracefully (impactAnalysis: [])
 * - idempotency: same options produce structurally equivalent output
 */

import { describe, it, expect, vi } from 'vitest'
import type { Decision } from '../../../persistence/schemas/decisions.js'
import {
  generateDeltaDocument,
  validateDeltaDocument,
  formatDeltaDocument,
  buildImpactAnalysisPrompt,
} from '../index.js'
import type {
  ImpactFinding,
  DeltaDocumentOptions,
  DeltaDocument,
} from '../index.js'

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: `decision-${Math.random().toString(36).slice(2, 9)}`,
    pipeline_run_id: 'run-parent-1',
    phase: 'analysis',
    category: 'Architecture',
    key: 'database',
    value: 'PostgreSQL',
    rationale: 'Required for ACID compliance',
    superseded_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const parentDecision1 = makeDecision({ id: 'pd-1', key: 'database', value: 'PostgreSQL' })
const parentDecision2 = makeDecision({ id: 'pd-2', key: 'cache', value: 'Redis', category: 'Caching' })
const parentDecision3 = makeDecision({ id: 'pd-3', key: 'auth', value: 'OAuth2', category: 'Security' })

// Amendment adds new decision (pd-4) + carries over pd-3
const amendmentDecision1 = makeDecision({
  id: 'ad-1',
  pipeline_run_id: 'run-amendment-1',
  key: 'database',
  value: 'MySQL',
  rationale: 'Cost reduction initiative',
})
const amendmentDecision2 = makeDecision({
  id: 'ad-2',
  pipeline_run_id: 'run-amendment-1',
  key: 'orm',
  value: 'Prisma',
  category: 'Data Access',
  rationale: 'Type safety and developer experience',
})
const amendmentDecision3 = makeDecision({
  id: 'pd-3', // Same ID as parent — NOT a new decision
  pipeline_run_id: 'run-amendment-1',
  key: 'auth',
  value: 'OAuth2',
  category: 'Security',
})

const supersededDecision = makeDecision({
  id: 'pd-1',
  key: 'database',
  value: 'PostgreSQL',
  superseded_by: 'ad-1',
})

function makeBaseOptions(overrides: Partial<DeltaDocumentOptions> = {}): DeltaDocumentOptions {
  return {
    amendmentRunId: 'run-amendment-1',
    parentRunId: 'run-parent-1',
    parentDecisions: [parentDecision1, parentDecision2, parentDecision3],
    amendmentDecisions: [amendmentDecision1, amendmentDecision2, amendmentDecision3],
    supersededDecisions: [supersededDecision],
    newStories: ['stories/12-9.md', 'EPIC-5-1'],
    framingConcept: 'Database cost optimization',
    runImpactAnalysis: false, // Default: skip dispatch in most tests
    ...overrides,
  }
}

const mockImpactFindings: ImpactFinding[] = [
  {
    confidence: 'HIGH',
    area: 'Data Model',
    description: 'MySQL does not support the same JSON operators as PostgreSQL.',
    relatedDecisionIds: ['ad-1'],
  },
  {
    confidence: 'MEDIUM',
    area: 'Architecture',
    description: 'ORM migration may require query rewrites.',
    relatedDecisionIds: ['ad-2'],
  },
  {
    confidence: 'LOW',
    area: 'Performance',
    description: 'Query optimizer differences may affect slow queries.',
    relatedDecisionIds: ['pd-1', 'ad-1'],
  },
]

// ---------------------------------------------------------------------------
// generateDeltaDocument()
// ---------------------------------------------------------------------------

describe('generateDeltaDocument()', () => {
  it('returns a DeltaDocument with all required fields', async () => {
    const options = makeBaseOptions()
    const doc = await generateDeltaDocument(options)

    expect(doc.amendmentRunId).toBe('run-amendment-1')
    expect(doc.parentRunId).toBe('run-parent-1')
    expect(doc.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(doc.executiveSummary).toBeDefined()
    expect(doc.executiveSummary.text).toBeTruthy()
    expect(doc.executiveSummary.wordCount).toBeGreaterThan(0)
    expect(Array.isArray(doc.newDecisions)).toBe(true)
    expect(Array.isArray(doc.supersededDecisions)).toBe(true)
    expect(Array.isArray(doc.newStories)).toBe(true)
    expect(Array.isArray(doc.impactAnalysis)).toBe(true)
    expect(Array.isArray(doc.recommendations)).toBe(true)
  })

  it('computes newDecisions as amendment decisions not present in parent', async () => {
    const options = makeBaseOptions()
    const doc = await generateDeltaDocument(options)

    // ad-1 and ad-2 are new; pd-3 (same ID) is NOT new
    const newIds = doc.newDecisions.map((d) => d.id)
    expect(newIds).toContain('ad-1')
    expect(newIds).toContain('ad-2')
    expect(newIds).not.toContain('pd-3')
  })

  it('includes the supersededDecisions from options', async () => {
    const options = makeBaseOptions()
    const doc = await generateDeltaDocument(options)

    expect(doc.supersededDecisions).toHaveLength(1)
    expect(doc.supersededDecisions[0].id).toBe('pd-1')
  })

  it('includes newStories from options', async () => {
    const options = makeBaseOptions()
    const doc = await generateDeltaDocument(options)

    expect(doc.newStories).toEqual(['stories/12-9.md', 'EPIC-5-1'])
  })

  it('defaults newStories to [] when not provided', async () => {
    const options = makeBaseOptions({ newStories: undefined })
    const doc = await generateDeltaDocument(options)

    expect(doc.newStories).toEqual([])
  })

  it('generates executive summary with wordCount >= 20', async () => {
    const options = makeBaseOptions()
    const doc = await generateDeltaDocument(options)

    expect(doc.executiveSummary.wordCount).toBeGreaterThanOrEqual(20)
  })

  it('includes framingConcept in executive summary when provided', async () => {
    const options = makeBaseOptions({ framingConcept: 'Database cost optimization' })
    const doc = await generateDeltaDocument(options)

    expect(doc.executiveSummary.text).toContain('Database cost optimization')
  })

  it('does not include framingConcept in summary when not provided', async () => {
    const options = makeBaseOptions({ framingConcept: undefined })
    const doc = await generateDeltaDocument(options)

    expect(doc.executiveSummary.text).not.toContain('Concept explored')
  })

  it('generates recommendations array', async () => {
    const options = makeBaseOptions()
    const doc = await generateDeltaDocument(options)

    expect(doc.recommendations.length).toBeGreaterThan(0)
    expect(typeof doc.recommendations[0]).toBe('string')
  })

  it('calls dispatch when runImpactAnalysis is true and dispatch is provided', async () => {
    const mockDispatch = vi.fn().mockResolvedValue(JSON.stringify(mockImpactFindings))
    const options = makeBaseOptions({ runImpactAnalysis: true })

    const doc = await generateDeltaDocument(options, mockDispatch)

    expect(mockDispatch).toHaveBeenCalledOnce()
    expect(doc.impactAnalysis).toHaveLength(3)
  })

  it('skips dispatch when runImpactAnalysis is false', async () => {
    const mockDispatch = vi.fn().mockResolvedValue(JSON.stringify(mockImpactFindings))
    const options = makeBaseOptions({ runImpactAnalysis: false })

    const doc = await generateDeltaDocument(options, mockDispatch)

    expect(mockDispatch).not.toHaveBeenCalled()
    expect(doc.impactAnalysis).toHaveLength(0)
  })

  it('skips dispatch when no dispatch function is provided', async () => {
    const options = makeBaseOptions({ runImpactAnalysis: true })
    const doc = await generateDeltaDocument(options)

    expect(doc.impactAnalysis).toHaveLength(0)
  })

  it('defaults runImpactAnalysis to true (calls dispatch when provided)', async () => {
    const mockDispatch = vi.fn().mockResolvedValue(JSON.stringify(mockImpactFindings))
    const options = makeBaseOptions({ runImpactAnalysis: undefined })

    const doc = await generateDeltaDocument(options, mockDispatch)

    expect(mockDispatch).toHaveBeenCalledOnce()
  })

  it('returns impactAnalysis: [] and logs warning when dispatch throws', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockDispatch = vi.fn().mockRejectedValue(new Error('Agent timeout'))
    const options = makeBaseOptions({ runImpactAnalysis: true })

    const doc = await generateDeltaDocument(options, mockDispatch)

    expect(doc.impactAnalysis).toEqual([])
    expect(consoleSpy).toHaveBeenCalledOnce()
    expect(consoleSpy.mock.calls[0][0]).toContain('Impact analysis failed')
    consoleSpy.mockRestore()
  })

  it('handles empty parent decisions gracefully', async () => {
    const options = makeBaseOptions({ parentDecisions: [], supersededDecisions: [] })
    const doc = await generateDeltaDocument(options)

    // All amendment decisions are "new" since parent has none
    expect(doc.newDecisions).toHaveLength(options.amendmentDecisions.length)
  })

  it('handles empty amendment decisions gracefully', async () => {
    const options = makeBaseOptions({ amendmentDecisions: [], supersededDecisions: [] })
    const doc = await generateDeltaDocument(options)

    expect(doc.newDecisions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// generateDeltaDocument() — idempotency (AC8)
// ---------------------------------------------------------------------------

describe('generateDeltaDocument() — idempotency', () => {
  it('produces structurally equivalent output on repeated calls with same options', async () => {
    const mockDispatch = vi.fn().mockResolvedValue(JSON.stringify(mockImpactFindings))
    const options = makeBaseOptions({ runImpactAnalysis: true })

    const doc1 = await generateDeltaDocument(options, mockDispatch)
    const doc2 = await generateDeltaDocument(options, mockDispatch)

    // Timestamps may differ
    expect(doc1.amendmentRunId).toBe(doc2.amendmentRunId)
    expect(doc1.parentRunId).toBe(doc2.parentRunId)
    expect(doc1.executiveSummary.text).toBe(doc2.executiveSummary.text)
    expect(doc1.newDecisions.map((d) => d.id)).toEqual(doc2.newDecisions.map((d) => d.id))
    expect(doc1.supersededDecisions.map((d) => d.id)).toEqual(
      doc2.supersededDecisions.map((d) => d.id),
    )
    expect(doc1.newStories).toEqual(doc2.newStories)
    expect(doc1.impactAnalysis).toEqual(doc2.impactAnalysis)
    expect(doc1.recommendations).toEqual(doc2.recommendations)
  })
})

// ---------------------------------------------------------------------------
// validateDeltaDocument()
// ---------------------------------------------------------------------------

describe('validateDeltaDocument()', () => {
  async function makeSampleDoc(overrides: Partial<DeltaDocument> = {}): Promise<DeltaDocument> {
    const base = await generateDeltaDocument(makeBaseOptions())
    return { ...base, ...overrides }
  }

  it('returns valid: true for a well-formed document', async () => {
    const doc = await makeSampleDoc()
    const result = validateDeltaDocument(doc)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('returns valid: false when executiveSummary is missing', async () => {
    const doc = await makeSampleDoc({ executiveSummary: undefined as unknown as typeof doc['executiveSummary'] })
    const result = validateDeltaDocument(doc)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'Executive summary is required and must be at least 20 words (NFR-3)',
    )
  })

  it('returns valid: false when executiveSummary text is empty', async () => {
    const doc = await makeSampleDoc({ executiveSummary: { text: '', wordCount: 0 } })
    const result = validateDeltaDocument(doc)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'Executive summary is required and must be at least 20 words (NFR-3)',
    )
  })

  it('returns valid: false when executiveSummary wordCount is < 20', async () => {
    const doc = await makeSampleDoc({
      executiveSummary: { text: 'This is too short.', wordCount: 4 },
    })
    const result = validateDeltaDocument(doc)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'Executive summary is required and must be at least 20 words (NFR-3)',
    )
  })

  it('returns valid: false when wordCount is exactly 19', async () => {
    const words = Array.from({ length: 19 }, (_, i) => `word${i}`).join(' ')
    const doc = await makeSampleDoc({ executiveSummary: { text: words, wordCount: 19 } })
    const result = validateDeltaDocument(doc)

    expect(result.valid).toBe(false)
  })

  it('returns valid: true when wordCount is exactly 20', async () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
    const doc = await makeSampleDoc({ executiveSummary: { text: words, wordCount: 20 } })
    const result = validateDeltaDocument(doc)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('never throws; errors are captured in the array', () => {
    // Pass null to simulate a completely invalid doc
    const badDoc = null as unknown as DeltaDocument
    expect(() => validateDeltaDocument(badDoc)).not.toThrow()
    const result = validateDeltaDocument(badDoc)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// formatDeltaDocument()
// ---------------------------------------------------------------------------

describe('formatDeltaDocument()', () => {
  let sampleDoc: DeltaDocument

  beforeEach(async () => {
    const mockDispatch = vi.fn().mockResolvedValue(JSON.stringify(mockImpactFindings))
    sampleDoc = await generateDeltaDocument(makeBaseOptions({ runImpactAnalysis: true }), mockDispatch)
  })

  it('starts with "# Amendment Delta Report"', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md.trimStart().startsWith('# Amendment Delta Report')).toBe(true)
  })

  it('includes level-2 heading for Executive Summary', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('## Executive Summary')
  })

  it('includes level-2 heading for New Decisions', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('## New Decisions')
  })

  it('includes level-2 heading for Superseded Decisions', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('## Superseded Decisions')
  })

  it('includes level-2 heading for New Stories', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('## New Stories')
  })

  it('includes level-2 heading for Impact Analysis', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('## Impact Analysis')
  })

  it('includes level-2 heading for Recommendations', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('## Recommendations')
  })

  it('includes amendment run ID in the header section', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('run-amendment-1')
  })

  it('includes parent run ID in the header section', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('run-parent-1')
  })

  it('renders new decisions as a table with pipe syntax', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('| Phase | Category | Key | Value | Rationale |')
  })

  it('renders superseded decisions as a table', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('| Phase | Category | Key | Original Value | Superseded By |')
  })

  it('renders story references as list items', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('- stories/12-9.md')
    expect(md).toContain('- EPIC-5-1')
  })

  it('renders HIGH/MEDIUM/LOW confidence headings when findings exist', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md).toContain('### HIGH Confidence')
    expect(md).toContain('### MEDIUM Confidence')
    expect(md).toContain('### LOW Confidence')
  })

  it('renders "No new stories" when newStories is empty', () => {
    const doc = { ...sampleDoc, newStories: [] }
    const md = formatDeltaDocument(doc)
    expect(md).toContain('No new stories were created in this amendment run.')
  })

  it('renders "No new decisions" when newDecisions is empty', () => {
    const doc = { ...sampleDoc, newDecisions: [] }
    const md = formatDeltaDocument(doc)
    expect(md).toContain('No new decisions were made in this amendment run.')
  })

  it('renders "No superseded decisions" when supersededDecisions is empty', () => {
    const doc = { ...sampleDoc, supersededDecisions: [] }
    const md = formatDeltaDocument(doc)
    expect(md).toContain('No parent decisions were superseded in this amendment run.')
  })

  it('renders "No impact analysis findings" when impactAnalysis is empty', () => {
    const doc = { ...sampleDoc, impactAnalysis: [] }
    const md = formatDeltaDocument(doc)
    expect(md).toContain('No impact analysis findings available.')
  })

  it('returns a non-empty string', () => {
    const md = formatDeltaDocument(sampleDoc)
    expect(md.length).toBeGreaterThan(100)
  })
})

// ---------------------------------------------------------------------------
// buildImpactAnalysisPrompt()
// ---------------------------------------------------------------------------

describe('buildImpactAnalysisPrompt()', () => {
  it('returns a non-empty string', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('includes ranking instructions for HIGH, MEDIUM, LOW', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain('HIGH')
    expect(prompt).toContain('MEDIUM')
    expect(prompt).toContain('LOW')
  })

  it('includes the superseded decision ID in the prompt', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain(supersededDecision.id)
  })

  it('includes the superseded decision value', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain('PostgreSQL')
  })

  it('includes the superseded decision rationale', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain('Required for ACID compliance')
  })

  it('includes the new decision ID in the prompt', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain(amendmentDecision1.id)
  })

  it('includes the new decision value', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain('MySQL')
  })

  it('includes the new decision rationale', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain('Cost reduction initiative')
  })

  it('instructs agent to return ImpactFinding[]', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [amendmentDecision1])
    expect(prompt).toContain('ImpactFinding')
  })

  it('handles empty superseded decisions', () => {
    const prompt = buildImpactAnalysisPrompt([], [amendmentDecision1])
    expect(prompt).toContain('(none)')
    expect(prompt).toContain(amendmentDecision1.id)
  })

  it('handles empty new decisions', () => {
    const prompt = buildImpactAnalysisPrompt([supersededDecision], [])
    expect(prompt).toContain(supersededDecision.id)
    expect(prompt).toContain('(none)')
  })

  it('includes all superseded decisions when multiple are provided', () => {
    const sup2 = makeDecision({ id: 'sup-2', key: 'cache', value: 'Memcached' })
    const prompt = buildImpactAnalysisPrompt([supersededDecision, sup2], [amendmentDecision1])
    expect(prompt).toContain(supersededDecision.id)
    expect(prompt).toContain(sup2.id)
    expect(prompt).toContain('Memcached')
  })

  it('includes all new decisions when multiple are provided', () => {
    const prompt = buildImpactAnalysisPrompt(
      [supersededDecision],
      [amendmentDecision1, amendmentDecision2],
    )
    expect(prompt).toContain(amendmentDecision1.id)
    expect(prompt).toContain(amendmentDecision2.id)
    expect(prompt).toContain('Prisma')
  })
})

// ---------------------------------------------------------------------------
// Exported types (AC7)
// ---------------------------------------------------------------------------

describe('Exported types', () => {
  it('can import ImpactFinding, ExecutiveSummary, DeltaDocumentOptions, DeltaDocument', async () => {
    // If types are not exported, this import would fail at compile time.
    // This test verifies runtime usability via type guards.
    const finding: ImpactFinding = {
      confidence: 'HIGH',
      area: 'Architecture',
      description: 'Test finding',
      relatedDecisionIds: ['d-1'],
    }
    expect(finding.confidence).toBe('HIGH')
  })

  it('generateDeltaDocument, validateDeltaDocument, formatDeltaDocument, buildImpactAnalysisPrompt are all functions', () => {
    expect(typeof generateDeltaDocument).toBe('function')
    expect(typeof validateDeltaDocument).toBe('function')
    expect(typeof formatDeltaDocument).toBe('function')
    expect(typeof buildImpactAnalysisPrompt).toBe('function')
  })
})

// Need to import beforeEach from vitest
import { beforeEach } from 'vitest'
