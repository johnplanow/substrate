/**
 * seedMethodologyContext — Pre-populates the decision store with planning
 * artifacts so compiled workflows (dev-story, code-review) have rich context
 * without requiring the full BMAD phase-orchestrator to run first.
 *
 * Reads from _bmad-output/planning-artifacts/ and writes global decisions
 * (pipeline_run_id = null) that compiled workflow queries pick up automatically.
 *
 * Idempotent: skips categories that already have decisions for the relevant phase.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import type { DatabaseAdapter } from '../../persistence/adapter.js'
import { createDecision, getDecisionsByPhase, upsertDecision } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('implementation-orchestrator:seed')

// ---------------------------------------------------------------------------
// Budget constants — keep seeded values small enough to fit token ceilings
// ---------------------------------------------------------------------------

/** Max chars for the architecture summary seeded into decisions */
const MAX_ARCH_CHARS = 6_000

/** Max chars per epic-shard decision value (per-story or per-epic fallback) */
const MAX_EPIC_SHARD_CHARS = 12_000

/** Max chars for test patterns */
const MAX_TEST_PATTERNS_CHARS = 2_000

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SeedResult {
  /** Number of decisions written to the store */
  decisionsCreated: number
  /** Categories that were skipped because decisions already existed */
  skippedCategories: string[]
}

/**
 * Seed the decision store with methodology-level context from planning artifacts.
 *
 * Reads the following from `{projectRoot}/_bmad-output/planning-artifacts/`:
 * - architecture.md → solutioning/architecture decisions
 * - epics.md → implementation/epic-shard decisions (one per epic)
 * - package.json → solutioning/test-patterns decisions (framework detection)
 *
 * @param db - SQLite database instance
 * @param projectRoot - Absolute path to the target project root
 * @returns SeedResult with counts of decisions created and categories skipped
 */
export async function seedMethodologyContext(
  db: DatabaseAdapter,
  projectRoot: string,
): Promise<SeedResult> {
  const result: SeedResult = { decisionsCreated: 0, skippedCategories: [] }

  try {
    // Seed architecture constraints (consumed by code-review + create-story)
    const archCount = await seedArchitecture(db, projectRoot)
    if (archCount === -1) {
      result.skippedCategories.push('architecture')
    } else {
      result.decisionsCreated += archCount
    }

    // Seed epic shards (consumed by create-story)
    const epicCount = await seedEpicShards(db, projectRoot)
    if (epicCount === -1) {
      result.skippedCategories.push('epic-shard')
    } else {
      result.decisionsCreated += epicCount
    }

    // Seed test patterns (consumed by dev-story)
    const testCount = await seedTestPatterns(db, projectRoot)
    if (testCount === -1) {
      result.skippedCategories.push('test-patterns')
    } else {
      result.decisionsCreated += testCount
    }

    logger.info(
      { decisionsCreated: result.decisionsCreated, skippedCategories: result.skippedCategories },
      'Methodology context seeding complete',
    )
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Methodology context seeding failed (non-fatal)',
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Private seeders
// ---------------------------------------------------------------------------

/**
 * Seed architecture constraints from architecture.md.
 * Extracts key sections (tech stack, ADRs, component overview) as separate decisions.
 * Returns number of decisions created, or -1 if skipped (already seeded).
 */
async function seedArchitecture(db: DatabaseAdapter, projectRoot: string): Promise<number> {
  // Check if architecture decisions already exist
  const existing = await getDecisionsByPhase(db, 'solutioning')
  if (existing.some((d) => d.category === 'architecture')) {
    return -1
  }

  const archPath = findArtifact(projectRoot, [
    '_bmad-output/planning-artifacts/architecture.md',
    '_bmad-output/architecture/architecture.md',
    '_bmad-output/architecture.md',
  ])
  if (archPath === undefined) return 0

  const content = readFileSync(archPath, 'utf-8')
  if (content.length === 0) return 0

  // Extract key sections from architecture.md
  const sections = extractArchSections(content)
  let count = 0

  for (const section of sections) {
    await createDecision(db, {
      pipeline_run_id: null,
      phase: 'solutioning',
      category: 'architecture',
      key: section.key,
      value: section.value.slice(0, MAX_ARCH_CHARS),
      rationale: 'Seeded from planning artifacts at orchestrator startup',
    })
    count++
  }

  if (count === 0) {
    // Fallback: seed the whole file (truncated) as a single decision
    await createDecision(db, {
      pipeline_run_id: null,
      phase: 'solutioning',
      category: 'architecture',
      key: 'full',
      value: content.slice(0, MAX_ARCH_CHARS),
      rationale: 'Seeded from planning artifacts at orchestrator startup (full file)',
    })
    count = 1
  }

  logger.debug({ count }, 'Seeded architecture decisions')
  return count
}

/**
 * Seed epic shards from epics.md.
 * Parses each epic section and creates an implementation/epic-shard decision.
 *
 * Uses content-hash comparison (AC1, AC2, AC6):
 * - Computes SHA-256 of the epics file and compares to the stored `epic-shard-hash` decision.
 * - If hashes match: skip re-seeding (unchanged file).
 * - If hash differs or no hash stored: delete existing epic-shard decisions and re-seed.
 *
 * Returns number of decisions created, or -1 if skipped (hash unchanged).
 */
async function seedEpicShards(db: DatabaseAdapter, projectRoot: string): Promise<number> {
  const epicsPath = findArtifact(projectRoot, [
    '_bmad-output/planning-artifacts/epics.md',
    '_bmad-output/epics.md',
  ])
  if (epicsPath === undefined) return 0

  const content = readFileSync(epicsPath, 'utf-8')
  if (content.length === 0) return 0

  // Compute SHA-256 hash of the epics file content
  const currentHash = createHash('sha256').update(content).digest('hex')

  // Retrieve stored hash from the decision store
  const implementationDecisions = await getDecisionsByPhase(db, 'implementation')
  const storedHashDecision = implementationDecisions.find(
    (d) => d.category === 'epic-shard-hash' && d.key === 'epics-file',
  )
  const storedHash = storedHashDecision?.value

  // AC2: If hash matches, skip re-seeding
  if (storedHash === currentHash) {
    logger.debug({ hash: currentHash }, 'Epic shards up-to-date (hash unchanged) — skipping re-seed')
    return -1
  }

  // AC1/AC6: Hash differs or missing — delete existing epic-shard decisions and re-seed
  if (implementationDecisions.some((d) => d.category === 'epic-shard')) {
    logger.debug({ storedHash, currentHash }, 'Epics file changed — deleting stale epic-shard decisions')
    await db.exec("DELETE FROM decisions WHERE phase = 'implementation' AND category = 'epic-shard'")
  }

  const shards = parseEpicShards(content)
  let count = 0

  // The delete-by-category path above covers both pre-37-0 (key=epicId) and
  // post-37-0 (key=storyKey) rows because both share category='epic-shard'.
  for (const shard of shards) {
    // Parse story subsections within each epic (AC1, AC2, AC3)
    const subsections = parseStorySubsections(shard.epicId, shard.content)
    for (const subsection of subsections) {
      await createDecision(db, {
        pipeline_run_id: null,
        phase: 'implementation',
        category: 'epic-shard',
        key: subsection.key, // storyKey (e.g. '37-1') or epicId fallback (e.g. '37')
        value: subsection.content.slice(0, MAX_EPIC_SHARD_CHARS),
        rationale: 'Seeded from planning artifacts at orchestrator startup',
      })
      count++
    }
  }

  // Store/update the content hash so subsequent calls can skip re-seeding.
  // Use delete + create (not upsertDecision) because upsertDecision's SQL
  // `pipeline_run_id = ?` with null never matches existing NULL rows in SQLite.
  await db.exec(
    "DELETE FROM decisions WHERE phase = 'implementation' AND category = 'epic-shard-hash' AND `key` = 'epics-file'",
  )
  await createDecision(db, {
    pipeline_run_id: null,
    phase: 'implementation',
    category: 'epic-shard-hash',
    key: 'epics-file',
    value: currentHash,
    rationale: 'SHA-256 hash of epics file content for change detection',
  })

  logger.debug({ count, hash: currentHash }, 'Seeded epic shard decisions')
  return count
}

/**
 * Seed test patterns from project configuration.
 * Detects test framework from package.json and seeds appropriate patterns.
 * Returns number of decisions created, or -1 if skipped (already seeded).
 */
async function seedTestPatterns(db: DatabaseAdapter, projectRoot: string): Promise<number> {
  // Check if test-patterns decisions already exist
  const existing = await getDecisionsByPhase(db, 'solutioning')
  if (existing.some((d) => d.category === 'test-patterns')) {
    return -1
  }

  const patterns = detectTestPatterns(projectRoot)
  if (patterns === undefined) return 0

  await createDecision(db, {
    pipeline_run_id: null,
    phase: 'solutioning',
    category: 'test-patterns',
    key: 'framework',
    value: patterns.slice(0, MAX_TEST_PATTERNS_CHARS),
    rationale: 'Detected from project configuration at orchestrator startup',
  })

  logger.debug('Seeded test patterns decision')
  return 1
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface ArchSection {
  key: string
  value: string
}

/**
 * Extract key architecture sections from architecture.md content.
 * Targets: tech stack, ADRs summary, component/module overview.
 */
function extractArchSections(content: string): ArchSection[] {
  const sections: ArchSection[] = []

  // Extract tech stack section
  const techStack = extractSection(content, /^##\s+(?:tech(?:nology)?\s*stack|stack\s*overview|starter\s+template)/im)
  if (techStack !== undefined) {
    sections.push({ key: 'tech-stack', value: techStack })
  }

  // Extract ADRs / architectural decisions section
  const adrs = extractSection(content, /^##\s+(?:ADR|(?:core\s+)?architect(?:ure|ural)\s+decision)/im)
  if (adrs !== undefined) {
    sections.push({ key: 'adrs', value: adrs })
  }

  // Extract component/module overview or implementation patterns
  const components = extractSection(content, /^##\s+(?:(?:component|module|system)\s+(?:overview|architecture|structure)|implementation\s+patterns)/im)
  if (components !== undefined) {
    sections.push({ key: 'components', value: components })
  }

  // Extract project structure
  const structure = extractSection(content, /^##\s+(?:project|directory|folder)\s+structure/im)
  if (structure !== undefined) {
    sections.push({ key: 'project-structure', value: structure })
  }

  return sections
}

/**
 * Extract a section starting at the given heading pattern until the next ## heading or EOF.
 */
function extractSection(content: string, headingPattern: RegExp): string | undefined {
  const match = headingPattern.exec(content)
  if (match === null) return undefined

  const startIdx = match.index
  // Find next ## heading after this one
  const rest = content.slice(startIdx + match[0].length)
  const nextHeading = /\n## /m.exec(rest)
  const endIdx = nextHeading !== null
    ? startIdx + match[0].length + nextHeading.index
    : content.length

  const section = content.slice(startIdx, endIdx).trim()
  return section.length > 0 ? section : undefined
}

interface EpicShard {
  epicId: string
  content: string
}

/**
 * Parse epics.md into individual epic shards.
 * Matches "## Epic N", "### Epic N", "#### Epic N", or depth-2 to depth-4 numeric headings.
 */
function parseEpicShards(content: string): EpicShard[] {
  const shards: EpicShard[] = []
  // Match #{2,4} Epic N, #{2,4} N., #{2,4} N:, or #{2,4} N  (where N is a number)
  const epicPattern = /^#{2,4}\s+(?:Epic\s+)?(\d+)[.:\s]/gm

  let match: RegExpExecArray | null
  const matches: Array<{ epicNum: string; startIdx: number }> = []

  while ((match = epicPattern.exec(content)) !== null) {
    const epicNum = match[1]
    if (epicNum !== undefined) {
      matches.push({ epicNum, startIdx: match.index })
    }
  }

  for (let i = 0; i < matches.length; i++) {
    const entry = matches[i]!
    const nextEntry = matches[i + 1]
    const start = entry.startIdx
    const end = nextEntry !== undefined ? nextEntry.startIdx : content.length
    const sectionContent = content.slice(start, end).trim()

    if (sectionContent.length > 0) {
      shards.push({
        epicId: entry.epicNum,
        content: sectionContent,
      })
    }
  }

  return shards
}

export interface StorySubsection {
  /** storyKey (e.g. '37-1') or epicId fallback (e.g. '37') for unstructured epics */
  key: string
  content: string
}

/**
 * Parse an epic section's content into per-story subsections.
 *
 * Matches story headings using three patterns:
 *   - Markdown headings: #{2,6} Story \d+[-._ ]\d+  (e.g., ### Story 37-1: Title or ### Story 1.1)
 *   - Bold:              **Story \d+[-._ ]\d+**     (e.g., **Story 37-1**)
 *   - Bare key:          \d+[-._ ]\d+:\s            (e.g., 37-1: Title — must start at line start)
 *
 * Each subsection spans from its heading to the next matching heading or EOF.
 *
 * Story 58-17: separator normalization. The original regex required `\d+-\d+`
 * (dash-only). Strata uses `### Story 1.1` (dot-separated) per its BMAD-template
 * convention. Without separator-agnostic parsing, every Story 1.X heading was
 * silently invisible to this parser, the matches.length === 0 fallback path
 * fired, the entire epic was stored as ONE per-epic decision (key=epicId)
 * truncated at 12K chars. All stories past the truncation point (1.6, 1.8,
 * 1.9+ in strata's case) were lost from the decisions store, which is the
 * actual root cause of strata obs_2026-04-20_001 — create-story received
 * empty input for those stories and hallucinated specs from domain priors.
 *
 * Epic 58-5 already made `extractStorySection` separator-agnostic for the
 * same reason; this matches that precedent at the seed-time parser.
 *
 * Captured storyKey is normalized to canonical dash-form (`1.1` → `1-1`) so
 * decision keys are consistent regardless of the source heading style — a
 * `--stories 1-9` CLI invocation finds the shard whether the epic used dot,
 * dash, underscore, or space separators.
 *
 * AC3: If no story headings are found, returns a single per-epic fallback entry
 * keyed by epicId — preserving backward-compatible behaviour for unstructured epics.
 */
export function parseStorySubsections(epicId: string, epicContent: string): StorySubsection[] {
  // Combined pattern: capture group 1 = markdown heading match, 2 = bold match, 3 = bare key match.
  // Each branch accepts dash/dot/underscore/space separators (Story 58-17).
  const storyPattern =
    /(?:^#{2,6}\s+Story\s+(\d+[-._ ]\d+)|^\*\*Story\s+(\d+[-._ ]\d+)\*\*|^(\d+[-._ ]\d+):\s)/gim

  const matches: Array<{ storyKey: string; startIdx: number }> = []
  let match: RegExpExecArray | null

  while ((match = storyPattern.exec(epicContent)) !== null) {
    const rawKey = match[1] ?? match[2] ?? match[3]
    if (rawKey !== undefined) {
      // Normalize separator characters to canonical dash-form so decisions are
      // looked up reliably by `--stories 1-9` regardless of the heading style.
      const storyKey = rawKey.replace(/[._ ]/g, '-')
      matches.push({ storyKey, startIdx: match.index })
    }
  }

  // AC3: No story headings → per-epic fallback keyed by epicId
  if (matches.length === 0) {
    return [{ key: epicId, content: epicContent }]
  }

  // Split content at story boundaries
  const result: StorySubsection[] = []
  for (let i = 0; i < matches.length; i++) {
    const entry = matches[i]!
    const nextEntry = matches[i + 1]
    const start = entry.startIdx
    const end = nextEntry !== undefined ? nextEntry.startIdx : epicContent.length
    const sectionContent = epicContent.slice(start, end).trim()

    if (sectionContent.length > 0) {
      result.push({ key: entry.storyKey, content: sectionContent })
    }
  }

  return result
}

/**
 * Read the project profile YAML synchronously.
 * Returns null on missing file, parse error, or unexpected shape.
 * Does NOT import from src/modules/project-profile/ — inline parse only.
 *
 * @internal
 */
function readProfileSync(projectRoot: string): Record<string, unknown> | null {
  const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) return null
  try {
    const content = readFileSync(profilePath, 'utf-8')
    const parsed = yaml.load(content)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/**
 * Detect test framework and patterns from project configuration.
 *
 * Detection priority:
 *   1. Profile present + packages[] non-empty  → buildMonorepoTestPatterns(packages)
 *   2. Profile present + testCommand non-empty  → mapTestCommandToPatterns(testCommand)
 *   3. No profile / profile fallthrough:
 *      a. package.json present                  → existing vitest/jest/mocha detection
 *      b. go.mod present                        → buildGoTestPatterns(projectRoot)
 *      c. build.gradle.kts or build.gradle      → buildGradleTestPatterns(projectRoot)
 *      d. pom.xml                               → buildMavenTestPatterns()
 *      e. Cargo.toml                            → buildCargoTestPatterns()
 *      f. pyproject.toml OR conftest.py         → buildPytestPatterns(projectRoot)
 *   4. Nothing matched → undefined
 *
 * @internal exported for direct unit testing
 */
export function detectTestPatterns(projectRoot: string): string | undefined {
  // Step 1 & 2: Profile-driven detection
  const profile = readProfileSync(projectRoot)
  if (profile !== null) {
    const project = profile['project'] as Record<string, unknown> | undefined
    if (project !== undefined) {
      const packages = project['packages']
      if (Array.isArray(packages) && packages.length > 0) {
        // Step 1: monorepo — build combined patterns
        return buildMonorepoTestPatterns(packages as Array<{ language?: string; path?: string }>)
      }
      const testCommand = project['testCommand']
      if (typeof testCommand === 'string' && testCommand.length > 0) {
        // Step 2: single project with testCommand
        const mapped = mapTestCommandToPatterns(testCommand)
        if (mapped !== undefined) return mapped
        // fall through if unrecognized
      }
    }
  }

  // Step 3a: Node.js — existing detection unchanged
  const pkgPath = join(projectRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8') as string)
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      }

      // Also check for test config files
      const hasVitestConfig = existsSync(join(projectRoot, 'vitest.config.ts'))
        || existsSync(join(projectRoot, 'vitest.config.js'))
        || existsSync(join(projectRoot, 'vite.config.ts'))

      const hasJestConfig = existsSync(join(projectRoot, 'jest.config.ts'))
        || existsSync(join(projectRoot, 'jest.config.js'))

      // Check for test script in package.json
      const testScript = pkg.scripts?.test ?? ''

      if (allDeps.vitest !== undefined || hasVitestConfig || testScript.includes('vitest')) {
        return buildVitestPatterns(testScript)
      }

      if (allDeps.jest !== undefined || hasJestConfig || testScript.includes('jest')) {
        return buildJestPatterns(testScript)
      }

      if (allDeps.mocha !== undefined || testScript.includes('mocha')) {
        return buildMochaPatterns()
      }

      // Check for test files to infer framework
      const testFiles = findTestFiles(projectRoot)
      const firstTestPath = testFiles[0]
      if (firstTestPath !== undefined) {
        // Read first test file to detect imports
        const firstTest = readFileSync(firstTestPath, 'utf-8') as string
        if (firstTest.includes('vitest') || firstTest.includes('vi.mock')) {
          return buildVitestPatterns(testScript)
        }
        if (firstTest.includes('@jest') || firstTest.includes('jest.mock')) {
          return buildJestPatterns(testScript)
        }
      }
      // No recognized framework found in a valid package.json
      return undefined
    } catch {
      // JSON parse failure — non-fatal, fall through to polyglot probes
    }
  }

  // Step 3b: Go
  if (existsSync(join(projectRoot, 'go.mod'))) {
    return buildGoTestPatterns(projectRoot)
  }

  // Step 3c: Gradle (JVM)
  if (
    existsSync(join(projectRoot, 'build.gradle.kts'))
    || existsSync(join(projectRoot, 'build.gradle'))
  ) {
    return buildGradleTestPatterns(projectRoot)
  }

  // Step 3d: Maven (JVM)
  if (existsSync(join(projectRoot, 'pom.xml'))) {
    return buildMavenTestPatterns()
  }

  // Step 3e: Rust
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return buildCargoTestPatterns()
  }

  // Step 3f: Python/pytest
  // conftest.py is pytest-specific — its presence alone is sufficient
  if (existsSync(join(projectRoot, 'conftest.py'))) {
    return buildPytestPatterns(projectRoot)
  }
  // pyproject.toml is used by many Python tools (Poetry, Flit, PDM) — only trigger
  // pytest detection when it actually contains a [tool.pytest section
  if (existsSync(join(projectRoot, 'pyproject.toml'))) {
    try {
      const pyprojectContent = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf-8') as string
      if (pyprojectContent.includes('[tool.pytest')) {
        return buildPytestPatterns(projectRoot)
      }
    } catch {
      // Non-fatal — file unreadable, no pytest patterns
    }
  }

  return undefined
}

function buildVitestPatterns(testScript: string): string {
  const runCmd = testScript || 'npx vitest run'
  return [
    '## Test Patterns',
    '- Framework: Vitest',
    '- Mock approach: vi.mock() with hoisting for module-level mocks',
    '- Assertion style: expect().toBe(), expect().toEqual(), expect().toThrow()',
    '- Test structure: describe/it blocks with beforeEach/afterEach',
    '- Coverage: 80% enforced — run full suite, not filtered',
    `- Run tests: ${runCmd}`,
    '- IMPORTANT: Do NOT use --testPathPattern (jest flag). Use: npx vitest run -- "pattern"',
  ].join('\n')
}

function buildJestPatterns(testScript: string): string {
  const runCmd = testScript || 'npx jest'
  return [
    '## Test Patterns',
    '- Framework: Jest',
    '- Mock approach: jest.mock() with automatic hoisting',
    '- Assertion style: expect().toBe(), expect().toEqual(), expect().toThrow()',
    '- Test structure: describe/it blocks with beforeEach/afterEach',
    `- Run tests: ${runCmd}`,
    '- Filter tests: npx jest --testPathPattern "pattern"',
  ].join('\n')
}

function buildMochaPatterns(): string {
  return [
    '## Test Patterns',
    '- Framework: Mocha',
    '- Assertion style: chai expect/should or node:assert',
    '- Test structure: describe/it blocks with before/after hooks',
    '- Run tests: npx mocha',
  ].join('\n')
}

/**
 * Build Go test patterns.
 * Optionally detects testify from go.mod if projectRoot is non-empty.
 *
 * @internal
 */
function buildGoTestPatterns(projectRoot: string): string {
  let hasTestify = false
  if (projectRoot.length > 0) {
    try {
      const goModPath = join(projectRoot, 'go.mod')
      if (existsSync(goModPath)) {
        const content = readFileSync(goModPath, 'utf-8') as string
        hasTestify = content.includes('github.com/stretchr/testify')
      }
    } catch {
      // Non-fatal
    }
  }
  return [
    '## Test Patterns',
    '- Framework: Go test (stdlib)',
    '- Test file naming: <module>_test.go alongside source files',
    '- Test structure: table-driven tests with t.Run() subtests',
    '- Run all tests: go test ./...',
    '- Run specific test: go test ./... -v -run TestFunctionName',
    '- Assertion style: t.Errorf(), t.Fatalf()',
    hasTestify ? '- testify available: use require.Equal(), assert.NoError(), etc.' : '',
  ].filter(Boolean).join('\n')
}

/**
 * Build Gradle (JVM) test patterns.
 * Detects JUnit5 vs JUnit4 if projectRoot is non-empty.
 *
 * @internal
 */
function buildGradleTestPatterns(projectRoot: string): string {
  let hasJunit5 = false
  if (projectRoot.length > 0) {
    try {
      const ktsPath = join(projectRoot, 'build.gradle.kts')
      const groovyPath = join(projectRoot, 'build.gradle')
      const buildFilePath = existsSync(ktsPath) ? ktsPath : groovyPath
      if (existsSync(buildFilePath)) {
        const content = readFileSync(buildFilePath, 'utf-8') as string
        hasJunit5 = content.includes('junit-jupiter')
      }
    } catch {
      // Non-fatal
    }
  }
  return [
    '## Test Patterns',
    `- Framework: ${hasJunit5 ? 'JUnit 5' : 'JUnit'}`,
    '- Run all tests: ./gradlew test',
    '- Run specific test: ./gradlew test --tests "com.example.ClassName"',
    '- Test annotation: @Test',
    hasJunit5 ? '- Assertion style: assertThat() (AssertJ), assertEquals()' : '- Assertion style: assertEquals(), assertThat()',
  ].join('\n')
}

/**
 * Build Maven (JVM) test patterns.
 *
 * @internal
 */
function buildMavenTestPatterns(): string {
  return [
    '## Test Patterns',
    '- Framework: JUnit (Maven)',
    '- Run all tests: mvn test',
    '- Run specific test: mvn test -Dtest=ClassName',
    '- Test annotation: @Test',
    '- Assertion style: assertEquals(), assertThat()',
  ].join('\n')
}

/**
 * Build Cargo/Rust test patterns.
 *
 * @internal
 */
function buildCargoTestPatterns(): string {
  return [
    '## Test Patterns',
    '- Framework: Rust built-in test harness (cargo test)',
    '- Run all tests: cargo test',
    '- Run specific test: cargo test module_name',
    '- Test annotation: #[test]',
    '- Assertion macros: assert_eq!(), assert!(), assert_ne!()',
    '- Test module structure: #[cfg(test)] mod tests { ... }',
  ].join('\n')
}

/**
 * Build pytest (Python) test patterns.
 * Checks for conftest.py and pyproject.toml for context.
 *
 * @internal
 */
function buildPytestPatterns(projectRoot: string): string {
  let hasConftest = false
  if (projectRoot.length > 0) {
    try {
      hasConftest = existsSync(join(projectRoot, 'conftest.py'))
    } catch {
      // Non-fatal
    }
  }
  return [
    '## Test Patterns',
    '- Framework: pytest',
    '- Run all tests: pytest',
    '- Run specific test: pytest tests/test_file.py -v -k "test_name"',
    '- Fixture pattern: @pytest.fixture (define in conftest.py for sharing)',
    '- Assertion style: assert statement (plain Python)',
    hasConftest ? '- conftest.py detected: shared fixtures available' : '',
  ].filter(Boolean).join('\n')
}

/**
 * Map a profile testCommand string to appropriate pattern builder output.
 * Returns undefined for unrecognized commands.
 *
 * @internal
 */
function mapTestCommandToPatterns(testCommand: string): string | undefined {
  if (testCommand.includes('go test')) return buildGoTestPatterns('')
  if (testCommand.includes('gradlew') || testCommand.includes('gradle')) return buildGradleTestPatterns('')
  if (testCommand.includes('mvn')) return buildMavenTestPatterns()
  if (testCommand.includes('cargo test')) return buildCargoTestPatterns()
  if (testCommand.includes('pytest')) return buildPytestPatterns('')
  if (testCommand.includes('vitest')) return buildVitestPatterns(testCommand)
  if (testCommand.includes('jest')) return buildJestPatterns(testCommand)
  if (testCommand.includes('mocha')) return buildMochaPatterns()
  return undefined
}

/**
 * Build combined test patterns for a monorepo with multiple language packages.
 * Emits a concise per-language block for each distinct language, prefixed with package path.
 *
 * @internal
 */
function buildMonorepoTestPatterns(packages: Array<{ language?: string; path?: string }>): string {
  // Build a map: language → first matching package path
  const seen = new Set<string>()
  const entries: Array<{ language: string; path: string }> = []

  for (const pkg of packages) {
    if (typeof pkg.language === 'string' && pkg.language.length > 0 && !seen.has(pkg.language)) {
      seen.add(pkg.language)
      entries.push({ language: pkg.language, path: pkg.path ?? '' })
    }
  }

  const blocks: string[] = []

  for (const entry of entries) {
    const header = entry.path.length > 0
      ? `# ${entry.path} (${entry.language})`
      : `# ${entry.language}`
    let block: string

    switch (entry.language) {
      case 'go':
        block = [header, '- go test ./...', '- go test ./... -v -run TestName', '- File naming: _test.go'].join('\n')
        break
      case 'typescript':
      case 'javascript':
        block = [header, '- npx vitest run (or npm test)', '- vi.mock() for mocking', '- describe/it structure'].join('\n')
        break
      case 'java':
      case 'kotlin':
        block = [header, '- ./gradlew test', '- @Test annotation', '- assertEquals() / assertThat()'].join('\n')
        break
      case 'rust':
        block = [header, '- cargo test', '- #[test] attribute', '- assert_eq!() / assert!()'].join('\n')
        break
      case 'python':
        block = [header, '- pytest', '- @pytest.fixture', '- assert statement style'].join('\n')
        break
      default:
        block = [header, `- Run tests for ${entry.language} package`].join('\n')
    }

    blocks.push(block)
  }

  return ['## Test Patterns', ...blocks].join('\n\n')
}

/**
 * Find a few test files in the project to help detect the test framework.
 */
function findTestFiles(projectRoot: string): string[] {
  const results: string[] = []
  const srcDir = join(projectRoot, 'src')
  if (!existsSync(srcDir)) return results

  try {
    scanForTests(srcDir, results, 3)
  } catch {
    // Non-fatal
  }
  return results
}

function scanForTests(dir: string, results: string[], limit: number): void {
  if (results.length >= limit) return

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= limit) return

    const fullPath = join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      scanForTests(fullPath, results, limit)
    } else if (entry.isFile() && /\.test\.[tj]sx?$/.test(entry.name)) {
      results.push(fullPath)
    }
  }
}

// ---------------------------------------------------------------------------
// File resolution helper
// ---------------------------------------------------------------------------

/**
 * Find the first existing file from a list of candidate paths relative to projectRoot.
 */
function findArtifact(projectRoot: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const fullPath = join(projectRoot, candidate)
    if (existsSync(fullPath)) return fullPath
  }
  return undefined
}
