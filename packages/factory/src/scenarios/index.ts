/**
 * Scenarios subsystem barrel exports.
 */
export { ScenarioStore } from './store.js'
export type { ScenarioEntry, ScenarioManifest, ScenarioStoreVerifyResult } from './types.js'
// Runner (story 44-2 / 44-5 / 47-3)
export { createScenarioRunner } from './runner.js'
export type { ScenarioRunner, ScenarioRunnerOptions, TwinCoordinator } from './runner.js'
// Scorer (stories 44-5, 46-1)
export { computeSatisfactionScore, createSatisfactionScorer } from './scorer.js'
export type {
  SatisfactionScore,
  SatisfactionScorer,
  ScenarioScoreDetail,
  ScenarioWeights,
} from './scorer.js'
// CLI subcommand (story 44-5)
export { registerScenariosCommand } from './cli-command.js'
