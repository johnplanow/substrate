/**
 * Export renderers — format decision store contents into human-readable markdown files.
 *
 * These are pure functions that accept pre-fetched decision arrays and return
 * markdown strings suitable for writing to disk. Used by the `substrate export` command.
 *
 * These are related to but distinct from the prompt-injection formatters in
 * phase-orchestrator/phases/planning.ts and solutioning.ts, which are designed
 * for token-budget-aware prompt injection, not for human-readable file export.
 */

import type { Decision, Requirement } from '../../persistence/queries/decisions.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fields from analysis/product-brief decisions to render, in display order */
const PRODUCT_BRIEF_FIELDS = [
  'problem_statement',
  'target_users',
  'core_features',
  'success_metrics',
  'constraints',
  'technology_constraints',
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Known acronyms that should appear fully uppercased when they are a standalone
 * word in a label (e.g. 'fr_coverage' → 'FR Coverage', 'api_style' → 'API Style').
 */
const UPPERCASE_ACRONYMS = new Set(['fr', 'nfr', 'ux', 'api', 'db', 'id', 'url'])

/**
 * Convert a snake_case key to Title Case for display headings.
 * Known acronyms (fr, nfr, ux, api, db, id, url) are rendered fully uppercased.
 */
export function fieldLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w+/g, (word) => {
    const lower = word.toLowerCase()
    if (UPPERCASE_ACRONYMS.has(lower)) return lower.toUpperCase()
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  })
}

/**
 * Safely parse a JSON string; returns the original string if parsing fails.
 */
export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Render a decision value to a markdown-friendly string.
 * - Arrays → bulleted list items
 * - Objects → key: value lines
 * - Primitives → plain string
 */
export function renderValue(rawValue: string): string {
  const parsed = safeParseJson(rawValue)
  if (Array.isArray(parsed)) {
    return parsed.map((item: unknown) => `- ${String(item)}`).join('\n')
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return Object.entries(parsed as Record<string, unknown>)
      .map(([k, v]) => `- **${fieldLabel(k)}**: ${String(v)}`)
      .join('\n')
  }
  return String(parsed)
}

// ---------------------------------------------------------------------------
// Product Brief Renderer (AC2)
// ---------------------------------------------------------------------------

/**
 * Render analysis-phase decisions as a `product-brief.md` file.
 *
 * Merges `product-brief` category decisions with `technology-constraints`
 * category decisions (they are stored separately in the decision store).
 *
 * @param decisions - All decisions from the analysis phase (any category)
 * @returns Formatted markdown content for product-brief.md
 */
export function renderProductBrief(decisions: Decision[]): string {
  const briefDecisions = decisions.filter((d) => d.category === 'product-brief')
  const techConstraintDecisions = decisions.filter((d) => d.category === 'technology-constraints')

  // Build lookup map from product-brief decisions
  const briefMap = Object.fromEntries(briefDecisions.map((d) => [d.key, d.value]))

  // Technology constraints are stored in a separate category — merge them in
  // if not already present in the product-brief map.
  if (techConstraintDecisions.length > 0 && briefMap['technology_constraints'] === undefined) {
    // Combine all tech constraint values into a single bulleted list value
    const tcBullets = techConstraintDecisions.flatMap((d) => {
      // Each constraint decision value may itself be a string or JSON array
      const parsed = safeParseJson(d.value)
      if (Array.isArray(parsed)) {
        return parsed.map((item: unknown) => String(item))
      }
      return [String(parsed)]
    })
    // Store as JSON array so renderValue() formats it as a bulleted list
    briefMap['technology_constraints'] = JSON.stringify(tcBullets)
  }

  if (briefDecisions.length === 0 && techConstraintDecisions.length === 0) {
    return ''
  }

  const parts: string[] = ['# Product Brief', '']

  for (const field of PRODUCT_BRIEF_FIELDS) {
    const rawValue = briefMap[field]
    if (rawValue === undefined) continue

    parts.push(`## ${fieldLabel(field)}`)
    parts.push('')
    parts.push(renderValue(rawValue))
    parts.push('')
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// PRD Renderer (AC3)
// ---------------------------------------------------------------------------

/**
 * Render planning-phase decisions (and requirements table) as a `prd.md` file.
 *
 * Sections rendered (when data is present):
 * - Project Classification (classification decisions)
 * - Functional Requirements (functional-requirements decisions)
 * - Non-Functional Requirements (non-functional-requirements decisions)
 * - Domain Model (domain-model decisions)
 * - User Stories (user-stories decisions)
 * - Tech Stack (tech-stack decisions)
 * - Out of Scope (out-of-scope decisions)
 *
 * @param decisions - All decisions from the planning phase
 * @param requirements - Requirements records from the requirements table (optional)
 * @returns Formatted markdown content for prd.md
 */
export function renderPrd(decisions: Decision[], requirements: Requirement[] = []): string {
  if (decisions.length === 0) {
    return ''
  }

  const parts: string[] = ['# Product Requirements Document', '']

  // -------------------------------------------------------------------------
  // Project Classification
  // -------------------------------------------------------------------------
  const classificationDecisions = decisions.filter((d) => d.category === 'classification')
  if (classificationDecisions.length > 0) {
    parts.push('## Project Classification')
    parts.push('')
    for (const d of classificationDecisions) {
      const parsed = safeParseJson(d.value)
      if (Array.isArray(parsed)) {
        parts.push(`**${fieldLabel(d.key)}**:`)
        for (const item of parsed) {
          parts.push(`- ${String(item)}`)
        }
      } else {
        parts.push(`**${fieldLabel(d.key)}**: ${String(parsed)}`)
      }
    }
    parts.push('')
  }

  // -------------------------------------------------------------------------
  // Functional Requirements
  // -------------------------------------------------------------------------
  const frDecisions = decisions.filter((d) => d.category === 'functional-requirements')
  if (frDecisions.length > 0) {
    parts.push('## Functional Requirements')
    parts.push('')
    for (const d of frDecisions) {
      const parsed = safeParseJson(d.value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const fr = parsed as {
          id?: string
          description?: string
          priority?: string
          acceptance_criteria?: string[]
        }
        const id = fr.id ?? d.key
        const priority = fr.priority ? ` [${fr.priority.toUpperCase()}]` : ''
        parts.push(`- **${id}**${priority}: ${fr.description ?? d.value}`)
        if (fr.acceptance_criteria && fr.acceptance_criteria.length > 0) {
          for (const ac of fr.acceptance_criteria) {
            parts.push(`  - ${ac}`)
          }
        }
      } else {
        parts.push(`- **${d.key}**: ${renderValue(d.value)}`)
      }
    }
    parts.push('')
  }

  // -------------------------------------------------------------------------
  // Non-Functional Requirements
  // -------------------------------------------------------------------------
  const nfrDecisions = decisions.filter((d) => d.category === 'non-functional-requirements')
  if (nfrDecisions.length > 0) {
    parts.push('## Non-Functional Requirements')
    parts.push('')
    for (const d of nfrDecisions) {
      const parsed = safeParseJson(d.value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const nfr = parsed as {
          id?: string
          description?: string
          category?: string
          priority?: string
        }
        const id = nfr.id ?? d.key
        const cat = nfr.category ? ` [${nfr.category.toUpperCase()}]` : ''
        parts.push(`- **${id}**${cat}: ${nfr.description ?? d.value}`)
      } else {
        parts.push(`- **${d.key}**: ${renderValue(d.value)}`)
      }
    }
    parts.push('')
  }

  // -------------------------------------------------------------------------
  // Domain Model
  // -------------------------------------------------------------------------
  const domainDecisions = decisions.filter((d) => d.category === 'domain-model')
  if (domainDecisions.length > 0) {
    parts.push('## Domain Model')
    parts.push('')
    for (const d of domainDecisions) {
      parts.push(renderValue(d.value))
    }
    parts.push('')
  }

  // -------------------------------------------------------------------------
  // User Stories
  // -------------------------------------------------------------------------
  const userStoryDecisions = decisions.filter((d) => d.category === 'user-stories')
  if (userStoryDecisions.length > 0) {
    parts.push('## User Stories')
    parts.push('')
    for (const d of userStoryDecisions) {
      const parsed = safeParseJson(d.value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const us = parsed as { title?: string; description?: string }
        if (us.title) {
          parts.push(`### ${us.title}`)
          parts.push('')
          if (us.description) {
            parts.push(us.description)
            parts.push('')
          }
        } else {
          parts.push(renderValue(d.value))
          parts.push('')
        }
      } else {
        parts.push(renderValue(d.value))
        parts.push('')
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tech Stack
  // -------------------------------------------------------------------------
  const techStackDecisions = decisions.filter((d) => d.category === 'tech-stack')
  if (techStackDecisions.length > 0) {
    parts.push('## Tech Stack')
    parts.push('')
    for (const d of techStackDecisions) {
      if (d.key === 'tech_stack') {
        // Multi-step planning stores a JSON object under key='tech_stack'
        const parsed = safeParseJson(d.value)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            parts.push(`- **${fieldLabel(k)}**: ${String(v)}`)
          }
        } else {
          parts.push(`- **${fieldLabel(d.key)}**: ${d.value}`)
        }
      } else {
        // Single-dispatch planning stores one key per tech stack component
        parts.push(`- **${fieldLabel(d.key)}**: ${d.value}`)
      }
    }
    parts.push('')
  }

  // -------------------------------------------------------------------------
  // Out of Scope
  // -------------------------------------------------------------------------
  const outOfScopeDecisions = decisions.filter((d) => d.category === 'out-of-scope')
  if (outOfScopeDecisions.length > 0) {
    parts.push('## Out of Scope')
    parts.push('')
    for (const d of outOfScopeDecisions) {
      parts.push(renderValue(d.value))
    }
    parts.push('')
  }

  // -------------------------------------------------------------------------
  // Requirements Table (from Requirement records)
  // -------------------------------------------------------------------------
  // Include functional/non_functional requirements from the requirements table
  // if they're not already shown in the decisions above
  const functionalReqs = requirements.filter((r) => r.type === 'functional')
  const nonFunctionalReqs = requirements.filter((r) => r.type === 'non_functional')

  if (
    (functionalReqs.length > 0 || nonFunctionalReqs.length > 0) &&
    frDecisions.length === 0 &&
    nfrDecisions.length === 0
  ) {
    parts.push('## Requirements (from Requirements Table)')
    parts.push('')

    if (functionalReqs.length > 0) {
      parts.push('### Functional Requirements')
      parts.push('')
      for (const r of functionalReqs) {
        const priority = r.priority ? ` [${r.priority.toUpperCase()}]` : ''
        parts.push(`- ${r.source ?? ''}${priority}: ${r.description}`)
      }
      parts.push('')
    }

    if (nonFunctionalReqs.length > 0) {
      parts.push('### Non-Functional Requirements')
      parts.push('')
      for (const r of nonFunctionalReqs) {
        const priority = r.priority ? ` [${r.priority.toUpperCase()}]` : ''
        parts.push(`- ${priority}: ${r.description}`)
      }
      parts.push('')
    }
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Architecture Renderer (AC4, T6)
// ---------------------------------------------------------------------------

/**
 * Render solutioning-phase architecture decisions as an `architecture.md` file.
 *
 * Groups all architecture decisions into a single `## Architecture Decisions`
 * section, formatting each as `**key**: value` with italicised rationale where
 * present.  The heading pattern matches the regex used by `seedMethodologyContext()`
 * so that the exported file can be round-tripped back into the decision store.
 *
 * @param decisions - All decisions from the solutioning phase (any category)
 * @returns Formatted markdown content for architecture.md, or '' if no data
 */
export function renderArchitecture(decisions: Decision[]): string {
  const archDecisions = decisions.filter((d) => d.category === 'architecture')

  if (archDecisions.length === 0) {
    return ''
  }

  const parts: string[] = ['# Architecture', '']

  parts.push('## Architecture Decisions')
  parts.push('')

  for (const d of archDecisions) {
    const value = safeParseJson(d.value)
    let displayValue: string
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // JSON object — render each sub-field on its own line, indented
      displayValue = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `  - *${fieldLabel(k)}*: ${String(v)}`)
        .join('\n')
      parts.push(`**${d.key}**:`)
      parts.push(displayValue)
    } else if (Array.isArray(value)) {
      displayValue = value.map((item: unknown) => `  - ${String(item)}`).join('\n')
      parts.push(`**${d.key}**:`)
      parts.push(displayValue)
    } else {
      displayValue = String(value)
      if (d.rationale) {
        parts.push(`**${d.key}**: ${displayValue} *(${d.rationale})*`)
      } else {
        parts.push(`**${d.key}**: ${displayValue}`)
      }
    }
  }

  parts.push('')
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Epics Renderer (AC5, T7)
// ---------------------------------------------------------------------------

/**
 * Render solutioning-phase epics and stories decisions as an `epics.md` file.
 *
 * Output format:
 * ```
 * ## Epic 1: Title
 * Description
 *
 * ### Story 1-1: Title
 * **Priority**: must
 * **Description**: ...
 * **Acceptance Criteria**:
 * - AC1
 * - AC2
 * ```
 *
 * The `## Epic N:` heading pattern is parsed by `parseEpicShards()` in
 * `seed-methodology-context.ts`, satisfying the round-trip contract (AC5).
 *
 * Stories are associated with their parent epic by the numeric prefix of the
 * story key (e.g., story key `2-3` → epic 2).
 *
 * @param decisions - All decisions from the solutioning phase (any category)
 * @returns Formatted markdown content for epics.md, or '' if no data
 */
export function renderEpics(decisions: Decision[]): string {
  const epicDecisions = decisions.filter((d) => d.category === 'epics')
  const storyDecisions = decisions.filter((d) => d.category === 'stories')

  if (epicDecisions.length === 0 && storyDecisions.length === 0) {
    return ''
  }

  // Build a map from epic number (1-based) to epic info
  interface EpicInfo {
    num: number
    title: string
    description: string
  }
  const epicMap = new Map<number, EpicInfo>()

  for (const d of epicDecisions) {
    // key format: 'epic-1', 'epic-2', …
    const match = /^epic-(\d+)$/i.exec(d.key)
    if (match === null) continue
    const epicNum = parseInt(match[1]!, 10)
    const parsed = safeParseJson(d.value)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const p = parsed as { title?: string; description?: string }
      epicMap.set(epicNum, {
        num: epicNum,
        title: p.title ?? `Epic ${epicNum}`,
        description: p.description ?? '',
      })
    } else {
      epicMap.set(epicNum, { num: epicNum, title: String(parsed), description: '' })
    }
  }

  // Build a map from epic number to sorted stories
  interface StoryInfo {
    key: string
    epicNum: number
    storyNum: number
    title: string
    description: string
    ac: string[]
    priority: string
  }
  const storyMap = new Map<number, StoryInfo[]>()

  for (const d of storyDecisions) {
    const parsed = safeParseJson(d.value)
    let story: StoryInfo

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const p = parsed as {
        key?: string
        title?: string
        description?: string
        ac?: string[]
        acceptance_criteria?: string[]
        priority?: string
      }
      const storyKey = p.key ?? d.key
      // Determine parent epic number from story key prefix (e.g., '1-2' → epic 1)
      const keyMatch = /^(\d+)-(\d+)/.exec(storyKey)
      // Skip stories with malformed keys (no valid epic-story prefix) to avoid spurious 'Epic 0'
      if (keyMatch === null) continue
      const epicNum = parseInt(keyMatch[1]!, 10)
      const storyNum = parseInt(keyMatch[2]!, 10)
      story = {
        key: storyKey,
        epicNum,
        storyNum,
        title: p.title ?? `Story ${storyKey}`,
        description: p.description ?? '',
        ac: p.acceptance_criteria ?? p.ac ?? [],
        priority: p.priority ?? 'must',
      }
    } else {
      const storyKey = d.key
      const keyMatch = /^(\d+)-(\d+)/.exec(storyKey)
      // Skip stories with malformed keys (no valid epic-story prefix) to avoid spurious 'Epic 0'
      if (keyMatch === null) continue
      const epicNum = parseInt(keyMatch[1]!, 10)
      const storyNum = parseInt(keyMatch[2]!, 10)
      story = {
        key: storyKey,
        epicNum,
        storyNum,
        title: `Story ${storyKey}`,
        description: String(parsed),
        ac: [],
        priority: 'must',
      }
    }

    if (!storyMap.has(story.epicNum)) {
      storyMap.set(story.epicNum, [])
    }
    storyMap.get(story.epicNum)!.push(story)
  }

  // Sort stories within each epic by story number
  for (const stories of storyMap.values()) {
    stories.sort((a, b) => a.storyNum - b.storyNum)
  }

  // Determine the full set of epic numbers (from both epics and stories)
  const allEpicNums = new Set<number>([...epicMap.keys(), ...storyMap.keys()])
  const sortedEpicNums = [...allEpicNums].sort((a, b) => a - b)

  const parts: string[] = ['# Epics and Stories', '']

  for (const epicNum of sortedEpicNums) {
    const epic = epicMap.get(epicNum)
    const epicTitle = epic?.title ?? `Epic ${epicNum}`
    const epicDescription = epic?.description ?? ''

    parts.push(`## Epic ${epicNum}: ${epicTitle}`)
    parts.push('')
    if (epicDescription) {
      parts.push(epicDescription)
      parts.push('')
    }

    const stories = storyMap.get(epicNum) ?? []
    for (const story of stories) {
      parts.push(`### Story ${story.key}: ${story.title}`)
      parts.push('')
      parts.push(`**Priority**: ${story.priority}`)
      if (story.description) {
        parts.push(`**Description**: ${story.description}`)
      }
      if (story.ac.length > 0) {
        parts.push('**Acceptance Criteria**:')
        for (const ac of story.ac) {
          parts.push(`- ${ac}`)
        }
      }
      parts.push('')
    }
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Operational Findings Renderer (Story 21-1 AC5)
// ---------------------------------------------------------------------------

/**
 * Render `operational-finding` category decisions as an "Operational Findings" section.
 *
 * Groups findings by run key (for run-summary decisions) and stall key (for stall decisions).
 * Returns '' if no matching decisions are found.
 *
 * @param decisions - Decisions of any category; filters for 'operational-finding'
 * @returns Formatted markdown content, or '' if empty
 */
export function renderOperationalFindings(decisions: Decision[]): string {
  const findings = decisions.filter((d) => d.category === 'operational-finding')
  if (findings.length === 0) return ''

  const parts: string[] = ['## Operational Findings', '']

  // Separate run summaries from stall findings
  const runSummaries = findings.filter((d) => d.key.startsWith('run-summary:'))
  const stallFindings = findings.filter((d) => d.key.startsWith('stall:'))
  const otherFindings = findings.filter(
    (d) => !d.key.startsWith('run-summary:') && !d.key.startsWith('stall:')
  )

  if (runSummaries.length > 0) {
    parts.push('### Run Summaries')
    parts.push('')
    for (const d of runSummaries) {
      const runId = d.key.replace('run-summary:', '')
      const parsed = safeParseJson(d.value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const s = parsed as {
          succeeded?: string[]
          failed?: string[]
          escalated?: string[]
          total_restarts?: number
          elapsed_seconds?: number
          total_input_tokens?: number
          total_output_tokens?: number
        }
        parts.push(`**Run: ${runId}**`)
        parts.push(`- Succeeded: ${(s.succeeded ?? []).join(', ') || 'none'}`)
        parts.push(`- Failed: ${(s.failed ?? []).join(', ') || 'none'}`)
        parts.push(`- Escalated: ${(s.escalated ?? []).join(', ') || 'none'}`)
        parts.push(`- Total restarts: ${s.total_restarts ?? 0}`)
        parts.push(`- Elapsed: ${s.elapsed_seconds ?? 0}s`)
        parts.push(`- Tokens: ${s.total_input_tokens ?? 0} in / ${s.total_output_tokens ?? 0} out`)
      } else {
        parts.push(`**Run: ${runId}**: ${String(parsed)}`)
      }
      parts.push('')
    }
  }

  if (stallFindings.length > 0) {
    parts.push('### Stall Events')
    parts.push('')
    for (const d of stallFindings) {
      const parsed = safeParseJson(d.value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const s = parsed as {
          phase?: string
          staleness_secs?: number
          attempt?: number
          outcome?: string
        }
        const outcome = s.outcome ?? 'unknown'
        parts.push(
          `- **${d.key}**: phase=${s.phase ?? '?'} staleness=${s.staleness_secs ?? 0}s attempt=${s.attempt ?? 0} outcome=${outcome}`
        )
      } else {
        parts.push(`- **${d.key}**: ${String(parsed)}`)
      }
    }
    parts.push('')
  }

  if (otherFindings.length > 0) {
    for (const d of otherFindings) {
      parts.push(`- **${d.key}**: ${renderValue(d.value)}`)
    }
    parts.push('')
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Experiments Renderer (Story 21-1 AC5)
// ---------------------------------------------------------------------------

/**
 * Render `experiment-result` category decisions as an "Experiments" section.
 *
 * Lists each experiment with its verdict, metric delta, and branch name.
 * Returns '' if no matching decisions are found.
 *
 * @param decisions - Decisions of any category; filters for 'experiment-result'
 * @returns Formatted markdown content, or '' if empty
 */
export function renderExperiments(decisions: Decision[]): string {
  const experiments = decisions.filter((d) => d.category === 'experiment-result')
  if (experiments.length === 0) return ''

  const parts: string[] = ['## Experiments', '']

  const improved = experiments.filter((d) => {
    const p = safeParseJson(d.value)
    return (
      typeof p === 'object' &&
      p !== null &&
      (p as Record<string, unknown>)['verdict'] === 'IMPROVED'
    )
  })
  const mixed = experiments.filter((d) => {
    const p = safeParseJson(d.value)
    return (
      typeof p === 'object' && p !== null && (p as Record<string, unknown>)['verdict'] === 'MIXED'
    )
  })
  const regressed = experiments.filter((d) => {
    const p = safeParseJson(d.value)
    return (
      typeof p === 'object' &&
      p !== null &&
      (p as Record<string, unknown>)['verdict'] === 'REGRESSED'
    )
  })

  parts.push(
    `**Total**: ${experiments.length} | **Improved**: ${improved.length} | **Mixed**: ${mixed.length} | **Regressed**: ${regressed.length}`
  )
  parts.push('')

  for (const d of experiments) {
    const parsed = safeParseJson(d.value)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const e = parsed as {
        target_metric?: string
        before?: number
        after?: number
        verdict?: string
        branch_name?: string | null
      }
      const verdict = e.verdict ?? 'UNKNOWN'
      const metric = e.target_metric ?? 'unknown'
      const branch = e.branch_name ? ` → \`${e.branch_name}\`` : ''
      parts.push(
        `- **[${verdict}]** ${metric}: before=${e.before ?? '?'} after=${e.after ?? '?'}${branch}`
      )
    } else {
      parts.push(`- ${String(parsed)}`)
    }
  }
  parts.push('')

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Readiness Report Renderer (AC6, T8)
// ---------------------------------------------------------------------------

/**
 * Render solutioning-phase readiness-findings decisions as a `readiness-report.md`.
 *
 * Groups findings by category, shows severity per finding, and emits an
 * overall pass/fail verdict based on whether any blockers were found.
 *
 * @param decisions - All decisions from the solutioning phase (any category)
 * @returns Formatted markdown content for readiness-report.md, or '' if no data
 */
export function renderReadinessReport(decisions: Decision[]): string {
  const findingDecisions = decisions.filter((d) => d.category === 'readiness-findings')

  if (findingDecisions.length === 0) {
    return ''
  }

  interface FindingRecord {
    category: string
    severity: string
    description: string
    affected_items: string[]
  }

  const findings: FindingRecord[] = []
  for (const d of findingDecisions) {
    const parsed = safeParseJson(d.value)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const p = parsed as {
        category?: string
        severity?: string
        description?: string
        affected_items?: string[]
      }
      findings.push({
        category: p.category ?? 'general',
        severity: p.severity ?? 'minor',
        description: p.description ?? String(parsed),
        affected_items: p.affected_items ?? [],
      })
    } else {
      findings.push({
        category: 'general',
        severity: 'minor',
        description: String(parsed),
        affected_items: [],
      })
    }
  }

  // Determine overall verdict: FAIL if any blocker or major finding is present
  const hasCritical = findings.some((f) => f.severity === 'blocker' || f.severity === 'major')
  const verdict = hasCritical ? 'FAIL' : 'PASS'

  const parts: string[] = ['# Readiness Report', '']
  parts.push(`**Overall Verdict**: ${verdict}`)
  parts.push('')
  parts.push(`**Total Findings**: ${findings.length}`)
  parts.push(`**Blockers**: ${findings.filter((f) => f.severity === 'blocker').length}`)
  parts.push(`**Major**: ${findings.filter((f) => f.severity === 'major').length}`)
  parts.push(`**Minor**: ${findings.filter((f) => f.severity === 'minor').length}`)
  parts.push('')

  // Group findings by category
  const byCategory = new Map<string, FindingRecord[]>()
  for (const finding of findings) {
    if (!byCategory.has(finding.category)) {
      byCategory.set(finding.category, [])
    }
    byCategory.get(finding.category)!.push(finding)
  }

  // Render categories in a fixed priority order; within each category findings appear in insertion order
  const categoryOrder = [
    'fr_coverage',
    'architecture_compliance',
    'story_quality',
    'ux_alignment',
    'dependency_validity',
    'general',
  ]
  const sortedCategories = [...byCategory.keys()].sort((a, b) => {
    const ai = categoryOrder.indexOf(a)
    const bi = categoryOrder.indexOf(b)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  for (const category of sortedCategories) {
    const categoryFindings = byCategory.get(category)!
    const categoryLabel = fieldLabel(category)
    parts.push(`## ${categoryLabel}`)
    parts.push('')
    for (const finding of categoryFindings) {
      const severityTag = `[${finding.severity.toUpperCase()}]`
      parts.push(`- ${severityTag} ${finding.description}`)
      if (finding.affected_items.length > 0) {
        parts.push(`  - *Affected*: ${finding.affected_items.join(', ')}`)
      }
    }
    parts.push('')
  }

  return parts.join('\n')
}
