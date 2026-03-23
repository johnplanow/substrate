/**
 * Scenarios subsystem barrel exports.
 */
export { ScenarioStore } from './store.js'
export type { ScenarioEntry, ScenarioManifest, ScenarioStoreVerifyResult } from './types.js'
// Runner (story 44-2 / 44-5)
export { createScenarioRunner } from './runner.js'
export type { ScenarioRunner, ScenarioRunnerOptions } from './runner.js'
// Scorer (story 44-5)
export { computeSatisfactionScore } from './scorer.js'
export type { SatisfactionScore } from './scorer.js'
// CLI subcommand (story 44-5)
export { registerScenariosCommand } from './cli-command.js'
