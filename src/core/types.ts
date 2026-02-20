/**
 * Core types for AI Dev Toolkit
 * Shared type definitions used across all modules
 */

/** Unique identifier for a task in the DAG */
export type TaskId = string

/** Unique identifier for a worker/agent instance */
export type WorkerId = string

/** Unique identifier for a registered agent type */
export type AgentId = string

/** Status of an individual task */
export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'

/** Status of an orchestration session */
export type SessionStatus =
  | 'initializing'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Billing mode for a worker/agent */
export type BillingMode = 'subscription' | 'api' | 'free'

/** Severity level for errors and log messages */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** Task priority level */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'

/** Agent capability descriptor */
export interface AgentCapability {
  name: string
  version: string
  supportedTaskTypes: string[]
  billingMode: BillingMode
  maxConcurrency: number
}

/** Task graph node definition */
export interface TaskNode {
  id: TaskId
  title: string
  description: string
  agentId?: AgentId
  status: TaskStatus
  priority: TaskPriority
  dependencies: TaskId[]
  metadata: Record<string, unknown>
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
}

/** Session configuration */
export interface SessionConfig {
  id: string
  name: string
  projectRoot: string
  taskGraphPath: string
  maxConcurrency: number
  budgetCap?: number
  billingMode: BillingMode
}

/** Cost tracking record */
export interface CostRecord {
  taskId: TaskId
  agentId: AgentId
  sessionId: string
  tokens: number
  estimatedCost: number
  billingMode: BillingMode
  timestamp: Date
}
