/**
 * Monitor module barrel export.
 *
 * Re-exports all public interfaces, classes, and factory functions
 * from the monitor agent module.
 */

export type { MonitorAgent, TaskMetrics } from './monitor-agent.js'
export { MonitorAgentImpl, createMonitorAgent } from './monitor-agent-impl.js'
export type { MonitorConfig, MonitorAgentOptions } from './monitor-agent-impl.js'
export { TaskTypeClassifier, createTaskTypeClassifier, DEFAULT_TAXONOMY } from './task-type-classifier.js'
