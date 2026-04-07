/**
 * Implementation Orchestrator — factory and core implementation.
 *
 * Orchestrates the create-story → dev-story → code-review pipeline for a set
 * of story keys with retry logic, escalation, parallel conflict-group
 * execution, pause/resume control, and SQLite state persistence.
 */

import type { DatabaseAdapter } from '../../persistence/adapter.js'
import type { MethodologyPack } from '../methodology-pack/types.js'
import type { ContextCompiler } from '../context-compiler/context-compiler.js'
import type { Dispatcher } from '../agent-dispatch/types.js'
import type { TypedEventBus } from '../../core/event-bus.js'
import type { TokenCeilings } from '../config/config-schema.js'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, basename } from 'node:path'
import yaml from 'js-yaml'
import { updatePipelineRun, getDecisionsByPhase, getDecisionsByCategory, registerArtifact, createDecision } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { writeStoryMetrics, aggregateTokenUsageForStory } from '../../persistence/queries/metrics.js'
import { STORY_METRICS, ESCALATION_DIAGNOSIS, STORY_OUTCOME, TEST_EXPANSION_FINDING, ADVISORY_NOTES } from '../../persistence/schemas/operational.js'
import { generateEscalationDiagnosis } from './escalation-diagnosis.js'
import { getProjectFindings } from './project-findings.js'
import { assemblePrompt } from '../compiled-workflows/prompt-assembler.js'
import { DevStoryResultSchema } from '../compiled-workflows/schemas.js'
import { runCreateStory, isValidStoryFile, extractStorySection } from '../compiled-workflows/create-story.js'
import { runDevStory } from '../compiled-workflows/dev-story.js'
import { runCodeReview } from '../compiled-workflows/code-review.js'
import { runTestPlan } from '../compiled-workflows/test-plan.js'
import { runTestExpansion } from '../compiled-workflows/test-expansion.js'
import { analyzeStoryComplexity, planTaskBatches } from '../compiled-workflows/index.js'
import { detectConflictGroupsWithContracts } from './conflict-detector.js'
import type { ContractDeclaration } from './conflict-detector.js'
import { inspectProcessTree } from '../../cli/commands/health.js'
import type { ImplementationOrchestrator } from './orchestrator.js'
import type {
  OrchestratorConfig,
  OrchestratorState,
  OrchestratorStatus,
  StoryPhase,
  StoryState,
  DecompositionMetrics,
  PerBatchMetrics,
} from './types.js'
import { addTokenUsage } from '../../persistence/queries/decisions.js'
import { createLogger } from '../../utils/logger.js'
import { seedMethodologyContext } from './seed-methodology-context.js'
import { capturePackageSnapshot, detectPackageChanges, restorePackageSnapshot } from './package-snapshot.js'
import type { PackageSnapshotData } from './package-snapshot.js'
import { sleep } from '../../utils/helpers.js'
import { runBuildVerification, checkGitDiffFiles } from '../agent-dispatch/dispatcher-impl.js'
import { detectInterfaceChanges } from '../agent-dispatch/interface-change-detector.js'
import { computeStoryComplexity, resolveFixStoryMaxTurns, resolveDevStoryMaxTurns, logComplexityResult } from '../compiled-workflows/story-complexity.js'
import { parseInterfaceContracts } from '../compiled-workflows/interface-contracts.js'
import { verifyContracts } from './contract-verifier.js'
import type { ContractMismatch } from './types.js'
import type { StateStore, StoryRecord, ContractRecord, ContractVerificationRecord, WgStoryStatus } from '../state/index.js'
import { DoltMergeConflict, WorkGraphRepository } from '../state/index.js'
import type { ITelemetryPersistence } from '../telemetry/index.js'
import { EfficiencyScorer, Categorizer, ConsumerAnalyzer, TelemetryNormalizer, TurnAnalyzer, LogTurnAnalyzer, Recommender } from '../telemetry/index.js'
import type { IngestionServer } from '../telemetry/ingestion-server.js'
import { TelemetryPipeline } from '../telemetry/telemetry-pipeline.js'
import { createTelemetryAdvisor } from '../telemetry/telemetry-advisor.js'
import type { TelemetryAdvisor } from '../telemetry/telemetry-advisor.js'
import type { RepoMapInjector } from '../context-compiler/index.js'
import type { SdlcEvents } from '@substrate-ai/sdlc'
import { createDefaultVerificationPipeline } from '@substrate-ai/sdlc'
import type { ReviewSignals } from '@substrate-ai/sdlc'
import type { RunManifest, PerStoryStatus } from '@substrate-ai/sdlc'
import type { TypedEventBus as GenericTypedEventBus } from '@substrate-ai/core'
import { assembleVerificationContext, VerificationStore, persistVerificationResult } from './verification-integration.js'
import type { OrchestratorEvents } from '../../core/event-bus.types.js'
import { CostGovernanceChecker } from './cost-governance.js'
import type { CeilingCheckResult } from './cost-governance.js'
import type { RunManifestData } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Compile-time safety assertions for verificationBusAdapter (Story 51-5)
// ---------------------------------------------------------------------------
//
// The verification pipeline emits exactly two events: 'verification:check-complete'
// and 'verification:story-complete'. Both must be declared in OrchestratorEvents with
// payload types compatible with SdlcEvents. These `never`-branching types are evaluated
// by the TypeScript compiler on every build — if OrchestratorEvents ever drops either
// event or changes its payload, the build fails here (not silently at runtime).
//
/* eslint-disable @typescript-eslint/no-unused-vars */
type _AssertCheckCompleteCompat =
  OrchestratorEvents['verification:check-complete'] extends SdlcEvents['verification:check-complete']
    ? true
    : never

type _AssertStoryCompleteCompat =
  OrchestratorEvents['verification:story-complete'] extends SdlcEvents['verification:story-complete']
    ? true
    : never
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Project the monolith event bus to `TypedEventBus<SdlcEvents>` for VerificationPipeline.
 *
 * RUNTIME SAFETY (verified by compile-time assertions above):
 *  1. OrchestratorEvents declares 'verification:check-complete' and
 *     'verification:story-complete' with payload types that extend their SdlcEvents
 *     counterparts (proven by _AssertCheckCompleteCompat / _AssertStoryCompleteCompat).
 *  2. VerificationPipeline ONLY calls bus.emit() — never bus.on() or bus.off().
 *     Confirm: grep "this._bus\." packages/sdlc/src/verification/verification-pipeline.ts
 *  3. TypedEventBusImpl is backed by Node.js EventEmitter — a string→handler map
 *     that is fully type-agnostic at runtime. No events are silently missed.
 *
 * TypeScript cannot perform the direct cast because TypedEventBus uses a generic
 * method signature (`emit<K extends keyof E>`) rather than concrete overloads, which
 * prevents the structural variance check it would need. The `as unknown` intermediate
 * is isolated to this one function so the rest of the call site stays clean.
 */
function toSdlcEventBus(bus: TypedEventBus): GenericTypedEventBus<SdlcEvents> {
  return bus as unknown as GenericTypedEventBus<SdlcEvents>
}

// ---------------------------------------------------------------------------
// Cost estimation helper (Claude pricing: $3/1M input, $15/1M output)
// ---------------------------------------------------------------------------

function estimateDispatchCost(input: number, output: number): number {
  return (input * 3 + output * 15) / 1_000_000
}

// ---------------------------------------------------------------------------
// OrchestratorDeps
// ---------------------------------------------------------------------------

/**
 * Dependency injection container for the implementation orchestrator.
 */
export interface OrchestratorDeps {
  /** Database adapter instance */
  db: DatabaseAdapter
  /** Loaded methodology pack */
  pack: MethodologyPack
  /** Context compiler for assembling decision-store context */
  contextCompiler: ContextCompiler
  /** Agent dispatcher for sub-agent spawning */
  dispatcher: Dispatcher
  /** Typed event bus for lifecycle events */
  eventBus: TypedEventBus
  /** Orchestrator configuration */
  config: OrchestratorConfig
  /** Optional project root for file-based context fallback */
  projectRoot?: string
  /** Optional per-workflow token ceiling overrides from parsed config (Story 24-7) */
  tokenCeilings?: TokenCeilings
  /** Optional StateStore for durable story state persistence (Story 26-4) */
  stateStore?: StateStore
  /** Optional telemetry persistence for efficiency scoring (Story 27-6) */
  telemetryPersistence?: ITelemetryPersistence
  /** Optional OTLP ingestion server for agent telemetry export (Story 27-9) */
  ingestionServer?: IngestionServer
  /** Optional repo-map injector for structural context injection (Story 28-9) */
  repoMapInjector?: RepoMapInjector
  /** Optional token budget for repo-map context injection (Story 28-9) */
  maxRepoMapTokens?: number
  /**
   * Optional agent backend identifier (e.g., 'claude-code', 'codex', 'gemini').
   * When set, all orchestrator dispatches use this agent instead of the default 'claude-code'.
   */
  agentId?: string
  /**
   * Optional run manifest for per-story lifecycle state tracking (Story 52-4).
   * When provided, the orchestrator records dispatched/terminal transitions
   * via patchStoryState (best-effort, non-fatal). Null disables all manifest writes.
   */
  runManifest?: RunManifest | null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pause gate: a promise that resolves when resume() is called.
 * The orchestrator awaits this before starting each new phase.
 */
interface PauseGate {
  promise: Promise<void>
  resolve: () => void
}

function createPauseGate(): PauseGate {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Build the targeted_files content string from a code-review issue list.
 * Deduplicates file paths and includes line numbers where available.
 * Returns empty string when no issues have file references.
 */
function buildTargetedFilesContent(issueList: unknown[]): string {
  const seen = new Map<string, Set<number>>()
  for (const issue of issueList) {
    const iss = issue as { file?: string; line?: number }
    if (!iss.file) continue
    if (!seen.has(iss.file)) seen.set(iss.file, new Set())
    if (iss.line !== undefined) seen.get(iss.file)!.add(iss.line)
  }
  if (seen.size === 0) return ''
  const lines: string[] = []
  for (const [file, lineNums] of seen) {
    if (lineNums.size > 0) {
      const sorted = [...lineNums].sort((a, b) => a - b)
      lines.push(`- ${file} (lines: ${sorted.join(', ')})`)
    } else {
      lines.push(`- ${file}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Story title validation — word-overlap similarity check
// ---------------------------------------------------------------------------

/**
 * Normalize a title string into a set of meaningful words for comparison.
 * Strips punctuation, lowercases, and filters out very short words (<=2 chars)
 * and common stop words to focus on content-bearing terms.
 */
function titleToWordSet(title: string): Set<string> {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'via'])
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w)),
  )
}

/**
 * Compute the word overlap ratio between two titles.
 * Returns a value between 0 and 1, where 1 means all words in the smaller set
 * are present in the larger set.
 *
 * Uses the smaller set as the denominator so that a generated title that is a
 * reasonable subset or superset of the expected title still scores well.
 */
function computeTitleOverlap(titleA: string, titleB: string): number {
  const wordsA = titleToWordSet(titleA)
  const wordsB = titleToWordSet(titleB)
  if (wordsA.size === 0 || wordsB.size === 0) return 0

  let shared = 0
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++
  }
  // Use the smaller set size as denominator
  const denominator = Math.min(wordsA.size, wordsB.size)
  return shared / denominator
}

/**
 * Extract the expected story title from the epic shard content.
 *
 * Looks for patterns like:
 *   - "### Story 37-1: Turborepo monorepo scaffold"
 *   - "Story 37-1: Turborepo monorepo scaffold"
 *   - "**37-1**: Turborepo monorepo scaffold"
 *   - "37-1: Turborepo monorepo scaffold"
 *
 * Returns the title portion after the story key, or null if no match.
 */
function extractExpectedStoryTitle(shardContent: string, storyKey: string): string | null {
  if (!shardContent || !storyKey) return null
  const escaped = storyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // Try heading patterns: "### Story 37-1: Title" or "Story 37-1: Title" or "**37-1**: Title" or "37-1: Title"
  const patterns = [
    new RegExp(`^#{2,4}\\s+Story\\s+${escaped}[:\\s]+\\s*(.+)$`, 'mi'),
    new RegExp(`^Story\\s+${escaped}[:\\s]+\\s*(.+)$`, 'mi'),
    new RegExp(`^\\*\\*${escaped}\\*\\*[:\\s]+\\s*(.+)$`, 'mi'),
    new RegExp(`^${escaped}[:\\s]+\\s*(.+)$`, 'mi'),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(shardContent)
    if (match?.[1]) {
      // Clean up: remove trailing markdown formatting, trim
      return match[1].replace(/\*+$/, '').trim()
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// AC satisfaction pre-check (pipeline finding: wasted dispatches)
// ---------------------------------------------------------------------------

/**
 * Check whether a story's expected NEW files already exist in the working tree,
 * indicating the story was implicitly implemented by adjacent stories.
 *
 * Parses the consolidated epics document for the story's "Files likely touched"
 * section and checks for files marked as "(new)". If all expected new files
 * already exist, the story is considered implicitly covered.
 *
 * Returns `true` if the story appears already covered, `false` otherwise.
 */
function isImplicitlyCovered(storyKey: string, projectRoot: string): boolean {
  // Find the consolidated epics file
  const planningDir = join(projectRoot, '_bmad-output', 'planning-artifacts')
  if (!existsSync(planningDir)) return false

  let epicsPath: string | undefined
  try {
    const entries = readdirSync(planningDir, { encoding: 'utf-8' })
    const match = entries.find((e) => /^epics[-.].*\.md$/i.test(e) && !(/^epic-\d+/.test(e)))
    if (match) epicsPath = join(planningDir, match)
  } catch {
    return false
  }
  if (!epicsPath) return false

  let content: string
  try {
    content = readFileSync(epicsPath, 'utf-8')
  } catch {
    return false
  }

  // Find the story's section
  const escapedKey = storyKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const storyHeading = new RegExp(`^###\\s+Story\\s+${escapedKey}[:\\s]`, 'm')
  const headingMatch = storyHeading.exec(content)
  if (!headingMatch) return false

  // Extract section until next story heading or end
  const sectionStart = headingMatch.index
  const nextHeading = content.indexOf('\n### Story ', sectionStart + 1)
  const section = nextHeading > 0 ? content.slice(sectionStart, nextHeading) : content.slice(sectionStart)

  // Find "Files likely touched:" block
  const filesIdx = section.indexOf('Files likely touched:')
  if (filesIdx < 0) return false

  // Extract file paths marked as "(new)"
  const filesBlock = section.slice(filesIdx)
  const newFilePattern = /^-\s*`([^`]+)`\s*\(new\)/gm
  const expectedNewFiles: string[] = []
  let fm: RegExpExecArray | null
  while ((fm = newFilePattern.exec(filesBlock)) !== null) {
    if (fm[1]) expectedNewFiles.push(fm[1])
  }

  // No new files expected — can't determine coverage
  if (expectedNewFiles.length === 0) return false

  // Check if all expected new files exist
  const existCount = expectedNewFiles.filter((f) => existsSync(join(projectRoot, f))).length
  return existCount === expectedNewFiles.length
}

// ---------------------------------------------------------------------------
// Auto-ingest epics dependencies into work graph
// ---------------------------------------------------------------------------

import { EpicIngester } from '../work-graph/epic-ingester.js'
import type { ParsedStory, ParsedDependency } from '../work-graph/epic-parser.js'
import { parseEpicsDependencies, findEpicsFile } from './story-discovery.js'

/**
 * Auto-ingest stories and inter-story dependencies from the consolidated
 * epics document into the work graph (`wg_stories` + `story_dependencies`).
 *
 * This bridges the gap between Level 4 discovery (file-based, no dependency
 * gating) and Level 1.5 discovery (`ready_stories` view, dependency-aware).
 *
 * Idempotent: existing stories preserve their status; dependencies are
 * replaced per-epic (EpicIngester's delete-and-reinsert pattern).
 */
async function autoIngestEpicsDependencies(
  db: DatabaseAdapter,
  projectRoot: string,
): Promise<{ storiesIngested: number; dependenciesIngested: number }> {
  const epicsPath = findEpicsFile(projectRoot)
  if (!epicsPath) return { storiesIngested: 0, dependenciesIngested: 0 }

  let content: string
  try {
    content = readFileSync(epicsPath, 'utf-8')
  } catch {
    return { storiesIngested: 0, dependenciesIngested: 0 }
  }

  // Parse story headings: ### Story N-M: Title
  const storyPattern = /^###\s+Story\s+(\d+)-(\d+):\s+(.+)$/gm
  const stories: ParsedStory[] = []
  let match: RegExpExecArray | null
  while ((match = storyPattern.exec(content)) !== null) {
    const epicNum = parseInt(match[1]!, 10)
    const storyNum = parseInt(match[2]!, 10)
    stories.push({
      story_key: `${epicNum}-${storyNum}`,
      epic_num: epicNum,
      story_num: storyNum,
      title: match[3]!.trim(),
      priority: 'P0',
      size: 'Medium',
      sprint: 0,
    })
  }

  if (stories.length === 0) return { storiesIngested: 0, dependenciesIngested: 0 }

  // Parse dependencies using the existing parser from story-discovery
  const allKeys = new Set(stories.map((s) => s.story_key))
  const depMap = parseEpicsDependencies(projectRoot, allKeys)

  const dependencies: ParsedDependency[] = []
  for (const [dependent, depSet] of depMap) {
    for (const dep of depSet) {
      dependencies.push({
        story_key: dependent,
        depends_on: dep,
        dependency_type: 'blocks',
        source: 'explicit',
      })
    }
  }

  // Ensure work graph tables exist
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS wg_stories (
      story_key VARCHAR(20) NOT NULL,
      epic VARCHAR(20) NOT NULL,
      title VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      spec_path VARCHAR(500),
      created_at DATETIME,
      updated_at DATETIME,
      completed_at DATETIME,
      PRIMARY KEY (story_key)
    )`)
    await db.query(`CREATE TABLE IF NOT EXISTS story_dependencies (
      story_key VARCHAR(50) NOT NULL,
      depends_on VARCHAR(50) NOT NULL,
      dependency_type VARCHAR(50) NOT NULL DEFAULT 'blocks',
      source VARCHAR(50) NOT NULL DEFAULT 'explicit',
      created_at DATETIME,
      PRIMARY KEY (story_key, depends_on)
    )`)
  } catch {
    // Tables may already exist or DB may not support DDL
  }

  const ingester = new EpicIngester(db)
  const result = await ingester.ingest(stories, dependencies)

  return {
    storiesIngested: result.storiesUpserted,
    dependenciesIngested: result.dependenciesReplaced,
  }
}

// Minimum word overlap ratio for create-story title validation.
// Below this threshold, a warning is emitted (but the pipeline is not blocked).
const TITLE_OVERLAP_WARNING_THRESHOLD = 0.3

// ---------------------------------------------------------------------------
// mapPhaseToManifestStatus — manifest status mapping (Story 52-4)
// ---------------------------------------------------------------------------

/**
 * Map a terminal StoryPhase to the corresponding PerStoryStatus for run-manifest writes.
 * Returns 'dispatched' for in-progress phases (used as a safe default).
 */
function mapPhaseToManifestStatus(phase: StoryPhase): PerStoryStatus {
  switch (phase) {
    case 'COMPLETE':           return 'complete'
    case 'ESCALATED':          return 'escalated'
    case 'VERIFICATION_FAILED': return 'verification-failed'
    default:                   return 'dispatched'
  }
}

// ---------------------------------------------------------------------------
// wgStatusForPhase — work-graph status mapping
// ---------------------------------------------------------------------------

/**
 * Map a StoryPhase to the corresponding WgStoryStatus for wg_stories writes.
 * Returns null for PENDING (no write needed).
 */
function wgStatusForPhase(phase: StoryPhase): WgStoryStatus | null {
  switch (phase) {
    case 'PENDING':
      return null
    case 'IN_STORY_CREATION':
    case 'IN_TEST_PLANNING':
    case 'IN_DEV':
    case 'IN_REVIEW':
    case 'NEEDS_FIXES':
    case 'CHECKPOINT':
      return 'in_progress'
    case 'COMPLETE':
      return 'complete'
    case 'ESCALATED':
      return 'escalated'
    case 'VERIFICATION_FAILED':
      return 'escalated'
  }
}

// ---------------------------------------------------------------------------
// Project profile staleness check
// ---------------------------------------------------------------------------

/**
 * Check whether `.substrate/project-profile.yaml` is stale relative to
 * the actual project structure.
 *
 * Returns an array of human-readable indicator strings. An empty array
 * means the profile appears current (or doesn't exist).
 *
 * Staleness indicators checked:
 * - Profile says `type: single` but `turbo.json` exists (should be monorepo)
 * - Profile has no Go language but `go.mod` exists
 * - Profile has no Python language but `pyproject.toml` exists
 * - Profile has no Rust language but `Cargo.toml` exists
 */
export function checkProfileStaleness(projectRoot: string): string[] {
  const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
  if (!existsSync(profilePath)) {
    return []
  }

  let profile: {
    project?: {
      type?: string
      language?: string
      packages?: Array<{ language?: string }>
    }
  }

  try {
    const raw = readFileSync(profilePath, 'utf-8')
    profile = (yaml.load(raw) as typeof profile) ?? {}
  } catch {
    // Malformed YAML — cannot check staleness
    return []
  }

  const project = profile.project
  if (project === undefined) {
    return []
  }

  const indicators: string[] = []

  // Collect all languages declared in the profile (primary + packages)
  const declaredLanguages = new Set<string>()
  if (typeof project.language === 'string') {
    declaredLanguages.add(project.language)
  }
  if (Array.isArray(project.packages)) {
    for (const pkg of project.packages) {
      if (typeof pkg.language === 'string') {
        declaredLanguages.add(pkg.language)
      }
    }
  }

  // Check: profile says single but turbo.json exists
  if (project.type === 'single' && existsSync(join(projectRoot, 'turbo.json'))) {
    indicators.push('turbo.json exists but profile says type: single (should be monorepo)')
  }

  // Check: new language markers that the profile doesn't declare
  const languageMarkers: Array<{ file: string; language: string }> = [
    { file: 'go.mod', language: 'go' },
    { file: 'pyproject.toml', language: 'python' },
    { file: 'Cargo.toml', language: 'rust' },
  ]

  for (const marker of languageMarkers) {
    if (existsSync(join(projectRoot, marker.file)) && !declaredLanguages.has(marker.language)) {
      indicators.push(`${marker.file} exists but profile does not declare ${marker.language}`)
    }
  }

  return indicators
}

// ---------------------------------------------------------------------------
// createImplementationOrchestrator
// ---------------------------------------------------------------------------

/**
 * Factory function that creates an ImplementationOrchestrator instance.
 *
 * @param deps - Injected dependencies (db, pack, contextCompiler, dispatcher,
 *               eventBus, config)
 * @returns A fully-configured ImplementationOrchestrator ready to call run()
 */
export function createImplementationOrchestrator(
  deps: OrchestratorDeps,
): ImplementationOrchestrator {
  const { db, pack, contextCompiler, dispatcher, eventBus, config, projectRoot, tokenCeilings, stateStore, telemetryPersistence, ingestionServer, repoMapInjector, maxRepoMapTokens, agentId, runManifest = null } = deps

  const logger = createLogger('implementation-orchestrator')

  // -- TelemetryAdvisor for optimization directive injection (Story 30-6) --
  const telemetryAdvisor: TelemetryAdvisor | undefined = db !== undefined
    ? createTelemetryAdvisor({ db })
    : undefined

  // -- work-graph repository (best-effort wg_stories updates) --
  const wgRepo = new WorkGraphRepository(db)
  const _wgInProgressWritten = new Set<string>()

  // -- mutable orchestrator state --

  let _state: OrchestratorState = 'IDLE'
  let _startedAt: string | undefined
  let _completedAt: string | undefined
  let _decomposition: DecompositionMetrics | undefined

  const _stories = new Map<string, StoryState>()

  let _paused = false
  let _pauseGate: PauseGate | null = null

  // -- heartbeat / watchdog state --
  let _lastProgressTs = Date.now()
  let _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const HEARTBEAT_INTERVAL_MS = 30_000
  const DEFAULT_STALL_THRESHOLD_MS = 600_000 // 10 minutes
  const DEV_STORY_STALL_THRESHOLD_MS = 900_000 // 15 minutes — dev-story commonly runs 10-15 min
  // Track which stories have already emitted a stall event to prevent duplicates
  const _stalledStories = new Set<string>()
  // Track which stories ever stalled (persistent — never cleared) for story-metrics decision
  const _storiesWithStall = new Set<string>()

  // -- per-story phase timing state (for AC2 of Story 17-2) --
  const _phaseStartMs = new Map<string, Map<string, number>>() // storyKey → phase → start ms
  const _phaseEndMs = new Map<string, Map<string, number>>()   // storyKey → phase → end ms
  const _storyDispatches = new Map<string, number>()           // storyKey → dispatch count
  const _storyRetryCount = new Map<string, number>()           // storyKey → retry count (Story 53-4)
  let _completedDispatches = 0                                  // total completed dispatch count (for heartbeat)

  // -- actual peak concurrency observed during runWithConcurrency --
  let _maxConcurrentActual = 0

  // -- package snapshot for node_modules protection (set in run(), used in processStory) --
  let _packageSnapshot: PackageSnapshotData | undefined

  // -- post-sprint contract verification mismatches (Story 25-6) --
  let _contractMismatches: ContractMismatch[] | undefined

  // -- cost governance state (Story 53-3) --
  const _costChecker = new CostGovernanceChecker()
  let _costWarningEmitted = false
  let _budgetExhausted = false

  // -- OTLP telemetry endpoint (Story 27-9) --
  // Set once when ingestionServer.start() resolves; cleared after run() completes.
  let _otlpEndpoint: string | undefined

  // -- Tier A verification pipeline (Story 51-5) --
  // In-memory store for VerificationSummary results; available to Epic 52 consumers.
  const verificationStore = new VerificationStore()
  // toSdlcEventBus() documents and isolates the bus type projection; see its JSDoc for
  // the full safety argument and the compile-time assertions that enforce it.
  const verificationPipeline = createDefaultVerificationPipeline(toSdlcEventBus(eventBus))

  // -- StateStore record cache (Story 26-4, AC3) --
  // Populated from stateStore.queryStories() after initialization for resume scenarios.
  // In-memory _stories always takes precedence over this cache.
  const _stateStoreCache = new Map<string, import('../state/types.js').StoryRecord>()

  // -- Checkpoint context (Story 39-5) --
  // Ephemeral in-memory store for partial work captured on dev-story timeout.
  // Keyed by storyKey; consumed by retry logic (Story 39-6).
  // NOT persisted to Dolt — only needed for immediate retry within the same run.
  interface CheckpointContext {
    /** Files modified before the timeout (from checkGitDiffFiles) */
    filesModified: string[]
    /** Git diff of modified files at time of timeout */
    gitDiff: string
    /** Error message from the timed-out dispatch (for debugging) */
    partialOutput: string
  }
  const _checkpoints = new Map<string, CheckpointContext>()


  // -- memory pressure backoff (Story 23-8, AC1) --
  // Exponential backoff intervals (ms) before retrying a story dispatch
  // when memory pressure is detected.  After all intervals are exhausted
  // the story is escalated with reason 'memory_pressure_exhausted'.
  const MEMORY_PRESSURE_BACKOFF_MS = [30_000, 60_000, 120_000]

  function startPhase(storyKey: string, phase: string): void {
    if (!_phaseStartMs.has(storyKey)) _phaseStartMs.set(storyKey, new Map())
    _phaseStartMs.get(storyKey)!.set(phase, Date.now())
  }

  function endPhase(storyKey: string, phase: string): void {
    if (!_phaseEndMs.has(storyKey)) _phaseEndMs.set(storyKey, new Map())
    _phaseEndMs.get(storyKey)!.set(phase, Date.now())
    _completedDispatches++
  }

  function incrementDispatches(storyKey: string): void {
    _storyDispatches.set(storyKey, (_storyDispatches.get(storyKey) ?? 0) + 1)
  }

  /**
   * Initialize `_storyRetryCount` from the run manifest for crash-recovery durability (AC6, Story 53-4).
   * Reads persisted retry_count so that budget gate correctly accounts for prior-session retries.
   * Best-effort: failures result in a starting count of 0 (safe — may allow one extra retry).
   */
  async function initRetryCount(storyKey: string): Promise<void> {
    if (runManifest === null || runManifest === undefined) {
      _storyRetryCount.set(storyKey, 0)
      return
    }
    try {
      const data = await runManifest.read()
      const storyState = data.per_story_state[storyKey]
      const existingCount = storyState?.retry_count ?? 0
      _storyRetryCount.set(storyKey, existingCount)
    } catch (err) {
      logger.warn({ err, storyKey }, 'initRetryCount: failed to read manifest — starting at 0')
      _storyRetryCount.set(storyKey, 0)
    }
  }

  /**
   * Increment the in-memory retry count and persist best-effort to the run manifest (AC4, Story 53-4).
   */
  function incrementRetryCount(storyKey: string): void {
    const current = _storyRetryCount.get(storyKey) ?? 0
    const next = current + 1
    _storyRetryCount.set(storyKey, next)
    if (runManifest !== null && runManifest !== undefined) {
      runManifest
        .patchStoryState(storyKey, { retry_count: next })
        .catch((err: unknown) =>
          logger.warn({ err, storyKey }, 'patchStoryState(retry_count) failed — pipeline continues'),
        )
    }
  }

  function buildPhaseDurationsJson(storyKey: string): string {
    const starts = _phaseStartMs.get(storyKey)
    const ends = _phaseEndMs.get(storyKey)
    if (!starts || starts.size === 0) return '{}'
    const durations: Record<string, number> = {}
    const nowMs = Date.now()
    for (const [phase, startMs] of starts) {
      const endMs = ends?.get(phase)
      if (endMs === undefined) {
        logger.warn(
          { storyKey, phase },
          'Phase has no end time — story may have errored mid-phase. Duration capped to now() and may be inflated.',
        )
      }
      durations[phase] = Math.round(((endMs ?? nowMs) - startMs) / 1000)
    }
    return JSON.stringify(durations)
  }

  async function writeStoryMetricsBestEffort(storyKey: string, result: string, reviewCycles: number): Promise<void> {
    if (config.pipelineRunId === undefined) return
    try {
      const storyState = _stories.get(storyKey)
      const startedAt = storyState?.startedAt
      const completedAt = storyState?.completedAt ?? new Date().toISOString()
      const wallClockSeconds = startedAt
        ? Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000)
        : 0
      // Compute wall-clock ms (higher precision than seconds) for event payload
      const wallClockMs = startedAt
        ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
        : 0
      const tokenAgg = await aggregateTokenUsageForStory(db, config.pipelineRunId, storyKey)
      // Story 52-4 AC5: update manifest with real aggregated cost_usd now that tokenAgg is available (best-effort)
      if (runManifest !== null) {
        runManifest
          .patchStoryState(storyKey, { cost_usd: tokenAgg.cost })
          .catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'patchStoryState(cost_usd) failed — pipeline continues'),
          )
      }
      // Capture phase durations JSON once so it can be reused for the event payload
      const phaseDurationsJson = buildPhaseDurationsJson(storyKey)
      await writeStoryMetrics(db, {
        run_id: config.pipelineRunId,
        story_key: storyKey,
        result,
        phase_durations_json: phaseDurationsJson,
        started_at: startedAt,
        completed_at: completedAt,
        wall_clock_seconds: wallClockSeconds,
        input_tokens: tokenAgg.input,
        output_tokens: tokenAgg.output,
        cost_usd: tokenAgg.cost,
        review_cycles: reviewCycles,
        dispatches: _storyDispatches.get(storyKey) ?? 0,
      })
      // AC1 of Story 26-5: also record to StateStore for Dolt-backed metric persistence
      if (stateStore !== undefined) {
        stateStore.recordMetric({
          storyKey,
          taskType: 'dev-story',
          model: undefined,            // model not tracked per-story at orchestrator level
          tokensIn: tokenAgg.input,
          tokensOut: tokenAgg.output,
          cacheReadTokens: undefined,  // cache read tokens not separately tracked at orchestrator level
          costUsd: tokenAgg.cost,
          wallClockMs,
          reviewCycles,
          stallCount: _storiesWithStall.has(storyKey) ? 1 : 0,
          result,
          recordedAt: completedAt,
          timestamp: completedAt,
        }).catch((storeErr: unknown) => {
          logger.warn({ err: storeErr, storyKey }, 'Failed to record metric to StateStore (best-effort)')
        })
      }
      // AC4 of Story 21-1: also write story-metrics decision for queryable insight
      try {
        const runId = config.pipelineRunId ?? 'unknown'
        await createDecision(db, {
          pipeline_run_id: config.pipelineRunId,
          phase: 'implementation',
          category: STORY_METRICS,
          key: `${storyKey}:${runId}`,
          value: JSON.stringify({
            wall_clock_seconds: wallClockSeconds,
            input_tokens: tokenAgg.input,
            output_tokens: tokenAgg.output,
            review_cycles: reviewCycles,
            stalled: _storiesWithStall.has(storyKey),
          }),
          rationale: `Story ${storyKey} completed with result=${result} in ${wallClockSeconds}s. Tokens: ${tokenAgg.input}+${tokenAgg.output}. Review cycles: ${reviewCycles}.`,
        })
      } catch (decisionErr) {
        logger.warn({ err: decisionErr, storyKey }, 'Failed to write story-metrics decision (best-effort)')
      }
      // Story 24-4 (AC8): emit story:metrics event for NDJSON consumers
      try {
        // Build per-phase breakdown in ms from raw timestamps (higher precision)
        const phaseBreakdown: Record<string, number> = {}
        const starts = _phaseStartMs.get(storyKey)
        const ends = _phaseEndMs.get(storyKey)
        if (starts) {
          const nowMs = Date.now()
          for (const [phase, startMs] of starts) {
            const endMs = ends?.get(phase)
            phaseBreakdown[phase] = endMs !== undefined ? endMs - startMs : nowMs - startMs
          }
        }
        // Collect git diff stats for backend-agnostic work measurement.
        // This captures actual files changed regardless of OTLP availability.
        // Collect git diff stats for backend-agnostic work measurement.
        // Uses checkGitDiffFiles (handles both tracked changes and untracked files)
        // plus git diff --numstat for line-level counts.
        let diffStats: { filesChanged: number; insertions: number; deletions: number } | undefined
        try {
          const cwd = projectRoot ?? process.cwd()
          const changedFiles = checkGitDiffFiles(cwd)
          if (changedFiles.length > 0) {
            // Count insertions/deletions from tracked modified files
            let insertions = 0
            let deletions = 0
            try {
              const numstat = execSync('git diff --numstat HEAD', {
                cwd,
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              for (const line of numstat.trim().split('\n')) {
                const parts = line.split('\t')
                if (parts.length >= 2) {
                  const ins = parseInt(parts[0], 10)
                  const del = parseInt(parts[1], 10)
                  if (!isNaN(ins)) insertions += ins
                  if (!isNaN(del)) deletions += del
                }
              }
            } catch { /* numstat failure is non-fatal */ }

            // Count lines in untracked new files (not captured by git diff)
            try {
              const untracked = execSync('git ls-files --others --exclude-standard', {
                cwd,
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'pipe'],
              })
              for (const file of untracked.trim().split('\n').filter(Boolean)) {
                try {
                  const wc = execSync(`wc -l < "${file}"`, { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
                  insertions += parseInt(wc.trim(), 10) || 0
                } catch { /* skip individual file failures */ }
              }
            } catch { /* untracked listing failure is non-fatal */ }

            diffStats = { filesChanged: changedFiles.length, insertions, deletions }
          }
        } catch {
          // git not available — skip
        }

        // Flag stories with suspiciously low output tokens as unverified.
        // When token tracking fails (e.g., non-Claude backend with no OTLP),
        // a "succeeded" story with <100 output tokens is likely a false positive.
        const LOW_OUTPUT_TOKEN_THRESHOLD = 100
        const unverified = tokenAgg.output < LOW_OUTPUT_TOKEN_THRESHOLD
        if (unverified) {
          logger.warn(
            { storyKey, outputTokens: tokenAgg.output, threshold: LOW_OUTPUT_TOKEN_THRESHOLD },
            'Story completed with very low output tokens — marking as unverified',
          )
          eventBus.emit('orchestrator:story-warn', {
            storyKey,
            msg: `Low output tokens (${tokenAgg.output} < ${LOW_OUTPUT_TOKEN_THRESHOLD}) — result may be unverified`,
          })
        }

        eventBus.emit('story:metrics', {
          storyKey,
          wallClockMs,
          phaseBreakdown,
          tokens: { input: tokenAgg.input, output: tokenAgg.output },
          reviewCycles,
          dispatches: _storyDispatches.get(storyKey) ?? 0,
          ...(diffStats !== undefined ? { diffStats } : {}),
          ...(unverified ? { unverified: true } : {}),
        })
      } catch (emitErr) {
        logger.warn({ err: emitErr, storyKey }, 'Failed to emit story:metrics event (best-effort)')
      }
    } catch (err) {
      logger.warn({ err, storyKey }, 'Failed to write story metrics (best-effort)')
    }
  }

  /**
   * Persist a story outcome finding to the decision store (Story 22-1, AC4).
   *
   * Records outcome, review cycles, and any recurring issue patterns for
   * future prompt injection via the learning loop.
   */
  async function writeStoryOutcomeBestEffort(
    storyKey: string,
    outcome: 'complete' | 'escalated',
    reviewCycles: number,
    issuePatterns?: string[],
  ): Promise<void> {
    if (config.pipelineRunId === undefined) return
    try {
      await createDecision(db, {
        pipeline_run_id: config.pipelineRunId,
        phase: 'implementation',
        category: STORY_OUTCOME,
        key: `${storyKey}:${config.pipelineRunId}`,
        value: JSON.stringify({
          storyKey,
          outcome,
          reviewCycles,
          recurringPatterns: issuePatterns ?? [],
        }),
        rationale: `Story ${storyKey} ${outcome} after ${reviewCycles} review cycle(s).`,
      })
    } catch (err) {
      logger.warn({ err, storyKey }, 'Failed to write story-outcome decision (best-effort)')
    }
  }

  /**
   * Emit an escalation event with structured diagnosis and persist the
   * diagnosis to the decision store (Story 22-3).
   */
  async function emitEscalation(payload: {
    storyKey: string
    lastVerdict: string
    reviewCycles: number
    issues: unknown[]
    /** Named retry budget — present when escalation reason is retry_budget_exhausted (Story 53-4 AC5) */
    retryBudget?: number
    /** Named retry count — present when escalation reason is retry_budget_exhausted (Story 53-4 AC5) */
    retryCount?: number
  }): Promise<void> {
    const diagnosis = generateEscalationDiagnosis(
      payload.issues,
      payload.reviewCycles,
      payload.lastVerdict,
    )

    eventBus.emit('orchestrator:story-escalated', {
      ...payload,
      diagnosis,
    })

    // Persist diagnosis to decision store (Story 22-3, AC3)
    if (config.pipelineRunId !== undefined) {
      try {
        // Persist diagnosis with full issue list so retry-escalated can inject
        // specific findings into the retry prompt (not just summary counts).
        const diagnosisWithIssues = {
          ...diagnosis,
          issues: payload.issues.slice(0, 10).map((issue) => {
            if (typeof issue === 'string') return { description: issue }
            const iss = issue as { severity?: string; description?: string; file?: string }
            return { severity: iss.severity, description: iss.description, file: iss.file }
          }),
        }
        await createDecision(db, {
          pipeline_run_id: config.pipelineRunId,
          phase: 'implementation',
          category: ESCALATION_DIAGNOSIS,
          key: `${payload.storyKey}:${config.pipelineRunId}`,
          value: JSON.stringify(diagnosisWithIssues),
          rationale: `Escalation diagnosis for ${payload.storyKey}: ${diagnosis.recommendedAction} — ${diagnosis.rationale}`,
        })
      } catch (err) {
        logger.warn({ err, storyKey: payload.storyKey }, 'Failed to persist escalation diagnosis (best-effort)')
      }
    }

    // Persist story outcome for learning loop (Story 22-1, AC4)
    const issuePatterns = extractIssuePatterns(payload.issues)
    await writeStoryOutcomeBestEffort(payload.storyKey, 'escalated', payload.reviewCycles, issuePatterns)
  }

  /**
   * Extract short pattern descriptions from an issue list for recurring pattern tracking.
   */
  function extractIssuePatterns(issues: unknown[]): string[] {
    const patterns: string[] = []
    for (const issue of issues) {
      if (typeof issue === 'string') {
        patterns.push(issue.slice(0, 100))
      } else {
        const iss = issue as { description?: string; severity?: string }
        if (iss.description && (iss.severity === 'blocker' || iss.severity === 'major')) {
          patterns.push(iss.description.slice(0, 100))
        }
      }
    }
    return patterns.slice(0, 10)
  }

  // -- helpers --

  function getStatus(): OrchestratorStatus {
    const stories: Record<string, StoryState> = {}
    // Story 26-4, AC3: Merge StateStore cache records first (lower priority).
    // In-memory _stories entries always override cache entries.
    for (const [key, record] of _stateStoreCache) {
      if (!_stories.has(key)) {
        stories[key] = {
          phase: record.phase,
          reviewCycles: record.reviewCycles,
          lastVerdict: record.lastVerdict,
          error: record.error,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
          checkpointFilesCount: record.checkpointFilesCount,
        }
      }
    }
    for (const [key, s] of _stories) {
      stories[key] = { ...s }
    }
    const status: OrchestratorStatus = {
      state: _state,
      stories,
    }
    if (_startedAt !== undefined) status.startedAt = _startedAt
    if (_completedAt !== undefined) {
      status.completedAt = _completedAt
      if (_startedAt !== undefined) {
        status.totalDurationMs =
          new Date(_completedAt).getTime() - new Date(_startedAt).getTime()
      }
    }
    if (_decomposition !== undefined) {
      status.decomposition = { ..._decomposition }
    }
    if (_maxConcurrentActual > 0) {
      status.maxConcurrentActual = _maxConcurrentActual
    }
    if (_contractMismatches !== undefined && _contractMismatches.length > 0) {
      status.contractMismatches = [..._contractMismatches]
    }
    return status
  }

  function updateStory(storyKey: string, updates: Partial<StoryState>): void {
    const existing = _stories.get(storyKey)
    if (existing !== undefined) {
      Object.assign(existing, updates)
      // Fire-and-forget persistence to StateStore after every in-memory update.
      persistStoryState(storyKey, existing).catch((err) =>
        logger.warn({ err, storyKey }, 'StateStore write failed after updateStory'),
      )
      // Branch lifecycle: fire-and-forget on terminal phase transitions.
      if (updates.phase === 'COMPLETE') {
        void stateStore?.mergeStory(storyKey).catch((err: unknown) => {
          if (err instanceof DoltMergeConflict) {
            eventBus.emit('pipeline:state-conflict', { storyKey, conflict: err })
          } else {
            logger.warn({ err, storyKey }, 'mergeStory failed')
          }
        })
      } else if (updates.phase === 'ESCALATED' || updates.phase === 'VERIFICATION_FAILED') {
        void stateStore?.rollbackStory(storyKey).catch((err: unknown) =>
          logger.warn({ err, storyKey }, 'rollbackStory failed — branch may persist'),
        )
      }
      // wg_stories status update: fire-and-forget (AC5).
      if (updates.phase !== undefined) {
        const targetStatus = wgStatusForPhase(updates.phase)
        if (targetStatus !== null) {
          if (targetStatus === 'in_progress' && _wgInProgressWritten.has(storyKey)) {
            // Dedup: skip redundant in_progress write (AC7)
          } else {
            const fullUpdated = { ...existing, ...updates }
            const opts =
              targetStatus === 'complete' || targetStatus === 'escalated'
                ? { completedAt: fullUpdated.completedAt }
                : undefined
            void wgRepo
              .updateStoryStatus(storyKey, targetStatus, opts)
              .catch((err: unknown) =>
                logger.warn({ err, storyKey }, 'wg_stories status update failed (best-effort)'),
              )
            if (targetStatus === 'in_progress') {
              _wgInProgressWritten.add(storyKey)
            }
          }
        }
      }
      // Run manifest per-story lifecycle state tracking (Story 52-4, AC4, AC5, AC6).
      // Best-effort: manifest write failures are non-fatal — pipeline always continues.
      if (runManifest !== null && updates.phase !== undefined) {
        const fullUpdated = { ...existing, ...updates }
        if (updates.phase === 'IN_STORY_CREATION') {
          // Dispatched transition: record when the story first enters active processing (AC4).
          runManifest
            .patchStoryState(storyKey, {
              status: 'dispatched',
              phase: String(updates.phase),
              started_at: fullUpdated.startedAt ?? new Date().toISOString(),
            })
            .catch((err: unknown) =>
              logger.warn({ err, storyKey }, 'patchStoryState(dispatched) failed — pipeline continues'),
            )
        } else if (
          updates.phase === 'COMPLETE' ||
          updates.phase === 'ESCALATED' ||
          updates.phase === 'VERIFICATION_FAILED'
        ) {
          // Terminal transition: record final status, phase, completion time, and metrics (AC5).
          // cost_usd is intentionally omitted here; writeStoryMetricsBestEffort patches it
          // with the real aggregated value once aggregateTokenUsageForStory completes.
          const manifestStatus = mapPhaseToManifestStatus(updates.phase)
          runManifest
            .patchStoryState(storyKey, {
              status: manifestStatus,
              phase: String(updates.phase),
              completed_at: fullUpdated.completedAt ?? new Date().toISOString(),
              review_cycles: fullUpdated.reviewCycles ?? 0,
              dispatches: _storyDispatches.get(storyKey) ?? 0,
            })
            .catch((err: unknown) =>
              logger.warn({ err, storyKey }, `patchStoryState(${manifestStatus}) failed — pipeline continues`),
            )
        }
      }
    }
  }

  /**
   * Persist a single story's state to the StateStore (Story 26-4, AC2).
   *
   * Best-effort: callers should `.catch()` on the returned promise.
   * Never throws — errors are swallowed so the pipeline is never blocked.
   */
  async function persistStoryState(storyKey: string, state: StoryState): Promise<void> {
    if (stateStore === undefined) return
    try {
      const record: StoryRecord = {
        storyKey,
        phase: state.phase,
        reviewCycles: state.reviewCycles,
        lastVerdict: state.lastVerdict,
        error: state.error,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        sprint: config.sprint,
        checkpointFilesCount: state.checkpointFilesCount,
      }
      await stateStore.setStoryState(storyKey, record)
    } catch (err) {
      logger.warn({ err, storyKey }, 'StateStore.setStoryState failed (best-effort)')
    }
  }

  async function persistState(): Promise<void> {
    if (config.pipelineRunId === undefined) return
    recordProgress()
    try {
      const serialized = JSON.stringify(getStatus())
      await updatePipelineRun(db, config.pipelineRunId, {
        current_phase: 'implementation',
        token_usage_json: serialized,
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to persist orchestrator state')
    }
  }

  function recordProgress(): void {
    _lastProgressTs = Date.now()
    // Clear stall deduplication set so stories can re-emit stall events after recovering
    _stalledStories.clear()
  }

  function getStallThresholdMs(phase: string): number {
    return phase === 'IN_DEV' ? DEV_STORY_STALL_THRESHOLD_MS : DEFAULT_STALL_THRESHOLD_MS
  }

  function startHeartbeat(): void {
    if (_heartbeatTimer !== null) return
    _heartbeatTimer = setInterval(() => {
      if (_state !== 'RUNNING') return
      let active = 0
      let queued = 0
      for (const s of _stories.values()) {
        if (s.phase === 'PENDING') queued++
        else if (s.phase !== 'COMPLETE' && s.phase !== 'ESCALATED' && s.phase !== 'VERIFICATION_FAILED') active++
      }
      const completed = _completedDispatches

      // Emit heartbeat unconditionally on every tick while RUNNING.
      // Previously gated by timeSinceProgress >= HEARTBEAT_INTERVAL_MS, which
      // suppressed heartbeats when persistState() called recordProgress()
      // shortly before the tick. During long-running dispatches (e.g. code
      // review timing out), the heartbeat must keep ticking so external
      // monitors (supervisor, CLI) can distinguish "alive but waiting" from
      // "stalled process".
      eventBus.emit('orchestrator:heartbeat', {
        runId: config.pipelineRunId ?? '',
        activeDispatches: active,
        completedDispatches: completed,
        queuedDispatches: queued,
      })

      // Touch pipeline_runs.updated_at on every heartbeat tick so external
      // health checks (substrate health, supervisor) see fresh staleness.
      // Without this, updated_at only advances when persistState() is called
      // on phase transitions, causing false STALLED verdicts during long
      // dispatches (e.g. 10-min code review with no phase change).
      if (config.pipelineRunId !== undefined) {
        updatePipelineRun(db, config.pipelineRunId, {
          current_phase: 'implementation',
        }).catch((err) => {
          logger.debug({ err }, 'Heartbeat: failed to touch updated_at (non-fatal)')
        })
      }

      // Watchdog: check for stalls with phase-aware thresholds (AC3, AC4)
      const elapsed = Date.now() - _lastProgressTs

      // Only run process inspection once per tick (shared across all stories)
      let childPids: number[] = []
      let childActive = false
      let processInspected = false

      for (const [key, s] of _stories) {
        if (s.phase === 'PENDING' || s.phase === 'COMPLETE' || s.phase === 'ESCALATED' || s.phase === 'VERIFICATION_FAILED') continue
        const threshold = getStallThresholdMs(s.phase)
        if (elapsed < threshold) continue

        // Deduplication: skip if we already emitted a stall event for this story
        if (_stalledStories.has(key)) continue

        // AC2 (Story 23-7): Check child process liveness before emitting stall.
        // Inspect once per tick and cache the result.
        if (!processInspected) {
          processInspected = true
          try {
            const processInfo = inspectProcessTree()
            childPids = processInfo.child_pids
            const nonZombieChildren = processInfo.child_pids.filter(
              (pid) => !processInfo.zombies.includes(pid)
            )
            childActive = nonZombieChildren.length > 0
          } catch {
            // Process inspection failed — proceed with stall detection
          }
        }

        // AC1 + AC2 (Story 23-7): If any child is alive and not a zombie,
        // reset the staleness timer and suppress the stall event.
        if (childActive) {
          _lastProgressTs = Date.now()
          logger.debug(
            { storyKey: key, phase: s.phase, childPids },
            'Staleness exceeded but child processes are active — suppressing stall'
          )
          break // timer reset — no need to check remaining stories this tick
        }

        _stalledStories.add(key)
        _storiesWithStall.add(key)
        logger.warn({ storyKey: key, phase: s.phase, elapsedMs: elapsed, childPids, childActive }, 'Watchdog: possible stall detected')
        eventBus.emit('orchestrator:stall', {
          runId: config.pipelineRunId ?? '',
          storyKey: key,
          phase: s.phase,
          elapsedMs: elapsed,
          childPids,
          childActive,
        })
      }
    }, HEARTBEAT_INTERVAL_MS)
    // Ensure the timer doesn't prevent process exit
    if (_heartbeatTimer && typeof _heartbeatTimer === 'object' && 'unref' in _heartbeatTimer) {
      _heartbeatTimer.unref()
    }
  }

  function stopHeartbeat(): void {
    if (_heartbeatTimer !== null) {
      clearInterval(_heartbeatTimer)
      _heartbeatTimer = null
    }
  }

  /**
   * Wait until the orchestrator is un-paused (if currently paused).
   */
  async function waitIfPaused(): Promise<void> {
    if (_paused && _pauseGate !== null) {
      await _pauseGate.promise
    }
  }

  /**
   * Check memory pressure before dispatching a story phase (Story 23-8, AC1).
   *
   * When the dispatcher reports memory pressure, this helper waits using
   * exponential backoff (30 s, 60 s, 120 s) and re-checks after each interval.
   * If memory is still pressured after all intervals, returns false so the
   * caller can escalate the story with reason 'memory_pressure_exhausted'.
   *
   * If memory is OK (or clears during a wait), returns true immediately.
   */
  async function checkMemoryPressure(storyKey: string): Promise<boolean> {
    for (let attempt = 0; attempt < MEMORY_PRESSURE_BACKOFF_MS.length; attempt++) {
      const memState = dispatcher.getMemoryState()
      if (!memState.isPressured) {
        return true
      }
      // Log memory state at each hold entry [AC3]
      logger.warn(
        {
          storyKey,
          freeMB: memState.freeMB,
          thresholdMB: memState.thresholdMB,
          pressureLevel: memState.pressureLevel,
          attempt: attempt + 1,
          maxAttempts: MEMORY_PRESSURE_BACKOFF_MS.length,
        },
        'Memory pressure before story dispatch — backing off',
      )
      await sleep(MEMORY_PRESSURE_BACKOFF_MS[attempt] ?? 0)
    }
    // Final check after last sleep
    return !dispatcher.getMemoryState().isPressured
  }

  /**
   * Run the full pipeline for a single story key.
   *
   * Sequence: create-story → dev-story → code-review (with retry/rework up
   * to maxReviewCycles). On SHIP_IT the story is marked COMPLETE. On
   * exhausted retries the story is ESCALATED.
   */
  async function processStory(storyKey: string, storyOptions?: { optimizationDirectives?: string }): Promise<void> {
    logger.info({ storyKey }, 'Processing story')

    // -- initialize retry count from manifest for crash-recovery durability (Story 53-4, AC6) --
    await initRetryCount(storyKey)

    // -- memory pressure pre-check (Story 23-8, AC1) --
    // Before starting any dispatch, verify memory is available. If pressured,
    // back off and retry. If memory pressure persists after all retries,
    // escalate this story so the pipeline can continue to the next one.
    {
      const memoryOk = await checkMemoryPressure(storyKey)
      if (!memoryOk) {
        logger.warn({ storyKey }, 'Memory pressure exhausted — escalating story without dispatch')
        const memPressureState: StoryState = {
          phase: 'ESCALATED' as import('./types.js').StoryPhase,
          reviewCycles: 0,
          error: 'memory_pressure_exhausted',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }
        _stories.set(storyKey, memPressureState)
        persistStoryState(storyKey, memPressureState).catch((err) =>
          logger.warn({ err, storyKey }, 'StateStore write failed after memory-pressure escalation'),
        )
        await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
        await emitEscalation({
          storyKey,
          lastVerdict: 'memory_pressure_exhausted',
          reviewCycles: 0,
          issues: [
            `Memory pressure exhausted after ${MEMORY_PRESSURE_BACKOFF_MS.length} backoff attempts`,
          ],
        })
        await persistState()
        return
      }
    }

    // -- create-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    // Story 26-7: create a branch for this story before any state writes.
    void stateStore?.branchForStory(storyKey).catch((err: unknown) =>
      logger.warn({ err, storyKey }, 'branchForStory failed — continuing without branch isolation'),
    )

    startPhase(storyKey, 'create-story')
    updateStory(storyKey, {
      phase: 'IN_STORY_CREATION' as StoryPhase,
      startedAt: new Date().toISOString(),
    })

    let storyFilePath: string | undefined

    // Check if a story file already exists for this story key.
    // Pre-existing stories (e.g., from BMAD auto-implement) should be reused
    // so their full task list is available for complexity analysis and batching.
    const artifactsDir = projectRoot ? join(projectRoot, '_bmad-output', 'implementation-artifacts') : undefined
    if (artifactsDir && existsSync(artifactsDir)) {
      try {
        const files = readdirSync(artifactsDir)
        const match = files.find((f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md'))
        if (match) {
          const candidatePath = join(artifactsDir, match)
          const validation = await isValidStoryFile(candidatePath)
          if (!validation.valid) {
            logger.warn(
              { storyKey, storyFilePath: candidatePath, reason: validation.reason },
              `Existing story file for ${storyKey} is invalid (${validation.reason}) — re-creating`,
            )
            // Fall through to create-story by leaving storyFilePath undefined
          } else {
            storyFilePath = candidatePath
            logger.info({ storyKey, storyFilePath }, 'Found existing story file — skipping create-story')
            endPhase(storyKey, 'create-story')
            eventBus.emit('orchestrator:story-phase-complete', {
              storyKey,
              phase: 'IN_STORY_CREATION',
              result: { result: 'success', story_file: storyFilePath, story_key: storyKey },
            })
            await persistState()
          }
        }
      } catch {
        // If directory read fails, fall through to create-story
      }
    }

    // AC satisfaction pre-check: if the story's expected new files already
    // exist in the working tree, the story was implicitly covered by adjacent
    // stories — skip create-story to avoid a wasted dispatch.
    if (storyFilePath === undefined && projectRoot && isImplicitlyCovered(storyKey, projectRoot)) {
      logger.info(
        { storyKey },
        `Story ${storyKey} appears implicitly covered — all expected new files already exist. Skipping create-story.`,
      )
      endPhase(storyKey, 'create-story')
      eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'IN_STORY_CREATION',
        result: { result: 'success', story_key: storyKey, implicitlyCovered: true },
      })
      updateStory(storyKey, { phase: 'COMPLETE' as StoryPhase, completedAt: new Date().toISOString() })
      await persistState()
      return
    }

    if (storyFilePath === undefined) {
    try {
      incrementDispatches(storyKey)
      const createResult = await runCreateStory(
        { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
        { epicId: storyKey.split('-')[0] ?? storyKey, storyKey, pipelineRunId: config.pipelineRunId },
      )

      endPhase(storyKey, 'create-story')
      eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'IN_STORY_CREATION',
        result: createResult,
      })

      // Record create-story token usage for accurate per-story cost attribution
      if (config.pipelineRunId !== undefined && createResult.tokenUsage !== undefined) {
        try {
          addTokenUsage(db, config.pipelineRunId, {
            phase: 'create-story',
            agent: 'create-story',
            input_tokens: createResult.tokenUsage.input,
            output_tokens: createResult.tokenUsage.output,
            cost_usd: estimateDispatchCost(createResult.tokenUsage.input, createResult.tokenUsage.output),
            metadata: JSON.stringify({ storyKey }),
          })
        } catch (tokenErr) {
          logger.warn({ storyKey, err: tokenErr }, 'Failed to record create-story token usage')
        }
      }

      await persistState()

      if (createResult.result === 'failed') {
        const errMsg = createResult.error ?? 'create-story failed'
        // Extract the most diagnostic portion of the error for structured logging
        const stderrSnippet = errMsg.includes('--- stderr ---')
          ? errMsg.slice(errMsg.indexOf('--- stderr ---') + 15, errMsg.indexOf('--- stderr ---') + 515)
          : errMsg.slice(0, 500)
        logger.error(
          { storyKey, stderrSnippet },
          `Create-story failed: ${stderrSnippet.split('\n')[0]}`,
        )
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
        await emitEscalation({
          storyKey,
          lastVerdict: 'create-story-failed',
          reviewCycles: 0,
          issues: [errMsg],
        })
        await persistState()
        return
      }

      if (createResult.story_file === undefined || createResult.story_file === '') {
        const errMsg = 'create-story succeeded but returned no story_file path'
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
        await emitEscalation({
          storyKey,
          lastVerdict: 'create-story-no-file',
          reviewCycles: 0,
          issues: [errMsg],
        })
        await persistState()
        return
      }

      storyFilePath = createResult.story_file

      // -- Story title validation (safety net for hallucinated titles) --
      // Compare the generated story title against the expected title from the
      // epic shard. If word overlap is below the threshold, emit a non-blocking
      // warning so operators can spot context-truncation regressions early.
      if (createResult.story_title) {
        try {
          const epicId = storyKey.split('-')[0] ?? storyKey
          const implDecisions = await getDecisionsByPhase(db, 'implementation')
          // Replicate the shard lookup order from create-story.ts:
          // 1. Per-story shard (post-37-0), 2. Per-epic shard + extraction (pre-37-0)
          let shardContent: string | undefined
          const perStoryShard = implDecisions.find(
            (d) => d.category === 'epic-shard' && d.key === storyKey,
          )
          if (perStoryShard?.value) {
            shardContent = perStoryShard.value
          } else {
            const epicShard = implDecisions.find(
              (d) => d.category === 'epic-shard' && d.key === epicId,
            )
            if (epicShard?.value) {
              shardContent = extractStorySection(epicShard.value, storyKey) ?? epicShard.value
            }
          }

          if (shardContent) {
            const expectedTitle = extractExpectedStoryTitle(shardContent, storyKey)
            if (expectedTitle) {
              const overlap = computeTitleOverlap(expectedTitle, createResult.story_title)
              if (overlap < TITLE_OVERLAP_WARNING_THRESHOLD) {
                const msg =
                  `Story title mismatch: expected "${expectedTitle}" ` +
                  `but got "${createResult.story_title}" ` +
                  `(word overlap: ${Math.round(overlap * 100)}%). ` +
                  `This may indicate the create-story agent received truncated context.`
                logger.warn({ storyKey, expectedTitle, generatedTitle: createResult.story_title, overlap }, msg)
                eventBus.emit('orchestrator:story-warn', { storyKey, msg })
              } else {
                logger.debug(
                  { storyKey, expectedTitle, generatedTitle: createResult.story_title, overlap },
                  'Story title validation passed',
                )
              }
            }
          }
        } catch (titleValidationErr) {
          // Title validation is best-effort — never block the pipeline
          logger.debug(
            { storyKey, err: titleValidationErr },
            'Story title validation skipped due to error',
          )
        }
      }

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      endPhase(storyKey, 'create-story')
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
      await emitEscalation({
        storyKey,
        lastVerdict: 'create-story-exception',
        reviewCycles: 0,
        issues: [errMsg],
      })
      await persistState()
      return
    }
    } // end if (storyFilePath === undefined)

    // -- interface contract parsing (Story 25-4: AC3) --
    // Parse the newly created (or pre-existing) story file for interface contract
    // declarations and persist them to the decision store so Story 25-5 dispatch
    // ordering and Story 25-6 verification can build a cross-story dependency graph.
    if (storyFilePath) {
      try {
        const storyContent = await readFile(storyFilePath, 'utf-8')
        const contracts = parseInterfaceContracts(storyContent, storyKey)
        if (contracts.length > 0) {
          const contractRecords: ContractRecord[] = contracts.map((d) => ({
            storyKey: d.storyKey,
            contractName: d.contractName,
            direction: d.direction,
            schemaPath: d.filePath,
            ...(d.transport !== undefined ? { transport: d.transport } : {}),
          }))

          if (stateStore !== undefined) {
            await stateStore.setContracts(storyKey, contractRecords)
          } else {
            // Fallback: use decision store when StateStore is not available.
            for (const contract of contracts) {
              await createDecision(db, {
                pipeline_run_id: config.pipelineRunId ?? null,
                phase: 'implementation',
                category: 'interface-contract',
                key: `${storyKey}:${contract.contractName}`,
                value: JSON.stringify({
                  direction: contract.direction,
                  schemaName: contract.contractName,
                  filePath: contract.filePath,
                  storyKey: contract.storyKey,
                  ...(contract.transport !== undefined ? { transport: contract.transport } : {}),
                }),
              })
            }
          }
          logger.info(
            { storyKey, contractCount: contracts.length, contracts },
            'Stored interface contract declarations',
          )
        }
      } catch (err) {
        logger.warn(
          { storyKey, error: err instanceof Error ? err.message : String(err) },
          'Failed to parse interface contracts — continuing without contract declarations',
        )
      }
    }

    // -- test-plan phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    startPhase(storyKey, 'test-plan')
    updateStory(storyKey, { phase: 'IN_TEST_PLANNING' as StoryPhase })
    await persistState()

    let testPlanPhaseResult: 'success' | 'failed' = 'failed'
    let testPlanTokenUsage: { input: number; output: number } | undefined
    try {
      const testPlanResult = await runTestPlan(
        { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
        { storyKey, storyFilePath: storyFilePath ?? '', pipelineRunId: config.pipelineRunId ?? '' },
      )
      testPlanPhaseResult = testPlanResult.result
      testPlanTokenUsage = testPlanResult.tokenUsage
      if (testPlanResult.result === 'success') {
        logger.info({ storyKey }, 'Test plan generated successfully')
      } else {
        logger.warn({ storyKey }, 'Test planning returned failed result — proceeding to dev-story without test plan')
      }
    } catch (err) {
      logger.warn({ storyKey, err }, 'Test planning failed — proceeding to dev-story without test plan')
    }

    endPhase(storyKey, 'test-plan')

    // Record test-plan token usage for accurate per-story cost attribution
    if (config.pipelineRunId !== undefined && testPlanTokenUsage !== undefined) {
      try {
        addTokenUsage(db, config.pipelineRunId, {
          phase: 'test-plan',
          agent: 'test-plan',
          input_tokens: testPlanTokenUsage.input,
          output_tokens: testPlanTokenUsage.output,
          cost_usd: estimateDispatchCost(testPlanTokenUsage.input, testPlanTokenUsage.output),
          metadata: JSON.stringify({ storyKey }),
        })
      } catch (tokenErr) {
        logger.warn({ storyKey, err: tokenErr }, 'Failed to record test-plan token usage')
      }
    }

    eventBus.emit('orchestrator:story-phase-complete', {
      storyKey,
      phase: 'IN_TEST_PLANNING',
      result: { result: testPlanPhaseResult },
    })

    // -- dev-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    startPhase(storyKey, 'dev-story')
    updateStory(storyKey, { phase: 'IN_DEV' as StoryPhase })
    await persistState()

    let devFilesModified: string[] = []
    // Per-batch file tracking for batched review (empty when single dispatch)
    const batchFileGroups: Array<{ batchIndex: number; files: string[] }> = []
    // Track whether dev-story reported a COMPLETE (success) result — used by
    // the zero-diff detection gate (Story 24-1) below.
    let devStoryWasSuccess = false
    // Output token count from the dev-story dispatch; forwarded to TrivialOutputCheck (Story 51-5)
    let devOutputTokenCount: number | undefined

    // Capture baseline HEAD SHA before dispatch so the zero-diff gate can
    // detect committed work (not just uncommitted changes).  Fixes the
    // false-escalation bug where an agent commits its work, leaving a clean
    // working tree that was incorrectly treated as zero-diff.
    let baselineHeadSha: string | undefined
    try {
      baselineHeadSha = execSync('git rev-parse HEAD', {
        cwd: projectRoot ?? process.cwd(),
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      // No commits yet or git unavailable — leave undefined; zero-diff gate
      // will fall back to working-tree-only check.
    }

    try {
      // Analyze story complexity to determine whether batching is needed (AC1, AC7)
      let storyContentForAnalysis = ''
      try {
        storyContentForAnalysis = await readFile(storyFilePath ?? '', 'utf-8')
      } catch (err) {
        // If we can't read for analysis, fall back to single dispatch
        logger.error(
          { storyKey, storyFilePath, error: err instanceof Error ? err.message : String(err) },
          'Could not read story file for complexity analysis — falling back to single dispatch',
        )
      }

      const analysis = analyzeStoryComplexity(storyContentForAnalysis)
      const batches = planTaskBatches(analysis)

      logger.info(
        { storyKey, estimatedScope: analysis.estimatedScope, batchCount: batches.length, taskCount: analysis.taskCount },
        'Story complexity analyzed',
      )

      if (analysis.estimatedScope === 'large' && batches.length > 1) {
        // AC1: Large story — dispatch sequentially per batch
        const allFilesModified = new Set<string>()

        // AC1: Record decomposition metrics on the orchestrator run result
        _decomposition = {
          totalTasks: analysis.taskCount,
          batchCount: batches.length,
          batchSizes: batches.map((b) => b.taskIds.length),
        }

        for (const batch of batches) {
          await waitIfPaused()
          if (_state !== 'RUNNING') break

          // AC2: Build taskScope string listing this batch's tasks
          const taskScope = batch.taskIds
            .map((id, i) => `T${id}: ${batch.taskTitles[i] ?? ''}`)
            .join('\n')

          // AC4: Prior files from all previously accumulated batches
          const priorFiles = allFilesModified.size > 0 ? Array.from(allFilesModified) : undefined

          logger.info(
            { storyKey, batchIndex: batch.batchIndex, taskCount: batch.taskIds.length },
            'Dispatching dev-story batch',
          )

          const batchStartMs = Date.now()
          incrementDispatches(storyKey)
          let batchResult
          try {
            batchResult = await runDevStory(
              { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
                ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}),
                ...(storyOptions?.optimizationDirectives !== undefined ? { optimizationDirectives: storyOptions.optimizationDirectives } : {}) },
              {
                storyKey,
                storyFilePath: storyFilePath ?? '',
                pipelineRunId: config.pipelineRunId,
                taskScope,
                priorFiles,
              },
            )
          } catch (batchErr) {
            // AC6: Batch failure — log and continue with partial files
            const errMsg = batchErr instanceof Error ? batchErr.message : String(batchErr)
            logger.warn(
              { storyKey, batchIndex: batch.batchIndex, error: errMsg },
              'Batch dispatch threw an exception — continuing with partial files',
            )
            continue
          }

          const batchDurationMs = Date.now() - batchStartMs
          const batchFilesModified = batchResult.files_modified ?? []

          // AC2: Emit per-batch metrics log entry
          const batchMetrics: PerBatchMetrics = {
            batchIndex: batch.batchIndex,
            taskIds: batch.taskIds,
            tokensUsed: {
              input: batchResult.tokenUsage?.input ?? 0,
              output: batchResult.tokenUsage?.output ?? 0,
            },
            durationMs: batchDurationMs,
            filesModified: batchFilesModified,
            result: batchResult.result === 'success' ? 'success' : 'failed',
          }
          logger.info(batchMetrics, 'Batch dev-story metrics')

          // AC5: Accumulate files_modified across all batches
          for (const f of batchFilesModified) {
            allFilesModified.add(f)
          }

          // Track per-batch files for batched review
          if (batchFilesModified.length > 0) {
            batchFileGroups.push({ batchIndex: batch.batchIndex, files: batchFilesModified })
          }

          // AC5: Store batch context in token_usage metadata JSON
          if (config.pipelineRunId !== undefined && batchResult.tokenUsage !== undefined) {
            try {
              addTokenUsage(db, config.pipelineRunId, {
                phase: 'dev-story',
                agent: `batch-${batch.batchIndex}`,
                input_tokens: batchResult.tokenUsage.input,
                output_tokens: batchResult.tokenUsage.output,
                cost_usd: estimateDispatchCost(batchResult.tokenUsage.input, batchResult.tokenUsage.output),
                metadata: JSON.stringify({
                  storyKey,
                  batchIndex: batch.batchIndex,
                  taskIds: batch.taskIds,
                  durationMs: batchDurationMs,
                  result: batchMetrics.result,
                }),
              })
            } catch (tokenErr) {
              logger.warn({ storyKey, batchIndex: batch.batchIndex, err: tokenErr }, 'Failed to record batch token usage')
            }
          }

          // Accumulate output tokens across batches for TrivialOutputCheck (Story 51-5)
          if (batchResult.tokenUsage?.output !== undefined) {
            devOutputTokenCount = (devOutputTokenCount ?? 0) + batchResult.tokenUsage.output
          }

          if (batchResult.result === 'failed') {
            // AC6: Batch returned failure — log and continue (partial progress)
            logger.warn(
              { storyKey, batchIndex: batch.batchIndex, error: batchResult.error },
              'Batch dev-story reported failure — continuing with partial files',
            )
          } else {
            // At least one batch reported success — track for zero-diff gate (Story 24-1)
            devStoryWasSuccess = true
          }

          eventBus.emit('orchestrator:story-phase-complete', {
            storyKey,
            phase: 'IN_DEV',
            result: batchResult,
          })
          await persistState()
        }

        devFilesModified = Array.from(allFilesModified)
      } else {
        // AC7: Small/medium story — single dispatch (existing behavior)
        incrementDispatches(storyKey)
        const devResult = await runDevStory(
          { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
            ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}),
            ...(storyOptions?.optimizationDirectives !== undefined ? { optimizationDirectives: storyOptions.optimizationDirectives } : {}) },
          {
            storyKey,
            storyFilePath: storyFilePath ?? '',
            pipelineRunId: config.pipelineRunId,
          },
        )

        devFilesModified = devResult.files_modified ?? []
        // Capture output tokens for TrivialOutputCheck (Story 51-5)
        devOutputTokenCount = devResult.tokenUsage?.output ?? undefined

        // Record single-dispatch dev-story token usage for per-story cost attribution
        if (config.pipelineRunId !== undefined && devResult.tokenUsage !== undefined) {
          try {
            addTokenUsage(db, config.pipelineRunId, {
              phase: 'dev-story',
              agent: 'dev-story',
              input_tokens: devResult.tokenUsage.input,
              output_tokens: devResult.tokenUsage.output,
              cost_usd: estimateDispatchCost(devResult.tokenUsage.input, devResult.tokenUsage.output),
              metadata: JSON.stringify({ storyKey }),
            })
          } catch (tokenErr) {
            logger.warn({ storyKey, err: tokenErr }, 'Failed to record dev-story token usage')
          }
        }

        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: 'IN_DEV',
          result: devResult,
        })
        await persistState()

        // -- Story 39-5 / 39-6: dev-story timeout checkpoint + retry --
        // Detect timeout before generic failure handling. runDevStory coerces
        // dispatch timeout into result:'failed' with error:'dispatch_timeout after Xms'.
        // checkpointHandled is set to true when retry completes so the subsequent
        // devResult success check is skipped (we already set devStoryWasSuccess from
        // the retry result).
        let checkpointHandled = false
        if (devResult.result === 'failed' && devResult.error?.startsWith('dispatch_timeout')) {
          endPhase(storyKey, 'dev-story')
          const timeoutFiles = checkGitDiffFiles(projectRoot ?? process.cwd())

          if (timeoutFiles.length === 0) {
            // AC3: No partial files on disk — escalate immediately (nothing to retry from)
            logger.warn(
              { storyKey },
              'Dev-story timeout with zero modified files — escalating immediately (no checkpoint)',
            )
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: 'timeout-no-files',
              completedAt: new Date().toISOString(),
            })
            await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
            await emitEscalation({
              storyKey,
              lastVerdict: 'timeout-no-files',
              reviewCycles: 0,
              issues: ['dev-story timed out with no partial files — nothing to checkpoint'],
            })
            await persistState()
            return
          }

          // AC1, AC2: Partial files exist — capture checkpoint
          logger.info(
            { storyKey, filesCount: timeoutFiles.length },
            'Dev-story timeout with partial files — capturing checkpoint',
          )

          let gitDiff = ''
          try {
            gitDiff = execSync(
              `git diff HEAD -- ${timeoutFiles.map((f) => `"${f}"`).join(' ')}`,
              {
                cwd: projectRoot ?? process.cwd(),
                encoding: 'utf-8',
                timeout: 10_000,
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            ).trim()
          } catch (diffErr) {
            logger.warn(
              { storyKey, error: diffErr instanceof Error ? diffErr.message : String(diffErr) },
              'Failed to capture git diff for checkpoint — proceeding with empty diff',
            )
          }

          _checkpoints.set(storyKey, {
            filesModified: timeoutFiles,
            gitDiff,
            partialOutput: devResult.error ?? '',
          })

          // AC2: Set story phase to CHECKPOINT (AC5: store filesCount for status display)
          updateStory(storyKey, { phase: 'CHECKPOINT' as StoryPhase, checkpointFilesCount: timeoutFiles.length })

          // AC4: Emit checkpoint event
          const diffSizeBytes = Buffer.byteLength(gitDiff, 'utf-8')
          eventBus.emit('story:checkpoint-saved', {
            storyKey,
            filesCount: timeoutFiles.length,
            diffSizeBytes,
          })

          // AC6: Record dispatch_log entry with result: 'timeout'
          if (stateStore !== undefined) {
            stateStore.recordMetric({
              storyKey,
              taskType: 'dev-story',
              result: 'timeout',
              recordedAt: new Date().toISOString(),
              sprint: config.sprint,
            }).catch((storeErr: unknown) => {
              logger.warn({ err: storeErr, storyKey }, 'Failed to record timeout metric to StateStore (best-effort)')
            })
          }

          await persistState()

          // -- Story 39-6: Checkpoint retry --
          // Instead of stopping at CHECKPOINT, dispatch a retry with the partial
          // work context injected so the agent can pick up where it left off.
          // If the retry also times out, escalate (handled below via checkpointRetryResult.status).

          // AC6: Emit checkpoint-retry event before dispatching
          eventBus.emit('story:checkpoint-retry', {
            storyKey,
            filesCount: timeoutFiles.length,
            attempt: 2,
          })

          // AC2: Assemble checkpoint retry prompt (dev-story template + partial work context)
          const checkpointData = _checkpoints.get(storyKey)!
          let checkpointRetryPrompt: string
          let checkpointRetryMaxTurns: number | undefined
          try {
            const devStoryTemplate = await pack.getPrompt('dev-story')
            const storyContent = await readFile(storyFilePath ?? '', 'utf-8')

            // AC3: Same turn budget as original dev-story dispatch
            const complexity = computeStoryComplexity(storyContent)
            checkpointRetryMaxTurns = resolveDevStoryMaxTurns(complexity.complexityScore)
            logComplexityResult(storyKey, complexity, checkpointRetryMaxTurns)

            let archConstraints = ''
            try {
              const decisions = await getDecisionsByPhase(db, 'solutioning')
              const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
              archConstraints = constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
            } catch { /* arch constraints are optional */ }

            const checkpointContext = [
              'Your prior attempt timed out. Here is the work you completed:',
              '',
              `Files modified (${checkpointData.filesModified.length}):`,
              ...checkpointData.filesModified.map((f) => `- ${f}`),
              '',
              '```diff',
              checkpointData.gitDiff || '(no diff available)',
              '```',
              '',
              'Continue from where you left off. Do not redo completed work.',
            ].join('\n')

            const sections = [
              { name: 'story_content', content: storyContent, priority: 'required' as const },
              { name: 'checkpoint_context', content: checkpointContext, priority: 'required' as const },
              { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
            ]
            const assembled = assemblePrompt(devStoryTemplate, sections, 24000)
            checkpointRetryPrompt = assembled.prompt
          } catch {
            checkpointRetryPrompt = `Continue story ${storyKey} from checkpoint. Your prior attempt timed out. Do not redo completed work.`
            logger.warn({ storyKey }, 'Failed to assemble checkpoint retry prompt — using fallback')
          }

          // AC3: Dispatch retry with same taskType: 'dev-story' (same timeout + turn budget)
          logger.info(
            { storyKey, filesCount: checkpointData.filesModified.length },
            'Dispatching checkpoint retry for timed-out story',
          )
          incrementDispatches(storyKey)
          updateStory(storyKey, { phase: 'IN_DEV' as StoryPhase })
          startPhase(storyKey, 'dev-story-retry')

          const checkpointRetryHandle = dispatcher.dispatch({
            prompt: checkpointRetryPrompt,
            agent: deps.agentId ?? 'claude-code',
            taskType: 'dev-story',
            outputSchema: DevStoryResultSchema,
            ...(checkpointRetryMaxTurns !== undefined ? { maxTurns: checkpointRetryMaxTurns } : {}),
            ...(projectRoot !== undefined ? { workingDirectory: projectRoot } : {}),
            ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            ...(config.perStoryContextCeilings?.[storyKey] !== undefined
              ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
              : {}),
            storyKey,
          })
          const checkpointRetryResult = await checkpointRetryHandle.result
          endPhase(storyKey, 'dev-story-retry')

          eventBus.emit('orchestrator:story-phase-complete', {
            storyKey,
            phase: 'IN_DEV',
            result: {
              tokenUsage: checkpointRetryResult.tokenEstimate
                ? { input: checkpointRetryResult.tokenEstimate.input, output: checkpointRetryResult.tokenEstimate.output }
                : undefined,
            },
          })

          if (checkpointRetryResult.status === 'timeout') {
            // AC4: Second timeout → escalate (no infinite retry loop)
            // NOTE: do NOT call endPhase(storyKey, 'dev-story') here — it was already
            // called at the start of the timeout handler (before entering checkpoint logic).
            // Calling it again would overwrite the first end timestamp and inflate phase duration.
            logger.warn({ storyKey }, 'Checkpoint retry dispatch timed out — escalating story')
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: 'checkpoint-retry-timeout',
              completedAt: new Date().toISOString(),
            })
            await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
            await emitEscalation({
              storyKey,
              lastVerdict: 'checkpoint-retry-timeout',
              reviewCycles: 0,
              issues: ['checkpoint retry timed out — no infinite retry loop'],
            })
            await persistState()
            return
          }

          // AC5: Retry completed (success or failure) — proceed to code review
          const retryParsed = checkpointRetryResult.parsed
          devFilesModified = retryParsed?.files_modified ?? checkGitDiffFiles(projectRoot ?? process.cwd())
          if (checkpointRetryResult.status === 'completed' && retryParsed?.result === 'success') {
            devStoryWasSuccess = true
          } else {
            logger.warn(
              { storyKey, status: checkpointRetryResult.status },
              'Checkpoint retry completed with failure — proceeding to code review',
            )
          }
          checkpointHandled = true
        }

        if (!checkpointHandled) {
          if (devResult.result === 'success') {
            devStoryWasSuccess = true
          } else {
            // Dev agent failed but may have produced code (common when agent
            // exhausts turns or exits non-zero after partial work). Proceed to
            // code review — the reviewer will assess actual code state.
            logger.warn({
              storyKey,
              error: devResult.error,
              filesModified: devFilesModified.length,
            }, 'Dev-story reported failure, proceeding to code review')

            // Distinguish non-timeout agent crashes from timeouts (which are handled above)
            if (!devResult.error?.startsWith('dispatch_timeout')) {
              logger.warn({ storyKey, error: devResult.error }, 'Agent process failure (non-timeout) — story will proceed to code review with partial work')
              eventBus.emit('orchestrator:story-warn', { storyKey, msg: 'agent process failure (non-timeout)' })
            }
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      endPhase(storyKey, 'dev-story')
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
      await emitEscalation({
        storyKey,
        lastVerdict: 'dev-story-exception',
        reviewCycles: 0,
        issues: [errMsg],
      })
      await persistState()
      return
    }

    // -- zero-diff detection gate (Story 24-1) --
    // Only applies when dev-story reported COMPLETE (result === 'success').
    // Non-success results proceed to code-review as before so the reviewer
    // can assess partial work (AC5).
    // gitDiffFiles is hoisted so the interface change detector (24-3) can
    // use ground-truth file paths instead of the agent's self-reported list.
    let gitDiffFiles: string[] | undefined
    if (devStoryWasSuccess) {
      gitDiffFiles = checkGitDiffFiles(projectRoot ?? process.cwd())
      if (gitDiffFiles.length === 0) {
        // Before escalating, check whether HEAD has moved since baseline.
        // If the agent committed its work, the working tree is clean but
        // new commits exist — that's real work, not a phantom completion.
        let hasNewCommits = false
        if (baselineHeadSha) {
          try {
            const currentHead = execSync('git rev-parse HEAD', {
              cwd: projectRoot ?? process.cwd(),
              encoding: 'utf-8',
              timeout: 3000,
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()
            hasNewCommits = currentHead !== baselineHeadSha
          } catch {
            // git failed — fall through to escalation
          }
        }

        if (hasNewCommits) {
          logger.info(
            { storyKey, baselineHeadSha },
            'Working tree clean but new commits detected since dispatch — skipping zero-diff escalation',
          )
        } else {
          logger.warn(
            { storyKey },
            'Zero-diff detected after COMPLETE dev-story — no file changes and no new commits',
          )
          eventBus.emit('orchestrator:zero-diff-escalation', {
            storyKey,
            reason: 'zero-diff-on-complete',
          })
          endPhase(storyKey, 'dev-story')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: 'zero-diff-on-complete',
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
          await emitEscalation({
            storyKey,
            lastVerdict: 'zero-diff-on-complete',
            reviewCycles: 0,
            issues: ['dev-story completed with COMPLETE verdict but no file changes detected in git diff'],
          })
          await persistState()
          return
        }
      }
    }

    // -- code-review phase (with retry/rework) --
    endPhase(storyKey, 'dev-story')

    // -- build verification gate (Story 24-2) --
    // Runs synchronously after dev-story, before dispatching code-review.
    // Catches compile-time errors (missing exports, type mismatches) before
    // wasting a review cycle. Respects skipBuildVerify — independent from
    // skipPreflight so pre-flight and per-story gates can be toggled separately.
    let _buildPassed = false // hoisted for code-review prompt context
    {
      let buildVerifyResult = config.skipBuildVerify === true
        ? { status: 'skipped' as const }
        : runBuildVerification({
            verifyCommand: pack.manifest.verifyCommand,
            verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
            projectRoot: projectRoot ?? process.cwd(),
            changedFiles: gitDiffFiles,
          })

      if (buildVerifyResult.status === 'passed') {
        // Secondary typecheck: catch type errors the bundler may skip (e.g., empty modules).
        // Uses tsconfig.typecheck.json when available — it includes src/**/*.ts which catches
        // monolith-level type mismatches that project-reference-only builds miss.
        const resolvedRootForTsc = projectRoot ?? process.cwd()
        const tscBin = join(resolvedRootForTsc, 'node_modules', '.bin', 'tsc')
        const typecheckConfig = join(resolvedRootForTsc, 'tsconfig.typecheck.json')
        const defaultConfig = join(resolvedRootForTsc, 'tsconfig.json')
        const tscConfigFlag = existsSync(typecheckConfig)
          ? ` -p ${typecheckConfig}`
          : ''
        const hasTsc = existsSync(tscBin) && (existsSync(typecheckConfig) || existsSync(defaultConfig))
        if (hasTsc) {
          try {
            execSync(`"${tscBin}" --noEmit${tscConfigFlag}`, {
              cwd: resolvedRootForTsc,
              timeout: 120_000,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            logger.info({ storyKey }, 'Secondary typecheck (tsc --noEmit) passed')
          } catch (tscErr) {
            const tscOutput = tscErr instanceof Error && 'stdout' in tscErr
              ? String((tscErr as { stdout?: string }).stdout ?? '').slice(0, 2000)
              : ''
            logger.warn({ storyKey, tscOutput }, 'Secondary typecheck (tsc --noEmit) failed — treating as build failure')
            buildVerifyResult = {
              status: 'failed',
              exitCode: 2,
              output: `tsc --noEmit failed:\n${tscOutput}`,
              reason: 'build-verification-failed',
            }
          }
        }
      }

      if (buildVerifyResult.status === 'passed') {
        _buildPassed = true
        eventBus.emit('story:build-verification-passed', { storyKey })
        logger.info({ storyKey }, 'Build verification passed')
      } else if (buildVerifyResult.status === 'failed' || buildVerifyResult.status === 'timeout') {
        const truncatedOutput = (buildVerifyResult.output ?? '').slice(0, 2000)
        const reason = buildVerifyResult.reason ?? 'build-verification-failed'

        // -- package snapshot restore: detect cross-story node_modules pollution --
        let retryPassed = false

        if (_packageSnapshot !== undefined && buildVerifyResult.status !== 'timeout') {
          const resolvedRoot = projectRoot ?? process.cwd()
          const hasChanges = detectPackageChanges(_packageSnapshot, resolvedRoot)
          if (hasChanges) {
            logger.warn({ storyKey }, 'Package files changed since snapshot — restoring to prevent cascade')
            const restoreResult = restorePackageSnapshot(_packageSnapshot, { projectRoot: resolvedRoot })
            if (restoreResult.restored) {
              const retryAfterRestore = runBuildVerification({
                verifyCommand: pack.manifest.verifyCommand,
                verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
                projectRoot: resolvedRoot,
                changedFiles: gitDiffFiles,
              })
              if (retryAfterRestore.status === 'passed') {
                retryPassed = true
                _buildPassed = true
                eventBus.emit('story:build-verification-passed', { storyKey })
                logger.warn(
                  { storyKey, filesRestored: restoreResult.filesRestored },
                  'Build passed after package snapshot restore — cross-story pollution detected and cleaned',
                )
              } else {
                logger.warn(
                  { storyKey, filesRestored: restoreResult.filesRestored },
                  'Build still fails after snapshot restore — story has its own build errors',
                )
              }
            }
          }
        }

        // -- build-fix retry: attempt to auto-fix missing npm packages before escalating --
        const fullOutput = buildVerifyResult.output ?? ''
        const missingPkgMatch = fullOutput.match(
          /Cannot find (?:module|package) ['"]([^'"]+)['"]/
        ) ?? fullOutput.match(
          /ERR_MODULE_NOT_FOUND[^]*?['"]([^'"]+)['"]/
        )

        if (missingPkgMatch && buildVerifyResult.status !== 'timeout') {
          const missingPkg = missingPkgMatch[1]
            // Strip subpath imports (e.g. "@foo/bar/baz" → "@foo/bar")
            .replace(/^(@[^/]+\/[^/]+)\/.*$/, '$1')
            .replace(/^([^@][^/]*)\/.*$/, '$1')

          const resolvedRoot = projectRoot ?? process.cwd()
          logger.warn(
            { storyKey, missingPkg },
            'Build-fix retry: detected missing npm package — attempting npm install',
          )

          try {
            execSync(`npm install ${missingPkg}`, {
              cwd: resolvedRoot,
              timeout: 60_000,
              encoding: 'utf-8',
              stdio: 'pipe',
            })

            logger.warn(
              { storyKey, missingPkg },
              'Build-fix retry: npm install succeeded — retrying build verification',
            )

            const retryResult = runBuildVerification({
              verifyCommand: pack.manifest.verifyCommand,
              verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
              projectRoot: resolvedRoot,
              changedFiles: gitDiffFiles,
            })

            if (retryResult.status === 'passed') {
              retryPassed = true
              _buildPassed = true
              eventBus.emit('story:build-verification-passed', { storyKey })
              logger.warn(
                { storyKey, missingPkg },
                'Build-fix retry: build verification passed after installing missing package',
              )
            } else {
              logger.warn(
                { storyKey, missingPkg, retryStatus: retryResult.status },
                'Build-fix retry: build still fails after installing missing package — escalating',
              )
            }
          } catch (installErr: unknown) {
            const installMsg = installErr instanceof Error ? installErr.message : String(installErr)
            logger.warn(
              { storyKey, missingPkg, error: installMsg },
              'Build-fix retry: npm install failed — escalating',
            )
          }
        }

        if (!retryPassed) {
          // -- build-fix dispatch: attempt agent-driven fix before escalating --
          // Mirrors the code-review fix cycle: dispatch a focused fix agent with
          // the build error output, then re-verify. Only for type/compile errors
          // (not timeouts or missing build scripts).
          let buildFixPassed = false
          if (
            buildVerifyResult.status === 'failed' &&
            storyFilePath !== undefined
          ) {
            try {
              logger.info({ storyKey }, 'Dispatching build-fix agent')
              startPhase(storyKey, 'build-fix')

              const storyContent = await readFile(storyFilePath, 'utf-8')
              let buildFixTemplate: string
              try {
                buildFixTemplate = await pack.getPrompt('build-fix')
              } catch {
                buildFixTemplate = [
                  '## Build Error Output\n{{build_errors}}',
                  '## Story File Content\n{{story_content}}',
                  '---',
                  'Fix the build errors above. Make minimal changes. Run the build to verify.',
                ].join('\n\n')
              }

              const buildFixPrompt = buildFixTemplate
                .replace('{{build_errors}}', truncatedOutput)
                .replace('{{story_content}}', storyContent.slice(0, 4000))

              incrementDispatches(storyKey)
              const fixHandle = dispatcher.dispatch<unknown>({
                prompt: buildFixPrompt,
                agent: deps.agentId ?? 'claude-code',
                taskType: 'build-fix',
                maxTurns: 15,
                workingDirectory: projectRoot ?? process.cwd(),
                ...(config.perStoryContextCeilings?.[storyKey] !== undefined
                  ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
                  : {}),
                ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
              })

              await fixHandle.result

              endPhase(storyKey, 'build-fix')

              // Re-verify build after fix
              const retryAfterFix = runBuildVerification({
                verifyCommand: pack.manifest.verifyCommand,
                verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
                projectRoot: projectRoot ?? process.cwd(),
                changedFiles: gitDiffFiles,
              })

              if (retryAfterFix.status === 'passed') {
                buildFixPassed = true
                _buildPassed = true
                eventBus.emit('story:build-verification-passed', { storyKey })
                logger.info({ storyKey }, 'Build passed after build-fix dispatch')
              } else {
                logger.warn({ storyKey }, 'Build still fails after build-fix dispatch — escalating')
              }
            } catch (fixErr) {
              const fixMsg = fixErr instanceof Error ? fixErr.message : String(fixErr)
              logger.warn({ storyKey, error: fixMsg }, 'Build-fix dispatch failed — escalating')
            }
          }

          if (!buildFixPassed) {
            eventBus.emit('story:build-verification-failed', {
              storyKey,
              exitCode: buildVerifyResult.exitCode ?? 1,
              output: truncatedOutput,
            })

            logger.warn(
              { storyKey, reason, exitCode: buildVerifyResult.exitCode },
              'Build verification failed — escalating story',
            )

            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: reason,
              completedAt: new Date().toISOString(),
            })
            await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
            await emitEscalation({
              storyKey,
              lastVerdict: reason,
              reviewCycles: 0,
              issues: [truncatedOutput],
            })
            await persistState()
            return
          }
        }
      }
      // status === 'skipped': gate disabled — proceed directly to code-review
    }

    // -- interface change detection (Story 24-3) --
    // Non-blocking warning: detects exported interfaces/types in modified .ts
    // files and checks if cross-module test files may have stale mocks.
    // Failure never blocks the pipeline (AC5: graceful degradation).
    // Prefer gitDiffFiles (ground truth from git) over devFilesModified
    // (agent self-report) when available.
    {
      try {
        const filesModified = gitDiffFiles ?? devFilesModified
        if (filesModified.length > 0) {
          const icResult = detectInterfaceChanges({
            filesModified,
            projectRoot: projectRoot ?? process.cwd(),
            storyKey,
          })
          if (icResult.potentiallyAffectedTests.length > 0) {
            logger.warn(
              {
                storyKey,
                modifiedInterfaces: icResult.modifiedInterfaces,
                potentiallyAffectedTests: icResult.potentiallyAffectedTests,
              },
              'Interface change warning: modified exports may affect cross-module test mocks',
            )
            eventBus.emit('story:interface-change-warning', {
              storyKey,
              modifiedInterfaces: icResult.modifiedInterfaces,
              potentiallyAffectedTests: icResult.potentiallyAffectedTests,
            })
          }
        }
      } catch {
        // AC5: outer catch — never block pipeline for detection errors
      }
    }

    let reviewCycles = 0
    let keepReviewing = true
    let timeoutRetried = false
    let previousIssueList: Array<{ severity?: string; description?: string; file?: string; line?: number }> = []

    while (keepReviewing) {
      await waitIfPaused()
      if (_state !== 'RUNNING') return

      if (reviewCycles === 0) startPhase(storyKey, 'code-review')

      // -- Story 53-4: Retry budget gate (AC5) --
      // Gate positioned BEFORE any retry dispatch, unconditional (cannot be bypassed).
      // reviewCycles === 0 → initial dev dispatch (not a retry), skip gate.
      // reviewCycles > 0  → retry attempt — check and enforce budget.
      if (reviewCycles > 0) {
        const currentRetries = _storyRetryCount.get(storyKey) ?? 0
        const budget = config.retryBudget ?? 2
        if (currentRetries >= budget) {
          // Budget exhausted — mandatory escalation
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            reviewCycles,
            completedAt: new Date().toISOString(),
            error: 'retry_budget_exhausted',
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles)
          await emitEscalation({
            storyKey,
            lastVerdict: 'retry_budget_exhausted',
            reviewCycles,
            issues: [`retry budget exhausted: ${currentRetries}/${budget} retries used`],
            retryBudget: budget,
            retryCount: currentRetries,
          })
          await persistState()
          return
        }
        // Budget not exhausted — increment counter and proceed with retry
        incrementRetryCount(storyKey)
      }

      updateStory(storyKey, {
        phase: 'IN_REVIEW' as StoryPhase,
        reviewCycles,
      })

      let verdict: string
      let issueList: unknown[] = []
      let reviewResult: Awaited<ReturnType<typeof runCodeReview>> | undefined

      try {
        // Batched review: when decomposition produced multiple batches and this is
        // the first review cycle, review each batch's files separately to keep diff
        // sizes manageable for the headless reviewer. Re-reviews after fixes always
        // review all files since fixes may cross batch boundaries.
        const useBatchedReview = batchFileGroups.length > 1 && previousIssueList.length === 0

        if (useBatchedReview) {
          // Per-batch reviews — aggregate worst verdict + union issues
          const allIssues: Array<{ severity: 'blocker' | 'major' | 'minor'; description: string; file?: string; line?: number }> = []
          let worstVerdict: 'SHIP_IT' | 'LGTM_WITH_NOTES' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' = 'SHIP_IT'
          let aggregateTokens = { input: 0, output: 0 }
          let lastError: string | undefined
          let lastRawOutput: string | undefined

          const verdictRank = { 'SHIP_IT': 0, 'LGTM_WITH_NOTES': 0.5, 'NEEDS_MINOR_FIXES': 1, 'NEEDS_MAJOR_REWORK': 2 } as const

          for (const group of batchFileGroups) {
            logger.info(
              { storyKey, batchIndex: group.batchIndex, fileCount: group.files.length },
              'Running batched code review',
            )
            incrementDispatches(storyKey)
            const batchReview = await runCodeReview(
              { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
                ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}) },
              {
                storyKey,
                storyFilePath: storyFilePath ?? '',
                workingDirectory: projectRoot,
                pipelineRunId: config.pipelineRunId,
                filesModified: group.files,
                buildPassed: _buildPassed,
              },
            )

            // Accumulate
            if (batchReview.tokenUsage) {
              aggregateTokens.input += batchReview.tokenUsage.input
              aggregateTokens.output += batchReview.tokenUsage.output
            }
            for (const iss of batchReview.issue_list ?? []) {
              allIssues.push(iss)
            }
            const bv = batchReview.verdict as keyof typeof verdictRank
            if (verdictRank[bv] > verdictRank[worstVerdict]) {
              worstVerdict = bv
            }
            if (batchReview.error) lastError = batchReview.error
            if (batchReview.rawOutput) lastRawOutput = batchReview.rawOutput
          }

          // Synthesize aggregate result
          reviewResult = {
            verdict: worstVerdict,
            issues: allIssues.length,
            issue_list: allIssues,
            error: lastError,
            rawOutput: lastRawOutput,
            tokenUsage: aggregateTokens,
          }

          logger.info(
            { storyKey, batchCount: batchFileGroups.length, verdict: worstVerdict, issues: allIssues.length },
            'Batched code review complete — aggregate result',
          )
        } else {
          // Single review (small story or re-review after fix)
          incrementDispatches(storyKey)
          reviewResult = await runCodeReview(
            { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
              ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}) },
            {
              storyKey,
              storyFilePath: storyFilePath ?? '',
              workingDirectory: projectRoot,
              pipelineRunId: config.pipelineRunId,
              filesModified: devFilesModified,
              buildPassed: _buildPassed,
              // Scope re-reviews: pass previous issues so the reviewer verifies fixes first
              ...(previousIssueList.length > 0 ? { previousIssues: previousIssueList } : {}),
            },
          )
        }

        // Record code-review token usage for per-story cost attribution
        if (config.pipelineRunId !== undefined && reviewResult.tokenUsage !== undefined) {
          try {
            addTokenUsage(db, config.pipelineRunId, {
              phase: 'code-review',
              agent: useBatchedReview ? 'code-review-batched' : 'code-review',
              input_tokens: reviewResult.tokenUsage.input,
              output_tokens: reviewResult.tokenUsage.output,
              cost_usd: estimateDispatchCost(reviewResult.tokenUsage.input, reviewResult.tokenUsage.output),
              metadata: JSON.stringify({ storyKey, reviewCycle: reviewCycles }),
            })
          } catch (tokenErr) {
            logger.warn({ storyKey, err: tokenErr }, 'Failed to record code-review token usage')
          }
        }

        // Phantom review detection: dispatch failures (crash, timeout, non-zero exit)
        // are flagged with dispatchFailed=true. Also detect heuristically when verdict
        // is non-SHIP_IT but issue list is empty + error (schema validation failure,
        // truncated response). Either way, retry the review once before escalation.
        const isPhantomReview = reviewResult.dispatchFailed === true
          || (reviewResult.verdict !== 'SHIP_IT'
            && reviewResult.verdict !== 'LGTM_WITH_NOTES'
            && (reviewResult.issue_list === undefined || reviewResult.issue_list.length === 0)
            && reviewResult.error !== undefined)
        if (isPhantomReview && !timeoutRetried) {
          timeoutRetried = true
          logger.warn(
            { storyKey, reviewCycles, error: reviewResult.error },
            'Phantom review detected (0 issues + error) — retrying review once',
          )
          continue
        }

        // Consecutive review timeout escalation: if both the original review AND the
        // phantom-retry timed out / failed, escalate immediately. Dispatching a fix
        // agent after 2 consecutive review timeouts wastes ~15+ minutes on yet another
        // timeout — the environment is likely resource-constrained or the story's diff
        // is too large for the reviewer to process within the time limit.
        if (isPhantomReview && timeoutRetried) {
          logger.warn(
            { storyKey, reviewCycles, error: reviewResult.error },
            'Consecutive review timeouts detected (original + retry both failed) — escalating immediately',
          )
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: 'consecutive-review-timeouts',
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
          await emitEscalation({
            storyKey,
            lastVerdict: 'consecutive-review-timeouts',
            reviewCycles: reviewCycles + 1,
            issues: ['Review dispatch failed twice consecutively (original + phantom-retry). Likely resource-constrained or diff too large for reviewer.'],
          })
          await persistState()
          return
        }

        verdict = reviewResult.verdict
        issueList = reviewResult.issue_list ?? []

        // Improvement-aware verdict adjustment: when a re-review (cycle > 0)
        // returns NEEDS_MAJOR_REWORK but issues decreased compared to the
        // previous cycle, the fix agent made real progress. Demote to
        // NEEDS_MINOR_FIXES so the pipeline dispatches a targeted sonnet fix
        // instead of an expensive opus rework. This avoids escalation when
        // only 1-2 residual issues remain from a previously larger set.
        if (
          verdict === 'NEEDS_MAJOR_REWORK'
          && reviewCycles > 0
          && previousIssueList.length > 0
          && issueList.length < previousIssueList.length
        ) {
          logger.info(
            { storyKey, originalVerdict: verdict, issuesBefore: previousIssueList.length, issuesAfter: issueList.length },
            'Issues decreased between review cycles — demoting MAJOR_REWORK to MINOR_FIXES',
          )
          verdict = 'NEEDS_MINOR_FIXES'
        }

        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: 'IN_REVIEW',
          result: reviewResult,
        })

        // Persist review artifact with full issue details for post-mortem diagnosis
        try {
          const summary = reviewResult.error
            ? `${verdict} (error: ${reviewResult.error}) — ${issueList.length} issues`
            : `${verdict} — ${issueList.length} issues`
          // Serialize full issue_list into content_hash for diagnostic queries.
          // On successful reviews (parsed correctly), this captures the actual findings.
          // On failures, it captures whatever partial data is available.
          const issueDetails = issueList.length > 0
            ? JSON.stringify(issueList)
            : reviewResult.rawOutput
              ? `raw:${reviewResult.rawOutput.slice(0, 500)}`
              : undefined
          await registerArtifact(db, {
            pipeline_run_id: config.pipelineRunId,
            phase: 'code-review',
            type: 'review-result',
            path: storyFilePath ?? storyKey,
            summary,
            content_hash: issueDetails,
          })
        } catch {
          // Artifact persistence is best-effort — never block the pipeline
        }

        updateStory(storyKey, { lastVerdict: verdict })
        await persistState()

        // AC3 + AC4: Emit pipeline summary log line with decomposition and verdict info
        {
          const totalTokens = reviewResult.tokenUsage
            ? reviewResult.tokenUsage.input + reviewResult.tokenUsage.output
            : 0
          const totalTokensK = totalTokens > 0 ? `${Math.round(totalTokens / 1000)}K` : '0'
          const fileCount = devFilesModified.length
          const parts: string[] = [`Code review completed: ${verdict}`]

          // AC4: When agentVerdict differs from pipeline verdict, log both
          if (reviewResult.agentVerdict !== undefined && reviewResult.agentVerdict !== verdict) {
            parts[0] = `Code review completed: ${verdict} (agent: ${reviewResult.agentVerdict})`
          }

          // AC3: Include decomposition summary when batching was used
          if (_decomposition !== undefined) {
            parts.push(`decomposed: ${_decomposition.batchCount} batches`)
          }

          parts.push(`${fileCount} files`)
          parts.push(`${totalTokensK} tokens`)

          logger.info({ storyKey, verdict, agentVerdict: reviewResult.agentVerdict }, parts.join(' | '))
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        endPhase(storyKey, 'code-review')
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: errMsg,
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, 'failed', reviewCycles)
        await emitEscalation({
          storyKey,
          lastVerdict: 'code-review-exception',
          reviewCycles,
          issues: [errMsg],
        })
        await persistState()
        return
      }

      if (verdict === 'SHIP_IT' || verdict === 'LGTM_WITH_NOTES') {
        endPhase(storyKey, 'code-review')

        // -- Tier A verification pipeline (Story 51-5) --
        if (config.skipVerification !== true) {
          // reviewResult is CodeReviewResult | undefined; CodeReviewResult already declares
          // dispatchFailed?, error?, and rawOutput? — no casts required.
          const latestReviewSignals: ReviewSignals | undefined = reviewResult != null
            ? {
                dispatchFailed: reviewResult.dispatchFailed,
                error: reviewResult.error,
                rawOutput: reviewResult.rawOutput,
              }
            : undefined
          const verifContext = assembleVerificationContext({
            storyKey,
            workingDir: projectRoot ?? process.cwd(),
            reviewResult: latestReviewSignals,
            outputTokenCount: devOutputTokenCount,
          })
          const verifSummary = await verificationPipeline.run(verifContext, 'A')
          verificationStore.set(storyKey, verifSummary)
          // Story 52-7: persist verification result to run manifest (non-fatal, best-effort)
          // Called before any terminal phase transition so result survives crashes.
          persistVerificationResult(storyKey, verifSummary, runManifest)
          if (verifSummary.status === 'fail') {
            updateStory(storyKey, { phase: 'VERIFICATION_FAILED' as StoryPhase, completedAt: new Date().toISOString() })
            persistStoryState(storyKey, _stories.get(storyKey)!).catch((err) =>
              logger.warn({ err, storyKey }, 'StateStore write failed after verification-failed'),
            )
            await writeStoryMetricsBestEffort(storyKey, 'verification-failed', reviewCycles)
            await persistState()
            return // do NOT mark as COMPLETE
          }
          // warn or pass — fall through to COMPLETE
        }

        updateStory(storyKey, {
          phase: 'COMPLETE' as StoryPhase,
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, verdict, reviewCycles + 1)
        await writeStoryOutcomeBestEffort(storyKey, 'complete', reviewCycles + 1)
        eventBus.emit('orchestrator:story-complete', { storyKey, reviewCycles })
        await persistState()

        // LGTM_WITH_NOTES: persist advisory notes to decision store for learning loop
        if (verdict === 'LGTM_WITH_NOTES' && reviewResult.notes && config.pipelineRunId) {
          try {
            await createDecision(db, {
              pipeline_run_id: config.pipelineRunId,
              phase: 'implementation',
              category: ADVISORY_NOTES,
              key: `${storyKey}:${config.pipelineRunId}`,
              value: JSON.stringify({ storyKey, notes: reviewResult.notes }),
              rationale: `Advisory notes from LGTM_WITH_NOTES review of ${storyKey}`,
            })
            logger.info({ storyKey }, 'Advisory notes persisted to decision store')
          } catch (advisoryErr) {
            logger.warn(
              { storyKey, error: advisoryErr instanceof Error ? advisoryErr.message : String(advisoryErr) },
              'Failed to persist advisory notes (best-effort)',
            )
          }
        }

        // Post-SHIP_IT/LGTM_WITH_NOTES: compute and persist efficiency score (Story 27-6)
        // Non-blocking — telemetry failure never alters the pipeline verdict or state.
        if (telemetryPersistence !== undefined) {
          try {
            const turns = await telemetryPersistence.getTurnAnalysis(storyKey)
            if (turns.length > 0) {
              const scorer = new EfficiencyScorer(logger)
              const effScore = scorer.score(storyKey, turns)
              await telemetryPersistence.storeEfficiencyScore(effScore)
              logger.info(
                {
                  storyKey,
                  compositeScore: effScore.compositeScore,
                  modelCount: effScore.perModelBreakdown.length,
                },
                'Efficiency score computed and persisted',
              )
            } else {
              logger.debug({ storyKey }, 'No turn analysis data available — skipping efficiency scoring')
            }
          } catch (effErr) {
            logger.warn(
              { storyKey, error: effErr instanceof Error ? effErr.message : String(effErr) },
              'Efficiency scoring failed — story verdict unchanged',
            )
          }
        }

        // Post-SHIP_IT/LGTM_WITH_NOTES: compute semantic categorization + consumer stats (Story 27-5, 27-16)
        // Non-blocking — telemetry failure never alters the pipeline verdict or state.
        // Uses turn analysis data (not raw spans) — Claude Code exports logs/metrics, not traces.
        if (telemetryPersistence !== undefined) {
          try {
            const turns = await telemetryPersistence.getTurnAnalysis(storyKey)
            if (turns.length === 0) {
              logger.debug({ storyKey }, 'No turn analysis data for telemetry categorization — skipping')
            } else {
              const categorizer = new Categorizer(logger)
              const consumerAnalyzer = new ConsumerAnalyzer(categorizer, logger)
              const categoryStats = categorizer.computeCategoryStatsFromTurns(turns)
              const consumerStats = consumerAnalyzer.analyzeFromTurns(turns)
              await telemetryPersistence.storeCategoryStats(storyKey, categoryStats)
              await telemetryPersistence.storeConsumerStats(storyKey, consumerStats)
              const growingCount = categoryStats.filter((c) => c.trend === 'growing').length
              const topCategory = categoryStats[0]?.category ?? 'none'
              const topConsumer = consumerStats[0]?.consumerKey ?? 'none'
              logger.info(
                { storyKey, topCategory, topConsumer, growingCount },
                'Semantic categorization and consumer analysis complete',
              )
            }
          } catch (catErr) {
            logger.warn(
              { storyKey, error: catErr instanceof Error ? catErr.message : String(catErr) },
              'Semantic categorization failed — story verdict unchanged',
            )
          }
        }

        // Post-SHIP_IT/LGTM_WITH_NOTES: run test expansion analysis (non-blocking — never alters verdict/state)
        try {
          const expansionResult = await runTestExpansion(
            { db, pack, contextCompiler, dispatcher, projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
            {
              storyKey,
              storyFilePath: storyFilePath ?? '',
              pipelineRunId: config.pipelineRunId,
              filesModified: devFilesModified,
              workingDirectory: projectRoot,
            },
          )
          logger.debug(
            {
              storyKey,
              expansion_priority: expansionResult.expansion_priority,
              coverage_gaps: expansionResult.coverage_gaps.length,
            },
            'Test expansion analysis complete',
          )
          await createDecision(db, {
            pipeline_run_id: config.pipelineRunId ?? 'unknown',
            phase: 'implementation',
            category: TEST_EXPANSION_FINDING,
            key: `${storyKey}:${config.pipelineRunId ?? 'unknown'}`,
            value: JSON.stringify(expansionResult),
          })
        } catch (expansionErr) {
          logger.warn(
            { storyKey, error: expansionErr instanceof Error ? expansionErr.message : String(expansionErr) },
            'Test expansion failed — story verdict unchanged',
          )
        }

        keepReviewing = false
        return
      }

      // Exceeded max review cycles
      if (reviewCycles >= config.maxReviewCycles - 1) {
        const finalReviewCycles = reviewCycles + 1

        // NEEDS_MAJOR_REWORK at the limit → escalate (fundamental issues remain)
        if (verdict !== 'NEEDS_MINOR_FIXES') {
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            reviewCycles: finalReviewCycles,
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', finalReviewCycles)
          await emitEscalation({
            storyKey,
            lastVerdict: verdict,
            reviewCycles: finalReviewCycles,
            issues: issueList,
          })
          await persistState()
          return
        }

        // NEEDS_MINOR_FIXES at the limit → fix then auto-approve (converged on nits)
        logger.info(
          { storyKey, reviewCycles: finalReviewCycles, issueCount: issueList.length },
          'Review cycles exhausted with only minor issues — applying fixes then auto-approving',
        )

        await waitIfPaused()
        if (_state !== 'RUNNING') return

        updateStory(storyKey, { phase: 'NEEDS_FIXES' as StoryPhase })
        try {
          let fixPrompt: string
          let autoApproveMaxTurns: number | undefined
          try {
            const fixTemplate = await pack.getPrompt('fix-story')
            const storyContent = await readFile(storyFilePath ?? '', 'utf-8')

            // Compute maxTurns from story complexity — auto-approve fixes are minor,
            // so cap at half the full complexity budget (min 15) to prevent churn
            const complexity = computeStoryComplexity(storyContent)
            autoApproveMaxTurns = Math.max(15, Math.floor(resolveFixStoryMaxTurns(complexity.complexityScore) / 2))
            logComplexityResult(storyKey, complexity, autoApproveMaxTurns)

            let reviewFeedback: string
            if (issueList.length === 0) {
              reviewFeedback = `Verdict: ${verdict}\nIssues: Minor issues flagged but no specifics provided. Review the story ACs and fix any remaining gaps.`
            } else {
              reviewFeedback = [
                `Verdict: ${verdict}`,
                `Issues (${issueList.length}):`,
                ...issueList.map((issue, i) => {
                  const iss = issue as { severity?: string; description?: string; file?: string; line?: number }
                  return `  ${i + 1}. [${iss.severity ?? 'unknown'}] ${iss.description ?? 'no description'}${iss.file ? ` (${iss.file}${iss.line ? `:${iss.line}` : ''})` : ''}`
                }),
              ].join('\n')
            }
            let archConstraints = ''
            try {
              const decisions = await getDecisionsByPhase(db, 'solutioning')
              const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
              archConstraints = constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
            } catch { /* arch constraints are optional */ }
            const targetedFilesContent = buildTargetedFilesContent(issueList)
            const sections = [
              { name: 'story_content', content: storyContent, priority: 'required' as const },
              { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
              { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
              ...(targetedFilesContent ? [{ name: 'targeted_files', content: targetedFilesContent, priority: 'important' as const }] : []),
            ]
            const assembled = assemblePrompt(fixTemplate, sections, 24000)
            fixPrompt = assembled.prompt
          } catch {
            fixPrompt = `Fix story ${storyKey}: verdict=${verdict}, minor fixes needed`
            logger.warn({ storyKey }, 'Failed to assemble auto-approve fix prompt, using fallback')
          }

          const handle = dispatcher.dispatch<unknown>({
            prompt: fixPrompt,
            agent: deps.agentId ?? 'claude-code',
            taskType: 'minor-fixes',
            workingDirectory: projectRoot,
            ...(autoApproveMaxTurns !== undefined ? { maxTurns: autoApproveMaxTurns } : {}),
            ...(config.perStoryContextCeilings?.[storyKey] !== undefined
              ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
              : {}),
            ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            storyKey,
          })
          const fixResult = await handle.result

          eventBus.emit('orchestrator:story-phase-complete', {
            storyKey,
            phase: 'IN_MINOR_FIX',
            result: {
              tokenUsage: fixResult.tokenEstimate
                ? { input: fixResult.tokenEstimate.input, output: fixResult.tokenEstimate.output }
                : undefined,
            },
          })

          if (fixResult.status === 'timeout') {
            logger.warn({ storyKey }, 'Auto-approve fix timed out — approving anyway (issues were minor)')
          }
        } catch (err) {
          logger.warn({ storyKey, err }, 'Auto-approve fix dispatch failed — approving anyway (issues were minor)')
        }

        // Auto-approve: mark COMPLETE regardless of fix outcome (issues were minor)
        endPhase(storyKey, 'code-review')

        // Emit auto-approve event for transparency — explains why NEEDS_MINOR_FIXES → COMPLETE
        eventBus.emit('story:auto-approved', {
          storyKey,
          verdict,
          reviewCycles: finalReviewCycles,
          maxReviewCycles: config.maxReviewCycles,
          issueCount: issueList.length,
          reason: `Review cycles exhausted (${finalReviewCycles}/${config.maxReviewCycles}) with only minor issues — auto-approving`,
        })

        updateStory(storyKey, {
          phase: 'COMPLETE' as StoryPhase,
          reviewCycles: finalReviewCycles,
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, verdict, finalReviewCycles)
        await writeStoryOutcomeBestEffort(storyKey, 'complete', finalReviewCycles)
        eventBus.emit('orchestrator:story-complete', {
          storyKey,
          reviewCycles: finalReviewCycles,
        })
        await persistState()
        keepReviewing = false
        return
      }

      // -- dispatch fix prompt --

      await waitIfPaused()
      if (_state !== 'RUNNING') return

      // Story 52-8: record recovery entry for this retry dispatch (non-fatal, best-effort).
      // attempt_number is 1-indexed: reviewCycles=0 on first retry → attempt_number=1.
      // appendRecoveryEntry is NOT called on the initial dev-story dispatch — only on fixes.
      if (runManifest) {
        runManifest
          .appendRecoveryEntry({
            story_key: storyKey,
            attempt_number: reviewCycles + 1,
            strategy: 'retry-with-context',
            root_cause: verdict,
            outcome: 'retried',
            cost_usd: 0,
            timestamp: new Date().toISOString(),
          })
          .catch((err: unknown) =>
            logger.warn({ err, storyKey }, 'appendRecoveryEntry failed — pipeline continues'),
          )
      }

      updateStory(storyKey, { phase: 'NEEDS_FIXES' as StoryPhase })
      startPhase(storyKey, 'fix')

      const taskType = verdict === 'NEEDS_MINOR_FIXES' ? 'minor-fixes' : 'major-rework'

      // Model escalation: use Opus for major rework, Sonnet for minor fixes
      const fixModel = taskType === 'major-rework' ? 'claude-opus-4-6' : undefined

      try {
        // Assemble a context-aware fix/rework prompt from the pack template
        let fixPrompt: string
        const isMajorRework = taskType === 'major-rework'
        const templateName = isMajorRework ? 'rework-story' : 'fix-story'

        // Pre-compute fix-story maxTurns for major rework (Story 24-6, AC5)
        // Declared here so it's accessible at the dispatch call site below.
        let fixMaxTurns: number | undefined

        try {
          const fixTemplate = await pack.getPrompt(templateName)
          const storyContent = await readFile(storyFilePath ?? '', 'utf-8')

          // Compute complexity for turn limit scaling (major-rework: Story 24-6, minor-fix: fix-story enrichment)
          // Minor-fixes get half budget (min 15) to prevent churn; major-rework gets full budget
          {
            const complexity = computeStoryComplexity(storyContent)
            const fullBudget = resolveFixStoryMaxTurns(complexity.complexityScore)
            fixMaxTurns = taskType === 'minor-fixes'
              ? Math.max(15, Math.floor(fullBudget / 2))
              : fullBudget
            logComplexityResult(storyKey, complexity, fixMaxTurns)
          }

          // Format review feedback: verdict + serialized issue list
          // Guard against empty issue lists — provide fallback guidance
          let reviewFeedback: string
          if (issueList.length === 0) {
            reviewFeedback = isMajorRework
              ? [
                  `Verdict: ${verdict}`,
                  'Issues: The reviewer flagged fundamental issues but did not provide specifics.',
                  'Instructions: Re-read the story file carefully, re-implement from scratch addressing all acceptance criteria.',
                ].join('\n')
              : [
                  `Verdict: ${verdict}`,
                  'Issues: The reviewer flagged this as needing work but did not provide specific issues.',
                  'Instructions: Re-read the story file carefully, compare each acceptance criterion against the current implementation, and fix any gaps you find.',
                  'Focus on: unimplemented ACs, missing tests, incorrect behavior, and incomplete task checkboxes.',
                ].join('\n')
          } else {
            const issueHeader = isMajorRework
              ? 'Issues from previous review that MUST be addressed'
              : 'Issues'
            reviewFeedback = [
              `Verdict: ${verdict}`,
              `${issueHeader} (${issueList.length}):`,
              ...issueList.map((issue, i) => {
                const iss = issue as { severity?: string; description?: string; file?: string; line?: number }
                return `  ${i + 1}. [${iss.severity ?? 'unknown'}] ${iss.description ?? 'no description'}${iss.file ? ` (${iss.file}${iss.line ? `:${iss.line}` : ''})` : ''}`
              }),
            ].join('\n')
          }

          // Query arch constraints from decision store
          let archConstraints = ''
          try {
            const decisions = await getDecisionsByPhase(db, 'solutioning')
            const constraints = decisions.filter((d: Decision) => d.category === 'architecture')
            archConstraints = constraints.map((d: Decision) => `${d.key}: ${d.value}`).join('\n')
          } catch { /* arch constraints are optional */ }

          // Compute git diff of modified files for rework context
          let gitDiffContent = ''
          try {
            const diffFiles = checkGitDiffFiles(projectRoot ?? process.cwd())
            if (diffFiles.length > 0) {
              gitDiffContent = execSync(`git diff HEAD -- ${diffFiles.map((f) => `"${f}"`).join(' ')}`, {
                cwd: projectRoot ?? process.cwd(),
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['ignore', 'pipe', 'pipe'],
              }).trim()
            }
          } catch { /* graceful degradation — fall back to empty diff */ }

          // Query prior pipeline findings (escalation issues, recurring patterns)
          // for context injection into fix/rework prompts (Tier 3 item #7)
          let priorFindingsContent = ''
          try {
            const findings = await getProjectFindings(db)
            if (findings !== '') {
              priorFindingsContent = 'Prior pipeline findings — avoid repeating these patterns:\n\n' + findings
            }
          } catch { /* graceful fallback */ }

          // Build sections based on template type
          const sections = isMajorRework
            ? [
                { name: 'story_content', content: storyContent, priority: 'required' as const },
                { name: 'review_findings', content: reviewFeedback, priority: 'required' as const },
                { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
                { name: 'git_diff', content: gitDiffContent, priority: 'optional' as const },
                { name: 'prior_findings', content: priorFindingsContent, priority: 'optional' as const },
              ]
            : (() => {
                const targetedFilesContent = buildTargetedFilesContent(issueList)
                return [
                  { name: 'story_content', content: storyContent, priority: 'required' as const },
                  { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
                  { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
                  ...(targetedFilesContent ? [{ name: 'targeted_files', content: targetedFilesContent, priority: 'important' as const }] : []),
                  { name: 'prior_findings', content: priorFindingsContent, priority: 'optional' as const },
                ]
              })()
          const assembled = assemblePrompt(fixTemplate, sections, 24000)
          fixPrompt = assembled.prompt
        } catch {
          fixPrompt = `Fix story ${storyKey}: verdict=${verdict}, taskType=${taskType}`
          logger.warn({ storyKey, taskType }, 'Failed to assemble fix prompt, using fallback')
        }

        incrementDispatches(storyKey)
        // Major rework uses DevStoryResultSchema (full re-implementation output contract)
        const handle = isMajorRework
          ? dispatcher.dispatch({
              prompt: fixPrompt,
              agent: deps.agentId ?? 'claude-code',
              taskType,
              ...(fixModel !== undefined ? { model: fixModel } : {}),
              outputSchema: DevStoryResultSchema,
              ...(fixMaxTurns !== undefined ? { maxTurns: fixMaxTurns } : {}),
              ...(config.perStoryContextCeilings?.[storyKey] !== undefined
                ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
                : {}),
              ...(projectRoot !== undefined ? { workingDirectory: projectRoot } : {}),
              ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            })
          : dispatcher.dispatch<unknown>({
              prompt: fixPrompt,
              agent: deps.agentId ?? 'claude-code',
              taskType,
              ...(fixModel !== undefined ? { model: fixModel } : {}),
              ...(fixMaxTurns !== undefined ? { maxTurns: fixMaxTurns } : {}),
              ...(config.perStoryContextCeilings?.[storyKey] !== undefined
                ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
                : {}),
              ...(projectRoot !== undefined ? { workingDirectory: projectRoot } : {}),
              ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            })
        const fixResult = await handle.result
        endPhase(storyKey, 'fix')

        // Record fix dispatch telemetry
        eventBus.emit('orchestrator:story-phase-complete', {
          storyKey,
          phase: taskType === 'minor-fixes' ? 'IN_MINOR_FIX' : 'IN_MAJOR_FIX',
          result: {
            tokenUsage: fixResult.tokenEstimate
              ? { input: fixResult.tokenEstimate.input, output: fixResult.tokenEstimate.output }
              : undefined,
          },
        })

        if (fixResult.status === 'timeout') {
          logger.warn({ storyKey, taskType }, 'Fix dispatch timed out — escalating story')
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: `fix-dispatch-timeout (${taskType})`,
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
          await emitEscalation({
            storyKey,
            lastVerdict: verdict,
            reviewCycles: reviewCycles + 1,
            issues: issueList,
          })
          await persistState()
          return
        }

        if (fixResult.status === 'failed') {
          // Major rework failure is a strong escalation signal
          if (isMajorRework) {
            logger.warn({ storyKey, exitCode: fixResult.exitCode }, 'Major rework dispatch failed — escalating story')
            endPhase(storyKey, 'code-review')
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: 'major-rework-dispatch-failed',
              completedAt: new Date().toISOString(),
            })
            await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
            await emitEscalation({
              storyKey,
              lastVerdict: verdict,
              reviewCycles: reviewCycles + 1,
              issues: issueList,
            })
            await persistState()
            return
          }
          logger.warn({ storyKey, taskType, exitCode: fixResult.exitCode }, 'Fix dispatch failed')
        }
      } catch (err) {
        logger.warn({ storyKey, taskType, err }, 'Fix dispatch failed, continuing to next review')
      }

      // Save current issues for scoped re-review in next cycle
      previousIssueList = issueList.map((issue) => {
        const iss = issue as { severity?: string; description?: string; file?: string; line?: number }
        return { severity: iss.severity, description: iss.description, file: iss.file, line: iss.line }
      })

      reviewCycles++
    }
  }

  /**
   * Handle the cost ceiling being exceeded before dispatching a story (Story 53-3).
   *
   * Transitions all skipped stories to ESCALATED phase, emits the
   * cost:ceiling-reached NDJSON event, and sets _budgetExhausted so that
   * runWithConcurrency stops enqueuing new groups.
   *
   * @param triggeredStoryKey - The story that would have been dispatched next
   * @param remainingInGroup - Other stories in the same conflict group after triggeredStoryKey
   * @param result - The ceiling check result
   * @param manifest - The current run manifest data
   */
  async function handleCeilingExceeded(
    triggeredStoryKey: string,
    remainingInGroup: string[],
    result: CeilingCheckResult,
    manifest: RunManifestData,
  ): Promise<void> {
    const haltOn = (manifest.cli_flags.halt_on as string | undefined) ?? 'none'

    // Collect all skipped stories: triggeredStoryKey + remainingInGroup + all PENDING stories
    const allSkipped: string[] = [triggeredStoryKey, ...remainingInGroup]
    for (const [key, state] of _stories) {
      if (state.phase === 'PENDING' && !allSkipped.includes(key)) {
        allSkipped.push(key)
      }
    }

    // Transition each skipped story to ESCALATED
    for (const key of allSkipped) {
      updateStory(key, {
        phase: 'ESCALATED' as StoryPhase,
        error: 'cost-ceiling-reached',
        completedAt: new Date().toISOString(),
      })
      // Best-effort manifest update
      if (runManifest !== null && runManifest !== undefined) {
        runManifest
          .patchStoryState(key, { status: 'escalated' })
          .catch(() => { /* best-effort — ignore errors */ })
      }
    }

    // Emit cost:ceiling-reached event
    eventBus.emit('cost:ceiling-reached', {
      cumulative_cost: result.cumulative,
      ceiling: result.ceiling,
      halt_on: haltOn,
      action: 'stopped',
      skipped_stories: allSkipped,
      ...(haltOn !== 'none' ? { severity: 'critical' } : {}),
    })

    // Mark budget as exhausted so runWithConcurrency stops enqueuing
    _budgetExhausted = true

    logger.warn(
      { skipped: allSkipped.length, cumulative: result.cumulative, ceiling: result.ceiling },
      'Cost ceiling reached — stopping dispatch',
    )
  }

  /**
   * Process a conflict group: run stories sequentially within the group.
   *
   * After each story completes (any outcome), a GC hint is issued and a short
   * pause inserted so the Node.js process can reclaim memory before the next
   * story dispatch (Story 23-8, AC2).
   */
  async function processConflictGroup(group: string[]): Promise<void> {
    // Track completed story keys within this conflict group for directive injection (Story 30-6)
    const completedStoryKeys: string[] = []

    for (const storyKey of group) {
      // -- Cost ceiling check (Story 53-3): enforce between dispatches --
      if (runManifest !== null && runManifest !== undefined) {
        try {
          const manifestData = await runManifest.read()
          const ceiling = manifestData.cli_flags.cost_ceiling as number | undefined
          if (ceiling !== undefined && ceiling > 0) {
            const checkResult = _costChecker.checkCeiling(manifestData, ceiling)
            if (checkResult.status === 'warning' && !_costWarningEmitted) {
              _costWarningEmitted = true
              eventBus.emit('cost:warning', {
                cumulative_cost: checkResult.cumulative,
                ceiling: checkResult.ceiling,
                percent_used: checkResult.percentUsed,
              })
            }
            if (checkResult.status === 'exceeded') {
              const remainingInGroup = group.slice(group.indexOf(storyKey) + 1)
              await handleCeilingExceeded(storyKey, remainingInGroup, checkResult, manifestData)
              return // stop processing remaining stories in this group
            }
          }
        } catch (err) {
          logger.debug({ err }, 'Cost ceiling check failed — proceeding without enforcement')
        }
      }

      // Query optimization directives from prior completed stories (Story 30-6)
      let optimizationDirectives: string | undefined
      if (telemetryAdvisor !== undefined && completedStoryKeys.length > 0) {
        try {
          const recs = await telemetryAdvisor.getRecommendationsForRun(completedStoryKeys)
          const directives = telemetryAdvisor.formatOptimizationDirectives(recs)
          if (directives.length > 0) {
            optimizationDirectives = directives
            logger.debug(
              { storyKey, directiveCount: recs.filter((r) => r.severity !== 'info').length },
              'Optimization directives ready for dispatch',
            )
          }
        } catch (err) {
          logger.debug({ err, storyKey }, 'Failed to fetch optimization directives — proceeding without')
        }
      }

      await processStory(storyKey, { optimizationDirectives })
      completedStoryKeys.push(storyKey)
      // GC hint between stories — best-effort, no error handling needed [AC2]
      ;(globalThis as { gc?: () => void }).gc?.()
      const gcPauseMs = config.gcPauseMs ?? 2_000
      await sleep(gcPauseMs)
    }
  }

  /**
   * Promise pool: run up to maxConcurrency groups at a time.
   *
   * Each promise self-removes from `running` upon settlement so that
   * Promise.race() always races only the truly in-flight promises and the
   * concurrency limit is accurately maintained.
   */
  async function runWithConcurrency(groups: string[][], maxConcurrency: number): Promise<void> {
    const queue = [...groups]
    const running = new Set<Promise<void>>()

    function enqueue(): void {
      if (_budgetExhausted) return  // budget ceiling reached — no new dispatches
      const group = queue.shift()
      if (group === undefined) return

      const p: Promise<void> = processConflictGroup(group).finally(() => {
        running.delete(p)
        // Immediately fill open concurrency slots when a story completes.
        // This callback-based approach avoids Promise.race timing issues
        // where .finally() mutations to the running set were invisible to
        // the awaiting code.
        while (running.size < maxConcurrency && queue.length > 0) {
          enqueue()
        }
      })
      running.add(p)
      // Track peak actual concurrency
      if (running.size > _maxConcurrentActual) {
        _maxConcurrentActual = running.size
      }
    }

    // Seed up to maxConcurrency concurrent tasks
    const initial = Math.min(maxConcurrency, queue.length)
    for (let i = 0; i < initial; i++) {
      enqueue()
    }

    // Wait for all promises to settle (enqueue chains via .finally callbacks)
    while (running.size > 0) {
      await Promise.race(running)
    }
  }

  // -- public interface --

  async function run(storyKeys: string[]): Promise<OrchestratorStatus> {
    if (_state === 'RUNNING' || _state === 'PAUSED') {
      logger.warn({ state: _state }, 'run() called while orchestrator is already running or paused — ignoring')
      return getStatus()
    }
    if (_state === 'COMPLETE') {
      logger.warn({ state: _state }, 'run() called on a COMPLETE orchestrator — ignoring')
      return getStatus()
    }

    _state = 'RUNNING'
    _startedAt = new Date().toISOString()

    // Initialize story states (in-memory only — persistence deferred until after stateStore.initialize()).
    // Issue 3: calling persistStoryState() before initialize() causes DoltStateStore writes to fail
    // silently because the MySQL connection is not yet open at this point.
    for (const key of storyKeys) {
      const pendingState: StoryState = {
        phase: 'PENDING',
        reviewCycles: 0,
      }
      _stories.set(key, pendingState)
    }

    eventBus.emit('orchestrator:started', {
      storyKeys,
      pipelineRunId: config.pipelineRunId,
    })
    await persistState()
    recordProgress()
    // Only start heartbeat/watchdog when --events mode is active (AC1, Issue 5)
    if (config.enableHeartbeat) {
      startHeartbeat()
    }

    // Seed methodology context from planning artifacts (idempotent)
    const _startupTimings: Record<string, number> = {}
    if (projectRoot !== undefined) {
      const seedStart = Date.now()
      const seedResult = await seedMethodologyContext(db, projectRoot)
      _startupTimings.seedMethodologyMs = Date.now() - seedStart
      if (seedResult.decisionsCreated > 0) {
        logger.info(
          { decisionsCreated: seedResult.decisionsCreated, skippedCategories: seedResult.skippedCategories, durationMs: _startupTimings.seedMethodologyMs },
          'Methodology context seeded from planning artifacts',
        )
      }
    }

    // Auto-ingest stories and dependencies from the consolidated epics document
    // into the work graph, so that ready_stories (Level 1.5) respects inter-story
    // dependencies during auto-discovery. Idempotent — safe to call on every run.
    if (projectRoot !== undefined) {
      const ingestStart = Date.now()
      try {
        const ingestResult = await autoIngestEpicsDependencies(db, projectRoot)
        if (ingestResult.storiesIngested > 0 || ingestResult.dependenciesIngested > 0) {
          logger.info(
            { ...ingestResult, durationMs: Date.now() - ingestStart },
            'Auto-ingested stories and dependencies from epics document',
          )
        }
      } catch (err) {
        logger.debug({ err }, 'Auto-ingest from epics document skipped — work graph may be unavailable')
      }
    }

    // Pre-flight build gate (Story 25-2): verify project builds before dispatching any story.
    // Reuses runBuildVerification() from Story 24-2. Respects verifyCommand config (AC3) and
    // auto-detects the package manager (AC4). Skip when skipPreflight=true (AC5).
    try {
      // Initialize StateStore (Story 26-4, AC7): open connections before any dispatch.
      // Inside try/finally so stateStore.close() is always called if initialize() throws.
      if (stateStore !== undefined) {
        const stateStoreInitStart = Date.now()
        await stateStore.initialize()
        _startupTimings.stateStoreInitMs = Date.now() - stateStoreInitStart
        // Now that the connection is open, persist PENDING states that were deferred above.
        for (const key of storyKeys) {
          const pendingState = _stories.get(key)
          if (pendingState !== undefined) {
            persistStoryState(key, pendingState).catch((err) =>
              logger.warn({ err, storyKey: key }, 'StateStore write failed during PENDING init'),
            )
          }
        }
        // Populate cache from StateStore for resume-from-prior-run scenarios (AC3).
        try {
          const queryStoriesStart = Date.now()
          const existingRecords = await stateStore.queryStories({})
          _startupTimings.queryStoriesMs = Date.now() - queryStoriesStart
          for (const record of existingRecords) {
            _stateStoreCache.set(record.storyKey, record)
          }
        } catch (err) {
          logger.warn({ err }, 'StateStore.queryStories() failed during init — status merge will be empty (best-effort)')
        }
      }

      // Story 27-9: Start OTLP ingestion server before first dispatch.
      // The server captures telemetry from Claude Code sub-agents.
      // Story 27-12: Wire TelemetryPipeline to IngestionServer when telemetryPersistence is available.
      if (ingestionServer !== undefined) {
        // Wire the full analysis pipeline when persistence is available (Story 27-12)
        if (telemetryPersistence !== undefined) {
          try {
            const pipelineLogger = logger
            const telemetryPipeline = new TelemetryPipeline({
              normalizer: new TelemetryNormalizer(pipelineLogger),
              turnAnalyzer: new TurnAnalyzer(pipelineLogger),
              logTurnAnalyzer: new LogTurnAnalyzer(pipelineLogger),
              categorizer: new Categorizer(pipelineLogger),
              consumerAnalyzer: new ConsumerAnalyzer(new Categorizer(pipelineLogger), pipelineLogger),
              efficiencyScorer: new EfficiencyScorer(pipelineLogger),
              recommender: new Recommender(pipelineLogger),
              persistence: telemetryPersistence,
            })
            ingestionServer.setPipeline(telemetryPipeline)
            logger.info('TelemetryPipeline wired to IngestionServer')
          } catch (pipelineErr) {
            logger.warn({ err: pipelineErr }, 'Failed to create TelemetryPipeline — continuing without analysis pipeline')
          }
        }
        await ingestionServer.start().catch((err: unknown) =>
          logger.warn({ err }, 'IngestionServer.start() failed — continuing without telemetry (best-effort)'),
        )
        try {
          _otlpEndpoint = ingestionServer.getOtlpEnvVars().OTEL_EXPORTER_OTLP_ENDPOINT
          logger.info({ otlpEndpoint: _otlpEndpoint }, 'OTLP telemetry ingestion active')
        } catch {
          // Server may not have started — endpoint remains undefined
        }
      }

      // Story 26-6: Query interface-contract declarations via StateStore (if available),
      // falling back to the decision store (Story 25-5 path) for backwards compatibility.
      // These are populated during create-story for prior runs. On a fresh run
      // there may be no declarations yet — the function gracefully falls back to
      // a single batch (original behavior).
      // NOTE: This block is intentionally inside the try/finally, after stateStore.initialize(),
      // so that queryContracts() is only called after the DB connection is open (DoltStateStore
      // requires an open MySQL connection; calling before initialize() would throw outside the
      // finally block and prevent stateStore.close() from running).
      let contractDeclarations: ContractDeclaration[] = []

      if (stateStore !== undefined) {
        const queryContractsStart = Date.now()
        const allContractRecords = await stateStore.queryContracts()
        _startupTimings.queryContractsMs = Date.now() - queryContractsStart
        contractDeclarations = allContractRecords.map((r) => ({
          storyKey: r.storyKey,
          contractName: r.contractName,
          direction: r.direction,
          filePath: r.schemaPath,
          ...(r.transport !== undefined ? { transport: r.transport } : {}),
        }))
      } else {
        // Fallback: use decision store when StateStore is not available.
        const interfaceContractDecisions = await getDecisionsByCategory(db, 'interface-contract')
        contractDeclarations = interfaceContractDecisions
          .map((d) => {
            try {
              const parsed = JSON.parse(d.value) as Record<string, unknown>
              const storyKey = typeof parsed.storyKey === 'string' ? parsed.storyKey : ''
              // Story 25-4 stores the name as 'schemaName' in the DB value
              const contractName = typeof parsed.schemaName === 'string' ? parsed.schemaName : ''
              const direction = parsed.direction === 'export' ? 'export' : 'import'
              const filePath = typeof parsed.filePath === 'string' ? parsed.filePath : ''
              if (!storyKey || !contractName) return null
              return {
                storyKey,
                contractName,
                direction,
                filePath,
                ...(typeof parsed.transport === 'string' ? { transport: parsed.transport } : {}),
              } satisfies ContractDeclaration
            } catch {
              return null
            }
          })
          .filter((d): d is ContractDeclaration => d !== null)
      }

      // Detect conflict groups with contract-aware dispatch ordering (Story 25-5).
      // Cross-project runs (no conflictGroups in pack) get maximum parallelism within each batch.
      const conflictDetectStart = Date.now()
      const { batches, edges: contractEdges } = detectConflictGroupsWithContracts(
        storyKeys,
        { moduleMap: pack.manifest.conflictGroups },
        contractDeclarations,
      )
      _startupTimings.conflictDetectMs = Date.now() - conflictDetectStart

      // AC5: Log contract dependency edges as structured events for observability
      if (contractEdges.length > 0) {
        logger.info(
          { contractEdges, edgeCount: contractEdges.length },
          'Contract dependency edges detected — applying contract-aware dispatch ordering',
        )
      }

      // Story 31-6: Persist contract dep edges to story_dependencies (fire-and-forget, non-fatal).
      wgRepo.addContractDependencies(contractEdges).catch((err: unknown) =>
        logger.warn({ err }, 'contract dep persistence failed (best-effort)')
      )

      logger.info({
        storyCount: storyKeys.length,
        groupCount: batches.reduce((sum, b) => sum + b.length, 0),
        batchCount: batches.length,
        maxConcurrency: config.maxConcurrency,
        batchStructure: batches.map((batch, i) => ({
          batch: i,
          groups: batch.map((g) => g.join(',')),
        })),
      }, 'Orchestrator starting')

      logger.info(
        { storyCount: storyKeys.length, conflictGroups: batches.length, maxConcurrency: config.maxConcurrency },
        `Story dispatch plan: ${storyKeys.length} stories in ${batches.reduce((s, b) => s + b.length, 0)} groups across ${batches.length} batches (max concurrency: ${config.maxConcurrency})`,
      )

      if (config.skipPreflight !== true) {
        const preflightStart = Date.now()
        const preFlightResult = runBuildVerification({
          verifyCommand: pack.manifest.verifyCommand,
          verifyTimeoutMs: pack.manifest.verifyTimeoutMs,
          projectRoot: projectRoot ?? process.cwd(),
        })
        _startupTimings.preflightMs = Date.now() - preflightStart

        if (preFlightResult.status === 'failed' || preFlightResult.status === 'timeout') {
          stopHeartbeat()
          const truncatedOutput = (preFlightResult.output ?? '').slice(0, 2000)
          const exitCode = preFlightResult.exitCode ?? 1

          eventBus.emit('pipeline:pre-flight-failure', {
            exitCode,
            output: truncatedOutput,
          })

          logger.error(
            { exitCode, reason: preFlightResult.reason },
            'Pre-flight build check failed — aborting pipeline before any story dispatch',
          )

          _state = 'FAILED'
          _completedAt = new Date().toISOString()
          await persistState()
          return getStatus()
        }

        if (preFlightResult.status !== 'skipped') {
          logger.info('Pre-flight build check passed')
        }
      }

      // Log startup timing breakdown for latency profiling (Fix 5)
      logger.info(_startupTimings, 'Orchestrator startup timings (ms)')

      // Package snapshot for concurrent-story node_modules protection.
      // When concurrency > 1, snapshot all package.json/lockfiles before dispatching
      // so we can restore if a story pollutes node_modules with bad transitive deps.
      const totalGroups = batches.reduce((sum, b) => sum + b.length, 0)
      const actualConcurrency = Math.min(config.maxConcurrency, totalGroups)
      if (actualConcurrency > 1 && projectRoot !== undefined) {
        try {
          _packageSnapshot = capturePackageSnapshot({ projectRoot })
          logger.info(
            { fileCount: _packageSnapshot.files.size, installCommand: _packageSnapshot.installCommand },
            'Package snapshot captured for concurrent story protection',
          )
        } catch (snapErr) {
          logger.warn({ err: snapErr }, 'Failed to capture package snapshot — continuing without protection')
        }
      }

      try {
        // Story 25-5: Run batches sequentially (contract ordering), groups within each batch in parallel.
        // When no contract dependencies exist, batches has a single element (original behavior).
        for (const batchGroups of batches) {
          await runWithConcurrency(batchGroups, config.maxConcurrency)
        }
      } catch (err) {
        stopHeartbeat()
        _state = 'FAILED'
        _completedAt = new Date().toISOString()
        await persistState()
        logger.error({ err }, 'Orchestrator failed with unhandled error')
        return getStatus()
      }

      stopHeartbeat()
      _state = 'COMPLETE'
      _completedAt = new Date().toISOString()

      // Story 25-6: Post-sprint contract verification pass.
      // Runs after all stories reach terminal state, before emitting orchestrator:complete.
      // Only verify contracts declared by stories in the current sprint to avoid
      // false positives from stale declarations in previous epics.
      if (projectRoot !== undefined && contractDeclarations.length > 0) {
        try {
          const totalDeclarations = contractDeclarations.length
          const currentSprintDeclarations = contractDeclarations.filter(
            (d) => storyKeys.includes(d.storyKey),
          )
          const stalePruned = totalDeclarations - currentSprintDeclarations.length

          if (stalePruned > 0) {
            logger.info(
              { stalePruned, remaining: currentSprintDeclarations.length },
              'Pruned stale contract declarations from previous epics',
            )
          }

          let mismatches: ContractMismatch[] = []
          if (currentSprintDeclarations.length > 0) {
            mismatches = verifyContracts(currentSprintDeclarations, projectRoot)
          }

          if (mismatches.length > 0) {
            _contractMismatches = mismatches
            for (const mismatch of mismatches) {
              eventBus.emit('pipeline:contract-mismatch', {
                exporter: mismatch.exporter,
                importer: mismatch.importer,
                contractName: mismatch.contractName,
                mismatchDescription: mismatch.mismatchDescription,
              })
            }
            logger.warn(
              { mismatchCount: mismatches.length, mismatches },
              'Post-sprint contract verification found mismatches — manual review required',
            )
          } else if (currentSprintDeclarations.length > 0) {
            logger.info('Post-sprint contract verification passed — all declared contracts satisfied')
          }

          // Emit consolidated summary event
          eventBus.emit('pipeline:contract-verification-summary', {
            verified: currentSprintDeclarations.length,
            stalePruned,
            mismatches: mismatches.length,
            verdict: mismatches.length === 0 ? 'pass' : 'fail',
          })

          // Story 26-6: Persist verification results to StateStore (current sprint only).
          if (stateStore !== undefined) {
            try {
              const currentSprintContracts = (await stateStore.queryContracts()).filter(
                (cr) => storyKeys.includes(cr.storyKey),
              )
              const verifiedAt = new Date().toISOString()

              // Group by story key
              const contractsByStory = new Map<string, typeof currentSprintContracts>()
              for (const cr of currentSprintContracts) {
                const existing = contractsByStory.get(cr.storyKey) ?? []
                existing.push(cr)
                contractsByStory.set(cr.storyKey, existing)
              }

              // Persist verification results per story
              for (const [sk, contracts] of contractsByStory) {
                const records: ContractVerificationRecord[] = contracts.map((cr) => {
                  const contractMismatches = (_contractMismatches ?? []).filter(
                    (m) => (m.exporter === sk || m.importer === sk) && m.contractName === cr.contractName,
                  )
                  if (contractMismatches.length > 0) {
                    return {
                      storyKey: sk,
                      contractName: cr.contractName,
                      verdict: 'fail' as const,
                      mismatchDescription: contractMismatches[0].mismatchDescription,
                      verifiedAt,
                    }
                  }
                  return {
                    storyKey: sk,
                    contractName: cr.contractName,
                    verdict: 'pass' as const,
                    verifiedAt,
                  }
                })
                await stateStore.setContractVerification(sk, records)
              }
              logger.info(
                { storyCount: contractsByStory.size },
                'Contract verification results persisted to StateStore',
              )
            } catch (persistErr) {
              logger.warn({ err: persistErr }, 'Failed to persist contract verification results to StateStore')
            }
          }
        } catch (err) {
          logger.error({ err }, 'Post-sprint contract verification threw an error — skipping')
        }
      }

      // Post-run project profile staleness check.
      // Detect if .substrate/project-profile.yaml is out of sync with the actual
      // project structure (e.g., stories created a monorepo or added new languages).
      if (projectRoot !== undefined) {
        try {
          const indicators = checkProfileStaleness(projectRoot)
          if (indicators.length > 0) {
            const message = 'Project profile may be outdated — consider running `substrate init --force` to re-detect'
            eventBus.emit('pipeline:profile-stale', { message, indicators })
            logger.warn({ indicators }, message)
          }
        } catch (err) {
          logger.debug({ err }, 'Profile staleness check failed (best-effort)')
        }
      }

      // Tally results
      let completed = 0
      let escalated = 0
      let failed = 0
      for (const s of _stories.values()) {
        if (s.phase === 'COMPLETE') completed++
        else if (s.phase === 'ESCALATED') {
          if (s.error !== undefined) failed++
          else escalated++
        } else if (s.phase === 'VERIFICATION_FAILED') {
          // VERIFICATION_FAILED counts as a failure (not a success) per AC3
          failed++
        }
      }

      eventBus.emit('orchestrator:complete', {
        totalStories: storyKeys.length,
        completed,
        escalated,
        failed,
      })
      await persistState()

      return getStatus()
    } finally {
      // Story 26-4, AC7: Close StateStore connection in all exit paths (best-effort).
      if (stateStore !== undefined) {
        await stateStore.close().catch((err) =>
          logger.warn({ err }, 'StateStore.close() failed (best-effort)'),
        )
      }
      // Story 27-9: Stop OTLP ingestion server in all exit paths (best-effort).
      if (ingestionServer !== undefined) {
        await ingestionServer.stop().catch((err: unknown) =>
          logger.warn({ err }, 'IngestionServer.stop() failed (best-effort)'),
        )
      }
    }
  }

  function pause(): void {
    if (_state !== 'RUNNING') return
    _paused = true
    _pauseGate = createPauseGate()
    _state = 'PAUSED'
    eventBus.emit('orchestrator:paused', {})
    logger.info('Orchestrator paused')
  }

  function resume(): void {
    if (_state !== 'PAUSED') return
    _paused = false
    if (_pauseGate !== null) {
      _pauseGate.resolve()
      _pauseGate = null
    }
    _state = 'RUNNING'
    eventBus.emit('orchestrator:resumed', {})
    logger.info('Orchestrator resumed')
  }

  return {
    run,
    pause,
    resume,
    getStatus,
  }
}
