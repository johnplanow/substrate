/**
 * Elicitation Method Selector.
 *
 * Provides context-aware selection of elicitation methods for automated
 * elicitation rounds in the compiled pipeline.
 *
 * Selection algorithm:
 *  1. Load the 50-method registry from packs/bmad/data/elicitation-methods.csv
 *  2. Score each method by category affinity for the content type
 *  3. Apply a recency penalty for methods already used in this run
 *  4. Pick the top 1-2 methods by score
 *
 * This enables diverse, context-appropriate elicitation across pipeline phases
 * without requiring human interaction.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('elicitation-selector')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single elicitation method from the BMAD library.
 */
export interface ElicitationMethod {
  /** Method name (e.g., "First Principles Analysis") */
  name: string
  /** Category (e.g., "core", "risk", "technical") */
  category: string
  /** Full description of what the method does */
  description: string
  /** Output pattern describing the flow of the method (e.g., "assumptions → truths → new approach") */
  output_pattern: string
}

/**
 * Context for elicitation method selection.
 */
export interface ElicitationContext {
  /**
   * Type of content being elicited on:
   * - 'brief'        → Analysis phase (product brief)
   * - 'prd'          → Planning phase (PRD/requirements)
   * - 'architecture' → Solutioning phase (architecture decisions)
   * - 'stories'      → Solutioning phase (epics/stories)
   */
  content_type: 'brief' | 'prd' | 'architecture' | 'stories'
  /** Optional domain keywords to influence selection */
  domain_keywords?: string[]
  /** Complexity score 0.0–1.0 (boosts technical/advanced methods when high) */
  complexity_score?: number
  /** Risk level (boosts risk methods when high) */
  risk_level?: 'low' | 'medium' | 'high'
}

// ---------------------------------------------------------------------------
// Category affinity matrix
// ---------------------------------------------------------------------------

/**
 * Affinity scores (0.0–1.0) for each category per content type.
 *
 * Higher score → more likely to be selected for that content type.
 * Based on the method-to-phase affinity matrix from the Dev Notes.
 */
const CATEGORY_AFFINITY: Record<string, Record<string, number>> = {
  brief: {
    core: 1.0,
    collaboration: 0.9,
    creative: 0.8,
    research: 0.5,
    risk: 0.4,
    advanced: 0.3,
    technical: 0.2,
    competitive: 0.2,
    learning: 0.1,
    philosophical: 0.1,
    retrospective: 0.1,
  },
  prd: {
    risk: 1.0,
    core: 0.9,
    research: 0.8,
    collaboration: 0.6,
    creative: 0.4,
    advanced: 0.3,
    technical: 0.2,
    competitive: 0.2,
    learning: 0.1,
    philosophical: 0.1,
    retrospective: 0.1,
  },
  architecture: {
    technical: 1.0,
    competitive: 0.9,
    risk: 0.8,
    core: 0.5,
    advanced: 0.5,
    research: 0.4,
    collaboration: 0.3,
    creative: 0.2,
    learning: 0.1,
    philosophical: 0.1,
    retrospective: 0.1,
  },
  stories: {
    collaboration: 1.0,
    risk: 0.9,
    core: 0.5,
    research: 0.4,
    creative: 0.3,
    technical: 0.3,
    advanced: 0.2,
    competitive: 0.2,
    learning: 0.1,
    philosophical: 0.1,
    retrospective: 0.1,
  },
}

// Recency penalty factor applied when a method has already been used
const RECENCY_PENALTY_FACTOR = 0.2

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string (with header) into an array of ElicitationMethod objects.
 *
 * Expected CSV format (columns): num,category,method_name,description,output_pattern
 *
 * @param csvContent - Raw CSV file content including header row
 * @returns Array of parsed elicitation methods
 */
export function parseMethodsCsv(csvContent: string): ElicitationMethod[] {
  const lines = csvContent.trim().split('\n')
  if (lines.length < 2) return []

  const methods: ElicitationMethod[] = []

  // Skip header (index 0), iterate data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    // Format: num,category,method_name,description,output_pattern
    // Use positional comma detection to handle commas within description/output_pattern:
    // - Split after 3rd comma from left (gives: num, category, method_name | rest)
    // - Split at last comma (gives: description | output_pattern)
    const firstComma = line.indexOf(',')
    const secondComma = line.indexOf(',', firstComma + 1)
    const thirdComma = line.indexOf(',', secondComma + 1)
    const lastComma = line.lastIndexOf(',')

    if (firstComma < 0 || secondComma < 0 || thirdComma < 0 || lastComma <= thirdComma) continue

    const category = line.slice(firstComma + 1, secondComma)
    const name = line.slice(secondComma + 1, thirdComma)
    const description = line.slice(thirdComma + 1, lastComma)
    const output_pattern = line.slice(lastComma + 1)

    if (!category || !name || !description || !output_pattern) continue

    methods.push({ name, category, description, output_pattern })
  }

  return methods
}

// ---------------------------------------------------------------------------
// Method loading
// ---------------------------------------------------------------------------

/**
 * Load elicitation methods from the pack data directory.
 *
 * Reads from packs/bmad/data/elicitation-methods.csv relative to process.cwd().
 * Returns an empty array if the file cannot be read.
 *
 * @returns Array of all available elicitation methods
 */
export function loadElicitationMethods(): ElicitationMethod[] {
  const csvPath = join(process.cwd(), 'packs', 'bmad', 'data', 'elicitation-methods.csv')
  try {
    const content = readFileSync(csvPath, 'utf-8')
    const methods = parseMethodsCsv(content)
    logger.debug({ count: methods.length }, 'Loaded elicitation methods')
    return methods
  } catch (err) {
    logger.warn({ csvPath, err }, 'Failed to load elicitation methods CSV')
    return []
  }
}

// ---------------------------------------------------------------------------
// Method selection
// ---------------------------------------------------------------------------

/**
 * Select 1–2 elicitation methods appropriate for the given context.
 *
 * Selection algorithm:
 *  1. Score each method: categoryAffinity × recencyFactor × riskBoost × complexityBoost
 *  2. Sort descending by score
 *  3. Return top 1–2 methods (always at least 1 if methods are available)
 *
 * Methods used in previous rounds (listed in `usedMethods`) are deprioritized
 * via `RECENCY_PENALTY_FACTOR` to encourage category rotation.
 *
 * @param context      - Elicitation context describing the artifact and domain
 * @param usedMethods  - Names of methods already used in this pipeline run
 * @param methods      - Optional pre-loaded method list (defaults to loadElicitationMethods())
 * @returns Array of 0–2 selected ElicitationMethod objects
 */
export function selectMethods(
  context: ElicitationContext,
  usedMethods: string[],
  methods?: ElicitationMethod[],
): ElicitationMethod[] {
  const allMethods = methods ?? loadElicitationMethods()
  if (allMethods.length === 0) return []

  const affinity = CATEGORY_AFFINITY[context.content_type] ?? {}
  const usedSet = new Set(usedMethods)
  const complexityScore = context.complexity_score ?? 0.5
  const riskLevel = context.risk_level ?? 'medium'

  // Score each method
  const scored = allMethods.map((method) => {
    // Base score from category affinity (defaults to 0.3 for unknown categories)
    const categoryScore = affinity[method.category] ?? 0.3

    // Recency penalty: methods used before get a heavy score reduction
    const recencyFactor = usedSet.has(method.name) ? RECENCY_PENALTY_FACTOR : 1.0

    // Risk boost: risk category gets a 30% bonus when risk_level is high
    const riskBoost = riskLevel === 'high' && method.category === 'risk' ? 1.3 : 1.0

    // Complexity boost: technical and advanced categories get a 20% bonus
    // when complexity_score > 0.7
    const complexityBoost =
      complexityScore > 0.7 &&
      (method.category === 'technical' || method.category === 'advanced')
        ? 1.2
        : 1.0

    const score = categoryScore * recencyFactor * riskBoost * complexityBoost

    return { method, score }
  })

  // Sort descending by score, then alphabetically by name for determinism on ties
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.method.name.localeCompare(b.method.name)
  })

  // Return top 2 (or 1 if only 1 available)
  return scored.slice(0, 2).map((s) => s.method)
}

// ---------------------------------------------------------------------------
// Content type derivation
// ---------------------------------------------------------------------------

/**
 * Derive an ElicitationContext content_type from a phase name and step name.
 *
 * Mapping:
 *  - analysis phase          → 'brief'
 *  - planning phase          → 'prd'
 *  - solutioning + arch step → 'architecture'
 *  - solutioning + story/epic step → 'stories'
 *  - default                 → 'brief'
 *
 * @param phase    - Pipeline phase name
 * @param stepName - Step name within the phase
 * @returns Content type for method selection
 */
export function deriveContentType(
  phase: string,
  stepName: string,
): ElicitationContext['content_type'] {
  if (phase === 'analysis') return 'brief'
  if (phase === 'planning') return 'prd'
  if (phase === 'solutioning') {
    if (stepName.includes('arch')) return 'architecture'
    if (stepName.includes('stor') || stepName.includes('epic')) return 'stories'
  }
  return 'brief'
}
