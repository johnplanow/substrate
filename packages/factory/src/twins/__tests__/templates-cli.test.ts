/**
 * Integration tests for the `twins init` and `twins templates` CLI logic.
 *
 * Story 47-4 — Task 7.
 *
 * These tests invoke the underlying logic directly (not via Commander subprocess) to avoid
 * overhead and to allow precise assertion on file system state and exit codes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { getTwinTemplate, listTwinTemplates } from '../templates.js'
import { TwinDefinitionSchema } from '../schema.js'
import type { TwinDefinitionInput } from '../schema.js'

// ---------------------------------------------------------------------------
// Helpers — mirror the init action logic from factory-command.ts
// ---------------------------------------------------------------------------

interface InitOpts {
  template: string
  force?: boolean
}

interface InitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Extracted init logic from the `factory twins init` Commander action.
 * Returns stdout, stderr, and exit code without actually calling `process.exit`.
 */
async function runInitLogic(opts: InitOpts, cwd: string): Promise<InitResult> {
  let stdout = ''
  let stderr = ''

  const entry = getTwinTemplate(opts.template)
  if (!entry) {
    const available = listTwinTemplates()
      .map((t) => t.name)
      .join(', ')
    stderr = `Error: Unknown template '${opts.template}'. Available: ${available}\n`
    return { exitCode: 1, stdout, stderr }
  }

  const targetPath = path.join(cwd, '.substrate', 'twins', `${opts.template}.yaml`)

  if (!opts.force) {
    try {
      await fsPromises.access(targetPath)
      // File exists — error without --force
      stderr = `Error: File already exists: ${targetPath} — use --force to overwrite\n`
      return { exitCode: 1, stdout, stderr }
    } catch {
      // access() threw → file does not exist → proceed
    }
  }

  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true })
  const yamlContent = yaml.dump(entry.definition)
  await fsPromises.writeFile(targetPath, yamlContent, 'utf-8')
  stdout = `Created ${targetPath}\n`

  return { exitCode: 0, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Helpers — mirror the templates action logic from factory-command.ts
// ---------------------------------------------------------------------------

/**
 * Extracted templates listing logic from the `factory twins templates` Commander action.
 * Returns the stdout string that would be written to process.stdout.
 */
function runTemplatesLogic(): string {
  const templates = listTwinTemplates()
  let stdout = ''
  for (const t of templates) {
    stdout += `  ${t.name.padEnd(16)}  ${t.description}\n`
  }
  return stdout
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twins-cli-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('factory twins init — localstack', () => {
  it('creates .substrate/twins/localstack.yaml', async () => {
    const result = await runInitLogic({ template: 'localstack', force: false }, tmpDir)
    expect(result.exitCode).toBe(0)

    const filePath = path.join(tmpDir, '.substrate', 'twins', 'localstack.yaml')
    expect(fs.existsSync(filePath)).toBe(true)

    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = yaml.load(content) as TwinDefinitionInput
    expect(parsed.name).toBe('localstack')
    expect(parsed.image).toBe('localstack/localstack:latest')
    expect(parsed.ports).toContain('4566:4566')
    expect(parsed.healthcheck?.url).toBe('http://localhost:4566/_localstack/health')

    // Must pass schema validation
    expect(() => TwinDefinitionSchema.parse(parsed)).not.toThrow()
  })
})

describe('factory twins init — wiremock', () => {
  it('creates .substrate/twins/wiremock.yaml', async () => {
    const result = await runInitLogic({ template: 'wiremock', force: false }, tmpDir)
    expect(result.exitCode).toBe(0)

    const filePath = path.join(tmpDir, '.substrate', 'twins', 'wiremock.yaml')
    expect(fs.existsSync(filePath)).toBe(true)

    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = yaml.load(content) as TwinDefinitionInput
    expect(parsed.name).toBe('wiremock')
    expect(parsed.image).toBe('wiremock/wiremock:latest')
    expect(parsed.ports).toContain('8080:8080')
    expect(parsed.healthcheck?.url).toBe('http://localhost:8080/__admin/health')

    // Must pass schema validation
    expect(() => TwinDefinitionSchema.parse(parsed)).not.toThrow()
  })
})

describe('factory twins init — unknown template', () => {
  it('exits with code 1 and mentions Available templates', async () => {
    const result = await runInitLogic({ template: 'bogus' }, tmpDir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Unknown template')
    expect(result.stderr).toContain('bogus')
    expect(result.stderr).toContain('Available:')
    expect(result.stderr).toContain('localstack')
    expect(result.stderr).toContain('wiremock')
  })
})

describe('factory twins init — existing file without --force', () => {
  it('exits with code 1 and does NOT overwrite existing file', async () => {
    // Pre-create the file with sentinel content
    const twinsDir = path.join(tmpDir, '.substrate', 'twins')
    fs.mkdirSync(twinsDir, { recursive: true })
    const filePath = path.join(twinsDir, 'localstack.yaml')
    const sentinelContent = 'sentinel: content\n'
    fs.writeFileSync(filePath, sentinelContent, 'utf-8')

    const result = await runInitLogic({ template: 'localstack', force: false }, tmpDir)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('already exists')
    expect(result.stderr).toContain('--force')

    // File must NOT have been overwritten
    const actual = fs.readFileSync(filePath, 'utf-8')
    expect(actual).toBe(sentinelContent)
  })
})

describe('factory twins init — existing file with --force', () => {
  it('overwrites the existing file with valid YAML', async () => {
    // Pre-create the file with sentinel content
    const twinsDir = path.join(tmpDir, '.substrate', 'twins')
    fs.mkdirSync(twinsDir, { recursive: true })
    const filePath = path.join(twinsDir, 'localstack.yaml')
    fs.writeFileSync(filePath, 'sentinel: content\n', 'utf-8')

    const result = await runInitLogic({ template: 'localstack', force: true }, tmpDir)
    expect(result.exitCode).toBe(0)

    const content = fs.readFileSync(filePath, 'utf-8')
    const parsed = yaml.load(content) as TwinDefinitionInput
    expect(parsed.name).toBe('localstack')
    expect(() => TwinDefinitionSchema.parse(parsed)).not.toThrow()
  })
})

describe('factory twins templates — output format', () => {
  it('outputs one line per template with name and description', () => {
    const output = runTemplatesLogic()
    const lines = output.split('\n').filter((l) => l.trim().length > 0)

    // At least two entries (localstack + wiremock)
    expect(lines.length).toBeGreaterThanOrEqual(2)

    // Each line must be non-empty and contain a name+description pair
    for (const line of lines) {
      expect(line.trim().length).toBeGreaterThan(0)
    }
  })

  it('includes localstack with its description on one line', () => {
    const output = runTemplatesLogic()
    const lines = output.split('\n').filter((l) => l.trim().length > 0)
    const localstackLine = lines.find((l) => l.includes('localstack'))
    expect(localstackLine).toBeDefined()
    // Line must contain the description text
    expect(localstackLine).toContain('LocalStack')
  })

  it('includes wiremock with its description on one line', () => {
    const output = runTemplatesLogic()
    const lines = output.split('\n').filter((l) => l.trim().length > 0)
    const wiremockLine = lines.find((l) => l.includes('wiremock'))
    expect(wiremockLine).toBeDefined()
    // Line must contain the description text
    expect(wiremockLine).toContain('WireMock')
  })

  it('uses padEnd(16) so name and description are tab-aligned', () => {
    const output = runTemplatesLogic()
    // Each line should start with two spaces and the name padded to ≥16 chars + two spaces
    const lines = output.split('\n').filter((l) => l.trim().length > 0)
    for (const line of lines) {
      // Format: "  <name padEnd(16)>  <description>"
      expect(line).toMatch(/^  \S.{14,}  \S/)
    }
  })
})
