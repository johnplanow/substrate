/**
 * Shared types for all phase implementations in the Phase Orchestrator.
 *
 * Defines the parameter and result types for each pipeline phase,
 * as well as the shared dependency injection interface used by all phases.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher } from '../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Shared phase dependencies
// ---------------------------------------------------------------------------

/**
 * Dependency injection container for all phase implementations.
 * Each phase receives the same set of shared dependencies.
 */
export interface PhaseDeps {
  /** SQLite database instance (WAL mode, per ADR-003) */
  db: BetterSqlite3Database
  /** Loaded methodology pack (provides prompts, constraints, templates) */
  pack: MethodologyPack
  /** Context compiler (provides countTokens and compile utilities) */
  contextCompiler: ContextCompiler
  /** Sub-agent dispatcher (spawns agents, collects YAML output) */
  dispatcher: Dispatcher
}

// ---------------------------------------------------------------------------
// Analysis phase types
// ---------------------------------------------------------------------------

/**
 * Parameters for the analysis phase.
 */
export interface AnalysisPhaseParams {
  /** The pipeline run ID for this execution */
  runId: string
  /** The user's initial concept or goal in natural language */
  concept: string
}

/**
 * A structured product brief produced by the analysis phase.
 * Each field describes a key dimension of the product being built.
 */
export interface ProductBrief {
  /** A clear statement of the problem being solved */
  problem_statement: string
  /** List of target user groups or personas */
  target_users: string[]
  /** List of core features that solve the problem */
  core_features: string[]
  /** List of measurable success criteria */
  success_metrics: string[]
  /** List of technical, business, or regulatory constraints */
  constraints: string[]
}

/**
 * Result of the analysis phase execution.
 */
export interface AnalysisResult {
  /** Whether the phase completed successfully or failed */
  result: 'success' | 'failed'
  /** The structured product brief (only present on success) */
  product_brief?: ProductBrief
  /** The artifact ID registered in the decision store (only present on success) */
  artifact_id?: string
  /** Error description (only present on failure) */
  error?: string
  /** Additional error details such as schema validation messages */
  details?: string
  /** Token usage for the dispatched agent */
  tokenUsage: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// Planning phase types
// ---------------------------------------------------------------------------

/**
 * Parameters for the planning phase.
 */
export interface PlanningPhaseParams {
  /** The pipeline run ID for this execution */
  runId: string
}

/**
 * A functional requirement produced by the planning phase.
 */
export interface FunctionalRequirement {
  /** A description of what the system must do */
  description: string
  /** Priority level: must (critical), should (important), could (nice-to-have) */
  priority: 'must' | 'should' | 'could'
}

/**
 * A non-functional requirement produced by the planning phase.
 */
export interface NonFunctionalRequirement {
  /** A description of the quality attribute */
  description: string
  /** Category such as performance, security, scalability, reliability */
  category: string
}

/**
 * A user story produced by the planning phase.
 */
export interface UserStory {
  /** Short title for the user story */
  title: string
  /** Full description in "As a... I want... So that..." format */
  description: string
}

/**
 * Structured output produced by the planning agent.
 */
export interface PlanningOutput {
  /** Functional requirements with priorities */
  functional_requirements: FunctionalRequirement[]
  /** Non-functional requirements by category */
  non_functional_requirements: NonFunctionalRequirement[]
  /** User stories derived from requirements */
  user_stories: UserStory[]
  /** Technology stack decisions (language, framework, database, etc.) */
  tech_stack: Record<string, string>
  /** Domain model entities and relationships */
  domain_model: Record<string, unknown>
  /** Items explicitly out of scope */
  out_of_scope: string[]
}

/**
 * Result of the planning phase execution.
 */
export interface PlanningResult {
  /** Whether the phase completed successfully or failed */
  result: 'success' | 'failed'
  /** Total count of functional + non-functional requirements created (only present on success) */
  requirements_count?: number
  /** Count of user stories created (only present on success) */
  user_stories_count?: number
  /** The artifact ID registered in the decision store (only present on success) */
  artifact_id?: string
  /** Error description (only present on failure) */
  error?: string
  /** Additional error details such as schema validation messages */
  details?: string
  /** Token usage for the dispatched agent */
  tokenUsage: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// Solutioning phase types
// ---------------------------------------------------------------------------

/**
 * Parameters for the solutioning phase.
 */
export interface SolutioningPhaseParams {
  /** The pipeline run ID for this execution */
  runId: string
}

/**
 * A single architecture decision produced by the architecture generation sub-phase.
 */
export interface ArchitectureDecision {
  /** Category of the architecture decision (e.g., 'language', 'database', 'patterns') */
  category: string
  /** Unique key for this decision within its category */
  key: string
  /** The decision value (may be a plain string or JSON-encoded data) */
  value: string
  /** Optional rationale explaining why this decision was made */
  rationale?: string
}

/**
 * A user-facing story produced by the epic/story generation sub-phase.
 */
export interface StoryDefinition {
  /** Short unique key for the story (e.g., '1-1', '2-3') */
  key: string
  /** Short title describing the story */
  title: string
  /** Full description of what needs to be built */
  description: string
  /** List of acceptance criteria for the story */
  acceptance_criteria: string[]
  /** Priority: must (critical), should (important), could (nice-to-have) */
  priority: 'must' | 'should' | 'could'
}

/**
 * An epic grouping related stories together.
 */
export interface EpicDefinition {
  /** Title of the epic */
  title: string
  /** Description of the epic scope */
  description: string
  /** List of stories within this epic */
  stories: StoryDefinition[]
}

/**
 * Combined structured output of the solutioning phase.
 */
export interface SolutioningOutput {
  /** List of architecture decisions from the architecture sub-phase */
  architecture_decisions: ArchitectureDecision[]
  /** List of epics (each containing stories) from the story generation sub-phase */
  epics: EpicDefinition[]
}

/**
 * Result of the solutioning phase execution.
 */
export interface SolutioningResult {
  /** Whether the phase completed successfully or failed */
  result: 'success' | 'failed'
  /** Count of architecture decisions stored (only on success) */
  architecture_decisions?: number
  /** Count of epics stored (only on success) */
  epics?: number
  /** Count of stories stored (only on success) */
  stories?: number
  /** Whether the readiness check passed (only on success) */
  readiness_passed?: boolean
  /** Artifact IDs registered during the phase (only on success) */
  artifact_ids?: string[]
  /** Gaps identified by the readiness check (uncovered requirements) */
  gaps?: string[]
  /** Error description (only on failure) */
  error?: string
  /** Additional error details */
  details?: string
  /** Aggregated token usage from all sub-phase dispatches */
  tokenUsage: {
    input: number
    output: number
  }
}
