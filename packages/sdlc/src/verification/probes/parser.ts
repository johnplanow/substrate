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
const FENCE_DELIMITER = /^\s*```/

/**
 * Return the raw text of the story's `## Runtime Probes` section (excluding
 * the heading line itself), or `undefined` if the section is not present.
 *
 * The section ends at the next `##` heading or end-of-file. Sub-headings
 * (`###`, `####`) remain part of the section body.
 *
 * Story 58-4: the scan tracks code-fence depth so a `## Runtime Probes`
 * heading that appears *inside* an outer ``` block is ignored. Stories that
 * DOCUMENT probes in prose — regression fixtures, how-to-author docs, the
 * Epic 58 e2e test spec — contain illustrative `## Runtime Probes` examples
 * inside outer fences. Without fence-awareness the parser matches those
 * illustrations as the story's own section, fails to find a terminated
 * yaml block (the inner fences are typically escaped), and emits a spurious
 * `runtime-probe-parse-error`. Hit live during the Epic 58 substrate
 * dispatch on 58-3's artifact.
 */
function extractRuntimeProbesSection(storyContent: string): string | undefined {
  const lines = storyContent.split(/\r?\n/)

  // First pass: find the first `## Runtime Probes` heading that is NOT
  // inside an outer code fence.
  let inCodeFence = false
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (FENCE_DELIMITER.test(line)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (!inCodeFence && SECTION_HEADING.test(line.trim())) {
      start = i
      break
    }
  }
  if (start === -1) return undefined

  // Second pass: find the end boundary (next `##` heading at fence-depth 0).
  let end = lines.length
  inCodeFence = false
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (FENCE_DELIMITER.test(line)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (!inCodeFence && /^##\s+\S/.test(line)) {
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

  // Story 58-8: accept two root shapes so author conventions in different
  // projects interop cleanly with substrate's probe check:
  //   (a) bare list      — `- name: foo\n  ...`
  //   (b) wrapped list   — `probes:\n  - name: foo\n  ...`
  // Shape (b) is common in config-file conventions (docker-compose `services:`,
  // GitHub Actions `jobs:`). Strata's author uses (b). Previously the parser
  // errored with `probe block root must be a YAML list; got object`.
  if (
    !Array.isArray(parsed) &&
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).probes)
  ) {
    parsed = (parsed as Record<string, unknown>).probes
  }

  if (!Array.isArray(parsed)) {
    return {
      kind: 'invalid',
      error: `probe block root must be a YAML list or a \`probes:\` mapping; got ${typeof parsed}`,
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
