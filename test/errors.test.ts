/**
 * Additional error class tests for coverage
 */

import { describe, it, expect } from 'vitest'
import {
  AdtError,
  TaskConfigError,
  WorkerError,
  TaskGraphError,
  BudgetExceededError,
  GitError,
  ConfigError,
  RecoveryError,
} from '@core/errors'

describe('Extended Error Coverage', () => {
  describe('WorkerError', () => {
    it('should create worker error', () => {
      const error = new WorkerError('Worker crashed', { pid: 1234 })
      expect(error.code).toBe('WORKER_ERROR')
      expect(error.name).toBe('WorkerError')
      expect(error.context.pid).toBe(1234)
      expect(error).toBeInstanceOf(AdtError)
    })
  })

  describe('TaskGraphError', () => {
    it('should create task graph error', () => {
      const error = new TaskGraphError('Invalid dependency', { taskId: 'task-1' })
      expect(error.code).toBe('TASK_GRAPH_ERROR')
      expect(error.name).toBe('TaskGraphError')
      expect(error).toBeInstanceOf(AdtError)
    })
  })

  describe('GitError', () => {
    it('should create git error', () => {
      const error = new GitError('Merge conflict detected', { branch: 'task/task-123' })
      expect(error.code).toBe('GIT_ERROR')
      expect(error.name).toBe('GitError')
      expect(error.context.branch).toBe('task/task-123')
      expect(error).toBeInstanceOf(AdtError)
    })
  })

  describe('ConfigError', () => {
    it('should create config error', () => {
      const error = new ConfigError('Missing required field', { field: 'projectRoot' })
      expect(error.code).toBe('CONFIG_ERROR')
      expect(error.name).toBe('ConfigError')
      expect(error).toBeInstanceOf(AdtError)
    })
  })

  describe('RecoveryError', () => {
    it('should create recovery error', () => {
      const error = new RecoveryError('State file corrupted', { path: '/tmp/state.json' })
      expect(error.code).toBe('RECOVERY_ERROR')
      expect(error.name).toBe('RecoveryError')
      expect(error).toBeInstanceOf(AdtError)
    })
  })

  describe('BudgetExceededError with extra context', () => {
    it('should include extra context', () => {
      const error = new BudgetExceededError(50.0, 75.5, { sessionId: 'sess-123' })
      expect(error.context.sessionId).toBe('sess-123')
      expect(error.context.limit).toBe(50.0)
      expect(error.context.current).toBe(75.5)
    })
  })

  describe('Error stack traces', () => {
    it('should have a stack trace', () => {
      const error = new AdtError('Stack test', 'STACK_TEST')
      expect(error.stack).toBeDefined()
      expect(error.stack).toContain('AdtError')
    })

    it('should serialize all error types to JSON', () => {
      const errors = [
        new TaskConfigError('Config error'),
        new WorkerError('Worker error'),
        new TaskGraphError('Graph error'),
        new GitError('Git error'),
        new ConfigError('Config err'),
        new RecoveryError('Recovery err'),
      ]

      for (const error of errors) {
        const json = error.toJSON()
        expect(json.name).toBeTruthy()
        expect(json.message).toBeTruthy()
        expect(json.code).toBeTruthy()
        expect(json.context).toBeDefined()
      }
    })
  })
})
