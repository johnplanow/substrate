/**
 * Unit tests for project-profile detection logic.
 *
 * Uses vi.mock to simulate filesystem state without creating real temp
 * directories, testing all stack marker priority paths.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest'
import * as fs from 'node:fs/promises'
import { detectSingleProjectStack, detectMonorepoProfile, detectProjectProfile } from '../detect.js'

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises')

const mockAccess = fs.access as MockedFunction<typeof fs.access>
const mockReaddir = fs.readdir as MockedFunction<typeof fs.readdir>

/** Helper: make access succeed for listed paths, fail for all others. */
function setupAccess(existingPaths: string[]): void {
  mockAccess.mockImplementation(async (filePath) => {
    const p = typeof filePath === 'string' ? filePath : String(filePath)
    if (existingPaths.some((ep) => p.endsWith(ep) || p === ep)) {
      return undefined
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no files exist
  mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  mockReaddir.mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// detectSingleProjectStack
// ---------------------------------------------------------------------------

describe('detectSingleProjectStack', () => {
  it('detects Go project from go.mod', async () => {
    setupAccess(['go.mod'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('go')
    expect(result.buildTool).toBe('go')
    expect(result.buildCommand).toBe('go build ./...')
    expect(result.testCommand).toBe('go test ./...')
  })

  it('detects Kotlin project from build.gradle.kts', async () => {
    setupAccess(['build.gradle.kts'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('kotlin')
    expect(result.buildTool).toBe('gradle')
  })

  it('detects Java project from build.gradle', async () => {
    // Only build.gradle (not .kts) to test priority
    setupAccess(['build.gradle'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('java')
    expect(result.buildTool).toBe('gradle')
  })

  it('detects Java project from pom.xml', async () => {
    setupAccess(['pom.xml'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('java')
    expect(result.buildTool).toBe('maven')
    expect(result.buildCommand).toBe('mvn compile')
    expect(result.testCommand).toBe('mvn test')
  })

  it('detects Rust project from Cargo.toml', async () => {
    setupAccess(['Cargo.toml'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('rust')
    expect(result.buildTool).toBe('cargo')
    expect(result.buildCommand).toBe('cargo build')
    expect(result.testCommand).toBe('cargo test')
  })

  it('detects Python project with poetry from pyproject.toml + poetry.lock', async () => {
    setupAccess(['pyproject.toml', 'poetry.lock'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('python')
    expect(result.buildTool).toBe('poetry')
    expect(result.buildCommand).toBe('poetry build')
    expect(result.testCommand).toBe('pytest')
  })

  it('detects Python project with pip from pyproject.toml (no poetry.lock)', async () => {
    setupAccess(['pyproject.toml'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('python')
    expect(result.buildTool).toBe('pip')
    expect(result.buildCommand).toBe('pip install -e .')
    expect(result.testCommand).toBe('pytest')
  })

  it('detects Node.js project with npm (package.json + package-lock.json)', async () => {
    setupAccess(['package.json', 'package-lock.json'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('typescript')
    expect(result.buildTool).toBe('npm')
  })

  it('detects Node.js project with pnpm from pnpm-lock.yaml', async () => {
    setupAccess(['package.json', 'pnpm-lock.yaml'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('typescript')
    expect(result.buildTool).toBe('pnpm')
    expect(result.buildCommand).toBe('pnpm run build')
    expect(result.testCommand).toBe('pnpm test')
  })

  it('detects Node.js project with yarn from yarn.lock', async () => {
    setupAccess(['package.json', 'yarn.lock'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('typescript')
    expect(result.buildTool).toBe('yarn')
    expect(result.buildCommand).toBe('yarn build')
    expect(result.testCommand).toBe('yarn test')
  })

  it('detects Node.js project with bun from bun.lockb', async () => {
    setupAccess(['package.json', 'bun.lockb'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('typescript')
    expect(result.buildTool).toBe('bun')
    expect(result.buildCommand).toBe('bun run build')
    expect(result.testCommand).toBe('bun test')
  })

  it('falls back to typescript/npm when no marker files are found', async () => {
    // All access calls fail (default mock)
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('typescript')
    expect(result.buildTool).toBe('npm')
    expect(result.buildCommand).toBe('npm run build')
    expect(result.testCommand).toBe('npm test')
  })

  it('go.mod takes priority over package.json', async () => {
    setupAccess(['go.mod', 'package.json'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('go')
  })

  it('build.gradle.kts takes priority over build.gradle', async () => {
    setupAccess(['build.gradle.kts', 'build.gradle'])
    const result = await detectSingleProjectStack('/project')
    expect(result.language).toBe('kotlin')
    expect(result.buildTool).toBe('gradle')
  })
})

// ---------------------------------------------------------------------------
// detectMonorepoProfile
// ---------------------------------------------------------------------------

describe('detectMonorepoProfile', () => {
  it('returns null when no turbo.json is found', async () => {
    // Default: no files exist
    const result = await detectMonorepoProfile('/project')
    expect(result).toBeNull()
  })

  it('detects Turborepo monorepo when turbo.json is present (v1 pipeline key)', async () => {
    setupAccess(['turbo.json'])
    mockReaddir.mockResolvedValue([])

    const result = await detectMonorepoProfile('/project')
    expect(result).not.toBeNull()
    expect(result?.project.type).toBe('monorepo')
    expect(result?.project.tool).toBe('turborepo')
    expect(result?.project.buildCommand).toBe('npx turbo build')
    expect(result?.project.testCommand).toBe('npx turbo test')
  })

  it('detects Turborepo monorepo when turbo.json is present (v2 tasks key)', async () => {
    // Both v1 and v2 are treated the same — just turbo.json presence matters
    setupAccess(['turbo.json'])
    mockReaddir.mockResolvedValue([])

    const result = await detectMonorepoProfile('/project')
    expect(result).not.toBeNull()
    expect(result?.project.tool).toBe('turborepo')
  })

  it('enumerates packages from apps/ and packages/ directories', async () => {
    setupAccess(['turbo.json', 'apps/web/package.json', 'apps/lock-service/go.mod'])

    // Mock readdir for apps/ and packages/
    mockReaddir.mockImplementation(async (dirPath) => {
      const p = typeof dirPath === 'string' ? dirPath : String(dirPath)
      if (p.endsWith('/apps')) {
        return [
          { name: 'web', isDirectory: () => true },
          { name: 'lock-service', isDirectory: () => true },
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      if (p.endsWith('/packages')) {
        return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
      }
      return [] as unknown as Awaited<ReturnType<typeof fs.readdir>>
    })

    const result = await detectMonorepoProfile('/project')
    expect(result).not.toBeNull()
    expect(result?.project.packages).toHaveLength(2)

    const web = result?.project.packages?.find((p) => p.path === 'apps/web')
    const lockService = result?.project.packages?.find((p) => p.path === 'apps/lock-service')

    expect(web?.language).toBe('typescript')
    expect(lockService?.language).toBe('go')
  })

  it('handles missing apps/ or packages/ directories gracefully', async () => {
    setupAccess(['turbo.json'])
    // readdir throws ENOENT for both subdirs
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    const result = await detectMonorepoProfile('/project')
    expect(result).not.toBeNull()
    expect(result?.project.packages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// detectProjectProfile (top-level)
// ---------------------------------------------------------------------------

describe('detectProjectProfile', () => {
  it('returns monorepo profile when turbo.json is present', async () => {
    setupAccess(['turbo.json'])
    mockReaddir.mockResolvedValue([])

    const result = await detectProjectProfile('/project')
    expect(result).not.toBeNull()
    expect(result!.project.type).toBe('monorepo')
    expect(result!.project.tool).toBe('turborepo')
  })

  it('returns single-project profile when no turbo.json', async () => {
    setupAccess(['go.mod'])

    const result = await detectProjectProfile('/project')
    expect(result).not.toBeNull()
    expect(result!.project.type).toBe('single')
    expect(result!.project.tool).toBeNull()
    expect(result!.project.buildCommand).toBe('go build ./...')
    expect(result!.project.testCommand).toBe('go test ./...')
    expect(result!.project.packages).toEqual([])
  })

  it('returns null when no recognizable marker files are found', async () => {
    // All access calls fail (default mock — no marker files present)
    const result = await detectProjectProfile('/project')
    expect(result).toBeNull()
  })

  it('backward compatibility: Node.js project with package.json', async () => {
    setupAccess(['package.json', 'pnpm-lock.yaml'])

    const result = await detectProjectProfile('/project')
    expect(result).not.toBeNull()
    expect(result!.project.type).toBe('single')
    expect(result!.project.tool).toBeNull()
    expect(result!.project.buildCommand).toBe('pnpm run build')
    expect(result!.project.testCommand).toBe('pnpm test')
  })
})
