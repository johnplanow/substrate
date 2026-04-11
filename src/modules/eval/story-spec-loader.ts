// src/modules/eval/story-spec-loader.ts
//
// Loads StorySpec data (files + acceptance criteria) for the implementation
// phase eval. Stories live as on-disk markdown at
// `_bmad-output/implementation-artifacts/<storyKey>-*.md`. The pipeline run's
// story keys are derived from `story-metrics` decisions written by the
// implementation orchestrator (`${storyKey}:${runId}` key shape).
//
// Both the parser and the loader are best-effort: missing files, missing
// sections, and unrecognised AC formats degrade gracefully to empty arrays.
// The eval engine only runs ImplVerifier when StorySpec has at least one
// file or one AC, so an empty result simply skips that layer.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { getDecisionsByPhaseForRun } from '../../persistence/queries/decisions.js'
import type { StorySpec } from './layers/impl-verifier.js'
import { STORY_METRICS } from '@substrate-ai/core'

interface StorySpecWithSource extends StorySpec {
  /** Story key this spec was parsed from, if known. Used for AC prefixing. */
  storyKey?: string
}

/**
 * Parse a BMAD-style story markdown file into a StorySpec.
 * Best-effort — returns empty arrays for any section it cannot find.
 */
export function parseStorySpec(content: string): StorySpec {
  return {
    files: extractFiles(content),
    acceptanceCriteria: extractAcceptanceCriteria(content),
  }
}

/**
 * Aggregate multiple per-story specs into a single combined spec for the
 * implementation phase. Files are deduped (first appearance wins). AC are
 * concatenated; when a source storyKey is provided, each AC is prefixed with
 * `Story <key> — ` so the judge knows which story each criterion came from.
 */
export function aggregateStorySpecs(specs: StorySpecWithSource[]): StorySpec {
  const seenFiles = new Set<string>()
  const files: string[] = []
  const acceptanceCriteria: string[] = []

  for (const spec of specs) {
    for (const file of spec.files) {
      if (!seenFiles.has(file)) {
        seenFiles.add(file)
        files.push(file)
      }
    }
    for (const ac of spec.acceptanceCriteria) {
      acceptanceCriteria.push(
        spec.storyKey !== undefined ? `Story ${spec.storyKey} — ${ac}` : ac,
      )
    }
  }

  return { files, acceptanceCriteria }
}

/**
 * Load and aggregate story specs for every story that ran in a pipeline run.
 *
 * Story keys are derived from `story-metrics` decisions written by the
 * implementation orchestrator (key shape: `${storyKey}:${runId}`). For each
 * key, the matching on-disk story file at
 * `<projectRoot>/_bmad-output/implementation-artifacts/<storyKey>-*.md` is
 * read and parsed. Any missing file or unparseable content is silently
 * skipped — the caller decides what to do with an empty result.
 */
export async function loadStorySpecsForRun(
  db: DatabaseAdapter,
  runId: string,
  projectRoot: string,
): Promise<StorySpec> {
  const storyKeys = await deriveStoryKeysFromRun(db, runId)
  if (storyKeys.length === 0) return { files: [], acceptanceCriteria: [] }

  const artifactsDir = join(projectRoot, '_bmad-output', 'implementation-artifacts')
  if (!existsSync(artifactsDir)) {
    return { files: [], acceptanceCriteria: [] }
  }

  let entries: string[]
  try {
    entries = readdirSync(artifactsDir)
  } catch {
    return { files: [], acceptanceCriteria: [] }
  }

  const perStorySpecs: StorySpecWithSource[] = []
  for (const storyKey of storyKeys) {
    const match = entries.find(
      (f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md'),
    )
    if (match === undefined) continue

    let content: string
    try {
      content = readFileSync(join(artifactsDir, match), 'utf-8')
    } catch {
      continue
    }

    const parsed = parseStorySpec(content)
    if (parsed.files.length === 0 && parsed.acceptanceCriteria.length === 0) {
      continue
    }
    perStorySpecs.push({ ...parsed, storyKey })
  }

  return aggregateStorySpecs(perStorySpecs)
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

/**
 * Extract files from a "## File List" or "### File List" section.
 * Bullet items in the form `- src/foo.ts` or `- src/foo.ts (new)` are picked
 * up. Annotations in parentheses after the path are stripped — `-` is NOT
 * a stripping delimiter because file paths can contain hyphens.
 */
function extractFiles(content: string): string[] {
  const section = sliceSection(content, /^#{2,3}\s+File\s+List\s*$/im)
  if (section === undefined) return []

  const files: string[] = []
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('-') || line.length < 3) continue
    // Strip leading "- " and any parenthesised annotation
    const after = line.slice(1).trim()
    const stripped = after.replace(/\s+\(.*\)\s*$/, '').trim()
    if (stripped.length > 0) files.push(stripped)
  }
  return files
}

/**
 * Extract acceptance criteria. Two patterns are supported:
 *   1. `### AC<n>: title` headings — text becomes `AC<n>: title`
 *   2. Numbered list items under `## Acceptance Criteria` — text becomes the
 *      list item content
 */
function extractAcceptanceCriteria(content: string): string[] {
  // Pattern 1: ### AC<n>: title  (most common BMAD shape)
  const headingPattern = /^#{2,4}\s+AC(\d+):\s*(.+)$/gm
  const headings: string[] = []
  let match: RegExpExecArray | null
  while ((match = headingPattern.exec(content)) !== null) {
    headings.push(`AC${match[1]}: ${match[2].trim()}`)
  }
  if (headings.length > 0) return headings

  // Pattern 2: numbered list under "## Acceptance Criteria"
  const section = sliceSection(content, /^##\s+Acceptance\s+Criteria\s*$/im)
  if (section === undefined) return []

  const numberedItems: string[] = []
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim()
    const itemMatch = line.match(/^\d+\.\s+(.+)$/)
    if (itemMatch !== null && itemMatch[1] !== undefined) {
      numberedItems.push(itemMatch[1].trim())
    }
  }
  return numberedItems
}

/**
 * Return the body of a markdown section: everything between the matching
 * heading and the next heading at depth 1-3 (or end of file). Returns
 * undefined when the heading is not found.
 *
 * Uses index-based slicing instead of a `(?=...|$)` regex lookahead because
 * `$` with the `m` flag matches end-of-line, which would terminate the body
 * after the first line and silently truncate the section.
 */
function sliceSection(content: string, headingRegex: RegExp): string | undefined {
  const headingMatch = headingRegex.exec(content)
  if (headingMatch === null || headingMatch.index === undefined) return undefined

  const bodyStart = headingMatch.index + headingMatch[0].length
  const afterHeading = content.slice(bodyStart)

  const nextHeading = afterHeading.match(/^#{1,3}\s+/m)
  if (nextHeading !== null && nextHeading.index !== undefined) {
    return afterHeading.slice(0, nextHeading.index)
  }
  return afterHeading
}

/**
 * Pull unique story keys from `story-metrics` decisions for the given run.
 * Decision keys use the shape `${storyKey}:${runId}`; we strip the `:${runId}`
 * suffix and dedupe.
 */
async function deriveStoryKeysFromRun(
  db: DatabaseAdapter,
  runId: string,
): Promise<string[]> {
  const decisions = await getDecisionsByPhaseForRun(db, runId, 'implementation')
  const seen = new Set<string>()
  const keys: string[] = []
  for (const d of decisions) {
    if (d.category !== STORY_METRICS) continue
    const key = d.key.endsWith(`:${runId}`)
      ? d.key.slice(0, -`:${runId}`.length)
      : d.key
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}
