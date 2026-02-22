/**
 * Unit tests for version-utils.ts (AC: #6)
 */

import { describe, it, expect } from 'vitest'
import {
  parseVersion,
  isVersionSupported,
  getNextVersion,
  formatUnsupportedVersionError,
} from '../version-utils.js'
import { ConfigError } from '../../../core/errors.js'

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('parses "1" to 1', () => {
    expect(parseVersion('1')).toBe(1)
  })

  it('parses "2" to 2', () => {
    expect(parseVersion('2')).toBe(2)
  })

  it('parses "10" to 10', () => {
    expect(parseVersion('10')).toBe(10)
  })

  it('throws ConfigError for "abc"', () => {
    expect(() => parseVersion('abc')).toThrow(ConfigError)
  })

  it('throws ConfigError for empty string ""', () => {
    expect(() => parseVersion('')).toThrow(ConfigError)
  })

  it('throws ConfigError for "-1"', () => {
    expect(() => parseVersion('-1')).toThrow(ConfigError)
  })

  it('throws ConfigError for "1.2.3"', () => {
    expect(() => parseVersion('1.2.3')).toThrow(ConfigError)
  })

  it('throws ConfigError for "0"', () => {
    expect(() => parseVersion('0')).toThrow(ConfigError)
  })

  it('throws ConfigError for "1.2"', () => {
    expect(() => parseVersion('1.2')).toThrow(ConfigError)
  })

  it('throws ConfigError for "1a"', () => {
    expect(() => parseVersion('1a')).toThrow(ConfigError)
  })
})

// ---------------------------------------------------------------------------
// isVersionSupported
// ---------------------------------------------------------------------------

describe('isVersionSupported', () => {
  const supported = ['1', '2', '5'] as const

  it('returns true for "1" (in list)', () => {
    expect(isVersionSupported('1', supported)).toBe(true)
  })

  it('returns true for "2" (in list)', () => {
    expect(isVersionSupported('2', supported)).toBe(true)
  })

  it('returns true for "5" (in list)', () => {
    expect(isVersionSupported('5', supported)).toBe(true)
  })

  it('returns false for "3" (not in list)', () => {
    expect(isVersionSupported('3', supported)).toBe(false)
  })

  it('returns false for "99" (not in list)', () => {
    expect(isVersionSupported('99', supported)).toBe(false)
  })

  it('returns false for "" (empty string)', () => {
    expect(isVersionSupported('', supported)).toBe(false)
  })

  it('returns false when supported list is empty', () => {
    expect(isVersionSupported('1', [])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getNextVersion
// ---------------------------------------------------------------------------

describe('getNextVersion', () => {
  it('"1" -> "2"', () => {
    expect(getNextVersion('1')).toBe('2')
  })

  it('"2" -> "3"', () => {
    expect(getNextVersion('2')).toBe('3')
  })

  it('"10" -> "11"', () => {
    expect(getNextVersion('10')).toBe('11')
  })

  it('"99" -> "100"', () => {
    expect(getNextVersion('99')).toBe('100')
  })
})

// ---------------------------------------------------------------------------
// formatUnsupportedVersionError
// ---------------------------------------------------------------------------

describe('formatUnsupportedVersionError', () => {
  it('returns config error message for formatType "config"', () => {
    const msg = formatUnsupportedVersionError('config', '99', ['1'])
    expect(msg).toBe(
      'Configuration format version "99" is not supported. ' +
        'This toolkit supports: 1. ' +
        'Please upgrade the toolkit: npm install -g substrate@latest'
    )
  })

  it('returns task_graph error message for formatType "task_graph"', () => {
    const msg = formatUnsupportedVersionError('task_graph', '99', ['1'])
    expect(msg).toBe(
      'Task graph format version "99" is not supported. ' +
        'This toolkit supports: 1. ' +
        'Please upgrade the toolkit: npm install -g substrate@latest'
    )
  })

  it('includes multiple supported versions in the message', () => {
    const msg = formatUnsupportedVersionError('config', '99', ['1', '2'])
    expect(msg).toContain('1, 2')
  })

  it('config message starts with "Configuration format version"', () => {
    const msg = formatUnsupportedVersionError('config', '5', ['1'])
    expect(msg).toMatch(/^Configuration format version/)
  })

  it('task_graph message starts with "Task graph format version"', () => {
    const msg = formatUnsupportedVersionError('task_graph', '5', ['1'])
    expect(msg).toMatch(/^Task graph format version/)
  })
})
