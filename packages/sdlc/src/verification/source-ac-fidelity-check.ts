/**
 * SourceAcFidelityCheck — Story 58-2.
 *
 * Tier A verification check that cross-references the rendered story artifact
 * against the source epic's hard clauses (MUST/SHALL keywords, backtick-wrapped
 * paths, and Runtime Probes sections). AC rewrites introduced by the
 * create-story agent are hard-gated before the story can reach COMPLETE.
 *
 * Scoring contract:
 *   - sourceEpicContent absent/empty → warn finding (source-ac-source-unavailable), status pass
 *   - All hard clauses present in storyContent → status pass
 *   - Any hard clause absent → one error finding per missing clause (source-ac-drift), status fail
 *
 * No LLM calls, no shell execution — pure in-memory literal substring matching.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type {
  VerificationCheck,
  VerificationContext,
  VerificationFinding,
  VerificationResult,
} from './types.js'
import { renderFindings } from './findings.js'
import { detectsEventDrivenAC } from './checks/runtime-probe-check.js'

// ---------------------------------------------------------------------------
// Path resolution helpers — Story 58-9c
// ---------------------------------------------------------------------------

/**
 * Directory names that should never be searched when doing the basename-glob
 * fallback for a relative path clause. Prevents the check from spending time
 * in the node_modules tree (which frequently has files whose basenames
 * collide with project source) and from descending into build or VCS output.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.substrate', '_bmad-output', 'coverage', '.next', '.cache'])

/** Max depth for the basename walk. Prevents pathological traversal. */
const MAX_WALK_DEPTH = 8

/**
 * Story 60-7: detect operational/runtime path references in source AC.
 *
 * Source ACs frequently mention runtime locations the implementation
 * INTERACTS WITH but does not SHIP — install destinations, system paths,
 * user home references, git internals. The check's existing path-clause
 * pipeline treats every backtick path as a deliverable and emits
 * architectural-drift error when it isn't found in code. This produces
 * false-positive verification failures.
 *
 * Concrete strata example (Run a880f201, Story 1-12, 2026-04-26): source AC
 * said "When `.git/hooks/post-merge` is installed" — describing the runtime
 * install location of a hook the dev's installer script writes. The dev
 * correctly shipped `hooks/install-vault-hooks.sh` + `hooks/vault-conflict-resolver.sh`,
 * but the check flagged `.git/hooks/post-merge` as architectural drift and
 * VERIFICATION_FAILED'd the story across both review cycles.
 *
 * Patterns covered:
 *   - `^\.git/...`           git internals (vault hooks, repo-internal paths)
 *   - `^/usr/...`, `^/etc/...`, `^/var/...`, `^/mnt/...`, `^/opt/...`,
 *     `^/srv/...`, `^/tmp/...`, `^/run/...`, `^/sys/...`, `^/proc/...`,
 *     `^/dev/...`, `^/home/...`  Unix system / install destinations
 *   - `^~/...`               user home references (`~/.config/...`, `~/obsidian-vault-test/`)
 *
 * Out of scope for v1 (deferred to follow-up if real evidence accumulates):
 *   - HTTP routes (`/api/embeddings`) — distinguishing a route from a system
 *     path requires extra signal (extension absence + plural-noun heuristic);
 *     punt until a story actually trips on this.
 */
function isOperationalPath(pathClause: string): boolean {
  // Strip surrounding backticks for the prefix test.
  const raw = pathClause.replace(/^`/, '').replace(/`$/, '')
  if (raw.startsWith('.git/')) return true
  if (raw.startsWith('~/')) return true
  // Match Unix system paths: leading slash + one of the canonical
  // root directories + slash. The trailing slash distinguishes
  // `/usr/local/bin` (system path) from `/userland/something` (project path).
  const SYSTEM_ROOTS = ['usr', 'etc', 'var', 'mnt', 'opt', 'srv', 'tmp', 'run', 'sys', 'proc', 'dev', 'home']
  for (const root of SYSTEM_ROOTS) {
    if (raw.startsWith(`/${root}/`)) return true
  }
  return false
}

/**
 * Return true if `base` (a filename like `discover.ts`) exists somewhere under
 * `root` within MAX_WALK_DEPTH levels, skipping SKIP_DIRS. The walk is
 * synchronous and bounded; finding a single match exits early.
 */
function existsAnywhereUnderRoot(root: string, base: string): boolean {
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!
    if (depth > MAX_WALK_DEPTH) continue
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue
      if (entry === base) return true
      const full = join(path, entry)
      try {
        const s = statSync(full)
        if (s.isDirectory()) stack.push({ path: full, depth: depth + 1 })
      } catch {
        continue
      }
    }
  }
  return false
}

/**
 * Check whether a path clause extracted from the source AC is satisfied by
 * the actual code under `workingDir`. Story 58-9c: handles relative paths
 * (e.g., `./discover.ts`) that the v0.20.15 literal `join(workingDir, path)`
 * check mis-resolved.
 *
 * Resolution strategy (in order):
 *   1. Literal `workingDir/path` — handles absolute paths and dot-stripped relatives.
 *   2. If the original started with `./`, strip the prefix and retry step 1.
 *   3. Basename search under workingDir — finds paths that live in an
 *      unstated directory context (common for relative imports in ACs).
 *
 * Any hit is treated as "code satisfies" (stylistic drift → warn). No hit
 * means architectural drift → error.
 */
function pathSatisfiedByCode(workingDir: string, pathClause: string): boolean {
  // Strip surrounding backticks
  const raw = pathClause.replace(/^`/, '').replace(/`$/, '')

  // Step 1: literal join (covers absolute-style paths like `packages/foo.ts`)
  if (existsSync(join(workingDir, raw))) return true

  // Step 2: strip leading `./` and retry (covers `./foo.ts` where the path is
  // relative to some directory context in the source AC)
  if (raw.startsWith('./')) {
    if (existsSync(join(workingDir, raw.slice(2)))) return true
  }

  // Step 3: basename search. Limited to relative-looking paths (contains no
  // absolute-from-project-root signal) so we don't do a costly walk for a
  // genuinely missing fully-qualified path.
  const isLikelyRelative = raw.startsWith('./') || !raw.includes('/')
  if (isLikelyRelative) {
    return existsAnywhereUnderRoot(workingDir, basename(raw))
  }

  return false
}

/**
 * Story 60-3 (Sprint 11B): check whether the path clause is referenced from
 * THIS story's modified files. Strata obs_2026-04-25_011 surfaced a case where
 * `pathSatisfiedByCode` returned true (path exists in repo) but the story's
 * own code did not actually use the path — the directory was created earlier
 * by a different story (1-17 in strata's case) and 1-10's `packages/memory-mcp/`
 * code never imported `packages/mesh-agent`. The fidelity check then annotated
 * the missing path as "stylistic drift — code satisfies it", obscuring real
 * under-delivery.
 *
 * This check closes that gap: when path exists in repo AND a list of
 * modified files is available, scan those modified files for an import /
 * require / use reference to the path's basename. If references exist, the
 * story's code does use the path → genuinely stylistic drift. If references
 * are absent, the story's code does not use the path → architectural
 * under-delivery (downgrade severity from warn to error).
 *
 * Conservative behavior: when modifiedFiles is empty (dev didn't report a
 * file list, or a Tier B re-verification context), preserves the existing
 * "code satisfies → warn" behavior. Only TIGHTENS when authoritative
 * file-list signal is present.
 */
function pathReferencedInModifiedFiles(
  workingDir: string,
  pathClause: string,
  modifiedFiles: string[],
): boolean {
  if (modifiedFiles.length === 0) return true // no signal → benefit of doubt

  const raw = pathClause.replace(/^`/, '').replace(/`$/, '')
  // Use the final non-extension segment as the lookup token. For
  // `packages/mesh-agent` → token `mesh-agent`. For `path/to/foo.ts` → token `foo`.
  const baseWithExt = basename(raw)
  const token = baseWithExt.replace(/\.[a-z]+$/i, '')
  // Tokens shorter than 3 chars are too generic to be meaningful (e.g., `db`,
  // `ts`) — give benefit of doubt to avoid false negatives.
  if (token.length < 3) return true

  // Build a separator-tolerant regex pattern. Cross-language imports normalize
  // separators differently:
  //   TS/JS: `from '@foo/mesh-agent'` (kebab preserved)
  //   Python: `from mesh_agent import` (snake — Python identifiers can't have hyphens)
  //   Go: `import ".../mesh-agent"` (kebab preserved)
  //   Rust: `use mesh_agent::` (snake — Rust identifier rule)
  // Replace `-` and `_` in the token with `[-_]` so kebab tokens match snake imports
  // and vice versa. Escape other regex metacharacters.
  const escapedSeparatorTolerant = token
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/[-_]/g, '[-_]')
  // Import-style reference: line begins with import/from/require/use/mod
  // (whitespace tolerated) and contains the token. Anchored to line start
  // to avoid false-positives where the comment text "import" appears
  // alongside a token reference (e.g., a comment like "# does NOT import X").
  const importPattern = new RegExp(
    `^\\s*(?:import|from|require|use|mod)\\b[^\\n]*\\b${escapedSeparatorTolerant}\\b`,
    'mi',
  )
  // Also catch package.json deps and other bare references that aren't
  // imports per se but still indicate the story wired the path in.
  const barePattern = new RegExp(`\\b${escapedSeparatorTolerant}\\b`, 'i')

  for (const filePath of modifiedFiles) {
    let content: string
    try {
      content = readFileSync(join(workingDir, filePath), 'utf-8')
    } catch {
      continue
    }
    if (importPattern.test(content)) return true
    // For package.json or yaml config files, accept bare reference.
    if (filePath.endsWith('package.json') || filePath.endsWith('.yaml') || filePath.endsWith('.yml') || filePath.endsWith('.toml')) {
      if (barePattern.test(content)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Hard-clause extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the story's section from the full epic content.
 *
 * Uses the heading pattern `### Story <storyKey>:` or `### Story <storyKey>[whitespace]`.
 *
 * **Separator-tolerant matching** (Story 60-6, mirrors create-story.ts Story
 * 58-5 normalization): Substrate's canonical storyKey form is hyphen
 * (`1-10c`) — `seed-methodology-context.ts` normalizes any author convention
 * to hyphen before storing in `wg_stories`. But strata's `epics.md` uses
 * dot-form headings (`### Story 1.10c:`). When the supplied storyKey
 * (`1-10c`) doesn't textually match the heading separator (`.`), the
 * extraction must still find the right section — silently scanning the
 * whole epic and attributing every story's clauses to this one is far worse
 * than emitting a clear "could not isolate" signal.
 *
 * Returns the extracted section text (from the heading match through to the
 * next `### Story` heading or end of file), or `null` if no matching heading
 * is found. Callers MUST handle null explicitly — the previous silent-fallback
 * behavior (return-full-epic) inflated findings cross-story and is gone.
 */
function extractStorySection(epicContent: string, storyKey: string): string | null {
  // Separator-tolerant: split on any of [-._ ] and rejoin with the same class
  // so `1-10c` matches `### Story 1.10c:`, `### Story 1_10c:`, `### Story 1 10c:`,
  // and vice versa.
  const parts = storyKey.split(/[-._ ]/)
  const normalized = parts
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[-._ ]')
  const headingPattern = new RegExp(`^###\\s+Story\\s+${normalized}[:\\s]`, 'm')
  const match = headingPattern.exec(epicContent)
  if (!match) {
    return null
  }
  const start = match.index
  // Find the next `### Story ` heading after the match
  const nextHeading = /\n### Story /m.exec(epicContent.slice(start + 1))
  if (nextHeading) {
    return epicContent.slice(start, start + 1 + nextHeading.index)
  }
  return epicContent.slice(start)
}

type HardClause = {
  type: 'MUST NOT' | 'MUST' | 'SHALL NOT' | 'SHALL' | 'path' | 'runtime-probes-section'
  /** The raw text of the clause (used for substring matching against storyContent) */
  text: string
  /**
   * Story 60-5: when a path clause sits inside a `- **(letter)**` list item
   * belonging to a multi-option alternative group, this stores `{group, option}`
   * so the verification phase can OR satisfaction across options instead of
   * AND'ing every clause. Strata obs_2026-04-26_013: source AC offered two
   * implementation shapes (`(a)` + `(b)`) and dev correctly took `(b)`, but
   * the v0.20.23 check hard-gated on `(a)`'s path being missing because it
   * had no concept of alternative options. This metadata lets the check
   * downgrade un-taken option paths to info severity when at least one
   * option in the group is satisfied.
   */
  alternative?: { group: string; option: string }
  /**
   * Sprint 21 (obs_2026-04-27_016): when a path clause sits inside a paragraph
   * containing a negation phrase ("(NOT replaced)", "MUST NOT", "deferred to",
   * "is gitignored", "documented (NOT", "does NOT replace", etc.), the AC author
   * is referencing the path to communicate scope-NARROWING — telling the dev
   * NOT to deliver / modify it. Treating these as positive-delivery requirements
   * was the strata Run 16 false-positive flood (6 ERROR findings on paths the
   * AC explicitly directed dev NOT to modify). When set, the path clause emits
   * info-severity (`source-ac-negation-reference`) rather than the under-delivery
   * error.
   */
  negation?: boolean
  /**
   * obs_2026-05-02_020: when a path clause appears inside a dependency-context
   * phrase ("via `<path>`", "via `<path>`'s outbox", "consumes `<path>`",
   * "imports from `<path>`", "built atop `<path>`", "<path>-shipped"),
   * the AC is referencing the path as an architectural dependency the
   * implementation INTERACTS WITH (typically a peer package shipped by an
   * earlier story), NOT as a positive-delivery requirement. Treating these
   * as deliverables produced strata Run 19 / Story 2-7's verification
   * failure: the dev correctly imported MeshClient from @jplanow/agent-mesh
   * to publish a MorningBriefing record, but `pathReferencedInModifiedFiles`
   * couldn't match the AC token `mesh-agent` against the import token
   * `agent-mesh` (different word order in the package name). Detecting the
   * dependency context up-front routes these path mentions to info-severity
   * `source-ac-dependency-reference` rather than the under-delivery error.
   */
  dependency?: boolean
}

// ---------------------------------------------------------------------------
// Alternative-option detection (Story 60-5)
// ---------------------------------------------------------------------------

/**
 * Bounds of one alternative option within a section. An "alternative group"
 * is a run of two or more consecutive markdown list items whose label is a
 * parenthesized letter inside double-asterisk bold — e.g.,
 *
 *   - **(a) TypeScript shim** in `pkgA/`
 *   - **(b) Python re-impl** within `pkgB/`
 *
 * The group spans both items; each item is one option. Continuation lines
 * (blank lines or indented continuations) belong to the most recent option.
 */
type AlternativeOption = {
  /** Stable per-group identifier so options sharing a group can be linked. */
  group: string
  /** The option's letter, lowercased ('a', 'b', 'c', ...). */
  option: string
  /** First line of the option (inclusive). */
  lineStart: number
  /** First line AFTER the option (exclusive). */
  lineEnd: number
}

const ALTERNATIVE_ITEM = /^\s*-\s+\*\*\(([a-zA-Z])\)/

/**
 * Scan section lines for alternative-option groups. A group requires at least
 * two consecutive lettered list items; isolated `- **(a)**` items are NOT
 * treated as alternatives because there is no second option to compare against.
 *
 * Returns a flat list of options (each item annotated with its group id) so
 * the caller can map any path-clause line back to its (group, option) bucket.
 */
function detectAlternativeOptions(lines: string[]): AlternativeOption[] {
  const options: AlternativeOption[] = []
  let i = 0
  while (i < lines.length) {
    const start = lines[i]
    const m = start !== undefined ? ALTERNATIVE_ITEM.exec(start) : null
    if (m) {
      const groupStartLine = i
      const items: { letter: string; line: number }[] = [
        { letter: m[1]!.toLowerCase(), line: i },
      ]
      let j = i + 1
      while (j < lines.length) {
        const line = lines[j] ?? ''
        const am = ALTERNATIVE_ITEM.exec(line)
        if (am) {
          items.push({ letter: am[1]!.toLowerCase(), line: j })
          j++
          continue
        }
        // Blank line or indented continuation — stays inside the group's span.
        if (line.trim() === '' || /^\s+\S/.test(line)) {
          j++
          continue
        }
        // Non-list line at column zero — group ends.
        break
      }
      // Need 2+ items to call this an alternative group.
      if (items.length >= 2) {
        const groupId = `alt-L${groupStartLine}`
        for (let k = 0; k < items.length; k++) {
          const item = items[k]!
          const next = k + 1 < items.length ? items[k + 1]!.line : j
          options.push({
            group: groupId,
            option: item.letter,
            lineStart: item.line,
            lineEnd: next,
          })
        }
      }
      i = j
    } else {
      i++
    }
  }
  return options
}

/** Resolve the (group, option) for a path clause whose match appeared on
 *  `lineIndex`, or undefined if the line is not inside any alternative option. */
function findOptionForLine(
  lineIndex: number,
  options: AlternativeOption[],
): { group: string; option: string } | undefined {
  for (const opt of options) {
    if (lineIndex >= opt.lineStart && lineIndex < opt.lineEnd) {
      return { group: opt.group, option: opt.option }
    }
  }
  return undefined
}

/**
 * Story 60-5: compute the "taken" option per alternative group.
 *
 * For each group of alternative options:
 *   - Each option owns one or more path clauses (tagged with the same `group`
 *     and the option's letter).
 *   - An option is satisfied when every path clause it owns exists in code
 *     (pathSatisfiedByCode === true). Missing paths in code make the option
 *     unsatisfied — the dev did not take this option.
 *   - The group's taken-option is the alphabetically-first satisfied letter,
 *     for deterministic selection when multiple options happen to be
 *     satisfied (uncommon, but possible if both options' paths exist from
 *     prior unrelated work).
 *
 * Returns a map: group-id → option-letter that was taken. Groups with no
 * satisfied option are absent from the map (caller falls back to existing
 * per-path error-severity drift detection).
 */
function computeTakenOptionPerGroup(
  hardClauses: HardClause[],
  workingDir: string,
): Map<string, string> {
  // group → option-letter → "all paths satisfied so far"
  const optionState = new Map<string, Map<string, boolean>>()

  for (const clause of hardClauses) {
    if (clause.type !== 'path' || !clause.alternative) continue
    const { group, option } = clause.alternative
    if (!optionState.has(group)) optionState.set(group, new Map())
    const groupMap = optionState.get(group)!
    const exists = pathSatisfiedByCode(workingDir, clause.text)
    if (!groupMap.has(option)) {
      groupMap.set(option, exists)
    } else if (!exists) {
      // Any one missing path unsatisfies the option.
      groupMap.set(option, false)
    }
  }

  const taken = new Map<string, string>()
  for (const [group, opts] of optionState) {
    const sorted = [...opts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [letter, satisfied] of sorted) {
      if (satisfied) {
        taken.set(group, letter)
        break
      }
    }
  }
  return taken
}

/**
 * Extract hard clauses from a story section of an epic file.
 *
 * Hard clauses:
 *   1. Lines containing MUST NOT / MUST / SHALL NOT / SHALL as standalone keywords (case-sensitive)
 *   2. Backtick-wrapped paths with at least one `/` (excludes bare filenames).
 *      Story 60-5: paths inside `- **(letter)**` list items belonging to a
 *      multi-option alternative group are tagged with `{group, option}` so
 *      the verification phase can OR satisfaction across options.
 *   3. The presence of `## Runtime Probes` heading followed by a fenced yaml block
 *      (represented as a single "runtime-probes-section" clause)
 */
// ---------------------------------------------------------------------------
// Negation-context detection (Sprint 21 / obs_2026-04-27_016)
// ---------------------------------------------------------------------------

/**
 * Negation phrases that mark a paragraph as "the paths in this paragraph
 * are references the dev should NOT deliver/modify". When any of these
 * phrases appears in a paragraph, every path-clause in that paragraph is
 * tagged `negation: true` so the verification emit routes them to the
 * info-severity `source-ac-negation-reference` finding instead of the
 * under-delivery error path.
 *
 * Strata Run 16 (Story 1-16, 2026-04-27): the AC contained
 *
 *   "the existing test scaffolding is documented (NOT replaced):
 *    `packages/memory` already uses vitest (Story 1.8+);
 *    `packages/memory-mcp` already uses pytest (Story 1.10+); ...
 *    1.16 does NOT replace or rewrite existing test infrastructure."
 *
 * Substrate emitted 6 ERROR-level under-delivery findings on the listed
 * paths; the dev had correctly NOT modified them. The flood of
 * false-positive ERRORs masked a real WARN about the missing `## Runtime
 * Probes` section (which itself would have surfaced two real defects in
 * the delivery). Detecting the negation context up-front separates the
 * legitimate "paths the AC mentions but the dev should not modify" case
 * from genuine under-delivery.
 *
 * Patterns are case-sensitive on the keyword (NOT, MUST NOT, gitignored)
 * because lowercased forms are common in non-imperative prose ("not
 * really" / "must not exceed" appear in unrelated contexts and
 * over-trigger). The strata observation enumerates the canonical forms.
 */
const NEGATION_PHRASE_PATTERNS: RegExp[] = [
  // "(NOT replaced)", "(NOT modified)", "(NOT changed)", etc. — parenthesized NOT
  /\(NOT\s+\w+/,
  // "documented (NOT" — common BMAD phrasing when AC lists references
  /documented\s*\(NOT/i,
  // "MUST NOT", "SHALL NOT" — keyword forms (already tracked as MUST NOT
  // clauses for substring matching, but also marks the paragraph as negation)
  /\bMUST\s+NOT\b|\bSHALL\s+NOT\b/,
  // "does NOT replace", "does NOT modify", "do NOT create", etc. — verb-NOT-verb
  /\bdo(?:es)?\s+NOT\s+\w+/,
  // "deferred to" — common phrasing for paths created by another sprint/story
  /\bdeferred\s+to\b/i,
  // "is gitignored" — explicit indicator the path must NOT live there
  /\b(?:is|are)\s+gitignored\b/i,
]

/**
 * Find all line indices that fall within a negation context. The scope of
 * a single negation context is the line that contains the negation phrase
 * PLUS any markdown indented-continuation lines following it (so a bullet
 * that wraps onto multiple indented lines is treated as one logical unit).
 *
 * The continuation walk stops at the first of: blank line, next markdown
 * bullet (`- `, `* `, numbered list), or any non-indented non-blank line.
 *
 * Coarser scopes (e.g., paragraph-wide aggregation) over-triggered on
 * test fixtures like:
 *
 *   The implementation MUST validate input.
 *   The system MUST NOT skip authentication.
 *   Files SHALL be placed in `src/auth/validator.ts`.
 *
 * — three independent statements wrapped without blank-line separators.
 * The "MUST NOT" on line 2 should not mark the unrelated path on line 3
 * as a negation reference. Only the bullet's CONTINUATION-LINE structure
 * constitutes "the same logical reference unit" as the negation phrase.
 */
export function detectNegationContextLines(lines: string[]): Set<number> {
  const result = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (NEGATION_PHRASE_PATTERNS.some((pat) => pat.test(line))) {
      result.add(i)
      // Walk forward marking indented continuation lines that belong to
      // the same logical bullet/paragraph element.
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j] ?? ''
        // Blank line ends the continuation
        if (next.trim() === '') break
        // New bullet ends the continuation
        if (/^\s*(?:-|\*|\d+\.)\s+/.test(next)) break
        // Indented non-bullet line is a continuation of the negation line
        if (/^\s+\S/.test(next)) {
          result.add(j)
          j++
          continue
        }
        // Non-indented non-blank line is a sibling, not a continuation
        break
      }
    }
  }
  return result
}

/**
 * obs_2026-05-02_020: dependency-context phrase patterns. When any of these
 * patterns appears on a line (or its indented continuation), every backtick-
 * wrapped path on the same line is tagged `dependency: true`. The phrases
 * indicate the AC is naming the path as an architectural integration point
 * (a peer package the implementation imports from, a service the code
 * queries, etc.) — NOT as a positive-delivery requirement.
 *
 * Strata Run 19 / Story 2-7 (2026-05-02): the AC said
 *
 *   "publishes a `MorningBriefing` mesh record via `packages/mesh-agent`'s
 *    outbox using the existing `MeshClient` surface"
 *
 * The implementation correctly imported `MeshClient` from
 * `@jplanow/agent-mesh` and called the existing publish surface, but
 * `pathReferencedInModifiedFiles` (Story 60-3, v0.20.23) couldn't match the
 * AC's `packages/mesh-agent` token against the package's `@jplanow/agent-mesh`
 * import path (the words `mesh` and `agent` are reordered between directory
 * name and package name). The check fired ERROR-level under-delivery and
 * VERIFICATION_FAILED'd a story whose code was correct.
 *
 * Patterns are anchored to backtick-wrapped paths to keep the trigger tight.
 * Bare prose like "uses the existing surface" or "from yesterday's run"
 * doesn't fire — only references where the path appears in backticks under
 * an explicit dependency-context preposition / verb.
 *
 * Coverage shapes (each must precede a backtick-wrapped path on the same line):
 *   - `via \`X\`` / `via \`X\`'s ...` — Story 2-7 exact shape
 *   - `imports? from \`X\`` — explicit import statement
 *   - `consumes \`X\`` — skill / queue consumption
 *   - `built atop \`X\`` — architectural foundation
 *   - `\`X\`-shipped` — back-reference to a peer story's package
 *   - `using \`X\`` — when AC narrates "using <package>'s API"
 */
const DEPENDENCY_CONTEXT_PHRASE_PATTERNS: RegExp[] = [
  // "via `path`" / "via `path`'s outbox" — Story 2-7 canonical
  /\bvia\s+`[^`]+`/i,
  // "imports from `path`" / "import from `path`" — explicit import language
  /\bimports?\s+from\s+`[^`]+`/i,
  // "consumes `path`" — skill/queue consumption
  /\bconsumes\s+`[^`]+`/i,
  // "built atop `path`" / "built on top of `path`"
  /\bbuilt\s+(?:atop|on\s+top\s+of)\s+`[^`]+`/i,
  // "`path`-shipped" — adjective form referencing a peer package
  /`[^`]+`-shipped/i,
  // "using `path`'s ..." — when AC narrates use-of-package
  /\busing\s+`[^`]+`['']s/i,
]

/**
 * Find all line indices that fall within a dependency context. Mirrors the
 * `detectNegationContextLines` shape exactly (same continuation walk: the
 * dependency-phrase line plus indented non-bullet continuation lines).
 */
export function detectDependencyContextLines(lines: string[]): Set<number> {
  const result = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (DEPENDENCY_CONTEXT_PHRASE_PATTERNS.some((pat) => pat.test(line))) {
      result.add(i)
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j] ?? ''
        if (next.trim() === '') break
        if (/^\s*(?:-|\*|\d+\.)\s+/.test(next)) break
        if (/^\s+\S/.test(next)) {
          result.add(j)
          j++
          continue
        }
        break
      }
    }
  }
  return result
}

function extractHardClauses(sectionContent: string): HardClause[] {
  const clauses: HardClause[] = []
  const lines = sectionContent.split('\n')

  // Story 60-5: detect alternative-option line ranges up-front so any path
  // extracted from inside one of those ranges can be tagged with its
  // (group, option) — without this metadata the verification phase has no
  // way to recognize that "(a)'s path missing" is acceptable when "(b)'s
  // path is satisfied".
  const alternativeOptions = detectAlternativeOptions(lines)

  // Sprint 21 (obs_2026-04-27_016): detect negation-context paragraphs so
  // path clauses extracted from them can be tagged as references-only.
  // See `detectNegationContextLines` for the heuristic.
  const negationContextLines = detectNegationContextLines(lines)

  // obs_2026-05-02_020: detect dependency-context phrases so path clauses
  // extracted from them can be tagged as integration-point references
  // rather than positive-delivery requirements.
  // See `detectDependencyContextLines` for the heuristic.
  const dependencyContextLines = detectDependencyContextLines(lines)

  // --- MUST NOT / MUST / SHALL NOT / SHALL lines ---
  // Word-boundary match, case-sensitive, captures the whole line.
  // Order matters: MUST NOT before MUST, SHALL NOT before SHALL to avoid double-matching.
  const mustPattern = /\b(MUST NOT|MUST|SHALL NOT|SHALL)\b/
  for (const line of lines) {
    const match = mustPattern.exec(line)
    if (match) {
      const keyword = match[1] as HardClause['type']
      clauses.push({ type: keyword, text: line.trim() })
    }
  }

  // --- Backtick-wrapped paths with at least one slash ---
  // Match `path/with/at-least-one-slash` — excludes bare `filename.ts`.
  // Iterate line-by-line so each match's line index is known and can be
  // mapped to an alternative option (Story 60-5).
  const pathPattern = /`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_./-]+)`/g
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? ''
    pathPattern.lastIndex = 0
    let pathMatch: RegExpExecArray | null
    while ((pathMatch = pathPattern.exec(line)) !== null) {
      const alt = findOptionForLine(lineIdx, alternativeOptions)
      const inNegation = negationContextLines.has(lineIdx)
      const inDependency = dependencyContextLines.has(lineIdx)
      clauses.push({
        type: 'path',
        // The full backtick-wrapped expression (including backticks) is the clause text
        // so the literal substring match against storyContent checks the exact same form.
        text: `\`${pathMatch[1]}\``,
        ...(alt ? { alternative: alt } : {}),
        ...(inNegation ? { negation: true } : {}),
        ...(inDependency ? { dependency: true } : {}),
      })
    }
  }

  // --- Runtime Probes section ---
  // Detect ## Runtime Probes heading followed by a fenced yaml block
  const probesPattern = /^##\s+Runtime Probes[\s\S]*?```yaml/m
  if (probesPattern.test(sectionContent)) {
    clauses.push({ type: 'runtime-probes-section', text: '## Runtime Probes' })
  }

  return clauses
}

// ---------------------------------------------------------------------------
// SourceAcFidelityCheck
// ---------------------------------------------------------------------------

export class SourceAcFidelityCheck implements VerificationCheck {
  readonly name = 'source-ac-fidelity'
  readonly tier = 'A' as const

  async run(context: VerificationContext): Promise<VerificationResult> {
    const start = Date.now()

    // AC2: When sourceEpicContent is absent or empty, emit warn and pass.
    if (!context.sourceEpicContent) {
      const findings: VerificationFinding[] = [
        {
          category: 'source-ac-source-unavailable',
          severity: 'warn',
          message: 'source epic content unavailable — skipping fidelity check',
        },
      ]
      return {
        status: 'pass',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // Extract the story's section from the epic content. Story 60-6: when no
    // heading matches, this is now `null` rather than a silent return-full-
    // epic fallback. Falling back to the full epic attributed every story's
    // hard clauses to this one — surfaced when strata's hyphen-form storyKey
    // (`1-10c`) didn't match the dot-form heading (`### Story 1.10c:`) and
    // produced cross-story findings. Loud warn finding here is strictly
    // better than silently grading the wrong scope.
    const storySection = extractStorySection(context.sourceEpicContent, context.storyKey)
    if (storySection === null) {
      const findings: VerificationFinding[] = [
        {
          category: 'source-ac-section-not-found',
          severity: 'warn',
          message:
            `could not locate "### Story ${context.storyKey}" heading in source epic content — ` +
            `skipping fidelity check (the heading may use a separator convention ` +
            `(e.g. dot vs hyphen vs underscore) the matcher does not recognize, ` +
            `or the story may not exist in this epic file)`,
        },
      ]
      return {
        status: 'pass',
        details: renderFindings(findings),
        duration_ms: Date.now() - start,
        findings,
      }
    }

    // Extract all hard clauses from the story section
    const hardClauses = extractHardClauses(storySection)

    const findings: VerificationFinding[] = []
    const storyContent = context.storyContent ?? ''

    // Story 60-5: compute taken-option per alternative group BEFORE the main
    // emission loop, so path-clause processing can recognize un-taken options
    // and emit them as info-severity rather than error.
    //
    // An option is considered "satisfied" if all its path clauses exist in
    // code (pathSatisfiedByCode === true). When at least one option in a
    // group is satisfied, the group's taken-option is the alphabetically-
    // first satisfied letter (deterministic). Other options' paths are
    // emitted as info findings ("alternative not taken — story took option X").
    //
    // This closes strata obs_2026-04-26_013: 1-10c source AC offered (a) TS
    // shim and (b) Python re-impl as alternatives; dev correctly took (b),
    // but v0.20.23's check hard-gated on (a)'s path being missing. The
    // alternative metadata + this OR'ing semantic preserves error severity
    // for genuinely-missing paths while accepting either option as valid
    // when source AC explicitly offered both.
    const takenOption = computeTakenOptionPerGroup(hardClauses, context.workingDir)

    for (const clause of hardClauses) {
      if (clause.type === 'runtime-probes-section') {
        // Special handling: check whether the story artifact contains ## Runtime Probes
        if (!storyContent.includes('## Runtime Probes')) {
          const truncated = clause.text.length > 120 ? clause.text.slice(0, 120) : clause.text
          // Sprint 21 (obs_2026-04-27_016 fix-4): when the AC is event-driven,
          // a missing `## Runtime Probes` section is structurally significant —
          // probe-author SHOULD have authored probes for it, and runtime-probes
          // check WILL skip without the section. The strata Run 16 case
          // surfaced this masking pattern: the WARN about missing probes was
          // the only signal that two real defects (missing --dry-run support,
          // JSON dup-echo) would have been caught had probes run. Escalating
          // to error severity makes the gate blocking when probe-authoring is
          // expected; non-event-driven stories continue to get the WARN-level
          // advisory.
          const isEventDrivenAc = detectsEventDrivenAC(context.sourceEpicContent)
          findings.push({
            category: 'source-ac-drift',
            severity: isEventDrivenAc ? 'error' : 'warn',
            message: isEventDrivenAc
              ? `runtime-probes-section: "${truncated}" present in epics source but absent in story artifact AND source AC is event-driven (probes are required for event-driven ACs — runtime-probes check will skip without the section)`
              : `runtime-probes-section: "${truncated}" present in epics source but absent in story artifact`,
          })
        }
      } else {
        // Literal substring match for MUST/SHALL lines and path clauses
        if (!storyContent.includes(clause.text)) {
          const truncated = clause.text.length > 120 ? clause.text.slice(0, 120) : clause.text

          // Story 58-9b: for path clauses, distinguish architectural drift
          // (path missing from BOTH artifact and code) from stylistic drift
          // (path exists in code — artifact paraphrased). Architectural
          // drift hard-gates at error-severity; stylistic drift stays
          // advisory at warn-severity. MUST/SHALL keyword clauses have no
          // code-observable signal, so they remain advisory warn.
          //
          // The 58-9b cross-reference closes the calibration loop started
          // in 58-9: now real drift (like strata 1-9's missing
          // `adjacency-store.ts`) hard-gates, while artifact-paraphrase
          // false positives (like strata 1-7's unquoted `./discover.ts`)
          // pass through as advisory.
          if (clause.type === 'path') {
            // Sprint 21 (obs_2026-04-27_016): if this path appeared inside a
            // paragraph carrying a negation phrase ("(NOT replaced)", "MUST
            // NOT", "deferred to", "documented (NOT", "does NOT replace",
            // "is gitignored"), the AC author was referencing the path to
            // tell the dev NOT to deliver it. Emit as info-severity
            // `source-ac-negation-reference` and skip the under-delivery
            // emission. Strata Run 16 / Story 1-16: 6 ERROR findings on
            // paths the AC explicitly directed dev NOT to modify, all
            // false-positives masking a real probes-section WARN.
            if (clause.negation === true) {
              findings.push({
                category: 'source-ac-negation-reference',
                severity: 'info',
                message:
                  `path: "${truncated}" referenced in source AC inside a negation context ` +
                  `(e.g., "(NOT replaced)", "MUST NOT", "deferred to", "documented (NOT", ` +
                  `"does NOT replace", "is gitignored") — the AC explicitly directed the ` +
                  `dev NOT to deliver/modify this path; treated as reference-only, ` +
                  `not a deliverable`,
              })
              continue
            }

            // obs_2026-05-02_020: if this path appeared inside a
            // dependency-context phrase ("via `X`", "imports from `X`",
            // "consumes `X`", "built atop `X`", "`X`-shipped", "using `X`'s"),
            // the AC was naming the path as an architectural integration
            // point — typically a peer package shipped by an earlier story
            // that this story IMPORTS FROM rather than ships. Strata Run 19
            // / Story 2-7 (2026-05-02) shipped correct code importing
            // MeshClient from @jplanow/agent-mesh, but the AC named
            // `packages/mesh-agent` and `pathReferencedInModifiedFiles`
            // couldn't bridge the directory-name vs. package-name token
            // mismatch. Emit info-severity rather than under-delivery.
            if (clause.dependency === true) {
              findings.push({
                category: 'source-ac-dependency-reference',
                severity: 'info',
                message:
                  `path: "${truncated}" referenced in source AC inside a dependency-context ` +
                  `phrase (e.g., "via \`X\`", "via \`X\`'s outbox", "imports from \`X\`", ` +
                  `"consumes \`X\`", "built atop \`X\`", "\`X\`-shipped", "using \`X\`'s") ` +
                  `— the AC named this path as an architectural integration point the ` +
                  `implementation interacts with, not a positive-delivery requirement; ` +
                  `treated as reference-only`,
              })
              continue
            }

            // Story 60-7: operational-path heuristic. Source ACs frequently
            // mention runtime install destinations, system paths, or git
            // internals that the implementation INTERACTS WITH but does not
            // SHIP — `.git/hooks/post-merge`, `/usr/local/bin/foo`,
            // `~/.config/strata/`. These are not deliverable file paths;
            // emitting them as architectural drift produces false
            // VERIFICATION_FAILED on stories that correctly ship installers
            // for these locations. Surfaced strata Run a880f201 (Story 1-12,
            // 2026-04-26): dev correctly shipped `hooks/install-vault-hooks.sh`
            // + `hooks/vault-conflict-resolver.sh` but the check flagged
            // `.git/hooks/post-merge` (the install destination) as missing.
            if (isOperationalPath(clause.text)) {
              findings.push({
                category: 'source-ac-operational-path-reference',
                severity: 'info',
                message:
                  `path: "${truncated}" referenced in source AC as a runtime / ` +
                  `install / system location (matches operational-path heuristic) ` +
                  `— treated as informational, not a deliverable file path`,
              })
              continue
            }

            // Story 60-5: if this path belongs to an un-taken alternative
            // option (source AC offered (a) and (b); story implemented (b)),
            // emit info-severity rather than error. The dev correctly chose
            // a different option in the same group; flagging the un-taken
            // option's path as architectural drift was the v0.20.23 false
            // positive that hard-gated strata 1-10c despite a correct
            // option-(b) implementation.
            if (clause.alternative) {
              const { group, option } = clause.alternative
              const taken = takenOption.get(group)
              if (taken !== undefined && taken !== option) {
                findings.push({
                  category: 'source-ac-alternative-not-taken',
                  severity: 'info',
                  message: `path: "${truncated}" not implemented — source AC offered this as alternative option (${option}); story implemented option (${taken}) instead`,
                })
                continue
              }
            }

            // Story 58-9c: delegated to pathSatisfiedByCode which handles
            // literal / dot-stripped / basename-search resolution so
            // relative-path source ACs (e.g., `./discover.ts`) are correctly
            // classified. v0.20.15's literal `join(workingDir, path)` check
            // false-positive-errored on relative paths; this restores the
            // stylistic-vs-architectural distinction across path styles.
            const existsInCode = pathSatisfiedByCode(context.workingDir, clause.text)

            // Story 60-3 (Sprint 11B): tighten "code satisfies → stylistic
            // drift" annotation. Strata obs_2026-04-25_011: path
            // `packages/mesh-agent` existed in repo (created by Story 1.17)
            // but 1-10's code never imported it; the check annotated the
            // miss as stylistic drift, masking real under-delivery. When
            // the dev-story result reports a list of modified files, check
            // whether THIS story's code references the path. References
            // present → genuinely stylistic. References absent → path
            // exists from prior work but this story didn't wire it →
            // architectural under-delivery.
            const modifiedFiles = context.devStoryResult?.files_modified ?? []
            const referencedByStory = pathReferencedInModifiedFiles(
              context.workingDir,
              clause.text,
              modifiedFiles,
            )

            let severity: 'warn' | 'error'
            let driftMessage: string
            if (!existsInCode) {
              severity = 'error'
              driftMessage = `${clause.type}: "${truncated}" present in epics source but absent in story artifact AND missing from code (architectural drift)`
            } else if (!referencedByStory) {
              severity = 'error'
              driftMessage = `${clause.type}: "${truncated}" present in epics source but absent in story artifact AND code path exists in repo but THIS story's modified files do not reference it (under-delivery — code path was created by a different story; this story did not wire it in)`
            } else {
              severity = 'warn'
              driftMessage = `${clause.type}: "${truncated}" present in epics source but absent in story artifact (code satisfies it — stylistic drift)`
            }
            findings.push({
              category: 'source-ac-drift',
              severity,
              message: driftMessage,
            })
          } else {
            // MUST/SHALL keyword clauses — no code-observable signal, stay advisory.
            findings.push({
              category: 'source-ac-drift',
              severity: 'warn',
              message: `${clause.type}: "${truncated}" present in epics source but absent in story artifact`,
            })
          }
        }
      }
    }

    const status = findings.some((f) => f.severity === 'error') ? 'fail' : 'pass'

    return {
      status,
      details:
        findings.length > 0
          ? renderFindings(findings)
          : `source-ac-fidelity: ${hardClauses.length} hard clause(s) verified — all present`,
      duration_ms: Date.now() - start,
      findings,
    }
  }
}
