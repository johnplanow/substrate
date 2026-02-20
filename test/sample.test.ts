/**
 * Sample test demonstrating the toolkit's core utilities
 * This serves as the baseline passing test for the test infrastructure
 */

import { describe, it, expect, vi } from 'vitest'
import {
  AdtError,
  TaskConfigError,
  WorkerNotFoundError,
  BudgetExceededError,
  TaskGraphCycleError,
} from '@core/errors'
import {
  sleep,
  assertDefined,
  formatDuration,
  generateId,
  deepClone,
  isPlainObject,
  withRetry,
} from '@utils/helpers'

describe('Core Error Classes', () => {
  describe('AdtError', () => {
    it('should create an error with message and code', () => {
      const error = new AdtError('Test error', 'TEST_CODE')
      expect(error.message).toBe('Test error')
      expect(error.code).toBe('TEST_CODE')
      expect(error.name).toBe('AdtError')
    })

    it('should include context in the error', () => {
      const context = { taskId: 'task-123', reason: 'timeout' }
      const error = new AdtError('Timed out', 'TIMEOUT', context)
      expect(error.context).toEqual(context)
    })

    it('should serialize to JSON correctly', () => {
      const error = new AdtError('Test', 'CODE', { key: 'value' })
      const json = error.toJSON()
      expect(json).toMatchObject({
        name: 'AdtError',
        message: 'Test',
        code: 'CODE',
        context: { key: 'value' },
      })
    })

    it('should be instanceof Error', () => {
      const error = new AdtError('Test', 'CODE')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(AdtError)
    })
  })

  describe('TaskConfigError', () => {
    it('should create a task config error', () => {
      const error = new TaskConfigError('Invalid config', { field: 'priority' })
      expect(error.code).toBe('TASK_CONFIG_ERROR')
      expect(error.name).toBe('TaskConfigError')
      expect(error.context).toEqual({ field: 'priority' })
    })

    it('should be instanceof AdtError', () => {
      const error = new TaskConfigError('Test')
      expect(error).toBeInstanceOf(AdtError)
      expect(error).toBeInstanceOf(TaskConfigError)
    })
  })

  describe('WorkerNotFoundError', () => {
    it('should include agent ID in message', () => {
      const error = new WorkerNotFoundError('claude-code')
      expect(error.message).toContain('claude-code')
      expect(error.code).toBe('WORKER_NOT_FOUND')
      expect(error.context).toEqual({ agentId: 'claude-code' })
    })
  })

  describe('BudgetExceededError', () => {
    it('should include limit and current in context', () => {
      const error = new BudgetExceededError(100, 150)
      expect(error.code).toBe('BUDGET_EXCEEDED')
      expect(error.context).toMatchObject({ limit: 100, current: 150 })
    })
  })

  describe('TaskGraphCycleError', () => {
    it('should display cycle in message', () => {
      const cycle = ['task-a', 'task-b', 'task-c', 'task-a']
      const error = new TaskGraphCycleError(cycle)
      expect(error.message).toContain('task-a')
      expect(error.message).toContain('task-b')
      expect(error.context).toEqual({ cycle })
    })
  })
})

describe('Helper Utilities', () => {
  describe('sleep', () => {
    it('should resolve after the specified delay', async () => {
      const start = Date.now()
      await sleep(50)
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(45)
    })
  })

  describe('assertDefined', () => {
    it('should not throw for defined values', () => {
      expect(() => { assertDefined('hello', 'should not throw'); }).not.toThrow()
      expect(() => { assertDefined(0, 'should not throw'); }).not.toThrow()
      expect(() => { assertDefined(false, 'should not throw'); }).not.toThrow()
    })

    it('should throw for null', () => {
      expect(() => { assertDefined(null, 'value is null'); }).toThrow('value is null')
    })

    it('should throw for undefined', () => {
      expect(() => { assertDefined(undefined, 'value is undefined'); }).toThrow(
        'value is undefined'
      )
    })
  })

  describe('formatDuration', () => {
    it('should format milliseconds correctly', () => {
      expect(formatDuration(500)).toBe('500ms')
      expect(formatDuration(999)).toBe('999ms')
    })

    it('should format seconds correctly', () => {
      expect(formatDuration(1500)).toBe('1.5s')
      expect(formatDuration(30000)).toBe('30.0s')
    })

    it('should format minutes correctly', () => {
      expect(formatDuration(90000)).toBe('1m 30s')
      expect(formatDuration(120000)).toBe('2m 0s')
    })

    it('should format hours correctly', () => {
      expect(formatDuration(3661000)).toBe('1h 1m')
    })
  })

  describe('generateId', () => {
    it('should generate a non-empty ID', () => {
      const id = generateId()
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('should include prefix when provided', () => {
      const id = generateId('task')
      expect(id.startsWith('task-')).toBe(true)
    })

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()))
      expect(ids.size).toBe(100)
    })
  })

  describe('deepClone', () => {
    it('should create a deep copy of an object', () => {
      const original = { a: 1, b: { c: [1, 2, 3] } }
      const clone = deepClone(original)
      expect(clone).toEqual(original)
      expect(clone).not.toBe(original)
      expect(clone.b).not.toBe(original.b)
      expect(clone.b.c).not.toBe(original.b.c)
    })

    it('should deep clone arrays', () => {
      const arr = [1, 2, { x: 3 }]
      const clone = deepClone(arr)
      expect(clone).toEqual(arr)
      expect(clone).not.toBe(arr)
    })
  })

  describe('isPlainObject', () => {
    it('should return true for plain objects', () => {
      expect(isPlainObject({})).toBe(true)
      expect(isPlainObject({ a: 1 })).toBe(true)
    })

    it('should return false for non-plain-objects', () => {
      expect(isPlainObject([])).toBe(false)
      expect(isPlainObject(null)).toBe(false)
      expect(isPlainObject('string')).toBe(false)
      expect(isPlainObject(42)).toBe(false)
      expect(isPlainObject(new Date())).toBe(false)
    })
  })

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success')
      const result = await withRetry(fn, 3)
      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('should retry on failure and succeed', async () => {
      let attempts = 0
      const fn = vi.fn().mockImplementation(() => {
        attempts++
        if (attempts < 3) throw new Error('Temporary failure')
        return Promise.resolve('success')
      })
      const result = await withRetry(fn, 3, 10)
      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('should throw after max retries', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Persistent failure'))
      await expect(withRetry(fn, 2, 10)).rejects.toThrow('Persistent failure')
      expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
    })
  })
})
