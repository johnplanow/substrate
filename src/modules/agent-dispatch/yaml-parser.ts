/**
 * YAML extraction and parsing for sub-agent output.
 *
 * Sub-agents emit structured YAML at the END of their output. This module
 * extracts and validates that YAML block regardless of surrounding narrative
 * text, reasoning, or code fences.
 *
 * Extraction strategy:
 * 1. Scan from the END of the output (YAML is always last per output contract)
 * 2. Look for fenced YAML blocks (```yaml...```) first
 * 3. Fall back to unfenced lines starting with known anchor keys
 * 4. If multiple YAML blocks exist, take the LAST one
 * 5. Parse with js-yaml and optionally validate with Zod schema
 */

import yaml from 'js-yaml'
import type { ZodSchema } from 'zod'

// ---------------------------------------------------------------------------
// Known anchor keys that indicate the start of a YAML result block
// ---------------------------------------------------------------------------

const YAML_ANCHOR_KEYS = ['result:', 'verdict:', 'story_file:']

// ---------------------------------------------------------------------------
// extractYamlBlock
// ---------------------------------------------------------------------------

/**
 * Extract the YAML result block from sub-agent output.
 *
 * Scans from the end of the output looking for:
 * - A fenced YAML block (```yaml...``` or ```...```)
 * - An unfenced block starting with a known anchor key
 *
 * If multiple blocks are found, the LAST one is returned.
 *
 * @param output - Raw stdout from the sub-agent process
 * @returns The raw YAML string, or null if no valid block is found
 */
export function extractYamlBlock(output: string): string | null {
  if (!output || output.trim() === '') {
    return null
  }

  // Try fenced blocks first — scan all occurrences and take last
  const fencedResult = extractLastFencedYaml(output)
  if (fencedResult !== null) {
    return fencedResult
  }

  // Fall back to unfenced YAML starting with a known anchor key
  return extractUnfencedYaml(output)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find all fenced YAML blocks (```yaml...``` or ```...```) and return the last one.
 */
function extractLastFencedYaml(output: string): string | null {
  // Match fenced blocks: ```yaml\n...\n``` or ```\n...\n```
  const fencePattern = /```(?:yaml)?\s*\n([\s\S]*?)```/g

  let lastMatch: string | null = null
  let match: RegExpExecArray | null

  while ((match = fencePattern.exec(output)) !== null) {
    const content = match[1]
    if (content !== undefined && content.trim() !== '' && containsAnchorKey(content)) {
      lastMatch = content.trim()
    }
  }

  return lastMatch
}

/**
 * Find unfenced YAML by scanning from the END of the output for anchor keys.
 *
 * Collects all contiguous YAML-like lines from the last anchor key occurrence.
 */
function extractUnfencedYaml(output: string): string | null {
  const lines = output.split('\n')

  // Scan from end to find the last anchor key occurrence
  let anchorLineIdx = -1

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line !== undefined && isAnchorLine(line)) {
      anchorLineIdx = i
      break
    }
  }

  if (anchorLineIdx === -1) {
    return null
  }

  // Collect lines from the anchor to the end (or until a non-YAML line)
  const yamlLines: string[] = []

  for (let i = anchorLineIdx; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined) {
      yamlLines.push(line)
    }
  }

  const yamlText = yamlLines.join('\n').trim()
  return yamlText !== '' ? yamlText : null
}

/**
 * Check if a line starts with one of the known anchor keys.
 */
function isAnchorLine(line: string): boolean {
  const trimmed = line.trim()
  return YAML_ANCHOR_KEYS.some((key) => trimmed.startsWith(key))
}

/**
 * Check if text content contains at least one anchor key.
 */
function containsAnchorKey(content: string): boolean {
  return YAML_ANCHOR_KEYS.some((key) => content.includes(key))
}

// ---------------------------------------------------------------------------
// parseYamlResult
// ---------------------------------------------------------------------------

/**
 * Parse a YAML string and optionally validate it against a Zod schema.
 *
 * @param yamlText - Raw YAML string to parse
 * @param schema   - Optional Zod schema for validation
 * @returns Object with parsed result and optional error
 */
export function parseYamlResult<T>(
  yamlText: string,
  schema?: ZodSchema<T>
): { parsed: T | null; error: string | null } {
  let raw: unknown

  try {
    raw = yaml.load(yamlText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { parsed: null, error: `YAML parse error: ${message}` }
  }

  if (raw === null || raw === undefined) {
    return { parsed: null, error: 'YAML parsed to null or undefined' }
  }

  if (schema === undefined) {
    // No schema — return the raw parsed value
    return { parsed: raw as T, error: null }
  }

  // Validate with Zod schema
  const result = schema.safeParse(raw)
  if (result.success) {
    return { parsed: result.data, error: null }
  }

  return {
    parsed: null,
    error: `Schema validation error: ${result.error.message}`,
  }
}
