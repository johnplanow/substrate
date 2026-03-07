/**
 * Tests for Story 25-7: Test-Plan Prompt Template registration and content.
 *
 * Verifies:
 *  - AC1: pack loader returns a prompt for 'test-plan' task type
 *  - AC3: prompt template contains expected placeholders injected by dev-story
 *  - AC4: no warning about missing test-plan prompt (prompt exists in manifest)
 *
 * Uses the real BMAD pack at packs/bmad/ to validate registration end-to-end.
 */

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { createPackLoader } from '../../methodology-pack/pack-loader.js'
import { TestPlanResultSchema } from '../schemas.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BMAD_PACK_PATH = resolve(process.cwd(), 'packs/bmad')

// ---------------------------------------------------------------------------
// AC1: Pack loader returns a prompt for 'test-plan' task type
// ---------------------------------------------------------------------------

describe('AC1: test-plan prompt registered in bmad pack manifest', () => {
  it('loads the bmad pack without error', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)

    expect(pack.manifest.name).toBe('bmad')
  })

  it('manifest.prompts contains a test-plan entry', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)

    expect(pack.manifest.prompts).toHaveProperty('test-plan')
    expect(pack.manifest.prompts['test-plan']).toBe('prompts/test-plan.md')
  })

  it('getPrompt("test-plan") resolves without throwing', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)

    await expect(pack.getPrompt('test-plan')).resolves.toBeDefined()
  })

  it('getPrompt("test-plan") returns a non-empty string', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(50)
  })
})

// ---------------------------------------------------------------------------
// AC2 / AC3: Prompt template contains expected placeholders and output contract
// ---------------------------------------------------------------------------

describe('AC3: test-plan prompt template contains expected placeholders', () => {
  it('contains {{story_content}} placeholder', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    expect(prompt).toContain('{{story_content}}')
  })

  it('contains output contract YAML field: result', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    expect(prompt).toContain('result:')
  })

  it('contains output contract YAML field: test_files', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    expect(prompt).toContain('test_files:')
  })

  it('contains output contract YAML field: test_categories', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    expect(prompt).toContain('test_categories:')
  })

  it('contains output contract YAML field: coverage_notes', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    expect(prompt).toContain('coverage_notes:')
  })
})

// ---------------------------------------------------------------------------
// TestPlanResultSchema field name alignment
// ---------------------------------------------------------------------------

describe('TestPlanResultSchema output contract field alignment', () => {
  it('TestPlanResultSchema has a result field', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: [],
      test_categories: [],
      coverage_notes: '',
    })

    expect(parsed).toHaveProperty('result')
  })

  it('TestPlanResultSchema has a test_files field', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: ['src/foo/__tests__/foo.test.ts'],
      test_categories: [],
      coverage_notes: '',
    })

    expect(parsed).toHaveProperty('test_files')
    expect(parsed.test_files).toEqual(['src/foo/__tests__/foo.test.ts'])
  })

  it('TestPlanResultSchema has a test_categories field', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: [],
      test_categories: ['unit', 'integration'],
      coverage_notes: '',
    })

    expect(parsed).toHaveProperty('test_categories')
    expect(parsed.test_categories).toEqual(['unit', 'integration'])
  })

  it('TestPlanResultSchema has a coverage_notes field', () => {
    const parsed = TestPlanResultSchema.parse({
      result: 'success',
      test_files: [],
      test_categories: [],
      coverage_notes: 'AC1 covered by foo.test.ts',
    })

    expect(parsed).toHaveProperty('coverage_notes')
    expect(parsed.coverage_notes).toBe('AC1 covered by foo.test.ts')
  })

  it('prompt output contract field names match TestPlanResultSchema exactly', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)
    const prompt = await pack.getPrompt('test-plan')

    // All schema field names should appear in the prompt output contract section
    const schemaFields = ['result', 'test_files', 'test_categories', 'coverage_notes']
    for (const field of schemaFields) {
      expect(prompt).toContain(`${field}:`)
    }
  })
})

// ---------------------------------------------------------------------------
// AC4: No warning path — prompt is discoverable (functional verification)
// ---------------------------------------------------------------------------

describe('AC4: test-plan prompt is discoverable (no warning scenario)', () => {
  it('getPrompt("test-plan") does not throw "no prompt for task type" error', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(BMAD_PACK_PATH)

    // If the manifest were missing the test-plan entry, this would throw
    // "no prompt for task type 'test-plan'"
    await expect(pack.getPrompt('test-plan')).resolves.not.toThrow()
  })

  it('pack loader validates that test-plan prompt file actually exists on disk', async () => {
    // If packs/bmad/prompts/test-plan.md were missing, pack.load() would
    // throw a "missing files" error during validation. This test confirms
    // the file is present and the loader passes validation.
    const loader = createPackLoader()
    await expect(loader.load(BMAD_PACK_PATH)).resolves.toBeDefined()
  })
})
