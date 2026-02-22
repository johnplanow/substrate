/**
 * compiled-workflows module — Public API re-exports.
 *
 * Compiled workflow functions provide token-efficient sub-agent dispatch
 * for the core pipeline stages: create-story, dev-story, and code-review.
 */

// ---------------------------------------------------------------------------
// Workflow functions
// ---------------------------------------------------------------------------

export { runCreateStory } from './create-story.js'
export { runDevStory } from './dev-story.js'
export { runCodeReview } from './code-review.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  WorkflowDeps,
  CreateStoryParams,
  CreateStoryResult,
  DevStoryParams,
  DevStoryResult,
  CodeReviewParams,
  CodeReviewResult,
  CodeReviewIssue,
} from './types.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export {
  CreateStoryResultSchema,
  DevStoryResultSchema,
  CodeReviewResultSchema,
  CodeReviewIssueSchema,
} from './schemas.js'

export type {
  CreateStorySchemaOutput,
  DevStorySchemaOutput,
  CodeReviewSchemaOutput,
  CodeReviewIssueSchemaOutput,
} from './schemas.js'

// ---------------------------------------------------------------------------
// Prompt assembler
// ---------------------------------------------------------------------------

export { assemblePrompt } from './prompt-assembler.js'
export type { PromptSection, AssembleResult, SectionPriority } from './prompt-assembler.js'

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

export { getGitDiffSummary, getGitDiffStatSummary } from './git-helpers.js'
