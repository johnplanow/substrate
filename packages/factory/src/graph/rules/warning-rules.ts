/**
 * All 5 warning-severity lint rules for the Attractor graph validator.
 * Story 42-5: Graph Validator — Warning Rules
 */

import type { Graph, LintRule, ValidationDiagnostic } from '../types.js'

// ---------------------------------------------------------------------------
// Known handler types and valid fidelity values
// ---------------------------------------------------------------------------

const KNOWN_HANDLER_TYPES = new Set([
  'codergen',
  'tool',
  'wait.human',
  'conditional',
  'start',
  'exit',
])

const VALID_FIDELITY_VALUES = new Set(['high', 'medium', 'low', 'draft'])

// ---------------------------------------------------------------------------
// Rule 1: type_known
// Node type must be empty or one of the known handler types.
// ---------------------------------------------------------------------------

const typeKnownRule: LintRule = {
  id: 'type_known',
  severity: 'warning',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []
    for (const node of graph.nodes.values()) {
      if (node.type !== '' && !KNOWN_HANDLER_TYPES.has(node.type)) {
        diagnostics.push({
          ruleId: 'type_known',
          severity: 'warning',
          nodeId: node.id,
          message: `Node '${node.id}' has unrecognised type '${node.type}'; known types are: ${[...KNOWN_HANDLER_TYPES].join(', ')}`,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 2: fidelity_valid
// Node fidelity must be empty or one of the valid fidelity modes.
// ---------------------------------------------------------------------------

const fidelityValidRule: LintRule = {
  id: 'fidelity_valid',
  severity: 'warning',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []
    for (const node of graph.nodes.values()) {
      if (node.fidelity !== '' && !VALID_FIDELITY_VALUES.has(node.fidelity)) {
        diagnostics.push({
          ruleId: 'fidelity_valid',
          severity: 'warning',
          nodeId: node.id,
          message: `Node '${node.id}' has invalid fidelity value '${node.fidelity}'; valid values are: ${[...VALID_FIDELITY_VALUES].join(', ')}`,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 3: retry_target_exists
// Node-level and graph-level retryTarget/fallbackRetryTarget must reference existing nodes.
// ---------------------------------------------------------------------------

const retryTargetExistsRule: LintRule = {
  id: 'retry_target_exists',
  severity: 'warning',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []

    for (const node of graph.nodes.values()) {
      if (node.retryTarget !== '' && !graph.nodes.has(node.retryTarget)) {
        diagnostics.push({
          ruleId: 'retry_target_exists',
          severity: 'warning',
          nodeId: node.id,
          message: `Node '${node.id}' retryTarget '${node.retryTarget}' does not exist`,
        })
      }
      if (node.fallbackRetryTarget !== '' && !graph.nodes.has(node.fallbackRetryTarget)) {
        diagnostics.push({
          ruleId: 'retry_target_exists',
          severity: 'warning',
          nodeId: node.id,
          message: `Node '${node.id}' fallbackRetryTarget '${node.fallbackRetryTarget}' does not exist`,
        })
      }
    }

    if (graph.retryTarget !== '' && !graph.nodes.has(graph.retryTarget)) {
      diagnostics.push({
        ruleId: 'retry_target_exists',
        severity: 'warning',
        message: `Graph-level retryTarget '${graph.retryTarget}' does not exist`,
      })
    }

    if (graph.fallbackRetryTarget !== '' && !graph.nodes.has(graph.fallbackRetryTarget)) {
      diagnostics.push({
        ruleId: 'retry_target_exists',
        severity: 'warning',
        message: `Graph-level fallbackRetryTarget '${graph.fallbackRetryTarget}' does not exist`,
      })
    }

    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 4: goal_gate_has_retry
// A node with goalGate=true must have a retryTarget (node-level or graph-level).
// ---------------------------------------------------------------------------

const goalGateHasRetryRule: LintRule = {
  id: 'goal_gate_has_retry',
  severity: 'warning',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []
    for (const node of graph.nodes.values()) {
      if (node.goalGate && node.retryTarget === '' && graph.retryTarget === '') {
        diagnostics.push({
          ruleId: 'goal_gate_has_retry',
          severity: 'warning',
          nodeId: node.id,
          message: `Node '${node.id}' has goal_gate=true but no retryTarget is set (node-level or graph-level default)`,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Rule 5: prompt_on_llm_nodes
// Codergen nodes (shape=box or type=codergen) should have a prompt or label.
// ---------------------------------------------------------------------------

const promptOnLlmNodesRule: LintRule = {
  id: 'prompt_on_llm_nodes',
  severity: 'warning',
  check(graph: Graph): ValidationDiagnostic[] {
    const diagnostics: ValidationDiagnostic[] = []
    for (const node of graph.nodes.values()) {
      const isCodergen = node.shape === 'box' || node.type === 'codergen'
      if (isCodergen && node.prompt === '' && node.label === '') {
        diagnostics.push({
          ruleId: 'prompt_on_llm_nodes',
          severity: 'warning',
          nodeId: node.id,
          message: `Codergen node '${node.id}' has no prompt or label`,
        })
      }
    }
    return diagnostics
  },
}

// ---------------------------------------------------------------------------
// Exported rule collection
// ---------------------------------------------------------------------------

export const warningRules: LintRule[] = [
  typeKnownRule,
  fidelityValidRule,
  retryTargetExistsRule,
  goalGateHasRetryRule,
  promptOnLlmNodesRule,
]
