/**
 * Recommendation Types — data structures for the routing recommendations engine.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

export type ConfidenceLevel = 'low' | 'medium' | 'high'

export interface Recommendation {
  task_type: string
  current_agent: string
  recommended_agent: string
  reason: string
  confidence: ConfidenceLevel
  current_success_rate: number
  recommended_success_rate: number
  current_avg_tokens: number
  recommended_avg_tokens: number
  improvement_percentage: number
  sample_size_current: number
  sample_size_recommended: number
}

export interface RecommendationFilters {
  threshold_percentage: number
  min_sample_size: number
}

export interface RecommendationExport {
  generated_at: string
  count: number
  recommendations: Recommendation[]
}

export function createRecommendation(data: unknown): Recommendation {
  if (data === null || typeof data !== 'object') {
    throw new Error('createRecommendation: data must be an object')
  }

  const d = data as Record<string, unknown>

  const requiredString = (field: string): string => {
    const val = d[field]
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(`createRecommendation: missing or invalid field "${field}"`)
    }
    return val
  }

  const requiredNumber = (field: string): number => {
    const val = d[field]
    if (typeof val !== 'number' || !isFinite(val)) {
      throw new Error(`createRecommendation: missing or invalid field "${field}"`)
    }
    return val
  }

  const confidence = d['confidence']
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    throw new Error(
      `createRecommendation: confidence must be "low", "medium", or "high", got "${String(confidence)}"`
    )
  }

  return {
    task_type: requiredString('task_type'),
    current_agent: requiredString('current_agent'),
    recommended_agent: requiredString('recommended_agent'),
    reason: requiredString('reason'),
    confidence: confidence as ConfidenceLevel,
    current_success_rate: requiredNumber('current_success_rate'),
    recommended_success_rate: requiredNumber('recommended_success_rate'),
    current_avg_tokens: requiredNumber('current_avg_tokens'),
    recommended_avg_tokens: requiredNumber('recommended_avg_tokens'),
    improvement_percentage: requiredNumber('improvement_percentage'),
    sample_size_current: requiredNumber('sample_size_current'),
    sample_size_recommended: requiredNumber('sample_size_recommended'),
  }
}
