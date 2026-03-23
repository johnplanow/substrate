/**
 * Unit tests for the twin template catalog.
 *
 * Story 47-4 — Task 6.
 */

import { describe, it, expect } from 'vitest'
import { TWIN_TEMPLATES, getTwinTemplate, listTwinTemplates } from '../templates.js'
import type { TwinTemplateEntry } from '../templates.js'
import { TwinDefinitionSchema } from '../schema.js'

describe('TWIN_TEMPLATES catalog', () => {
  it('contains at least 2 entries', () => {
    expect(TWIN_TEMPLATES.size).toBeGreaterThanOrEqual(2)
  })

  it('has a localstack entry', () => {
    expect(TWIN_TEMPLATES.has('localstack')).toBe(true)
  })

  it('has a wiremock entry', () => {
    expect(TWIN_TEMPLATES.has('wiremock')).toBe(true)
  })
})

describe('getTwinTemplate — LocalStack fields', () => {
  it('returns the localstack entry with correct image', () => {
    const entry = getTwinTemplate('localstack')
    expect(entry).toBeDefined()
    expect(entry!.definition.image).toBe('localstack/localstack:latest')
  })

  it('includes port 4566:4566', () => {
    const entry = getTwinTemplate('localstack')!
    expect(entry.definition.ports).toContain('4566:4566')
  })

  it('has healthcheck URL http://localhost:4566/_localstack/health', () => {
    const entry = getTwinTemplate('localstack')!
    expect(entry.definition.healthcheck?.url).toBe('http://localhost:4566/_localstack/health')
  })
})

describe('getTwinTemplate — WireMock fields', () => {
  it('returns the wiremock entry with correct image', () => {
    const entry = getTwinTemplate('wiremock')
    expect(entry).toBeDefined()
    expect(entry!.definition.image).toBe('wiremock/wiremock:latest')
  })

  it('includes port 8080:8080', () => {
    const entry = getTwinTemplate('wiremock')!
    expect(entry.definition.ports).toContain('8080:8080')
  })

  it('has healthcheck URL http://localhost:8080/__admin/health', () => {
    const entry = getTwinTemplate('wiremock')!
    expect(entry.definition.healthcheck?.url).toBe('http://localhost:8080/__admin/health')
  })
})

describe('TwinDefinitionSchema validation', () => {
  it('parses LocalStack definition without throwing', () => {
    const entry = getTwinTemplate('localstack')!
    expect(() => TwinDefinitionSchema.parse(entry.definition)).not.toThrow()
  })

  it('parses WireMock definition without throwing', () => {
    const entry = getTwinTemplate('wiremock')!
    expect(() => TwinDefinitionSchema.parse(entry.definition)).not.toThrow()
  })
})

describe('getTwinTemplate — unknown name', () => {
  it('returns undefined for a non-existent template', () => {
    expect(getTwinTemplate('nonexistent')).toBeUndefined()
  })
})

describe('listTwinTemplates', () => {
  it('returns all entries in the catalog', () => {
    const list = listTwinTemplates()
    expect(list.length).toBe(TWIN_TEMPLATES.size)
  })

  it('each entry has a non-empty name and description', () => {
    const list = listTwinTemplates()
    for (const entry of list) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
    }
  })

  it('returned entries have TwinTemplateEntry shape', () => {
    const list = listTwinTemplates()
    for (const entry of list) {
      const e = entry as TwinTemplateEntry
      expect(typeof e.name).toBe('string')
      expect(typeof e.description).toBe('string')
      expect(e.definition).toBeDefined()
    }
  })
})
