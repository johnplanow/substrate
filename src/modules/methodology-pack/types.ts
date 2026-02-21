/**
 * Types for the methodology pack system.
 *
 * A methodology pack is a pluggable content bundle that defines:
 *  - Phase definitions (pipeline execution order)
 *  - Compiled prompt templates (create-story, dev-story, code-review)
 *  - Constraint rules (validation checks for quality gates)
 *  - Story templates
 */

// ---------------------------------------------------------------------------
// Phase Definition
// ---------------------------------------------------------------------------

/**
 * A phase in the development pipeline.
 */
export interface PhaseDefinition {
  name: string
  description: string
  entryGates: string[]
  exitGates: string[]
  artifacts: string[]
}

// ---------------------------------------------------------------------------
// Constraint Rule
// ---------------------------------------------------------------------------

/** Severity level for a constraint rule */
export type ConstraintSeverity = 'required' | 'recommended' | 'optional'

/**
 * A single constraint rule used by quality gates.
 */
export interface ConstraintRule {
  name: string
  description: string
  severity: ConstraintSeverity
  check: string
}

// ---------------------------------------------------------------------------
// Pack Manifest
// ---------------------------------------------------------------------------

/**
 * The manifest.yaml schema for a methodology pack.
 * Must be present at the root of the pack directory.
 */
export interface PackManifest {
  name: string
  version: string
  description: string
  phases: PhaseDefinition[]
  /** Map of task type → relative path to prompt file */
  prompts: Record<string, string>
  /** Map of phase/task type → relative path to constraints file */
  constraints: Record<string, string>
  /** Map of template name → relative path to template file */
  templates: Record<string, string>
}

// ---------------------------------------------------------------------------
// Pack Discovery
// ---------------------------------------------------------------------------

/**
 * Lightweight info about a discovered pack (before loading).
 */
export interface PackInfo {
  name: string
  path: string
}

// ---------------------------------------------------------------------------
// MethodologyPack interface
// ---------------------------------------------------------------------------

/**
 * A loaded methodology pack with lazy-loaded content access.
 */
export interface MethodologyPack {
  /** The validated manifest */
  readonly manifest: PackManifest

  /** Return the ordered list of phases */
  getPhases(): PhaseDefinition[]

  /**
   * Return the compiled prompt template for the given task type.
   * Files are lazy-loaded and cached after first access.
   * Variables ({{phase}}, {{methodology}}, {{constraints}}) are interpolated.
   *
   * @param taskType - key matching a prompts entry in the manifest
   * @throws if the task type is not in the manifest or file is missing
   */
  getPrompt(taskType: string): Promise<string>

  /**
   * Return the constraint rules for the given phase/task type.
   * Files are lazy-loaded and cached after first access.
   *
   * @param phase - key matching a constraints entry in the manifest
   * @throws if the phase is not in the manifest or file is missing
   */
  getConstraints(phase: string): Promise<ConstraintRule[]>

  /**
   * Return the raw content of a template file.
   * Files are lazy-loaded and cached after first access.
   *
   * @param name - key matching a templates entry in the manifest
   * @throws if the template name is not in the manifest or file is missing
   */
  getTemplate(name: string): Promise<string>
}
