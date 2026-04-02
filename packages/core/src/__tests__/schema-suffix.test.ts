/**
 * Unit tests for schema-aware YAML suffix generation.
 *
 * Tests extractSchemaFields and buildYamlOutputSuffix which introspect Zod
 * schemas to produce field-specific YAML output format instructions for
 * non-Claude agent backends.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { extractSchemaFields, buildYamlOutputSuffix } from '../dispatch/dispatcher-impl.js'

describe('extractSchemaFields', () => {
  it('extracts field names from a simple Zod object', () => {
    const schema = z.object({
      result: z.string(),
      count: z.number(),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('result: <string>')
    expect(fields).toContain('count: <number>')
  })

  it('handles enum fields with values', () => {
    const schema = z.object({
      result: z.enum(['success', 'failed']),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('result: success | failed')
  })

  it('handles array fields', () => {
    const schema = z.object({
      files_modified: z.array(z.string()),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('files_modified: <list>')
  })

  it('handles optional fields', () => {
    const schema = z.object({
      notes: z.string().optional(),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('notes: <string>')
  })

  it('handles default fields', () => {
    const schema = z.object({
      ac_met: z.array(z.string()).default([]),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('ac_met: <list>')
  })

  it('handles preprocess/transform (ZodEffects) on object', () => {
    const schema = z.object({
      result: z.preprocess((val) => val, z.string()),
      verdict: z.enum(['SHIP_IT', 'NEEDS_MINOR_FIXES']),
    }).transform((data) => ({ ...data, extra: true }))
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('result: <string>')
    expect(fields).toContain('verdict: SHIP_IT | NEEDS_MINOR_FIXES')
  })

  it('handles boolean fields', () => {
    const schema = z.object({
      enabled: z.boolean(),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('enabled: <boolean>')
  })

  it('handles nested object fields', () => {
    const schema = z.object({
      metadata: z.object({ key: z.string() }),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toContain('metadata: <object>')
  })

  it('returns empty array for non-object schema', () => {
    expect(extractSchemaFields(z.string())).toEqual([])
    expect(extractSchemaFields(null)).toEqual([])
    expect(extractSchemaFields(undefined)).toEqual([])
  })

  it('works with DevStoryResultSchema-like schema', () => {
    const schema = z.object({
      result: z.enum(['success', 'failed']),
      ac_met: z.array(z.string()).default([]),
      ac_failures: z.array(z.string()).default([]),
      files_modified: z.array(z.string()).default([]),
      tests: z.enum(['pass', 'fail']),
      notes: z.string().optional(),
    })
    const fields = extractSchemaFields(schema)
    expect(fields).toHaveLength(6)
    expect(fields).toContain('result: success | failed')
    expect(fields).toContain('ac_met: <list>')
    expect(fields).toContain('tests: pass | fail')
    expect(fields).toContain('notes: <string>')
  })
})

describe('buildYamlOutputSuffix', () => {
  it('includes actual field names when schema is provided', () => {
    const schema = z.object({
      result: z.enum(['success', 'failed']),
      files_modified: z.array(z.string()),
    })
    const suffix = buildYamlOutputSuffix(schema)
    expect(suffix).toContain('result: success | failed')
    expect(suffix).toContain('files_modified: <list>')
    expect(suffix).toContain('```yaml')
    expect(suffix).toContain('IMPORTANT')
  })

  it('falls back to generic format when no schema provided', () => {
    const suffix = buildYamlOutputSuffix(undefined)
    expect(suffix).toContain('result: success')
    expect(suffix).toContain('additional fields')
  })

  it('falls back to generic format when schema is null', () => {
    const suffix = buildYamlOutputSuffix(null)
    expect(suffix).toContain('result: success')
  })

  it('includes YAML fence markers', () => {
    const suffix = buildYamlOutputSuffix(z.object({ result: z.string() }))
    expect(suffix).toContain('```yaml')
    expect(suffix).toContain('```')
  })

  it('instructs agent to emit YAML as last output', () => {
    const suffix = buildYamlOutputSuffix()
    expect(suffix).toContain('MUST be the last thing')
    expect(suffix).toContain('Do not add any text after')
  })
})
