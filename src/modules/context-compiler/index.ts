/**
 * context-compiler module — public API re-exports
 */

export type { ContextCompiler } from './context-compiler.js'

export {
  ContextCompilerImpl,
  createContextCompiler,
} from './context-compiler-impl.js'

export type { ContextCompilerOptions } from './context-compiler-impl.js'

export {
  countTokens,
  truncateToTokens,
} from './token-counter.js'

export type {
  TaskDescriptor,
  ContextTemplate,
  TemplateSection,
  StoreQuery,
  SectionReport,
  CompileResult,
} from './types.js'

export {
  TaskDescriptorSchema,
  ContextTemplateSchema,
  TemplateSectionSchema,
  StoreQuerySchema,
  SectionReportSchema,
  CompileResultSchema,
} from './types.js'
