/**
 * DOT source parser for factory graphs.
 *
 * Processing pipeline:
 *  1. `fromDot()` (ts-graphviz model API) extracts graph-level attributes.
 *  2. `parse()` (@ts-graphviz/ast) traverses AST in declaration order so
 *     that `node [...]` / `edge [...]` default blocks apply only to nodes/edges
 *     declared AFTER the block (standard DOT semantics, GE-P5/P6/P7).
 *
 * Story 42-1: graph-level attribute extraction
 * Story 42-2: node and edge attribute extraction
 * Story 42-3: chained edge expansion (GE-P5), default blocks (GE-P6),
 *             subgraph flattening (GE-P7), outgoingEdges helper
 */

import { parse } from '@ts-graphviz/ast'
import type {
  DotASTNode,
  GraphASTNode,
  ClusterStatementASTNode,
  AttributeListASTNode,
  AttributeASTNode,
  CommentASTNode,
  NodeASTNode,
  EdgeASTNode,
  SubgraphASTNode,
  NodeRefASTNode,
  NodeRefGroupASTNode,
} from '@ts-graphviz/ast'
import { fromDot } from 'ts-graphviz'
import type { RootGraphModel } from '@ts-graphviz/common'
import type { Graph, GraphNode, GraphEdge, FidelityMode } from './types.js'

// ---------------------------------------------------------------------------
// Raw attribute map — DOT attribute names (snake_case keys) → string values
// ---------------------------------------------------------------------------

/** Raw DOT attribute map used during AST traversal. */
type AttrMap = Record<string, string>

// ---------------------------------------------------------------------------
// Attribute coercion helpers
// ---------------------------------------------------------------------------

function attrStr(attrs: AttrMap, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(attrs, key) ? (attrs[key] ?? fallback) : fallback
}

function attrInt(attrs: AttrMap, key: string, fallback: number): number {
  if (!Object.prototype.hasOwnProperty.call(attrs, key)) return fallback
  const n = parseInt(attrs[key] ?? '', 10)
  return isNaN(n) ? fallback : n
}

function attrBool(attrs: AttrMap, key: string, fallback: boolean): boolean {
  if (!Object.prototype.hasOwnProperty.call(attrs, key)) return fallback
  const v = (attrs[key] ?? '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

// ---------------------------------------------------------------------------
// Class derivation algorithm (GE-P7)
// ---------------------------------------------------------------------------

/**
 * Derive a CSS-style class name from a subgraph label.
 *
 * Examples:
 *   "Loop A"        → "loop-a"
 *   "Phase 1: Init" → "phase-1-init"
 *
 * Returns an empty string when `label` is empty (no class assignment).
 */
function deriveClass(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

// ---------------------------------------------------------------------------
// AST attribute extraction
// ---------------------------------------------------------------------------

/**
 * Collect Attribute children from an AST node into a plain AttrMap.
 * CommentASTNode children are skipped.
 */
function extractAttrs(children: ReadonlyArray<AttributeASTNode | CommentASTNode>): AttrMap {
  const map: AttrMap = {}
  for (const child of children) {
    if (child.type === 'Attribute') {
      map[child.key.value] = child.value.value
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// GraphNode builder
// ---------------------------------------------------------------------------

/**
 * Construct a `GraphNode` from a merged attribute map.
 *
 * Priority (highest → lowest): explicit attrs > current node defaults.
 * `subgraphClass` is applied only when the merged attrs have no `class` key;
 * an explicit `class` attribute always wins.
 *
 * `defaultMaxRetries` is the graph-level default — used when node has no
 * explicit `max_retries` attribute (story 42-2 AC4).
 */
function buildGraphNode(
  id: string,
  attrs: AttrMap,
  subgraphClass: string,
  defaultMaxRetries: number,
): GraphNode {
  // class: explicit attr wins over subgraph derivation
  const classAttr = Object.prototype.hasOwnProperty.call(attrs, 'class')
    ? (attrs['class'] ?? '')
    : subgraphClass

  return {
    id,
    label: attrStr(attrs, 'label', ''),
    shape: attrStr(attrs, 'shape', 'box'),
    type: attrStr(attrs, 'type', ''),
    prompt: attrStr(attrs, 'prompt', ''),
    maxRetries: attrInt(attrs, 'max_retries', defaultMaxRetries),
    goalGate: attrBool(attrs, 'goal_gate', false),
    retryTarget: attrStr(attrs, 'retry_target', ''),
    fallbackRetryTarget: attrStr(attrs, 'fallback_retry_target', ''),
    fidelity: attrStr(attrs, 'fidelity', ''),
    threadId: attrStr(attrs, 'thread_id', ''),
    class: classAttr,
    timeout: attrInt(attrs, 'timeout', 0),
    llmModel: attrStr(attrs, 'llm_model', ''),
    llmProvider: attrStr(attrs, 'llm_provider', ''),
    reasoningEffort: attrStr(attrs, 'reasoning_effort', ''),
    autoStatus: attrBool(attrs, 'auto_status', true),
    allowPartial: attrBool(attrs, 'allow_partial', false),
    toolCommand: attrStr(attrs, 'tool_command', ''),
    backend: attrStr(attrs, 'backend', ''),
    maxParallel: attrInt(attrs, 'maxParallel', 0),
    joinPolicy: attrStr(attrs, 'joinPolicy', ''),
  }
}

// ---------------------------------------------------------------------------
// GraphEdge builder
// ---------------------------------------------------------------------------

function buildGraphEdge(fromNode: string, toNode: string, attrs: AttrMap): GraphEdge {
  return {
    fromNode,
    toNode,
    label: attrStr(attrs, 'label', ''),
    condition: attrStr(attrs, 'condition', ''),
    weight: attrInt(attrs, 'weight', 0),
    fidelity: attrStr(attrs, 'fidelity', ''),
    threadId: attrStr(attrs, 'thread_id', ''),
    loopRestart: attrBool(attrs, 'loop_restart', false),
  }
}

// ---------------------------------------------------------------------------
// Edge target helper
// ---------------------------------------------------------------------------

/**
 * Extract the node ID from an `EdgeTargetASTNode`.
 *
 * For `NodeRef` (single node reference), returns `node.id.value`.
 * For `NodeRefGroup` (curly-brace groups `{A B}`), returns the first
 * member's ID — groups are rare in factory graphs.
 */
function getEdgeTargetId(target: NodeRefASTNode | NodeRefGroupASTNode): string {
  if (target.type === 'NodeRef') {
    return (target as NodeRefASTNode).id.value
  }
  // NodeRefGroup — use first member
  const group = target as NodeRefGroupASTNode
  const first = group.children[0]
  return first ? first.id.value : ''
}

// ---------------------------------------------------------------------------
// AST traversal (GE-P5, GE-P6, GE-P7 implementation)
// ---------------------------------------------------------------------------

/**
 * Traverse child statements of a Graph or Subgraph AST node **in declaration
 * order**, accumulating nodes and edges into the caller-provided collections.
 *
 * @param stmts              Ordered list of child statements.
 * @param nodeDefaults       Mutable current node defaults — updated in-place on
 *                           each `node [...]` block (later block overwrites earlier).
 * @param edgeDefaults       Mutable current edge defaults — updated similarly.
 * @param nodes              Output map (node id → GraphNode).
 * @param edges              Output edge array.
 * @param subgraphClass      Class name inherited from the nearest enclosing
 *                           subgraph with a `label` attribute; empty string if none.
 * @param defaultMaxRetries  Graph-level default for `max_retries`.
 */
function traverseStatements(
  stmts: ReadonlyArray<ClusterStatementASTNode>,
  nodeDefaults: AttrMap,
  edgeDefaults: AttrMap,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  subgraphClass: string,
  defaultMaxRetries: number,
): void {
  for (const stmt of stmts) {
    switch (stmt.type) {
      case 'Comment':
        break

      case 'AttributeList': {
        // `node [...]`, `edge [...]`, or `graph [...]` default block.
        const listStmt = stmt as AttributeListASTNode
        const attrs = extractAttrs(listStmt.children)
        if (listStmt.kind === 'Node') {
          // GE-P6: later node default block overwrites earlier for same key.
          Object.assign(nodeDefaults, attrs)
        } else if (listStmt.kind === 'Edge') {
          Object.assign(edgeDefaults, attrs)
        }
        // Graph-level defaults (kind='Graph') are extracted by fromDot() already.
        break
      }

      case 'Attribute':
        // Direct key=value in a graph or subgraph body (e.g. `label="x"`).
        // These set the containing graph/subgraph's own attributes, not
        // node/edge defaults. Subgraph labels are handled in the Subgraph case.
        break

      case 'Node': {
        // GE-P6: explicit node attrs win over current defaults.
        const nodeStmt = stmt as NodeASTNode
        const id = nodeStmt.id.value
        const explicit = extractAttrs(nodeStmt.children)
        const merged: AttrMap = { ...nodeDefaults, ...explicit }
        nodes.set(id, buildGraphNode(id, merged, subgraphClass, defaultMaxRetries))
        break
      }

      case 'Edge': {
        // GE-P5: edge defaults applied first; explicit attrs override.
        const edgeStmt = stmt as EdgeASTNode
        const explicit = extractAttrs(edgeStmt.children)
        const merged: AttrMap = { ...edgeDefaults, ...explicit }

        // GE-P5: expand chained targets — [A, B, C] → A→B edge, B→C edge.
        // Also materialise implicit nodes (targets referenced only in edges)
        // with the node defaults active at the time of the edge declaration.
        const targets = edgeStmt.targets
        for (let i = 0; i < targets.length - 1; i++) {
          const from = getEdgeTargetId(targets[i]!)
          const to = getEdgeTargetId(targets[i + 1]!)
          if (from && to) {
            if (!nodes.has(from)) {
              nodes.set(from, buildGraphNode(from, { ...nodeDefaults }, subgraphClass, defaultMaxRetries))
            }
            if (!nodes.has(to)) {
              nodes.set(to, buildGraphNode(to, { ...nodeDefaults }, subgraphClass, defaultMaxRetries))
            }
            edges.push(buildGraphEdge(from, to, merged))
          }
        }
        break
      }

      case 'Subgraph': {
        // GE-P7: derive class from subgraph label, then recurse.
        const sgStmt = stmt as SubgraphASTNode

        // Collect the subgraph's own `label` attribute from its direct
        // Attribute children (not from AttributeList blocks inside it).
        let sgLabel = ''
        for (const child of sgStmt.children) {
          if (child.type === 'Attribute') {
            const attrChild = child as AttributeASTNode
            if (attrChild.key.value === 'label') {
              sgLabel = attrChild.value.value
            }
          }
        }

        // Inner subgraph label takes precedence over outer subgraph class.
        const derivedClass = sgLabel ? deriveClass(sgLabel) : subgraphClass

        // node/edge defaults continue into the subgraph scope (DOT semantics).
        traverseStatements(
          sgStmt.children,
          nodeDefaults,
          edgeDefaults,
          nodes,
          edges,
          derivedClass,
          defaultMaxRetries,
        )
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Concrete Graph implementation
// ---------------------------------------------------------------------------

class GraphImpl implements Graph {
  id: string
  goal: string
  label: string
  modelStylesheet: string
  defaultMaxRetries: number
  retryTarget: string
  fallbackRetryTarget: string
  defaultFidelity: FidelityMode | ''
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]

  constructor(data: Omit<Graph, 'outgoingEdges' | 'startNode' | 'exitNode'>) {
    this.id = data.id
    this.goal = data.goal
    this.label = data.label
    this.modelStylesheet = data.modelStylesheet
    this.defaultMaxRetries = data.defaultMaxRetries
    this.retryTarget = data.retryTarget
    this.fallbackRetryTarget = data.fallbackRetryTarget
    this.defaultFidelity = data.defaultFidelity
    this.nodes = data.nodes
    this.edges = data.edges
  }

  /** Return all edges where `edge.fromNode === nodeId`. */
  outgoingEdges(nodeId: string): GraphEdge[] {
    return this.edges.filter((e) => e.fromNode === nodeId)
  }

  startNode(): GraphNode {
    for (const node of this.nodes.values()) {
      if (node.shape === 'Mdiamond' || node.type === 'start') {
        return node
      }
    }
    throw new Error('Graph has no start node (shape=Mdiamond or type=start)')
  }

  exitNode(): GraphNode {
    for (const node of this.nodes.values()) {
      if (node.shape === 'Msquare' || node.type === 'exit') {
        return node
      }
    }
    throw new Error('Graph has no exit node (shape=Msquare or type=exit)')
  }
}

// ---------------------------------------------------------------------------
// Model-level attribute reader helpers (for graph-level attrs via fromDot)
// ---------------------------------------------------------------------------

interface ModelAttrList {
  get(key: string): unknown
}

function getString(attrList: ModelAttrList, key: string, defaultValue: string): string {
  const val = attrList.get(key)
  if (val === undefined || val === null) return defaultValue
  return String(val)
}

function getInt(attrList: ModelAttrList, key: string, defaultValue: number): number {
  const val = attrList.get(key)
  if (val === undefined || val === null) return defaultValue
  const n = parseInt(String(val), 10)
  return isNaN(n) ? defaultValue : n
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a DOT source string into a typed `Graph` model.
 *
 * Uses two complementary parsers:
 *  - `fromDot()` (ts-graphviz model API) for graph-level attributes.
 *  - `parse()` (@ts-graphviz/ast) for ordered AST traversal, enabling
 *    correct default block scoping, chained edge expansion, and subgraph
 *    flattening.
 *
 * @throws {Error} with prefix `"DOT parse error: "` on invalid DOT syntax.
 */
export function parseGraph(dotSource: string): Graph {
  // --- Pass 1: graph-level attributes via fromDot() model API ---
  let modelAst: RootGraphModel
  try {
    // fromDot() overloads: call without options returns RootGraphModel (first overload).
    // Cast needed because TypeScript's ReturnType<> resolves to the last overload.
    modelAst = fromDot(dotSource) as RootGraphModel
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`DOT parse error: ${message}`)
  }

  const ga = modelAst.attributes.graph as ModelAttrList
  const id = modelAst.id !== undefined ? String(modelAst.id) : ''
  const goal = getString(ga, 'goal', '')
  const label = getString(ga, 'label', '')
  const modelStylesheet = getString(ga, 'model_stylesheet', '')
  const defaultMaxRetries = getInt(ga, 'default_max_retries', 0)
  const retryTarget = getString(ga, 'retry_target', '')
  const fallbackRetryTarget = getString(ga, 'fallback_retry_target', '')
  const defaultFidelity = getString(ga, 'default_fidelity', '') as FidelityMode | ''

  // --- Pass 2: AST traversal for nodes, edges, defaults, subgraphs ---
  let dotAst: DotASTNode
  try {
    dotAst = parse(dotSource)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`DOT parse error: ${message}`)
  }

  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  // The top-level DotASTNode wraps a GraphASTNode as its first non-comment child.
  const graphAST = dotAst.children.find((c): c is GraphASTNode => c.type === 'Graph')
  if (graphAST) {
    traverseStatements(
      graphAST.children,
      {}, // nodeDefaults — start empty
      {}, // edgeDefaults — start empty
      nodes,
      edges,
      '', // no enclosing subgraph class at top level
      defaultMaxRetries,
    )
  }

  return new GraphImpl({
    id,
    goal,
    label,
    modelStylesheet,
    defaultMaxRetries,
    retryTarget,
    fallbackRetryTarget,
    defaultFidelity,
    nodes,
    edges,
  })
}
