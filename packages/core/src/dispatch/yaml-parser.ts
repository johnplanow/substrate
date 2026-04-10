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

const YAML_ANCHOR_KEYS = ['result:', 'verdict:', 'story_file:', 'expansion_priority:']

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

  // Fall back to unfenced YAML starting with a known anchor key.
  // First, strip any trailing markdown fence that may be wrapping the YAML
  // (LLMs frequently emit ```yaml\n...\n``` even when told not to).
  const stripped = stripTrailingFence(output)
  const unfenced = extractUnfencedYaml(stripped)
  if (unfenced !== null) {
    return unfenced
  }

  // Fall back to JSON extraction — some backends (e.g., Codex with --json)
  // emit structured JSON objects instead of YAML. Try to find a JSON object
  // containing anchor keys and convert it to YAML for downstream parsing.
  return extractJsonAsYaml(output)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip a trailing markdown fence that wraps the entire remaining output.
 * Handles: "```yaml\nverdict: ...\n```" → "verdict: ..."
 */
function stripTrailingFence(output: string): string {
  const trimmed = output.trimEnd()
  if (!trimmed.endsWith('```')) return output
  // Walk backwards past the closing fence
  const body = trimmed.slice(0, -3).trimEnd()
  // Find the opening fence — it must be the last ``` or ```yaml line before the body
  const lastOpen = body.lastIndexOf('```')
  if (lastOpen === -1) return output
  // Verify the opening fence is on its own line (possibly with "yaml" suffix)
  const beforeFence = body.slice(0, lastOpen)
  const fenceLine = body.slice(lastOpen)
  if (beforeFence.length > 0 && !beforeFence.endsWith('\n')) return output
  // Strip the opening fence line
  const afterOpen = fenceLine.replace(/^```(?:yaml)?\s*\n?/, '')
  return beforeFence + afterOpen
}

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
 * Try to extract a JSON object from the output and convert it to YAML.
 *
 * Scans for JSON objects (delimited by { ... }) that contain at least one
 * anchor key. Tries the last such object. Converts via yaml.dump so
 * downstream parseYamlResult can validate it with the same Zod schema.
 */
function extractJsonAsYaml(output: string): string | null {
  // Find all top-level JSON object candidates (greedy { ... } blocks)
  const jsonPattern = /\{[\s\S]*?\n\}/g
  let lastJsonObj: Record<string, unknown> | null = null
  let match: RegExpExecArray | null

  while ((match = jsonPattern.exec(output)) !== null) {
    const candidate = match[0]
    // Quick check: must contain at least one anchor key
    if (!YAML_ANCHOR_KEYS.some((key) => candidate.includes(key.replace(':', '')))) {
      continue
    }
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        lastJsonObj = parsed as Record<string, unknown>
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  if (lastJsonObj === null) {
    return null
  }

  // Convert to YAML string for parseYamlResult
  try {
    return yaml.dump(lastJsonObj, { lineWidth: -1 })
  } catch {
    return null
  }
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
// Duplicate key merging
// ---------------------------------------------------------------------------

/**
 * Merge duplicate top-level YAML keys by concatenating their array values.
 *
 * LLMs sometimes emit the same mapping key twice, splitting a list across two
 * blocks (e.g., `non_functional_requirements:` appears twice, each with
 * different items). This violates YAML 1.2 but is recoverable: we detect
 * duplicate top-level keys and merge their children into a single key.
 *
 * Only operates on top-level keys (no indentation). Nested duplicates are not
 * handled — they're rare in practice and harder to fix safely.
 */
function mergeDuplicateYamlKeys(yamlText: string): string {
  const lines = yamlText.split('\n')
  const sections: { key: string; lines: string[] }[] = []
  let current: { key: string; lines: string[] } | null = null

  for (const line of lines) {
    // Top-level key: starts at column 0, ends with ':'
    const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (keyMatch) {
      const key = keyMatch[1]!
      const rest = keyMatch[2]!.trim()
      // If the rest is non-empty and not a comment, it's an inline value (scalar)
      // — still start a new section for it
      current = { key, lines: [line] }
      sections.push(current)

      // Skip merging for inline scalar values (e.g., `result: success`)
      if (rest.length > 0 && !rest.startsWith('#')) {
        current = null
      }
    } else if (current) {
      current.lines.push(line)
    } else {
      // Lines before any key or after an inline scalar — emit as-is
      sections.push({ key: '', lines: [line] })
    }
  }

  // Find duplicates and merge
  const seen = new Map<string, number>()
  const merged: typeof sections = []

  for (const section of sections) {
    if (section.key === '') {
      merged.push(section)
      continue
    }

    const existing = seen.get(section.key)
    if (existing !== undefined) {
      // Merge: append the child lines (skip the key line itself)
      const target = merged[existing]!
      target.lines.push(...section.lines.slice(1))
    } else {
      seen.set(section.key, merged.length)
      merged.push(section)
    }
  }

  return merged.flatMap((s) => s.lines).join('\n')
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
    raw = yaml.load(sanitizeYamlEscapes(yamlText))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // LLMs sometimes emit the same top-level key twice (e.g., listing items
    // under `non_functional_requirements:` in two separate blocks). Attempt
    // to merge duplicate keys before giving up.
    if (message.includes('duplicated mapping key')) {
      try {
        raw = yaml.load(sanitizeYamlEscapes(mergeDuplicateYamlKeys(yamlText)))
      } catch {
        return { parsed: null, error: `YAML parse error: ${message}` }
      }
    } else {
      return { parsed: null, error: `YAML parse error: ${message}` }
    }
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

// ---------------------------------------------------------------------------
// YAML escape sanitization
// ---------------------------------------------------------------------------

/**
 * Valid YAML escape sequences in double-quoted strings (YAML 1.2 spec).
 * Any backslash followed by a character NOT in this set is invalid.
 */
const VALID_YAML_ESCAPES = new Set([
  '0',
  'a',
  'b',
  't',
  '\t',
  'n',
  'v',
  'f',
  'r',
  'e',
  ' ',
  '"',
  '/',
  '\\',
  'N',
  '_',
  'L',
  'P',
  'x',
  'u',
  'U',
])

/**
 * Sanitize invalid backslash escape sequences in YAML double-quoted strings.
 *
 * LLMs frequently emit invalid escapes like `\$` or `\#` inside double-quoted
 * YAML values (e.g., `vi.mock('\$lib/types/review')`). js-yaml rejects these.
 * This function strips the backslash from invalid sequences, turning `\$` → `$`.
 *
 * Only operates within double-quoted string regions to avoid corrupting
 * single-quoted strings, block scalars, or unquoted values.
 */
function sanitizeYamlEscapes(yamlText: string): string {
  // Process each line — only fix invalid escapes inside double-quoted segments
  return yamlText.replace(/"(?:[^"\\]|\\.)*"/g, (match) => {
    return match.replace(/\\(.)/g, (esc, ch: string) => {
      if (VALID_YAML_ESCAPES.has(ch)) return esc // valid escape, keep it
      return ch // invalid escape like \$ → just the character
    })
  })
}
