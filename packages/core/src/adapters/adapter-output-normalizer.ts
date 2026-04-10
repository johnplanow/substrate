/**
 * AdapterOutputNormalizer — multi-strategy YAML extraction for adapter output.
 *
 * When an adapter produces output that fails standard YAML extraction, this
 * normalizer applies a sequence of additional strategies to recover parseable
 * YAML. Each strategy is tried in order; the first success is returned.
 *
 * Strategies (in order):
 *   1. 'standard'       — call extractYamlBlock() directly
 *   2. 'strip-prose'    — remove leading prose lines, retry extractYamlBlock()
 *   3. 'strip-markdown' — strip line-leading markdown artifacts, retry
 *   4. 'json-fallback'  — find embedded JSON containing anchor keys, dump to YAML
 *
 * If all strategies fail, returns an AdapterFormatError with diagnostic fields.
 *
 * Architecture note: this file may import from packages/core/src/dispatch/yaml-parser.ts
 * (same package) but must NOT import from @substrate-ai/sdlc, src/modules/, or any
 * file outside packages/core/.
 */

import yaml from 'js-yaml'
import { extractYamlBlock } from '../dispatch/yaml-parser.js'
import { AdapterFormatError } from './adapter-format-error.js'

// ---------------------------------------------------------------------------
// Known anchor keys (without colon) used to identify YAML result blocks
// ---------------------------------------------------------------------------

const YAML_ANCHOR_KEYS = ['result:', 'verdict:', 'story_file:', 'expansion_priority:']
const YAML_ANCHOR_KEYS_BARE = YAML_ANCHOR_KEYS.map((k) => k.replace(':', ''))

// ---------------------------------------------------------------------------
// Minimal logger interface (compatible with ILogger from dispatch/types.ts)
// ---------------------------------------------------------------------------

interface ILogger {
  debug(...args: unknown[]): void
  warn(...args: unknown[]): void
}

// ---------------------------------------------------------------------------
// AdapterOutputNormalizer
// ---------------------------------------------------------------------------

/**
 * Multi-strategy YAML extractor for adapter output.
 *
 * Inject into DispatcherImpl via constructor parameter so it can be mocked in
 * unit tests. Default to `new AdapterOutputNormalizer()` if not provided.
 */
export class AdapterOutputNormalizer {
  private readonly _logger: ILogger

  constructor(logger: ILogger = console) {
    this._logger = logger
  }

  /**
   * Attempt to extract valid YAML from raw adapter output.
   *
   * Tries strategies in order and returns the first successful extraction.
   * If all strategies are exhausted, returns an AdapterFormatError (does NOT throw).
   *
   * @param rawOutput  - Full stdout string from the adapter process
   * @param adapterId  - Adapter identifier for error diagnostics and logging
   * @returns `{ yaml: string; strategy: string }` on success, or `AdapterFormatError` on exhaustion
   */
  normalize(
    rawOutput: string,
    adapterId: string
  ): { yaml: string; strategy: string } | AdapterFormatError {
    const tried: string[] = []
    let lastError = 'no_yaml_block'

    // -----------------------------------------------------------------------
    // Strategy 1: 'standard' — call extractYamlBlock() directly
    // -----------------------------------------------------------------------
    {
      const strategy = 'standard'
      tried.push(strategy)
      const result = extractYamlBlock(rawOutput)
      if (result !== null) {
        return { yaml: result, strategy }
      }
      this._logger.debug({ adapterId, strategy }, 'Normalizer strategy failed')
      lastError = 'extractYamlBlock returned null'
    }

    // -----------------------------------------------------------------------
    // Strategy 2: 'strip-prose' — remove leading non-YAML lines, retry
    // -----------------------------------------------------------------------
    {
      const strategy = 'strip-prose'
      tried.push(strategy)
      const stripped = stripLeadingProse(rawOutput)
      if (stripped !== rawOutput) {
        const result = extractYamlBlock(stripped)
        if (result !== null) {
          return { yaml: result, strategy }
        }
      }
      this._logger.debug({ adapterId, strategy }, 'Normalizer strategy failed')
      lastError = 'strip-prose: extractYamlBlock returned null after prose removal'
    }

    // -----------------------------------------------------------------------
    // Strategy 3: 'strip-markdown' — remove line-leading markdown artifacts
    // -----------------------------------------------------------------------
    {
      const strategy = 'strip-markdown'
      tried.push(strategy)
      const cleaned = stripMarkdownArtifacts(rawOutput)
      if (cleaned !== rawOutput) {
        const result = extractYamlBlock(cleaned)
        if (result !== null) {
          return { yaml: result, strategy }
        }
      }
      this._logger.debug({ adapterId, strategy }, 'Normalizer strategy failed')
      lastError = 'strip-markdown: extractYamlBlock returned null after markdown removal'
    }

    // -----------------------------------------------------------------------
    // Strategy 4: 'json-fallback' — parse embedded JSON, dump to YAML
    // -----------------------------------------------------------------------
    {
      const strategy = 'json-fallback'
      tried.push(strategy)
      const result = extractJsonAsYaml(rawOutput)
      if (result !== null) {
        return { yaml: result, strategy }
      }
      this._logger.debug({ adapterId, strategy }, 'Normalizer strategy failed')
      lastError = 'json-fallback: no JSON object with anchor keys found'
    }

    // -----------------------------------------------------------------------
    // All strategies exhausted — emit warn-level structured log and return error
    // -----------------------------------------------------------------------
    this._logger.warn(
      {
        adapter_id: adapterId,
        tried_strategies: tried,
        snippet: rawOutput.slice(0, 500),
      },
      'AdapterOutputNormalizer exhausted all strategies — adapter format unrecognized'
    )

    return new AdapterFormatError({
      adapter_id: adapterId,
      rawOutput,
      tried_strategies: tried,
      extraction_error: lastError,
    })
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip leading lines that do not look like YAML content.
 *
 * A line is considered "YAML content" if it:
 * - Starts with a known anchor key (result:, verdict:, etc.)
 * - Starts with a code fence marker (```)
 * - Starts with a YAML document separator (---)
 * - Is blank (may be whitespace between prose and YAML)
 * - Starts with whitespace (indented YAML value)
 *
 * Lines before the first YAML-looking line are removed.
 */
function stripLeadingProse(text: string): string {
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    const trimmed = line.trim()

    // Blank lines are skipped (not YAML, but not prose either)
    if (trimmed === '') continue

    // Fence markers or YAML doc separator
    if (trimmed.startsWith('```') || trimmed.startsWith('---')) {
      return lines.slice(i).join('\n')
    }

    // Known anchor keys
    if (YAML_ANCHOR_KEYS.some((k) => trimmed.startsWith(k))) {
      return lines.slice(i).join('\n')
    }

    // Indented YAML (value continuation or nested key)
    if (/^\s+\S/.test(line)) {
      return lines.slice(i).join('\n')
    }

    // Generic YAML key pattern: starts with a word char, followed by ':'
    if (/^[a-zA-Z_][a-zA-Z0-9_]*:/.test(trimmed)) {
      return lines.slice(i).join('\n')
    }

    // This line looks like prose — continue scanning
  }

  // No YAML-looking line found — return original unchanged
  return text
}

/**
 * Strip line-leading markdown artifacts.
 *
 * Handles:
 *   - Blockquote prefix:  `> ` → ``
 *   - Heading markers:    `## ` → ``
 *   - Bold/italic:        `**` or `*` at start → ``
 *   - Underscore italic:  `_` at start → ``
 */
function stripMarkdownArtifacts(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      return line
        .replace(/^>\s?/, '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\*{1,2}/, '')
        .replace(/^_/, '')
    })
    .join('\n')
}

/**
 * Scan the text for an embedded JSON object containing at least one anchor key,
 * then dump it to YAML via js-yaml for downstream parseYamlResult().
 *
 * Uses a greedy { ... } scan to find candidate JSON objects. The last matching
 * object is used (consistent with yaml-parser.ts's "take the last block" rule).
 */
function extractJsonAsYaml(text: string): string | null {
  // Match multiline JSON objects (greedy { ... \n})
  const jsonPattern = /\{[\s\S]*?\n\}/g
  let lastMatch: Record<string, unknown> | null = null
  let match: RegExpExecArray | null

  while ((match = jsonPattern.exec(text)) !== null) {
    const candidate = match[0]

    // Quick check: must contain at least one anchor key (bare, without colon)
    const hasAnchorKey = YAML_ANCHOR_KEYS_BARE.some(
      (key) => candidate.includes(`"${key}"`) || candidate.includes(`'${key}'`)
    )
    if (!hasAnchorKey) continue

    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        lastMatch = parsed as Record<string, unknown>
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  if (lastMatch === null) return null

  try {
    return yaml.dump(lastMatch, { lineWidth: -1 })
  } catch {
    return null
  }
}
