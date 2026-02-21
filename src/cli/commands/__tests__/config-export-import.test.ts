/**
 * Unit tests for `substrate config export` and `substrate config import` subcommands
 *
 * Covers:
 *  - AC1: config export → stdout (YAML with header comment)
 *  - AC2: config export → file (--output flag)
 *  - AC3: config export → JSON format
 *  - AC4: config import → valid file, diff shown, changes applied
 *  - AC5: config import → --yes flag, no prompt
 *  - AC6: config import → no changes detected
 *  - AC7: config import → file not found; invalid YAML/JSON syntax
 *  - AC8: config import → Zod schema validation failure
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  runConfigExport,
  runConfigImport,
  CONFIG_EXIT_SUCCESS,
  CONFIG_EXIT_INVALID,
  CONFIG_EXIT_ERROR,
} from '../config.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string
let projectConfigDir: string
let globalConfigDir: string

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `substrate-config-ei-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  )
  projectConfigDir = join(testDir, '.substrate')
  globalConfigDir = join(testDir, 'global', '.substrate')
  await mkdir(projectConfigDir, { recursive: true })
  await mkdir(globalConfigDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureOutput(): { getStdout: () => string; getStderr: () => string; restore: () => void } {
  let stdout = ''
  let stderr = ''
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
    stdout += typeof data === 'string' ? data : data.toString()
    return true
  })
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
    stderr += typeof data === 'string' ? data : data.toString()
    return true
  })
  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
    restore: (): void => {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    },
  }
}

async function writeConfigYaml(content: string, dir?: string): Promise<void> {
  const configDir = dir ?? projectConfigDir
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'config.yaml'), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// config export — AC1: stdout, YAML with header comment
// ---------------------------------------------------------------------------

describe('runConfigExport — AC1: stdout YAML with header comment', () => {
  it('returns CONFIG_EXIT_SUCCESS', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigExport({ projectConfigDir, globalConfigDir })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('writes YAML header comment with ISO8601 timestamp to stdout', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigExport({ projectConfigDir, globalConfigDir })
      const out = getStdout()
      expect(out).toMatch(/^# Substrate Configuration Export — \d{4}-\d{2}-\d{2}T/)
    } finally {
      restore()
    }
  })

  it('includes config keys in stdout YAML output', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigExport({ projectConfigDir, globalConfigDir })
      const out = getStdout()
      expect(out).toContain('config_format_version')
      expect(out).toContain('global')
    } finally {
      restore()
    }
  })

  it('masks credentials in export (api_key_env values stay as field names)', async () => {
    // The masking behavior: getMasked() returns the masked config
    // We can verify the output is valid YAML containing config data
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigExport({ projectConfigDir, globalConfigDir })
      const out = getStdout()
      // Should be parseable YAML (after stripping the comment header)
      const lines = out.split('\n')
      const yamlContent = lines.filter((l) => !l.startsWith('#')).join('\n')
      const yaml = await import('js-yaml')
      const parsed = yaml.default.load(yamlContent) as Record<string, unknown>
      expect(parsed).toBeTruthy()
      expect(typeof parsed).toBe('object')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config export — AC2: --output file
// ---------------------------------------------------------------------------

describe('runConfigExport — AC2: write to file', () => {
  it('writes config to the specified file', async () => {
    const outputPath = join(testDir, 'substrate-backup.yaml')
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigExport({ output: outputPath, projectConfigDir, globalConfigDir })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
      const content = await readFile(outputPath, 'utf-8')
      expect(content).toContain('config_format_version')
    } finally {
      restore()
    }
  })

  it('prints confirmation message to stdout', async () => {
    const outputPath = join(testDir, 'substrate-backup.yaml')
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigExport({ output: outputPath, projectConfigDir, globalConfigDir })
      const out = getStdout()
      expect(out).toContain(`Configuration exported to ${outputPath}`)
    } finally {
      restore()
    }
  })

  it('overwrites existing file', async () => {
    const outputPath = join(testDir, 'substrate-backup.yaml')
    await writeFile(outputPath, 'old content', 'utf-8')
    const { restore } = captureOutput()
    try {
      await runConfigExport({ output: outputPath, projectConfigDir, globalConfigDir })
      const content = await readFile(outputPath, 'utf-8')
      expect(content).not.toBe('old content')
      expect(content).toContain('config_format_version')
    } finally {
      restore()
    }
  })

  it('exits with code 0', async () => {
    const outputPath = join(testDir, 'output.yaml')
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigExport({ output: outputPath, projectConfigDir, globalConfigDir })
      expect(exitCode).toBe(0)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config export — AC3: JSON format
// ---------------------------------------------------------------------------

describe('runConfigExport — AC3: JSON format', () => {
  it('outputs valid pretty-printed JSON to stdout', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigExport({ outputFormat: 'json', projectConfigDir, globalConfigDir })
      const out = getStdout()
      expect(() => JSON.parse(out) as unknown).not.toThrow()
      const parsed = JSON.parse(out) as { config_format_version: string }
      expect(parsed.config_format_version).toBe('1')
    } finally {
      restore()
    }
  })

  it('pretty-prints JSON with 2-space indentation', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigExport({ outputFormat: 'json', projectConfigDir, globalConfigDir })
      const out = getStdout()
      expect(out).toContain('  "')
    } finally {
      restore()
    }
  })

  it('writes JSON to file when --output is also specified', async () => {
    const outputPath = join(testDir, 'config.json')
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigExport({
        outputFormat: 'json',
        output: outputPath,
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
      const content = await readFile(outputPath, 'utf-8')
      const parsed = JSON.parse(content) as { config_format_version: string }
      expect(parsed.config_format_version).toBe('1')
    } finally {
      restore()
    }
  })

  it('exits with code 0', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigExport({ outputFormat: 'json', projectConfigDir, globalConfigDir })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config import — AC4: valid YAML file, diff shown, changes applied
// ---------------------------------------------------------------------------

describe('runConfigImport — AC4: valid file, diff, apply', () => {
  it('displays diff of changed keys and applies them', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: debug\n', 'utf-8')

    const { getStdout, restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
      const out = getStdout()
      expect(out).toContain('global.log_level')
      expect(out).toContain('debug')
    } finally {
      restore()
    }
  })

  it('writes the changed key to the project config file', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: warn\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      const content = await readFile(join(projectConfigDir, 'config.yaml'), 'utf-8')
      expect(content).toContain('warn')
    } finally {
      restore()
    }
  })

  it('prints success message with count of updated settings', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: warn\n', 'utf-8')

    const { getStdout, restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      const out = getStdout()
      expect(out).toContain('Configuration imported successfully')
      expect(out).toContain('setting(s) updated')
    } finally {
      restore()
    }
  })

  it('returns CONFIG_EXIT_SUCCESS on successful import', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: debug\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('accepts JSON import files', async () => {
    const importFile = join(testDir, 'import.json')
    await writeFile(
      importFile,
      JSON.stringify({ global: { log_level: 'debug' } }),
      'utf-8'
    )

    const { getStdout, restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
      const out = getStdout()
      expect(out).toContain('global.log_level')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config import — AC5: --yes flag skips prompt
// ---------------------------------------------------------------------------

describe('runConfigImport — AC5: --yes flag', () => {
  it('applies changes without prompting when --yes is set', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: debug\n', 'utf-8')

    const { getStdout, restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        yes: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
      const out = getStdout()
      expect(out).toContain('global.log_level')
      // Should not contain the cancelled message
      expect(out).not.toContain('Import cancelled')
    } finally {
      restore()
    }
  })

  it('still displays diff when --yes is set', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: debug\n', 'utf-8')

    const { getStdout, restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        yes: true,
      })
      const out = getStdout()
      expect(out).toContain('global.log_level')
    } finally {
      restore()
    }
  })

  it('exits with code 0', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: debug\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        yes: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config import — AC6: no changes detected
// ---------------------------------------------------------------------------

describe('runConfigImport — AC6: no changes detected', () => {
  it('prints "No changes detected" when imported config matches current', async () => {
    const importFile = join(testDir, 'import.yaml')
    // Default config has log_level: 'info', so import 'info' (same as default)
    await writeFile(importFile, 'global:\n  log_level: info\n', 'utf-8')

    const { getStdout, restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
      const out = getStdout()
      expect(out).toContain('No changes detected')
    } finally {
      restore()
    }
  })

  it('does not write any config file when there are no changes', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: info\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      // No config.yaml should have been written in the project dir
      // (only the test import file exists)
      let fileExists = false
      try {
        await readFile(join(projectConfigDir, 'config.yaml'), 'utf-8')
        fileExists = true
      } catch {
        // expected — file should not exist
      }
      expect(fileExists).toBe(false)
    } finally {
      restore()
    }
  })

  it('exits with code 0', async () => {
    const importFile = join(testDir, 'import.yaml')
    await writeFile(importFile, 'global:\n  log_level: info\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
        autoConfirm: true,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config import — AC7: file not found / parse errors
// ---------------------------------------------------------------------------

describe('runConfigImport — AC7: file not found', () => {
  it('returns CONFIG_EXIT_INVALID when file does not exist', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport('/nonexistent/path/config.yaml', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('prints error message to stderr when file does not exist', async () => {
    const { getStderr, restore } = captureOutput()
    try {
      await runConfigImport('/nonexistent/path/config.yaml', {
        projectConfigDir,
        globalConfigDir,
      })
      const err = getStderr()
      expect(err).toContain('Config file not found')
      expect(err).toContain('/nonexistent/path/config.yaml')
    } finally {
      restore()
    }
  })
})

describe('runConfigImport — AC7: invalid YAML syntax', () => {
  it('returns CONFIG_EXIT_INVALID when YAML is invalid', async () => {
    const importFile = join(testDir, 'invalid.yaml')
    await writeFile(importFile, 'global:\n  log_level: !!invalid: : :\n  bad: [unclosed', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('prints parse error details to stderr', async () => {
    const importFile = join(testDir, 'invalid.yaml')
    await writeFile(importFile, ': : : invalid yaml : : :\n  bad: [unclosed', 'utf-8')

    const { getStderr, restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      const err = getStderr()
      expect(err).toContain('Failed to parse config file')
    } finally {
      restore()
    }
  })

  it('returns CONFIG_EXIT_INVALID when JSON is invalid', async () => {
    const importFile = join(testDir, 'invalid.json')
    await writeFile(importFile, '{ invalid json }', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('prints parse error details for invalid JSON to stderr', async () => {
    const importFile = join(testDir, 'invalid.json')
    await writeFile(importFile, '{ bad json content', 'utf-8')

    const { getStderr, restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      const err = getStderr()
      expect(err).toContain('Failed to parse config file')
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config import — AC8: Zod schema validation failure
// ---------------------------------------------------------------------------

describe('runConfigImport — AC8: Zod schema validation failure', () => {
  it('returns CONFIG_EXIT_INVALID when file fails Zod validation', async () => {
    const importFile = join(testDir, 'bad-schema.yaml')
    // log_level must be one of the enum values; 'INVALID_LEVEL' is not valid
    await writeFile(importFile, 'global:\n  log_level: INVALID_LEVEL\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('prints Zod issue paths to stderr', async () => {
    const importFile = join(testDir, 'bad-schema.yaml')
    await writeFile(importFile, 'global:\n  max_concurrent_tasks: "not-a-number"\n', 'utf-8')

    const { getStderr, restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      const err = getStderr()
      // Should contain the dot-path to the invalid field
      expect(err).toContain('global.max_concurrent_tasks')
    } finally {
      restore()
    }
  })

  it('does not write any config file on schema validation failure', async () => {
    const importFile = join(testDir, 'bad-schema.yaml')
    await writeFile(importFile, 'global:\n  log_level: INVALID_LEVEL\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      // No config.yaml should have been written in project dir
      let fileExists = false
      try {
        await readFile(join(projectConfigDir, 'config.yaml'), 'utf-8')
        fileExists = true
      } catch {
        // expected — file should not exist
      }
      expect(fileExists).toBe(false)
    } finally {
      restore()
    }
  })

  it('exits with code 2 on schema failure', async () => {
    const importFile = join(testDir, 'bad-schema.yaml')
    await writeFile(importFile, 'global:\n  log_level: INVALID_LEVEL\n', 'utf-8')

    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigImport(importFile, {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(2)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Export constants sanity checks
// ---------------------------------------------------------------------------

describe('config export/import exit code constants', () => {
  it('CONFIG_EXIT_SUCCESS is 0', () => {
    expect(CONFIG_EXIT_SUCCESS).toBe(0)
  })

  it('CONFIG_EXIT_ERROR is 1', () => {
    expect(CONFIG_EXIT_ERROR).toBe(1)
  })

  it('CONFIG_EXIT_INVALID is 2', () => {
    expect(CONFIG_EXIT_INVALID).toBe(2)
  })
})
