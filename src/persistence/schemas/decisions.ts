/**
 * Zod schemas for the decision store persistence layer.
 *
 * Provides validation schemas for all decision store entities and their
 * inferred TypeScript types.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const PhaseEnum = z.enum(['analysis', 'planning', 'solutioning', 'implementation'])
export type Phase = z.infer<typeof PhaseEnum>

export const RequirementPriorityEnum = z.enum(['must', 'should', 'could', 'wont'])
export type RequirementPriority = z.infer<typeof RequirementPriorityEnum>

export const RequirementTypeEnum = z.enum(['functional', 'non_functional', 'constraint'])
export type RequirementType = z.infer<typeof RequirementTypeEnum>

export const PipelineRunStatusEnum = z.enum(['running', 'paused', 'completed', 'failed', 'stopped'])
export type PipelineRunStatus = z.infer<typeof PipelineRunStatusEnum>

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export const DecisionSchema = z.object({
  id: z.string().uuid(),
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  rationale: z.string().nullable().optional(),
  superseded_by: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type Decision = z.infer<typeof DecisionSchema>

export const CreateDecisionInputSchema = z.object({
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  rationale: z.string().nullable().optional(),
})
export type CreateDecisionInput = z.infer<typeof CreateDecisionInputSchema>

// ---------------------------------------------------------------------------
// Requirement
// ---------------------------------------------------------------------------

export const RequirementSchema = z.object({
  id: z.string().uuid(),
  pipeline_run_id: z.string().nullable().optional(),
  source: z.string().min(1),
  type: RequirementTypeEnum,
  description: z.string().min(1),
  priority: RequirementPriorityEnum,
  status: z.string().default('active'),
  created_at: z.string().optional(),
})
export type Requirement = z.infer<typeof RequirementSchema>

export const CreateRequirementInputSchema = z.object({
  pipeline_run_id: z.string().nullable().optional(),
  source: z.string().min(1),
  type: RequirementTypeEnum,
  description: z.string().min(1),
  priority: RequirementPriorityEnum,
})
export type CreateRequirementInput = z.infer<typeof CreateRequirementInputSchema>

// ---------------------------------------------------------------------------
// Constraint
// ---------------------------------------------------------------------------

export const ConstraintSchema = z.object({
  id: z.string().uuid(),
  pipeline_run_id: z.string().nullable().optional(),
  category: z.string().min(1),
  description: z.string().min(1),
  source: z.string().min(1),
  created_at: z.string().optional(),
})
export type Constraint = z.infer<typeof ConstraintSchema>

export const CreateConstraintInputSchema = z.object({
  pipeline_run_id: z.string().nullable().optional(),
  category: z.string().min(1),
  description: z.string().min(1),
  source: z.string().min(1),
})
export type CreateConstraintInput = z.infer<typeof CreateConstraintInputSchema>

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1),
  content_hash: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  created_at: z.string().optional(),
})
export type Artifact = z.infer<typeof ArtifactSchema>

export const RegisterArtifactInputSchema = z.object({
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1),
  content_hash: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
})
export type RegisterArtifactInput = z.infer<typeof RegisterArtifactInputSchema>

// ---------------------------------------------------------------------------
// PipelineRun
// ---------------------------------------------------------------------------

export const PipelineRunSchema = z.object({
  id: z.string().uuid(),
  methodology: z.string().min(1),
  current_phase: z.string().nullable().optional(),
  status: PipelineRunStatusEnum,
  config_json: z.string().nullable().optional(),
  token_usage_json: z.string().nullable().optional(),
  parent_run_id: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
})
export type PipelineRun = z.infer<typeof PipelineRunSchema>

export const CreatePipelineRunInputSchema = z.object({
  methodology: z.string().min(1),
  start_phase: z.string().nullable().optional(),
  config_json: z.string().nullable().optional(),
})
export type CreatePipelineRunInput = z.infer<typeof CreatePipelineRunInputSchema>

// ---------------------------------------------------------------------------
// TokenUsage
// ---------------------------------------------------------------------------

export const TokenUsageSchema = z.object({
  id: z.number().int().optional(),
  pipeline_run_id: z.string().nullable().optional(),
  phase: z.string().min(1),
  agent: z.string().min(1),
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  cost_usd: z.number().min(0).default(0),
  created_at: z.string().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

export const AddTokenUsageInputSchema = z.object({
  phase: z.string().min(1),
  agent: z.string().min(1),
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  cost_usd: z.number().min(0).default(0),
})
export type AddTokenUsageInput = z.infer<typeof AddTokenUsageInputSchema>
