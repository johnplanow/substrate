/**
 * Template registry and helpers for `substrate init --template <name>`.
 *
 * Defines the built-in task graph templates and provides lookup utilities.
 * Template YAML files live in src/cli/templates/ and are read at runtime.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// ESM-compatible path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to the templates directory, relative to this source file.
// In src: src/cli/commands/../templates = src/cli/templates
// In dist: dist/cli/commands/../templates = dist/cli/templates
const TEMPLATES_DIR = join(__dirname, '..', 'templates')

/**
 * Get the absolute path to a template YAML file.
 *
 * @param templateName - Template name (without .yaml extension)
 * @returns Absolute path to the template file
 */
export function getTemplatePath(templateName: string): string {
  return join(TEMPLATES_DIR, `${templateName}.yaml`)
}

// ---------------------------------------------------------------------------
// TemplateDefinition interface
// ---------------------------------------------------------------------------

/**
 * Describes a built-in task graph template.
 */
export interface TemplateDefinition {
  /** Unique name used with --template <name> */
  name: string
  /** One-line description shown in --list-templates output */
  description: string
  /** Absolute path to the .yaml source file */
  filePath: string
  /** Number of tasks in this template */
  taskCount: number
}

// ---------------------------------------------------------------------------
// Built-in template registry
// ---------------------------------------------------------------------------

/**
 * Static list of all built-in templates.
 * Add new templates here and create the corresponding YAML file in src/cli/templates/.
 */
export const BUILT_IN_TEMPLATES: TemplateDefinition[] = [
  {
    name: 'sequential',
    description: 'A series of tasks that run one after another',
    filePath: getTemplatePath('sequential'),
    taskCount: 3,
  },
  {
    name: 'parallel',
    description: 'A set of tasks that all run concurrently',
    filePath: getTemplatePath('parallel'),
    taskCount: 4,
  },
  {
    name: 'review-cycle',
    description: 'Implementation followed by code review and revision',
    filePath: getTemplatePath('review-cycle'),
    taskCount: 3,
  },
  {
    name: 'research-then-implement',
    description: 'Research phase feeding into parallel implementation tasks',
    filePath: getTemplatePath('research-then-implement'),
    taskCount: 5,
  },
]

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Look up a template by name.
 *
 * @param name - Template name (case-sensitive)
 * @returns The TemplateDefinition, or undefined if not found
 */
export function getTemplate(name: string): TemplateDefinition | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.name === name)
}

/**
 * Return all built-in templates.
 */
export function listTemplates(): TemplateDefinition[] {
  return BUILT_IN_TEMPLATES
}
