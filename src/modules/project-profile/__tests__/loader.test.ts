/**
 * Unit tests for the project profile loader.
 *
 * Tests YAML override loading, Zod validation, and auto-detection fallback.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'
import * as fs from 'node:fs/promises'
import { loadProjectProfile } from '../loader.js'
import * as detectModule from '../detect.js'
import type { ProjectProfile } from '../types.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises')
vi.mock('../detect.js')

const mockAccess = fs.access as MockedFunction<typeof fs.access>
const mockReadFile = fs.readFile as MockedFunction<typeof fs.readFile>
const mockDetectProjectProfile = detectModule.detectProjectProfile as MockedFunction<
  typeof detectModule.detectProjectProfile
>

const VALID_PROFILE: ProjectProfile = {
  project: {
    type: 'single',
    tool: null,
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    packages: [],
  },
}

const VALID_PROFILE_YAML = `
project:
  type: single
  tool: null
  buildCommand: npm run build
  testCommand: npm test
  packages: []
`

const MONOREPO_PROFILE: ProjectProfile = {
  project: {
    type: 'monorepo',
    tool: 'turborepo',
    buildCommand: 'turbo build',
    testCommand: 'turbo test',
    packages: [],
  },
}

const MONOREPO_PROFILE_YAML = `
project:
  type: monorepo
  tool: turborepo
  buildCommand: turbo build
  testCommand: turbo test
  packages: []
`

beforeEach(() => {
  vi.clearAllMocks()
  // Default: file does not exist
  mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  mockDetectProjectProfile.mockResolvedValue(VALID_PROFILE)
})

// ---------------------------------------------------------------------------
// Fallback path (no YAML file)
// ---------------------------------------------------------------------------

describe('loadProjectProfile — auto-detection fallback', () => {
  it('calls detectProjectProfile when no override file exists', async () => {
    const result = await loadProjectProfile('/project')
    expect(mockDetectProjectProfile).toHaveBeenCalledWith('/project')
    expect(result).toEqual(VALID_PROFILE)
  })

  it('returns the detected profile without writing to disk', async () => {
    mockDetectProjectProfile.mockResolvedValue(MONOREPO_PROFILE)
    const result = await loadProjectProfile('/project')
    expect(result.project.type).toBe('monorepo')
    expect(result.project.tool).toBe('turborepo')
  })
})

// ---------------------------------------------------------------------------
// YAML override path
// ---------------------------------------------------------------------------

describe('loadProjectProfile — YAML override', () => {
  beforeEach(() => {
    // Make the profile file accessible
    mockAccess.mockResolvedValue(undefined)
  })

  it('returns parsed profile from valid YAML', async () => {
    mockReadFile.mockResolvedValue(VALID_PROFILE_YAML as unknown as Buffer)
    const result = await loadProjectProfile('/project')
    expect(result.project.type).toBe('single')
    expect(result.project.buildCommand).toBe('npm run build')
    expect(result.project.testCommand).toBe('npm test')
  })

  it('returns monorepo profile from valid YAML', async () => {
    mockReadFile.mockResolvedValue(MONOREPO_PROFILE_YAML as unknown as Buffer)
    const result = await loadProjectProfile('/project')
    expect(result.project.type).toBe('monorepo')
    expect(result.project.tool).toBe('turborepo')
    expect(result.project.buildCommand).toBe('turbo build')
  })

  it('does NOT call detectProjectProfile when YAML file exists', async () => {
    mockReadFile.mockResolvedValue(VALID_PROFILE_YAML as unknown as Buffer)
    await loadProjectProfile('/project')
    expect(mockDetectProjectProfile).not.toHaveBeenCalled()
  })

  it('throws with descriptive message when YAML fails Zod validation (missing type)', async () => {
    const invalidYaml = `
project:
  buildCommand: npm run build
  testCommand: npm test
`
    mockReadFile.mockResolvedValue(invalidYaml as unknown as Buffer)

    await expect(loadProjectProfile('/project')).rejects.toThrow(
      'Invalid .substrate/project-profile.yaml:'
    )
  })

  it('throws with descriptive message when YAML fails Zod validation (invalid type value)', async () => {
    const invalidYaml = `
project:
  type: unsupported-type
  buildCommand: npm run build
  testCommand: npm test
`
    mockReadFile.mockResolvedValue(invalidYaml as unknown as Buffer)

    await expect(loadProjectProfile('/project')).rejects.toThrow(
      'Invalid .substrate/project-profile.yaml:'
    )
  })

  it('propagates non-Zod errors as-is', async () => {
    mockReadFile.mockRejectedValue(new Error('Permission denied'))

    await expect(loadProjectProfile('/project')).rejects.toThrow('Permission denied')
  })
})

// ---------------------------------------------------------------------------
// Profile with packages
// ---------------------------------------------------------------------------

describe('loadProjectProfile — profile with packages', () => {
  it('parses profile with package entries correctly', async () => {
    mockAccess.mockResolvedValue(undefined)
    const yamlWithPackages = `
project:
  type: monorepo
  tool: turborepo
  buildCommand: turbo build
  testCommand: turbo test
  packages:
    - path: apps/web
      language: typescript
      buildTool: pnpm
    - path: apps/lock-service
      language: go
      buildTool: go
`
    mockReadFile.mockResolvedValue(yamlWithPackages as unknown as Buffer)

    const result = await loadProjectProfile('/project')
    expect(result.project.packages).toHaveLength(2)

    const webPkg = result.project.packages?.[0]
    expect(webPkg?.path).toBe('apps/web')
    expect(webPkg?.language).toBe('typescript')
    expect(webPkg?.buildTool).toBe('pnpm')

    const goPkg = result.project.packages?.[1]
    expect(goPkg?.path).toBe('apps/lock-service')
    expect(goPkg?.language).toBe('go')
    expect(goPkg?.buildTool).toBe('go')
  })
})
