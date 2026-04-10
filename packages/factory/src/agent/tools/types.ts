/**
 * Core type definitions for the agent tool system.
 * Story 48-6: Provider-Aligned Tool Sets
 */

/**
 * Represents the execution environment for tools.
 * Interface (not a class) to enable test mocking.
 */
export interface ExecutionEnvironment {
  workdir: string
  exec(command: string, timeoutMs: number): Promise<ShellResult>
}

/**
 * Result of a shell command execution.
 */
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Result returned from a tool execution.
 */
export interface ToolResult {
  content: string
  isError: boolean
}

/**
 * Error thrown when tool argument validation fails.
 */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolValidationError'
  }
}

/**
 * Definition of a tool that can be registered with the ToolRegistry.
 * The executor uses `any` for args to avoid covariance/contravariance issues
 * when collecting tools of different arg types into a single array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<TArgs = any> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputTruncation?: number
  executor: (args: TArgs, env: ExecutionEnvironment) => Promise<string>
}

/**
 * Interface for the ToolRegistry.
 */
export interface IToolRegistry {
  register(tool: ToolDefinition): void
  execute(name: string, args: unknown, env: ExecutionEnvironment): Promise<ToolResult>
  get(name: string): ToolDefinition | undefined
  getDefinitions(): ToolDefinition[]
}
