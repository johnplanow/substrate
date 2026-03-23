/**
 * Unit tests for ScenarioStore — discovery and integrity verification.
 */

import { createHash } from 'crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { ScenarioStore } from '../store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'scenario-store-test-'))
}

function setupScenariosDir(projectRoot: string): string {
  const scenariosDir = join(projectRoot, '.substrate', 'scenarios')
  mkdirSync(scenariosDir, { recursive: true })
  return scenariosDir
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScenarioStore', () => {
  let tmpDir: string
  const store = new ScenarioStore()

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // AC1: Scenario File Discovery by Glob Pattern
  it('AC1: discovers exactly the four scenario-* files and excludes helper.sh', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), '#!/bin/bash\necho login')
    writeFileSync(join(scenariosDir, 'scenario-checkout.py'), 'print("checkout")')
    writeFileSync(join(scenariosDir, 'scenario-auth.js'), 'console.log("auth")')
    writeFileSync(join(scenariosDir, 'scenario-deploy.ts'), 'export {}')
    writeFileSync(join(scenariosDir, 'helper.sh'), '#!/bin/bash\necho helper')

    const manifest = await store.discover(tmpDir)

    expect(manifest.scenarios).toHaveLength(4)
    const names = manifest.scenarios.map((s) => s.name)
    expect(names).toContain('scenario-login.sh')
    expect(names).toContain('scenario-checkout.py')
    expect(names).toContain('scenario-auth.js')
    expect(names).toContain('scenario-deploy.ts')
    expect(names).not.toContain('helper.sh')
  })

  // AC1: sorted alphabetically by name
  it('AC1: returns scenarios sorted alphabetically by name', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), 'login')
    writeFileSync(join(scenariosDir, 'scenario-auth.js'), 'auth')
    writeFileSync(join(scenariosDir, 'scenario-deploy.ts'), 'deploy')

    const manifest = await store.discover(tmpDir)

    const names = manifest.scenarios.map((s) => s.name)
    expect(names).toEqual([...names].sort())
  })

  // AC2: Empty directory returns empty manifest
  it('AC2: returns empty manifest when scenarios dir exists but contains no matching files', async () => {
    setupScenariosDir(tmpDir) // create dir but no files

    const manifest = await store.discover(tmpDir)

    expect(manifest.scenarios).toHaveLength(0)
    expect(manifest.capturedAt).toBeGreaterThan(0)
  })

  // AC3: Missing scenarios directory returns empty manifest
  it('AC3: returns empty manifest without throwing when .substrate/scenarios/ does not exist', async () => {
    // Do NOT create .substrate/scenarios
    await expect(store.discover(tmpDir)).resolves.toEqual({
      scenarios: [],
      capturedAt: expect.any(Number),
    })
  })

  // AC4: SHA-256 Checksum Computed Per File
  it('AC4: checksum matches independently computed SHA-256 digest', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    const fileContent = '#!/bin/bash\necho "login scenario"'
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), fileContent)

    const manifest = await store.discover(tmpDir)

    const entry = manifest.scenarios.find((s) => s.name === 'scenario-login.sh')
    expect(entry).toBeDefined()

    const expectedChecksum = sha256(Buffer.from(fileContent))
    expect(entry!.checksum).toBe(expectedChecksum)
  })

  // AC5: Integrity Verification Passes for Unmodified Files
  it('AC5: verify() returns { valid: true, tampered: [] } for unmodified files', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), 'echo login')
    writeFileSync(join(scenariosDir, 'scenario-auth.js'), 'console.log("auth")')

    const manifest = await store.discover(tmpDir)
    const result = await store.verify(manifest, tmpDir)

    expect(result.valid).toBe(true)
    expect(result.tampered).toEqual([])
  })

  // AC6: Integrity Verification Detects Modified Files
  it('AC6: verify() detects modified files and returns them in tampered array', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    const loginFile = join(scenariosDir, 'scenario-login.sh')
    writeFileSync(loginFile, 'echo login')

    const manifest = await store.discover(tmpDir)

    // Modify the file after capturing manifest
    writeFileSync(loginFile, 'echo MODIFIED')

    const result = await store.verify(manifest, tmpDir)

    expect(result.valid).toBe(false)
    expect(result.tampered).toContain('scenario-login.sh')
  })

  // Deleted file treated as tampered
  it('treats deleted files as tampered', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    const loginFile = join(scenariosDir, 'scenario-login.sh')
    writeFileSync(loginFile, 'echo login')

    const manifest = await store.discover(tmpDir)

    // Delete the file after capturing manifest
    unlinkSync(loginFile)

    const result = await store.verify(manifest, tmpDir)

    expect(result.valid).toBe(false)
    expect(result.tampered).toContain('scenario-login.sh')
  })

  // projectRoot parameter is respected
  it('respects projectRoot parameter — targets the given directory, not process.cwd()', async () => {
    // Create two separate project roots
    const tmpDir2 = createTmpDir()
    try {
      const scenariosDir1 = setupScenariosDir(tmpDir)
      const scenariosDir2 = setupScenariosDir(tmpDir2)

      writeFileSync(join(scenariosDir1, 'scenario-alpha.sh'), 'alpha')
      writeFileSync(join(scenariosDir2, 'scenario-beta.sh'), 'beta')

      const manifest1 = await store.discover(tmpDir)
      const manifest2 = await store.discover(tmpDir2)

      const names1 = manifest1.scenarios.map((s) => s.name)
      const names2 = manifest2.scenarios.map((s) => s.name)

      expect(names1).toContain('scenario-alpha.sh')
      expect(names1).not.toContain('scenario-beta.sh')
      expect(names2).toContain('scenario-beta.sh')
      expect(names2).not.toContain('scenario-alpha.sh')
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true })
    }
  })

  // ScenarioEntry shape verification
  it('ScenarioEntry has name, path, and checksum fields with correct formats', async () => {
    const scenariosDir = setupScenariosDir(tmpDir)
    writeFileSync(join(scenariosDir, 'scenario-login.sh'), 'echo login')

    const manifest = await store.discover(tmpDir)

    expect(manifest.scenarios).toHaveLength(1)
    const entry = manifest.scenarios[0]!
    expect(entry).toHaveProperty('name')
    expect(entry).toHaveProperty('path')
    expect(entry).toHaveProperty('checksum')
    expect(entry.name).toBe('scenario-login.sh')
    expect(entry.path).toMatch(/scenario-login\.sh$/)
    expect(entry.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  // capturedAt timestamp is set correctly
  it('manifest has a capturedAt timestamp within the expected range', async () => {
    setupScenariosDir(tmpDir)
    const before = Date.now()
    const manifest = await store.discover(tmpDir)
    const after = Date.now()

    expect(manifest.capturedAt).toBeGreaterThanOrEqual(before)
    expect(manifest.capturedAt).toBeLessThanOrEqual(after)
  })
})
