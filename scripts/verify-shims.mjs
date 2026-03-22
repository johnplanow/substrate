#!/usr/bin/env tsx
/**
 * Shim Resolution Verification Script
 *
 * Verifies that every re-export shim from Epic 41 (stories 41-1 through 41-10) resolves
 * correctly to its @substrate-ai/core implementation at runtime.
 *
 * Strategy: Dynamically import each shimmed src/ path directly. This confirms that:
 *   1. The shim file can be imported without error (no MODULE_NOT_FOUND, no syntax errors)
 *   2. Each expected symbol is defined and non-null in the shim's export surface
 *   3. @substrate-ai/core itself resolves to packages/core/dist/ (module origin check)
 *
 * A broken shim — wrong re-export path, internal circular import, missing barrel export,
 * or MODULE_NOT_FOUND in its own dependency chain — will cause the dynamic import to throw
 * and be recorded as a failure.
 *
 * Uses tsx as runtime to correctly resolve .ts files and .js → .ts extension remapping.
 *
 * Run: npx tsx scripts/verify-shims.mjs
 * Expected output: "All N shims verified" where N = 57 (total shim files in manifest)
 */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Step 1: Verify @substrate-ai/core resolves to packages/core/dist/
// ---------------------------------------------------------------------------

let coreModulePath
try {
  // import.meta.resolve() works correctly with ESM conditional exports
  const resolved = await import.meta.resolve('@substrate-ai/core')
  coreModulePath = fileURLToPath(resolved)
} catch (err) {
  console.error('✗ FATAL: @substrate-ai/core could not be resolved:', err.message)
  console.error('  Run `npm run build` first to build packages/core/dist/')
  process.exit(1)
}

if (!coreModulePath.startsWith(join(projectRoot, 'packages', 'core', 'dist'))) {
  console.error(`✗ FATAL: @substrate-ai/core resolved to unexpected path:`)
  console.error(`  Got:      ${coreModulePath}`)
  console.error(`  Expected: path starting with ${join(projectRoot, 'packages', 'core', 'dist')}`)
  process.exit(1)
}

console.log(`✔ @substrate-ai/core → ${coreModulePath.replace(projectRoot, '.')}`)
console.log()

// ---------------------------------------------------------------------------
// Step 2: Shim registry — maps each shim file to the symbols it re-exports
// Type-only exports (interfaces, type aliases) are marked with 'type:' prefix
// and are not verifiable at runtime (TypeScript erases them).
// ---------------------------------------------------------------------------

const shims = [
  // Story 41-1: Event Bus Migration
  {
    path: 'src/core/event-bus.ts',
    story: '41-1',
    symbols: ['TypedEventBusImpl', 'createEventBus'],
    typeOnly: ['TypedEventBus'],
  },
  {
    path: 'src/core/errors.ts',
    story: '41-1',
    symbols: ['AdtError', 'ConfigError', 'ConfigIncompatibleFormatError'],
    typeOnly: [],
    note: 'Hybrid: also defines local error subclasses',
  },

  // Story 41-2: Dispatcher Migration
  {
    path: 'src/modules/agent-dispatch/dispatcher-impl.ts',
    story: '41-2',
    symbols: ['DispatcherImpl'],
    typeOnly: [],
    note: 'Hybrid: also defines local createDispatcher wrapper',
  },
  {
    path: 'src/modules/agent-dispatch/yaml-parser.ts',
    story: '41-2',
    symbols: ['extractYamlBlock', 'parseYamlResult'],
    typeOnly: [],
  },
  {
    path: 'src/modules/agent-dispatch/types.ts',
    story: '41-2',
    symbols: ['DispatcherShuttingDownError'],
    typeOnly: [],
    note: 'Partial shim: only DispatcherShuttingDownError is from core; rest are local',
  },

  // Story 41-3: Persistence Layer Migration
  {
    path: 'src/persistence/adapter.ts',
    story: '41-3',
    symbols: ['isSyncAdapter'],
    typeOnly: ['DatabaseAdapter', 'SyncAdapter', 'DatabaseAdapterConfig', 'DoltClientLike'],
    note: 'Hybrid: local createDatabaseAdapter wrapper with DoltClient injection',
  },
  {
    path: 'src/persistence/dolt-adapter.ts',
    story: '41-3',
    symbols: ['DoltDatabaseAdapter'],
    typeOnly: ['DoltClientLike'],
  },
  {
    path: 'src/persistence/memory-adapter.ts',
    story: '41-3',
    symbols: ['InMemoryDatabaseAdapter'],
    typeOnly: [],
  },
  {
    path: 'src/persistence/schema.ts',
    story: '41-3',
    symbols: ['initSchema'],
    typeOnly: [],
  },
  {
    path: 'src/persistence/schemas/decisions.ts',
    story: '41-3',
    symbols: [
      'PhaseEnum', 'RequirementPriorityEnum', 'RequirementTypeEnum', 'PipelineRunStatusEnum',
      'DecisionSchema', 'CreateDecisionInputSchema', 'RequirementSchema', 'CreateRequirementInputSchema',
      'ConstraintSchema', 'CreateConstraintInputSchema', 'ArtifactSchema', 'RegisterArtifactInputSchema',
      'PipelineRunSchema', 'CreatePipelineRunInputSchema', 'TokenUsageSchema', 'AddTokenUsageInputSchema',
    ],
    typeOnly: ['Phase', 'RequirementPriority', 'RequirementType', 'PipelineRunStatus', 'Decision',
      'CreateDecisionInput', 'Requirement', 'CreateRequirementInput', 'Constraint', 'CreateConstraintInput',
      'Artifact', 'RegisterArtifactInput', 'PipelineRun', 'CreatePipelineRunInput', 'TokenUsage', 'AddTokenUsageInput'],
  },
  {
    path: 'src/persistence/schemas/operational.ts',
    story: '41-3',
    symbols: ['OPERATIONAL_FINDING', 'EXPERIMENT_RESULT', 'STORY_METRICS', 'ESCALATION_DIAGNOSIS',
      'STORY_OUTCOME', 'TEST_EXPANSION_FINDING', 'TEST_PLAN', 'ADVISORY_NOTES'],
    typeOnly: [],
  },
  {
    path: 'src/persistence/queries/amendments.ts',
    story: '41-3',
    symbols: ['createAmendmentRun', 'loadParentRunDecisions', 'supersedeDecision',
      'getActiveDecisions', 'getAmendmentRunChain', 'getLatestCompletedRun'],
    typeOnly: ['CreateAmendmentRunInput', 'ActiveDecisionsFilter', 'SupersessionEvent', 'AmendmentChainEntry'],
  },
  {
    path: 'src/persistence/queries/cost.ts',
    story: '41-3',
    symbols: ['recordCostEntry', 'getCostEntryById', 'incrementTaskCost', 'getSessionCostSummary',
      'getSessionCostSummaryFiltered', 'getTaskCostSummary', 'getAgentCostBreakdown', 'getAllCostEntries',
      'getAllCostEntriesFiltered', 'getPlanningCostTotal', 'getSessionCost', 'getTaskCost'],
    typeOnly: ['CreateCostEntryInput', 'LegacyCostEntryInput'],
  },
  {
    path: 'src/persistence/queries/decisions.ts',
    story: '41-3',
    symbols: ['createDecision', 'upsertDecision', 'getDecisionsByPhase', 'getDecisionsByPhaseForRun',
      'getDecisionsByCategory', 'getDecisionByKey', 'updateDecision', 'createRequirement',
      'listRequirements', 'updateRequirementStatus', 'createConstraint', 'listConstraints',
      'registerArtifact', 'getArtifactsByPhase', 'getArtifactByType', 'getArtifactByTypeForRun',
      'getArtifactsByRun', 'getPipelineRunById', 'updatePipelineRunConfig', 'createPipelineRun',
      'updatePipelineRun', 'getRunningPipelineRuns', 'getLatestRun', 'addTokenUsage', 'getTokenUsageSummary'],
    typeOnly: ['Decision', 'Requirement', 'Constraint', 'Artifact', 'PipelineRun', 'TokenUsage',
      'CreateDecisionInput', 'CreateRequirementInput', 'CreateConstraintInput', 'RegisterArtifactInput',
      'CreatePipelineRunInput', 'AddTokenUsageInput', 'TokenUsageSummary'],
  },
  {
    path: 'src/persistence/queries/metrics.ts',
    story: '41-3',
    symbols: ['writeRunMetrics', 'getRunMetrics', 'listRunMetrics', 'tagRunAsBaseline',
      'getBaselineRunMetrics', 'incrementRunRestarts', 'writeStoryMetrics', 'getStoryMetricsForRun',
      'compareRunMetrics', 'getRunSummaryForSupervisor', 'aggregateTokenUsageForRun', 'aggregateTokenUsageForStory'],
    typeOnly: ['RunMetricsInput', 'RunMetricsRow', 'StoryMetricsInput', 'StoryMetricsRow',
      'TokenAggregate', 'RunMetricsDelta', 'RunSummaryForSupervisor'],
  },
  {
    path: 'src/persistence/queries/retry-escalated.ts',
    story: '41-3',
    symbols: ['getRetryableEscalations'],
    typeOnly: ['SkippedStory', 'RetryableEscalationsResult'],
  },

  // Story 41-4: Routing Engine Migration
  {
    path: 'src/modules/routing/index.ts',
    story: '41-4',
    symbols: ['createRoutingEngine', 'makeRoutingDecision', 'RoutingDecisionBuilder',
      'ProviderStatusTracker', 'RoutingPolicySchema', 'ProviderPolicySchema', 'loadRoutingPolicy',
      'RoutingPolicyValidationError', 'RoutingEngineImpl', 'createRoutingEngineImpl',
      'ModelRoutingConfigSchema', 'RoutingConfigError', 'loadModelRoutingConfig',
      'RoutingResolver', 'TASK_TYPE_PHASE_MAP', 'ROUTING_RESOLVER_LOGGER_NAME',
      'RoutingTokenAccumulator', 'RoutingTelemetry', 'RoutingRecommender', 'RoutingTuner',
      'getModelTier'],
    typeOnly: ['RoutingEngine', 'RoutingEngineImplOptions', 'RoutingDecision', 'ProviderStatus',
      'RoutingPolicy', 'ProviderPolicy', 'TaskTypePolicy', 'DefaultRoutingPolicy',
      'ApiBillingConfig', 'RateLimitConfig', 'ModelRoutingConfig', 'ModelPhaseConfig',
      'ModelResolution', 'PhaseTokenEntry', 'PhaseTokenBreakdown', 'RoutingRecommendation',
      'RoutingAnalysis', 'TuneLogEntry'],
  },

  // Story 41-5: Config System Migration
  {
    path: 'src/modules/config/index.ts',
    story: '41-5',
    symbols: ['createConfigSystem', 'ConfigSystemImpl', 'createConfigWatcher', 'flattenObject',
      'computeChangedKeys', 'ConfigMigrator', 'defaultConfigMigrator', 'parseVersion',
      'isVersionSupported', 'getNextVersion', 'formatUnsupportedVersionError'],
    typeOnly: ['ConfigSystem', 'ConfigSystemOptions', 'ConfigWatcher', 'MigrationResult'],
    note: 'Hybrid: also re-exports local SubstrateConfigSchema, DEFAULT_CONFIG, etc.',
  },

  // Story 41-6a: Telemetry Pipeline Infrastructure
  {
    path: 'src/modules/telemetry/ingestion-server.ts',
    story: '41-6a',
    symbols: ['IngestionServer', 'TelemetryError'],
    typeOnly: ['IngestionServerOptions', 'DispatchContext'],
  },
  {
    path: 'src/modules/telemetry/cost-table.ts',
    story: '41-6a',
    symbols: ['COST_TABLE', 'estimateCost', 'resolveModel'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/normalizer.ts',
    story: '41-6a',
    symbols: ['TelemetryNormalizer'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/timestamp-normalizer.ts',
    story: '41-6a',
    symbols: ['normalizeTimestamp'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/batch-buffer.ts',
    story: '41-6a',
    symbols: ['BatchBuffer'],
    typeOnly: ['BatchBufferOptions'],
  },
  {
    path: 'src/modules/telemetry/token-extractor.ts',
    story: '41-6a',
    symbols: ['extractTokensFromAttributes', 'extractTokensFromBody', 'mergeTokenCounts'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/telemetry-pipeline.ts',
    story: '41-6a',
    symbols: ['TelemetryPipeline'],
    typeOnly: ['RawOtlpPayload', 'TelemetryPipelineDeps'],
  },
  {
    path: 'src/modules/telemetry/source-detector.ts',
    story: '41-6a',
    symbols: ['detectSource'],
    typeOnly: ['OtlpSource'],
  },

  // Story 41-6b: Telemetry Scoring Modules
  {
    path: 'src/modules/telemetry/turn-analyzer.ts',
    story: '41-6b',
    symbols: ['TurnAnalyzer'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/consumer-analyzer.ts',
    story: '41-6b',
    symbols: ['ConsumerAnalyzer'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/log-turn-analyzer.ts',
    story: '41-6b',
    symbols: ['LogTurnAnalyzer'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/categorizer.ts',
    story: '41-6b',
    symbols: ['Categorizer'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/efficiency-scorer.ts',
    story: '41-6b',
    symbols: ['EfficiencyScorer', 'createEfficiencyScorer'],
    typeOnly: [],
  },
  {
    path: 'src/modules/telemetry/recommender.ts',
    story: '41-6b',
    symbols: ['Recommender'],
    typeOnly: [],
  },

  // Story 41-7: Supervisor, Budget, CostTracker, Monitor Migration
  {
    path: 'src/modules/budget/budget-tracker.ts',
    story: '41-7',
    symbols: ['BudgetTrackerImpl', 'createBudgetTracker'],
    typeOnly: ['BudgetTracker', 'BudgetTrackerOptions'],
  },
  {
    path: 'src/modules/cost-tracker/index.ts',
    story: '41-7',
    symbols: ['CostTrackerImpl', 'createCostTracker', 'CostTrackerSubscriber', 'createCostTrackerSubscriber',
      'TOKEN_RATES', 'PROVIDER_ALIASES', 'getTokenRate', 'estimateCost', 'estimateCostSafe'],
    typeOnly: ['CostTracker', 'CostTrackerOptions', 'CostTrackerSubscriberOptions',
      'CostEntry', 'TaskCostSummary', 'SessionCostSummary', 'AgentCostBreakdown',
      'TokenRates', 'ModelRates'],
    note: 'estimateCost here is the cost-tracker variant; core exports both versions',
  },
  {
    path: 'src/modules/monitor/index.ts',
    story: '41-7',
    symbols: ['MonitorAgentImpl', 'createMonitorAgent', 'TaskTypeClassifier', 'createTaskTypeClassifier',
      'DEFAULT_TAXONOMY', 'generateMonitorReport', 'createRecommendation', 'RecommendationEngine',
      'createRecommendationEngine'],
    typeOnly: ['MonitorAgent', 'TaskMetrics', 'MonitorConfig', 'MonitorAgentOptions',
      'MonitorReport', 'ReportGeneratorOptions', 'Recommendation', 'ConfidenceLevel',
      'RecommendationFilters', 'RecommendationExport', 'MonitorRecommendationConfig',
      'AgentPerformanceMetrics', 'TaskTypeBreakdownResult'],
  },
  {
    path: 'src/persistence/monitor-database.ts',
    story: '41-7',
    symbols: ['MonitorDatabaseImpl', 'createMonitorDatabase'],
    typeOnly: ['TaskMetricsRow', 'AggregateStats', 'MonitorDatabase'],
  },

  // Story 41-8: Adapters, Git, VersionManager Migration
  {
    path: 'src/adapters/adapter-registry.ts',
    story: '41-8',
    symbols: ['AdapterRegistry'],
    typeOnly: ['AdapterDiscoveryResult', 'DiscoveryReport'],
  },
  {
    path: 'src/adapters/claude-adapter.ts',
    story: '41-8',
    symbols: ['ClaudeCodeAdapter'],
    typeOnly: [],
  },
  {
    path: 'src/adapters/codex-adapter.ts',
    story: '41-8',
    symbols: ['CodexCLIAdapter'],
    typeOnly: [],
  },
  {
    path: 'src/adapters/gemini-adapter.ts',
    story: '41-8',
    symbols: ['GeminiCLIAdapter'],
    typeOnly: [],
  },
  {
    path: 'src/adapters/schemas.ts',
    story: '41-8',
    symbols: ['BillingModeSchema', 'SpawnCommandSchema', 'AdapterOptionsSchema', 'AdapterCapabilitiesSchema',
      'AdapterHealthResultSchema', 'TokenEstimateSchema', 'TaskResultSchema', 'PlannedTaskSchema',
      'PlanParseResultSchema', 'validateWithSchema', 'validateSpawnCommand', 'validateAdapterCapabilities',
      'validateAdapterHealthResult'],
    typeOnly: [],
  },
  {
    path: 'src/modules/git/index.ts',
    story: '41-8',
    symbols: ['GitManagerImpl', 'createGitManager'],
    typeOnly: ['GitManager', 'GitManagerOptions'],
  },
  {
    path: 'src/modules/git/git-manager.ts',
    story: '41-8',
    symbols: ['GitManagerImpl', 'createGitManager'],
    typeOnly: ['GitManager', 'GitManagerOptions'],
  },
  {
    path: 'src/modules/git-worktree/git-utils.ts',
    story: '41-8',
    symbols: ['spawnGit', 'getGitVersion', 'parseGitVersion', 'isGitVersionSupported', 'verifyGitVersion',
      'createWorktree', 'removeWorktree', 'removeBranch', 'getOrphanedWorktrees', 'simulateMerge',
      'abortMerge', 'getConflictingFiles', 'performMerge', 'getMergedFiles'],
    typeOnly: [],
  },
  {
    path: 'src/modules/git-worktree/git-worktree-manager.ts',
    story: '41-8',
    symbols: [],
    typeOnly: ['GitWorktreeManager', 'WorktreeInfo', 'ConflictReport', 'MergeResult'],
    note: 'Type-only shim: all exports are TypeScript interfaces',
  },
  {
    path: 'src/modules/git-worktree/git-worktree-manager-impl.ts',
    story: '41-8',
    symbols: ['GitWorktreeManagerImpl', 'createGitWorktreeManager'],
    typeOnly: ['GitWorktreeManagerOptions'],
  },
  {
    path: 'src/modules/git-worktree/index.ts',
    story: '41-8',
    symbols: ['GitWorktreeManagerImpl', 'createGitWorktreeManager'],
    typeOnly: ['GitWorktreeManager', 'WorktreeInfo', 'ConflictReport', 'MergeResult', 'GitWorktreeManagerOptions'],
  },
  {
    path: 'src/modules/version-manager/index.ts',
    story: '41-8',
    symbols: ['VersionManagerImpl', 'createVersionManager', 'UpdateChecker', 'UpdateCheckError', 'VersionCache'],
    typeOnly: ['VersionManager', 'VersionCheckResult', 'UpgradePreview', 'VersionManagerDeps', 'VersionCacheEntry'],
  },
  {
    path: 'src/modules/version-manager/update-checker.ts',
    story: '41-8',
    symbols: ['UpdateChecker', 'UpdateCheckError'],
    typeOnly: [],
  },
  {
    path: 'src/modules/version-manager/version-manager.ts',
    story: '41-8',
    symbols: [],
    typeOnly: ['VersionManager', 'VersionCheckResult', 'UpgradePreview'],
    note: 'Type-only shim: all exports are TypeScript interfaces/types',
  },
  {
    path: 'src/modules/version-manager/version-cache.ts',
    story: '41-8',
    symbols: ['VersionCache'],
    typeOnly: ['VersionCacheEntry'],
  },
  {
    path: 'src/modules/version-manager/version-manager-impl.ts',
    story: '41-8',
    symbols: ['VersionManagerImpl', 'createVersionManager'],
    typeOnly: ['VersionManagerDeps'],
  },

  // Story 41-9: Supervisor Final Integration
  {
    path: 'src/modules/supervisor/index.ts',
    story: '41-9',
    symbols: ['analyzeTokenEfficiency', 'analyzeTimings', 'generateRecommendations', 'generateAnalysisReport',
      'writeAnalysisReport', 'buildBranchName', 'buildWorktreePath', 'buildModificationDirective',
      'resolvePromptFile', 'determineVerdict', 'buildPRBody', 'buildAuditLogEntry', 'createExperimenter'],
    typeOnly: ['PhaseDurations', 'TokenEfficiencyFinding', 'TimingFinding', 'TimingAnalysis',
      'RecommendationType', 'AnalysisRecommendation', 'AnalysisSummary', 'AnalysisFindings',
      'AnalysisReport', 'SupervisorRecommendation', 'ExperimentPhase', 'ExperimentVerdict',
      'ExperimentMetricDeltas', 'ExperimentResult', 'ExperimentConfig', 'ExperimentRunOptions',
      'RunStoryFn', 'ExperimenterDeps', 'Experimenter', 'SpawnFn'],
  },
  {
    path: 'src/modules/supervisor/analysis.ts',
    story: '41-9',
    symbols: ['analyzeTokenEfficiency', 'analyzeTimings', 'generateRecommendations', 'generateAnalysisReport',
      'writeAnalysisReport'],
    typeOnly: ['PhaseDurations', 'TokenEfficiencyFinding', 'TimingFinding', 'TimingAnalysis',
      'RecommendationType', 'AnalysisRecommendation', 'AnalysisSummary', 'AnalysisFindings', 'AnalysisReport'],
    note: 'buildBranchName and other experimenter helpers are in index.ts, not analysis.ts',
  },
  {
    path: 'src/modules/supervisor/experimenter.ts',
    story: '41-9',
    symbols: ['createExperimenter'],
    typeOnly: ['SpawnFn', 'SupervisorRecommendation', 'ExperimentPhase', 'ExperimentVerdict',
      'ExperimentMetricDeltas', 'ExperimentResult', 'ExperimentConfig', 'ExperimentRunOptions',
      'RunStoryFn', 'ExperimenterDeps', 'Experimenter'],
  },

  // Story 41-10: DoltClient and DoltInit Migration
  {
    path: 'src/modules/state/dolt-client.ts',
    story: '41-10',
    symbols: ['DoltClient', 'createDoltClient'],
    typeOnly: ['DoltClientOptions'],
  },
  {
    path: 'src/modules/state/dolt-init.ts',
    story: '41-10',
    symbols: ['initializeDolt', 'checkDoltInstalled', 'runDoltCommand', 'DoltNotInstalled', 'DoltInitError'],
    typeOnly: ['DoltInitConfig'],
  },
]

// ---------------------------------------------------------------------------
// Step 3: Dynamically import each shim file and verify its exported symbols
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failedDetails = []

for (const shim of shims) {
  // Type-only shims have no runtime-verifiable symbols — record as verified
  if (shim.symbols.length === 0) {
    const typeNote = shim.typeOnly.length > 0 ? ` [${shim.typeOnly.length} type-only exports, not verifiable at runtime]` : ''
    const noteStr = shim.note ? ` (${shim.note})` : ''
    console.log(`✓ [${shim.story}] ${shim.path} [type-only]${typeNote}${noteStr}`)
    passed++
    continue
  }

  try {
    // Dynamically import the actual shim file (not @substrate-ai/core)
    // Node.js 22+ supports .ts files natively via type stripping
    const shimUrl = pathToFileURL(join(projectRoot, shim.path)).href
    const mod = await import(shimUrl)

    const missing = []
    for (const sym of shim.symbols) {
      if (!(sym in mod)) {
        missing.push(`${sym} (not exported)`)
      } else if (mod[sym] === undefined || mod[sym] === null) {
        missing.push(`${sym} (null/undefined)`)
      }
    }

    if (missing.length === 0) {
      const typeNote = shim.typeOnly.length > 0 ? ` [${shim.typeOnly.length} type-only exports not verifiable at runtime]` : ''
      const noteStr = shim.note ? ` (${shim.note})` : ''
      console.log(`✓ [${shim.story}] ${shim.path}${typeNote}${noteStr}`)
      passed++
    } else {
      console.error(`✗ [${shim.story}] ${shim.path}`)
      console.error(`  Missing symbols: ${missing.join(', ')}`)
      failed++
      failedDetails.push({ path: shim.path, missing })
    }
  } catch (err) {
    console.error(`✗ [${shim.story}] ${shim.path}`)
    console.error(`  Import error: ${err.message}`)
    failed++
    failedDetails.push({ path: shim.path, missing: [`IMPORT_ERROR: ${err.message}`] })
  }
}

// ---------------------------------------------------------------------------
// Step 4: Summary
// ---------------------------------------------------------------------------

console.log()
console.log(`Module origin: ${coreModulePath.replace(projectRoot + '/', '')}`)
console.log()

if (failed > 0) {
  console.error(`✗ ${failed} shim(s) FAILED verification`)
  for (const { path, missing } of failedDetails) {
    console.error(`  ${path}: [${missing.join(', ')}]`)
  }
  console.error(`\nAll ${passed} shims verified (${failed} FAILED)`)
  process.exit(1)
} else {
  console.log(`All ${passed} shims verified`)
}
