/**
 * ContextCompiler — public interface for the context-compiler module.
 *
 * Defines the contract that all context compiler implementations must satisfy.
 */

import type { TaskDescriptor, ContextTemplate, CompileResult } from './types.js'

// ---------------------------------------------------------------------------
// ContextCompiler interface
// ---------------------------------------------------------------------------

export interface ContextCompiler {
  /**
   * Compile a minimal prompt from the decision store for the given task
   * descriptor. Returns a CompileResult containing the assembled prompt,
   * its token count, per-section reports, and a flag indicating whether
   * any sections were truncated or omitted.
   *
   * @throws {Error} if no template is registered for `descriptor.taskType`
   */
  compile(descriptor: TaskDescriptor): CompileResult

  /**
   * Register a context template for a given task type. Overwrites any
   * previously registered template for the same task type.
   */
  registerTemplate(template: ContextTemplate): void

  /**
   * Retrieve the registered template for a task type.
   * Returns `undefined` if no template has been registered for that type.
   */
  getTemplate(taskType: string): ContextTemplate | undefined
}
