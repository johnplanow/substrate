/**
 * Unit tests for task-parser.ts (AC: #1, #2, #3)
 */

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { parseGraphFile, parseGraphString, ParseError } from '../task-parser.js'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')

describe('parseGraphString', () => {
  describe('YAML format', () => {
    it('parses valid YAML content', () => {
      const content = `
version: "1"
session:
  name: test
  budget_usd: 5.0
tasks:
  task-1:
    name: Task One
    prompt: Do it
    type: coding
    depends_on: []
`
      const result = parseGraphString(content, 'yaml')
      expect(result).toBeDefined()
      expect(result).toMatchObject({
        version: '1',
        session: { name: 'test' },
      })
    })

    it('throws ParseError on invalid YAML syntax', () => {
      const badYaml = 'key: [unclosed bracket'
      expect(() => parseGraphString(badYaml, 'yaml')).toThrow(ParseError)
    })

    it('thrown ParseError contains format field', () => {
      const badYaml = 'key: [unclosed'
      try {
        parseGraphString(badYaml, 'yaml')
      } catch (err) {
        expect(err).toBeInstanceOf(ParseError)
        if (err instanceof ParseError) {
          expect(err.format).toBe('yaml')
        }
      }
    })
  })

  describe('JSON format', () => {
    it('parses valid JSON content', () => {
      const content = JSON.stringify({
        version: '1',
        session: { name: 'json-test' },
        tasks: {},
      })
      const result = parseGraphString(content, 'json')
      expect(result).toMatchObject({ version: '1' })
    })

    it('throws ParseError on invalid JSON syntax', () => {
      const badJson = '{ "key": invalid }'
      expect(() => parseGraphString(badJson, 'json')).toThrow(ParseError)
    })

    it('thrown ParseError contains format field', () => {
      const badJson = '{ invalid }'
      try {
        parseGraphString(badJson, 'json')
      } catch (err) {
        expect(err).toBeInstanceOf(ParseError)
        if (err instanceof ParseError) {
          expect(err.format).toBe('json')
        }
      }
    })
  })
})

describe('parseGraphFile', () => {
  it('parses a valid YAML file', () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.yaml')
    const result = parseGraphFile(filePath)
    expect(result).toBeDefined()
    expect(result).toMatchObject({ version: '1' })
  })

  it('parses a valid JSON file', () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.json')
    const result = parseGraphFile(filePath)
    expect(result).toBeDefined()
    expect(result).toMatchObject({ version: '1' })
  })

  it('detects YAML format for .yaml extension', () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.yaml')
    // Just verifying it doesn't throw and produces an object
    const result = parseGraphFile(filePath)
    expect(typeof result).toBe('object')
  })

  it('detects JSON format for .json extension', () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.json')
    const result = parseGraphFile(filePath)
    expect(typeof result).toBe('object')
  })

  it('parses a valid .yml file (not just .yaml)', () => {
    const filePath = join(FIXTURES_DIR, 'valid-graph.yml')
    const result = parseGraphFile(filePath)
    expect(result).toBeDefined()
    expect(result).toMatchObject({ version: '1' })
    expect(typeof result).toBe('object')
  })

  it('throws ParseError when file does not exist', () => {
    const filePath = '/nonexistent/path/to/file.yaml'
    expect(() => parseGraphFile(filePath)).toThrow(ParseError)
  })

  it('thrown ParseError contains filePath when file not found', () => {
    const filePath = '/nonexistent/path/to/file.yaml'
    try {
      parseGraphFile(filePath)
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError)
      if (err instanceof ParseError) {
        expect(err.filePath).toBe(filePath)
      }
    }
  })
})
