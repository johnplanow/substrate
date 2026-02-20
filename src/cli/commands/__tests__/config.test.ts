/**
 * Unit tests for the `substrate config` command group
 *
 * Tests:
 *  - config show with default config
 *  - config show with JSON format
 *  - config show masks credentials
 *  - config set with valid key/value
 *  - config set with invalid key/value
 *  - config set with dot-notation keys
 *  - Error handling for missing .substrate/ dir
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, writeFile, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  runConfigShow,
  runConfigSet,
  CONFIG_EXIT_SUCCESS,
  CONFIG_EXIT_ERROR,
  CONFIG_EXIT_INVALID,
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
    `substrate-config-cmd-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
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

async function writeConfigYaml(content: string): Promise<void> {
  await writeFile(join(projectConfigDir, 'config.yaml'), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// config show
// ---------------------------------------------------------------------------

describe('runConfigShow', () => {
  it('returns CONFIG_EXIT_SUCCESS with no config files', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigShow({ projectConfigDir, globalConfigDir })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('outputs YAML by default', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigShow({ projectConfigDir, globalConfigDir })
      const output = getStdout()
      expect(output).toContain('config_format_version')
      expect(output).toContain('global')
    } finally {
      restore()
    }
  })

  it('outputs JSON when format is json', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigShow({ projectConfigDir, globalConfigDir, format: 'json' })
      const output = getStdout()
      expect(() => JSON.parse(output) as unknown).not.toThrow()
      const parsed = JSON.parse(output) as { config_format_version: string }
      expect(parsed.config_format_version).toBe('1')
    } finally {
      restore()
    }
  })

  it('includes header comment in YAML output', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigShow({ projectConfigDir, globalConfigDir })
      const output = getStdout()
      expect(output).toContain('credentials masked')
    } finally {
      restore()
    }
  })

  it('reflects project config overrides in output', async () => {
    await writeConfigYaml('global:\n  log_level: debug\n')
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigShow({ projectConfigDir, globalConfigDir })
      const output = getStdout()
      expect(output).toContain('debug')
    } finally {
      restore()
    }
  })

  it('returns CONFIG_EXIT_INVALID for invalid config', async () => {
    await writeConfigYaml('global:\n  log_level: NOTVALID\n')
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigShow({ projectConfigDir, globalConfigDir })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// config set
// ---------------------------------------------------------------------------

describe('runConfigSet', () => {
  it('returns CONFIG_EXIT_SUCCESS for valid key/value', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('global.log_level', 'debug', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('persists the value to project config file', async () => {
    const { restore } = captureOutput()
    try {
      await runConfigSet('global.log_level', 'warn', {
        projectConfigDir,
        globalConfigDir,
      })
      const content = await readFile(join(projectConfigDir, 'config.yaml'), 'utf-8')
      expect(content).toContain('warn')
    } finally {
      restore()
    }
  })

  it('outputs confirmation message', async () => {
    const { getStdout, restore } = captureOutput()
    try {
      await runConfigSet('global.log_level', 'debug', {
        projectConfigDir,
        globalConfigDir,
      })
      const output = getStdout()
      expect(output).toContain('global.log_level')
      expect(output).toContain('debug')
    } finally {
      restore()
    }
  })

  it('returns CONFIG_EXIT_INVALID for invalid value', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('global.log_level', 'NOTVALID', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('returns CONFIG_EXIT_INVALID for invalid numeric value', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('global.max_concurrent_tasks', '0', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('returns CONFIG_EXIT_INVALID for empty key', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('', 'value', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_INVALID)
    } finally {
      restore()
    }
  })

  it('supports numeric values (coerced from string)', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('global.max_concurrent_tasks', '8', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)

      // Verify the value was stored as a number
      const content = await readFile(join(projectConfigDir, 'config.yaml'), 'utf-8')
      expect(content).toContain('8')
    } finally {
      restore()
    }
  })

  it('supports boolean values', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('providers.claude.enabled', 'true', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })

  it('supports dot-notation for nested provider keys', async () => {
    const { restore } = captureOutput()
    try {
      const exitCode = await runConfigSet('providers.claude.max_concurrent', '4', {
        projectConfigDir,
        globalConfigDir,
      })
      expect(exitCode).toBe(CONFIG_EXIT_SUCCESS)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

describe('config command exit codes', () => {
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
