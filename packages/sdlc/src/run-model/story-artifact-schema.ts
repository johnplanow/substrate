/**
 * Story-artifact frontmatter schema — Epic 64 / Story 64-2.
 *
 * Parses the optional YAML frontmatter block at the top of a story artifact
 * file (delimited by `---` fences) and validates it against the
 * StoryFrontmatterSchema. The `external_state_dependencies` field is the
 * machine-readable declaration that pairs with the `## Runtime Probes`
 * operational section: when a story declares external dependencies but has
 * no probes section, RuntimeProbeCheck escalates to error severity and
 * hard-gates SHIP_IT.
 *
 * Design notes:
 * - `ExternalStateDependencySchema` is `z.string()` (open enum) — the gate
 *   only cares about non-empty vs. empty. A closed enum risks false silences
 *   if agents invent novel category names (obs_2026-05-01_017 party-mode call).
 * - Parser returns the default (empty array) on ANY parse/validation failure
 *   so old story files without frontmatter continue to dispatch normally
 *   (backward-compat AC5).
 */

import { z } from 'zod'
import { load as yamlLoad } from 'js-yaml'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Open string enum for external-state dependency categories.
 * Suggested values: subprocess, filesystem, git, database, network,
 * registry, os. Open string so novel names don't cause silent skips.
 */
export const ExternalStateDependencySchema = z.string()

export const StoryFrontmatterSchema = z.object({
  external_state_dependencies: z.array(ExternalStateDependencySchema).optional().default([]),
})

export type StoryFrontmatter = z.infer<typeof StoryFrontmatterSchema>

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the optional YAML frontmatter block from a story artifact.
 *
 * Frontmatter must appear at the very start of the file, delimited by
 * `---\n` lines:
 *
 * ```
 * ---
 * external_state_dependencies:
 *   - subprocess
 *   - git
 * ---
 * # Story Title
 * ...
 * ```
 *
 * Returns `StoryFrontmatterSchema.parse({})` (i.e. `{ external_state_dependencies: [] }`)
 * on any of:
 *   - No frontmatter block present
 *   - Frontmatter YAML is malformed
 *   - Frontmatter fields fail Zod validation
 *
 * This preserves backward-compatibility: stories without a frontmatter
 * block (i.e. every story created before Epic 64) continue to pass the
 * external-state-dependencies gate because the empty array is the "no
 * dependencies declared" default.
 */
export function parseStoryFrontmatter(content: string): StoryFrontmatter {
  // Match optional leading `---\n...\n---\n` block
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  if (!match) return StoryFrontmatterSchema.parse({})
  try {
    const raw = yamlLoad(match[1] ?? '')
    return StoryFrontmatterSchema.parse(raw ?? {})
  } catch {
    // Malformed frontmatter — treat as empty (backward-compat)
    return StoryFrontmatterSchema.parse({})
  }
}
