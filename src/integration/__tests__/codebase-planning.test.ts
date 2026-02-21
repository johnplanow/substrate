/**
 * Integration test for codebase-aware planning (Story 7-2)
 *
 * Uses real temp directories to test scanCodebase and buildPlanningPrompt end-to-end.
 * Covers AC1, AC4, AC9.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanCodebase } from '../../modules/plan-generator/codebase-scanner.js'
import { buildPlanningPrompt } from '../../modules/plan-generator/planning-prompt.js'
import type { AgentSummary } from '../../modules/plan-generator/planning-prompt.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-integration-test-'))
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
// AC1/AC9: Full codebase scan
// ---------------------------------------------------------------------------

describe('Integration: scanCodebase with real filesystem', () => {
  it('AC1/AC9: scans a project with package.json, tsconfig.json, src/, README.md', async () => {
    const dir = makeTempDir()

    // Set up project structure
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'integration-test-project',
        version: '1.2.3',
        description: 'Test project for integration',
        dependencies: { commander: '^12.0.0', zod: '^3.0.0' },
        devDependencies: { typescript: '^5.0.0', vitest: '^1.0.0' },
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    )

    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true },
      }),
    )

    writeFileSync(
      join(dir, 'README.md'),
      'This is the integration test project README. It has some content for testing purposes.',
    )

    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'src', 'utils'))
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const foo = "bar"')
    writeFileSync(join(dir, 'src', 'utils', 'helper.ts'), 'export const helper = () => {}')

    mkdirSync(join(dir, 'node_modules'))
    mkdirSync(join(dir, 'node_modules', 'commander'))

    // Scan
    const ctx = await scanCodebase(dir, { contextDepth: 2 })

    // AC1: tech stack
    expect(ctx.techStack.some((s) => s.name === 'Node.js')).toBe(true)
    expect(ctx.techStack.some((s) => s.name === 'TypeScript')).toBe(true)

    // AC1: dependencies populated
    expect(ctx.dependencies.runtime['commander']).toBe('^12.0.0')
    expect(ctx.dependencies.runtime['zod']).toBe('^3.0.0')
    expect(ctx.dependencies.development['vitest']).toBe('^1.0.0')

    // AC1: topLevelDirs includes src
    expect(ctx.topLevelDirs).toContain('src')

    // topLevelDirs does NOT contain node_modules (excluded)
    expect(ctx.topLevelDirs).not.toContain('node_modules')

    // src/utils appears at depth 2
    expect(ctx.topLevelDirs.some((d) => d.includes('utils'))).toBe(true)

    // AC9: README.md in keyFiles with truncated content
    const readmeEntry = ctx.keyFiles.find((f) => f.relativePath === 'README.md')
    expect(readmeEntry).toBeDefined()
    expect(readmeEntry!.skipped).toBe(false)

    // AC9: tsconfig.json in keyFiles
    expect(ctx.keyFiles.some((f) => f.relativePath === 'tsconfig.json')).toBe(true)

    // Languages include TypeScript and JavaScript
    expect(ctx.detectedLanguages).toContain('TypeScript')
    expect(ctx.detectedLanguages).toContain('JavaScript')
  })

  it('AC4: buildPlanningPrompt with codebaseContext, availableAgents, agentCount: 2 produces all sections', async () => {
    const dir = makeTempDir()

    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'auth-project',
        dependencies: { express: '^4.18.0' },
        devDependencies: { typescript: '^5.0.0' },
      }),
    )

    writeFileSync(
      join(dir, 'README.md'),
      'Auth project README content for testing.',
    )

    const codebaseContext = await scanCodebase(dir, { contextDepth: 2 })

    const availableAgents: AgentSummary[] = [
      {
        agentId: 'claude',
        supportedTaskTypes: ['coding', 'testing', 'debugging', 'refactoring', 'docs'],
        billingMode: 'subscription',
        healthy: true,
      },
      {
        agentId: 'codex',
        supportedTaskTypes: ['coding', 'refactoring'],
        billingMode: 'api',
        healthy: true,
      },
    ]

    const prompt = buildPlanningPrompt({
      goal: 'Add JWT authentication',
      codebaseContext,
      availableAgents,
      agentCount: 2,
    })

    // All three sections present
    expect(prompt).toContain('## Codebase Context')
    expect(prompt).toContain('## Available Agents')
    expect(prompt).toContain('## Multi-Agent Instructions')

    // Goal present
    expect(prompt).toContain('Add JWT authentication')

    // Codebase context details
    expect(prompt).toContain(dir) // rootPath
    expect(prompt).toContain('Node.js')

    // Agent details
    expect(prompt).toContain('claude')
    expect(prompt).toContain('codex')

    // Multi-agent count
    expect(prompt).toContain('2')
  })
})
