/**
 * Types and Zod schemas for the context-compiler module.
 *
 * Provides all data structures used to describe task descriptors,
 * context templates, section definitions, store queries, and compile results.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// StoreQuery
// ---------------------------------------------------------------------------

export const StoreQuerySchema = z.object({
  table: z.enum(['decisions', 'requirements', 'constraints', 'artifacts']),
  filters: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
})
export type StoreQuery = z.infer<typeof StoreQuerySchema>

// ---------------------------------------------------------------------------
// TemplateSection
// ---------------------------------------------------------------------------

export const TemplateSectionSchema = z.object({
  name: z.string().min(1),
  priority: z.enum(['required', 'important', 'optional']),
  query: StoreQuerySchema,
  format: z.custom<(items: unknown[]) => string>((val) => typeof val === 'function'),
})
export type TemplateSection = z.infer<typeof TemplateSectionSchema>

// ---------------------------------------------------------------------------
// ContextTemplate
// ---------------------------------------------------------------------------

export const ContextTemplateSchema = z.object({
  taskType: z.string().min(1),
  sections: z.array(TemplateSectionSchema),
})
export type ContextTemplate = z.infer<typeof ContextTemplateSchema>

// ---------------------------------------------------------------------------
// TaskDescriptor
// ---------------------------------------------------------------------------

export const TaskDescriptorSchema = z.object({
  taskType: z.string().min(1),
  pipelineRunId: z.string().min(1),
  tokenBudget: z.number().int().positive(),
  overrides: z.record(z.string(), z.string()).optional(),
})
export type TaskDescriptor = z.infer<typeof TaskDescriptorSchema>

// ---------------------------------------------------------------------------
// SectionReport
// ---------------------------------------------------------------------------

export const SectionReportSchema = z.object({
  name: z.string(),
  priority: z.string(),
  tokens: z.number().int().min(0),
  included: z.boolean(),
  truncated: z.boolean(),
})
export type SectionReport = z.infer<typeof SectionReportSchema>

// ---------------------------------------------------------------------------
// CompileResult
// ---------------------------------------------------------------------------

export const CompileResultSchema = z.object({
  prompt: z.string(),
  tokenCount: z.number().int().min(0),
  sections: z.array(SectionReportSchema),
  truncated: z.boolean(),
})
export type CompileResult = z.infer<typeof CompileResultSchema>

// ---------------------------------------------------------------------------
// ContextCompiler interface
// ---------------------------------------------------------------------------

/**
 * ContextCompiler — public interface for the context-compiler module.
 *
 * Defines the contract that all context compiler implementations must satisfy.
 */
export interface ContextCompiler {
  /**
   * Compile a minimal prompt from the decision store for the given task
   * descriptor. Returns a CompileResult containing the assembled prompt,
   * its token count, per-section reports, and a flag indicating whether
   * any sections were truncated or omitted.
   *
   * @throws {Error} if no template is registered for `descriptor.taskType`
   */
  compile(descriptor: TaskDescriptor): Promise<CompileResult>

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
