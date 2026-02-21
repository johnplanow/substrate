/**
 * Unit tests for codebase-scanner.ts
 *
 * Uses real temp directories to avoid mocking complexity with directory traversal.
 * Covers AC1, AC2, AC7, AC9.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanCodebase, ScanError } from '../codebase-scanner.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-scanner-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup failures
    }
  }
  tempDirs = []
})

// ---------------------------------------------------------------------------
// AC7: Path validation
// ---------------------------------------------------------------------------

describe('AC7: path validation', () => {
  it('throws ScanError with SCAN_PATH_NOT_FOUND for non-existent path', async () => {
    await expect(scanCodebase('/nonexistent/path/that/does/not/exist')).rejects.toMatchObject({
      name: 'ScanError',
      code: 'SCAN_PATH_NOT_FOUND',
      message: expect.stringContaining('Codebase path not found'),
    })
  })

  it('throws ScanError with SCAN_PATH_NOT_DIR for a file path', async () => {
    const dir = makeTempDir()
    const filePath = join(dir, 'package.json')
    writeFileSync(filePath, '{}')

    await expect(scanCodebase(filePath)).rejects.toMatchObject({
      name: 'ScanError',
      code: 'SCAN_PATH_NOT_DIR',
      message: expect.stringContaining('Codebase path is not a directory'),
    })
  })

  it('ScanError is instance of Error', async () => {
    const err = new ScanError('test message', 'SCAN_PATH_NOT_FOUND')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ScanError')
    expect(err.code).toBe('SCAN_PATH_NOT_FOUND')
    expect(err.message).toBe('test message')
  })
})

// ---------------------------------------------------------------------------
// AC1: Basic scanning with package.json
// ---------------------------------------------------------------------------

describe('AC1: codebase path scanning', () => {
  it('detects Node.js from package.json', async () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'my-project',
        version: '1.0.0',
        dependencies: { express: '^4.18.0' },
        devDependencies: {},
      }),
    )

    const ctx = await scanCodebase(dir)

    expect(ctx.techStack.some((s) => s.name === 'Node.js')).toBe(true)
  })

  it('detects TypeScript from devDependencies in package.json', async () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'ts-project',
        devDependencies: { typescript: '^5.0.0' },
        dependencies: {},
      }),
    )

    const ctx = await scanCodebase(dir)

    const tsEntry = ctx.techStack.find((s) => s.name === 'TypeScript')
    expect(tsEntry).toBeDefined()
    expect(tsEntry?.source).toBe('package.json')
  })

  it('populates runtime and development dependencies from package.json', async () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dep-project',
        dependencies: { commander: '^12.0.0', zod: '^3.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    )

    const ctx = await scanCodebase(dir)

    expect(ctx.dependencies.runtime['commander']).toBe('^12.0.0')
    expect(ctx.dependencies.runtime['zod']).toBe('^3.0.0')
    expect(ctx.dependencies.development['vitest']).toBe('^1.0.0')
  })

  it('returns populated rootPath', async () => {
    const dir = makeTempDir()
    const ctx = await scanCodebase(dir)
    expect(ctx.rootPath).toBe(dir)
  })

  it('detects React from dependencies', async () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'react-project',
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: {},
      }),
    )

    const ctx = await scanCodebase(dir)

    expect(ctx.techStack.some((s) => s.name === 'React')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC2: contextDepth flag
// ---------------------------------------------------------------------------

describe('AC2: contextDepth flag', () => {
  it('contextDepth: 0 — returns no directories (only root-level analysis)', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'src', 'utils'))

    const ctx = await scanCodebase(dir, { contextDepth: 0 })

    // At depth 0 we start from root but collect dirs at depth 1+ — with maxDepth 0 no dirs collected
    expect(ctx.topLevelDirs).toEqual([])
  })

  it('contextDepth: 1 — lists first-level dirs only', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'test'))
    mkdirSync(join(dir, 'src', 'utils')) // this should NOT appear at depth 1

    const ctx = await scanCodebase(dir, { contextDepth: 1 })

    expect(ctx.topLevelDirs).toContain('src')
    expect(ctx.topLevelDirs).toContain('test')
    // Sub-directory should not appear
    expect(ctx.topLevelDirs).not.toContain(join('src', 'utils'))
  })

  it('contextDepth: 2 (default) — lists two levels of dirs', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'src', 'utils'))
    mkdirSync(join(dir, 'src', 'utils', 'deep')) // depth 3 — should NOT appear

    const ctx = await scanCodebase(dir, { contextDepth: 2 })

    expect(ctx.topLevelDirs).toContain('src')
    expect(ctx.topLevelDirs).toContain(join('src', 'utils'))
    expect(ctx.topLevelDirs).not.toContain(join('src', 'utils', 'deep'))
  })

  it('default depth is 2', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'src', 'utils'))

    const ctx = await scanCodebase(dir) // no explicit contextDepth

    expect(ctx.topLevelDirs).toContain('src')
    expect(ctx.topLevelDirs).toContain(join('src', 'utils'))
  })
})

// ---------------------------------------------------------------------------
// AC9: Key file extraction
// ---------------------------------------------------------------------------

describe('AC9: key file extraction', () => {
  it('includes README.md with first 500 chars only', async () => {
    const dir = makeTempDir()
    const longContent = 'A'.repeat(1000)
    writeFileSync(join(dir, 'README.md'), longContent)

    const ctx = await scanCodebase(dir)

    const readmeEntry = ctx.keyFiles.find((f) => f.relativePath === 'README.md')
    expect(readmeEntry).toBeDefined()
    expect(readmeEntry!.contentSummary.length).toBeLessThanOrEqual(500)
    expect(readmeEntry!.skipped).toBe(false)
  })

  it('marks files exceeding 50KB as skipped', async () => {
    const dir = makeTempDir()
    // Create a go.mod that exceeds 50KB
    const largeContent = 'x'.repeat(51 * 1024)
    writeFileSync(join(dir, 'go.mod'), largeContent)

    const ctx = await scanCodebase(dir)

    const goModEntry = ctx.keyFiles.find((f) => f.relativePath === 'go.mod')
    expect(goModEntry).toBeDefined()
    expect(goModEntry!.skipped).toBe(true)
  })

  it('detects TypeScript from tsconfig.json', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true },
    }))

    const ctx = await scanCodebase(dir)

    const tsEntry = ctx.techStack.find((s) => s.name === 'TypeScript')
    expect(tsEntry).toBeDefined()
    expect(tsEntry?.source).toBe('tsconfig.json')
  })

  it('includes tsconfig.json in keyFiles when present', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022' },
    }))

    const ctx = await scanCodebase(dir)

    expect(ctx.keyFiles.some((f) => f.relativePath === 'tsconfig.json')).toBe(true)
  })

  it('detects Go from go.mod', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'go.mod'), 'module example.com/myapp\n\ngo 1.21\n')

    const ctx = await scanCodebase(dir)

    const goEntry = ctx.techStack.find((s) => s.name === 'Go')
    expect(goEntry).toBeDefined()
    expect(goEntry?.version).toBe('1.21')
    expect(ctx.detectedLanguages).toContain('Go')
  })

  it('detects Python from pyproject.toml', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.poetry]\nname = "myapp"\n')

    const ctx = await scanCodebase(dir)

    const pyEntry = ctx.techStack.find((s) => s.name === 'Python')
    expect(pyEntry).toBeDefined()
    expect(ctx.detectedLanguages).toContain('Python')
  })

  it('detects Rust from Cargo.toml', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "myapp"\nversion = "0.1.0"\n')

    const ctx = await scanCodebase(dir)

    const rustEntry = ctx.techStack.find((s) => s.name === 'Rust')
    expect(rustEntry).toBeDefined()
    expect(ctx.detectedLanguages).toContain('Rust')
  })

  it('detects Java from pom.xml', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'pom.xml'), '<project><groupId>com.example</groupId></project>')

    const ctx = await scanCodebase(dir)

    const javaEntry = ctx.techStack.find((s) => s.name === 'Java')
    expect(javaEntry).toBeDefined()
    expect(ctx.detectedLanguages).toContain('Java')
  })

  it('reads .substrate/substrate.yaml if present', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, '.substrate'))
    writeFileSync(join(dir, '.substrate', 'substrate.yaml'), 'agents:\n  - id: claude\n')

    const ctx = await scanCodebase(dir)

    const yamlEntry = ctx.keyFiles.find((f) => f.relativePath === '.substrate/substrate.yaml')
    expect(yamlEntry).toBeDefined()
    expect(yamlEntry!.contentSummary).toContain('claude')
  })
})

// ---------------------------------------------------------------------------
// Excluded directories
// ---------------------------------------------------------------------------

describe('excluded directories', () => {
  it('does not include node_modules in topLevelDirs', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'node_modules'))
    mkdirSync(join(dir, 'src'))

    const ctx = await scanCodebase(dir)

    expect(ctx.topLevelDirs).not.toContain('node_modules')
    expect(ctx.topLevelDirs).toContain('src')
  })

  it('does not include .git in topLevelDirs', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'src'))

    const ctx = await scanCodebase(dir)

    expect(ctx.topLevelDirs).not.toContain('.git')
  })

  it('does not include dist in topLevelDirs', async () => {
    const dir = makeTempDir()
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'src'))

    const ctx = await scanCodebase(dir)

    expect(ctx.topLevelDirs).not.toContain('dist')
  })
})

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

describe('detectedLanguages', () => {
  it('TypeScript implies JavaScript in detectedLanguages', async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))

    const ctx = await scanCodebase(dir)

    expect(ctx.detectedLanguages).toContain('TypeScript')
    expect(ctx.detectedLanguages).toContain('JavaScript')
  })

  it('Node.js alone implies JavaScript', async () => {
    const dir = makeTempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'myapp', dependencies: {}, devDependencies: {} }),
    )

    const ctx = await scanCodebase(dir)

    expect(ctx.detectedLanguages).toContain('JavaScript')
  })

  it('empty directory returns empty detectedLanguages', async () => {
    const dir = makeTempDir()

    const ctx = await scanCodebase(dir)

    expect(ctx.detectedLanguages).toEqual([])
  })
})
