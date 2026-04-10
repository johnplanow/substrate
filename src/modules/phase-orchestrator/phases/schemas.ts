/**
 * Shared Zod schemas for all phase output contracts in the Phase Orchestrator.
 *
 * Each phase defines an output schema that the dispatcher uses to validate
 * the agent's YAML output against before returning a typed result.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Analysis phase schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for the ProductBrief structure emitted by the analysis agent.
 * Validates that all required fields are present and non-empty.
 */
export const ProductBriefSchema = z.object({
  problem_statement: z.string().min(10),
  target_users: z.array(z.string().min(1)).min(1),
  core_features: z.array(z.string().min(1)).min(1),
  success_metrics: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()).default([]),
  technology_constraints: z.array(z.string()).optional().default([]),
})

export type ProductBriefSchemaType = z.infer<typeof ProductBriefSchema>

/**
 * Zod schema for the full YAML output emitted by the analysis agent.
 * The agent must emit a YAML block with `result` and `product_brief` fields.
 */
export const AnalysisOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  product_brief: ProductBriefSchema,
})

export type AnalysisOutputSchemaType = z.infer<typeof AnalysisOutputSchema>

// ---------------------------------------------------------------------------
// Analysis step-level schemas (multi-step decomposition)
// ---------------------------------------------------------------------------

/**
 * Step 1 output: Vision & problem analysis.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const AnalysisVisionOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  problem_statement: z.string().min(10).optional(),
  target_users: z.array(z.string().min(1)).min(1).optional(),
})

export type AnalysisVisionOutputSchemaType = z.infer<typeof AnalysisVisionOutputSchema>

/**
 * Step 2 output: Scope & features (builds on vision output).
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const AnalysisScopeOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  core_features: z.array(z.string().min(1)).min(1).optional(),
  success_metrics: z.array(z.string().min(1)).min(1).optional(),
  constraints: z.array(z.string()).default([]),
  technology_constraints: z.array(z.string()).optional().default([]),
})

export type AnalysisScopeOutputSchemaType = z.infer<typeof AnalysisScopeOutputSchema>

// ---------------------------------------------------------------------------
// Planning phase schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single functional requirement.
 */
export const FunctionalRequirementSchema = z.object({
  description: z.string().min(5),
  priority: z.enum(['must', 'should', 'could']).default('must'),
})

export type FunctionalRequirementSchemaType = z.infer<typeof FunctionalRequirementSchema>

/**
 * Zod schema for a single non-functional requirement.
 */
export const NonFunctionalRequirementSchema = z.object({
  description: z.string().min(5),
  category: z.string().min(1),
})

export type NonFunctionalRequirementSchemaType = z.infer<typeof NonFunctionalRequirementSchema>

/**
 * Zod schema for a single user story.
 */
export const UserStorySchema = z.object({
  title: z.string().min(3),
  description: z.string().min(5),
})

export type UserStorySchemaType = z.infer<typeof UserStorySchema>

/**
 * Zod schema for the full YAML output emitted by the planning agent.
 * The agent must emit a YAML block with all PRD fields.
 */
export const PlanningOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  functional_requirements: z.array(FunctionalRequirementSchema).min(3),
  non_functional_requirements: z.array(NonFunctionalRequirementSchema).min(2),
  user_stories: z.array(UserStorySchema).min(1),
  tech_stack: z.record(z.string(), z.string()),
  domain_model: z.record(z.string(), z.unknown()),
  out_of_scope: z.array(z.string()).default([]),
})

export type PlanningOutputSchemaType = z.infer<typeof PlanningOutputSchema>

// ---------------------------------------------------------------------------
// Planning step-level schemas (multi-step decomposition)
// ---------------------------------------------------------------------------

/**
 * Step 1 output: Project classification & vision.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const PlanningClassificationOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  project_type: z.string().min(1).optional(),
  vision: z.string().min(10).optional(),
  key_goals: z.array(z.string().min(1)).min(1).optional(),
})

export type PlanningClassificationOutputSchemaType = z.infer<
  typeof PlanningClassificationOutputSchema
>

/**
 * Step 2 output: Functional requirements & user stories.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const PlanningFRsOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  functional_requirements: z.array(FunctionalRequirementSchema).min(3).optional(),
  user_stories: z.array(UserStorySchema).min(1).optional(),
})

export type PlanningFRsOutputSchemaType = z.infer<typeof PlanningFRsOutputSchema>

/**
 * Step 3 output: NFRs, tech stack, domain model, out-of-scope.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const PlanningNFRsOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  non_functional_requirements: z.array(NonFunctionalRequirementSchema).min(2).optional(),
  tech_stack: z.record(z.string(), z.string()).optional(),
  domain_model: z.record(z.string(), z.unknown()).optional(),
  out_of_scope: z.array(z.string()).default([]),
})

export type PlanningNFRsOutputSchemaType = z.infer<typeof PlanningNFRsOutputSchema>

// ---------------------------------------------------------------------------
// Solutioning phase schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single architecture decision emitted by the architecture agent.
 */
export const ArchitectureDecisionSchema = z.object({
  category: z.string().min(1),
  key: z.string().min(1),
  value: z.string().min(1),
  rationale: z.string().optional(),
})

export type ArchitectureDecisionSchemaType = z.infer<typeof ArchitectureDecisionSchema>

/**
 * Zod schema for a single story definition emitted by the story generation agent.
 */
export const StoryDefinitionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(3),
  description: z.string().min(5),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  priority: z.enum(['must', 'should', 'could']).default('must'),
})

export type StoryDefinitionSchemaType = z.infer<typeof StoryDefinitionSchema>

/**
 * Zod schema for a single epic definition emitted by the story generation agent.
 */
export const EpicDefinitionSchema = z.object({
  title: z.string().min(3),
  description: z.string().min(5),
  stories: z.array(StoryDefinitionSchema).min(1),
})

export type EpicDefinitionSchemaType = z.infer<typeof EpicDefinitionSchema>

/**
 * Zod schema for the full YAML output emitted by the architecture agent.
 */
export const ArchitectureOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  architecture_decisions: z.array(ArchitectureDecisionSchema).min(1),
})

export type ArchitectureOutputSchemaType = z.infer<typeof ArchitectureOutputSchema>

/**
 * Zod schema for the full YAML output emitted by the story generation agent.
 */
export const StoryGenerationOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  epics: z.array(EpicDefinitionSchema).min(1),
})

export type StoryGenerationOutputSchemaType = z.infer<typeof StoryGenerationOutputSchema>

// ---------------------------------------------------------------------------
// Solutioning step-level schemas (multi-step decomposition)
// ---------------------------------------------------------------------------

/**
 * Architecture Step 1 output: Context analysis — initial architecture decisions.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const ArchContextOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  architecture_decisions: z.array(ArchitectureDecisionSchema).min(1).optional(),
})

export type ArchContextOutputSchemaType = z.infer<typeof ArchContextOutputSchema>

/**
 * Epic Design Step output: Epic structure with FR coverage mapping.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const EpicDesignOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  epics: z
    .array(
      z.object({
        title: z.string().min(3),
        description: z.string().min(5),
        fr_coverage: z.array(z.string()).default([]),
      })
    )
    .min(1)
    .optional(),
})

export type EpicDesignOutputSchemaType = z.infer<typeof EpicDesignOutputSchema>

// ---------------------------------------------------------------------------
// UX Design phase schemas (Story 16.5)
// ---------------------------------------------------------------------------

/**
 * Step 1 output: UX Discovery + Core Experience.
 * Covers user personas, core experience goals, and emotional response targets.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const UxDiscoveryOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  target_personas: z.array(z.string().min(1)).optional(),
  core_experience: z.string().optional(),
  emotional_goals: z.array(z.string().min(1)).optional(),
  inspiration_references: z.array(z.string()).default([]),
})

export type UxDiscoveryOutputSchemaType = z.infer<typeof UxDiscoveryOutputSchema>

/**
 * Step 2 output: Design System + Visual Foundation.
 * Covers design system approach, visual language, and design directions.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const UxDesignSystemOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  design_system: z.string().optional(),
  visual_foundation: z.string().optional(),
  design_principles: z.array(z.string().min(1)).optional(),
  color_and_typography: z.string().optional(),
})

export type UxDesignSystemOutputSchemaType = z.infer<typeof UxDesignSystemOutputSchema>

/**
 * Step 3 output: User Journeys + Component Strategy + Accessibility.
 * Covers user flows, component architecture, UX patterns, and a11y guidelines.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const UxJourneysOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  user_journeys: z.array(z.string().min(1)).optional(),
  component_strategy: z.string().optional(),
  ux_patterns: z.array(z.string()).default([]),
  accessibility_guidelines: z.array(z.string()).default([]),
})

export type UxJourneysOutputSchemaType = z.infer<typeof UxJourneysOutputSchema>

// ---------------------------------------------------------------------------
// Research phase schemas (Story 20-2)
// ---------------------------------------------------------------------------

/**
 * Step 1 output: Research Discovery.
 * Covers concept classification and raw findings across market, domain, and technical dimensions.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const ResearchDiscoveryOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  concept_classification: z.string().optional(),
  market_findings: z.string().optional(),
  domain_findings: z.string().optional(),
  technical_findings: z.string().optional(),
})

export type ResearchDiscoveryOutputSchemaType = z.infer<typeof ResearchDiscoveryOutputSchema>

/**
 * Step 2 output: Research Synthesis.
 * Covers distilled research findings, risk flags, and opportunity signals.
 * Content fields are optional to allow `{result: 'failed'}` without Zod rejection.
 */
export const ResearchSynthesisOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  market_context: z.string().optional(),
  competitive_landscape: z.string().optional(),
  technical_feasibility: z.string().optional(),
  risk_flags: z.array(z.string()).default([]),
  opportunity_signals: z.array(z.string()).default([]),
})

export type ResearchSynthesisOutputSchemaType = z.infer<typeof ResearchSynthesisOutputSchema>

// ---------------------------------------------------------------------------
// Elicitation output schema (Story 16.3)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the YAML output emitted by an elicitation sub-agent.
 * The agent returns structured insights from applying an elicitation method.
 */
export const ElicitationOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  insights: z.string(),
})

export type ElicitationOutputSchemaType = z.infer<typeof ElicitationOutputSchema>
