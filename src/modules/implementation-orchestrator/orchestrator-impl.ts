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
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, basename, dirname, relative, isAbsolute, resolve } from 'node:path'
import yaml from 'js-yaml'
import { updatePipelineRun, getDecisionsByPhase, getDecisionsByCategory, registerArtifact, createDecision } from '../../persistence/queries/decisions.js'
import type { Decision } from '../../persistence/queries/decisions.js'
import { writeStoryMetrics, aggregateTokenUsageForStory } from '../../persistence/queries/metrics.js'
import { STORY_METRICS, ESCALATION_DIAGNOSIS, STORY_OUTCOME, TEST_EXPANSION_FINDING, ADVISORY_NOTES } from '../../persistence/schemas/operational.js'
import { generateEscalationDiagnosis } from './escalation-diagnosis.js'
import { getProjectFindings } from './project-findings.js'
import { assemblePrompt } from '../compiled-workflows/prompt-assembler.js'
import { DevStoryResultSchema } from '../compiled-workflows/schemas.js'
import { runCreateStory, isValidStoryFile, extractStorySection, hashSourceAcSection, extractNamedPathsFromSource, computeStoryFileFidelity, computeClauseFidelity } from '../compiled-workflows/create-story.js'
import { runDevStory } from '../compiled-workflows/dev-story.js'
import { runCodeReview } from '../compiled-workflows/code-review.js'
import { createMergeQueue } from '../compiled-workflows/merge-to-main.js'
import { commitDevStoryOutput, checkpointStoryWorktree, getGitChangedFiles } from '../compiled-workflows/git-helpers.js'
import { runTestPlan } from '../compiled-workflows/test-plan.js'
import { runProbeAuthor } from './probe-author-integration.js'
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
import { runBuildVerification, checkGitDiffFiles, checkGitModifiedTrackedFiles } from '../agent-dispatch/dispatcher-impl.js'
import { detectInterfaceChanges } from '../agent-dispatch/interface-change-detector.js'
import { computeStoryComplexity, resolveFixStoryMaxTurns, resolveDevStoryMaxTurns, logComplexityResult } from '../compiled-workflows/story-complexity.js'
import { parseInterfaceContracts } from '../compiled-workflows/interface-contracts.js'
import { verifyContracts } from './contract-verifier.js'
import type { ContractMismatch } from './types.js'
import type { WgStoryStatus } from '../state/index.js'
import { WorkGraphRepository } from '../state/index.js'
import type { ITelemetryPersistence } from '../telemetry/index.js'
import { EfficiencyScorer, Categorizer, ConsumerAnalyzer, TelemetryNormalizer, TurnAnalyzer, LogTurnAnalyzer, Recommender } from '../telemetry/index.js'
import type { IngestionServer } from '../telemetry/ingestion-server.js'
import { TelemetryPipeline } from '../telemetry/telemetry-pipeline.js'
import { createTelemetryAdvisor } from '../telemetry/telemetry-advisor.js'
import type { TelemetryAdvisor } from '../telemetry/telemetry-advisor.js'
import type { RepoMapInjector } from '../context-compiler/index.js'
import type { SdlcEvents } from '@substrate-ai/sdlc'
import { createDefaultVerificationPipeline, detectsEventDrivenAC, detectsStateIntegratingAC, runStaleVerificationRecovery, parseRuntimeProbes, parseStoryFrontmatter, loadJourneyRegistryFromTrustedTree, loadJourneyDeferralsFromTrustedTree, loadAcceptanceContractFromTrustedTree, JOURNEY_DEFERRALS_PATH, ACCEPTANCE_CONTRACT_PROFILE_PATH, computeJourneyCoverage, summarizeCoverage, renderSurface, renderVerdictHtml } from '@substrate-ai/sdlc'
import type { JourneyRegistry, JourneyClaim, JourneyCoverageEntry, JourneyVerdictInput } from '@substrate-ai/sdlc'
import { runAcceptanceJudge } from '../compiled-workflows/acceptance-judge.js'
import type { AcceptanceJudgeVerdict } from '../compiled-workflows/schemas.js'
import type { ReviewSignals, DevStorySignals, BatchEntry } from '@substrate-ai/sdlc'
import type { RunManifest, PerStoryStatus, PerStoryState, ProbeAuthorTriggerClass } from '@substrate-ai/sdlc'
import type { TypedEventBus as GenericTypedEventBus, CoreEvents } from '@substrate-ai/core'
import { createGitWorktreeManager, swallowDebug, BRANCH_PREFIX, detectCodexSandboxBlock, CODEX_SANDBOX_BLOCK_HINT, detectClaudeAuthFailure, CLAUDE_AUTH_FAILURE_HINT } from '@substrate-ai/core'
import {
  assembleVerificationContext,
  VerificationStore,
  persistVerificationResult,
  persistDevStorySignals,
  renderVerificationFindingsForPrompt,
} from './verification-integration.js'
import type { OrchestratorEvents } from '../../core/event-bus.types.js'
import { CostGovernanceChecker } from './cost-governance.js'
import type { CeilingCheckResult } from './cost-governance.js'
import type { RunManifestData } from '@substrate-ai/sdlc'
import { routeDecision } from '../decision-router/index.js'
import { runInteractivePrompt } from '../interactive-prompt/index.js'
import { runRecoveryEngine } from '../recovery-engine/index.js'
import { aggregateStoryDispatchTelemetry } from './dispatch-telemetry-aggregation.js'

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

/**
 * Project the monolith event bus to `TypedEventBus<CoreEvents>` for GitWorktreeManager.
 *
 * Story 75-1 (Path E spike 2026-05-10): OrchestratorEvents mirrors the CoreEvents worktree
 * events ('worktree:created', 'worktree:removed') so the cast is safe at runtime.
 * TypeScript cannot perform the direct cast due to generic method signatures; the
 * `as unknown` intermediate is isolated here to keep call sites clean.
 */
function toCoreEventBus(bus: TypedEventBus): GenericTypedEventBus<CoreEvents> {
  return bus as unknown as GenericTypedEventBus<CoreEvents>
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
  /**
   * Optional git worktree manager for merge-to-main cleanup after SHIP_IT (Story 75-2).
   * When provided, the orchestrator calls cleanupWorktree(storyKey) after a successful
   * merge. When absent, worktree cleanup and the merge-to-main phase are skipped.
   * Injected from Story 75-1 (worktree creation).
   */
  worktreeManager?: import('@substrate-ai/core').GitWorktreeManager
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
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w)),
  )
}

/**
 * Sanitize a create-story-emitted story title before it is used to compose the
 * dev-story auto-commit subject (`feat(story-N-M): <title>`).
 *
 * F-commitmsg (2026-05-26, run 376a3930 / story 78-1): create-story's structured
 * `story_title` can absorb stray stdout — a story whose domain is `substrate report`
 * bled the report banner (rows of `═` box-drawing characters + "Run: …/Verdict: …"
 * text) into the title, producing a multi-line, box-drawing-filled commit subject.
 * A commit subject must be a single clean line, so:
 *   - reject outright (→ undefined) any title containing box-drawing/block glyphs
 *     (U+2500–U+259F) — that is unambiguous stdout contamination, not a real title;
 *   - otherwise take the first non-empty line, strip control chars, collapse
 *     whitespace, and cap the length.
 * Returning undefined makes commitDevStoryOutput fall back to its safe default
 * ("implementation"), yielding `feat(story-N-M): implementation` rather than a
 * mangled subject. Exported for unit testing.
 */
export function sanitizeStoryTitle(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Box-drawing / block glyphs (U+2500-U+259F) appear only via banner/table stdout
  // contamination (run 376a3930 / story 78-1) - never in a real title. Reject outright.
  if (/[\u2500-\u259F]/.test(raw)) return undefined
  // First non-empty line, then strip control chars (code < 0x20 or DEL) via char-code
  // filtering - avoids embedding control bytes / fragile escapes in this source file.
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const cleaned = Array.from(firstLine)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return undefined
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned
}

/**
 * obs_2026-05-27_032: render an escalation's `issues[]` into a single durable
 * detail string for `per_story_state.escalation_detail`. Issues are strings
 * (e.g. build-failure output) or finding objects (`{severity?, file?, description?}`).
 * Capped to keep the manifest lean. Returns undefined for an empty/absent list.
 * Exported for unit testing.
 */
export function summarizeEscalationIssues(issues: unknown[], cap = 4000): string | undefined {
  if (!Array.isArray(issues) || issues.length === 0) return undefined
  const parts = issues.map((issue) => {
    if (typeof issue === 'string') return issue
    if (issue !== null && typeof issue === 'object') {
      const i = issue as { severity?: string; file?: string; description?: string }
      if (typeof i.description === 'string') {
        return [i.severity, i.file, i.description].filter((p) => typeof p === 'string' && p.length > 0).join(' ')
      }
      return JSON.stringify(issue)
    }
    return String(issue)
  })
  const joined = parts.join('\n').trim()
  if (joined.length === 0) return undefined
  return joined.length > cap ? `${joined.slice(0, cap - 1)}…` : joined
}

/**
 * obs_2026-05-26_028: detect whether a dev-story's output landed in the MAIN
 * checkout instead of its per-story worktree (a cwd misroute). Returns the
 * uncommitted files in the main checkout when running in worktree mode (the
 * main tree should be clean during a worktree dispatch), else an empty list.
 * Used to enrich the zero-diff escalation with an actionable cause rather than
 * the opaque verdict. Best-effort: a probe failure yields an empty list (never
 * blocks escalation). Exported for unit testing.
 */
/**
 * H1.4 (hardening program, field finding #13): classify a story's ground-truth
 * git diff into implementation vs. pipeline-artifact changes.
 *
 * The field failure: story 2-3 returned status=complete with "239 tests pass"
 * while its branch contained ONLY the create-story spec file — zero source,
 * zero tests (the 239 were the pre-existing suite; true but vacuous). The
 * zero-diff gate never fired because the spec .md IS a diff entry.
 *
 * A file counts as implementation when it lives outside substrate's own
 * artifact trees (`_bmad-output/`, `.substrate/`). Story specs, planning
 * artifacts, and manifest state are pipeline bookkeeping — a "successful"
 * dev pass whose diff is bookkeeping-only produced no implementation.
 *
 * Pure + exported for unit testing.
 */
export function classifyImplementationDiff(files: readonly string[]): {
  hasImplementation: boolean
  artifactOnly: string[]
} {
  const isArtifact = (f: string): boolean => {
    const norm = f.replace(/\\/g, '/').replace(/^\.\//, '')
    return norm.startsWith('_bmad-output/') || norm.startsWith('.substrate/')
  }
  const artifactOnly = files.filter(isArtifact)
  const hasImplementation = files.some((f) => !isArtifact(f))
  return { hasImplementation, artifactOnly }
}

export function detectWorkOutsideWorktree(
  effectiveProjectRoot: string | undefined,
  projectRoot: string | undefined,
  checkDiff: (root: string) => string[],
): string[] {
  const inWorktreeMode =
    effectiveProjectRoot !== undefined && projectRoot !== undefined && effectiveProjectRoot !== projectRoot
  if (!inWorktreeMode) return []
  try {
    return checkDiff(projectRoot)
  } catch {
    return []
  }
}

/**
 * obs_2026-05-26_027: capture the reconstruction phase-input. Reads the story
 * file the producing phase consumed, copies it to a durable sidecar under the
 * run manifest's directory (`inputs/<run-id>/<story-key>.md`), and returns the
 * per_story_state patch fields (path + sidecar-relative location + SHA-256).
 *
 * Called at auto-commit time — the last point where `storyFilePath` still
 * resolves before the per-story worktree is torn down — so the input survives
 * for the Story 77-8 harness even when the consumer repo does not git-track its
 * story artifacts (the strata-5-2 gap obs_027 documents). Throws if the story
 * file cannot be read; the caller treats capture as best-effort and continues.
 * Exported for unit testing (the orchestrator call site is deep in the
 * worktree/merge path).
 */
export function captureReconstructionInput(
  storyFilePath: string,
  storyKey: string,
  runManifestBaseDir: string,
  runId: string,
  effectiveProjectRoot: string | undefined,
): { story_file: string; story_file_input_path: string; story_file_sha256: string } {
  const inputContent = readFileSync(storyFilePath, 'utf-8')
  const relInputPath = join('inputs', runId, `${storyKey}.md`)
  const absInputPath = join(runManifestBaseDir, relInputPath)
  mkdirSync(dirname(absInputPath), { recursive: true })
  writeFileSync(absInputPath, inputContent)
  const root = effectiveProjectRoot ?? ''
  const story_file =
    root.length > 0 && storyFilePath.startsWith(root)
      ? storyFilePath.slice(root.length).replace(/^[/\\]+/, '')
      : basename(storyFilePath)
  return {
    story_file,
    story_file_input_path: relInputPath,
    story_file_sha256: createHash('sha256').update(inputContent).digest('hex'),
  }
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
import { parseEpicsDependencies, findEpicsFile, findEpicFileForStory } from './story-discovery.js'

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

// Story 59-3: pre-dev source-AC fidelity gate constants.
// FIDELITY_DRIFT_THRESHOLD: fraction of source-AC named paths that may be
// absent from the create-story output before drift is declared. Set at 0.5
// (50%) — minor stylistic differences (one or two paths shortened to
// basename without prose mention) still pass; substantial substitution
// (Run 9: 8/10 named paths missing — 80% drift) fires. Calibrated against
// strata 1-9 Run 9 captured drift artifact.
const FIDELITY_DRIFT_THRESHOLD = 0.5

// Minimum number of named paths in source AC to enable the fidelity gate.
// Stories with fewer paths (e.g., pure prose specs, type-only refactors)
// have insufficient signal — gate is skipped to avoid false-positives.
const MIN_NAMED_PATHS_FOR_FIDELITY_GATE = 3

// Maximum retries when fidelity gate fires drift. Each retry renames the
// drifted artifact to .stale-<ts> and re-dispatches create-story. After
// MAX_FIDELITY_RETRIES, the story escalates with create-story-source-ac-drift.
const MAX_FIDELITY_RETRIES = 2

// v0.20.114 (F-timeout): the dev-story checkpoint-RETRY resumes partial work
// already on disk, so it gets a LONGER window than the first attempt. The first
// dev-story dispatch keeps the default ~30-min timeout as a fast stuck-detector;
// the retry gets 45 min (1.5×) to RESUME and finish. Before this, the retry
// reused the same 30-min timeout, so a large story needing >30 min net hit the
// same wall twice and escalated as `checkpoint-retry-timeout` though work was
// progressing — this cost two full 77-1 dispatches during eval-framework
// dogfooding (2026-05). Note: this is an absolute floor, independent of any
// `dispatch_timeouts.dev-story` config override (which still scales the first
// attempt); a project that configures a base > 45 min should also raise this.
const CHECKPOINT_RETRY_TIMEOUT_MS = 2_700_000

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
  const { db, pack, contextCompiler, dispatcher, eventBus, config, projectRoot, tokenCeilings, telemetryPersistence, ingestionServer, repoMapInjector, maxRepoMapTokens, agentId, runManifest = null, worktreeManager } = deps

  // ---------------------------------------------------------------------------
  // Story 75-1 (Path E spike 2026-05-10): per-story worktree isolation.
  // ~14 dispatch sites within processStory() previously passed bare projectRoot.
  // _worktreeManager is the canonical instance — created here if not injected via
  // deps (injection is reserved for tests and the merge-to-main phase in Story 75-2).
  // noWorktree is drawn from config.noWorktree (set via --no-worktree CLI flag, Story 75-3).
  // ---------------------------------------------------------------------------
  const noWorktree = config.noWorktree ?? false
  const _worktreeManager: import('@substrate-ai/core').GitWorktreeManager | undefined =
    worktreeManager ??
    (projectRoot !== undefined && !noWorktree
      ? createGitWorktreeManager({
          eventBus: toCoreEventBus(eventBus),
          projectRoot,
          // v0.20.109: thread `worktree.copy_files` config through so gitignored
          // `.env` etc. are carried into each per-story worktree on creation.
          ...(config.worktreeCopyFiles !== undefined ? { copyFiles: config.worktreeCopyFiles } : {}),
        })
      : undefined)

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
  const _storyAgents = new Map<string, Array<{ agent: string; model?: string; phase: string }>>() // storyKey → dispatch agent info
  // H0.1 (field finding #17): storyKey → worktree path, so escalation paths
  // (emitEscalation, which runs at orchestrator scope) can checkpoint-commit
  // dirty worktree state before the story terminates. Entries are set at
  // worktree creation and left in place — checkpointStoryWorktree no-ops on
  // a missing/clean directory, so stale entries after cleanup are harmless.
  const _storyWorktrees = new Map<string, string>()
  const _storyRetryCount = new Map<string, number>()           // storyKey → retry count (Story 53-4)
  let _completedDispatches = 0                                  // total completed dispatch count (for heartbeat)

  // -- actual peak concurrency observed during runWithConcurrency --
  let _maxConcurrentActual = 0

  // -- package snapshot for node_modules protection (set in run(), used in processStory) --
  let _packageSnapshot: PackageSnapshotData | undefined

  // -- orchestrator start branch for merge-to-main phase (Story 75-2) --
  // Captured once at run() startup from `git rev-parse --abbrev-ref HEAD`.
  // Consumed by processStory after SHIP_IT to know which branch to merge into.
  let _orchestratorStartBranch: string | undefined

  // A5.1 F4 (red-team): the run-start SHA of the trusted tree, captured once so
  // acceptance loads read the registry/contract/deferrals at a PINNED snapshot
  // (design principle 2), not live HEAD. Closes the two-step out-of-band tamper
  // where a sibling story mutates the main-tree registry and a later audit
  // reads the weakened version. Undefined → loaders fall back to HEAD.
  let _runStartSha: string | undefined

  // -- post-sprint contract verification mismatches (Story 25-6) --
  let _contractMismatches: ContractMismatch[] | undefined

  // -- cost governance state (Story 53-3) --
  const _costChecker = new CostGovernanceChecker()
  let _costWarningEmitted = false
  let _budgetExhausted = false
  // H0.4 (field finding #10): set when a dispatch dies on authentication —
  // every subsequent dispatch would fail identically, so the run halts.
  let _authFailureHalted = false

  // -- graceful shutdown state (Story 58-7) --
  // Scoped to this orchestrator instance (one per createImplementationOrchestrator() call).
  // Signal handlers are registered/deregistered in run() to prevent test leakage.
  let _shutdownRequested = false
  let _inFlightCount = 0
  let _drainResolve: (() => void) | null = null
  const _drainPromise = new Promise<void>(resolve => { _drainResolve = resolve })

  // -- OTLP telemetry endpoint (Story 27-9) --
  // Set once when ingestionServer.start() resolves; cleared after run() completes.
  let _otlpEndpoint: string | undefined

  // Story 60-14: probe-author phase mode resolved at run() start from CLI/env/default.
  // Read by the per-story probe-author gate to decide whether to invoke the phase.
  // Default 'enabled' is a safe baseline before run() resolves the actual value.
  let _probeAuthorEffectiveMode: 'enabled' | 'disabled' = 'enabled'

  // -- Tier A verification pipeline (Story 51-5) --
  // In-memory store for VerificationSummary results; available to Epic 52 consumers.
  const verificationStore = new VerificationStore()
  // toSdlcEventBus() documents and isolates the bus type projection; see its JSDoc for
  // the full safety argument and the compile-time assertions that enforce it.
  const verificationPipeline = createDefaultVerificationPipeline(
    toSdlcEventBus(eventBus),
    undefined,
  )

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


  // -- Sequential merge serialization (Story 75-2, AC7) --
  // enqueueMerge serializes all merge-to-main calls via a Promise-chain mutex
  // created by createMergeQueue (see merge-to-main.ts for implementation).
  // Prevents concurrent git merge operations against the same base branch.
  // No package additions needed (AC10).
  const enqueueMerge = createMergeQueue()

  // -- memory pressure backoff (Story 23-8, AC1) --
  // Exponential backoff intervals (ms) before retrying a story dispatch
  // when memory pressure is detected.  After all intervals are exhausted
  // the story is escalated with reason 'memory_pressure_exhausted'.
  const MEMORY_PRESSURE_BACKOFF_MS = [30_000, 60_000, 120_000]

  function startPhase(storyKey: string, phase: string): void {
    if (!_phaseStartMs.has(storyKey)) _phaseStartMs.set(storyKey, new Map())
    _phaseStartMs.get(storyKey)!.set(phase, Date.now())
  }

  function endPhase(storyKey: string, phase: string, model?: string): void {
    if (!_phaseEndMs.has(storyKey)) _phaseEndMs.set(storyKey, new Map())
    _phaseEndMs.get(storyKey)!.set(phase, Date.now())
    _completedDispatches++
    // Record the agent (and resolved model, when the caller has it) used for
    // this phase dispatch (for telemetry). Story 77-4: model populates
    // primary_model — threaded from the workflow result's DispatchResult.model.
    recordDispatchAgent(storyKey, phase, agentId ?? 'claude-code', model)
  }

  function incrementDispatches(storyKey: string): void {
    _storyDispatches.set(storyKey, (_storyDispatches.get(storyKey) ?? 0) + 1)
  }

  function recordDispatchAgent(storyKey: string, phase: string, agent: string, model?: string): void {
    if (!_storyAgents.has(storyKey)) _storyAgents.set(storyKey, [])
    _storyAgents.get(storyKey)!.push({ agent, phase, ...(model !== undefined && { model }) })
  }

  /**
   * Story 77-4: derive primary_model for story_metrics from the per-story dispatch
   * agents. Prefer the model of the primary implementation dispatch (dev-story, then
   * its retry); otherwise fall back to the most frequent model across all dispatches.
   * Returns undefined only when no dispatch recorded a model (genuinely unknown).
   */
  function derivePrimaryModel(storyKey: string): string | undefined {
    const agents = _storyAgents.get(storyKey) ?? []
    const devModel =
      agents.find((a) => a.phase === 'dev-story' && a.model !== undefined)?.model ??
      agents.find((a) => a.phase === 'dev-story-retry' && a.model !== undefined)?.model
    if (devModel !== undefined) return devModel
    // Fallback: most frequent model across this story's dispatches.
    const counts = new Map<string, number>()
    for (const a of agents) {
      if (a.model !== undefined) counts.set(a.model, (counts.get(a.model) ?? 0) + 1)
    }
    let best: string | undefined
    let bestCount = 0
    for (const [model, count] of counts) {
      if (count > bestCount) {
        best = model
        bestCount = count
      }
    }
    return best
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

  async function writeStoryMetricsBestEffort(storyKey: string, result: string, reviewCycles: number, storyAgentId?: string): Promise<void> {
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
        primary_agent_id: storyAgentId ?? agentId ?? 'claude-code',
        primary_model: derivePrimaryModel(storyKey),
        dispatch_agents_json: _storyAgents.has(storyKey) ? JSON.stringify(_storyAgents.get(storyKey)) : undefined,
      })
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
    /**
     * Story 77-4: explicit root-cause taxonomy value to persist as
     * escalation_reason. When absent, falls back to `lastVerdict` (which is the
     * per-site verdict/reason string passed by every escalation path).
     */
    escalationReason?: string
  }): Promise<void> {
    // H0.1 (field finding #17): before the story terminates as escalated,
    // make the branch the durable copy of whatever is sitting uncommitted in
    // its worktree. Covers every escalation path centrally (same rationale as
    // the obs_032 escalation_detail patch below). Best-effort and no-op when
    // the worktree is missing or clean.
    const escalationWorktree = _storyWorktrees.get(payload.storyKey)
    if (escalationWorktree !== undefined) {
      const cp = await checkpointStoryWorktree(
        payload.storyKey,
        `escalation: ${payload.escalationReason ?? payload.lastVerdict}`,
        escalationWorktree,
      )
      if (cp.status === 'committed') {
        logger.info(
          { storyKey: payload.storyKey, sha: cp.sha },
          'escalation checkpoint: uncommitted worktree state preserved on story branch',
        )
        if (runManifest !== null && cp.sha) {
          runManifest
            .patchStoryState(payload.storyKey, { checkpoint_sha: cp.sha })
            .catch((err: unknown) =>
              logger.warn({ err, storyKey: payload.storyKey }, 'patchStoryState(checkpoint_sha, escalation) failed — pipeline continues'),
            )
        }
      } else if (cp.status === 'failed') {
        logger.warn(
          { storyKey: payload.storyKey, stderr: cp.stderr.slice(0, 500) },
          'escalation checkpoint failed — worktree state remains uncommitted (inspect before any cleanup)',
        )
      }
    }

    // H0.5 (field finding #20): on EVERY escalation, check whether story work
    // leaked into the PARENT working tree (cwd misroute — the worst-case
    // #15/#17 combination: escalation abandons a complete implementation as
    // uncommitted parent-tree modifications, invisible to the worktree
    // checkpoint above AND to reconcile-from-disk). Previously this diagnostic
    // ran only on the zero-diff path. Name the files in the escalation detail
    // so the operator never discovers the leak by accident.
    if (escalationWorktree !== undefined && projectRoot !== undefined) {
      const leakedFiles = detectWorkOutsideWorktree(escalationWorktree, projectRoot, checkGitDiffFiles)
      if (leakedFiles.length > 0) {
        const leakMsg =
          `PARENT-TREE LEAK: the MAIN checkout at ${projectRoot} carries ${String(leakedFiles.length)} ` +
          `uncommitted change(s) during this story's escalation (e.g. ${leakedFiles.slice(0, 10).join(', ')}). ` +
          `Story output may have landed OUTSIDE the worktree — inspect \`git -C ${projectRoot} status\` ` +
          `BEFORE any cleanup; reconcile-from-disk inspects the branch, not main, and will not see these files.`
        payload.issues = [...payload.issues, leakMsg]
        eventBus.emit('orchestrator:story-warn', { storyKey: payload.storyKey, msg: leakMsg })
        logger.warn({ storyKey: payload.storyKey, leakedFileCount: leakedFiles.length }, 'escalation parent-tree leak detected')
      }
    }

    const diagnosis = generateEscalationDiagnosis(
      payload.issues,
      payload.reviewCycles,
      payload.lastVerdict,
    )

    eventBus.emit('orchestrator:story-escalated', {
      ...payload,
      diagnosis,
    })

    // Story 77-4: persist escalation_reason to the run manifest so `substrate
    // report` and decision-replay (77-5) can read why the story escalated. The
    // reason is the explicit taxonomy value when supplied, else the per-site
    // verdict. Best-effort, non-fatal — mirrors the other patchStoryState calls.
    if (runManifest !== null) {
      const escalationReason = payload.escalationReason ?? payload.lastVerdict
      // obs_2026-05-27_032: also persist the escalation DETAIL (the issues —
      // build-failure output, failure text, findings) durably to per_story_state,
      // so the root cause survives `substrate report` deleting the ephemeral
      // notification and the worktree being torn down. Without this only the
      // short reason remained and escalations couldn't be diagnosed post-hoc.
      const escalationDetail = summarizeEscalationIssues(payload.issues)
      runManifest
        .patchStoryState(payload.storyKey, {
          escalation_reason: escalationReason,
          ...(escalationDetail !== undefined ? { escalation_detail: escalationDetail } : {}),
        })
        .catch((err: unknown) =>
          logger.warn({ err, storyKey: payload.storyKey }, 'patchStoryState(escalation_reason/detail) failed — pipeline continues'),
        )
    }

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
        } else {
          // Intermediate phase transition: persist phase for resume durability
          // (Story 66-1, obs_2026-05-03_022 fix #1). Best-effort — failures log a
          // warning but must not propagate or halt dispatch.
          const intermediatePhase = updates.phase
          runManifest
            .patchStoryState(storyKey, { phase: String(intermediatePhase) })
            .catch((err: unknown) =>
              logger.warn(
                { err, storyKey, phase: intermediatePhase },
                'phase-persistence-write-failed — pipeline continues',
              ),
            )
        }
      }
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

  // A2.3 (acceptance-gate): judge verdicts recorded by the acceptance stage,
  // consumed by the coverage audit (journey verdict = pass only when every
  // end-state PASSes) and persisted to the manifest at the run-end sweep.
  const _journeyVerdicts = new Map<string, AcceptanceJudgeVerdict[]>()

  /** External artifacts base: ~/.substrate/acceptance/<name>-<hash8>/<run>/ (H4.2 symmetry). */
  function acceptanceArtifactsBase(): string {
    const root = projectRoot ?? process.cwd()
    const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8)
    return join(homedir(), '.substrate', 'acceptance', `${basename(root)}-${hash}`, config.pipelineRunId ?? 'adhoc')
  }

  // -------------------------------------------------------------------------
  // A2.3 (acceptance-gate): the acceptance STAGE — render the claimed
  // journeys' surfaces via the declared contract, judge them (separate
  // lineage), record verdicts. Runs post-verification, pre-finalization,
  // for stories that claim journeys. Failures leave the journey unwalked —
  // the coverage audit is the enforcement point, never a silent skip.
  // -------------------------------------------------------------------------
  async function runAcceptanceStage(
    storyKey: string,
    worktreeDir: string,
  ): Promise<{ journeyId: string; criticality: 'critical' | 'standard'; judged: boolean; pass: boolean }[]> {
    const outcomes: { journeyId: string; criticality: 'critical' | 'standard'; judged: boolean; pass: boolean }[] = []
    const mode = config.acceptanceMode ?? 'advisory'
    if (mode === 'off' || projectRoot === undefined) return outcomes
    const journeyIds = _stories.get(storyKey)?.journeys ?? []
    if (journeyIds.length === 0) return outcomes
    const registryLoad = await loadJourneyRegistryFromTrustedTree(projectRoot, _runStartSha ?? 'HEAD')
    if (registryLoad.status !== 'ok') return outcomes // audit surfaces registry problems loudly
    const contractLoad = await loadAcceptanceContractFromTrustedTree(projectRoot, _runStartSha ?? 'HEAD')
    if (contractLoad.status !== 'ok') {
      logger.warn({ storyKey, status: contractLoad.status }, 'A2.3: no usable acceptance contract — claimed journeys stay unwalked (acceptance-unrunnable at audit)')
      return outcomes
    }
    const contract = contractLoad.contract
    eventBus.emit('orchestrator:acceptance-started', { storyKey, journeys: journeyIds })
    for (const journeyId of journeyIds) {
      const journey = registryLoad.registry.journeys.find((j) => j.id === journeyId)
      if (journey === undefined) continue
      const outcome = { journeyId, criticality: journey.criticality, judged: false, pass: false }
      outcomes.push(outcome)
      const journeyDir = join(acceptanceArtifactsBase(), storyKey, journeyId)
      const artifacts: string[] = []
      // A5.1 F1 (red-team): render-side gaming tripwire. The judge grounds in
      // the render command's OUTPUT, but that command runs agent-authored code
      // in the worktree — a story can make the render PRINT a passing surface
      // without wiring the real product. Full close = A6 canaries + Phase-4
      // driver; a cheap partial: if the story's diff touches a file the render
      // command names, the render may have been gamed — warn (operator-visible,
      // never a lone block: a legit story CAN touch its own render entry point).
      {
        const changed = new Set(checkGitDiffFiles(worktreeDir).map((f) => f.replace(/\\/g, '/')))
        const renderTokens = new Set<string>()
        for (const surface of journey.surfaces) {
          const def = contract.surfaces[surface as 'email' | 'cli' | 'file']
          if (def !== undefined) for (const tok of def.render.trim().split(/\s+/)) renderTokens.add(tok.replace(/\\/g, '/'))
        }
        const gamedTargets = [...changed].filter((f) => renderTokens.has(f) || [...renderTokens].some((t) => t.endsWith('/' + f) || f.endsWith('/' + t)))
        if (gamedTargets.length > 0) {
          logger.warn(
            { storyKey, journeyId, gamedTargets },
            'acceptance-render-target-modified: the story modified file(s) the acceptance render command invokes — the rendered surface may reflect gamed output rather than real product behavior. Review the render targets; a canary (A6) is the structural check.',
          )
          eventBus.emit('orchestrator:story-warn', {
            storyKey,
            msg: `acceptance-render-target-modified (${journeyId}): story diff touches render target(s) ${gamedTargets.join(', ')} — verdict may reflect gamed output`,
          })
        }
      }
      let renderFailed = false
      for (const surface of journey.surfaces) {
        if (surface === 'web') continue // interactive driver out of program scope
        const res = await renderSurface({
          surface,
          contract,
          workingDirectory: worktreeDir,
          artifactsDir: join(journeyDir, surface),
        })
        eventBus.emit('orchestrator:acceptance-rendered', {
          storyKey,
          surface,
          status: res.status,
          artifactsDir: res.artifactsDir,
          artifacts: res.artifacts,
          ...(res.error !== undefined ? { error: res.error } : {}),
        })
        if (res.status === 'failed') {
          renderFailed = true
          logger.warn(
            { storyKey, journeyId, surface, error: res.error, exitCode: res.exitCode, stderrTail: res.stderrTail?.slice(0, 500) },
            'A2.3: surface render failed — journey stays unwalked',
          )
        } else {
          artifacts.push(...res.artifacts.map((a) => join(surface, a)))
        }
      }
      if (renderFailed || artifacts.length === 0) continue
      const judge = await runAcceptanceJudge(
        { db, pack, contextCompiler, dispatcher, projectRoot: journeyDir, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
        { journey, artifactsDir: journeyDir, artifacts, storyKey },
      )
      // A4.3: per-gate cost telemetry (create-story pattern; best-effort).
      if (config.pipelineRunId !== undefined && judge.tokenUsage !== undefined) {
        void Promise.resolve()
          .then(() => addTokenUsage(db, config.pipelineRunId!, {
            phase: 'acceptance-judge',
            agent: 'acceptance-judge',
            input_tokens: judge.tokenUsage.input,
            output_tokens: judge.tokenUsage.output,
            cost_usd: estimateDispatchCost(judge.tokenUsage.input, judge.tokenUsage.output),
            metadata: JSON.stringify({ storyKey, journeyId }),
          }))
          .catch((tokenErr: unknown) => logger.warn({ storyKey, journeyId, err: tokenErr }, 'A4.3: acceptance-judge token usage record failed'))
      }
      if (judge.result === 'success' && judge.verdicts !== undefined) {
        _journeyVerdicts.set(journeyId, judge.verdicts)
        outcome.judged = true
        outcome.pass = judge.verdicts.every((v) => v.verdict === 'PASS')
        eventBus.emit('orchestrator:acceptance-verdict', {
          storyKey,
          journeyId,
          verdicts: judge.verdicts.map((v) => ({
            end_state_id: v.end_state_id,
            verdict: v.verdict,
            artifact: v.evidence.artifact,
            excerpt: v.evidence.excerpt,
          })),
        })
      } else {
        logger.warn({ storyKey, journeyId, error: judge.error, details: judge.details }, 'A2.3: judge failed — journey stays unwalked')
      }
    }
    return outcomes
  }

  // -------------------------------------------------------------------------
  // A0.3 (acceptance-gate): journey coverage audit — pure ledger arithmetic
  // over the trusted-tree registry + per-story claims + operator deferrals.
  // Emits `orchestrator:acceptance-coverage`; the final sweep persists the
  // ledger to the run manifest. Returns undefined when no registry exists
  // (acceptance not configured — legal) or the registry is unreadable
  // (warned; registry-validity escalation is A1 `acceptance-unrunnable` scope).
  // -------------------------------------------------------------------------
  async function auditJourneyCoverage(
    scope: { epic: number } | { final: true },
    opts?: { persist?: boolean },
  ): Promise<{ entries: JourneyCoverageEntry[]; unrunnable?: string } | undefined> {
    const mode = config.acceptanceMode ?? 'advisory'
    if (mode === 'off' || projectRoot === undefined) return undefined
    const registryLoad = await loadJourneyRegistryFromTrustedTree(projectRoot, _runStartSha ?? 'HEAD')
    if (registryLoad.status === 'absent') return undefined
    if (registryLoad.status === 'invalid') {
      // A1.1 (no-silent-skip): a COMMITTED-but-broken registry is a loud
      // misconfiguration — the audit cannot run, and pretending otherwise
      // recreates the blind spot.
      return {
        entries: [],
        unrunnable:
          'journey registry is INVALID: ' +
          registryLoad.issues.map((i) => `${i.path}: ${i.message}`).join('; ') +
          ' — fix it (substrate acceptance validate) or the audit cannot run',
      }
    }
    if (registryLoad.status !== 'ok') {
      logger.warn({ detail: registryLoad.message }, 'A0.3: journey registry read failed — coverage audit skipped (environmental)')
      return undefined
    }
    // A1.1: journeys can only be WALKED through the declared acceptance
    // contract. Registry-present + contract-absent means claimed journeys can
    // never become walked-* — surfaced as acceptance-unrunnable (blocking) or
    // a warning (advisory). Unclaimed journeys stay contract-independent.
    let unrunnable: string | undefined
    const contractLoad = await loadAcceptanceContractFromTrustedTree(projectRoot, _runStartSha ?? 'HEAD')
    if (contractLoad.status === 'absent') {
      unrunnable =
        `journey registry exists but the committed project profile has no acceptance: contract block ` +
        `(${ACCEPTANCE_CONTRACT_PROFILE_PATH}) — claimed journeys can never be walked. Declare render commands per surface.`
    } else if (contractLoad.status === 'invalid') {
      unrunnable =
        'acceptance: contract block is INVALID: ' +
        contractLoad.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
    } else if (contractLoad.status === 'error') {
      logger.warn({ detail: contractLoad.message }, 'A1.1: acceptance contract read failed (environmental) — treating as absent for this audit')
    }
    const deferralsLoad = await loadJourneyDeferralsFromTrustedTree(projectRoot, _runStartSha ?? 'HEAD')
    if (deferralsLoad.status !== 'ok') {
      logger.warn(
        { detail: deferralsLoad.status === 'invalid' ? deferralsLoad.issues : deferralsLoad.message },
        `A0.3: ${JOURNEY_DEFERRALS_PATH} unreadable/invalid — treating as no deferrals`,
      )
    }
    const deferredJourneyIds =
      deferralsLoad.status === 'ok' ? deferralsLoad.deferrals.map((d) => d.journey) : []
    const claims: JourneyClaim[] = []
    for (const [key, st] of _stories.entries()) {
      for (const journeyId of st.journeys ?? []) claims.push({ journeyId, storyKey: key })
    }
    // A2.3: journey-level verdict = pass only when EVERY end-state PASSes;
    // any FAIL or UNREACHABLE fails the journey.
    const verdicts: JourneyVerdictInput[] = [..._journeyVerdicts.entries()].map(([journeyId, vs]) => ({
      journeyId,
      verdict: vs.every((v) => v.verdict === 'PASS') ? 'pass' : 'fail',
    }))
    const entries = computeJourneyCoverage({
      registry: registryLoad.registry,
      claims,
      verdicts,
      deferredJourneyIds,
      scope,
    })
    const scopeLabel = 'final' in scope ? 'final' : `epic-${String(scope.epic)}`
    eventBus.emit('orchestrator:acceptance-coverage', {
      scope: scopeLabel,
      mode,
      entries,
      summary: summarizeCoverage(entries),
    })
    if (unrunnable !== undefined) {
      logger.warn({ scope: scopeLabel }, `A1.1: acceptance gate unrunnable — ${unrunnable}`)
    }
    if (opts?.persist === true) {
      // A2.2/A2.3: attach per-end-state verdicts to the ledger entries, write
      // the minutes-scale verdict HTML, persist both to the manifest.
      const entriesWithVerdicts = entries.map((e) => {
        const vs = _journeyVerdicts.get(e.journeyId)
        return vs !== undefined
          ? {
              ...e,
              verdicts: vs.map((v) => ({
                end_state_id: v.end_state_id,
                verdict: v.verdict,
                artifact: v.evidence.artifact,
                excerpt: v.evidence.excerpt,
              })),
            }
          : e
      })
      let reportPath: string | undefined
      try {
        const html = renderVerdictHtml({
          scope: `${config.pipelineRunId ?? 'run'} ${scopeLabel}`,
          generatedAt: new Date().toISOString(),
          journeys: entriesWithVerdicts.map((e) => ({
            journeyId: e.journeyId,
            title: e.title,
            criticality: e.criticality,
            state: e.state,
            ownerStories: e.ownerStories,
            verdicts: (e as { verdicts?: { end_state_id: string; verdict: 'PASS' | 'FAIL' | 'UNREACHABLE'; artifact: string; excerpt: string }[] }).verdicts ?? [],
          })),
        })
        reportPath = join(acceptanceArtifactsBase(), 'acceptance-verdicts.html')
        mkdirSync(dirname(reportPath), { recursive: true })
        writeFileSync(reportPath, html, 'utf-8')
      } catch (err) {
        logger.warn({ err }, 'A2.2: verdict artifact write failed (best-effort)')
        reportPath = undefined
      }
      if (runManifest !== null) {
        await runManifest
          .update({
            journeys: entriesWithVerdicts,
            ...(reportPath !== undefined ? { acceptance_report_path: reportPath } : {}),
          })
          .catch((err: unknown) => logger.warn({ err }, 'A0.3: manifest journeys ledger write failed — pipeline continues'))
      }
    }
    return unrunnable !== undefined ? { entries, unrunnable } : { entries }
  }

  function getStallThresholdMs(phase: string): number {
    return phase === 'IN_DEV' ? DEV_STORY_STALL_THRESHOLD_MS : DEFAULT_STALL_THRESHOLD_MS
  }

  /**
   * Map an internal StoryPhase to a consumer-facing manifest-compatible status string.
   * Mirrors the PerStoryStatus values in per-story-state.ts.
   * Story 66-2: obs_2026-05-03_022 fix #2.
   */
  function storyPhaseToStatus(phase: string): string {
    switch (phase) {
      case 'COMPLETE':            return 'complete'
      case 'ESCALATED':           return 'escalated'
      case 'VERIFICATION_FAILED': return 'verification-failed'
      case 'IN_REVIEW':
      case 'NEEDS_FIXES':         return 'in-review'
      case 'PENDING':             return 'pending'
      default:                    return 'dispatched'
    }
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

      // Build per-story snapshot for drift detection (Story 66-2: obs_2026-05-03_022 fix #2).
      // Includes all stories (not just active) for complete observability.
      const perStoryState: Record<string, { phase: string; status: string }> = {}
      for (const [key, s] of _stories) {
        perStoryState[key] = { phase: s.phase, status: storyPhaseToStatus(s.phase) }
      }

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
        ...(Object.keys(perStoryState).length > 0 ? { perStoryState } : {}),
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

    // ---------------------------------------------------------------------------
    // Story 75-1 (Path E spike 2026-05-10): per-story worktree isolation.
    // Creates an isolated git worktree so concurrent story dispatches cannot corrupt
    // each other's working trees. Failed stories leave their branch intact for
    // `substrate reconcile-from-disk` inspection (Epic 76).
    // IMPORTANT: failure MUST propagate — do NOT add try/catch here (AC2/AC5).
    // AC6: when noWorktree=true (--no-worktree flag, Story 75-3), effectiveProjectRoot
    //      falls back to projectRoot and no worktree is created.
    // ---------------------------------------------------------------------------
    let effectiveProjectRoot = projectRoot
    if (!noWorktree && _worktreeManager !== undefined && projectRoot !== undefined) {
      const wt = await _worktreeManager.createWorktree(storyKey)
      effectiveProjectRoot = wt.worktreePath
      _storyWorktrees.set(storyKey, wt.worktreePath)
    }

    // Path E Bug #5 (v0.20.86): captured from create-story result so substrate
    // can compose the `feat(story-<key>): <title>` commit message before
    // merge-to-main. Hoisted here because the create-story `const createResult`
    // is scoped to the retry-loop block below and won't reach the merge-to-main
    // gate ~2700 lines later.
    let _capturedStoryTitle: string | undefined

    // -- create-story phase --

    await waitIfPaused()
    if (_state !== 'RUNNING') return

    startPhase(storyKey, 'create-story')
    updateStory(storyKey, {
      phase: 'IN_STORY_CREATION' as StoryPhase,
      startedAt: new Date().toISOString(),
    })

    let storyFilePath: string | undefined
    // Story 58-6: source AC hash to pass to runCreateStory (populated when drift
    // is detected or when a fresh create fires after the freshness check).
    let sourceAcHash: string | undefined

    // Check if a story file already exists for this story key.
    // Pre-existing stories (e.g., from BMAD auto-implement) should be reused
    // so their full task list is available for complexity analysis and batching.
    const artifactsDir = effectiveProjectRoot ? join(effectiveProjectRoot, '_bmad-output', 'implementation-artifacts') : undefined
    if (artifactsDir && existsSync(artifactsDir)) {
      try {
        const files = readdirSync(artifactsDir)
        // Story 58-11: exclude previously-renamed stale artifacts from the
        // existing-artifact lookup. When a drift is detected the orchestrator
        // renames `<storyKey>-<slug>.md` to `<storyKey>-<slug>.stale-<ts>.md`
        // to force the create-story agent to write fresh (strata
        // obs_2026-04-22_007). Without this exclusion the very next lookup
        // would match the `.stale-<ts>.md` form as an existing artifact and
        // the rename would bounce back on every dispatch.
        const STALE_SUFFIX = /\.stale-\d+\.md$/
        const match = files.find(
          (f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md') && !STALE_SUFFIX.test(f),
        )
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
            // Story 58-6: Freshness check — verify the artifact's stored source-AC hash
            // matches the current epics.md content. If the epic was edited since the
            // artifact was written, regenerate instead of silently reusing a stale artifact.
            let isDrift = false
            try {
              const epicsPath = effectiveProjectRoot ? findEpicsFile(effectiveProjectRoot) : undefined
              if (epicsPath !== undefined) {
                const epicContent = readFileSync(epicsPath, 'utf-8')
                const sourceSection = extractStorySection(epicContent, storyKey)
                if (sourceSection != null) {
                  const currentHash = hashSourceAcSection(sourceSection)
                  sourceAcHash = currentHash
                  const artifactContent = await readFile(candidatePath, 'utf-8')
                  const hashMatch = /<!--\s*source-ac-hash:\s*([0-9a-f]{64})\s*-->/.exec(artifactContent)
                  const storedHash = hashMatch?.[1] ?? null
                  if (storedHash !== currentHash) {
                    isDrift = true
                    eventBus.emit('story:ac-source-drift', { storyKey, storedHash, currentHash })
                    logger.info(
                      { storyKey, storedHash, currentHash },
                      `[orchestrator] story ${storyKey}: source AC hash mismatch, regenerating story artifact`,
                    )
                  }
                }
              }
            } catch {
              // Non-fatal: if freshness check fails for any reason, preserve the
              // existing reuse behavior (AC7 — no regression when epics unavailable).
            }

            if (!isDrift) {
              storyFilePath = candidatePath
              logger.info({ storyKey, storyFilePath }, 'Found existing story file — skipping create-story')
              // A0.3 (acceptance-gate): the reuse path skips create-story's
              // tag validation, but coverage claims must not vanish — parse
              // the reused artifact's `journeys:` frontmatter here.
              try {
                const reusedContent = await readFile(candidatePath, 'utf-8')
                const reusedJourneys = parseStoryFrontmatter(reusedContent).journeys
                if (reusedJourneys.length > 0) {
                  updateStory(storyKey, { journeys: reusedJourneys })
                }
              } catch {
                // Best-effort — an unreadable artifact is handled downstream.
              }
              endPhase(storyKey, 'create-story')
              eventBus.emit('orchestrator:story-phase-complete', {
                storyKey,
                phase: 'IN_STORY_CREATION',
                result: { result: 'success', story_file: storyFilePath, story_key: storyKey },
              })
              await persistState()
            } else {
              // Story 58-11: rename the drifted artifact to `.stale-<ts>.md`
              // before dispatching create-story. When the existing file is
              // still present at the target path, the create-story agent
              // tends to Read it, emit a short YAML success stub, and never
              // call Write — producing a ~220-output-token fraud-success
              // caught by 58-9d's post-dispatch guard (strata
              // obs_2026-04-22_007). Renaming forces the agent to write a
              // fresh artifact; the `.stale-<ts>.md` preserves the prior
              // content for post-mortem diff.
              try {
                const ts = Date.now()
                const staleName = match.replace(/\.md$/, `.stale-${ts}.md`)
                const stalePath = join(artifactsDir, staleName)
                renameSync(candidatePath, stalePath)
                logger.info(
                  { storyKey, staleName },
                  `[orchestrator] story ${storyKey}: renamed drifted artifact to ${staleName} before re-dispatch`,
                )
              } catch (renameErr) {
                // Non-fatal: if rename fails (permissions, unusual FS state),
                // fall through and let 58-9d's post-dispatch fraud-guard
                // catch any resulting short-circuit.
                logger.warn(
                  { storyKey, err: renameErr },
                  'Failed to rename stale artifact before create-story re-dispatch; relying on 58-9d fraud-guard',
                )
              }
            }
          }
        }
      } catch {
        // If directory read fails, fall through to create-story
      }
    }

    // AC satisfaction pre-check: if the story's expected new files already
    // exist in the working tree, the story was implicitly covered by adjacent
    // stories — skip create-story to avoid a wasted dispatch.
    if (storyFilePath === undefined && effectiveProjectRoot && isImplicitlyCovered(storyKey, effectiveProjectRoot)) {
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

    // Story 59-3: pre-dev source-AC fidelity gate retry loop. The loop body
    // is the existing create-story dispatch + post-dispatch verification. The
    // fidelity gate at the end of each iteration may reset storyFilePath to
    // undefined (renaming the drifted artifact to .stale-<ts>) to force a
    // retry, up to MAX_FIDELITY_RETRIES. Strata obs_2026-04-20_001: with
    // verified-correct shard input, the create-story agent still hallucinated
    // a different storage backend / file structure (Run 9: WikilinkResolver +
    // VaultGraphBuilder + vault_links LanceDB instead of source AC's
    // wikilink-parser + adjacency-store + adjacency-builder + JSON adjacency).
    // The gate detects this BEFORE dev runs by extracting backtick-wrapped
    // named paths from the source AC and verifying they appear in the
    // generated story file.
    let fidelityRetries = 0
    // F-probe (shift-left, separate budget from fidelity): retries spent
    // re-authoring an invalid ## Runtime Probes block at create-story time.
    let probeRetries = 0
    // Story 59-5: drift-correction guidance for retry attempts. Empty on first
    // dispatch; populated by the fidelity gate (below) when drift is detected
    // and a retry is being scheduled. The next loop iteration passes this
    // through to runCreateStory which surfaces it in the prompt directly above
    // the Mission section so the agent attends to the correction before
    // rendering. Without this, retry produces identical drift on systematic
    // failure modes (no new context for the model to act on).
    let priorDriftFeedback: string | undefined
    while (storyFilePath === undefined) {
    try {
      incrementDispatches(storyKey)
      // Story 58-9d: capture dispatch start so we can verify the agent
      // actually wrote the file during THIS dispatch (not before).
      const dispatchStartMs = Date.now()
      const createResult = await runCreateStory(
        { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
        {
          epicId: storyKey.split('-')[0] ?? storyKey,
          storyKey,
          pipelineRunId: config.pipelineRunId,
          source_ac_hash: sourceAcHash,
          ...(priorDriftFeedback !== undefined ? { priorDriftFeedback } : {}),
        },
      )

      endPhase(storyKey, 'create-story')
      eventBus.emit('orchestrator:story-phase-complete', {
        storyKey,
        phase: 'IN_STORY_CREATION',
        result: createResult,
      })

      // Record create-story token usage for accurate per-story cost attribution.
      // Story 57-4: wrap in Promise.resolve().then(...) so both sync throws and async
      // rejections are caught; the prior try/catch only caught sync throws, allowing
      // Dolt "database is read only" rejections to terminate the orchestrator process.
      if (config.pipelineRunId !== undefined && createResult.tokenUsage !== undefined) {
        void Promise.resolve()
          .then(() => addTokenUsage(db, config.pipelineRunId!, {
            phase: 'create-story',
            agent: 'create-story',
            input_tokens: createResult.tokenUsage!.input,
            output_tokens: createResult.tokenUsage!.output,
            cost_usd: estimateDispatchCost(createResult.tokenUsage!.input, createResult.tokenUsage!.output),
            metadata: JSON.stringify({ storyKey }),
          }))
          .catch((tokenErr: unknown) =>
            logger.warn({ storyKey, err: tokenErr }, 'Failed to record create-story token usage'),
          )
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
        // H0.4 (field finding #10): an agent that died on authentication is an
        // environmental failure, not a story failure — classify it, surface the
        // remediation, and halt the run (every subsequent dispatch would fail
        // the same way). Two detection sources: the workflow's source-level
        // classification (error === 'auth-failure', exit-0 refusals) and a
        // signature match on the folded stderr (non-zero exits).
        const authSignature =
          createResult.error === 'auth-failure'
            ? (createResult.details ?? 'auth-failure')
            : detectClaudeAuthFailure(errMsg)
        if (authSignature !== null) {
          const authDetail = createResult.details ?? errMsg
          await emitEscalation({
            storyKey,
            lastVerdict: 'auth-failure',
            reviewCycles: 0,
            issues: [authDetail, CLAUDE_AUTH_FAILURE_HINT],
            escalationReason: 'auth-failure',
          })
          await triggerAuthFailureHalt(storyKey, authSignature.slice(0, 200))
          await persistState()
          return
        }
        // If the failure output carries a Codex sandbox/approval write-block
        // signature, surface the actionable explanation alongside the raw error.
        const codexHint = detectCodexSandboxBlock(errMsg)
        await emitEscalation({
          storyKey,
          lastVerdict: 'create-story-failed',
          reviewCycles: 0,
          issues: codexHint !== null ? [errMsg, codexHint] : [errMsg],
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
        // A Codex agent returning an empty story_file in its YAML response is
        // the third manifestation of a sandbox/approval write-block — the
        // model couldn't write so it didn't claim a path. Surface the same
        // hint that's on create-story-failed and create-story-fraud-success
        // so the operator sees a named cause, not the generic message.
        const noFileIssues =
          deps.agentId === 'codex' ? [errMsg, CODEX_SANDBOX_BLOCK_HINT] : [errMsg]
        await emitEscalation({
          storyKey,
          lastVerdict: 'create-story-no-file',
          reviewCycles: 0,
          issues: noFileIssues,
        })
        await persistState()
        return
      }

      // -- story-artifact path containment (H1.8, hardening program) --
      // Live capture 2026-07-05: a create-story agent wrote its artifact to
      // $HOME/_bmad-output/... — outside the project AND its worktree — and
      // the pipeline accepted the path (the run "succeeded" only because the
      // prompt embeds story content). An out-of-project artifact is a scope
      // violation of the #15 leak class: it strands pipeline state where no
      // cleanup, commit, or reconcile will ever find it. Worktree mode only —
      // unit-test fixtures use synthetic paths with no worktree.
      if (
        effectiveProjectRoot !== undefined &&
        effectiveProjectRoot !== projectRoot
      ) {
        // H7 (relative-story-file-bypasses-h18, red-team): resolve the claimed
        // path to absolute against the worktree BEFORE the containment check.
        // Pre-fix the gate was conditioned on isAbsolute(), so a RELATIVE claim
        // like `../../_bmad-output/…/12-3.md` skipped the check entirely and
        // resolved outside the worktree — the same #15 leak, reported as
        // success. A bare relative path inside the worktree (`_bmad-output/…`)
        // still resolves inside and passes.
        const resolvedStoryFile = isAbsolute(createResult.story_file)
          ? createResult.story_file
          : resolve(effectiveProjectRoot, createResult.story_file)
        // H7 (worktree-symlink-lexical-escape, red-team): path.relative is pure
        // string math — it does not resolve symlinks. An agent can plant a
        // symlink inside its worktree pointing OUT, then claim a path through
        // it that passes the lexical check while physically resolving outside.
        // Canonicalize BOTH the worktree root and the candidate (its nearest
        // existing ancestor, since the leaf may not exist yet) before comparing.
        const canonicalize = (p: string): string => {
          let cur = p
          // Walk up to the nearest existing path so realpath resolves symlinks
          // in the ancestor chain even when the leaf file was not written.
          for (let i = 0; i < 64; i++) {
            try {
              return join(realpathSync(cur), relative(cur, p))
            } catch {
              const parent = dirname(cur)
              if (parent === cur) break
              cur = parent
            }
          }
          return p
        }
        const realWorktree = canonicalize(effectiveProjectRoot)
        const realStoryFile = canonicalize(resolvedStoryFile)
        const relToWorktree = relative(realWorktree, realStoryFile)
        const outsideWorktree = relToWorktree.startsWith('..') || isAbsolute(relToWorktree)
        if (outsideWorktree) {
          const errMsg =
            `create-story wrote its artifact OUTSIDE the story worktree: ${createResult.story_file} (resolved: ${resolvedStoryFile}) ` +
            `(worktree: ${effectiveProjectRoot}). The agent escaped its working directory — ` +
            `this is the parent/home-directory write-leak class (field finding #15). ` +
            `The stray file was NOT adopted; inspect and remove it.`
          logger.error({ storyKey, storyFile: createResult.story_file, worktree: effectiveProjectRoot }, 'create-story artifact outside worktree — escalating')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: 'create-story-outside-project',
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
          await emitEscalation({
            storyKey,
            lastVerdict: 'create-story-outside-project',
            reviewCycles: 0,
            issues: [errMsg],
            escalationReason: 'create-story-outside-project',
          })
          await persistState()
          return
        }
      }

      // Story 58-9d: verify the agent actually WROTE the claimed file during
      // this dispatch. Strata observation obs_2026-04-22_006 surfaced a
      // failure mode where the create-story agent returned `result: success`
      // with tiny output (85 output tokens for 1-9) and a story_file path
      // that happened to match an existing artifact — but the agent never
      // issued a filesystem write. The orchestrator trusted the claim,
      // downstream phases operated on stale Run 4 content, and the freshness
      // check / preservation directives never had a chance to fire on fresh
      // artifact content.
      //
      // Guard is scoped to paths under the project's expected artifacts
      // directory — `{projectRoot}/_bmad-output/implementation-artifacts/`.
      // Synthetic test paths (like `/path/to/5-1.md` in unit fixtures) are
      // bypassed, matching the pre-58-9d behavior for out-of-tree paths.
      //
      // Story 59-1 (strata obs_2026-04-25_009): tolerate backslash-escaped
      // paths. The agent sometimes treats markdown-escape conventions as
      // literal in tool args, so a path rendered as `_bmad-output` in the
      // prompt becomes `\_bmad-output` in the tool call. Run 9 evidence:
      // 1-7 was reported at the canonical path but the file existed at the
      // literal-backslash path, triggering a false fraud-success escalation.
      // Recovery: detect both claim-side and filesystem-side variants,
      // rename the file to the canonical location, emit a warn finding so
      // operators can spot the agent misbehavior. If rename fails for any
      // reason, propagate the escaped path so downstream phases can still
      // read the artifact.
      if (effectiveProjectRoot !== undefined) {
        const expectedArtifactsDir = join(effectiveProjectRoot, '_bmad-output', 'implementation-artifacts')
        const escapedExpectedDir = expectedArtifactsDir.replace('/_bmad-output/', '/\\_bmad-output/')

        // Normalize a backslash-escaped claim to canonical form for the prefix check.
        let claimedPath = createResult.story_file
        if (claimedPath.startsWith(escapedExpectedDir)) {
          claimedPath = claimedPath.replace('/\\_bmad-output/', '/_bmad-output/')
          logger.warn(
            { storyKey, originalClaim: createResult.story_file, normalizedClaim: claimedPath },
            'create-story claimed path contains backslash-escaped underscore; normalizing',
          )
          eventBus.emit('orchestrator:story-warn', {
            storyKey,
            msg: `create-story claim path was backslash-escaped; normalized to ${claimedPath}`,
          })
        }

        if (claimedPath.startsWith(expectedArtifactsDir)) {
          try {
            // Resolve where the file actually lives. Prefer canonical; fall
            // back to escaped variant; if neither, treat as fraud-success.
            let actualPath: string | null = null
            if (existsSync(claimedPath)) {
              actualPath = claimedPath
            } else {
              const escapedVariant = claimedPath.replace('/_bmad-output/', '/\\_bmad-output/')
              if (escapedVariant !== claimedPath && existsSync(escapedVariant)) {
                try {
                  renameSync(escapedVariant, claimedPath)
                  actualPath = claimedPath
                  logger.warn(
                    { storyKey, escapedVariant, canonicalPath: claimedPath },
                    'create-story wrote artifact to backslash-escaped path; moved to canonical location',
                  )
                  eventBus.emit('orchestrator:story-warn', {
                    storyKey,
                    msg: `create-story wrote to backslash-escaped path ${escapedVariant}; corrected to ${claimedPath}`,
                  })
                } catch (renameErr) {
                  // Use escaped path as-is so downstream phases can still
                  // read the artifact. Less ideal than canonical (operators
                  // may see two locations) but better than failing the run.
                  actualPath = escapedVariant
                  logger.warn(
                    { storyKey, escapedVariant, canonicalPath: claimedPath, err: renameErr },
                    'create-story wrote to backslash-escaped path; rename to canonical failed; treating as success at escaped location',
                  )
                  eventBus.emit('orchestrator:story-warn', {
                    storyKey,
                    msg: `create-story wrote to backslash-escaped path ${escapedVariant}; rename to canonical failed`,
                  })
                }
              }
            }

            if (actualPath === null) {
              const outputTokens = createResult.tokenUsage?.output ?? 0
              const errMsg = `create-story claimed success (story_file: ${createResult.story_file}) but the file does not exist on disk (output tokens: ${outputTokens})`
              logger.error({ storyKey, claimedPath: createResult.story_file, outputTokens }, errMsg)
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: errMsg,
                completedAt: new Date().toISOString(),
              })
              await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
              // A claimed-but-absent file from Codex is the classic symptom of a
              // sandbox/approval write-block (the agent emits YAML but exec can't
              // write). Surface the explanation so operators don't chase a phantom.
              const fraudIssues =
                deps.agentId === 'codex' ? [errMsg, CODEX_SANDBOX_BLOCK_HINT] : [errMsg]
              await emitEscalation({
                storyKey,
                lastVerdict: 'create-story-fraud-success',
                reviewCycles: 0,
                issues: fraudIssues,
              })
              await persistState()
              return
            }

            // Propagate the resolved path so downstream phases find the file.
            if (actualPath !== createResult.story_file) {
              createResult.story_file = actualPath
            }

            const claimedStat = statSync(actualPath)
            if (claimedStat.mtimeMs < dispatchStartMs) {
              const outputTokens = createResult.tokenUsage?.output ?? 0
              const mtimeISO = new Date(claimedStat.mtimeMs).toISOString()
              const dispatchStartISO = new Date(dispatchStartMs).toISOString()
              const errMsg = `create-story claimed success but did not rewrite ${actualPath} during this dispatch (file mtime ${mtimeISO} predates dispatch start ${dispatchStartISO}; output tokens: ${outputTokens})`
              logger.error({ storyKey, claimedPath: actualPath, mtimeISO, dispatchStartISO, outputTokens }, errMsg)
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: errMsg,
                completedAt: new Date().toISOString(),
              })
              await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
              await emitEscalation({
                storyKey,
                lastVerdict: 'create-story-fraud-success',
                reviewCycles: 0,
                issues: [errMsg],
              })
              await persistState()
              return
            }
          } catch (verifyErr) {
            // Non-fatal: if stat/existsSync itself throws (permissions etc.),
            // fall through. The later phases will surface any real issue.
            logger.warn({ storyKey, err: verifyErr }, 'create-story post-dispatch file verification threw; proceeding with claimed path')
          }
        }
      }

      storyFilePath = createResult.story_file
      // A0.3 (acceptance-gate): persist validated journey tags to per-story
      // state — the epic-close coverage audit reads claims from here, which
      // stays correct in every finalization mode (branch-mode artifacts never
      // reach the main tree).
      if (createResult.journeys !== undefined && createResult.journeys.length > 0) {
        updateStory(storyKey, { journeys: createResult.journeys })
        if (runManifest !== null) {
          runManifest
            .patchStoryState(storyKey, { journeys: createResult.journeys })
            .catch((err: unknown) =>
              logger.warn({ err, storyKey }, 'A0.3: patchStoryState(journeys) failed — pipeline continues'),
            )
        }
      }
      // Path E Bug #5 (v0.20.86): preserve story_title across the retry-loop
      // scope so the merge-to-main commit step can use it. The original
      // `createResult` const goes out of scope after the loop exits.
      // F-commitmsg (2026-05-26): sanitize before capture — create-story's
      // story_title can absorb stray stdout (banner/report output), which would
      // otherwise become a mangled `feat(story-N-M): …` commit subject. A
      // contaminated title sanitizes to undefined → commitDevStoryOutput falls
      // back to its safe 'implementation' default.
      _capturedStoryTitle = sanitizeStoryTitle(createResult.story_title)

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

    // -- Story 59-3: pre-dev source-AC fidelity gate --
    // After a successful dispatch, verify the generated story file references
    // the named paths from the source AC. If the agent drifted (substituted
    // its own filenames / storage backends / class names), rename the artifact
    // to .stale-<ts> and retry create-story. After MAX_FIDELITY_RETRIES,
    // escalate with create-story-source-ac-drift.
    if (storyFilePath !== undefined && effectiveProjectRoot !== undefined) {
      try {
        const epicId = storyKey.split('-')[0] ?? storyKey
        const fidelityImplDecisions = await getDecisionsByPhase(db, 'implementation')
        let fidelitySourceContent: string | undefined
        const fidelityPerStoryShard = fidelityImplDecisions.find(
          (d) => d.category === 'epic-shard' && d.key === storyKey,
        )
        if (fidelityPerStoryShard?.value) {
          // obs_2026-05-26_030: narrow even the per-story shard to the story's
          // own section. A stored per-story shard can over-capture trailing
          // epic-level sections (especially for the LAST story in an epic),
          // whose paths/verbs then read as false drift against the render
          // (strata 5-7). extractStorySection is idempotent when the shard is
          // already a single story's section; fall back to the raw value if the
          // heading can't be located (preserves prior behavior).
          fidelitySourceContent =
            extractStorySection(fidelityPerStoryShard.value, storyKey) ?? fidelityPerStoryShard.value
        } else {
          const epicShardForFidelity = fidelityImplDecisions.find(
            (d) => d.category === 'epic-shard' && d.key === epicId,
          )
          if (epicShardForFidelity?.value) {
            fidelitySourceContent = extractStorySection(epicShardForFidelity.value, storyKey) ?? undefined
          }
        }

        if (fidelitySourceContent !== undefined) {
          const namedPaths = extractNamedPathsFromSource(fidelitySourceContent)
          // Story 60-1: clause-fidelity gate runs alongside 59-3's path gate.
          // Different drift class (silent AC clause-set reduction) — caught
          // by counting behavioral clauses (Given/When/Then or ### AC<N>)
          // and numeric quantifiers (`exactly four tools`). Strata
          // obs_2026-04-25_011 (Run 11): source said `exactly four tools`,
          // rendered said `exactly two tools`; path gate passed because all
          // backtick-wrapped paths still appeared.
          const storyContentForFidelity = await readFile(storyFilePath, 'utf-8')

          const pathFidelity = namedPaths.length >= MIN_NAMED_PATHS_FOR_FIDELITY_GATE
            ? computeStoryFileFidelity(storyContentForFidelity, namedPaths)
            : null
          const clauseFidelity = computeClauseFidelity(storyContentForFidelity, fidelitySourceContent)

          const pathDrift = pathFidelity?.drift ?? 0
          const clauseDrift = clauseFidelity.drift
          const overallDrift = Math.max(pathDrift, clauseDrift)

          logger.debug(
            {
              storyKey,
              pathDrift,
              clauseDrift,
              overallDrift,
              pathMissing: pathFidelity?.missing ?? [],
              numericMismatches: clauseFidelity.numericMismatches,
              clauseRatio: clauseFidelity.clauseRatio,
            },
            'create-story output fidelity check (path + clause)',
          )

          if (overallDrift > FIDELITY_DRIFT_THRESHOLD) {
            fidelityRetries++
            if (fidelityRetries <= MAX_FIDELITY_RETRIES) {
              // Rename drifting artifact and retry. Mirror 58-11's stale-suffix.
              const stalePath = storyFilePath.replace(/\.md$/, `.stale-${Date.now()}.md`)
              try {
                renameSync(storyFilePath, stalePath)
                const driftPct = Math.round(overallDrift * 100)
                const pathMissing = pathFidelity?.missing ?? []
                // obs_2026-05-03_021: only ERROR-severity mismatches drive
                // retry feedback. Warn-severity entries stay in
                // `clauseFidelity.numericMismatches` for telemetry but are
                // not communicated to the dispatched agent (asking it to
                // "restore the count" of a faithfully-rendered constraint
                // pushes it to corrupt good output — the strata 1-11b
                // failure mode).
                const numericMismatches = clauseFidelity.numericMismatches.filter(
                  (m) => m.severity === 'error',
                )

                // Build human-readable summary of which signal(s) tripped.
                const reasons: string[] = []
                if (pathMissing.length > 0) {
                  reasons.push(`${pathMissing.length} named path(s) missing`)
                }
                if (numericMismatches.length > 0) {
                  reasons.push(`${numericMismatches.length} numeric quantifier mismatch(es) (e.g., "${numericMismatches[0]!.noun}" source=${numericMismatches[0]!.sourceCount} rendered=${numericMismatches[0]!.renderedCount})`)
                }
                if (clauseFidelity.clauseRatio < 0.7) {
                  reasons.push(`clause shortfall (rendered ${clauseFidelity.renderedClauseCount}/${clauseFidelity.sourceClauseCount} = ${Math.round(clauseFidelity.clauseRatio * 100)}%)`)
                }

                logger.warn(
                  {
                    storyKey,
                    pathDrift,
                    clauseDrift,
                    pathMissing,
                    numericMismatches,
                    clauseRatio: clauseFidelity.clauseRatio,
                    retries: fidelityRetries,
                    stalePath,
                  },
                  `create-story output drifted from source AC (${driftPct}% drift, ${reasons.join('; ')}); renamed to ${stalePath} and retrying (${fidelityRetries}/${MAX_FIDELITY_RETRIES})`,
                )
                eventBus.emit('orchestrator:story-warn', {
                  storyKey,
                  msg: `create-story drift detected (${reasons.join('; ')}); retry ${fidelityRetries}/${MAX_FIDELITY_RETRIES}`,
                })

                // Story 59-5 + 60-2: drift-correction guidance composes
                // path-missing AND clause-reduction signals into a unified
                // priorDriftFeedback. The escape-hatch sentence is the
                // critical addition for 60-2: the create-story prompt
                // already permits emitting `result: failure, error: source
                // scope exceeds single-story capacity` when the source AC
                // is genuinely too large to fit in one story (instead of
                // silently reducing scope). The retry message reminds the
                // agent of this option — without it, retries would loop
                // until budget exhaustion on a story that legitimately
                // needs splitting upstream.
                const feedbackParts: string[] = [
                  `### Prior Dispatch Drift Detected (retry ${fidelityRetries}/${MAX_FIDELITY_RETRIES})`,
                  '',
                  `A previous create-story dispatch produced an artifact that drifted from the source AC. The previous artifact has been moved to \`${stalePath}\`.`,
                  '',
                  '**Specific drift findings:**',
                  '',
                ]
                if (pathMissing.length > 0) {
                  feedbackParts.push('Named paths/files from source AC that were missing in the prior dispatch:')
                  feedbackParts.push('')
                  feedbackParts.push(...pathMissing.map((p) => `- \`${p}\``))
                  feedbackParts.push('')
                }
                if (numericMismatches.length > 0) {
                  feedbackParts.push('Numeric quantifiers from source AC that were reduced in the prior dispatch:')
                  feedbackParts.push('')
                  feedbackParts.push(
                    ...numericMismatches.map((m) =>
                      `- source AC says "**${m.sourceCount}** ${m.noun}"; rendered artifact says "${m.renderedCount}" — restore the original count and the named items`,
                    ),
                  )
                  feedbackParts.push('')
                }
                if (clauseFidelity.clauseRatio < 0.7) {
                  feedbackParts.push(
                    `The source AC has ${clauseFidelity.sourceClauseCount} behavioral clauses (Given/When/Then triples or numbered ACs); the prior rendered artifact had only ${clauseFidelity.renderedClauseCount}. You dropped clauses without authorization. Either preserve all source clauses verbatim, OR if the scope is genuinely too large for a single story, emit \`result: failure, error: source scope exceeds single-story capacity — split upstream\` per the prompt's Scope Cap Guidance — silently reducing scope is forbidden.`,
                  )
                  feedbackParts.push('')
                }
                feedbackParts.push(
                  'Preserve the source AC contract verbatim: every named file/path, every numeric quantifier (`exactly N`, `all N`, `both`), and every behavioral clause. Do not substitute names from training priors. Do not silently reduce scope. If the scope cannot fit, emit `result: failure, error: source scope exceeds single-story capacity — split upstream` instead of partially rendering.',
                )

                priorDriftFeedback = feedbackParts.join('\n')
                storyFilePath = undefined  // force re-dispatch
                continue
              } catch (renameErr) {
                logger.warn(
                  { storyKey, err: renameErr, stalePath },
                  'failed to rename drifting artifact for retry; proceeding with current artifact',
                )
                // Fall through — proceed to dev with the drifting artifact.
                // Verification phase's source-ac-fidelity check will still
                // catch the drift as a backstop.
              }
            } else {
              // Retry budget exhausted — escalate with diagnostic detail.
              const pathMissing = pathFidelity?.missing ?? []
              // obs_2026-05-03_021: same severity filter as the retry path —
              // only ERROR-severity mismatches drove drift, so only they
              // belong in the escalation reason.
              const numericMismatches = clauseFidelity.numericMismatches.filter(
                (m) => m.severity === 'error',
              )
              const reasons: string[] = []
              if (pathMissing.length > 0) {
                reasons.push(`paths missing: ${pathMissing.join(', ')}`)
              }
              if (numericMismatches.length > 0) {
                reasons.push(
                  `numeric mismatches: ${numericMismatches.map((m) => `${m.noun} (source=${m.sourceCount}, rendered=${m.renderedCount})`).join('; ')}`,
                )
              }
              if (clauseFidelity.clauseRatio < 0.7) {
                reasons.push(
                  `clause shortfall: source=${clauseFidelity.sourceClauseCount}, rendered=${clauseFidelity.renderedClauseCount}`,
                )
              }
              const errMsg =
                `create-story output drifted from source AC after ${MAX_FIDELITY_RETRIES} retries; ` +
                reasons.join('; ')
              logger.error(
                { storyKey, pathDrift, clauseDrift, pathMissing, numericMismatches, clauseRatio: clauseFidelity.clauseRatio },
                errMsg,
              )
              endPhase(storyKey, 'create-story')
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: errMsg,
                completedAt: new Date().toISOString(),
              })
              await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
              await emitEscalation({
                storyKey,
                lastVerdict: 'create-story-source-ac-drift',
                reviewCycles: 0,
                issues: [errMsg],
              })
              await persistState()
              return
            }
          }
        }
      } catch (fidelityErr) {
        // Fidelity gate is best-effort — never block the pipeline on a gate
        // bug. Verification phase backstop catches drift the gate misses.
        logger.warn(
          { storyKey, err: fidelityErr },
          'fidelity gate threw; proceeding without retry',
        )
      }
    }

    // -- F-probe shift-left: runtime-probe YAML validity gate --
    // Validate the rendered `## Runtime Probes` block with the SAME parser the
    // verification check uses (parseRuntimeProbes). create-story can author probes
    // as raw agent text (no `_authoredBy`), and a malformed block scalar — e.g. a
    // multi-line `command: |` embedding `git commit -m "...\n\nCo-Authored-By: ..."`
    // with an unindented trailer — only surfaced at verification → false escalation
    // (run c2874c68, story 77-6). Catch it at authoring and retry with targeted
    // guidance so a fixable YAML mistake costs a cheap re-dispatch, not a
    // verification-failure escalation. Runs only when the fidelity gate did not
    // already schedule a retry (storyFilePath still defined). Exhausting the budget
    // proceeds to dev-story — the verification check remains the backstop.
    if (storyFilePath !== undefined && effectiveProjectRoot !== undefined) {
      try {
        const probeContent = await readFile(storyFilePath, 'utf-8')
        const probeParse = parseRuntimeProbes(probeContent)
        if (probeParse.kind === 'invalid' && probeRetries < MAX_FIDELITY_RETRIES) {
          probeRetries++
          const stalePath = storyFilePath.replace(/\.md$/, `.stale-probe-${Date.now()}.md`)
          renameSync(storyFilePath, stalePath)
          logger.warn(
            { storyKey, error: probeParse.error, retries: probeRetries, stalePath },
            `create-story produced an invalid ## Runtime Probes block (${probeParse.error}); renamed to ${stalePath} and retrying (${probeRetries}/${MAX_FIDELITY_RETRIES})`,
          )
          eventBus.emit('orchestrator:story-warn', {
            storyKey,
            msg: `invalid runtime-probe YAML; retry ${probeRetries}/${MAX_FIDELITY_RETRIES}`,
          })
          priorDriftFeedback = [
            `### Prior Dispatch — Invalid Runtime Probes YAML (retry ${probeRetries}/${MAX_FIDELITY_RETRIES})`,
            '',
            `The previous artifact's \`## Runtime Probes\` block was not valid YAML and has been moved to \`${stalePath}\`.`,
            '',
            `Parse error: ${probeParse.error}`,
            '',
            'When re-authoring the probes, the fenced ```yaml block MUST be valid YAML:',
            '- Inside a `command: |` block scalar, EVERY line (including blank-line continuations) must be indented to at least the block indentation. A multi-line shell string with an unindented (column-0) line — e.g. a `git commit -m "subject\\n\\nCo-Authored-By: ..."` whose trailer sits at column 0 — terminates the scalar and breaks the YAML.',
            '- Prefer single-line commands, or keep every continuation line indented under the block scalar.',
          ].join('\n')
          storyFilePath = undefined
          continue
        }
        // invalid + budget exhausted, or absent/parsed → proceed (verification backstop)
      } catch (probeGateErr) {
        logger.warn(
          { storyKey, err: probeGateErr },
          'probe-validity gate threw; proceeding without retry (verification backstop)',
        )
      }
    }
    } // end while (storyFilePath === undefined)

    // -- interface contract parsing (Story 25-4: AC3) --
    // Parse the newly created (or pre-existing) story file for interface contract
    // declarations and persist them to the decision store so Story 25-5 dispatch
    // ordering and Story 25-6 verification can build a cross-story dependency graph.
    if (storyFilePath) {
      try {
        const storyContent = await readFile(storyFilePath, 'utf-8')
        const contracts = parseInterfaceContracts(storyContent, storyKey)
        if (contracts.length > 0) {
          // Persist contract declarations to the decision store (canonical surface).
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

    // -- probe-author phase (Story 60-13) --
    // Gate: runs between create-story and test-plan when the source AC is
    // event-driven AND the story artifact does not already have a
    // ## Runtime Probes section. Non-fatal — all failure modes fall through.
    //
    // Story 60-14: also gated on the effective probe-author mode resolved
    // at run start. When mode is 'disabled' (via --probe-author=disabled CLI
    // flag or SUBSTRATE_PROBE_AUTHOR_ENABLED=false env var), the entire
    // phase is skipped and dev-story falls back to dev-authored probes.
    // Powers the A/B validation harness comparing authored-vs-dev probe
    // catch rates against the defect-replay corpus.

    if (storyFilePath && _probeAuthorEffectiveMode === 'enabled') {
      try {
        // Resolve source epic content for the event-driven gate check.
        let probeAuthorEpicContent = ''
        const probeAuthorEpicsPath = findEpicFileForStory(effectiveProjectRoot ?? process.cwd(), storyKey)
        if (probeAuthorEpicsPath) {
          try {
            const epicFull = readFileSync(probeAuthorEpicsPath, 'utf-8')
            const section = extractStorySection(epicFull, storyKey)
            probeAuthorEpicContent = section ?? epicFull
          } catch {
            // Non-fatal: proceed without epic content; gate will skip if empty
          }
        }

        // Only fire the gate when the AC is event-driven or state-integrating AND the
        // artifact lacks probes. runProbeAuthor does the same checks internally, but the
        // external gate here avoids building the prompt and reading the file on stories
        // that match neither heuristic. Story 65-1 extends the gate with state-integrating
        // AC detection (subprocess, filesystem, git, database, network, registry).
        // Story 65-2: probeAuthorStateIntegrating=false skips detectsStateIntegratingAC()
        // branch so operators can ramp DOWN Phase 3 without modifying source code.
        const stateIntegratingEnabled = config.probeAuthorStateIntegrating !== false
        const isEventDriven = detectsEventDrivenAC(probeAuthorEpicContent)
        const isStateIntegrating = stateIntegratingEnabled && detectsStateIntegratingAC(probeAuthorEpicContent)
        if (isEventDriven || isStateIntegrating) {
          // Story 65-6: compute trigger-class discriminator from detector results.
          const triggerClass: ProbeAuthorTriggerClass =
            isEventDriven && isStateIntegrating ? 'both'
            : isStateIntegrating ? 'state-integrating'
            : 'event-driven'

          // Story 65-6: persist trigger class to manifest (best-effort, non-fatal).
          if (runManifest !== null && runManifest !== undefined) {
            runManifest
              .patchStoryState(storyKey, { probe_author_triggered_by: triggerClass })
              .catch((err: unknown) =>
                logger.warn({ err, storyKey }, 'patchStoryState(probe_author_triggered_by) failed — pipeline continues'),
              )
          }

          let artifactHasProbes = false
          try {
            const artifactContent = readFileSync(storyFilePath, 'utf-8')
            artifactHasProbes = /^## Runtime Probes/m.test(artifactContent)
          } catch {
            // Non-fatal: let runProbeAuthor decide
          }

          if (!artifactHasProbes) {
            const probeAuthorResult = await runProbeAuthor(
              { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
              {
                storyKey,
                storyFilePath,
                pipelineRunId: config.pipelineRunId ?? '',
                sourceAcContent: probeAuthorEpicContent,
                epicContent: probeAuthorEpicContent,
                stateIntegratingEnabled,
                triggerClass,
                emitEvent: (name, payload) => {
                  // Emit probe-author telemetry events on the orchestrator bus.
                  // These are informational/KPI events; we cast to satisfy the
                  // typed event bus until a dedicated event type is declared (60-15).
                  eventBus.emit('orchestrator:story-warn', {
                    storyKey,
                    msg: `probe-author:${name.replace('probe-author:', '')} ${JSON.stringify(payload)}`,
                  })
                },
              },
            )
            logger.info(
              { storyKey, result: probeAuthorResult.result, probesAuthoredCount: probeAuthorResult.probesAuthoredCount },
              'probe-author phase complete',
            )

            // Record probe-author token usage for per-story cost attribution (Story 57-4 pattern)
            if (config.pipelineRunId !== undefined && probeAuthorResult.tokenUsage.input + probeAuthorResult.tokenUsage.output > 0) {
              void Promise.resolve()
                .then(() => addTokenUsage(db, config.pipelineRunId!, {
                  phase: 'probe-author',
                  agent: 'probe-author',
                  input_tokens: probeAuthorResult.tokenUsage.input,
                  output_tokens: probeAuthorResult.tokenUsage.output,
                  cost_usd: estimateDispatchCost(probeAuthorResult.tokenUsage.input, probeAuthorResult.tokenUsage.output),
                  metadata: JSON.stringify({ storyKey }),
                }))
                .catch((tokenErr: unknown) =>
                  logger.warn({ storyKey, err: tokenErr }, 'Failed to record probe-author token usage'),
                )
            }
          } else {
            logger.debug({ storyKey }, 'probe-author: story artifact already has ## Runtime Probes — skipping gate')
          }
        } else {
          logger.debug({ storyKey }, 'probe-author: source AC not event-driven — skipping gate')
        }
      } catch (probeAuthorErr) {
        // The probe-author gate is non-fatal. If anything throws unexpectedly,
        // log and continue to the test-plan phase without authored probes.
        logger.warn(
          { storyKey, err: probeAuthorErr },
          'probe-author gate threw unexpectedly; proceeding to test-plan without authored probes',
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
        { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
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

    // Record test-plan token usage for accurate per-story cost attribution (Story 57-4: see notes above)
    if (config.pipelineRunId !== undefined && testPlanTokenUsage !== undefined) {
      void Promise.resolve()
        .then(() => addTokenUsage(db, config.pipelineRunId!, {
          phase: 'test-plan',
          agent: 'test-plan',
          input_tokens: testPlanTokenUsage.input,
          output_tokens: testPlanTokenUsage.output,
          cost_usd: estimateDispatchCost(testPlanTokenUsage.input, testPlanTokenUsage.output),
          metadata: JSON.stringify({ storyKey }),
        }))
        .catch((tokenErr: unknown) =>
          logger.warn({ storyKey, err: tokenErr }, 'Failed to record test-plan token usage'),
        )
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
    // Story 77-4: model the dispatcher resolved for the dev-story (primary)
    // implementation dispatch; threaded to endPhase so primary_model is populated.
    let devStoryModel: string | undefined
    // Story content and structured dev output forwarded to static Tier A verification.
    let storyContentForVerification: string | undefined
    let devStorySignals: DevStorySignals | undefined

    const normalizeDevStorySignals = (result: DevStorySignals | null | undefined): DevStorySignals | undefined => {
      if (result == null) return undefined
      return {
        result: result.result,
        ac_met: result.ac_met ?? [],
        ac_failures: result.ac_failures ?? [],
        files_modified: result.files_modified ?? [],
        tests: result.tests,
      }
    }

    const replaceDevStorySignals = (result: DevStorySignals | null | undefined): void => {
      const normalized = normalizeDevStorySignals(result)
      if (normalized !== undefined) devStorySignals = normalized
    }

    const mergeDevStorySignals = (result: DevStorySignals | null | undefined): void => {
      const normalized = normalizeDevStorySignals(result)
      if (normalized === undefined) return
      if (devStorySignals === undefined) {
        devStorySignals = normalized
        return
      }

      devStorySignals = {
        result: devStorySignals.result === 'failed' || normalized.result === 'failed'
          ? 'failed'
          : (normalized.result ?? devStorySignals.result),
        ac_met: Array.from(new Set([...(devStorySignals.ac_met ?? []), ...(normalized.ac_met ?? [])])),
        ac_failures: Array.from(new Set([...(devStorySignals.ac_failures ?? []), ...(normalized.ac_failures ?? [])])),
        files_modified: Array.from(new Set([...(devStorySignals.files_modified ?? []), ...(normalized.files_modified ?? [])])),
        tests: devStorySignals.tests === 'fail' || normalized.tests === 'fail'
          ? 'fail'
          : (normalized.tests ?? devStorySignals.tests),
      }
    }

    // Capture baseline HEAD SHA before dispatch so the zero-diff gate can
    // detect committed work (not just uncommitted changes).  Fixes the
    // false-escalation bug where an agent commits its work, leaving a clean
    // working tree that was incorrectly treated as zero-diff.
    let baselineHeadSha: string | undefined
    try {
      baselineHeadSha = execSync('git rev-parse HEAD', {
        cwd: effectiveProjectRoot ?? process.cwd(),
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      // No commits yet or git unavailable — leave undefined; zero-diff gate
      // will fall back to working-tree-only check.
    }

    // H0.1: persist the baseline immediately so the revision bracket's start
    // exists on EVERY terminal path — before this, commit_sha landed only on
    // the happy path and failure paths had a one-ended bracket precisely when
    // an operator needed to reconstruct what the story produced. Best-effort.
    if (baselineHeadSha !== undefined && runManifest !== null) {
      runManifest
        .patchStoryState(storyKey, { baseline_sha: baselineHeadSha })
        .catch((err: unknown) =>
          logger.warn({ err, storyKey }, 'patchStoryState(baseline_sha) failed — pipeline continues'),
        )
    }

    try {
      // Analyze story complexity to determine whether batching is needed (AC1, AC7)
      let storyContentForAnalysis = ''
      try {
        storyContentForAnalysis = await readFile(storyFilePath ?? '', 'utf-8')
        storyContentForVerification = storyContentForAnalysis
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
              { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
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
          mergeDevStorySignals(batchResult)
          // Story 77-4: capture the resolved model (same across batches; last wins)
          if (batchResult.model !== undefined) devStoryModel = batchResult.model

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

          // AC5: Store batch context in token_usage metadata JSON (Story 57-4: see notes above)
          if (config.pipelineRunId !== undefined && batchResult.tokenUsage !== undefined) {
            void Promise.resolve()
              .then(() => addTokenUsage(db, config.pipelineRunId!, {
                phase: 'dev-story',
                agent: `batch-${batch.batchIndex}`,
                input_tokens: batchResult.tokenUsage!.input,
                output_tokens: batchResult.tokenUsage!.output,
                cost_usd: estimateDispatchCost(batchResult.tokenUsage!.input, batchResult.tokenUsage!.output),
                metadata: JSON.stringify({
                  storyKey,
                  batchIndex: batch.batchIndex,
                  taskIds: batch.taskIds,
                  durationMs: batchDurationMs,
                  result: batchMetrics.result,
                }),
              }))
              .catch((tokenErr: unknown) =>
                logger.warn({ storyKey, batchIndex: batch.batchIndex, err: tokenErr }, 'Failed to record batch token usage'),
              )
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
          { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
            ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}),
            ...(storyOptions?.optimizationDirectives !== undefined ? { optimizationDirectives: storyOptions.optimizationDirectives } : {}) },
          {
            storyKey,
            storyFilePath: storyFilePath ?? '',
            pipelineRunId: config.pipelineRunId,
          },
        )

        devFilesModified = devResult.files_modified ?? []
        // Story 77-4: capture the resolved model for primary_model telemetry
        if (devResult.model !== undefined) devStoryModel = devResult.model
        // Capture output tokens for TrivialOutputCheck (Story 51-5)
        devOutputTokenCount = devResult.tokenUsage?.output ?? undefined

        // Record single-dispatch dev-story token usage for per-story cost attribution
        if (config.pipelineRunId !== undefined && devResult.tokenUsage !== undefined) {
          // Story 57-4: see notes above
          void Promise.resolve()
            .then(() => addTokenUsage(db, config.pipelineRunId!, {
              phase: 'dev-story',
              agent: 'dev-story',
              input_tokens: devResult.tokenUsage!.input,
              output_tokens: devResult.tokenUsage!.output,
              cost_usd: estimateDispatchCost(devResult.tokenUsage!.input, devResult.tokenUsage!.output),
              metadata: JSON.stringify({ storyKey }),
            }))
            .catch((tokenErr: unknown) =>
              logger.warn({ storyKey, err: tokenErr }, 'Failed to record dev-story token usage'),
            )
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
          endPhase(storyKey, 'dev-story', devStoryModel)
          const timeoutFiles = checkGitDiffFiles(effectiveProjectRoot ?? process.cwd())

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
                cwd: effectiveProjectRoot ?? process.cwd(),
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
            // v0.20.114 (F-timeout): longer window than the first attempt — the
            // retry resumes partial work, so it shouldn't re-hit the 30-min wall.
            timeout: CHECKPOINT_RETRY_TIMEOUT_MS,
            outputSchema: DevStoryResultSchema,
            ...(checkpointRetryMaxTurns !== undefined ? { maxTurns: checkpointRetryMaxTurns } : {}),
            ...(effectiveProjectRoot !== undefined ? { workingDirectory: effectiveProjectRoot } : {}),
            ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            ...(config.perStoryContextCeilings?.[storyKey] !== undefined
              ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
              : {}),
            storyKey,
          })
          const checkpointRetryResult = await checkpointRetryHandle.result
          // Story 77-4: retry resolves the same model; capture for primary_model
          if (checkpointRetryResult.model !== undefined) devStoryModel = checkpointRetryResult.model
          endPhase(storyKey, 'dev-story-retry', checkpointRetryResult.model)

          // Story 77-4: the dev-story-timeout checkpoint retry is a recovery
          // action — record it in recovery_history (outcome reflects whether the
          // retry produced a result or timed out again).
          if (runManifest) {
            runManifest
              .appendRecoveryEntry({
                story_key: storyKey,
                attempt_number: _storyDispatches.get(storyKey) ?? 1,
                strategy: 'dev-story-timeout-checkpoint-retry',
                root_cause: 'checkpoint-retry-timeout',
                outcome: checkpointRetryResult.status === 'timeout' ? 'escalated' : 'retried',
                cost_usd: 0,
                timestamp: new Date().toISOString(),
              })
              .catch((err: unknown) =>
                logger.warn({ err, storyKey }, 'appendRecoveryEntry(checkpoint-retry) failed — pipeline continues'),
              )
          }

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
            // NOTE: do NOT call endPhase(storyKey, 'dev-story', devStoryModel) here — it was already
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
          replaceDevStorySignals(retryParsed as DevStorySignals | null | undefined)
          devFilesModified = retryParsed?.files_modified ?? checkGitDiffFiles(effectiveProjectRoot ?? process.cwd())
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
          replaceDevStorySignals(devResult)
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
      endPhase(storyKey, 'dev-story', devStoryModel)
      updateStory(storyKey, {
        phase: 'ESCALATED' as StoryPhase,
        error: errMsg,
        completedAt: new Date().toISOString(),
      })
      await writeStoryMetricsBestEffort(storyKey, 'failed', 0)
      // H0.4 (field finding #10): classify auth deaths and halt the run —
      // same treatment as the create-story site.
      const devAuthSignature = detectClaudeAuthFailure(errMsg)
      if (devAuthSignature !== null) {
        await emitEscalation({
          storyKey,
          lastVerdict: 'auth-failure',
          reviewCycles: 0,
          issues: [errMsg, CLAUDE_AUTH_FAILURE_HINT],
          escalationReason: 'auth-failure',
        })
        await triggerAuthFailureHalt(storyKey, devAuthSignature)
        await persistState()
        return
      }
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
    // H1.7: pre-existing tracked files the story touched (captured pre-commit,
    // same moment as the ground-truth diff) — feeds the reward-hack tripwire.
    let modifiedTrackedFiles: string[] | undefined
    if (devStoryWasSuccess) {
      gitDiffFiles = checkGitDiffFiles(effectiveProjectRoot ?? process.cwd())
      // Best-effort: the tripwire is advisory — a missing/failing capture
      // (e.g. partially-mocked module in tests) degrades to no-signal, never
      // breaks the story flow.
      try {
        modifiedTrackedFiles = checkGitModifiedTrackedFiles(effectiveProjectRoot ?? process.cwd(), baselineHeadSha)
      } catch {
        modifiedTrackedFiles = undefined
      }
      if (gitDiffFiles.length === 0) {
        // Before escalating, check whether HEAD has moved since baseline.
        // If the agent committed its work, the working tree is clean but
        // new commits exist — that's real work, not a phantom completion.
        let hasNewCommits = false
        if (baselineHeadSha) {
          try {
            const currentHead = execSync('git rev-parse HEAD', {
              cwd: effectiveProjectRoot ?? process.cwd(),
              encoding: 'utf-8',
              timeout: 3000,
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()
            hasNewCommits = currentHead !== baselineHeadSha
          } catch {
            // git failed — fall through to escalation
          }
        }

        if (hasNewCommits && baselineHeadSha) {
          // Recover the file list from the committed diff (baseline..HEAD)
          try {
            const committedFiles = execSync(`git diff --name-only ${baselineHeadSha}..HEAD`, {
              cwd: effectiveProjectRoot ?? process.cwd(),
              encoding: 'utf-8',
              timeout: 5000,
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()
            if (committedFiles.length > 0) {
              gitDiffFiles = committedFiles.split('\n').filter(Boolean)
            }
          } catch {
            // git failed — gitDiffFiles stays empty, code review will use baselineCommit fallback
          }
          logger.info(
            { storyKey, baselineHeadSha, committedFileCount: gitDiffFiles?.length ?? 0 },
            'Working tree clean but new commits detected since dispatch — skipping zero-diff escalation',
          )
        } else {
          // obs_2026-05-26_028: before emitting the opaque zero-diff verdict,
          // check whether the dev-story output actually landed in the MAIN
          // checkout instead of this story's worktree (a cwd misroute). In
          // worktree mode the main tree should be clean during a dispatch; if
          // it carries uncommitted changes, the work isn't lost — it's in the
          // wrong tree, and reconcile-from-disk (which inspects the branch)
          // won't find it. Surface that specific, actionable cause rather than
          // sending the operator hunting. Best-effort, additive diagnostic — we
          // still escalate (the worktree genuinely has no changes).
          const outsideWorktreeFiles = detectWorkOutsideWorktree(
            effectiveProjectRoot,
            projectRoot,
            checkGitDiffFiles,
          )
          const misrouted = outsideWorktreeFiles.length > 0

          logger.warn(
            { storyKey, misrouteSuspected: misrouted, outsideWorktreeFileCount: outsideWorktreeFiles.length },
            misrouted
              ? 'Zero-diff in worktree, but the MAIN checkout has uncommitted changes — dev-story output likely landed outside the story worktree (cwd misroute)'
              : 'Zero-diff detected after COMPLETE dev-story — no file changes and no new commits',
          )
          eventBus.emit('orchestrator:zero-diff-escalation', {
            storyKey,
            reason: 'zero-diff-on-complete',
          })
          endPhase(storyKey, 'dev-story', devStoryModel)
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: 'zero-diff-on-complete',
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
          const zeroDiffIssues = ['dev-story completed with COMPLETE verdict but no file changes detected in git diff']
          if (misrouted) {
            zeroDiffIssues.push(
              `Work appears to have landed in the MAIN checkout instead of the story worktree ` +
                `(${outsideWorktreeFiles.length} uncommitted file(s) at ${projectRoot as string}; e.g. ` +
                `${outsideWorktreeFiles.slice(0, 5).join(', ')}). The output is not lost — inspect ` +
                `\`git -C ${projectRoot as string} status\`. reconcile-from-disk inspects the branch/worktree, not main, so it will not pick this up.`,
            )
          }
          await emitEscalation({
            storyKey,
            lastVerdict: 'zero-diff-on-complete',
            reviewCycles: 0,
            issues: zeroDiffIssues,
          })
          await persistState()
          return
        }
      }
    }

    // -- net-new-implementation gate (H1.4, field finding #13) --
    // A dev-story that reports success but whose ground-truth diff contains
    // ONLY pipeline artifacts (the story spec .md, manifest state) produced
    // no implementation — the field case sailed to COMPLETE with "239 tests
    // pass" (the pre-existing suite) and only the spec file on the branch.
    // Escalate with a named reason instead of letting self-reported success
    // stand in for work.
    if (devStoryWasSuccess && gitDiffFiles !== undefined && gitDiffFiles.length > 0) {
      const implClassification = classifyImplementationDiff(gitDiffFiles)
      // H7 (empty-stub / noop-whitespace, red-team): the path-based check is
      // content-blind — an empty stub file or a whitespace-only edit registers
      // a non-artifact PATH and reads as "implementation". Measure real added
      // lines with `-w` (ignore all whitespace): an empty file adds 0, a
      // whitespace-only edit adds 0, a pure deletion adds 0. (Comment-only
      // stubs still pass — catching those needs language-aware parsing.)
      let implAddedLines: number | undefined
      if (implClassification.hasImplementation && baselineHeadSha) {
        const numstatCwd = effectiveProjectRoot ?? process.cwd()
        try {
          // This gate runs BEFORE commit-first, so the dev output is an
          // uncommitted (often untracked) working-tree change. `git diff HEAD`
          // ignores untracked files, so mark intent-to-add first (records paths
          // only, no content staged), measure, then reset to restore the exact
          // pre-gate index state (commit-first re-stages afterward).
          execSync('git add -N -A', { cwd: numstatCwd, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
          const numstat = execSync('git diff -w --numstat HEAD', {
            cwd: numstatCwd,
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          try {
            execSync('git reset -q', { cwd: numstatCwd, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
          } catch {
            // best-effort restore; commit-first re-stages regardless
          }
          const isArtifactPath = (f: string): boolean => {
            const n = f.replace(/\\/g, '/').replace(/^\.\//, '')
            return n.startsWith('_bmad-output/') || n.startsWith('.substrate/')
          }
          // Rows for NON-ARTIFACT files only. `-` in the added column marks a
          // binary file (unmeasurable) — exclude so binaries don't read as 0.
          const implRows = numstat
            .split('\n')
            .map((line) => line.split('\t'))
            .filter((cols) => cols.length === 3 && cols[0] !== '-' && !isArtifactPath(cols[2]!))
          // Only conclude "zero added" when numstat ACTUALLY produced
          // implementation-file rows. An empty/absent numstat (git failure,
          // no data) leaves implAddedLines undefined → the gate is skipped and
          // the path-based classification (already passed) stands. This avoids
          // false-escalating when the diff data is simply unavailable.
          implAddedLines =
            implRows.length > 0
              ? implRows.reduce((sum, cols) => sum + (Number.parseInt(cols[0]!, 10) || 0), 0)
              : undefined
        } catch {
          implAddedLines = undefined // git unavailable — fall back to path-based only
        }
      }
      if (implClassification.hasImplementation && implAddedLines === 0) {
        logger.warn(
          { storyKey, changed: gitDiffFiles.slice(0, 10) },
          'dev-story reported success but its implementation files added zero non-whitespace lines (empty stub / whitespace-only / pure deletion) — escalating no-implementation',
        )
        endPhase(storyKey, 'dev-story', devStoryModel)
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: 'no-implementation',
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
        await emitEscalation({
          storyKey,
          lastVerdict: 'no-implementation',
          reviewCycles: 0,
          issues: [
            `dev-story reported COMPLETE and touched non-artifact files, but added ZERO non-whitespace lines to any of them ` +
              `(${gitDiffFiles.slice(0, 10).join(', ')}) — the "implementation" is an empty stub, a whitespace-only edit, or a pure deletion.`,
          ],
          escalationReason: 'no-implementation',
        })
        await persistState()
        return
      }
      if (!implClassification.hasImplementation) {
        logger.warn(
          { storyKey, artifactFiles: implClassification.artifactOnly.slice(0, 10) },
          'dev-story reported success but the diff contains only pipeline artifacts — no implementation was produced',
        )
        endPhase(storyKey, 'dev-story', devStoryModel)
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          error: 'no-implementation',
          completedAt: new Date().toISOString(),
        })
        await writeStoryMetricsBestEffort(storyKey, 'escalated', 0)
        await emitEscalation({
          storyKey,
          lastVerdict: 'no-implementation',
          reviewCycles: 0,
          issues: [
            `dev-story reported COMPLETE but every changed file is a pipeline artifact (${implClassification.artifactOnly.slice(0, 10).join(', ')}) — no source or test files were produced. ` +
              `Self-reported test results on such a story are vacuous (they exercise the pre-existing suite).`,
          ],
          escalationReason: 'no-implementation',
        })
        await persistState()
        return
      }
    }

    // -- commit-first (H0.1, field findings #1/#17) --
    // The story branch, not the worktree's working tree, must be the durable
    // source of truth from the moment dev-story returns. Before this, the
    // deliverable commit fired only inside the SHIP_IT/LGTM finalize block —
    // auto-approved, escalated, and verification-failed stories all left
    // their ONLY copy as uncommitted files that `worktree remove --force`
    // destroyed (income-sources stories 4-3, 5-1). Worktree mode only:
    // under --no-worktree the documented contract is that work lands
    // uncommitted in the operator's own tree.
    let _devOutputCommitHookFailure: string | undefined
    const _commitFirstEligible =
      !noWorktree &&
      _worktreeManager !== undefined &&
      effectiveProjectRoot !== undefined &&
      effectiveProjectRoot !== projectRoot
    if (_commitFirstEligible && effectiveProjectRoot !== undefined) {
      const dirtyNow = await getGitChangedFiles(effectiveProjectRoot)
      if (dirtyNow.length > 0) {
        if (devStoryWasSuccess) {
          // Deliverable commit — hooks fire, same as the finalize-time commit.
          const earlyCommit = await commitDevStoryOutput(
            storyKey,
            _capturedStoryTitle,
            dirtyNow,
            effectiveProjectRoot,
          )
          if (earlyCommit.status === 'committed') {
            logger.info(
              { storyKey, sha: earlyCommit.sha, fileCount: earlyCommit.filesStaged.length },
              'commit-first: dev-story output committed to story branch',
            )
            if (runManifest !== null && earlyCommit.sha) {
              runManifest
                .patchStoryState(storyKey, { commit_sha: earlyCommit.sha })
                .catch((err: unknown) =>
                  logger.warn({ err, storyKey }, 'patchStoryState(commit_sha, commit-first) failed — pipeline continues'),
                )
            }
          } else if (earlyCommit.status === 'failed') {
            // Hooks rejected the deliverable commit. Don't escalate yet —
            // review/fix cycles may resolve the hook complaint — but the work
            // must be durable NOW: checkpoint with hooks bypassed and remember
            // the hook output so finalize can escalate dev-story-commit-failed
            // if it never gets resolved.
            _devOutputCommitHookFailure = earlyCommit.stderr
            const cp = await checkpointStoryWorktree(
              storyKey,
              'dev-story output (deliverable commit rejected by hooks)',
              effectiveProjectRoot,
            )
            logger.warn(
              { storyKey, checkpoint: cp.status, hookStderr: earlyCommit.stderr.slice(0, 500) },
              'commit-first: hooks rejected feat commit — work preserved as wip checkpoint',
            )
            if (cp.status === 'committed' && runManifest !== null && cp.sha) {
              runManifest
                .patchStoryState(storyKey, { checkpoint_sha: cp.sha })
                .catch((err: unknown) =>
                  logger.warn({ err, storyKey }, 'patchStoryState(checkpoint_sha) failed — pipeline continues'),
                )
            }
          }
          // no-changes: nothing dirty despite the earlier list — benign race;
          // the zero-diff gate above already vouched for real work.
        } else {
          // Partial/failed dev output heading into review: checkpoint so the
          // branch carries it even if the story later escalates.
          const cp = await checkpointStoryWorktree(storyKey, 'dev-story partial output', effectiveProjectRoot)
          if (cp.status === 'committed') {
            logger.info({ storyKey, sha: cp.sha }, 'commit-first: partial dev-story output checkpointed')
            if (runManifest !== null && cp.sha) {
              runManifest
                .patchStoryState(storyKey, { checkpoint_sha: cp.sha })
                .catch((err: unknown) =>
                  logger.warn({ err, storyKey }, 'patchStoryState(checkpoint_sha) failed — pipeline continues'),
                )
            }
          }
        }
      }
    }

    // -- code-review phase (with retry/rework) --
    endPhase(storyKey, 'dev-story', devStoryModel)

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
            projectRoot: effectiveProjectRoot ?? process.cwd(),
            changedFiles: gitDiffFiles,
          })

      if (buildVerifyResult.status === 'passed') {
        // Secondary typecheck: catch type errors the bundler may skip (e.g., empty modules).
        // Uses tsconfig.typecheck.json when available — it includes src/**/*.ts which catches
        // monolith-level type mismatches that project-reference-only builds miss.
        const resolvedRootForTsc = effectiveProjectRoot ?? process.cwd()
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
          const resolvedRoot = effectiveProjectRoot ?? process.cwd()
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

          const resolvedRoot = effectiveProjectRoot ?? process.cwd()
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
                workingDirectory: effectiveProjectRoot ?? process.cwd(),
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
                projectRoot: effectiveProjectRoot ?? process.cwd(),
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
            // Story 72-1: Route build-verification-failure through the autonomy policy
            let buildHaltPolicy: 'all' | 'critical' | 'none' = 'critical'
            if (runManifest !== null && runManifest !== undefined) {
              try {
                const manifestData = await runManifest.read()
                buildHaltPolicy = ((manifestData.cli_flags.halt_on as string | undefined) ?? 'critical') as 'all' | 'critical' | 'none'
              } catch { /* use default */ }
            }
            const buildRouteResult = routeDecision('build-verification-failure', buildHaltPolicy)
            const buildRunId = config.pipelineRunId ?? 'unknown'
            const buildReason = `build verification failed for story ${storyKey}`

            if (buildRouteResult.halt) {
              eventBus.emit('decision:halt', {
                runId: buildRunId,
                decisionType: 'build-verification-failure',
                severity: buildRouteResult.severity,
                reason: buildReason,
              })
              // Story 73-2: Invoke interactive prompt when Decision Router halts.
              // runInteractivePrompt handles non-interactive bypass internally
              // (checks SUBSTRATE_NON_INTERACTIVE env var) and emits
              // decision:halt-skipped-non-interactive via onHaltSkipped callback.
              await runInteractivePrompt({
                runId: buildRunId,
                decisionType: 'build-verification-failure',
                severity: buildRouteResult.severity,
                summary: buildReason,
                defaultAction: buildRouteResult.defaultAction,
                choices: ['escalate-without-halt', 'retry-with-custom-context', 'propose-re-scope', 'abort-run'],
                onHaltSkipped: (payload) => {
                  eventBus.emit('decision:halt-skipped-non-interactive', payload)
                },
              }).catch((err: unknown) => {
                logger.warn({ err, storyKey }, 'interactive prompt failed — continuing with default action')
              })
            } else {
              eventBus.emit('decision:autonomous', {
                runId: buildRunId,
                decisionType: 'build-verification-failure',
                severity: buildRouteResult.severity,
                defaultAction: buildRouteResult.defaultAction,
                reason: buildReason,
              })
            }

            eventBus.emit('story:build-verification-failed', {
              storyKey,
              exitCode: buildVerifyResult.exitCode ?? 1,
              output: truncatedOutput,
            })

            logger.warn(
              { storyKey, reason, exitCode: buildVerifyResult.exitCode, routedHalt: buildRouteResult.halt, defaultAction: buildRouteResult.defaultAction },
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
            projectRoot: effectiveProjectRoot ?? process.cwd(),
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
            // Persist for post-run telemetry reporting (mesh-reporter reads this)
            if (config.pipelineRunId !== undefined) {
              createDecision(db, {
                pipeline_run_id: config.pipelineRunId,
                phase: 'implementation',
                category: 'INTERFACE_WARNING',
                key: `${storyKey}:${config.pipelineRunId}`,
                value: JSON.stringify({
                  modifiedInterfaces: icResult.modifiedInterfaces,
                  potentiallyAffectedTests: icResult.potentiallyAffectedTests,
                }),
              }).catch(swallowDebug('orchestrator-best-effort')) // Best-effort — never block pipeline
            }
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
    // Story 62-4: schema-validation phantoms (malformed agent output) get
    // their own retry counter independent of the standard retry budget. The
    // cycle didn't produce review work, only formatting failure, so it
    // shouldn't burn slots that genuine review failures need. Capped to
    // prevent infinite-loop on persistent malformed output.
    let schemaValidationRetries = 0
    let previousIterationWasMalformed = false
    const MAX_SCHEMA_VALIDATION_RETRIES = 3

    // Story 61-8: shared verification + COMPLETE transition for the three
    // call sites that previously inlined the same ~80 lines of logic:
    //   1. SHIP_IT/LGTM_WITH_NOTES happy path
    //   2. NEEDS_MINOR_FIXES at-limit auto-approve (cycles exhausted)
    //   3. NEEDS_MINOR_FIXES timeout auto-approve (Story 61-6, fix dispatch timed out)
    //
    // Returns 'verification-failed' when Tier A verification rejects the
    // implementation (caller should return out of processStory). Returns
    // 'completed' when the story made it to COMPLETE; caller may then
    // execute site-specific post-amble (e.g., advisory notes / efficiency
    // scoring at the SHIP_IT site, or `keepReviewing = false; return` at
    // the auto-approve sites).
    //
    // `autoApprove` differentiates the SHIP_IT site (undefined) from the
    // two auto-approve sites (set, with the `story:auto-approved` event
    // payload context). `downgradeLastVerdict` is the 61-6 timeout case
    // where the recorded verdict is explicitly downgraded to
    // LGTM_WITH_NOTES on the COMPLETE state record.
    // H1.5 (fixture-matrix catch): ground truth for RE-verification. With
    // commit-first, the story's work is committed by verification time — a
    // plain `git status` capture is empty on retries. The story's real change
    // set = committed baseline..HEAD plus anything still dirty.
    function recaptureChangedFiles(root: string): string[] {
      const files = new Set<string>()
      if (baselineHeadSha) {
        try {
          execSync(`git diff --name-only ${baselineHeadSha}..HEAD`, {
            cwd: root,
            encoding: 'utf-8',
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .forEach((f) => files.add(f))
        } catch {
          // baseline diff unavailable — fall through to dirty capture
        }
      }
      for (const f of checkGitDiffFiles(root)) files.add(f)
      return [...files]
    }

    async function runVerificationAndComplete(args: {
      recordedVerdict: string
      finalReviewCycles: number
      reviewResult: Awaited<ReturnType<typeof runCodeReview>> | undefined
      autoApprove?: {
        issueCount: number
        reason: string
        downgradeLastVerdict?: string
      }
    }): Promise<'completed' | 'verification-failed'> {
      const { recordedVerdict, finalReviewCycles, reviewResult, autoApprove } = args
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
        // Story 58-2: scope sourceEpicContent to the specific story's section
        // from the epic file (avoids cross-story drift findings).
        // Story 61-3: per-epic-file fallback via findEpicFileForStory.
        let sourceEpicContent: string | undefined
        const epicsPath = findEpicFileForStory(effectiveProjectRoot ?? process.cwd(), storyKey)
        if (epicsPath) {
          try {
            const epicFull = readFileSync(epicsPath, 'utf-8')
            const section = extractStorySection(epicFull, storyKey)
            if (section) sourceEpicContent = section
          } catch {
            // non-fatal — SourceAcFidelityCheck will emit warn finding
          }
        }
        // Story 60-8: persist dev-story signals to manifest BEFORE verification
        // so the same signals fed into the verification context are durably recorded.
        await persistDevStorySignals(storyKey, devStorySignals, runManifest)
        const verifContext = assembleVerificationContext({
          storyKey,
          workingDir: effectiveProjectRoot ?? process.cwd(),
          // H7 (trust-boundary): security-relevant profile fields (languages,
          // testCommand) are read from the main tree, not the agent's worktree.
          ...(projectRoot !== undefined ? { trustedProfileDir: projectRoot } : {}),
          reviewResult: latestReviewSignals,
          storyContent: storyContentForVerification,
          devStoryResult: devStorySignals,
          outputTokenCount: devOutputTokenCount,
          sourceEpicContent,
          // H1.5: ground-truth diff for the contamination gate.
          ...(gitDiffFiles !== undefined ? { changedFiles: gitDiffFiles } : {}),
          // H1.7: pre-existing tracked files (reward-hack tripwire).
          ...(modifiedTrackedFiles !== undefined ? { modifiedTrackedFiles } : {}),
          // Story 74-2: stamp findings written by the verification → learning
          // bridge with the active pipeline run id.
          runId: config.pipelineRunId,
        })
        const verifSummary = await verificationPipeline.run(verifContext, 'A')
        verificationStore.set(storyKey, verifSummary)
        // Story 52-7 / 57-2: persist verification result to run manifest before any
        // terminal phase transition so result survives crashes; awaited so
        // verification_result is flushed before COMPLETE transition.
        await persistVerificationResult(storyKey, verifSummary, runManifest)
        if (verifSummary.status === 'fail') {
          // Story 73-1: Recovery Engine — invoke instead of marking story directly failed.
          // Classifies the failure, emits tier-appropriate events, appends proposals,
          // and applies back-pressure. The orchestrator acts on the returned action.
          // AC9: handles all four result branches — retry (Tier A), propose (Tier B),
          //      halt (Tier C), halt-entire-run (safety valve >= 5 proposals).
          let shouldFallThroughToComplete = false

          // Derived once at this scope (not inside the runManifest block) so the
          // VERIFICATION_FAILED terminal finalizer below can reuse it for
          // escalation_reason (F-ac2gap, 77-4 AC2 follow-up).
          const verificationFailReason = (verifSummary.checks ?? []).some(
            (c) => (c.checkName === 'build' || c.checkName === 'typecheck') && c.status === 'fail',
          )
            ? 'build-failure'
            : 'ac-missing-evidence'

          if (runManifest != null) {
            // Derive root cause from verification findings (best-effort)
            const failFindings = (verifSummary.checks ?? []).flatMap((c) => c.findings ?? [])
            const recoveryRootCause = verificationFailReason
            const recoveryBudget = {
              max: config.maxReviewCycles,
              remaining: Math.max(0, config.maxReviewCycles - finalReviewCycles),
            }

            const recoveryResult = await runRecoveryEngine({
              runId: config.pipelineRunId ?? storyKey,
              storyKey,
              failure: {
                rootCause: recoveryRootCause,
                findings: failFindings,
              },
              budget: recoveryBudget,
              bus: toSdlcEventBus(eventBus),
              manifest: runManifest,
              adapter: db,
              engine: 'linear', // conservative: no work-graph dependency resolution in orchestrator
            }).catch((recoveryErr: unknown) => {
              logger.warn(
                { storyKey, err: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr) },
                'Recovery Engine invocation failed — falling through to VERIFICATION_FAILED (best-effort)',
              )
              return null
            })

            if (recoveryResult?.action === 'halt-entire-run') {
              // Safety valve: >= 5 pending proposals — halt the entire run (AC6).
              // Reuse _budgetExhausted to stop the dispatch loop (exit main loop).
              logger.error(
                { storyKey, pendingProposalsCount: recoveryResult.pendingProposalsCount },
                'Recovery Engine safety valve: halting entire run due to >= 5 pending proposals',
              )
              // Story 77-4: record the run-level halt recovery action against this story.
              if (runManifest) {
                runManifest
                  .appendRecoveryEntry({
                    story_key: storyKey,
                    attempt_number: finalReviewCycles + 1,
                    strategy: 'halt-entire-run',
                    root_cause: recoveryRootCause,
                    outcome: 'escalated',
                    cost_usd: 0,
                    timestamp: new Date().toISOString(),
                  })
                  .catch((err: unknown) =>
                    logger.warn({ err, storyKey }, 'appendRecoveryEntry(halt-entire-run) failed — pipeline continues'),
                  )
              }
              _budgetExhausted = true
              // fall through to VERIFICATION_FAILED below
            } else if (recoveryResult?.action === 'retry') {
              // AC2 / AC9: Tier A — re-dispatch dev-story with enriched prompt (diagnosis +
              // findings prepended), then re-run Tier A verification pipeline.
              logger.info(
                { storyKey, attempt: recoveryResult.attempt, retryBudgetRemaining: recoveryResult.retryBudgetRemaining },
                'Recovery Engine Tier A: re-dispatching dev-story with enriched prompt',
              )
              try {
                incrementDispatches(storyKey)
                const retryDevResult = await runDevStory(
                  { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId },
                  {
                    storyKey,
                    storyFilePath: storyFilePath ?? '',
                    pipelineRunId: config.pipelineRunId,
                    findingsPrompt: recoveryResult.enrichedPrompt,
                  },
                )
                replaceDevStorySignals(retryDevResult)
                // Re-run Tier A verification after recovery retry (AC2: reuse runVerificationPipeline)
                await persistDevStorySignals(storyKey, devStorySignals, runManifest)
                const retryVerifContext = assembleVerificationContext({
                  storyKey,
                  workingDir: effectiveProjectRoot ?? process.cwd(),
                  // H7 (trust-boundary): trusted profile from the main tree.
                  ...(projectRoot !== undefined ? { trustedProfileDir: projectRoot } : {}),
                  reviewResult: latestReviewSignals,
                  storyContent: storyContentForVerification,
                  devStoryResult: devStorySignals,
                  outputTokenCount: devOutputTokenCount,
                  sourceEpicContent,
                  // H1.5/H1.7 (fixture-matrix catch): the RETRY verification
                  // must see the same ground-truth signals as the first pass —
                  // without them, a contamination FAIL was retried into a
                  // context whose contamination check had nothing to inspect,
                  // passed, and the contaminated story MERGED. Re-capture
                  // fresh (the retry dispatch may have changed the tree).
                  ...(effectiveProjectRoot !== undefined
                    ? { changedFiles: recaptureChangedFiles(effectiveProjectRoot) }
                    : {}),
                  // H7 review (merged_bug_001 site 2): recapture the tracked-file
                  // set fresh too — the retry dispatch may have modified more
                  // tracked (test) files; reusing the pre-retry snapshot blinded
                  // TestMutationCheck on the retry path.
                  ...(effectiveProjectRoot !== undefined
                    ? { modifiedTrackedFiles: checkGitModifiedTrackedFiles(effectiveProjectRoot, baselineHeadSha) }
                    : {}),
                  // Story 74-2: stamp findings written by the verification →
                  // learning bridge with the active pipeline run id.
                  runId: config.pipelineRunId,
                })
                const retryVerifSummary = await verificationPipeline.run(retryVerifContext, 'A')
                verificationStore.set(storyKey, retryVerifSummary)
                await persistVerificationResult(storyKey, retryVerifSummary, runManifest)
                const tierARecovered = retryVerifSummary.status !== 'fail'
                // Story 77-4: record this Tier A recovery action in recovery_history.
                if (runManifest) {
                  runManifest
                    .appendRecoveryEntry({
                      story_key: storyKey,
                      attempt_number: recoveryResult.attempt,
                      strategy: 'tier-a-retry-with-context',
                      root_cause: recoveryRootCause,
                      outcome: tierARecovered ? 'recovered' : 'retried',
                      cost_usd: 0,
                      timestamp: new Date().toISOString(),
                    })
                    .catch((err: unknown) =>
                      logger.warn({ err, storyKey }, 'appendRecoveryEntry(tier-a) failed — pipeline continues'),
                    )
                }
                if (tierARecovered) {
                  // Retry passed — fall through to COMPLETE (do not mark VERIFICATION_FAILED)
                  logger.info({ storyKey }, 'Recovery Engine Tier A retry succeeded — story proceeding to COMPLETE')
                  shouldFallThroughToComplete = true
                } else {
                  logger.warn({ storyKey }, 'Recovery Engine Tier A retry still failed — falling through to VERIFICATION_FAILED')
                }
              } catch (retryErr) {
                logger.warn(
                  { storyKey, err: retryErr instanceof Error ? retryErr.message : String(retryErr) },
                  'Recovery Engine Tier A re-dispatch threw — falling through to VERIFICATION_FAILED',
                )
              }
            } else if (recoveryResult?.action === 'propose') {
              // AC9 Tier B: re-scope proposal appended — mark ESCALATED, not VERIFICATION_FAILED.
              // Back-pressure is already applied by Recovery Engine (pauses dependent dispatches).
              logger.info({ storyKey }, 'Recovery Engine Tier B: proposal appended — marking story ESCALATED for operator re-scope')
              // Story 77-4: record the Tier B re-scope recovery action.
              if (runManifest) {
                runManifest
                  .appendRecoveryEntry({
                    story_key: storyKey,
                    attempt_number: finalReviewCycles + 1,
                    strategy: 'tier-b-re-scope-proposal',
                    root_cause: recoveryRootCause,
                    outcome: 'escalated',
                    cost_usd: 0,
                    timestamp: new Date().toISOString(),
                  })
                  .catch((err: unknown) =>
                    logger.warn({ err, storyKey }, 'appendRecoveryEntry(tier-b) failed — pipeline continues'),
                  )
              }
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                completedAt: new Date().toISOString(),
                error: 'recovery-engine-propose',
              })
              await emitEscalation({
                storyKey,
                lastVerdict: 'recovery-propose',
                reviewCycles: finalReviewCycles,
                issues: failFindings,
                escalationReason: recoveryRootCause,
              })
              await writeStoryMetricsBestEffort(storyKey, 'escalated', finalReviewCycles)
              await persistState()
              return 'verification-failed'
            } else if (recoveryResult?.action === 'halt') {
              // AC9 Tier C: operator intervention required — invoke interactive prompt, then ESCALATE.
              // Story 73-2 handles the interactive prompt; this site invokes it.
              logger.warn({ storyKey }, 'Recovery Engine Tier C: halt — invoking interactive prompt for operator decision')
              const haltRunId = config.pipelineRunId ?? storyKey
              await runInteractivePrompt({
                runId: haltRunId,
                decisionType: 'verification-failure',
                severity: 'critical',
                summary: `Verification failed (Tier C halt) on story ${storyKey}: ${recoveryRootCause}`,
                defaultAction: 'escalate',
                choices: ['escalate-without-halt', 'propose-re-scope', 'abort-run'],
                onHaltSkipped: (haltPayload) => {
                  eventBus.emit('decision:halt-skipped-non-interactive', haltPayload)
                },
              }).catch((err: unknown) => {
                logger.warn({ err, storyKey }, 'Recovery Engine Tier C: interactive prompt failed — escalating anyway')
              })
              // Story 77-4: record the Tier C halt recovery action.
              if (runManifest) {
                runManifest
                  .appendRecoveryEntry({
                    story_key: storyKey,
                    attempt_number: finalReviewCycles + 1,
                    strategy: 'tier-c-halt',
                    root_cause: recoveryRootCause,
                    outcome: 'escalated',
                    cost_usd: 0,
                    timestamp: new Date().toISOString(),
                  })
                  .catch((err: unknown) =>
                    logger.warn({ err, storyKey }, 'appendRecoveryEntry(tier-c) failed — pipeline continues'),
                  )
              }
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                completedAt: new Date().toISOString(),
                error: 'recovery-engine-halt',
              })
              await emitEscalation({
                storyKey,
                lastVerdict: 'recovery-halt',
                reviewCycles: finalReviewCycles,
                issues: failFindings,
                escalationReason: recoveryRootCause,
              })
              await writeStoryMetricsBestEffort(storyKey, 'escalated', finalReviewCycles)
              await persistState()
              return 'verification-failed'
            }
          }

          if (!shouldFallThroughToComplete) {
            // H0.1 (field finding #17): this terminal path bypasses
            // emitEscalation (same gap F-ac2gap documents below), so checkpoint
            // the worktree here directly — a verification-failed story's work
            // must live on its branch, not only in the dirty working tree that
            // cleanup tooling force-removes.
            if (effectiveProjectRoot !== undefined && effectiveProjectRoot !== projectRoot) {
              const cp = await checkpointStoryWorktree(
                storyKey,
                `verification-failed: ${verificationFailReason ?? 'tier-a-fail'}`,
                effectiveProjectRoot,
              )
              if (cp.status === 'committed') {
                logger.info(
                  { storyKey, sha: cp.sha },
                  'verification-failed checkpoint: uncommitted worktree state preserved on story branch',
                )
                if (runManifest !== null && cp.sha) {
                  runManifest
                    .patchStoryState(storyKey, { checkpoint_sha: cp.sha })
                    .catch((err: unknown) =>
                      logger.warn({ err, storyKey }, 'patchStoryState(checkpoint_sha, verification-failed) failed — pipeline continues'),
                    )
                }
              }
            }
            updateStory(storyKey, {
              phase: 'VERIFICATION_FAILED' as StoryPhase,
              completedAt: new Date().toISOString(),
            })
            // F-ac2gap (77-4 AC2 follow-up): the VERIFICATION_FAILED terminal path
            // (Tier A retry exhausted, recovery did not escalate via propose/halt)
            // bypasses emitEscalation, so escalation_reason was never written even
            // though the story terminated as a failure. Found by 77-6's fresh-run
            // AC5 validation (run c2874c68: primary_model + recovery_history landed,
            // escalation_reason was undefined). Persist the recovery root-cause
            // taxonomy value so decision-replay (77-5) and `substrate report` have it.
            if (runManifest !== null) {
              runManifest
                .patchStoryState(storyKey, { escalation_reason: verificationFailReason })
                .catch((err: unknown) =>
                  logger.warn({ err, storyKey }, 'patchStoryState(escalation_reason, verification-failed) failed — pipeline continues'),
                )
            }
            await writeStoryMetricsBestEffort(storyKey, 'verification-failed', finalReviewCycles)
            await persistState()
            return 'verification-failed'
          }
          // shouldFallThroughToComplete = true: Tier A retry passed verification,
          // fall through to COMPLETE state transition below.
        }
        // warn or pass — fall through to COMPLETE
      }

      // Auto-approve sites (limit-reached / minor-fixes timeout) emit
      // story:auto-approved before transitioning. SHIP_IT/LGTM site doesn't.
      if (autoApprove !== undefined) {
        eventBus.emit('story:auto-approved', {
          storyKey,
          verdict: recordedVerdict,
          reviewCycles: finalReviewCycles,
          maxReviewCycles: config.maxReviewCycles,
          issueCount: autoApprove.issueCount,
          reason: autoApprove.reason,
        })
      }

      const completeUpdate: Partial<StoryState> = {
        phase: 'COMPLETE' as StoryPhase,
        completedAt: new Date().toISOString(),
      }
      // Auto-approve sites carry the explicit final review cycle count on
      // the state record. The SHIP_IT/LGTM site doesn't track this in the
      // state object (cycle count flows through writeStoryMetricsBestEffort
      // instead) — preserved for behavioural compatibility.
      if (autoApprove !== undefined) {
        completeUpdate.reviewCycles = finalReviewCycles
      }
      // Story 61-6: timeout-on-minor downgrades lastVerdict on the state
      // record so post-mortem inspection can distinguish timeout-driven
      // auto-approve from cycle-exhaustion auto-approve.
      if (autoApprove?.downgradeLastVerdict !== undefined) {
        completeUpdate.lastVerdict = autoApprove.downgradeLastVerdict
      }
      updateStory(storyKey, completeUpdate)

      // Story 57-2: post-COMPLETE invariant — verification_result should be
      // present unless skipVerification.
      if (config.skipVerification !== true && runManifest != null) {
        void Promise.resolve()
          .then(() => runManifest.read())
          .then((manifest) => {
            if (manifest?.per_story_state?.[storyKey]?.verification_result == null) {
              logger.warn(
                { storyKey, category: 'verification-result-missing' },
                'post-COMPLETE invariant: verification_result absent in manifest',
              )
            }
          })
          .catch(() => { /* read failure — invariant check best-effort only */ })
      }
      await writeStoryMetricsBestEffort(storyKey, recordedVerdict, finalReviewCycles)
      await writeStoryOutcomeBestEffort(storyKey, 'complete', finalReviewCycles)
      eventBus.emit('orchestrator:story-complete', {
        storyKey,
        reviewCycles: finalReviewCycles,
      })
      await persistState()
      return 'completed'
    }

    // H0.2 (hardening program, field findings #1/#14): unified finalization.
    // This commit+merge block used to live lexically inside the SHIP_IT/LGTM
    // review branch ONLY — auto-approved stories (cycle-limit and
    // minor-fix-timeout paths) returned early and never committed or merged,
    // leaving dirty worktrees behind while the run reported success
    // ('recovered'). Every COMPLETE-bound path now calls this helper after
    // runVerificationAndComplete returns 'completed'.
    // Returns 'terminal' when an escalation inside finalization already wrote
    // story state (caller must return immediately); 'finalized' otherwise.
    async function finalizeStory(completedReviewCycles: number): Promise<'finalized' | 'terminal'> {
        // H3.2: deliverable commit SHA, hoisted to function scope so the
        // finalization-mode gate and lifecycle events (which live outside the
        // commit block) can reference it.
        let storyDeliverableSha: string | undefined
        // Story 75-2: merge-to-main phase — integrate the story branch into the base branch.
        // Only runs when:
        //   - noWorktree is false (Story 75-3 — the --no-worktree opt-out skips both creation AND merge)
        //   - _worktreeManager is present (auto-created at line 673 OR injected via deps)
        //   - we captured the orchestrator start branch at run startup (git available)
        // Missing any of these means this run was started without worktree support — skip silently and mark COMPLETE.
        // Two-bug fix (caught by worktree-merge-integration.test.ts 2026-05-10):
        //   1. Use `_worktreeManager` (canonical instance) NOT `worktreeManager` (deps prop —
        //      undefined in the production path where the orchestrator auto-creates the manager).
        //      Pre-fix: production users with --worktree never had merge-to-main fire because
        //      `worktreeManager` deps prop was undefined.
        //   2. Check `!noWorktree` so --no-worktree opt-out skips merge (would error on a
        //      non-existent branch otherwise).
        if (!noWorktree && _worktreeManager !== undefined && _orchestratorStartBranch !== undefined && projectRoot !== undefined) {
          // Canonical branch name from @substrate-ai/core (v0.20.84 recurrence prevention
          // for the v0.20.82 BRANCH_PREFIX drift bug). DO NOT inline this literal.
          const branchName = `${BRANCH_PREFIX}${storyKey}`

          // Path E Bug #5 (v0.20.86): substrate commits the worktree's dirty
          // state programmatically. Pre-fix, this step relied on the
          // dispatched agent running `git commit` itself — empirical audit
          // (2026-05-10) found 1 `feat(story-X-Y)` commit across substrate +
          // 4 consumer projects in 2 months. Agents don't reliably commit.
          // Without this step, the per-story branch never advances past the
          // orchestrator's start commit, merge-to-main fast-forwards a no-op,
          // and the worktree cleanup destroys the agent's uncommitted work.
          if (effectiveProjectRoot !== undefined) {
            const dirty = await getGitChangedFiles(effectiveProjectRoot)
            const commitResult = await commitDevStoryOutput(
              storyKey,
              _capturedStoryTitle,
              dirty,
              effectiveProjectRoot,
            )
            if (commitResult.status === 'no-changes') {
              // H0.1: with commit-first, a clean tree here usually means the
              // work is ALREADY on the branch (feat commit at dev-story end,
              // wip checkpoints, or agent-side commits). Three cases:
              //  (a) hooks rejected the deliverable commit at dev-story end and
              //      nothing changed since → the hook complaint is unresolved;
              //      escalate dev-story-commit-failed with that output rather
              //      than letting a hook-bypassed wip checkpoint reach main;
              //  (b) branch advanced past baseline → proceed to merge;
              //  (c) branch never advanced → the original silent-failure
              //      escalation (agent produced nothing committable).
              if (_devOutputCommitHookFailure !== undefined) {
                logger.error(
                  { storyKey, stderr: _devOutputCommitHookFailure },
                  'deliverable commit was rejected by hooks at dev-story end and was never resolved — escalating',
                )
                updateStory(storyKey, {
                  phase: 'ESCALATED' as StoryPhase,
                  error: 'dev-story-commit-failed',
                  completedAt: new Date().toISOString(),
                })
                await emitEscalation({
                  storyKey,
                  lastVerdict: 'dev-story-commit-failed',
                  reviewCycles: completedReviewCycles,
                  issues: [
                    `substrate auto-commit was rejected by pre-commit hooks at dev-story end and the rejection was never resolved: ${_devOutputCommitHookFailure}`,
                    'The work IS preserved as a wip(story-…) checkpoint on the story branch (hooks bypassed) — it was deliberately not merged.',
                  ],
                })
                await persistState()
                return 'terminal'
              }
              let branchAdvancedSinceBaseline = false
              if (baselineHeadSha) {
                try {
                  const headNow = execSync('git rev-parse HEAD', {
                    cwd: effectiveProjectRoot,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 5_000,
                  }).trim()
                  branchAdvancedSinceBaseline = headNow !== baselineHeadSha
                } catch {
                  // rev-parse failed — treat as not-advanced; the escalation
                  // below is the safe default.
                }
              }
              if (!branchAdvancedSinceBaseline) {
                // Working tree has nothing to commit and the branch never
                // moved. Either the agent produced no output (silent failure)
                // or the changes were all in .gitignored / out-of-worktree
                // paths. Escalate so an operator investigates rather than
                // reporting a false success.
                logger.warn(
                  { storyKey, reason: commitResult.reason },
                  'dev-story produced no committable changes — escalating instead of running merge-to-main on an unchanged branch',
                )
                updateStory(storyKey, {
                  phase: 'ESCALATED' as StoryPhase,
                  error: `dev-story-no-commit: ${commitResult.reason}`,
                  completedAt: new Date().toISOString(),
                })
                await emitEscalation({
                  storyKey,
                  lastVerdict: 'dev-story-no-commit',
                  reviewCycles: completedReviewCycles,
                  issues: [
                    `dev-story phase reached SHIP_IT but produced no committable changes (reason: ${commitResult.reason})`,
                  ],
                })
                await persistState()
                return 'terminal'
              }
              logger.info(
                { storyKey },
                'working tree clean at finalize but branch already advanced (commit-first) — proceeding to merge',
              )
            }
            if (commitResult.status === 'failed') {
              // Pre-commit hook rejection, gpg failure, or other commit-time
              // failure. Surface the hook output to the operator.
              logger.error(
                { storyKey, stderr: commitResult.stderr },
                'substrate auto-commit failed — escalating story',
              )
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: 'dev-story-commit-failed',
                completedAt: new Date().toISOString(),
              })
              await emitEscalation({
                storyKey,
                lastVerdict: 'dev-story-commit-failed',
                reviewCycles: completedReviewCycles,
                issues: [`substrate auto-commit failed: ${commitResult.stderr}`],
              })
              await persistState()
              return 'terminal'
            }
            // H0.1: the commit may have happened at dev-story end (commit-first,
            // no-changes fall-through above) rather than just now — resolve the
            // SHA to attribute either way.
            let finalizeCommitSha: string | undefined
            if (commitResult.status === 'committed') {
              finalizeCommitSha = commitResult.sha || undefined
              logger.info(
                { storyKey, sha: commitResult.sha, fileCount: commitResult.filesStaged.length },
                'substrate auto-committed dev-story output before merge-to-main',
              )
            } else {
              try {
                finalizeCommitSha = execSync('git rev-parse HEAD', {
                  cwd: effectiveProjectRoot,
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: 5_000,
                }).trim()
              } catch {
                // Best-effort — merge proceeds; census loses SHA correlation
                // for this story only.
              }
            }
            // F-commitsha (Story 77-6 prereq): persist the auto-commit SHA to the
            // manifest so reconstruction-corpus census can correlate commit↔manifest
            // by SHA (no commit SHA was recorded anywhere before). Best-effort.
            //
            // obs_2026-05-26_027: ALSO persist the reconstruction phase-input here
            // — this is the last point before the per-story worktree is torn down
            // where `storyFilePath` still resolves to the exact story file the
            // producing phase consumed. We copy it to a durable sidecar under the
            // run manifest's directory (`inputs/<run-id>/<story-key>.md`) and record
            // its path + SHA-256, so the reconstruction harness (Story 77-8) can
            // recover the input even for consumer repos that don't git-track story
            // artifacts (the strata-5-2 gap). All in one patchStoryState write.
            storyDeliverableSha = finalizeCommitSha
            // H3.2: explicit lifecycle event — the deliverable commit exists.
            if (finalizeCommitSha) {
              eventBus.emit('orchestrator:story-committed', {
                storyKey,
                sha: finalizeCommitSha,
                branch: branchName,
              })
            }
            if (runManifest !== null && finalizeCommitSha) {
              const statePatch: Partial<PerStoryState> = { commit_sha: finalizeCommitSha }
              if (storyFilePath !== undefined) {
                try {
                  Object.assign(
                    statePatch,
                    captureReconstructionInput(
                      storyFilePath,
                      storyKey,
                      runManifest.baseDir,
                      runManifest.runId,
                      effectiveProjectRoot,
                    ),
                  )
                } catch (inputErr) {
                  logger.warn(
                    { err: inputErr, storyKey },
                    'reconstruction phase-input capture failed — pipeline continues (commit_sha still recorded)',
                  )
                }
              }
              // Story 81-1: aggregate dispatch telemetry (total_turns + total_tokens)
              // from per-story dispatch records and include alongside commit_sha.
              //
              // NOTE — known gap: the current `_storyAgents` records carry only
              // `{ agent, phase, model? }` and do NOT include turn counts or token
              // data. `aggregateStoryDispatchTelemetry` therefore returns `{}` (both
              // fields absent) in the current implementation. Piping token/turn data
              // through every dispatch site is a follow-up to this story. Absent
              // fields are treated as "unknown" (NOT zero) by Epic 81 consumers.
              try {
                const dispatchTelemetry = aggregateStoryDispatchTelemetry(
                  _storyAgents.get(storyKey) ?? [],
                )
                if (dispatchTelemetry.total_turns !== undefined) {
                  statePatch.total_turns = dispatchTelemetry.total_turns
                }
                if (dispatchTelemetry.total_tokens !== undefined) {
                  statePatch.total_tokens = dispatchTelemetry.total_tokens
                }
              } catch (telemetryErr) {
                logger.warn(
                  { err: telemetryErr, storyKey },
                  'aggregateStoryDispatchTelemetry failed — pipeline continues (commit_sha still recorded)',
                )
              }
              runManifest
                .patchStoryState(storyKey, statePatch)
                .catch((err: unknown) =>
                  logger.warn({ err, storyKey }, 'patchStoryState(commit_sha/phase-input/telemetry) failed — pipeline continues'),
                )
            }
          }

          // Defensive gate: even with the auto-commit above, verify the branch
          // actually advanced past the orchestrator start before merging. Catches
          // any future flow drift where the commit step is skipped or returns
          // unexpectedly.
          try {
            const branchSha = execSync(`git rev-parse ${branchName}`, {
              cwd: effectiveProjectRoot ?? projectRoot,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 5_000,
            }).trim()
            const startSha = execSync(`git rev-parse ${_orchestratorStartBranch}`, {
              cwd: projectRoot,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 5_000,
            }).trim()
            if (branchSha === startSha) {
              logger.warn(
                { storyKey, branchSha, startSha, branchName },
                'merge-to-main gate: branch did not advance from start commit — escalating instead of running a no-op merge',
              )
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: 'dev-story-no-commit',
                completedAt: new Date().toISOString(),
              })
              await emitEscalation({
                storyKey,
                lastVerdict: 'dev-story-no-commit',
                reviewCycles: completedReviewCycles,
                issues: [
                  `branch ${branchName} did not advance past start commit ${startSha} — merge-to-main would be a no-op`,
                ],
              })
              await persistState()
              return 'terminal'
            }
          } catch (gateErr) {
            // git rev-parse failure is unusual but not necessarily fatal. Log
            // and proceed — the merge phase will surface any genuine git
            // issues with its own error handling.
            logger.warn(
              { storyKey, err: gateErr instanceof Error ? gateErr.message : String(gateErr) },
              'merge-to-main pre-flight verification failed — proceeding with merge phase',
            )
          }

          // H7 (merge-integrity, red-team): DISCLOSURE gate. The dev agent can
          // write two files but report only one in files_modified; review is
          // scoped to the self-report, so the undisclosed file is never diffed —
          // yet the auto-commit stages the git ground truth and the merge lands
          // BOTH. Deterministically refuse to integrate any IMPLEMENTATION file
          // the agent never disclosed, regardless of the reviewer's verdict.
          // Artifacts (_bmad-output/, .substrate/) are exempt (create-story /
          // profile writes). The branch is preserved for operator inspection.
          {
            // H7 hotfix (live-smoke 2026-07-06): reconcile path FORMAT before
            // comparing. Real agents report files_modified as ABSOLUTE worktree
            // paths (…/worktrees/…/1-1/src/x.py) while git ground truth is
            // worktree-RELATIVE (src/x.py). Without stripping the worktree
            // prefix the two sets never intersect, so EVERY committed file read
            // as undisclosed and every real story false-escalated
            // undisclosed-files-in-merge (the stub reports relative paths, so
            // the fixture matrix never caught it).
            const worktreeRoot = (effectiveProjectRoot ?? process.cwd())
              .replace(/\\/g, '/')
              .replace(/\/+$/, '')
            const norm = (f: string): string => {
              let n = f.replace(/\\/g, '/').replace(/^\.\//, '')
              if (worktreeRoot.length > 0 && n.startsWith(worktreeRoot + '/')) {
                n = n.slice(worktreeRoot.length + 1)
              }
              return n
            }
            const disclosed = new Set((devFilesModified ?? []).map(norm))
            const mergedFiles = recaptureChangedFiles(effectiveProjectRoot ?? process.cwd())
            const { artifactOnly } = classifyImplementationDiff(mergedFiles)
            const artifactSet = new Set(artifactOnly.map(norm))
            const undisclosed = mergedFiles
              .map(norm)
              .filter((f) => !artifactSet.has(f) && !disclosed.has(f))
            if (undisclosed.length > 0) {
              logger.error(
                { storyKey, undisclosed, disclosed: [...disclosed] },
                'H7: refusing to merge — committed implementation files were never disclosed by the dev agent (files_modified) and thus never reviewed',
              )
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: 'undisclosed-files-in-merge',
                completedAt: new Date().toISOString(),
              })
              await emitEscalation({
                storyKey,
                lastVerdict: 'undisclosed-files-in-merge',
                reviewCycles: completedReviewCycles,
                issues: [
                  `${undisclosed.length} implementation file(s) are committed on the story branch but were NOT in the dev agent's files_modified (so no review cycle inspected them): ${undisclosed.join(', ')}. ` +
                    `A merge would land unreviewed code. Inspect the branch; if the changes are legitimate, re-dispatch with accurate files_modified or merge manually.`,
                ],
              })
              await persistState()
              return 'terminal'
            }
          }

          // H3.1: finalization mode gate. 'merge' continues into the local
          // merge below (today's behavior). 'branch' and 'pr' STOP here —
          // nothing self-merges; the story branch is the deliverable
          // (field findings #14/#16: deterministic, never-self-merge modes).
          // A2.3 (acceptance-gate): run the acceptance STAGE for stories that
          // claim journeys — render the surfaces from the worktree via the
          // declared contract, judge with the separate-lineage agent, record
          // verdicts. Best-effort: any failure leaves the journey unwalked and
          // the coverage audit below is the enforcement point.
          let acceptanceOutcomes: Awaited<ReturnType<typeof runAcceptanceStage>> = []
          try {
            acceptanceOutcomes = await runAcceptanceStage(storyKey, effectiveProjectRoot ?? projectRoot ?? process.cwd())
          } catch (stageErr) {
            logger.warn({ storyKey, err: stageErr }, 'A2.3: acceptance stage threw (best-effort) — claimed journeys stay unwalked')
          }

          let finalizationMode = config.finalizationMode ?? 'merge'

          // A4.1/A4.2 (acceptance-gate): verdict × tier policy. Applies ONLY in
          // blocking mode (ADVISORY-UNTIL-PROVEN — advisory never blocks or
          // changes integration behavior).
          //   critical journey walked-FAIL → escalate acceptance-fail, no
          //     merge, branch durable (H0.1).
          //   critical journeys all walked-PASS → integration downgraded to
          //     acceptance.critical_pass_finalization (default branch): the
          //     deliverable branch + verdict artifact await a HUMAN merge —
          //     the sprint demo lands in the morning report, the run keeps
          //     moving (the design brief's tier table on the H3.1 seam).
          //   standard-tier FAIL → warn + Tier-B-style pending proposal;
          //     the run continues.
          if ((config.acceptanceMode ?? 'advisory') === 'blocking' && acceptanceOutcomes.length > 0) {
            const criticalFailed = acceptanceOutcomes.filter((o) => o.criticality === 'critical' && o.judged && !o.pass)
            if (criticalFailed.length > 0) {
              const failedIds = criticalFailed.map((o) => o.journeyId)
              logger.error(
                { storyKey, journeys: failedIds },
                'A4.1: journey-critical acceptance FAIL — blocking integration; branch preserved',
              )
              updateStory(storyKey, {
                phase: 'ESCALATED' as StoryPhase,
                error: 'acceptance-fail',
                completedAt: new Date().toISOString(),
              })
              await emitEscalation({
                storyKey,
                lastVerdict: 'acceptance-fail',
                reviewCycles: completedReviewCycles,
                issues: [
                  `journey-critical acceptance verdicts FAILED for: ${failedIds.join(', ')} — the rendered product does not deliver the journey's end-states.`,
                  'Inspect the verdict evidence (acceptance:verdict events / run report), fix the wiring, and re-dispatch. The story branch is preserved.',
                ],
              })
              await persistState()
              return 'terminal'
            }
            const standardFailed = acceptanceOutcomes.filter((o) => o.criticality === 'standard' && o.judged && !o.pass)
            if (standardFailed.length > 0) {
              logger.warn(
                { storyKey, journeys: standardFailed.map((o) => o.journeyId) },
                'A4.1: standard-tier acceptance FAIL — run continues; fix-story proposal filed (best-effort)',
              )
              if (runManifest !== null && typeof (runManifest as { appendProposal?: unknown }).appendProposal === 'function') {
                await runManifest
                  .appendProposal({
                    id: `acceptance-fail-${storyKey}-${Date.now()}`,
                    created_at: new Date().toISOString(),
                    description: `standard-tier journey acceptance FAILED (${standardFailed.map((o) => o.journeyId).join(', ')}) — file a fix story to wire the journey end-states`,
                    type: 'fix',
                    story_key: storyKey,
                  } as never)
                  .catch((err: unknown) => logger.warn({ err, storyKey }, 'A4.1: proposal append failed — pipeline continues'))
              }
            }
            const critical = acceptanceOutcomes.filter((o) => o.criticality === 'critical')
            if (
              finalizationMode === 'merge' &&
              critical.length > 0 &&
              critical.every((o) => o.judged && o.pass)
            ) {
              finalizationMode = config.acceptanceCriticalPassFinalization ?? 'branch'
              logger.info(
                { storyKey, journeys: critical.map((o) => o.journeyId), finalizationMode },
                'A4.2: journey-critical PASS — integration downgraded for human-held merge (verdict artifact in the run report)',
              )
            }
          }

          // A0.3 (acceptance-gate): epic-close journey coverage audit. Pure
          // accounting — runs in EVERY finalization mode (branch included).
          // Blocking mode escalates the LAST story of the epic BEFORE it
          // integrates when a journey is unclaimed/unwalked — intercepting
          // the never-wired-journey class (UJ-2) at the merge choke point.
          // Advisory (default) warns + emits the coverage event and proceeds.
          {
            const acceptanceModeCfg = config.acceptanceMode ?? 'advisory'
            if (acceptanceModeCfg !== 'off') {
              const epicOfA = (key: string): string =>
                key.includes('-') ? key.slice(0, key.lastIndexOf('-')) : key
              const epicIdA = epicOfA(storyKey)
              const TERMINAL_A: StoryPhase[] = ['COMPLETE', 'ESCALATED']
              const isLastOfEpicA = [..._stories.entries()]
                .filter(([key]) => key !== storyKey && epicOfA(key) === epicIdA)
                .every(([, st]) => TERMINAL_A.includes(st.phase))
              const epicNum = Number(epicIdA)
              if (isLastOfEpicA && Number.isInteger(epicNum)) {
                const audit = await auditJourneyCoverage({ epic: epicNum })
                const violations = (audit?.entries ?? []).filter(
                  (e) => e.state === 'unclaimed' || e.state === 'unwalked',
                )
                if (violations.length > 0 || audit?.unrunnable !== undefined) {
                  const issueLines = violations.map(
                    (v) =>
                      `journey ${v.journeyId} [${v.criticality}] "${v.title}" is ${v.state}` +
                      (v.ownerStories.length > 0
                        ? ` (claimed by ${v.ownerStories.join(', ')} but never walked)`
                        : ' — NO story claims it'),
                  )
                  if (audit?.unrunnable !== undefined) issueLines.push(audit.unrunnable)
                  if (acceptanceModeCfg === 'blocking') {
                    // Precedence (A1.1): unclaimed is contract-independent
                    // (no walk needed to know nobody claims it) and stays the
                    // most specific signal. A claimed journey that can never
                    // be walked because the contract is absent/invalid is
                    // acceptance-unrunnable (fix the config); journey-unwalked
                    // is reserved for a runnable gate that didn't walk.
                    const verdict = violations.some((v) => v.state === 'unclaimed')
                      ? 'journey-unclaimed'
                      : audit?.unrunnable !== undefined
                        ? 'acceptance-unrunnable'
                        : 'journey-unwalked'
                    logger.error(
                      { storyKey, epicId: epicIdA, verdict, journeys: violations.map((v) => v.journeyId) },
                      'A0.3/A1.1: journey coverage violation at epic close — blocking finalization; branch preserved',
                    )
                    updateStory(storyKey, {
                      phase: 'ESCALATED' as StoryPhase,
                      error: verdict,
                      completedAt: new Date().toISOString(),
                    })
                    await emitEscalation({
                      storyKey,
                      lastVerdict: verdict,
                      reviewCycles: completedReviewCycles,
                      issues: [
                        `epic ${epicIdA} closes with ${String(violations.length)} journey coverage violation(s) — the never-wired-journey class:`,
                        ...issueLines,
                        'Wire the journey in a story tagged with its id, or defer it explicitly: `substrate acceptance defer <id> --reason "<why>"` (commit the deferral file).',
                      ],
                    })
                    await persistState()
                    return 'terminal'
                  }
                  logger.warn(
                    { storyKey, epicId: epicIdA, violations: issueLines },
                    'A0.3 (advisory): journey coverage violations at epic close — not blocking (acceptance.mode: advisory)',
                  )
                }
              }
            }
          }

          // H3.4: epic gate hook. When configured, the LAST story of an epic
          // (all sibling stories in this run's scope already terminal) must
          // pass `finalization.epic_gate_command` before it integrates in
          // merge/pr mode. Branch mode skips the gate — nothing integrates.
          // Known limitation (recorded in the hardening ledger): with
          // concurrent finalization of two same-epic stories, neither sees
          // the other as terminal and the gate is skipped; exact under
          // sequential dispatch or dependency-serialized epics.
          const epicGateCommand = config.epicGateCommand
          if (
            epicGateCommand !== undefined &&
            epicGateCommand.trim() !== '' &&
            finalizationMode !== 'branch'
          ) {
            const epicOf = (key: string): string =>
              key.includes('-') ? key.slice(0, key.lastIndexOf('-')) : key
            const epicId = epicOf(storyKey)
            const TERMINAL_PHASES: StoryPhase[] = ['COMPLETE', 'ESCALATED']
            const isLastOfEpic = [..._stories.entries()]
              .filter(([key]) => key !== storyKey && epicOf(key) === epicId)
              .every(([, st]) => TERMINAL_PHASES.includes(st.phase))
            if (isLastOfEpic) {
              logger.info({ storyKey, epicId, epicGateCommand }, 'H3.4: last story of epic — running epic gate command')
              let gateOutput = ''
              let gatePassed = false
              try {
                gateOutput = execSync(epicGateCommand, {
                  cwd: projectRoot,
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: 600_000,
                  maxBuffer: 10 * 1024 * 1024,
                })
                gatePassed = true
              } catch (gateCmdErr) {
                const e = gateCmdErr as { stdout?: string; stderr?: string; message?: string }
                gateOutput = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || (e.message ?? String(gateCmdErr))
              }
              if (!gatePassed) {
                logger.error(
                  { storyKey, epicId, output: gateOutput.slice(0, 500) },
                  'H3.4: epic gate command failed — halting finalization; branch preserved',
                )
                updateStory(storyKey, {
                  phase: 'ESCALATED' as StoryPhase,
                  error: 'epic-gate-failed',
                  completedAt: new Date().toISOString(),
                })
                await emitEscalation({
                  storyKey,
                  lastVerdict: 'epic-gate-failed',
                  reviewCycles: completedReviewCycles,
                  issues: [
                    `epic gate command failed for epic ${epicId} (last story ${storyKey}): \`${epicGateCommand}\`\n` +
                      `output (truncated):\n${gateOutput.slice(0, 4000)}`,
                  ],
                })
                await persistState()
                return 'terminal'
              }
              logger.info({ storyKey, epicId }, 'H3.4: epic gate passed')
            }
          }
          if (finalizationMode === 'branch' || finalizationMode === 'pr') {
            let prUrl: string | undefined
            if (finalizationMode === 'pr') {
              // Push the branch and open a PR. Failure DEGRADES to branch
              // mode with a warning — integration never blocks the story.
              try {
                // H7 review (bug_007): argv form — no shell. branchName and the
                // agent-authored title/body are literal args, never evaluated.
                execFileSync('git', ['push', '-u', 'origin', branchName], {
                  cwd: projectRoot,
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: 60_000,
                })
                const shortSha = (storyDeliverableSha ?? '').slice(0, 10)
                const ghOutput = execFileSync(
                  'gh',
                  [
                    'pr', 'create',
                    '--head', branchName,
                    '--title', `story ${storyKey}: ${_capturedStoryTitle ?? 'implementation'}`,
                    '--body', `Substrate story ${storyKey} (commit ${shortSha}). Verified by the Tier-A pipeline; see the run manifest for the full verification record.`,
                  ],
                  {
                    cwd: projectRoot,
                    encoding: 'utf-8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 60_000,
                  },
                ).trim()
                // gh prints the PR URL on success; empty output means we have
                // no URL to record — treat as degraded rather than storing ''.
                prUrl = ghOutput === '' ? undefined : ghOutput
              } catch (prErr) {
                logger.warn(
                  { storyKey, branchName, err: prErr instanceof Error ? prErr.message.slice(0, 300) : String(prErr) },
                  'pr finalization: push/gh failed — degrading to branch mode (the branch is still the deliverable)',
                )
              }
            }
            // Remove the worktree but KEEP the deliverable branch.
            try {
              await _worktreeManager.cleanupWorktree(storyKey, { keepBranch: true })
            } catch (cleanupErr) {
              logger.warn({ storyKey, err: cleanupErr }, 'worktree removal after branch/pr finalization failed (best-effort; branch intact)')
            }
            eventBus.emit('orchestrator:story-finalized', {
              storyKey,
              mode: finalizationMode,
              branch: branchName,
              sha: storyDeliverableSha ?? '',
              ...(prUrl !== undefined ? { prUrl } : {}),
            })
            if (runManifest !== null) {
              runManifest
                .patchStoryState(storyKey, {
                  finalization: {
                    mode: finalizationMode,
                    branch: branchName,
                    ...(storyDeliverableSha ? { sha: storyDeliverableSha } : {}),
                    ...(prUrl !== undefined ? { pr_url: prUrl } : {}),
                  },
                })
                .catch((err: unknown) =>
                  logger.warn({ err, storyKey }, 'patchStoryState(finalization) failed — pipeline continues'),
                )
            }
            logger.info({ storyKey, branchName, mode: finalizationMode, prUrl }, 'story finalized without self-merge — branch is the deliverable')
            return 'finalized'
          }

          logger.info({ storyKey, branchName, startBranch: _orchestratorStartBranch }, 'Invoking merge-to-main phase')
          let mergeResult: import('../compiled-workflows/merge-to-main.js').MergeToMainResult
          try {
            mergeResult = await enqueueMerge({
              storyKey,
              branchName,
              startBranch: _orchestratorStartBranch,
              worktreeManager: _worktreeManager,
              eventBus,
              projectRoot,
              // H3.3 (AC2): ff-only unless the operator opted into three-way.
              mergeStrategy: config.mergeStrategy ?? 'ff-only',
            })
          } catch (mergeErr) {
            // Unexpected error from merge phase — escalate story
            const errMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr)
            logger.error({ storyKey, err: mergeErr }, 'merge-to-main phase threw unexpectedly — escalating story')
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: `merge-to-main-error: ${errMsg}`,
              completedAt: new Date().toISOString(),
            })
            await emitEscalation({
              storyKey,
              lastVerdict: 'merge-to-main-error',
              reviewCycles: completedReviewCycles,
              issues: [`merge-to-main phase threw: ${errMsg}`],
            })
            await persistState()
            return 'terminal'
          }
          if (!mergeResult.success) {
            // Merge refused/failed — story is ESCALATED, worktree + branch
            // preserved for the operator. H3.3: three distinct reasons, each
            // with an escalation naming exactly what blocked and the remedy.
            const failReason = mergeResult.reason ?? 'merge-conflict-detected'
            const issues: string[] = []
            if (failReason === 'parent-tree-dirtied-by-run') {
              issues.push(
                `parent working tree has uncommitted changes to ${mergeResult.dirtiedFiles?.length ?? 0} file(s) the story also modified: ${(mergeResult.dirtiedFiles ?? []).join(', ')} — ` +
                  `merging would entangle unreviewed parent edits with verified story content. Commit or stash the parent changes, then merge ${branchName} manually.`,
              )
            } else if (failReason === 'ff-only-merge-not-possible') {
              issues.push(
                `${_orchestratorStartBranch ?? 'the start branch'} moved since ${branchName} was created and merge_strategy is ff-only — ` +
                  `substrate will not synthesize a merge commit. Set finalization.merge_strategy: three-way (required for concurrent multi-story runs) or integrate the branch manually.`,
              )
            } else {
              issues.push(
                `merge conflict in ${mergeResult.conflictingFiles?.length ?? 0} file(s): ${(mergeResult.conflictingFiles ?? []).join(', ')}`,
              )
            }
            logger.warn(
              { storyKey, branchName, reason: failReason, conflictingFiles: mergeResult.conflictingFiles, dirtiedFiles: mergeResult.dirtiedFiles },
              `merge-to-main failed — escalating story with ${failReason}`,
            )
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: failReason,
              completedAt: new Date().toISOString(),
            })
            await emitEscalation({
              storyKey,
              lastVerdict: failReason,
              reviewCycles: completedReviewCycles,
              issues,
            })
            await persistState()
            return 'terminal'
          }
          logger.info({ storyKey, branchName }, 'merge-to-main phase completed successfully')
          // H3.2: explicit lifecycle events for merge-mode integration.
          eventBus.emit('orchestrator:story-merged', {
            storyKey,
            sha: storyDeliverableSha ?? '',
            branch: branchName,
          })
          eventBus.emit('orchestrator:story-finalized', {
            storyKey,
            mode: 'merge',
            branch: branchName,
            sha: storyDeliverableSha ?? '',
          })
          if (runManifest !== null) {
            runManifest
              .patchStoryState(storyKey, {
                finalization: {
                  mode: 'merge',
                  branch: branchName,
                  ...(storyDeliverableSha ? { sha: storyDeliverableSha } : {}),
                },
              })
              .catch((err: unknown) =>
                logger.warn({ err, storyKey }, 'patchStoryState(finalization) failed — pipeline continues'),
              )
          }
        }
      return 'finalized'
    }

    while (keepReviewing) {
      await waitIfPaused()
      if (_state !== 'RUNNING') return

      if (reviewCycles === 0) startPhase(storyKey, 'code-review')

      // -- Story 53-4: Retry budget gate (AC5) --
      // Gate positioned BEFORE any retry dispatch, unconditional (cannot be bypassed).
      // reviewCycles === 0 → initial dev dispatch (not a retry), skip gate.
      // reviewCycles > 0  → retry attempt — check and enforce budget.
      //
      // Story 62-4: when the previous iteration was a schema-validation
      // phantom (malformed agent output), skip the retry-budget increment.
      // The cycle didn't produce review work; charging it against the
      // budget unfairly consumes slots needed for genuine review defects.
      if (reviewCycles > 0 && !previousIterationWasMalformed) {
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
      // Reset the flag for the upcoming iteration; it'll be re-set if the
      // iteration ends in a schema-validation phantom.
      previousIterationWasMalformed = false

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
              { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
                ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}) },
              {
                storyKey,
                storyFilePath: storyFilePath ?? '',
                workingDirectory: effectiveProjectRoot,
                pipelineRunId: config.pipelineRunId,
                filesModified: group.files,
                buildPassed: _buildPassed,
                ...(baselineHeadSha ? { baselineCommit: baselineHeadSha } : {}),
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
            { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, repoMapInjector, maxRepoMapTokens, agentId,
              ...(config.perStoryContextCeilings?.[storyKey] !== undefined ? { maxContextTokens: config.perStoryContextCeilings[storyKey] } : {}) },
            {
              storyKey,
              storyFilePath: storyFilePath ?? '',
              workingDirectory: effectiveProjectRoot,
              pipelineRunId: config.pipelineRunId,
              filesModified: devFilesModified,
              buildPassed: _buildPassed,
              // Scope re-reviews: pass previous issues so the reviewer verifies fixes first
              ...(previousIssueList.length > 0 ? { previousIssues: previousIssueList } : {}),
              // Pass baseline commit so code review can diff committed changes
              ...(baselineHeadSha ? { baselineCommit: baselineHeadSha } : {}),
            },
          )
        }

        // Record code-review token usage for per-story cost attribution (Story 57-4: see notes above)
        if (config.pipelineRunId !== undefined && reviewResult?.tokenUsage !== undefined) {
          // Capture in a const so TS narrowing survives the async .then() callback
          // (reviewResult is `let`-declared and could theoretically be reassigned).
          const reviewTokens = reviewResult.tokenUsage
          void Promise.resolve()
            .then(() => addTokenUsage(db, config.pipelineRunId!, {
              phase: 'code-review',
              agent: useBatchedReview ? 'code-review-batched' : 'code-review',
              input_tokens: reviewTokens.input,
              output_tokens: reviewTokens.output,
              cost_usd: estimateDispatchCost(reviewTokens.input, reviewTokens.output),
              metadata: JSON.stringify({ storyKey, reviewCycle: reviewCycles }),
            }))
            .catch((tokenErr: unknown) =>
              logger.warn({ storyKey, err: tokenErr }, 'Failed to record code-review token usage'),
            )
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

        // Story 62-3: distinguish "agent produced malformed YAML" from "agent
        // didn't review at all". Malformed-output phantoms come from
        // `schema_validation_failed` in code-review.ts. Operators can debug
        // them differently (prompt/parser fix) than crash/timeout phantoms
        // (resource-constraint / diff-too-large). Story 62-4: malformed
        // phantoms get a more lenient retry policy (independent counter,
        // doesn't burn the standard retry budget).
        const isMalformedOutput = isPhantomReview
          && reviewResult.error === 'schema_validation_failed'

        if (isMalformedOutput) {
          schemaValidationRetries++
          eventBus.emit('orchestrator:code-review-output-malformed', {
            storyKey,
            reviewCycles,
            attempt: schemaValidationRetries,
            maxAttempts: MAX_SCHEMA_VALIDATION_RETRIES,
            error: reviewResult.error ?? 'schema_validation_failed',
            ...(reviewResult.details !== undefined ? { details: reviewResult.details } : {}),
          })

          if (schemaValidationRetries <= MAX_SCHEMA_VALIDATION_RETRIES) {
            logger.warn(
              { storyKey, reviewCycles, attempt: schemaValidationRetries, error: reviewResult.error },
              'Code-review output malformed (schema validation failed) — retrying review',
            )
            previousIterationWasMalformed = true
            continue
          }

          // Exhausted malformed-output retry budget — escalate with a
          // distinct reason so operators can debug the YAML emission rather
          // than chase phantom-retry / retry-budget escalations.
          logger.warn(
            { storyKey, reviewCycles, schemaValidationRetries },
            'Code-review output malformed across MAX_SCHEMA_VALIDATION_RETRIES attempts — escalating',
          )
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: 'code-review-output-malformed-budget-exceeded',
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
          await emitEscalation({
            storyKey,
            lastVerdict: 'code-review-output-malformed-budget-exceeded',
            reviewCycles: reviewCycles + 1,
            issues: [
              `Code-review agent output failed schema validation ${schemaValidationRetries} consecutive times. The output was malformed (likely YAML parse error from unquoted colons, unbalanced quotes, or invalid escapes), not absent. Inspect the rawOutput on the manifest entry for the agent's emission shape and update the prompt or yaml-parser fallbacks.`,
            ],
          })
          await persistState()
          return
        }

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
          // H7 review (bug_012): a review "failure" whose error carries an auth
          // signature is an auth death, not a timeout — halt the run (H0.4)
          // instead of escalating one story and marching to the next. Covers
          // the wrapped-failure path (runCodeReview returns dispatchFailed with
          // the auth error) that the code-review catch above does not see.
          const phantomAuthSignature = detectClaudeAuthFailure(reviewResult.error ?? '')
          if (phantomAuthSignature !== null) {
            endPhase(storyKey, 'code-review')
            updateStory(storyKey, {
              phase: 'ESCALATED' as StoryPhase,
              error: 'auth-failure',
              completedAt: new Date().toISOString(),
            })
            await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
            await emitEscalation({
              storyKey,
              lastVerdict: 'auth-failure',
              reviewCycles: reviewCycles + 1,
              issues: [reviewResult.error ?? '', CLAUDE_AUTH_FAILURE_HINT],
              escalationReason: 'auth-failure',
            })
            await triggerAuthFailureHalt(storyKey, phantomAuthSignature)
            await persistState()
            return
          }
          // H5.5: a missing story artifact is NOT a timeout — pre-fix, the
          // 2026-07-06 live smoke misclassified a fix-agent-deleted story
          // file as consecutive-review-timeouts, sending the operator down
          // a resource-constraint rabbit hole while the file sat safely in
          // the H0.1 feat commit. The phases now self-recover from branch
          // HEAD; reaching here means the artifact is gone from BOTH the
          // working tree and the branch — name that.
          const isStoryFileMissing = (reviewResult.error ?? '').includes('story-file-missing')
          const escalationReason = isStoryFileMissing ? 'story-file-missing' : 'consecutive-review-timeouts'
          logger.warn(
            { storyKey, reviewCycles, error: reviewResult.error, reason: escalationReason },
            'Consecutive review failures (original + retry) — escalating immediately',
          )
          endPhase(storyKey, 'code-review')
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: escalationReason,
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles + 1)
          await emitEscalation({
            storyKey,
            lastVerdict: escalationReason,
            reviewCycles: reviewCycles + 1,
            issues: [
              isStoryFileMissing
                ? `Story artifact is missing from BOTH the working tree and the branch HEAD (${reviewResult.error ?? ''}). An agent deleted it and it was never committed — check the wip/feat commits on the story branch for the last good copy.`
                : 'Review dispatch failed twice consecutively (original + phantom-retry). Likely resource-constrained or diff too large for reviewer.',
            ],
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

        // Story 81-1: persist the code-review verdict to the per-story state
        // manifest. Uses the agent's original verdict when available (agentVerdict
        // from CodeReviewResultSchema.transform lines 226-229) — this is the value
        // that drove Sonnet vs Opus routing. Falls back to the pipeline-recomputed
        // verdict when agentVerdict is absent. Best-effort; never blocks pipeline.
        if (runManifest !== null) {
          const persistedVerdict = reviewResult.agentVerdict ?? verdict
          runManifest
            .patchStoryState(storyKey, { verdict: persistedVerdict })
            .catch((err: unknown) =>
              logger.warn({ err, storyKey }, 'patchStoryState(verdict) failed — pipeline continues'),
            )
        }

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
        // H7 review (bug_012): auth deaths surfacing during code-review must
        // halt the run too — H0.4 only wired create-story/dev-story. Without
        // this, an auth expiry after dev-story (or a resumed run whose stories
        // are all past dev-story) escalates as a misleading exception per story
        // and the run never halts — the exact cascade H0.4 was written to stop.
        const reviewAuthSignature = detectClaudeAuthFailure(errMsg)
        if (reviewAuthSignature !== null) {
          updateStory(storyKey, {
            phase: 'ESCALATED' as StoryPhase,
            error: 'auth-failure',
            completedAt: new Date().toISOString(),
          })
          await writeStoryMetricsBestEffort(storyKey, 'failed', reviewCycles)
          await emitEscalation({
            storyKey,
            lastVerdict: 'auth-failure',
            reviewCycles,
            issues: [errMsg, CLAUDE_AUTH_FAILURE_HINT],
            escalationReason: 'auth-failure',
          })
          await triggerAuthFailureHalt(storyKey, reviewAuthSignature)
          await persistState()
          return
        }
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
        // Story 61-8: shared helper handles verification + COMPLETE transition.
        // Returns 'verification-failed' on Tier A reject (helper writes
        // VERIFICATION_FAILED state internally) — caller returns out.
        const completedReviewCycles = reviewCycles + 1
        const outcome = await runVerificationAndComplete({
          recordedVerdict: verdict,
          finalReviewCycles: completedReviewCycles,
          reviewResult,
        })
        if (outcome === 'verification-failed') {
          return // do NOT mark as COMPLETE
        }

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
            { db, pack, contextCompiler, dispatcher, projectRoot: effectiveProjectRoot, parentProjectRoot: projectRoot, tokenCeilings, otlpEndpoint: _otlpEndpoint, agentId },
            {
              storyKey,
              storyFilePath: storyFilePath ?? '',
              pipelineRunId: config.pipelineRunId,
              filesModified: devFilesModified,
              workingDirectory: effectiveProjectRoot,
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

        // H0.2: unified finalization (shared with the auto-approve sites below).
        const finalizeOutcome = await finalizeStory(completedReviewCycles)
        if (finalizeOutcome === 'terminal') {
          return
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
            const verificationFindingsContent = renderVerificationFindingsForPrompt(
              verificationStore.get(storyKey),
            )
            const sections = [
              { name: 'story_content', content: storyContent, priority: 'required' as const },
              { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
              { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
              ...(targetedFilesContent ? [{ name: 'targeted_files', content: targetedFilesContent, priority: 'important' as const }] : []),
              ...(verificationFindingsContent
                ? [{ name: 'verification_findings', content: verificationFindingsContent, priority: 'important' as const }]
                : []),
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
            workingDirectory: effectiveProjectRoot,
            ...(autoApproveMaxTurns !== undefined ? { maxTurns: autoApproveMaxTurns } : {}),
            ...(config.perStoryContextCeilings?.[storyKey] !== undefined
              ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
              : {}),
            ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            storyKey,
          })
          const fixResult = await handle.result

          // H7 review (merged_bug_001): fold the auto-approve fix's disclosures
          // into devFilesModified too (this path leads straight to finalize).
          {
            const fixFiles = (fixResult.parsed as { files_modified?: unknown } | null | undefined)?.files_modified
            if (Array.isArray(fixFiles)) {
              devFilesModified = Array.from(
                new Set([...devFilesModified, ...fixFiles.filter((f): f is string => typeof f === 'string')]),
              )
            }
          }

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

        // Story 61-8: shared helper handles verification + COMPLETE transition
        // and emits story:auto-approved when `autoApprove` is set.
        const outcome = await runVerificationAndComplete({
          recordedVerdict: verdict,
          finalReviewCycles,
          reviewResult,
          autoApprove: {
            issueCount: issueList.length,
            reason: `Review cycles exhausted (${finalReviewCycles}/${config.maxReviewCycles}) with only minor issues — auto-approving`,
          },
        })
        if (outcome === 'verification-failed') {
          return
        }
        // H0.2: auto-approved stories finalize exactly like SHIP_IT ones.
        if ((await finalizeStory(finalReviewCycles)) === 'terminal') {
          return
        }
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
      // Story 60-9: bumped escalation model from claude-opus-4-6 → claude-opus-4-7.
      // Major-rework dispatches (3rd+ review cycle) get the latest Opus to
      // maximize convergence probability; defaults predated 4-7's release.
      const fixModel = taskType === 'major-rework' ? 'claude-opus-4-7' : undefined

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
            const diffFiles = checkGitDiffFiles(effectiveProjectRoot ?? process.cwd())
            if (diffFiles.length > 0) {
              gitDiffContent = execSync(`git diff HEAD -- ${diffFiles.map((f) => `"${f}"`).join(' ')}`, {
                cwd: effectiveProjectRoot ?? process.cwd(),
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

          // Story 55-3: render structured verification findings for prompt injection
          const verificationFindingsContent = renderVerificationFindingsForPrompt(
            verificationStore.get(storyKey),
          )

          // Build sections based on template type
          const sections = isMajorRework
            ? [
                { name: 'story_content', content: storyContent, priority: 'required' as const },
                { name: 'review_findings', content: reviewFeedback, priority: 'required' as const },
                { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
                { name: 'git_diff', content: gitDiffContent, priority: 'optional' as const },
                { name: 'prior_findings', content: priorFindingsContent, priority: 'optional' as const },
                ...(verificationFindingsContent
                  ? [{ name: 'verification_findings', content: verificationFindingsContent, priority: 'important' as const }]
                  : []),
              ]
            : (() => {
                const targetedFilesContent = buildTargetedFilesContent(issueList)
                return [
                  { name: 'story_content', content: storyContent, priority: 'required' as const },
                  { name: 'review_feedback', content: reviewFeedback, priority: 'required' as const },
                  { name: 'arch_constraints', content: archConstraints, priority: 'optional' as const },
                  ...(targetedFilesContent ? [{ name: 'targeted_files', content: targetedFilesContent, priority: 'important' as const }] : []),
                  { name: 'prior_findings', content: priorFindingsContent, priority: 'optional' as const },
                  ...(verificationFindingsContent
                    ? [{ name: 'verification_findings', content: verificationFindingsContent, priority: 'important' as const }]
                    : []),
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
              ...(effectiveProjectRoot !== undefined ? { workingDirectory: effectiveProjectRoot } : {}),
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
              ...(effectiveProjectRoot !== undefined ? { workingDirectory: effectiveProjectRoot } : {}),
              ...(_otlpEndpoint !== undefined ? { otlpEndpoint: _otlpEndpoint } : {}),
            })
        const fixResult = await handle.result
        endPhase(storyKey, 'fix')

        // H7 review (merged_bug_001 site 1): a fix cycle can legitimately ADD a
        // file (esp. major-rework, whose whole point is broader changes). The
        // H7 disclosure gate compares merged files against devFilesModified —
        // which was captured only from the INITIAL dev-story dispatch. Fold the
        // fix agent's own files_modified into the disclosed set so a
        // legitimately-added, re-reviewed file is not falsely escalated as
        // undisclosed-files-in-merge.
        {
          const fixFiles = (fixResult.parsed as { files_modified?: unknown } | null | undefined)?.files_modified
          if (Array.isArray(fixFiles)) {
            devFilesModified = Array.from(
              new Set([...devFilesModified, ...fixFiles.filter((f): f is string => typeof f === 'string')]),
            )
          }
        }

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
          // Story 61-6: minor-fixes timeout is not a real failure signal. The
          // dev pass already produced the work; the fix dispatch couldn't
          // pin down a small cleanup. Auto-approve as LGTM_WITH_NOTES with
          // the original minor findings retained as warnings on the manifest
          // record. Major-rework timeout still escalates (existing behavior
          // preserved — major rework timeout IS a real failure signal).
          //
          // Story 61-8: routes through the shared runVerificationAndComplete
          // helper alongside SHIP_IT/LGTM and the at-limit auto-approve.
          if (taskType === 'minor-fixes') {
            const finalReviewCycles = reviewCycles + 1
            const downgradedVerdict = 'LGTM_WITH_NOTES'
            logger.warn(
              { storyKey, reviewCycles: finalReviewCycles, issueCount: issueList.length },
              'Minor-fixes dispatch timed out — auto-approving as LGTM_WITH_NOTES (original findings retained as warnings)',
            )
            const outcome = await runVerificationAndComplete({
              recordedVerdict: downgradedVerdict,
              finalReviewCycles,
              reviewResult,
              autoApprove: {
                issueCount: issueList.length,
                reason: `Minor-fixes dispatch timed out (cycle ${finalReviewCycles}) — auto-approving as LGTM_WITH_NOTES with original findings retained as warnings`,
                downgradeLastVerdict: downgradedVerdict,
              },
            })
            if (outcome === 'verification-failed') {
              return
            }
            // H0.2: auto-approved stories finalize exactly like SHIP_IT ones.
            if ((await finalizeStory(finalReviewCycles)) === 'terminal') {
              return
            }
            keepReviewing = false
            return
          }

          // Major-rework (or any non-minor) timeout → escalate
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

        if (isMajorRework) {
          replaceDevStorySignals(fixResult.parsed as DevStorySignals | null | undefined)
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
  /**
   * H0.4 (field finding #10): halt the entire run when a dispatch dies on
   * authentication. Auth failures are environmental, not story-specific —
   * every subsequent dispatch fails identically, so continuing burns the
   * whole batch (the field run lost ~25 minutes and two runs to this).
   * Mirrors handleCeilingExceeded: routes through the Decision Router
   * (severity fatal → halts under every --halt-on policy), sweeps PENDING
   * stories to ESCALATED with a named reason, and reuses _budgetExhausted
   * to stop the dispatch loop.
   */
  async function triggerAuthFailureHalt(triggeredStoryKey: string, matchedSignature: string): Promise<void> {
    if (_authFailureHalted) return // one halt is enough
    _authFailureHalted = true
    _budgetExhausted = true // stop runWithConcurrency from enqueuing more dispatches

    const runId = config.pipelineRunId ?? 'unknown'
    const reason = `agent authentication failure on story ${triggeredStoryKey} (matched: "${matchedSignature}") — all subsequent dispatches would fail identically`

    let haltPolicy: 'all' | 'critical' | 'none' = 'critical'
    if (runManifest !== null) {
      try {
        const manifest = await runManifest.read()
        haltPolicy = ((manifest.cli_flags.halt_on as string | undefined) ?? 'critical') as 'all' | 'critical' | 'none'
      } catch {
        // best-effort — fatal severity halts under every policy anyway
      }
    }
    const routeResult = routeDecision('auth-failure', haltPolicy)

    eventBus.emit('decision:halt', {
      runId,
      decisionType: 'auth-failure',
      severity: routeResult.severity,
      reason,
    })
    await runInteractivePrompt({
      runId,
      decisionType: 'auth-failure',
      severity: routeResult.severity,
      summary: reason,
      defaultAction: routeResult.defaultAction,
      choices: ['abort-run'],
      onHaltSkipped: (payload) => {
        eventBus.emit('decision:halt-skipped-non-interactive', payload)
      },
    }).catch((err: unknown) => {
      logger.warn({ err }, 'interactive prompt failed during auth-failure halt — halting anyway')
    })

    // Sweep every not-yet-started story to ESCALATED with a named reason so
    // `substrate report` explains why they never ran.
    for (const [key, state] of _stories) {
      if (state.phase === 'PENDING' && key !== triggeredStoryKey) {
        updateStory(key, {
          phase: 'ESCALATED' as StoryPhase,
          error: 'auth-failure-halt',
          completedAt: new Date().toISOString(),
        })
        if (runManifest !== null && runManifest !== undefined) {
          runManifest
            .patchStoryState(key, { status: 'escalated', escalation_reason: 'auth-failure-halt' })
            .catch(() => { /* best-effort */ })
        }
      }
    }

    logger.error({ runId, triggeredStoryKey, matchedSignature }, 'RUN HALTED: agent authentication failure — fix credentials and re-run')
  }

  async function handleCeilingExceeded(
    triggeredStoryKey: string,
    remainingInGroup: string[],
    result: CeilingCheckResult,
    manifest: RunManifestData,
  ): Promise<void> {
    const haltPolicy = ((manifest.cli_flags.halt_on as string | undefined) ?? 'critical') as 'all' | 'critical' | 'none'

    // Story 72-1: Route the cost-ceiling-exhausted decision through the autonomy policy
    const routeResult = routeDecision('cost-ceiling-exhausted', haltPolicy)
    const runId = config.pipelineRunId ?? 'unknown'
    const reason = `cost ceiling exceeded: ${result.cumulative.toFixed(4)} USD >= ${result.ceiling} USD`

    if (routeResult.halt) {
      eventBus.emit('decision:halt', {
        runId,
        decisionType: 'cost-ceiling-exhausted',
        severity: routeResult.severity,
        reason,
      })
      // Story 73-2: Invoke interactive prompt when Decision Router halts.
      await runInteractivePrompt({
        runId,
        decisionType: 'cost-ceiling-exhausted',
        severity: routeResult.severity,
        summary: reason,
        defaultAction: routeResult.defaultAction,
        choices: ['skip-remaining', 'retry-with-custom-context', 'propose-re-scope', 'abort-run'],
        onHaltSkipped: (payload) => {
          eventBus.emit('decision:halt-skipped-non-interactive', payload)
        },
      }).catch((err: unknown) => {
        logger.warn({ err }, 'interactive prompt failed during cost-ceiling halt — continuing with default action')
      })
    } else {
      eventBus.emit('decision:autonomous', {
        runId,
        decisionType: 'cost-ceiling-exhausted',
        severity: routeResult.severity,
        defaultAction: routeResult.defaultAction,
        reason,
      })
    }

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
      halt_on: haltPolicy,
      action: routeResult.halt ? 'stopped' : routeResult.defaultAction,
      skipped_stories: allSkipped,
      severity: routeResult.severity,
    })

    // Mark budget as exhausted so runWithConcurrency stops enqueuing
    _budgetExhausted = true

    logger.warn(
      { skipped: allSkipped.length, cumulative: result.cumulative, ceiling: result.ceiling, routedHalt: routeResult.halt, defaultAction: routeResult.defaultAction },
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
      // -- Shutdown guard (Story 58-7): skip new dispatches after SIGTERM/SIGINT --
      if (_shutdownRequested) {
        logger.info({ storyKey }, 'shutdown requested — skipping dispatch')
        return
      }

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

      // -- In-flight dispatch tracking for graceful shutdown drain (Story 58-7) --
      _inFlightCount++
      try {
        await processStory(storyKey, { optimizationDirectives })
      } finally {
        _inFlightCount--
        if (_inFlightCount === 0 && _shutdownRequested) {
          _drainResolve?.()
        }
      }
      completedStoryKeys.push(storyKey)
      // GC hint between stories — best-effort, no error handling needed [AC2]
      ;(globalThis as { gc?: () => void }).gc?.()
      const gcPauseMs = config.gcPauseMs ?? 2_000
      await sleep(gcPauseMs)
    }
  }

  // ---------------------------------------------------------------------------
  // Story 68-1: Cross-story file collision detection + group serialization
  //
  // Motivating incidents: Epic 66 run a832487a + Epic 67 run a59e4c96
  // (concurrent-dispatch races caused transient verification failures when
  // two stories modified the same file concurrently).
  //
  // Helper to extract likely file paths from a story artifact's content.
  // Reads Interface Contracts section (@ path pattern) and backtick-quoted
  // paths. Returns empty set when no recognizable paths are found.
  // ---------------------------------------------------------------------------

  function extractFilePathsFromStoryContent(content: string): Set<string> {
    const paths = new Set<string>()

    // Pattern 1: Interface Contracts — lines like `@ packages/foo/bar.ts`
    const atPattern = /@\s+([a-zA-Z][^\s`()\n]+\.[a-zA-Z0-9]+)/g
    let m: RegExpExecArray | null
    while ((m = atPattern.exec(content)) !== null) {
      const p = m[1]?.trim()
      if (p !== undefined && p.includes('/') && !p.startsWith('http')) {
        // Strip trailing punctuation from sentences (e.g. trailing period)
        paths.add(p.replace(/[.)]+$/, ''))
      }
    }

    // Pattern 2: backtick-quoted relative paths like
    // `packages/sdlc/src/verification/types.ts`
    const backtickPattern = /`([a-zA-Z][^`\n ]+\.[a-zA-Z0-9]{1,6})`/g
    while ((m = backtickPattern.exec(content)) !== null) {
      const p = m[1]?.trim()
      if (p !== undefined && p.includes('/') && !p.includes(' ') && !p.startsWith('http')) {
        paths.add(p)
      }
    }

    return paths
  }

  /**
   * Story 68-1: Pre-dispatch cross-story file collision detection.
   *
   * Before dispatching a batch with multiple concurrent groups, checks whether
   * any two stories from different groups share file paths in their story specs.
   * When collisions are found:
   *   1. Emits `dispatch:cross-story-file-collision` event for operator visibility.
   *   2. Merges colliding groups so they execute sequentially.
   *
   * Best-effort: if story files are missing, unreadable, or contain no parseable
   * paths, the original groups are returned unchanged.
   */
  function detectAndSerializeConcurrentFileCollisions(batchGroups: string[][]): string[][] {
    // No concurrency possible with ≤1 group
    if (batchGroups.length <= 1) return batchGroups

    const root = projectRoot ?? process.cwd()
    const artifactsDir = join(root, '_bmad-output', 'implementation-artifacts')

    if (!existsSync(artifactsDir)) return batchGroups

    // --- Extract file paths for each story ---
    const storyFileMap = new Map<string, Set<string>>() // storyKey → file set

    const allStoryKeys = batchGroups.flat()
    let artifactFiles: string[] | undefined
    try {
      artifactFiles = readdirSync(artifactsDir)
    } catch {
      return batchGroups // can't read artifacts dir — skip
    }

    const STALE_SUFFIX = /\.stale-\d+\.md$/
    for (const storyKey of allStoryKeys) {
      try {
        const match = artifactFiles.find(
          (f) => f.startsWith(`${storyKey}-`) && f.endsWith('.md') && !STALE_SUFFIX.test(f),
        )
        if (!match) continue

        const content = readFileSync(join(artifactsDir, match), 'utf-8')
        const paths = extractFilePathsFromStoryContent(content)
        if (paths.size > 0) {
          storyFileMap.set(storyKey, paths)
        }
      } catch {
        // Story file unreadable — skip this story
      }
    }

    if (storyFileMap.size === 0) return batchGroups

    // --- Pairwise collision detection with union-find merge ---
    // Stories within the same group already run sequentially (conflict-detected).
    // We check cross-group collisions only.

    const parent = Array.from({ length: batchGroups.length }, (_, i) => i)

    function find(x: number): number {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]! // path compression
        x = parent[x]!
      }
      return x
    }

    function union(x: number, y: number): void {
      const rx = find(x)
      const ry = find(y)
      if (rx !== ry) parent[rx] = ry
    }

    let collisionCount = 0
    const collisionEvents: Array<{ storyKeys: string[]; collisionPaths: string[] }> = []

    for (let i = 0; i < batchGroups.length; i++) {
      for (let j = i + 1; j < batchGroups.length; j++) {
        if (find(i) === find(j)) continue // already in same union

        const groupA = batchGroups[i] ?? []
        const groupB = batchGroups[j] ?? []

        const filesA = new Set<string>()
        const filesB = new Set<string>()
        const keysA: string[] = []
        const keysB: string[] = []

        for (const key of groupA) {
          const files = storyFileMap.get(key)
          if (files !== undefined) {
            keysA.push(key)
            for (const f of files) filesA.add(f)
          }
        }
        for (const key of groupB) {
          const files = storyFileMap.get(key)
          if (files !== undefined) {
            keysB.push(key)
            for (const f of files) filesB.add(f)
          }
        }

        if (keysA.length === 0 || keysB.length === 0) continue

        const collisionPaths = [...filesA].filter((f) => filesB.has(f))
        if (collisionPaths.length > 0) {
          union(i, j)
          collisionCount++
          collisionEvents.push({ storyKeys: [...keysA, ...keysB], collisionPaths })
        }
      }
    }

    if (collisionCount === 0) return batchGroups

    // --- Emit collision events ---
    for (const evt of collisionEvents) {
      try {
        eventBus.emit('dispatch:cross-story-file-collision', {
          storyKeys: evt.storyKeys,
          collisionPaths: evt.collisionPaths,
          recommendedAction: 'serialize',
        })
      } catch {
        // Event bus emission is best-effort
      }
      logger.info(
        { storyKeys: evt.storyKeys, collisionPaths: evt.collisionPaths },
        'Cross-story file collision detected — serializing affected groups to prevent race conditions',
      )
    }

    // --- Rebuild groups based on union-find roots ---
    const mergedGroupMap = new Map<number, string[]>()
    for (let i = 0; i < batchGroups.length; i++) {
      const group = batchGroups[i] ?? []
      const root2 = find(i)
      const existing = mergedGroupMap.get(root2) ?? []
      mergedGroupMap.set(root2, [...existing, ...group])
    }

    const result = [...mergedGroupMap.values()]
    logger.info(
      {
        originalGroupCount: batchGroups.length,
        mergedGroupCount: result.length,
        collisionCount,
      },
      'Story groups re-arranged after cross-story collision detection',
    )

    return result
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
      if (_shutdownRequested) return  // shutdown requested — no new dispatches (Story 58-7)
      const group = queue.shift()
      if (group === undefined) return

      const p: Promise<void> = processConflictGroup(group).finally(() => {
        running.delete(p)
        // Immediately fill open concurrency slots when a story completes.
        // This callback-based approach avoids Promise.race timing issues
        // where .finally() mutations to the running set were invisible to
        // the awaiting code.
        // Guard against budget/shutdown so enqueue() can't return early
        // (without queue.shift()) and spin the while loop infinitely.
        while (running.size < maxConcurrency && queue.length > 0 && !_budgetExhausted && !_shutdownRequested) {
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

  /**
   * Graceful shutdown handler for SIGTERM and SIGINT (Story 58-7, AC2).
   *
   * Idempotent: subsequent calls during the same run are no-ops.
   * Sets `_shutdownRequested` to stop new dispatches, waits for in-flight
   * dispatches to drain (up to `shutdownGracePeriodMs`), persists stopped state
   * to the run manifest and Dolt (best-effort), then calls process.exit.
   */
  async function shutdownGracefully(reason: string, signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
    if (_shutdownRequested) return // idempotent
    _shutdownRequested = true
    logger.info({ reason, signal }, 'Graceful shutdown initiated — stopping new dispatches')

    const gracePeriod = config.shutdownGracePeriodMs ?? 5000
    if (_inFlightCount > 0) {
      await Promise.race([
        _drainPromise,
        new Promise<void>(r => setTimeout(r, gracePeriod)),
      ])
    }

    // Persist stopped state to run manifest (best-effort)
    if (runManifest !== null) {
      await runManifest
        .patchRunStatus({
          run_status: 'stopped',
          stopped_reason: reason,
          stopped_at: new Date().toISOString(),
        })
        .catch((err: unknown) =>
          logger.warn({ err }, 'patchRunStatus failed during shutdown (best-effort)'),
        )
    }

    // Update Dolt pipeline_runs.status = 'stopped' (best-effort)
    if (config.pipelineRunId !== undefined) {
      await updatePipelineRun(db, config.pipelineRunId, { status: 'stopped' }).catch((err: unknown) =>
        logger.warn({ err }, 'updatePipelineRun(stopped) failed during shutdown (best-effort)'),
      )
    }

    // Transition active wg_stories to 'cancelled' (best-effort, Story 58-7 AC2)
    const activePhases: StoryPhase[] = [
      'PENDING',
      'IN_STORY_CREATION',
      'IN_TEST_PLANNING',
      'IN_DEV',
      'IN_REVIEW',
      'NEEDS_FIXES',
      'CHECKPOINT',
    ]
    const cancellations: Array<Promise<void>> = []
    for (const [storyKey, state] of _stories.entries()) {
      if (activePhases.includes(state.phase)) {
        cancellations.push(
          wgRepo
            .updateStoryStatus(storyKey, 'cancelled')
            .catch((err: unknown) =>
              logger.warn({ err, storyKey }, 'wg_stories → cancelled failed during shutdown (best-effort)'),
            ),
        )
      }
    }
    if (cancellations.length > 0) {
      await Promise.allSettled(cancellations)
    }

    process.exit(signal === 'SIGINT' ? 130 : 143)
  }

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

    // Story 75-2: capture the orchestrator start branch at run-startup.
    // Used by the merge-to-main phase to know which branch to merge story branches into.
    // Captured once here; persisted to run manifest after initialization below.
    // Stored in _orchestratorStartBranch (closure var) so processStory can access it.
    if (projectRoot !== undefined) {
      try {
        _orchestratorStartBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
        logger.info({ orchestratorStartBranch: _orchestratorStartBranch }, 'Captured orchestrator start branch for merge-to-main')
        // A5.1 F4: pin the trusted-tree SHA for acceptance spec loads — only in
        // BLOCKING mode, the only mode where a tampered registry flips an
        // outcome (advisory just reports, so live HEAD is fine there). Scoping
        // to blocking also keeps this extra `git rev-parse` out of the vast
        // majority of runs that don't use the gate.
        if ((config.acceptanceMode ?? 'advisory') === 'blocking') {
          try {
            _runStartSha = execSync('git rev-parse HEAD', {
              cwd: projectRoot,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }).trim() || undefined
          } catch {
            _runStartSha = undefined // fall back to HEAD in the loaders
          }
        }
        // A5.1 F3 (red-team): in --no-worktree mode the acceptance spec-tamper
        // tripwire is a vacuous self-compare (trusted == working dir), so an
        // agent in the main tree can weaken the registry/contract/deferrals
        // undetected. Blocking-mode integrity depends on the tripwire — warn
        // loudly. (Full close = A5.4 run-start snapshot compare.)
        if (config.noWorktree === true && (config.acceptanceMode ?? 'advisory') === 'blocking') {
          const warnMsg =
            'acceptance-tamper-guard-disabled: --no-worktree + acceptance.mode blocking — the spec-tamper tripwire cannot function without worktree isolation (trusted == working tree). An agent can weaken journey specs undetected. Prefer worktree isolation for blocking-mode acceptance.'
          logger.warn({ storyScope: storyKeys }, warnMsg)
          eventBus.emit('orchestrator:story-warn', { storyKey: '(run)', msg: warnMsg })
        }
      } catch (branchErr) {
        if (config.noWorktree !== true) {
          // H3.3 (AC3): with worktrees active, no start branch means NO story
          // can ever finalize — every dispatch would burn tokens and then
          // silently hand-land. Pre-fix this was a warn that disabled merge
          // integration for the whole run. Fail loud, before any dispatch.
          logger.error(
            { err: branchErr },
            'FATAL: failed to capture the orchestrator start branch (git rev-parse --abbrev-ref HEAD). ' +
              'Worktree finalization cannot work without it. Fix git in the project root or re-run with --no-worktree.',
          )
          _state = 'FAILED'
          _completedAt = new Date().toISOString()
          return getStatus()
        }
        logger.warn({ err: branchErr }, 'Failed to capture orchestrator start branch — merge-to-main will skip worktree integration (--no-worktree run)')
      }
    }

    // Initialize story states (in-memory only).
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

    // Story 60-14: emit probe-author phase mode telemetry. Powers the A/B
    // validation harness — every dispatch is tagged with its arm of the
    // experiment so post-run analysis can compute catch rate per arm.
    {
      const cliMode = config.probeAuthorMode
      let effectiveMode: 'enabled' | 'disabled'
      let source: 'cli' | 'env' | 'default'
      if (cliMode === 'enabled' || cliMode === 'disabled') {
        effectiveMode = cliMode
        source = 'cli'
      } else {
        // 'auto' or undefined → consult env, default true (enabled)
        const envValue = process.env.SUBSTRATE_PROBE_AUTHOR_ENABLED
        if (envValue === 'false' || envValue === '0') {
          effectiveMode = 'disabled'
          source = 'env'
        } else if (envValue === 'true' || envValue === '1') {
          effectiveMode = 'enabled'
          source = 'env'
        } else {
          effectiveMode = 'enabled'
          source = 'default'
        }
      }
      _probeAuthorEffectiveMode = effectiveMode
      eventBus.emit('probe-author:enabled', {
        runId: config.pipelineRunId ?? '',
        mode: effectiveMode,
        source,
      })
    }

    await persistState()
    recordProgress()
    // Only start heartbeat/watchdog when --events mode is active (AC1, Issue 5)
    if (config.enableHeartbeat) {
      startHeartbeat()
    }

    // Story 75-2: persist orchestrator start branch to run manifest so merge-to-main
    // can read the base branch at merge time. Best-effort — never block the pipeline.
    if (_orchestratorStartBranch !== undefined && runManifest !== null) {
      runManifest
        .patchRunStatus({ orchestrator_start_branch: _orchestratorStartBranch })
        .catch((err: unknown) =>
          logger.warn({ err }, 'Failed to persist orchestrator_start_branch to manifest (best-effort)'),
        )
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

    // Install SIGTERM/SIGINT handlers (Story 58-7, AC1).
    // Scoped to this run() invocation — removed in finally to prevent test leakage.
    const sigtermHandler = (): void => { void shutdownGracefully('killed_by_user', 'SIGTERM') }
    const sigintHandler = (): void => { void shutdownGracefully('killed_by_user', 'SIGINT') }
    process.on('SIGTERM', sigtermHandler)
    process.on('SIGINT', sigintHandler)

    // Pre-flight build gate (Story 25-2): verify project builds before dispatching any story.
    // Reuses runBuildVerification() from Story 24-2. Respects verifyCommand config (AC3) and
    // auto-detects the package manager (AC4). Skip when skipPreflight=true (AC5).
    try {
      // Initialize StateStore (Story 26-4, AC7): open connections before any dispatch.
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

      // Query interface-contract declarations from the decision store (canonical surface).
      // These are populated during create-story; on a fresh run there may be no declarations
      // yet — `detectConflictGroupsWithContracts` gracefully falls back to a single batch.
      const interfaceContractDecisions = await getDecisionsByCategory(db, 'interface-contract')
      const contractDeclarations: ContractDeclaration[] = interfaceContractDecisions
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
        // Story 68-1: Before each batch, detect cross-story file collisions and serialize colliding groups.
        // Story 70-1: After each batch, invoke cross-story race recovery if collision event fired.
        for (const rawBatchGroups of batches) {
          const batchGroups = detectAndSerializeConcurrentFileCollisions(rawBatchGroups)

          // Story 70-1: Track whether dispatch:cross-story-file-collision fires during this batch.
          // If it does, stale verifications may exist and recovery must run after batch completion.
          let collisionFired = false
          const collisionListener = (_evt: OrchestratorEvents['dispatch:cross-story-file-collision']): void => { collisionFired = true }
          eventBus.on('dispatch:cross-story-file-collision', collisionListener)

          await runWithConcurrency(batchGroups, config.maxConcurrency)

          // Deregister listener immediately after batch completes to avoid cross-batch leakage.
          eventBus.off('dispatch:cross-story-file-collision', collisionListener)

          // Story 70-1: If a cross-story collision was detected during this batch, run stale
          // verification recovery. Recovery is a no-op when no stale verifications are found
          // (idempotent). Only invoked when collisionFired to avoid unnecessary overhead.
          if (collisionFired && runManifest !== null && runManifest !== undefined) {
            const batchStoryKeys = batchGroups.flat()
            const batchEntries: BatchEntry[] = batchStoryKeys.map((key) => ({ storyKey: key }))
            const runId = config.pipelineRunId ?? 'unknown'
            try {
              const recoveryResult = await runStaleVerificationRecovery({
                runId,
                batch: batchEntries,
                workingDir: projectRoot ?? process.cwd(),
                bus: toSdlcEventBus(eventBus),
                manifest: runManifest,
                adapter: db,
              })
              if (!recoveryResult.noStale) {
                logger.info(
                  {
                    recovered: recoveryResult.recovered,
                    stillFailed: recoveryResult.stillFailed,
                    recoveredCount: recoveryResult.recovered.length,
                    stillFailedCount: recoveryResult.stillFailed.length,
                  },
                  'Cross-story race recovery complete',
                )
              }
            } catch (recoveryErr) {
              // Non-fatal: recovery failure must not abort the pipeline
              logger.warn({ err: recoveryErr }, 'Cross-story race recovery failed (non-fatal) — pipeline continues')
            }
          }
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

      // A0.3 (acceptance-gate): run-end journey coverage sweep. Final scope
      // (audits the FULL registry) + persists the ledger to the manifest.
      // A5.1 F5 (red-team): this is the BACKSTOP for the epic-close audit's
      // skip paths (concurrency race, escalate-before-audit). In blocking mode
      // any critical journey still unclaimed/unwalked/walked-fail at run end is
      // a loud, operator-visible violation — the stories already terminated, so
      // this cannot un-merge, but it must not be silent (the F2 schema fix
      // requires epic on criticals, so the common case is caught at epic close;
      // this covers the residual races).
      try {
        const finalAudit = await auditJourneyCoverage({ final: true }, { persist: true })
        if ((config.acceptanceMode ?? 'advisory') === 'blocking' && finalAudit !== undefined) {
          const criticalViolations = finalAudit.entries.filter(
            (e) => e.criticality === 'critical' && (e.state === 'unclaimed' || e.state === 'unwalked' || e.state === 'walked-fail'),
          )
          if (criticalViolations.length > 0) {
            const msg =
              `acceptance-coverage-violation (run end): ${String(criticalViolations.length)} journey-critical violation(s) survived to run end — ` +
              criticalViolations.map((v) => `${v.journeyId} [${v.state}]`).join(', ') +
              '. In blocking mode these should have been caught at epic close; a residual here indicates a concurrency race or an epic that never formally closed. Inspect the coverage ledger in `substrate report`.'
            logger.error({ criticalViolations: criticalViolations.map((v) => v.journeyId) }, msg)
            eventBus.emit('orchestrator:story-warn', { storyKey: '(run)', msg })
          }
        }
      } catch (err) {
        logger.warn({ err }, 'A0.3: run-end coverage sweep failed (best-effort)')
      }

      // Tally results.
      // Story 58-12: ESCALATED phase always counts as escalated, regardless of
      // the `error` field. The error-presence partition made `orchestrator:complete`
      // report an `escalated: 0` tally for every real-world escalation path
      // (strata obs_2026-04-22_008, mirrored at the pipeline:complete layer).
      let completed = 0
      let escalated = 0
      let failed = 0
      for (const s of _stories.values()) {
        if (s.phase === 'COMPLETE') completed++
        else if (s.phase === 'ESCALATED') escalated++
        else if (s.phase === 'VERIFICATION_FAILED') {
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
      // Story 58-7, AC1: Remove signal handlers on clean exit to prevent test leakage.
      process.off('SIGTERM', sigtermHandler)
      process.off('SIGINT', sigintHandler)

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
