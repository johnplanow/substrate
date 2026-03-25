/**
 * ToolRegistry implementation.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import type { ToolDefinition, ToolResult, ExecutionEnvironment, IToolRegistry } from './types.js'

// ajv v6 — use require-style import for CJS compatibility under NodeNext
// The ajv package.json has "main": "lib/ajv.js" (CJS) without ESM exports,
// but TypeScript with NodeNext can still import it via the types.
import Ajv from 'ajv'

// ajv v6 validate function type (has .errors property)
type AjvValidateFunction = ((data: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; dataPath?: string; message?: string }>
}

const ajv = new Ajv({ allErrors: true, coerceTypes: false })

/**
 * Registry for tool definitions. Provides lookup, validation, and execution.
 */
export class ToolRegistry implements IToolRegistry {
  private readonly _tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    this._tools.set(tool.name, tool)
  }

  async execute(name: string, args: unknown, env: ExecutionEnvironment): Promise<ToolResult> {
    const tool = this._tools.get(name)
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true }
    }

    // Validate args against inputSchema
    const validate = ajv.compile(tool.inputSchema) as AjvValidateFunction
    const valid = validate(args)
    if (!valid) {
      const errors = validate.errors ?? []
      const messages = errors
        .map(e => {
          const path = e.instancePath ?? e.dataPath ?? ''
          return `${path} ${e.message ?? ''}`.trim()
        })
        .join(', ')
      return { content: `Validation failed for tool '${name}': ${messages}`, isError: true }
    }

    try {
      const result = await tool.executor(args, env)
      const content =
        tool.outputTruncation !== undefined && result.length > tool.outputTruncation
          ? result.slice(0, tool.outputTruncation) + '\n[truncated]'
          : result
      return { content, isError: false }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: message, isError: true }
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this._tools.get(name)
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this._tools.values())
  }
}
