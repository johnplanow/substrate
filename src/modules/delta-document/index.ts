/**
 * Delta Document Generator Module
 *
 * Generates structured change documents for amendment pipeline runs.
 * Documents include: header, executive summary, new decisions, superseded
 * decisions, new stories, impact analysis, and recommendations.
 *
 * Usage:
 *   import { generateDeltaDocument, validateDeltaDocument, formatDeltaDocument, buildImpactAnalysisPrompt }
 *     from './modules/delta-document/index.js'
 *
 *   const doc = await generateDeltaDocument(options, dispatchFn)
 *   const { valid, errors } = validateDeltaDocument(doc)
 *   const markdown = formatDeltaDocument(doc)
 */

import type { Decision } from '../../persistence/schemas/decisions.js'

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

export interface ImpactFinding {
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  area: string           // e.g., 'Architecture', 'Data Model', 'API Surface'
  description: string
  relatedDecisionIds: string[]
}

export interface ExecutiveSummary {
  text: string           // Minimum 20 words (NFR-3)
  wordCount: number      // Computed, not user-supplied
}

export interface DeltaDocumentOptions {
  amendmentRunId: string
  parentRunId: string
  parentDecisions: Decision[]
  amendmentDecisions: Decision[]
  supersededDecisions: Decision[]
  newStories?: string[]          // Story file paths or keys
  framingConcept?: string        // Concept that motivated the amendment
  runImpactAnalysis?: boolean    // Default: true
}

export interface DeltaDocument {
  amendmentRunId: string
  parentRunId: string
  generatedAt: string           // ISO 8601
  executiveSummary: ExecutiveSummary
  newDecisions: Decision[]
  supersededDecisions: Decision[]
  newStories: string[]
  impactAnalysis: ImpactFinding[]
  recommendations: string[]
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the set of new decisions: decisions in the amendment run not present
 * in the parent run (matched by decision ID).
 */
function computeNewDecisions(
  parentDecisions: Decision[],
  amendmentDecisions: Decision[],
): Decision[] {
  const parentIds = new Set(parentDecisions.map((d) => d.id))
  return amendmentDecisions.filter((d) => !parentIds.has(d.id))
}

/**
 * Auto-generate the executive summary text from the delta data.
 * Always produces at least 20 words (NFR-3) given typical inputs.
 */
function buildExecutiveSummary(options: DeltaDocumentOptions): ExecutiveSummary {
  const text = [
    `This amendment run (${options.amendmentRunId}) extends run ${options.parentRunId}.`,
    `${options.amendmentDecisions.length} new decisions were made.`,
    `${options.supersededDecisions.length} parent decisions were superseded.`,
    options.framingConcept ? `Concept explored: ${options.framingConcept}.` : '',
    `Review the superseded decisions and impact analysis sections for full details.`,
  ]
    .filter(Boolean)
    .join(' ')

  return { text, wordCount: text.split(/\s+/).filter((w) => w.length > 0).length }
}

/**
 * Build recommendations from the delta data.
 */
function buildRecommendations(
  newDecisions: Decision[],
  supersededDecisions: Decision[],
  impactFindings: ImpactFinding[],
): string[] {
  const recommendations: string[] = []

  if (supersededDecisions.length > 0) {
    recommendations.push(
      `Review the ${supersededDecisions.length} superseded decision(s) to ensure downstream artifacts are updated.`,
    )
  }

  if (newDecisions.length > 0) {
    recommendations.push(
      `Validate the ${newDecisions.length} new decision(s) against existing constraints and requirements.`,
    )
  }

  const highConfidence = impactFindings.filter((f) => f.confidence === 'HIGH')
  if (highConfidence.length > 0) {
    recommendations.push(
      `Address ${highConfidence.length} HIGH confidence impact finding(s) before proceeding to the next pipeline phase.`,
    )
  }

  if (recommendations.length === 0) {
    recommendations.push('No immediate action required. Monitor for downstream impacts.')
  }

  return recommendations
}

/**
 * Parse impact findings from agent output string.
 * Expects JSON array of ImpactFinding objects. Returns [] on parse failure.
 */
function parseImpactFindings(agentOutput: string): ImpactFinding[] {
  try {
    // Try to extract a JSON array from the output
    const match = agentOutput.match(/\[[\s\S]*\]/)
    if (!match) return []

    const parsed = JSON.parse(match[0]) as unknown
    if (!Array.isArray(parsed)) return []

    return parsed.filter(
      (item): item is ImpactFinding =>
        typeof item === 'object' &&
        item !== null &&
        'confidence' in item &&
        ['HIGH', 'MEDIUM', 'LOW'].includes((item as Record<string, unknown>).confidence as string) &&
        'area' in item &&
        'description' in item &&
        'relatedDecisionIds' in item,
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Exported Functions
// ---------------------------------------------------------------------------

/**
 * Generate a structured delta document for an amendment run.
 *
 * Computes new decisions, formats the executive summary, optionally dispatches
 * an impact analysis agent, and assembles the full DeltaDocument.
 *
 * The `dispatch` parameter is injectable for testing. In production, callers
 * pass the real dispatcher function from the agent-dispatch module.
 *
 * If impact analysis dispatch fails or times out, impactAnalysis is set to []
 * and a warning is logged — the document is still returned successfully.
 */
export async function generateDeltaDocument(
  options: DeltaDocumentOptions,
  dispatch?: (prompt: string) => Promise<string>,
): Promise<DeltaDocument> {
  const newDecisions = computeNewDecisions(options.parentDecisions, options.amendmentDecisions)
  const executiveSummary = buildExecutiveSummary(options)

  let impactFindings: ImpactFinding[] = []

  if (options.runImpactAnalysis !== false && dispatch) {
    const prompt = buildImpactAnalysisPrompt(options.supersededDecisions, options.amendmentDecisions)
    try {
      const agentOutput = await dispatch(prompt)
      impactFindings = parseImpactFindings(agentOutput)
    } catch (err) {
      console.warn('Impact analysis failed; continuing without it:', err)
      impactFindings = []
    }
  }

  const recommendations = buildRecommendations(
    newDecisions,
    options.supersededDecisions,
    impactFindings,
  )

  const doc: DeltaDocument = {
    amendmentRunId: options.amendmentRunId,
    parentRunId: options.parentRunId,
    generatedAt: new Date().toISOString(),
    executiveSummary,
    newDecisions,
    supersededDecisions: options.supersededDecisions,
    newStories: options.newStories ?? [],
    impactAnalysis: impactFindings,
    recommendations,
  }

  return doc
}

/**
 * Validate a DeltaDocument.
 *
 * Returns { valid: true, errors: [] } if the document passes all checks.
 * Returns { valid: false, errors: [...] } with all validation failures listed.
 *
 * Never throws — all failures are captured in the errors array.
 */
export function validateDeltaDocument(doc: DeltaDocument): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  try {
    if (
      !doc.executiveSummary ||
      !doc.executiveSummary.text ||
      doc.executiveSummary.text.trim() === '' ||
      doc.executiveSummary.wordCount < 20
    ) {
      errors.push(
        'Executive summary is required and must be at least 20 words (NFR-3)',
      )
    }
  } catch {
    errors.push('Executive summary is required and must be at least 20 words (NFR-3)')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Format a DeltaDocument to a Markdown string.
 *
 * Produces a document with a level-1 heading and level-2 headings for each
 * section. Suitable for writing directly to a .md file.
 */
export function formatDeltaDocument(doc: DeltaDocument): string {
  const lines: string[] = []

  // Title
  lines.push('# Amendment Delta Report')
  lines.push('')

  // Header metadata
  lines.push(`**Amendment Run:** ${doc.amendmentRunId}`)
  lines.push(`**Parent Run:** ${doc.parentRunId}`)
  lines.push(`**Generated:** ${doc.generatedAt}`)
  lines.push('')

  // Executive Summary
  lines.push('## Executive Summary')
  lines.push('')
  lines.push(doc.executiveSummary.text)
  lines.push('')

  // New Decisions
  lines.push('## New Decisions')
  lines.push('')
  if (doc.newDecisions.length === 0) {
    lines.push('No new decisions were made in this amendment run.')
  } else {
    lines.push('| Phase | Category | Key | Value | Rationale |')
    lines.push('|-------|----------|-----|-------|-----------|')
    for (const d of doc.newDecisions) {
      const rationale = d.rationale ?? ''
      lines.push(`| ${d.phase} | ${d.category} | ${d.key} | ${d.value} | ${rationale} |`)
    }
  }
  lines.push('')

  // Superseded Decisions
  lines.push('## Superseded Decisions')
  lines.push('')
  if (doc.supersededDecisions.length === 0) {
    lines.push('No parent decisions were superseded in this amendment run.')
  } else {
    lines.push('| Phase | Category | Key | Original Value | Superseded By |')
    lines.push('|-------|----------|-----|----------------|---------------|')
    for (const d of doc.supersededDecisions) {
      const supersededBy = d.superseded_by ?? ''
      lines.push(`| ${d.phase} | ${d.category} | ${d.key} | ${d.value} | ${supersededBy} |`)
    }
  }
  lines.push('')

  // New Stories
  lines.push('## New Stories')
  lines.push('')
  if (doc.newStories.length === 0) {
    lines.push('No new stories were created in this amendment run.')
  } else {
    for (const story of doc.newStories) {
      lines.push(`- ${story}`)
    }
  }
  lines.push('')

  // Impact Analysis
  lines.push('## Impact Analysis')
  lines.push('')
  if (doc.impactAnalysis.length === 0) {
    lines.push('No impact analysis findings available.')
  } else {
    const byConfidence: Record<string, ImpactFinding[]> = { HIGH: [], MEDIUM: [], LOW: [] }
    for (const finding of doc.impactAnalysis) {
      byConfidence[finding.confidence].push(finding)
    }

    for (const level of ['HIGH', 'MEDIUM', 'LOW'] as const) {
      if (byConfidence[level].length > 0) {
        lines.push(`### ${level} Confidence`)
        for (const finding of byConfidence[level]) {
          const related =
            finding.relatedDecisionIds.length > 0
              ? ` (related: ${finding.relatedDecisionIds.join(', ')})`
              : ''
          lines.push(`- **${finding.area}:** ${finding.description}${related}`)
        }
        lines.push('')
      }
    }
  }

  // Recommendations
  lines.push('## Recommendations')
  lines.push('')
  for (const rec of doc.recommendations) {
    lines.push(`- ${rec}`)
  }
  lines.push('')

  return lines.join('\n')
}

/**
 * Build the prompt for the impact analysis agent.
 *
 * Instructs the agent to rank findings as HIGH, MEDIUM, or LOW confidence
 * and return structured ImpactFinding[] in its output.
 */
export function buildImpactAnalysisPrompt(
  superseded: Decision[],
  newDecisions: Decision[],
): string {
  const supersededSection =
    superseded.length === 0
      ? '(none)'
      : superseded
          .map((d) => {
            const rationale = d.rationale ? `\n    Rationale: ${d.rationale}` : ''
            return `  - ID: ${d.id}\n    ${d.category}/${d.key}: ${d.value}${rationale}`
          })
          .join('\n')

  const newSection =
    newDecisions.length === 0
      ? '(none)'
      : newDecisions
          .map((d) => {
            const rationale = d.rationale ? `\n    Rationale: ${d.rationale}` : ''
            return `  - ID: ${d.id}\n    ${d.category}/${d.key}: ${d.value}${rationale}`
          })
          .join('\n')

  return `You are an impact analysis agent for a product decision amendment pipeline.

Analyze the following superseded and new decisions from an amendment run and identify
potential impacts on the system architecture, data model, API surface, and other areas.

## Superseded Decisions

These decisions from the parent run have been superseded by the amendment:

${supersededSection}

## New Decisions

These new decisions were made in the amendment run:

${newSection}

## Instructions

For each impact you identify, classify your confidence as:
- HIGH: Direct, certain impact with clear causality
- MEDIUM: Likely impact requiring further investigation
- LOW: Possible impact, may depend on implementation details

Return your findings as a JSON array of ImpactFinding objects. Each object must have:
- confidence: "HIGH" | "MEDIUM" | "LOW"
- area: string (e.g., "Architecture", "Data Model", "API Surface", "Security", "Performance")
- description: string (human-readable description of the impact)
- relatedDecisionIds: string[] (IDs of the decisions that drive this finding)

Example output format:
[
  {
    "confidence": "HIGH",
    "area": "Data Model",
    "description": "Changing the user ID type from integer to UUID requires a full database migration.",
    "relatedDecisionIds": ["<decision-id>"]
  }
]

Analyze thoroughly and return ONLY the JSON array with no additional text.`
}
