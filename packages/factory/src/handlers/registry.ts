/**
 * HandlerRegistry — maps node types and shapes to handler functions.
 *
 * Resolution priority (3-step chain):
 *   1. Explicit type: `node.type` is non-empty and a handler is registered for it
 *   2. Shape-based: `node.shape` maps to a registered type via the shape map
 *   3. Default: `_default` if set; throws otherwise
 *
 * Story 42-9.
 */

import type { GraphNode } from '../graph/types.js'
import type { IHandlerRegistry, NodeHandler } from './types.js'
import { startHandler } from './start.js'
import { exitHandler } from './exit.js'
import { conditionalHandler } from './conditional.js'
import { createCodergenHandler } from './codergen-handler.js'
import { createToolHandler } from './tool.js'
import { createWaitHumanHandler } from './wait-human.js'

export class HandlerRegistry implements IHandlerRegistry {
  /** Maps node type → handler function */
  private _handlers = new Map<string, NodeHandler>()
  /** Maps DOT shape name → canonical node type */
  private _shapeMap = new Map<string, string>()
  /** Fallback handler when no type or shape match is found */
  private _default: NodeHandler | undefined

  /**
   * Register a handler for the given node type.
   * Overwrites if already registered.
   */
  register(type: string, handler: NodeHandler): void {
    this._handlers.set(type, handler)
  }

  /**
   * Register a shape → type mapping.
   * Overwrites if already registered.
   */
  registerShape(shape: string, type: string): void {
    this._shapeMap.set(shape, type)
  }

  /**
   * Set the default handler used when no type or shape match is found.
   */
  setDefault(handler: NodeHandler): void {
    this._default = handler
  }

  /**
   * Resolve the handler for the given node.
   * Priority: explicit type → shape-based fallback → default → throw
   */
  resolve(node: GraphNode): NodeHandler {
    // Step 1: Explicit type match
    if (node.type) {
      const handler = this._handlers.get(node.type)
      if (handler !== undefined) {
        return handler
      }
    }

    // Step 2: Shape-based fallback
    if (node.shape) {
      const mappedType = this._shapeMap.get(node.shape)
      if (mappedType !== undefined) {
        const handler = this._handlers.get(mappedType)
        if (handler !== undefined) {
          return handler
        }
      }
    }

    // Step 3: Default handler
    if (this._default !== undefined) {
      return this._default
    }

    throw new Error(
      `No handler for node "${node.id}" (type="${node.type}", shape="${node.shape}")`
    )
  }
}

/**
 * Factory function that creates a `HandlerRegistry` pre-wired with:
 * - `start`, `exit`, `conditional`, and `codergen` handlers
 * - Shape mappings: `Mdiamond→start`, `Msquare→exit`, `diamond→conditional`, `box→codergen`
 * - Default handler: codergen (catches all unrecognised type/shape combinations)
 *
 * Story 42-10 adds codergen as the explicit "codergen" type, as the handler for
 * `shape=box` nodes, and as the registry-level default for any node that has no
 * recognised type or shape mapping.
 */
export function createDefaultRegistry(): HandlerRegistry {
  const registry = new HandlerRegistry()

  // Register built-in type handlers
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register('conditional', conditionalHandler)
  registry.register('codergen', createCodergenHandler())
  registry.register('tool', createToolHandler())
  registry.register('wait.human', createWaitHumanHandler())

  // Register DOT shape → canonical type mappings
  registry.registerShape('Mdiamond', 'start')
  registry.registerShape('Msquare', 'exit')
  registry.registerShape('diamond', 'conditional')
  registry.registerShape('box', 'codergen')

  // Set codergen as default for nodes with no recognised type or shape
  registry.setDefault(createCodergenHandler())

  return registry
}
