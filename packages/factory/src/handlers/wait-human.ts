/**
 * wait.human handler — pauses graph execution for human input at decision points.
 *
 * AC4: Accelerator key parsing from edge labels (`[Y] Yes` → `{ key: 'Y', label: 'Yes' }`)
 * AC5: Returns SUCCESS with preferredLabel matching human selection and context update
 *
 * Story 42-11.
 */

import * as readline from 'readline'
import type { GraphNode, Graph, GraphEdge, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler } from './types.js'

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/**
 * A single choice presented to the human at a wait.human gate.
 */
export interface Choice {
  /** Single-character accelerator key (uppercased). */
  key: string
  /** Human-readable label text (without the `[X]` prefix). */
  label: string
}

/**
 * Configuration options for the wait.human handler factory.
 */
export interface WaitHumanHandlerOptions {
  /**
   * Inject a custom prompt function for testability.
   * Receives the node label (question header) and the list of choices.
   * Must resolve with the full edge label string (e.g., `"[Y] Yes"`).
   * Defaults to a readline-based CLI prompt.
   */
  promptFn?: (nodeLabel: string, choices: Choice[]) => Promise<string>
}

// ---------------------------------------------------------------------------
// Accelerator key parsing (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse an edge label into a `Choice` with an accelerator key.
 *
 * - Labels matching `/^\[([A-Za-z0-9])\]\s*(.*)$/` use the bracketed char as key
 *   and the remaining text as the label.
 * - Labels without the `[X]` prefix fall back to the first character of the label
 *   (uppercased) as the key, and the full label string as the label text.
 *
 * @param edgeLabel - The raw edge label string from the DOT graph.
 * @returns `{ key, label }` — key is always uppercased.
 */
export function parseAcceleratorKey(edgeLabel: string): Choice {
  const match = /^\[([A-Za-z0-9])\]\s*(.*)$/.exec(edgeLabel)
  if (match) {
    return {
      key: (match[1] ?? '').toUpperCase(),
      label: (match[2] ?? '').trim(),
    }
  }
  return {
    key: edgeLabel.charAt(0).toUpperCase(),
    label: edgeLabel,
  }
}

// ---------------------------------------------------------------------------
// Choice derivation from graph edges (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Derive the list of choices for a wait.human node by inspecting outgoing edges.
 *
 * Filters `graph.edges` where `edge.fromNode === node.id` and `edge.label` is
 * non-empty, then maps each edge label through `parseAcceleratorKey`.
 *
 * @param node  - The wait.human graph node.
 * @param graph - The full graph (used to read edge labels).
 * @returns Ordered array of choices derived from outgoing edge labels.
 */
export function deriveChoices(node: GraphNode, graph: Graph): Choice[] {
  return graph.edges
    .filter((edge: GraphEdge) => edge.fromNode === node.id && edge.label)
    .map((edge: GraphEdge) => parseAcceleratorKey(edge.label))
}

// ---------------------------------------------------------------------------
// Default prompt implementation (readline-based CLI)
// ---------------------------------------------------------------------------

/**
 * Default `promptFn` using Node's built-in `readline` module.
 * Displays the node label as a question header, lists choices, and reads
 * a single line of input. Re-prompts on invalid input.
 *
 * Returns the full edge label string matched (e.g., `"[Y] Yes"`).
 */
function defaultPromptFn(nodeLabel: string, choices: Choice[]): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    function prompt(): void {
      process.stdout.write(`\n${nodeLabel}\n`)
      for (const choice of choices) {
        process.stdout.write(`  [${choice.key}] ${choice.label}\n`)
      }
      rl.question('Select an option: ', (answer) => {
        const trimmed = answer.trim()

        // Match by accelerator key (case-insensitive)
        const byKey = choices.find((c) => c.key.toUpperCase() === trimmed.toUpperCase())
        if (byKey) {
          rl.close()
          resolve(`[${byKey.key}] ${byKey.label}`)
          return
        }

        // Match by full edge label (e.g., "[Y] Yes") or bare label text
        const byFullLabel = choices.find(
          (c) => `[${c.key}] ${c.label}` === trimmed || c.label === trimmed
        )
        if (byFullLabel) {
          rl.close()
          resolve(`[${byFullLabel.key}] ${byFullLabel.label}`)
          return
        }

        process.stdout.write('Invalid input. Please try again.\n')
        prompt()
      })
    }

    prompt()
  })
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a wait.human node handler that pauses execution for human input.
 *
 * @param options - Optional configuration (inject `promptFn` for testing).
 * @returns A `NodeHandler` that:
 *   1. Derives choices from outgoing edge labels via `deriveChoices`.
 *   2. Calls `promptFn(node.label, choices)` and awaits the selected label.
 *   3. Returns `{ status: 'SUCCESS', preferredLabel, contextUpdates: { '{node.id}.choice': label } }`.
 */
export function createWaitHumanHandler(options?: WaitHumanHandlerOptions): NodeHandler {
  const promptFn = options?.promptFn ?? defaultPromptFn

  return async (node: GraphNode, context: IGraphContext, graph: Graph): Promise<Outcome> => {
    // context is required by the NodeHandler signature; not used directly here
    void context

    const choices = deriveChoices(node, graph)
    const selectedLabel = await promptFn(node.label, choices)

    return {
      status: 'SUCCESS',
      preferredLabel: selectedLabel,
      contextUpdates: {
        [`${node.id}.choice`]: selectedLabel,
      },
    }
  }
}
