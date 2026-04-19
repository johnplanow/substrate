/**
 * Runtime probe parser — Epic 55 / Phase 2.
 *
 * Locates the `## Runtime Probes` section in a story's markdown content and
 * extracts any probe declarations contained in a `yaml` code fence inside
 * it. Never throws: every failure mode is returned as a RuntimeProbeParseResult
 * variant so the VerificationCheck can emit a structured finding rather than
 * crash the verification pipeline.
 */

import { load as yamlLoad, YAMLException } from 'js-yaml'
import {
  RuntimeProbeListSchema,
  type RuntimeProbe,
  type RuntimeProbeParseResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

const SECTION_HEADING = /^##\s+Runtime\s+Probes\s*$/i

/**
 * Return the raw text of the story's `## Runtime Probes` section (excluding
 * the heading line itself), or `undefined` if the section is not present.
 *
 * The section ends at the next `##` heading or end-of-file. Sub-headings
 * (`###`, `####`) remain part of the section body.
 */
function extractRuntimeProbesSection(storyContent: string): string | undefined {
  const lines = storyContent.split(/\r?\n/)
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.trim()))
  if (start === -1) return undefined

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i] ?? '')) {
      end = i
      break
    }
  }

  return lines.slice(start + 1, end).join('\n')
}

/**
 * Extract the body of the first ```yaml (or ```yml) fenced block in the
 * given section text. Returns `undefined` if no yaml fence is present.
 *
 * The opening fence is recognized case-insensitively and may carry an
 * arbitrary trailing info string (e.g. ```yaml title=...). The closing
 * fence is any line whose first non-whitespace run is exactly three
 * backticks.
 */
function extractYamlFence(section: string): string | undefined {
  const lines = section.split(/\r?\n/)
  let inside = false
  let collected: string[] | undefined
  for (const line of lines) {
    if (!inside) {
      if (/^\s*```\s*(yaml|yml)\b/i.test(line)) {
        inside = true
        collected = []
      }
      continue
    }
    // inside a yaml fence
    if (/^\s*```\s*$/.test(line)) {
      return (collected ?? []).join('\n')
    }
    collected?.push(line)
  }
  // Unterminated fence → treat as missing; the caller surfaces this as an
  // `invalid` parse result with a clear message.
  return undefined
}

// ---------------------------------------------------------------------------
// parseRuntimeProbes — public entry point
// ---------------------------------------------------------------------------

/**
 * Parse the `## Runtime Probes` section of a story's markdown content.
 *
 * Outcomes:
 *   - section missing                                  → { kind: 'absent' }
 *   - section present, no yaml fence                   → { kind: 'invalid' }
 *   - section present, yaml fence malformed            → { kind: 'invalid' }
 *   - section present, yaml root is not a list         → { kind: 'invalid' }
 *   - section present, entry fails RuntimeProbeSchema  → { kind: 'invalid' }
 *   - section present, yaml valid, all entries valid   → { kind: 'parsed' }
 *
 * Duplicate names within a single story are surfaced as `invalid` so that
 * finding messages can unambiguously reference a probe by name.
 */
export function parseRuntimeProbes(storyContent: string): RuntimeProbeParseResult {
  const section = extractRuntimeProbesSection(storyContent)
  if (section === undefined) {
    return { kind: 'absent' }
  }

  const yamlBody = extractYamlFence(section)
  if (yamlBody === undefined) {
    return {
      kind: 'invalid',
      error:
        '## Runtime Probes section is present but contains no terminated ```yaml fenced block',
    }
  }

  let parsed: unknown
  try {
    parsed = yamlLoad(yamlBody) ?? []
  } catch (err: unknown) {
    const detail = err instanceof YAMLException ? err.message : String(err)
    return { kind: 'invalid', error: `YAML parse error: ${detail}` }
  }

  if (!Array.isArray(parsed)) {
    return {
      kind: 'invalid',
      error: `probe block root must be a YAML list; got ${typeof parsed}`,
    }
  }

  const validation = RuntimeProbeListSchema.safeParse(parsed)
  if (!validation.success) {
    const first = validation.error.issues[0]
    const path = first?.path.join('.') ?? ''
    const message = first?.message ?? 'schema validation failed'
    return {
      kind: 'invalid',
      error: `probe list is malformed at ${path || '<root>'}: ${message}`,
    }
  }

  const probes: RuntimeProbe[] = validation.data
  const seen = new Set<string>()
  for (const probe of probes) {
    if (seen.has(probe.name)) {
      return {
        kind: 'invalid',
        error: `duplicate probe name: ${probe.name}`,
      }
    }
    seen.add(probe.name)
  }

  return { kind: 'parsed', probes }
}
