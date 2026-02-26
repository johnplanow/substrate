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
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { createDecision, getDecisionsByPhase } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('implementation-orchestrator:seed')

// ---------------------------------------------------------------------------
// Budget constants — keep seeded values small enough to fit token ceilings
// ---------------------------------------------------------------------------

/** Max chars for the architecture summary seeded into decisions */
const MAX_ARCH_CHARS = 6_000

/** Max chars per epic shard */
const MAX_EPIC_SHARD_CHARS = 4_000

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
export function seedMethodologyContext(
  db: BetterSqlite3Database,
  projectRoot: string,
): SeedResult {
  const result: SeedResult = { decisionsCreated: 0, skippedCategories: [] }

  try {
    // Seed architecture constraints (consumed by code-review + create-story)
    const archCount = seedArchitecture(db, projectRoot)
    if (archCount === -1) {
      result.skippedCategories.push('architecture')
    } else {
      result.decisionsCreated += archCount
    }

    // Seed epic shards (consumed by create-story)
    const epicCount = seedEpicShards(db, projectRoot)
    if (epicCount === -1) {
      result.skippedCategories.push('epic-shard')
    } else {
      result.decisionsCreated += epicCount
    }

    // Seed test patterns (consumed by dev-story)
    const testCount = seedTestPatterns(db, projectRoot)
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
function seedArchitecture(db: BetterSqlite3Database, projectRoot: string): number {
  // Check if architecture decisions already exist
  const existing = getDecisionsByPhase(db, 'solutioning')
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
    createDecision(db, {
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
    createDecision(db, {
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
 * Parses each "## Epic N" section and creates an implementation/epic-shard decision.
 * Returns number of decisions created, or -1 if skipped (already seeded).
 */
function seedEpicShards(db: BetterSqlite3Database, projectRoot: string): number {
  // Check if epic-shard decisions already exist
  const existing = getDecisionsByPhase(db, 'implementation')
  if (existing.some((d) => d.category === 'epic-shard')) {
    return -1
  }

  const epicsPath = findArtifact(projectRoot, [
    '_bmad-output/planning-artifacts/epics.md',
    '_bmad-output/epics.md',
  ])
  if (epicsPath === undefined) return 0

  const content = readFileSync(epicsPath, 'utf-8')
  if (content.length === 0) return 0

  const shards = parseEpicShards(content)
  let count = 0

  for (const shard of shards) {
    createDecision(db, {
      pipeline_run_id: null,
      phase: 'implementation',
      category: 'epic-shard',
      key: shard.epicId,
      value: shard.content.slice(0, MAX_EPIC_SHARD_CHARS),
      rationale: 'Seeded from planning artifacts at orchestrator startup',
    })
    count++
  }

  logger.debug({ count }, 'Seeded epic shard decisions')
  return count
}

/**
 * Seed test patterns from project configuration.
 * Detects test framework from package.json and seeds appropriate patterns.
 * Returns number of decisions created, or -1 if skipped (already seeded).
 */
function seedTestPatterns(db: BetterSqlite3Database, projectRoot: string): number {
  // Check if test-patterns decisions already exist
  const existing = getDecisionsByPhase(db, 'solutioning')
  if (existing.some((d) => d.category === 'test-patterns')) {
    return -1
  }

  const patterns = detectTestPatterns(projectRoot)
  if (patterns === undefined) return 0

  createDecision(db, {
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
  const techStack = extractSection(content, /^##\s+(?:tech(?:nology)?\s*stack|stack\s*overview)/im)
  if (techStack !== undefined) {
    sections.push({ key: 'tech-stack', value: techStack })
  }

  // Extract ADRs section (or individual ADR summaries)
  const adrs = extractSection(content, /^##\s+(?:ADR|Architecture\s+Decision\s+Record)/im)
  if (adrs !== undefined) {
    sections.push({ key: 'adrs', value: adrs })
  }

  // Extract component/module overview
  const components = extractSection(content, /^##\s+(?:component|module|system)\s+(?:overview|architecture|structure)/im)
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
 * Matches "## Epic N" or "## N." or "## N:" section headings.
 */
function parseEpicShards(content: string): EpicShard[] {
  const shards: EpicShard[] = []
  // Match ## Epic N, ## N., ## N:, or ## N  (where N is a number)
  const epicPattern = /^## (?:Epic\s+)?(\d+)[.:\s]/gm

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

/**
 * Detect test framework and patterns from project configuration.
 * Reads package.json to determine vitest/jest/mocha and generates pattern docs.
 */
function detectTestPatterns(projectRoot: string): string | undefined {
  const pkgPath = join(projectRoot, 'package.json')
  if (!existsSync(pkgPath)) return undefined

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
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
      const firstTest = readFileSync(firstTestPath, 'utf-8')
      if (firstTest.includes('vitest') || firstTest.includes('vi.mock')) {
        return buildVitestPatterns(testScript)
      }
      if (firstTest.includes('@jest') || firstTest.includes('jest.mock')) {
        return buildJestPatterns(testScript)
      }
    }

    return undefined
  } catch {
    return undefined
  }
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
