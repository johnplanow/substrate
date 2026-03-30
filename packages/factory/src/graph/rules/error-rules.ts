/**
 * All 8 error-severity lint rules for the Attractor graph validator.
 * Story 42-4: Graph Validator — Error Rules
 */

import type { Graph, GraphNode, LintRule, ValidationDiagnostic } from '../types.js'
import { parseCondition, ConditionParseError } from '../condition-parser.js'
import { parseStylesheet, StylesheetParseError } from '../../stylesheet/parser.js'

// ---------------------------------------------------------------------------
// Start / exit node detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given node is the graph's start node.
 * A node is the start node if:
 *   node.shape === 'Mdiamond'  OR  node.id === 'start'  OR  node.id === 'Start'
 */
export function isStartNode(node: GraphNode): boolean {
  return node.shape === 'Mdiamond' || node.id === 'start' || node.id === 'Start'
}

/**
 * Returns true if the given node is the graph's exit node.
 * A node is the exit node if:
 *   node.shape === 'Msquare'  OR  node.id === 'exit'  OR  node.id === 'end'
 */
export function isExitNode(node: GraphNode): boolean {
  return node.shape === 'Msquare' || node.id === 'exit' || node.id === 'end'
}

// ---------------------------------------------------------------------------
// Rule 1: start_node
// Exactly one start node must exist.
// ---------------------------------------------------------------------------

const startNodeRule: LintRule = {
  id: 'start_node',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const startNodes = [...graph.nodes.values()].filter(isStartNode)
    if (startNodes.length === 1) return []
    return [
      {
        ruleId: 'start_node',
        severity: 'error',
        message: `Expected exactly one start node (shape=Mdiamond or id=start/Start), found ${startNodes.length}`,
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Rule 2: terminal_node
// Exactly one exit node must exist.
// ---------------------------------------------------------------------------

const terminalNodeRule: LintRule = {
  id: 'terminal_node',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const exitNodes = [...graph.nodes.values()].filter(isExitNode)
    if (exitNodes.length === 1) return []
    return [
      {
        ruleId: 'terminal_node',
        severity: 'error',
        message: `Expected exactly one terminal node (shape=Msquare or id=exit/end), found ${exitNodes.length}`,
      },
    ]
  },
}

// ---------------------------------------------------------------------------
// Rule 3: start_no_incoming
// The start node must not have any incoming edges.
// ---------------------------------------------------------------------------

const startNoIncomingRule: LintRule = {
  id: 'start_no_incoming',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const startNodes = [...graph.nodes.values()].filter(isStartNode)
    // Defer to start_node rule if zero or multiple start nodes
    if (startNodes.length !== 1) return []
    const startId = startNodes[0]!.id
    const diagnostics: ValidationDiagnostic[] = []
    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i]!
      if (edge.toNode === startId) {
        diagnostics.push({
          ruleId: 'start_no_incoming',
          severity: 'error',
          message: `Edge at index ${i} targets the start node '${startId}'; start nodes must have no incoming edges`,
          edgeIndex: i,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 4: exit_no_outgoing
// The exit node must not have any outgoing edges.
// ---------------------------------------------------------------------------

const exitNoOutgoingRule: LintRule = {
  id: 'exit_no_outgoing',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const exitNodes = [...graph.nodes.values()].filter(isExitNode)
    // Defer to terminal_node rule if zero or multiple exit nodes
    if (exitNodes.length !== 1) return []
    const exitId = exitNodes[0]!.id
    const diagnostics: ValidationDiagnostic[] = []
    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i]!
      if (edge.fromNode === exitId) {
        diagnostics.push({
          ruleId: 'exit_no_outgoing',
          severity: 'error',
          message: `Edge at index ${i} originates from the exit node '${exitId}'; exit nodes must have no outgoing edges`,
          edgeIndex: i,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 5: edge_target_exists
// Every edge target must refer to an existing node.
// ---------------------------------------------------------------------------

const edgeTargetExistsRule: LintRule = {
  id: 'edge_target_exists',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []
    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i]!
      if (!graph.nodes.has(edge.toNode)) {
        diagnostics.push({
          ruleId: 'edge_target_exists',
          severity: 'error',
          message: `Edge at index ${i} targets non-existent node '${edge.toNode}'`,
          edgeIndex: i,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 6: reachability
// Every node must be reachable from the start node via BFS traversal.
// ---------------------------------------------------------------------------

const reachabilityRule: LintRule = {
  id: 'reachability',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const startNodes = [...graph.nodes.values()].filter(isStartNode)
    // Defer to start_node rule if there's not exactly one start node
    if (startNodes.length !== 1) return []

    const startId = startNodes[0]!.id
    const visited = new Set<string>()
    const queue: string[] = [startId]

    while (queue.length > 0) {
      const nodeId = queue.shift()!
      if (visited.has(nodeId)) continue
      visited.add(nodeId)
      for (const edge of graph.outgoingEdges(nodeId)) {
        if (!visited.has(edge.toNode)) {
          queue.push(edge.toNode)
        }
      }
    }

    const diagnostics: ValidationDiagnostic[] = []
    for (const [nodeId] of graph.nodes) {
      if (!visited.has(nodeId)) {
        diagnostics.push({
          ruleId: 'reachability',
          severity: 'error',
          message: `Node '${nodeId}' is not reachable from start`,
          nodeId,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 7: condition_syntax
// Edge condition expressions must conform to the condition grammar.
// Uses parseCondition from story 42-6 — catches double-equals and other
// invalid operators, empty clauses, and malformed expressions.
// ---------------------------------------------------------------------------

const conditionSyntaxRule: LintRule = {
  id: 'condition_syntax',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []
    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i]!
      // LLM-prefixed conditions (e.g. "llm:...") are evaluated at runtime via the
      // edge-selector's LLM evaluator and do not conform to the key=value condition
      // grammar. Skip syntax validation for them to avoid false-positive errors.
      if (edge.condition && !edge.condition.trim().startsWith('llm:')) {
        try {
          parseCondition(edge.condition)
        } catch (err) {
          if (err instanceof ConditionParseError) {
            diagnostics.push({
              ruleId: 'condition_syntax',
              severity: 'error',
              message: `Edge at index ${i} has invalid condition syntax: '${edge.condition}'`,
              edgeIndex: i,
            })
          } else {
            throw err
          }
        }
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 8: stylesheet_syntax
// Model stylesheet must be parseable by the real stylesheet parser (story 42-7).
// ---------------------------------------------------------------------------

const stylesheetSyntaxRule: LintRule = {
  id: 'stylesheet_syntax',
  severity: 'error',
  check(graph: Graph): ValidationDiagnostic[] {
    if (!graph.modelStylesheet) return []
    try {
      parseStylesheet(graph.modelStylesheet)
      return []
    } catch (err) {
      if (err instanceof StylesheetParseError) {
        return [
          {
            ruleId: 'stylesheet_syntax',
            severity: 'error',
            message: `Model stylesheet has invalid syntax: ${err.message}`,
          },
        ]
      }
      throw err
    }
  },
}

// ---------------------------------------------------------------------------
// Exported rule collection
// ---------------------------------------------------------------------------

export const errorRules: LintRule[] = [
  startNodeRule,
  terminalNodeRule,
  startNoIncomingRule,
  exitNoOutgoingRule,
  edgeTargetExistsRule,
  reachabilityRule,
  conditionSyntaxRule,
  stylesheetSyntaxRule,
]
