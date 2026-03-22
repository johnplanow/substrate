/**
 * MonitorAgent interface — public contract for the monitor agent module.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

import type { IBaseService } from '../types.js'
import type { Recommendation } from './recommendation-types.js'

// ---------------------------------------------------------------------------
// TaskMetrics
// ---------------------------------------------------------------------------

export interface TaskMetrics {
  taskId: string
  agent: string
  taskType: string
  outcome: 'success' | 'failure'
  failureReason?: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  cost: number
  estimatedCost: number
  billingMode: string
  recordedAt: string
}

// ---------------------------------------------------------------------------
// MonitorAgent interface
// ---------------------------------------------------------------------------

export interface MonitorAgent extends IBaseService {
  recordTaskMetrics(
    taskId: string,
    agent: string,
    outcome: 'success' | 'failure',
    data: {
      failureReason?: string
      inputTokens?: number
      outputTokens?: number
      durationMs?: number
      cost?: number
      estimatedCost?: number
      billingMode?: string
      taskType?: string
    }
  ): void

  getRecommendation(taskType: string): Recommendation | null

  getRecommendations(): Recommendation[]

  setCustomTaxonomy(taxonomy: Record<string, string[]>): void
}
