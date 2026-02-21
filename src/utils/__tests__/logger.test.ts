/**
 * Unit tests for src/utils/logger.ts — Pino configuration and redaction.
 * AC: #3, #4
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import { PINO_REDACT_PATHS, maskSecrets } from '../../cli/utils/masking.js'
import { createLogger, childLogger } from '../logger.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a synchronous in-memory pino logger that writes JSON to a buffer.
 * Uses pino.destination({ sync: true }) pattern via the stream overload.
 */
function createCapturingLogger(name: string): { logger: pino.Logger; getLines: () => string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding: string, callback: () => void) {
      lines.push(chunk.toString().trim())
      callback()
    },
  })

  const logger = pino(
    {
      name,
      level: 'trace',
      redact: PINO_REDACT_PATHS,
      formatters: {
        level(label) {
          return { level: label }
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: { pid: process.pid },
    },
    stream,
  )

  return { logger, getLines: () => lines }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  it('returns a pino logger instance', () => {
    const logger = createLogger('test-module', { pretty: false })
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
  })

  it('uses LOG_LEVEL environment variable to override default log level', () => {
    const original = process.env.LOG_LEVEL
    try {
      process.env.LOG_LEVEL = 'warn'
      const logger = createLogger('test-level', { pretty: false })
      expect(logger.level).toBe('warn')
    } finally {
      if (original === undefined) {
        delete process.env.LOG_LEVEL
      } else {
        process.env.LOG_LEVEL = original
      }
    }
  })

  it('uses info level when NODE_ENV = production', () => {
    const originalEnv = process.env.NODE_ENV
    const originalLevel = process.env.LOG_LEVEL
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.LOG_LEVEL
      const logger = createLogger('test-prod', { pretty: false })
      expect(logger.level).toBe('info')
    } finally {
      process.env.NODE_ENV = originalEnv
      if (originalLevel === undefined) {
        delete process.env.LOG_LEVEL
      } else {
        process.env.LOG_LEVEL = originalLevel
      }
    }
  })
})

describe('childLogger', () => {
  it('returns a child logger with sessionId binding', () => {
    const parent = createLogger('parent-module', { pretty: false })
    const child = childLogger(parent, { sessionId: 'abc-123' })
    expect(child).toBeDefined()
    expect(typeof child.info).toBe('function')
    // Child logger should be a different object from parent
    expect(child).not.toBe(parent)
  })
})

describe('Pino redaction — PINO_REDACT_PATHS', () => {
  it('contains all required redaction paths', () => {
    expect(PINO_REDACT_PATHS).toContain('apiKey')
    expect(PINO_REDACT_PATHS).toContain('api_key')
    expect(PINO_REDACT_PATHS).toContain('*.apiKey')
    expect(PINO_REDACT_PATHS).toContain('*.api_key')
    expect(PINO_REDACT_PATHS).toContain('providers.*.api_key_env')
    expect(PINO_REDACT_PATHS).toContain('env.ANTHROPIC_API_KEY')
    expect(PINO_REDACT_PATHS).toContain('env.OPENAI_API_KEY')
    expect(PINO_REDACT_PATHS).toContain('env.GOOGLE_API_KEY')
  })

  it('redacts apiKey field in log output', () => {
    const { logger, getLines } = createCapturingLogger('redact-test')

    logger.info({ apiKey: 'sk-ant-secret12345678901234567890' }, 'test redaction')

    const lines = getLines()
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as { apiKey?: string }
    expect(parsed.apiKey).toBe('[Redacted]')
  })

  it('does not log the actual api key value', () => {
    const { logger, getLines } = createCapturingLogger('redact-test-2')
    const secretKey = 'sk-ant-api-secret-value-1234567890'

    logger.info({ api_key: secretKey }, 'should be redacted')

    const lines = getLines()
    const rawOutput = lines.join('')
    expect(rawOutput).not.toContain(secretKey)
  })
})

describe('maskSecrets', () => {
  it('masks Anthropic API key pattern', () => {
    const input = 'sk-ant-abcdefghijklmnopqrstuvwxyz'
    const result = maskSecrets(input)
    expect(result).toBe('***')
  })

  it('returns input unchanged when no secrets present', () => {
    const input = 'no secrets here'
    const result = maskSecrets(input)
    expect(result).toBe(input)
  })

  it('masks OpenAI key pattern', () => {
    const input = 'sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234'
    const result = maskSecrets(input)
    expect(result).toBe('***')
  })

  it('masks secrets within a longer string', () => {
    const input = 'Error: invalid key sk-ant-secretaaaaaaaaaaaaaaaaaaaaa for provider'
    const result = maskSecrets(input)
    expect(result).not.toContain('sk-ant-secret')
    expect(result).toContain('***')
  })
})
