/**
 * Unit tests for task-baselines (Story 35-2).
 */

import { describe, it, expect } from 'vitest'

import { getBaseline, TASK_BASELINES, DEFAULT_BASELINE } from '../task-baselines.js'

describe('task-baselines', () => {
  describe('getBaseline()', () => {
    it('should return task-specific baseline for known types', () => {
      const devStory = getBaseline('dev-story')
      expect(devStory.expectedOutputPerTurn).toBe(550)
      expect(devStory.targetIoRatio).toBe(100)

      const codeReview = getBaseline('code-review')
      expect(codeReview.expectedOutputPerTurn).toBe(3900)
      expect(codeReview.targetIoRatio).toBe(50)
    })

    it('should return DEFAULT_BASELINE for undefined taskType', () => {
      const baseline = getBaseline(undefined)
      expect(baseline).toBe(DEFAULT_BASELINE)
      expect(baseline.expectedOutputPerTurn).toBe(800)
      expect(baseline.targetIoRatio).toBe(100)
    })

    it('should return DEFAULT_BASELINE for empty string taskType', () => {
      expect(getBaseline('')).toBe(DEFAULT_BASELINE)
    })

    it('should return DEFAULT_BASELINE for unknown taskType', () => {
      expect(getBaseline('unknown-task')).toBe(DEFAULT_BASELINE)
    })

    it('should have baselines for all expected task types', () => {
      const expectedTypes = [
        'dev-story', 'create-story', 'code-review',
        'minor-fixes', 'test-plan', 'test-expansion',
      ]
      for (const taskType of expectedTypes) {
        expect(TASK_BASELINES[taskType]).toBeDefined()
        expect(TASK_BASELINES[taskType]!.expectedOutputPerTurn).toBeGreaterThan(0)
        expect(TASK_BASELINES[taskType]!.targetIoRatio).toBeGreaterThan(0)
      }
    })
  })
})
