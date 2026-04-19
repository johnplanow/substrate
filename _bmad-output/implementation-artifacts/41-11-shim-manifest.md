# Shim Manifest — Epic 41

Total shim files: 57

> **Note on import path compliance (AC5):** All production shim files have been updated to use
> the `@substrate-ai/core` alias. Test files (`git-worktree-merge.test.ts`,
> `git-worktree-manager.test.ts`) retain direct `packages/core/src/git/git-utils.js` paths in
> `vi.mock()` calls — this is intentional test infrastructure: Vitest must target the exact
> internal module path that `GitWorktreeManagerImpl` imports. These are not production imports.

| src/ Shim Path | Exported Symbols | Originating Story |
|---|---|---|
| src/core/event-bus.ts | TypedEventBus (type), TypedEventBusImpl, createEventBus | 41-1 |
| src/core/errors.ts | AdtError, ConfigError, ConfigIncompatibleFormatError (re-exported from core; local extensions also defined) | 41-1 |
| src/modules/agent-dispatch/dispatcher-impl.ts | DispatcherImpl (re-exported from core; local createDispatcher wrapper also defined) | 41-2 |
| src/modules/agent-dispatch/yaml-parser.ts | extractYamlBlock, parseYamlResult | 41-2 |
| src/modules/agent-dispatch/types.ts | DispatcherShuttingDownError (partial shim; rest are local types) | 41-2 |
| src/persistence/adapter.ts | DatabaseAdapter, SyncAdapter, DatabaseAdapterConfig, isSyncAdapter, DoltClientLike (re-exported; local createDatabaseAdapter wrapper also defined) | 41-3 |
| src/persistence/dolt-adapter.ts | DoltDatabaseAdapter, DoltClientLike | 41-3 |
| src/persistence/memory-adapter.ts | InMemoryDatabaseAdapter | 41-3 |
| src/persistence/schema.ts | initSchema | 41-3 |
| src/persistence/schemas/decisions.ts | PhaseEnum, RequirementPriorityEnum, RequirementTypeEnum, PipelineRunStatusEnum, DecisionSchema, CreateDecisionInputSchema, RequirementSchema, CreateRequirementInputSchema, ConstraintSchema, CreateConstraintInputSchema, ArtifactSchema, RegisterArtifactInputSchema, PipelineRunSchema, CreatePipelineRunInputSchema, TokenUsageSchema, AddTokenUsageInputSchema + 16 type re-exports | 41-3 |
| src/persistence/schemas/operational.ts | OPERATIONAL_FINDING, EXPERIMENT_RESULT, STORY_METRICS, ESCALATION_DIAGNOSIS, STORY_OUTCOME, TEST_EXPANSION_FINDING, TEST_PLAN, ADVISORY_NOTES | 41-3 |
| src/persistence/queries/amendments.ts | createAmendmentRun, loadParentRunDecisions, supersedeDecision, getActiveDecisions, getAmendmentRunChain, getLatestCompletedRun + 4 type re-exports | 41-3 |
| src/persistence/queries/cost.ts | recordCostEntry, getCostEntryById, incrementTaskCost, getSessionCostSummary, getSessionCostSummaryFiltered, getTaskCostSummary, getAgentCostBreakdown, getAllCostEntries, getAllCostEntriesFiltered, getPlanningCostTotal, getSessionCost, getTaskCost + 2 type re-exports | 41-3 |
| src/persistence/queries/decisions.ts | createDecision, upsertDecision, getDecisionsByPhase, getDecisionsByPhaseForRun, getDecisionsByCategory, getDecisionByKey, updateDecision, createRequirement, listRequirements, updateRequirementStatus, createConstraint, listConstraints, registerArtifact, getArtifactsByPhase, getArtifactByType, getArtifactByTypeForRun, getArtifactsByRun, getPipelineRunById, updatePipelineRunConfig, createPipelineRun, updatePipelineRun, getRunningPipelineRuns, getLatestRun, addTokenUsage, getTokenUsageSummary + 13 type re-exports | 41-3 |
| src/persistence/queries/metrics.ts | writeRunMetrics, getRunMetrics, listRunMetrics, tagRunAsBaseline, getBaselineRunMetrics, incrementRunRestarts, writeStoryMetrics, getStoryMetricsForRun, compareRunMetrics, getRunSummaryForSupervisor, aggregateTokenUsageForRun, aggregateTokenUsageForStory + 7 type re-exports | 41-3 |
| src/persistence/queries/retry-escalated.ts | getRetryableEscalations + SkippedStory, RetryableEscalationsResult | 41-3 |
| src/modules/routing/index.ts | RoutingEngine, RoutingEngineImplOptions (as RoutingEngineOptions), createRoutingEngine, RoutingDecision, makeRoutingDecision, RoutingDecisionBuilder, ProviderStatus, ProviderStatusTracker, RoutingPolicy et al., RoutingEngineImpl, ModelRoutingConfig et al., ModelResolution, RoutingResolver, RoutingTokenAccumulator, RoutingTelemetry, RoutingRecommender, RoutingTuner, getModelTier | 41-4 |
| src/modules/config/index.ts | createConfigSystem, ConfigSystemImpl, ConfigSystem, ConfigSystemOptions, SubstrateConfigSchema, PartialSubstrateConfigSchema, SubstrateConfig, PartialSubstrateConfig, DEFAULT_CONFIG, ConfigWatcher, createConfigWatcher, flattenObject, computeChangedKeys, ConfigMigrator, defaultConfigMigrator, MigrationResult, version utilities | 41-5 |
| src/modules/telemetry/ingestion-server.ts | IngestionServer, TelemetryError, IngestionServerOptions, DispatchContext | 41-6a |
| src/modules/telemetry/cost-table.ts | estimateCost, COST_TABLE, resolveModel | 41-6a |
| src/modules/telemetry/normalizer.ts | TelemetryNormalizer | 41-6a |
| src/modules/telemetry/timestamp-normalizer.ts | normalizeTimestamp | 41-6a |
| src/modules/telemetry/batch-buffer.ts | BatchBuffer, BatchBufferOptions | 41-6a |
| src/modules/telemetry/token-extractor.ts | extractTokensFromAttributes, extractTokensFromBody, mergeTokenCounts | 41-6a |
| src/modules/telemetry/telemetry-pipeline.ts | TelemetryPipeline, RawOtlpPayload, TelemetryPipelineDeps | 41-6a |
| src/modules/telemetry/source-detector.ts | detectSource, OtlpSource | 41-6a |
| src/modules/telemetry/turn-analyzer.ts | TurnAnalyzer | 41-6b |
| src/modules/telemetry/consumer-analyzer.ts | ConsumerAnalyzer | 41-6b |
| src/modules/telemetry/log-turn-analyzer.ts | LogTurnAnalyzer | 41-6b |
| src/modules/telemetry/categorizer.ts | Categorizer | 41-6b |
| src/modules/telemetry/efficiency-scorer.ts | EfficiencyScorer, createEfficiencyScorer | 41-6b |
| src/modules/telemetry/recommender.ts | Recommender | 41-6b |
| src/modules/budget/budget-tracker.ts | BudgetTracker, BudgetTrackerOptions, BudgetTrackerImpl, createBudgetTracker | 41-7 |
| src/modules/cost-tracker/index.ts | CostTracker, CostTrackerOptions, CostTrackerImpl, createCostTracker, CostTrackerSubscriber, createCostTrackerSubscriber, CostTrackerSubscriberOptions, CostEntry, TaskCostSummary, SessionCostSummary, AgentCostBreakdown, TokenRates, ModelRates, TOKEN_RATES, PROVIDER_ALIASES, getTokenRate, estimateCost, estimateCostSafe | 41-7 |
| src/modules/monitor/index.ts | MonitorAgent, TaskMetrics, MonitorAgentImpl, createMonitorAgent, MonitorConfig, MonitorAgentOptions, TaskTypeClassifier, createTaskTypeClassifier, DEFAULT_TAXONOMY, MonitorReport, ReportGeneratorOptions, generateMonitorReport, Recommendation, ConfidenceLevel, RecommendationFilters, RecommendationExport, createRecommendation, RecommendationEngine, createRecommendationEngine, MonitorRecommendationConfig, AgentPerformanceMetrics, TaskTypeBreakdownResult | 41-7 |
| src/persistence/monitor-database.ts | TaskMetricsRow, AggregateStats, MonitorDatabase, MonitorDatabaseImpl, createMonitorDatabase | 41-7 |
| src/adapters/adapter-registry.ts | AdapterRegistry, AdapterDiscoveryResult, DiscoveryReport | 41-8 |
| src/adapters/claude-adapter.ts | ClaudeCodeAdapter | 41-8 |
| src/adapters/codex-adapter.ts | CodexCLIAdapter | 41-8 |
| src/adapters/gemini-adapter.ts | GeminiCLIAdapter | 41-8 |
| src/adapters/schemas.ts | BillingModeSchema, SpawnCommandSchema, AdapterOptionsSchema, AdapterCapabilitiesSchema, AdapterHealthResultSchema, TokenEstimateSchema, TaskResultSchema, PlannedTaskSchema, PlanParseResultSchema, validateWithSchema, validateSpawnCommand, validateAdapterCapabilities, validateAdapterHealthResult | 41-8 |
| src/modules/git/index.ts | GitManager, GitManagerOptions, GitManagerImpl, createGitManager | 41-8 |
| src/modules/git/git-manager.ts | GitManager, GitManagerOptions, GitManagerImpl, createGitManager | 41-8 |
| src/modules/git-worktree/git-utils.ts | spawnGit, getGitVersion, parseGitVersion, isGitVersionSupported, verifyGitVersion, createWorktree, removeWorktree, removeBranch, getOrphanedWorktrees, simulateMerge, abortMerge, getConflictingFiles, performMerge, getMergedFiles | 41-8 |
| src/modules/git-worktree/git-worktree-manager.ts | GitWorktreeManager (shim re-export from core) | 41-8 |
| src/modules/git-worktree/git-worktree-manager-impl.ts | GitWorktreeManagerImpl, createGitWorktreeManager (shim re-export from core) | 41-8 |
| src/modules/git-worktree/index.ts | All git-worktree exports (shim barrel re-export from core) | 41-8 |
| src/modules/version-manager/index.ts | VersionManager, VersionCheckResult, UpgradePreview, VersionManagerDeps, VersionManagerImpl, createVersionManager, UpdateChecker, UpdateCheckError, VersionCacheEntry, VersionCache | 41-8 |
| src/modules/version-manager/update-checker.ts | UpdateChecker, UpdateCheckError | 41-8 |
| src/modules/version-manager/version-manager.ts | VersionManager, VersionCheckResult, UpgradePreview | 41-8 |
| src/modules/version-manager/version-cache.ts | VersionCacheEntry, VersionCache | 41-8 |
| src/modules/version-manager/version-manager-impl.ts | VersionManagerImpl, createVersionManager | 41-8 |
| src/modules/supervisor/index.ts | analyzeTokenEfficiency, analyzeTimings, generateRecommendations, generateAnalysisReport, writeAnalysisReport, buildBranchName, buildWorktreePath, buildModificationDirective, resolvePromptFile, determineVerdict, buildPRBody, buildAuditLogEntry, createExperimenter + all supervisor type re-exports | 41-9 |
| src/modules/supervisor/analysis.ts | All analysis functions and types from core supervisor | 41-9 |
| src/modules/supervisor/experimenter.ts | All experimenter types and functions from core supervisor | 41-9 |
| src/modules/state/dolt-client.ts | DoltClient, createDoltClient, DoltClientOptions | 41-10 |
| src/modules/state/dolt-init.ts | initializeDolt, checkDoltInstalled, runDoltCommand, DoltNotInstalled, DoltInitError, DoltInitConfig | 41-10 |

## Circular Dependency Audit Results

| Entry Point | Result | Files Processed |
|---|---|---|
| packages/core/src/index.ts | ✔ No circular dependency found! | 109 |
| packages/sdlc/src/index.ts | ✔ No circular dependency found! | 111 |
| packages/factory/src/index.ts | ✔ No circular dependency found! | 111 |
| src/index.ts (monolith) | ✔ No circular dependency found! | 134 |
