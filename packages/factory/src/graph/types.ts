/**
 * Core type definitions for the factory graph engine.
 * Sourced from architecture-software-factory.md and story 42-1.
 */

import type { StageStatus } from '../events.js'

// Re-export StageStatus so consumers can import from one place.
export type { StageStatus }

// ---------------------------------------------------------------------------
// Outcome types (story 42-8)
// ---------------------------------------------------------------------------

/**
 * Terminal status values returned by every node handler.
 * Drives edge selection, checkpointing, and retry logic.
 *
 * - `SUCCESS` — the node completed all objectives fully.
 * - `FAILURE` — the node failed and downstream work should not proceed.
 * - `NEEDS_RETRY` — the handler requests another attempt (consumed by retry loop).
 * - `ESCALATE` — the node requires human intervention or parent-pipeline escalation.
 *
 * `PARTIAL_SUCCESS` — the primary objective was met but secondary goals were missed.
 * Examples: code was generated but not all tests pass; a report was produced but
 * coverage targets were not hit. Use instead of `FAILURE` when the output has value
 * and downstream nodes can act on it.
 *
 * Retry exhaustion behaviour: if `GraphNode.allowPartial === false` (default),
 * the executor demotes `PARTIAL_SUCCESS` to `FAILURE`; if `allowPartial === true`,
 * it is accepted as-is. Goal gates always accept `PARTIAL_SUCCESS` as satisfying.
 */
export type OutcomeStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'

/**
 * Structured result returned by every node handler.
 * The executor reads contextUpdates and merges them into GraphContext after a
 * successful node, uses preferredLabel and suggestedNextIds in edge selection
 * (story 42-12), stores notes in the checkpoint (story 42-13), and uses the
 * status to trigger retry / escalation logic.
 */
export interface Outcome {
  status: OutcomeStatus
  preferredLabel?: string
  suggestedNextIds?: string[]
  contextUpdates?: Record<string, unknown>
  notes?: string
  error?: unknown
  /** Human-readable reason for FAILURE outcomes (e.g., stderr from tool handler). */
  failureReason?: string
}

// ---------------------------------------------------------------------------
// Primitive union types
// ---------------------------------------------------------------------------

/**
 * Fidelity mode for node or graph-level quality setting.
 */
export type FidelityMode = 'high' | 'medium' | 'low' | 'draft'

// ---------------------------------------------------------------------------
// Graph node
// ---------------------------------------------------------------------------

/**
 * A single node in the factory graph.
 * All 17 attributes from the DOT Attribute Mapping table (story 42-2).
 */
export interface GraphNode {
  id: string
  label: string
  shape: string
  type: string
  prompt: string
  maxRetries: number
  goalGate: boolean
  retryTarget: string
  fallbackRetryTarget: string
  fidelity: string
  threadId: string
  class: string
  timeout: number
  llmModel: string
  llmProvider: string
  reasoningEffort: string
  autoStatus: boolean
  /**
   * Controls executor behaviour when a handler returns `PARTIAL_SUCCESS` and all
   * retry attempts are exhausted.
   *
   * - `false` (default): the executor demotes `PARTIAL_SUCCESS` to `FAILURE`,
   *   adding an explanatory `failureReason`. The node is treated as failed for
   *   checkpointing, edge selection, and goal gate evaluation.
   * - `true`: `PARTIAL_SUCCESS` is accepted as-is; execution continues to the
   *   next node and goal gates treat it the same as `SUCCESS`.
   */
  allowPartial: boolean
  /** Shell command string for tool nodes (from `tool_command` DOT attribute). Story 42-11. */
  toolCommand: string
}

// ---------------------------------------------------------------------------
// Graph edge
// ---------------------------------------------------------------------------

/**
 * A directed edge between two nodes in the factory graph.
 * All 6 edge attributes from the DOT Attribute Mapping table (story 42-2).
 */
export interface GraphEdge {
  id?: string
  fromNode: string
  toNode: string
  label: string
  condition: string
  weight: number
  fidelity: string
  threadId: string
  loopRestart: boolean
}

// ---------------------------------------------------------------------------
// Graph (top-level model)
// ---------------------------------------------------------------------------

/**
 * The top-level factory graph model returned by `parseGraph()`.
 *
 * `outgoingEdges`, `startNode`, and `exitNode` are implemented as methods
 * on the concrete `GraphImpl` class.
 */
export interface Graph {
  /** DOT graph id (or empty string if unnamed) */
  id: string
  /** High-level goal for this pipeline */
  goal: string
  /** Human-readable label */
  label: string
  /** Path to the model stylesheet YAML */
  modelStylesheet: string
  /** Default maximum retry attempts for nodes that don't override */
  defaultMaxRetries: number
  /** Default retry target node id */
  retryTarget: string
  /** Default fallback retry target node id */
  fallbackRetryTarget: string
  /** Default fidelity mode */
  defaultFidelity: FidelityMode | ''
  /** All nodes keyed by id */
  nodes: Map<string, GraphNode>
  /** All edges */
  edges: GraphEdge[]
  /** Return all edges originating from the given node id */
  outgoingEdges(nodeId: string): GraphEdge[]
  /** Return the start node (shape=Mdiamond or type=start) */
  startNode(): GraphNode
  /** Return the exit node (shape=Msquare or type=exit) */
  exitNode(): GraphNode
}

// ---------------------------------------------------------------------------
// Condition expression types (story 42-6)
// ---------------------------------------------------------------------------

/**
 * A single parsed clause of an edge condition expression.
 *
 * Grammar reference (Attractor Spec §10):
 *   condition  ::= clause ('&&' clause)*
 *   clause     ::= key op value
 *   key        ::= [a-zA-Z_][a-zA-Z0-9_]*
 *   op         ::= '=' | '!='
 *   value      ::= quoted_string | unquoted_token
 */
export interface ConditionClause {
  key: string
  op: '=' | '!='
  value: string
}

/**
 * A parsed condition expression — a conjunction of one or more clauses.
 * All clauses must be satisfied for the condition to evaluate to true.
 */
export type ParsedCondition = ConditionClause[]

// ---------------------------------------------------------------------------
// IGraphContext (story 42-8)
// ---------------------------------------------------------------------------

/**
 * Thread-safe key-value store for node handler execution state.
 * Implemented by `GraphContext` in `context.ts`.
 * "Thread-safety" in the JS single-threaded sense: each clone() produces an
 * independent backing store so mutations do not propagate between instances.
 */
export interface IGraphContext {
  /** Return stored value, or `undefined` if the key is absent. */
  get(key: string): unknown
  /** Store value; overwrites if the key already exists. */
  set(key: string, value: unknown): void
  /** Return String-coerced value, or `defaultValue` (default `""`) if absent. */
  getString(key: string, defaultValue?: string): string
  /** Return Number-coerced value, or `defaultValue` (default `0`) if absent; NaN resolves to default. */
  getNumber(key: string, defaultValue?: number): number
  /** Return Boolean-coerced value, or `defaultValue` (default `false`) if absent. */
  getBoolean(key: string, defaultValue?: boolean): boolean
  /** Merge all entries from `updates` into the store; does not clear pre-existing keys. */
  applyUpdates(updates: Record<string, unknown>): void
  /** Return a shallow-copied plain object of all current key-value pairs. */
  snapshot(): Record<string, unknown>
  /** Return a completely independent copy backed by its own Map. */
  clone(): IGraphContext
}

// ---------------------------------------------------------------------------
// Stylesheet types (story 42-7)
// ---------------------------------------------------------------------------

/**
 * The set of recognised CSS-like properties in a model stylesheet.
 */
export type StylesheetProperty = 'llm_model' | 'llm_provider' | 'reasoning_effort'

/**
 * A single `property: value` pair inside a stylesheet rule block.
 */
export interface StylesheetDeclaration {
  property: StylesheetProperty
  value: string
}

/**
 * Discriminant for the four supported selector types.
 * Determines how the selector is matched against a node and the specificity assigned.
 */
export type StylesheetSelectorType = 'universal' | 'shape' | 'class' | 'id'

/**
 * A parsed CSS-like selector with its type, match value, and specificity score.
 *
 * | Selector type | Example         | Specificity |
 * |---------------|-----------------|-------------|
 * | universal     | `*`             | 0           |
 * | shape         | `box`           | 1           |
 * | class         | `.code`         | 2           |
 * | id            | `#review_node`  | 3           |
 */
export interface StylesheetSelector {
  type: StylesheetSelectorType
  value: string
  specificity: 0 | 1 | 2 | 3
}

/**
 * A single parsed rule from a model stylesheet: one selector + zero or more declarations.
 */
export interface StylesheetRule {
  selector: StylesheetSelector
  declarations: StylesheetDeclaration[]
}

/**
 * A fully parsed model stylesheet — an ordered array of rules in source order.
 */
export type ParsedStylesheet = StylesheetRule[]

/**
 * The LLM routing properties resolved for a specific graph node after applying
 * all matching stylesheet rules in specificity order.
 *
 * Only properties that appear in at least one matching rule are present;
 * the caller is responsible for merging with explicit node attributes and graph defaults.
 */
export interface ResolvedNodeStyles {
  llmModel?: string
  llmProvider?: string
  reasoningEffort?: string
}

// ---------------------------------------------------------------------------
// Stub interfaces (to be filled by later stories)
// ---------------------------------------------------------------------------

/**
 * A persisted execution checkpoint for resuming a graph run.
 * Spec-compliant shape from Attractor Spec §5.3 (story 42-13).
 */
export interface Checkpoint {
  /** Unix timestamp (ms) when this checkpoint was created */
  timestamp: number
  /** ID of the last completed node */
  currentNode: string
  /** IDs of all completed nodes in traversal order */
  completedNodes: string[]
  /** Retry counters keyed by node ID */
  nodeRetries: Record<string, number>
  /** Serialized snapshot of GraphContext at save time */
  contextValues: Record<string, unknown>
  /** Execution log lines accumulated since run start */
  logs: string[]
}

/**
 * State returned by `CheckpointManager.resume()` for use by the graph executor.
 * Story 42-13.
 */
export interface ResumeState {
  /** GraphContext seeded from checkpoint.contextValues */
  context: IGraphContext
  /** Set of node IDs that were already completed — executor skips these */
  completedNodes: Set<string>
  /** Retry counters restored from checkpoint */
  nodeRetries: Record<string, number>
  /**
   * Fidelity override for the first resumed node.
   * Set to 'summary:high' when the last-executed node used 'full' fidelity
   * (in-memory LLM sessions cannot be serialized).
   * Empty string means no degradation is needed.
   */
  firstResumedNodeFidelity: string
}

/**
 * Backend used for AI-assisted code generation within the graph engine.
 * Stub — expanded in story 42-9.
 */
export interface CodergenBackend {
  generate(prompt: string, context: IGraphContext): Promise<string>
}

/**
 * A single diagnostic produced by graph validation.
 * Expanded in story 42-4.
 */
export interface ValidationDiagnostic {
  ruleId: string
  severity: 'error' | 'warning'
  message: string
  nodeId?: string
  edgeIndex?: number
}

/**
 * A single lint rule applied during graph validation.
 * Expanded in story 42-4.
 */
export interface LintRule {
  id: string
  severity: 'error' | 'warning'
  check(graph: Graph): ValidationDiagnostic[]
}

/**
 * Validates a parsed graph and returns diagnostics.
 * Expanded in story 42-4.
 */
export interface GraphValidator {
  validate(graph: Graph): ValidationDiagnostic[]
  validateOrRaise(graph: Graph): void
  registerRule(rule: LintRule): void
}
