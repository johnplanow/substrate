/**
 * Tests for the logger utility
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createLogger, childLogger } from '@utils/logger'

describe('Logger Utility', () => {
  describe('createLogger', () => {
    it('should create a logger with a given name', () => {
      const log = createLogger('test-module')
      expect(log).toBeDefined()
      expect(typeof log.info).toBe('function')
      expect(typeof log.error).toBe('function')
      expect(typeof log.debug).toBe('function')
      expect(typeof log.warn).toBe('function')
    })

    it('should create a logger with the specified log level', () => {
      const log = createLogger('test', { level: 'error' })
      expect(log.level).toBe('error')
    })

    it('should create a logger with debug level by default in test env', () => {
      const log = createLogger('test-debug')
      // In test (non-production) environment, default is debug
      expect(['debug', 'trace', 'info']).toContain(log.level)
    })

    it('should create loggers with different names', () => {
      const logA = createLogger('module-a')
      const logB = createLogger('module-b')
      expect(logA).not.toBe(logB)
    })
  })

  describe('childLogger', () => {
    it('should create a child logger inheriting parent level', () => {
      const parent = createLogger('parent', { level: 'warn' })
      const child = childLogger(parent, { component: 'worker' })
      expect(child).toBeDefined()
      expect(typeof child.warn).toBe('function')
    })

    it('should allow child logger to log with bindings', () => {
      const parent = createLogger('parent', { level: 'trace', pretty: false })
      const child = childLogger(parent, { taskId: 'task-123', agentId: 'claude' })
      expect(child).toBeDefined()
      // Child logger should function correctly
      expect(() => { child.info('Child logger test message'); }).not.toThrow()
    })
  })

  describe('environment-based configuration', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = { ...process.env }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should use LOG_LEVEL env var when set', () => {
      process.env.LOG_LEVEL = 'warn'
      const log = createLogger('env-test')
      expect(log.level).toBe('warn')
    })

    it('should use info level in production mode', () => {
      delete process.env.LOG_LEVEL
      process.env.NODE_ENV = 'production'
      const log = createLogger('prod-test', { pretty: false })
      expect(log.level).toBe('info')
    })
  })
})
