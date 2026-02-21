/**
 * planning-prompt.ts — Planning Prompt Builder
 *
 * Constructs structured prompts for the planning CLI agent, optionally
 * including codebase context and multi-agent instructions.
 *
 * Architecture: ADR-010 (Plan generation via CLI agent delegation)
 */

import type { CodebaseContext } from './codebase-scanner.js'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Summary of a registered adapter for inclusion in the planning prompt.
 */
export interface AgentSummary {
  agentId: string
  supportedTaskTypes: string[]
  billingMode: string
  healthy: boolean
}

/**
 * Options for building a planning prompt.
 */
export interface PlanningPromptOptions {
  /** The high-level goal or description of work to plan */
  goal: string
  /** Structured codebase scan result (optional) */
  codebaseContext?: CodebaseContext
  /** List of available agents and their capabilities (optional) */
  availableAgents?: AgentSummary[]
  /** Hint for number of parallel agents (optional) */
  agentCount?: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a planning prompt string from the given options.
 *
 * When codebaseContext is provided, appends a `## Codebase Context` section.
 * When availableAgents is provided, appends an `## Available Agents` section.
 * When agentCount and availableAgents are both provided, appends a
 * `## Multi-Agent Instructions` section.
 */
export function buildPlanningPrompt(options: PlanningPromptOptions): string {
  const { goal, codebaseContext, availableAgents, agentCount } = options

  const sections: string[] = []

  // Base goal section
  sections.push(`## Goal\n${goal}`)

  // Codebase context section
  if (codebaseContext !== undefined) {
    sections.push(buildCodebaseContextSection(codebaseContext))
  }

  // Available agents section
  if (availableAgents !== undefined && availableAgents.length > 0) {
    sections.push(buildAvailableAgentsSection(availableAgents))
  }

  // Multi-agent instructions (only when both agentCount and availableAgents are provided)
  if (agentCount !== undefined && availableAgents !== undefined && availableAgents.length > 0) {
    sections.push(buildMultiAgentInstructionsSection(agentCount))
  }

  return sections.join('\n\n')
}

/**
 * Options for building a refinement prompt.
 */
export interface RefinementPromptOptions {
  /** The current task graph YAML (full snapshot, not a delta) */
  currentYaml: string
  /** All prior feedback strings in order (not including newFeedback) */
  feedbackHistory: string[]
  /** The new feedback to apply in this refinement round */
  newFeedback: string
  /** Available agent IDs */
  availableAgents?: string[]
}

/**
 * Build a refinement prompt that includes the full current YAML,
 * all prior feedback rounds, and the new feedback to apply.
 */
export function buildRefinementPrompt(options: RefinementPromptOptions): string {
  const { currentYaml, feedbackHistory, newFeedback, availableAgents = [] } = options

  const parts: string[] = [
    '## Task: Refine the Following Task Graph',
    '',
    'The current task graph (YAML) is:',
    '```yaml',
    currentYaml,
    '```',
    '',
  ]

  if (feedbackHistory.length > 0) {
    parts.push('### Prior Refinement Feedback (applied)')
    for (let i = 0; i < feedbackHistory.length; i++) {
      parts.push(`Round ${String(i + 1)}: ${feedbackHistory[i]}`)
    }
    parts.push('')
  }

  parts.push('### New Feedback to Apply')
  parts.push(newFeedback)
  parts.push('')

  if (availableAgents.length > 0) {
    parts.push('### Available Agents')
    for (const agent of availableAgents) {
      parts.push(`- ${agent}`)
    }
    parts.push('')
  }

  parts.push('### Output Format')
  parts.push('Produce the complete, updated task graph YAML (not a diff). Include all tasks, even unchanged ones.')

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildCodebaseContextSection(ctx: CodebaseContext): string {
  const lines: string[] = ['## Codebase Context']

  lines.push(`Root: ${ctx.rootPath}`)

  if (ctx.detectedLanguages.length > 0) {
    lines.push(`Languages: ${ctx.detectedLanguages.join(', ')}`)
  }

  if (ctx.techStack.length > 0) {
    const stackItems = ctx.techStack
      .map((item) => item.version !== undefined ? `${item.name} ${item.version}` : item.name)
      .join(', ')
    lines.push(`Tech Stack: ${stackItems}`)
  }

  // Top 15 directories
  const topDirs = ctx.topLevelDirs.slice(0, 15)
  if (topDirs.length > 0) {
    lines.push(`Top-level directories: ${topDirs.map((d) => `${d}/`).join(', ')}`)
  }

  // Top 20 runtime dependencies
  const runtimeDeps = Object.entries(ctx.dependencies.runtime).slice(0, 20)
  if (runtimeDeps.length > 0) {
    const depStr = runtimeDeps.map(([name, ver]) => `${name}@${ver}`).join(', ')
    lines.push(`Key dependencies: ${depStr}`)
  }

  return lines.join('\n')
}

function buildAvailableAgentsSection(agents: AgentSummary[]): string {
  const lines: string[] = ['## Available Agents (assign agent IDs to tasks where appropriate)']

  for (const agent of agents) {
    const taskTypes = agent.supportedTaskTypes.join(', ')
    const status = agent.healthy ? 'healthy' : 'unhealthy'
    lines.push(`- ${agent.agentId}: task types [${taskTypes}], billing: ${agent.billingMode}, status: ${status}`)
  }

  return lines.join('\n')
}

function buildMultiAgentInstructionsSection(agentCount: number): string {
  return [
    '## Multi-Agent Instructions',
    `Generate a plan for approximately ${String(agentCount)} parallel agents.`,
    "Assign each task an 'agent' field using one of the agent IDs listed above.",
    'Tasks that should run sequentially or have no natural agent specialization',
    "may omit the 'agent' field -- they will inherit routing at execution time.",
  ].join('\n')
}
