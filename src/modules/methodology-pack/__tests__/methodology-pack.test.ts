/**
 * Unit tests for the methodology-pack module.
 *
 * Tests:
 *  - Manifest schema validation (valid and invalid)
 *  - PackLoader.load(): loads BMAD pack, rejects bad manifests
 *  - PackLoader.discover(): finds packs in packs/ directory
 *  - MethodologyPack.getPhases(): returns ordered phase list
 *  - MethodologyPack.getPrompt(): lazy load, cache, interpolation
 *  - MethodologyPack.getConstraints(): returns structured objects
 *  - MethodologyPack.getTemplate(): lazy load and cache
 *  - Missing packs directory: returns empty list
 *  - BMAD pack: prompts exist and are within token budget targets
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createPackLoader } from '../pack-loader.js'
import { MethodologyPackImpl } from '../methodology-pack-impl.js'
import type { PackManifest } from '../types.js'

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

let testDir: string

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `methodology-pack-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  )
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// Helper: create a minimal valid pack in a temp directory
async function createTestPack(
  packDir: string,
  options: {
    manifestExtra?: Partial<PackManifest>
    writePrompts?: boolean
    writeConstraints?: boolean
    writeTemplates?: boolean
    customManifestYaml?: string
  } = {}
): Promise<void> {
  await mkdir(join(packDir, 'prompts'), { recursive: true })
  await mkdir(join(packDir, 'constraints'), { recursive: true })
  await mkdir(join(packDir, 'templates'), { recursive: true })

  const {
    writePrompts = true,
    writeConstraints = true,
    writeTemplates = true,
    customManifestYaml,
  } = options

  if (writePrompts) {
    await writeFile(join(packDir, 'prompts', 'create-story.md'), '# Create Story\nDo things {{phase}} with {{methodology}}', 'utf-8')
    await writeFile(join(packDir, 'prompts', 'dev-story.md'), '# Dev Story\nImplement all tasks', 'utf-8')
  }

  if (writeConstraints) {
    await writeFile(
      join(packDir, 'constraints', 'create-story.yaml'),
      `- name: story-has-user-story\n  description: Story must have user story\n  severity: required\n  check: Story section exists`,
      'utf-8'
    )
    await writeFile(
      join(packDir, 'constraints', 'dev-story.yaml'),
      `- name: sequential-execution\n  description: Execute tasks in order\n  severity: required\n  check: Tasks executed in order`,
      'utf-8'
    )
  }

  if (writeTemplates) {
    await writeFile(join(packDir, 'templates', 'story.md'), '# Story Template\n{{epic_num}}.{{story_num}}', 'utf-8')
  }

  if (customManifestYaml) {
    await writeFile(join(packDir, 'manifest.yaml'), customManifestYaml, 'utf-8')
    return
  }

  const manifest: PackManifest = {
    name: 'test-pack',
    version: '1.0.0',
    description: 'Test methodology pack',
    phases: [
      {
        name: 'planning',
        description: 'Planning phase',
        entryGates: [],
        exitGates: ['planning-complete'],
        artifacts: ['plan'],
      },
      {
        name: 'implementation',
        description: 'Implementation phase',
        entryGates: ['planning-complete'],
        exitGates: ['done'],
        artifacts: ['code', 'tests'],
      },
    ],
    prompts: {
      'create-story': 'prompts/create-story.md',
      'dev-story': 'prompts/dev-story.md',
    },
    constraints: {
      'create-story': 'constraints/create-story.yaml',
      'dev-story': 'constraints/dev-story.yaml',
    },
    templates: {
      story: 'templates/story.md',
    },
    ...options.manifestExtra,
  }

  // Convert to YAML manually (simple enough structure)
  const yamlContent = buildManifestYaml(manifest)
  await writeFile(join(packDir, 'manifest.yaml'), yamlContent, 'utf-8')
}

function buildManifestYaml(manifest: PackManifest): string {
  const phases = manifest.phases
    .map((p) => {
      const entryGates = p.entryGates.length
        ? `[${p.entryGates.join(', ')}]`
        : '[]'
      const exitGates = p.exitGates.length
        ? `[${p.exitGates.join(', ')}]`
        : '[]'
      const artifacts = p.artifacts.length
        ? `[${p.artifacts.join(', ')}]`
        : '[]'
      return `  - name: ${p.name}\n    description: ${p.description}\n    entryGates: ${entryGates}\n    exitGates: ${exitGates}\n    artifacts: ${artifacts}`
    })
    .join('\n')

  const prompts = Object.entries(manifest.prompts)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')

  const constraints = Object.entries(manifest.constraints)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')

  const templates = Object.entries(manifest.templates)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')

  return `name: ${manifest.name}\nversion: ${manifest.version}\ndescription: ${manifest.description}\nphases:\n${phases}\nprompts:\n${prompts}\nconstraints:\n${constraints}\ntemplates:\n${templates}\n`
}

// ---------------------------------------------------------------------------
// PackLoader — load()
// ---------------------------------------------------------------------------

describe('PackLoader.load()', () => {
  it('loads a valid pack and returns a MethodologyPack', async () => {
    const packDir = join(testDir, 'my-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    expect(pack).toBeDefined()
    expect(pack.manifest.name).toBe('test-pack')
    expect(pack.manifest.version).toBe('1.0.0')
  })

  it('throws a clear error when manifest.yaml is missing', async () => {
    const packDir = join(testDir, 'empty-pack')
    await mkdir(packDir, { recursive: true })

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/manifest.yaml/)
  })

  it('throws a clear error when manifest.yaml has invalid YAML', async () => {
    const packDir = join(testDir, 'bad-yaml-pack')
    await mkdir(packDir, { recursive: true })
    await writeFile(join(packDir, 'manifest.yaml'), '{ invalid yaml: [unclosed', 'utf-8')

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/invalid YAML/)
  })

  it('throws a validation error with details when manifest fields are missing', async () => {
    const packDir = join(testDir, 'invalid-manifest-pack')
    await mkdir(packDir, { recursive: true })
    await writeFile(
      join(packDir, 'manifest.yaml'),
      'name: test\nversion: 1.0.0\n# missing required fields',
      'utf-8'
    )

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/validation/)
  })

  it('throws when referenced prompt files are missing', async () => {
    const packDir = join(testDir, 'missing-prompts-pack')
    await mkdir(packDir, { recursive: true })
    // Write manifest but NOT prompt files
    await createTestPack(packDir, { writePrompts: false, writeConstraints: true, writeTemplates: true })

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/missing files/)
  })

  it('throws when referenced constraint files are missing', async () => {
    const packDir = join(testDir, 'missing-constraints-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir, { writePrompts: true, writeConstraints: false, writeTemplates: true })

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/missing files/)
  })
})

// ---------------------------------------------------------------------------
// PackLoader — discover()
// ---------------------------------------------------------------------------

describe('PackLoader.discover()', () => {
  it('returns empty list when no packs/ directory exists', async () => {
    const projectRoot = join(testDir, 'project-no-packs')
    await mkdir(projectRoot, { recursive: true })

    const loader = createPackLoader()
    const packs = await loader.discover(projectRoot)

    expect(packs).toEqual([])
  })

  it('discovers packs in packs/ directory', async () => {
    const projectRoot = join(testDir, 'project-with-packs')
    const packA = join(projectRoot, 'packs', 'alpha')
    const packB = join(projectRoot, 'packs', 'beta')
    await mkdir(packA, { recursive: true })
    await mkdir(packB, { recursive: true })
    await createTestPack(packA)
    await createTestPack(packB, {
      manifestExtra: { name: 'beta', description: 'Beta pack' },
    })

    const loader = createPackLoader()
    const packs = await loader.discover(projectRoot)

    expect(packs).toHaveLength(2)
    const names = packs.map((p) => p.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
  })

  it('ignores subdirectories without manifest.yaml', async () => {
    const projectRoot = join(testDir, 'project-partial')
    const packA = join(projectRoot, 'packs', 'valid-pack')
    const notAPack = join(projectRoot, 'packs', 'not-a-pack')
    await mkdir(packA, { recursive: true })
    await mkdir(notAPack, { recursive: true })
    await createTestPack(packA)
    // notAPack has no manifest.yaml

    const loader = createPackLoader()
    const packs = await loader.discover(projectRoot)

    expect(packs).toHaveLength(1)
    expect(packs[0]?.name).toBe('valid-pack')
  })

  it('ignores files in packs/ directory (only subdirectories)', async () => {
    const projectRoot = join(testDir, 'project-files')
    const packsDir = join(projectRoot, 'packs')
    await mkdir(packsDir, { recursive: true })
    await writeFile(join(packsDir, 'some-file.txt'), 'hello', 'utf-8')

    const loader = createPackLoader()
    const packs = await loader.discover(projectRoot)

    expect(packs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// MethodologyPack.getPhases()
// ---------------------------------------------------------------------------

describe('MethodologyPack.getPhases()', () => {
  it('returns ordered phase list from manifest', async () => {
    const packDir = join(testDir, 'phases-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const phases = pack.getPhases()

    expect(phases).toHaveLength(2)
    expect(phases[0]?.name).toBe('planning')
    expect(phases[1]?.name).toBe('implementation')
  })

  it('returns phases with correct structure', async () => {
    const packDir = join(testDir, 'phase-structure-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const phases = pack.getPhases()
    const impl = phases[1]!

    expect(impl.name).toBe('implementation')
    expect(impl.description).toBe('Implementation phase')
    expect(impl.entryGates).toEqual(['planning-complete'])
    expect(impl.exitGates).toEqual(['done'])
    expect(impl.artifacts).toEqual(['code', 'tests'])
  })
})

// ---------------------------------------------------------------------------
// MethodologyPack.getPrompt() — lazy loading, caching, interpolation
// ---------------------------------------------------------------------------

describe('MethodologyPack.getPrompt()', () => {
  it('returns prompt content for a valid task type', async () => {
    const packDir = join(testDir, 'prompt-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const prompt = await pack.getPrompt('create-story')

    expect(prompt).toContain('Create Story')
  })

  it('performs variable interpolation on prompt content', async () => {
    const packDir = join(testDir, 'interp-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const prompt = await pack.getPrompt('create-story')

    // {{methodology}} should be replaced with pack name
    expect(prompt).toContain('test-pack')
    // {{phase}} should be replaced with taskType
    expect(prompt).toContain('create-story')
    // Original {{...}} syntax should be gone
    expect(prompt).not.toContain('{{methodology}}')
    expect(prompt).not.toContain('{{phase}}')
  })

  it('caches prompt after first access (returns same string reference)', async () => {
    const packDir = join(testDir, 'cache-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    // First access
    const first = await pack.getPrompt('dev-story')

    // Second access — should return exact same reference from cache
    const second = await pack.getPrompt('dev-story')

    expect(first).toBe(second) // same string reference (from cache)
  })

  it('throws a clear error for unknown task type', async () => {
    const packDir = join(testDir, 'unknown-type-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    await expect(pack.getPrompt('nonexistent-type')).rejects.toThrow(
      /no prompt for task type "nonexistent-type"/
    )
  })
})

// ---------------------------------------------------------------------------
// MethodologyPack.getConstraints()
// ---------------------------------------------------------------------------

describe('MethodologyPack.getConstraints()', () => {
  it('returns structured constraint objects', async () => {
    const packDir = join(testDir, 'constraints-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const constraints = await pack.getConstraints('create-story')

    expect(Array.isArray(constraints)).toBe(true)
    expect(constraints.length).toBeGreaterThan(0)

    const first = constraints[0]!
    expect(first).toHaveProperty('name')
    expect(first).toHaveProperty('description')
    expect(first).toHaveProperty('severity')
    expect(first).toHaveProperty('check')
  })

  it('severity values are one of required | recommended | optional', async () => {
    const packDir = join(testDir, 'severity-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const constraints = await pack.getConstraints('create-story')

    const validSeverities = new Set(['required', 'recommended', 'optional'])
    for (const c of constraints) {
      expect(validSeverities.has(c.severity)).toBe(true)
    }
  })

  it('caches constraints after first access', async () => {
    const packDir = join(testDir, 'constraint-cache-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    const first = await pack.getConstraints('dev-story')
    const second = await pack.getConstraints('dev-story')

    expect(first).toBe(second) // same array reference (from cache)
  })

  it('throws a clear error for unknown phase', async () => {
    const packDir = join(testDir, 'unknown-phase-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    await expect(pack.getConstraints('nonexistent-phase')).rejects.toThrow(
      /no constraints for phase "nonexistent-phase"/
    )
  })

  it('throws when constraint file has invalid structure', async () => {
    const packDir = join(testDir, 'bad-constraint-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)
    // Overwrite with invalid constraint content
    await writeFile(
      join(packDir, 'constraints', 'create-story.yaml'),
      '- name: bad\n  # missing required fields',
      'utf-8'
    )

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    await expect(pack.getConstraints('create-story')).rejects.toThrow(/Invalid constraint file/)
  })
})

// ---------------------------------------------------------------------------
// MethodologyPack.getTemplate()
// ---------------------------------------------------------------------------

describe('MethodologyPack.getTemplate()', () => {
  it('returns template content for a valid template name', async () => {
    const packDir = join(testDir, 'template-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)
    const template = await pack.getTemplate('story')

    expect(template).toContain('Story Template')
  })

  it('caches template after first access', async () => {
    const packDir = join(testDir, 'template-cache-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    const first = await pack.getTemplate('story')
    const second = await pack.getTemplate('story')

    expect(first).toBe(second)
  })

  it('throws a clear error for unknown template name', async () => {
    const packDir = join(testDir, 'unknown-template-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    await expect(pack.getTemplate('nonexistent')).rejects.toThrow(
      /no template named "nonexistent"/
    )
  })
})

// ---------------------------------------------------------------------------
// BMAD pack integration — loads real BMAD pack from packs/bmad/
// ---------------------------------------------------------------------------

describe('BMAD pack integration', () => {
  // Path to the real BMAD pack (relative to repo root)
  const bmadPackPath = resolve(process.cwd(), 'packs/bmad')

  it('loads the BMAD pack successfully', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)

    expect(pack.manifest.name).toBe('bmad')
    expect(pack.manifest.version).toBeDefined()
  })

  it('BMAD pack has 4 phases', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const phases = pack.getPhases()

    expect(phases).toHaveLength(4)
    const phaseNames = phases.map((p) => p.name)
    expect(phaseNames).toContain('analysis')
    expect(phaseNames).toContain('planning')
    expect(phaseNames).toContain('solutioning')
    expect(phaseNames).toContain('implementation')
  })

  it('BMAD pack create-story prompt exists and is within token budget (~2000 tokens)', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const prompt = await pack.getPrompt('create-story')

    expect(prompt).toBeDefined()
    expect(prompt.length).toBeGreaterThan(100)
    // ~4 chars per token; 2000 tokens ~ 8000 chars; allow 50% buffer = 12000
    expect(prompt.length).toBeLessThan(12000)
  })

  it('BMAD pack dev-story prompt exists and is within token budget (~1800 tokens)', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const prompt = await pack.getPrompt('dev-story')

    expect(prompt).toBeDefined()
    expect(prompt.length).toBeGreaterThan(100)
    // ~1800 tokens ~ 7200 chars; allow 50% buffer = 10800
    expect(prompt.length).toBeLessThan(10800)
  })

  it('BMAD pack code-review prompt exists and is within token budget (~1300 tokens)', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const prompt = await pack.getPrompt('code-review')

    expect(prompt).toBeDefined()
    expect(prompt.length).toBeGreaterThan(100)
    // ~1300 tokens ~ 5200 chars; allow 50% buffer = 7800
    expect(prompt.length).toBeLessThan(7800)
  })

  it('BMAD pack create-story constraints load as structured objects', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const constraints = await pack.getConstraints('create-story')

    expect(Array.isArray(constraints)).toBe(true)
    expect(constraints.length).toBeGreaterThanOrEqual(15) // story spec says ~20
    for (const c of constraints) {
      expect(c).toHaveProperty('name')
      expect(c).toHaveProperty('description')
      expect(c).toHaveProperty('severity')
      expect(c).toHaveProperty('check')
    }
  })

  it('BMAD pack dev-story constraints include sequential execution and red-green-refactor', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const constraints = await pack.getConstraints('dev-story')

    const names = constraints.map((c) => c.name)
    expect(names).toContain('sequential-task-execution')
    expect(names).toContain('red-green-refactor')
    expect(names).toContain('halt-on-new-dependency')
    expect(names).toContain('permitted-sections-only')
  })

  it('BMAD pack code-review constraints include adversarial minimum and severity', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const constraints = await pack.getConstraints('code-review')

    const names = constraints.map((c) => c.name)
    expect(names).toContain('minimum-three-issues')
    expect(names).toContain('adversarial-framing')
    expect(names).toContain('verdict-criteria')
    expect(names).toContain('git-reality-check')
  })

  it('BMAD pack story template is accessible', async () => {
    const loader = createPackLoader()
    const pack = await loader.load(bmadPackPath)
    const template = await pack.getTemplate('story')

    expect(template).toBeDefined()
    expect(template.length).toBeGreaterThan(50)
  })

  it('BMAD pack is discovered when discover() is called from repo root', async () => {
    const projectRoot = resolve(process.cwd())
    const loader = createPackLoader()
    const packs = await loader.discover(projectRoot)

    const bmad = packs.find((p) => p.name === 'bmad')
    expect(bmad).toBeDefined()
    expect(bmad?.path).toContain('packs/bmad')
  })
})

// ---------------------------------------------------------------------------
// MethodologyPackImpl direct tests (unit tests without file I/O for cache)
// ---------------------------------------------------------------------------

describe('MethodologyPackImpl cache behavior', () => {
  it('prompt cache returns same string reference on second call', async () => {
    const packDir = join(testDir, 'impl-cache-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    const first = await pack.getPrompt('create-story')
    const second = await pack.getPrompt('create-story')

    // Same reference from cache
    expect(first === second).toBe(true)
  })

  it('constraint cache returns same array reference on second call', async () => {
    const packDir = join(testDir, 'constraint-ref-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir)

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    const first = await pack.getConstraints('create-story')
    const second = await pack.getConstraints('create-story')

    expect(first === second).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Manifest schema validation edge cases
// ---------------------------------------------------------------------------

describe('Manifest schema validation', () => {
  it('rejects manifest with empty name', async () => {
    const packDir = join(testDir, 'empty-name-pack')
    await mkdir(packDir, { recursive: true })
    await createTestPack(packDir, {
      customManifestYaml: `name: ""\nversion: 1.0.0\ndescription: test\nphases: []\nprompts: {}\nconstraints: {}\ntemplates: {}`,
    })

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/validation/)
  })

  it('rejects manifest with invalid phase (missing entryGates)', async () => {
    const packDir = join(testDir, 'bad-phase-pack')
    await mkdir(packDir, { recursive: true })
    const yaml = `
name: test
version: 1.0.0
description: test
phases:
  - name: impl
    description: impl
    exitGates: []
    artifacts: []
prompts: {}
constraints: {}
templates: {}
`
    await createTestPack(packDir, { customManifestYaml: yaml })

    const loader = createPackLoader()
    await expect(loader.load(packDir)).rejects.toThrow(/validation/)
  })

  it('accepts manifest with empty phases array', async () => {
    const packDir = join(testDir, 'no-phases-pack')
    await mkdir(packDir, { recursive: true })
    const yaml = `name: test\nversion: 1.0.0\ndescription: test\nphases: []\nprompts: {}\nconstraints: {}\ntemplates: {}`
    await writeFile(join(packDir, 'manifest.yaml'), yaml, 'utf-8')

    const loader = createPackLoader()
    const pack = await loader.load(packDir)

    expect(pack.manifest.phases).toEqual([])
  })
})
