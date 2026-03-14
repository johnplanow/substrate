/**
 * EpicParser — parses BMAD epic planning documents into structured data.
 *
 * Story 31-2: Epic Doc Ingestion
 *
 * Expected epic doc format:
 *   - Story map section begins with a heading containing "Story Map"
 *     (e.g. `#### Story Map`)
 *   - Sprint headers:  `**Sprint N — Label:**`
 *   - Story lines:     `- {epicNum}-{storyNum}: {title} ({priority}, {size})`
 *   - Dependency chain: `**Dependency chain**: {chain}`
 *     where chain uses `→` for sequential deps and `;` + `also gates` for parallel.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedStory {
  /** Fully-qualified story key, e.g. `31-2` */
  story_key: string
  /** Numeric epic identifier, e.g. `31` */
  epic_num: number
  /** Numeric story identifier within the epic, e.g. `2` */
  story_num: number
  /** Story title as written in the epic doc */
  title: string
  /** Priority tag, e.g. `P0` */
  priority: string
  /** Size tag, e.g. `Medium` */
  size: string
  /** Sprint number derived from the nearest `**Sprint N —` header above this story */
  sprint: number
}

export interface ParsedDependency {
  /**
   * The *downstream* (blocked) story that has this dependency.
   * Corresponds to the `story_key` column in `story_dependencies`.
   */
  story_key: string
  /**
   * The *upstream* (blocking) story that must complete first.
   * Corresponds to the `depends_on` column in `story_dependencies`.
   */
  depends_on: string
  /** Relationship type — always `'blocks'` for parsed deps */
  dependency_type: 'blocks'
  /** Provenance tag — always `'explicit'` for parser-derived deps */
  source: 'explicit'
}

// ---------------------------------------------------------------------------
// EpicParser
// ---------------------------------------------------------------------------

/** Regex for sprint header lines: `**Sprint 1 —` or `Sprint 1 —` (with or without bold markers) */
const SPRINT_HEADER_RE = /^(?:\*\*)?Sprint\s+(\d+)\s*[—–-]/i

/**
 * Regex for story lines: `- 31-2: Epic doc ingestion (P0, Medium)`
 * Captures: epicNum, storyNum, title, priority, size
 */
const STORY_LINE_RE = /^(?:-\s+)?(\d+)-(\d+):\s+(.+?)\s+\((P\d+),\s+([\w-]+)\)\s*$/

/** Regex to find the story map section heading */
const STORY_MAP_HEADING_RE = /^#{1,6}\s+.*Story\s+Map/im

/** Regex to find the dependency chain line */
const DEPENDENCY_CHAIN_RE = /\*\*Dependency\s+chain\*\*:\s*(.+)/i

/** Regex for "also gates" clauses: `31-3 also gates 31-6, 31-7` */
const ALSO_GATES_RE = /^([\d]+-[\d]+)\s+also\s+gates\s+(.+)$/i

export class EpicParser {
  /**
   * Parse story metadata from an epic planning document.
   *
   * @param content - Full text of the epic markdown document.
   * @returns Array of `ParsedStory` objects, one per story line found.
   * @throws {Error} If the story map section is absent or no stories can be parsed.
   */
  parseStories(content: string): ParsedStory[] {
    const headingMatch = STORY_MAP_HEADING_RE.exec(content)
    if (!headingMatch) {
      throw new Error('No story map section found in document')
    }

    // Slice content starting from just after the story map heading so we don't
    // accidentally pick up a sprint header or story line from earlier text.
    const afterHeading = content.slice(headingMatch.index + headingMatch[0].length)

    const stories: ParsedStory[] = []
    let currentSprint = 0

    for (const rawLine of afterHeading.split('\n')) {
      const line = rawLine.trim()

      // Skip code fence markers themselves
      if (line.startsWith('```')) continue

      // Sprint header — update current sprint tracking
      const sprintMatch = SPRINT_HEADER_RE.exec(line)
      if (sprintMatch) {
        currentSprint = parseInt(sprintMatch[1]!, 10)
        continue
      }

      // Story line
      const storyMatch = STORY_LINE_RE.exec(line)
      if (storyMatch) {
        const epicNum = parseInt(storyMatch[1]!, 10)
        const storyNum = parseInt(storyMatch[2]!, 10)
        stories.push({
          story_key: `${epicNum}-${storyNum}`,
          epic_num: epicNum,
          story_num: storyNum,
          title: storyMatch[3]!.trim(),
          priority: storyMatch[4]!,
          size: storyMatch[5]!,
          sprint: currentSprint,
        })
      }
    }

    if (stories.length === 0) {
      throw new Error('Story map section found but contained no parseable story lines')
    }

    return stories
  }

  /**
   * Parse dependency relationships from an epic planning document.
   *
   * If the `**Dependency chain**:` line is absent, returns an empty array
   * (not all epics declare dependencies).
   *
   * @param content - Full text of the epic markdown document.
   * @returns Array of `ParsedDependency` objects.
   */
  parseDependencies(content: string): ParsedDependency[] {
    const chainLineMatch = DEPENDENCY_CHAIN_RE.exec(content)
    if (!chainLineMatch) {
      return []
    }

    const chainStr = chainLineMatch[1]!.trim()
    const dependencies: ParsedDependency[] = []

    // Semicolons delimit independent clauses (linear chains or gating clauses)
    const clauses = chainStr.split(';').map((c) => c.trim()).filter(Boolean)

    for (const clause of clauses) {
      // Check for "also gates" pattern first: `31-3 also gates 31-6, 31-7`
      const alsoGatesMatch = ALSO_GATES_RE.exec(clause)
      if (alsoGatesMatch) {
        const gater = alsoGatesMatch[1]!.trim()
        const gatedList = alsoGatesMatch[2]!
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)

        for (const gated of gatedList) {
          // gater blocks gated → gated depends_on gater
          dependencies.push({
            story_key: gated,
            depends_on: gater,
            dependency_type: 'blocks',
            source: 'explicit',
          })
        }
        continue
      }

      // Linear chain: `31-1 → 31-2 → 31-3`
      const parts = clause.split('→').map((p) => p.trim()).filter(Boolean)
      for (let i = 0; i < parts.length - 1; i++) {
        const upstream = parts[i]!
        const downstream = parts[i + 1]!
        // upstream blocks downstream → downstream depends_on upstream
        dependencies.push({
          story_key: downstream,
          depends_on: upstream,
          dependency_type: 'blocks',
          source: 'explicit',
        })
      }
    }

    return dependencies
  }
}
