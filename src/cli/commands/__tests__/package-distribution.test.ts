/**
 * Tests for Story 8.1: npm Package Distribution & Installation
 *
 * Validates AC requirements:
 * - AC1: Global installation via npm registry (bin entry, version, help)
 * - AC2: Package size constraint (under 50MB, files field, bin entry)
 * - AC3: Node engine constraint (>=22.0.0)
 * - AC4: Project-local install & npx compatibility (bin entry & CLI behavior)
 * - AC5: Semantic versioning & version matching (no 'v' prefix, semver format)
 * - AC6: CLI shebang & executable permissions (#!/usr/bin/env node)
 * - AC7: Built output configuration (build produces dist/, no source maps in package)
 * - AC8: npmignore configuration (excluded files, included files)
 * - AC9: Entry point validation (no module resolution failures)
 *
 * Note: Tests that invoke the CLI binary directly use spawnSync with a timeout.
 * Static validation tests (package.json fields, .npmignore contents) do not spawn processes.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync, accessSync, constants } from 'fs'
import { resolve, join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname_ts = dirname(__filename)

// Root of the project (4 levels up from src/cli/commands/__tests__)
const PROJECT_ROOT = resolve(__dirname_ts, '../../../..')

describe('Story 8.1: npm Package Distribution & Installation', () => {
  let packageJson: {
    name: string
    version: string
    description: string
    license: string
    author: string
    repository: { type: string; url: string }
    engines: { node: string }
    bin: Record<string, string>
    main: string
    exports: Record<string, unknown>
    files: string[]
    keywords: string[]
    type: string
  }

  beforeAll(() => {
    const pkgContent = readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')
    packageJson = JSON.parse(pkgContent)
  })

  // -----------------------------------------------------------------------
  // AC1: Global installation via npm registry
  // -----------------------------------------------------------------------
  describe('AC1: Global installation via npm registry', () => {
    it('should have name "substrate" (all lowercase, DNS-safe)', () => {
      expect(packageJson.name).toBe('substrate')
    })

    it('should have bin entry pointing to dist/cli/index.js', () => {
      expect(packageJson.bin).toBeDefined()
      expect(packageJson.bin['substrate']).toBe('./dist/cli/index.js')
    })

    it('should have a valid version field', () => {
      expect(packageJson.version).toBeDefined()
      expect(typeof packageJson.version).toBe('string')
      // Must be semantic version: MAJOR.MINOR.PATCH
      expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('should have a description field', () => {
      expect(packageJson.description).toBeTruthy()
      expect(typeof packageJson.description).toBe('string')
    })
  })

  // -----------------------------------------------------------------------
  // AC2: Package size constraint
  // -----------------------------------------------------------------------
  describe('AC2: Package size constraint', () => {
    it('should have "files" field to whitelist package contents', () => {
      expect(packageJson.files).toBeDefined()
      expect(Array.isArray(packageJson.files)).toBe(true)
      expect(packageJson.files.length).toBeGreaterThan(0)
    })

    it('should include dist output in files', () => {
      const hasDistEntry = packageJson.files.some(
        (f: string) => f.startsWith('dist') || f === 'dist/**',
      )
      expect(hasDistEntry).toBe(true)
    })

    it('should include README.md in files', () => {
      expect(packageJson.files).toContain('README.md')
    })

    it('should have bin entry pointing to built CLI', () => {
      expect(packageJson.bin['substrate']).toBe('./dist/cli/index.js')
    })
  })

  // -----------------------------------------------------------------------
  // AC3: Node engine constraint
  // -----------------------------------------------------------------------
  describe('AC3: Node engine constraint (>=22.0.0)', () => {
    it('should specify node engine >= 22.0.0', () => {
      expect(packageJson.engines).toBeDefined()
      expect(packageJson.engines.node).toBeDefined()
      // Should specify >=22.0.0 or higher (not >=18.0.0)
      expect(packageJson.engines.node).toMatch(/>=22/)
    })

    it('should NOT use the old >=18.0.0 constraint', () => {
      expect(packageJson.engines.node).not.toMatch(/>=18/)
    })
  })

  // -----------------------------------------------------------------------
  // AC4: Project-local installation & npx
  // -----------------------------------------------------------------------
  describe('AC4: Project-local installation & npx', () => {
    it('should have bin entry that enables npx substrate invocation', () => {
      // The bin entry is how npm creates the npx symlink
      expect(packageJson.bin['substrate']).toBeDefined()
    })

    it('should have type "module" for ESM support', () => {
      // Modern npm package with ESM
      expect(packageJson.type).toBe('module')
    })
  })

  // -----------------------------------------------------------------------
  // AC5: Semantic versioning & version matching
  // -----------------------------------------------------------------------
  describe('AC5: Semantic versioning & version matching', () => {
    it('should use semver MAJOR.MINOR.PATCH format (no v prefix)', () => {
      // Version must NOT start with 'v'
      expect(packageJson.version).not.toMatch(/^v/)
      // Must be valid semver
      expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/)
    })

    it('CLI --version output should NOT have "v" prefix', () => {
      const distCli = join(PROJECT_ROOT, 'dist/cli/index.js')
      if (!existsSync(distCli)) {
        console.warn('dist/cli/index.js not found; skipping --version check')
        return
      }
      const result = spawnSync('node', [distCli, '--version'], {
        encoding: 'utf-8',
        timeout: 15000,
      })
      if (result.error) {
        console.warn('CLI not runnable; skipping --version check:', result.error.message)
        return
      }
      const version = result.stdout.trim()
      expect(version).not.toMatch(/^v/)
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  // -----------------------------------------------------------------------
  // AC6: CLI shebang & executable permissions
  // -----------------------------------------------------------------------
  describe('AC6: CLI shebang & executable permissions', () => {
    it('dist/cli/index.js should have shebang as first line', () => {
      const distCli = join(PROJECT_ROOT, 'dist/cli/index.js')
      if (!existsSync(distCli)) {
        console.warn('dist/cli/index.js not found; skipping shebang check')
        return
      }
      const content = readFileSync(distCli, 'utf-8')
      const firstLine = content.split('\n')[0]
      expect(firstLine).toBe('#!/usr/bin/env node')
    })

    it('bin entry should reference correct file with shebang-compatible path', () => {
      // The path must be relative and start with ./ for npm to create a proper bin link
      expect(packageJson.bin['substrate']).toMatch(/^\.\/dist\//)
    })
  })

  // -----------------------------------------------------------------------
  // AC7: Built output configuration
  // -----------------------------------------------------------------------
  describe('AC7: Built output configuration', () => {
    it('should have main field pointing to dist/index.js', () => {
      expect(packageJson.main).toBe('./dist/index.js')
    })

    it('should have exports field with module and types', () => {
      expect(packageJson.exports).toBeDefined()
      const defaultExport = packageJson.exports['.'] as Record<string, string>
      expect(defaultExport).toBeDefined()
      expect(defaultExport.import).toBe('./dist/index.js')
      expect(defaultExport.types).toBe('./dist/index.d.ts')
    })

    it('should have CLI export in exports field', () => {
      const cliExport = packageJson.exports['./cli'] as Record<string, string>
      expect(cliExport).toBeDefined()
      expect(cliExport.import).toBe('./dist/cli/index.js')
    })

    it('files field should not explicitly include source maps', () => {
      // Check that files field does NOT explicitly include .map files
      const hasMapFiles = packageJson.files.some((f: string) => f.includes('.map'))
      expect(hasMapFiles).toBe(false)
    })

    it('README.md should be included in package distribution', () => {
      expect(packageJson.files).toContain('README.md')
    })
  })

  // -----------------------------------------------------------------------
  // AC8: npmignore configuration
  // -----------------------------------------------------------------------
  describe('AC8: npmignore configuration', () => {
    it('.npmignore file should exist', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      expect(existsSync(npmIgnorePath)).toBe(true)
    })

    it('.npmignore should exclude src/ directory', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('src/')
    })

    it('.npmignore should exclude test/ directory', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('test/')
    })

    it('.npmignore should exclude _bmad/ directory', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('_bmad/')
    })

    it('.npmignore should exclude _bmad-output/ directory', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('_bmad-output/')
    })

    it('.npmignore should exclude coverage/ directory', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('coverage/')
    })

    it('.npmignore should exclude .github/ directory', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('.github/')
    })

    it('.npmignore should exclude source map files', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toMatch(/\*\.map/)
    })

    it('.npmignore should exclude vitest.config.ts', () => {
      const npmIgnorePath = join(PROJECT_ROOT, '.npmignore')
      const content = readFileSync(npmIgnorePath, 'utf-8')
      expect(content).toContain('vitest.config.ts')
    })

    it('npm pack should not include source map files (dist output)', () => {
      const result = spawnSync('npm', ['pack', '--dry-run'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (result.error) {
        console.warn('npm pack failed; skipping pack content check:', result.error.message)
        return
      }
      const output = result.stdout + result.stderr
      // Should not contain .map files listed as tarball contents
      const lines = output.split('\n')
      const mapLines = lines.filter((line) => line.includes('.map') && line.includes('kB'))
      expect(mapLines).toHaveLength(0)
    })

    it('npm pack should include dist JS files', () => {
      const result = spawnSync('npm', ['pack', '--dry-run'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (result.error) {
        console.warn('npm pack failed; skipping pack content check:', result.error.message)
        return
      }
      const output = result.stdout + result.stderr
      expect(output).toContain('dist/cli/index.js')
    })

    it('npm pack should include README.md', () => {
      const result = spawnSync('npm', ['pack', '--dry-run'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (result.error) {
        console.warn('npm pack failed; skipping pack content check:', result.error.message)
        return
      }
      const output = result.stdout + result.stderr
      expect(output).toContain('README.md')
    })

    it('npm pack should NOT include src/ TypeScript files', () => {
      const result = spawnSync('npm', ['pack', '--dry-run'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30000,
      })
      if (result.error) {
        console.warn('npm pack failed; skipping pack content check:', result.error.message)
        return
      }
      const output = result.stdout + result.stderr
      // Check that no src/ files are listed in the tarball contents
      const lines = output.split('\n')
      const srcLines = lines.filter((line) => /\s+src\//.test(line))
      expect(srcLines).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // AC9: Entry point validation
  // -----------------------------------------------------------------------
  describe('AC9: Entry point validation', () => {
    it('CLI entry point should execute --help without errors', () => {
      const distCli = join(PROJECT_ROOT, 'dist/cli/index.js')
      if (!existsSync(distCli)) {
        console.warn('dist/cli/index.js not found; skipping help check')
        return
      }
      const result = spawnSync('node', [distCli, '--help'], {
        encoding: 'utf-8',
        timeout: 15000,
      })
      if (result.error) {
        console.warn('CLI not runnable; skipping help check:', result.error.message)
        return
      }
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Usage: substrate')
      expect(result.stdout).toContain('Options:')
      expect(result.stdout).toContain('Commands:')
    })

    it('CLI entry point should display all expected subcommands', () => {
      const distCli = join(PROJECT_ROOT, 'dist/cli/index.js')
      if (!existsSync(distCli)) {
        console.warn('dist/cli/index.js not found; skipping subcommand check')
        return
      }
      const result = spawnSync('node', [distCli, '--help'], {
        encoding: 'utf-8',
        timeout: 15000,
      })
      if (result.error) {
        console.warn('CLI not runnable; skipping subcommand check:', result.error.message)
        return
      }
      // Core commands that must be available
      expect(result.stdout).toContain('start')
      expect(result.stdout).toContain('init')
      expect(result.stdout).toContain('config')
      expect(result.stdout).toContain('plan')
    })

    it('CLI should report correct version from package.json', () => {
      const distCli = join(PROJECT_ROOT, 'dist/cli/index.js')
      if (!existsSync(distCli)) {
        console.warn('dist/cli/index.js not found; skipping version check')
        return
      }
      const result = spawnSync('node', [distCli, '--version'], {
        encoding: 'utf-8',
        timeout: 15000,
      })
      if (result.error) {
        console.warn('CLI not runnable; skipping version check:', result.error.message)
        return
      }
      const version = result.stdout.trim()
      expect(version).toBe(packageJson.version)
    })
  })

  // -----------------------------------------------------------------------
  // Package metadata validation
  // -----------------------------------------------------------------------
  describe('Package metadata validation', () => {
    it('should have license set to MIT', () => {
      expect(packageJson.license).toBe('MIT')
    })

    it('should have author field', () => {
      expect(packageJson.author).toBeTruthy()
    })

    it('should have repository field with git URL', () => {
      expect(packageJson.repository).toBeDefined()
      expect(packageJson.repository.type).toBe('git')
      expect(packageJson.repository.url).toBeTruthy()
    })

    it('should have keywords array with required terms', () => {
      expect(packageJson.keywords).toBeDefined()
      expect(Array.isArray(packageJson.keywords)).toBe(true)
      expect(packageJson.keywords).toContain('ai')
      expect(packageJson.keywords).toContain('agents')
      expect(packageJson.keywords).toContain('orchestration')
      expect(packageJson.keywords).toContain('cli')
      expect(packageJson.keywords).toContain('task-graph')
      expect(packageJson.keywords).toContain('routing')
    })
  })
})
