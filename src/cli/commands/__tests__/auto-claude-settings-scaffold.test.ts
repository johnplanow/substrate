/**
 * Unit tests for upgrade-safe .claude/settings.json and statusline.sh scaffolding.
 *
 * Tests scaffoldClaudeSettings (JSON merge), scaffoldStatuslineScript, and
 * their integration with runInitAction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

// Mock DatabaseAdapter
const mockAdapter = {
  query: vi.fn().mockResolvedValue([]),
  exec: vi.fn().mockResolvedValue(undefined),
  transaction: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('../../../persistence/adapter.js', () => ({
  createDatabaseAdapter: vi.fn(() => mockAdapter),
}))

vi.mock('../../../persistence/schema.js', () => ({
  initSchema: vi.fn().mockResolvedValue(undefined),
}))

// Mock PackLoader
const mockPackLoad = vi.fn()
vi.mock('../../../modules/methodology-pack/pack-loader.js', () => ({
  createPackLoader: vi.fn(() => ({
    load: mockPackLoad,
    discover: vi.fn(),
  })),
}))

// Mock git-root
vi.mock('../../../utils/git-root.js', () => ({
  resolveMainRepoRoot: vi.fn().mockImplementation((root: string) => Promise.resolve(root)),
}))

// Mock fs (sync)
const mockExistsSync = vi.fn()
const mockMkdirSync = vi.fn()
const mockCpSync = vi.fn()
const mockChmodSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
}))

// Mock fs/promises
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn().mockResolvedValue(undefined)
const mockAccess = vi.fn().mockRejectedValue(new Error('ENOENT'))

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  access: (...args: unknown[]) => mockAccess(...args),
}))

// Mock node:module createRequire for bmad-method resolution
const mockRequireResolve = vi.fn()
const mockRequireCall = vi.fn()

vi.mock('node:module', () => {
  return {
    createRequire: vi.fn(() => {
      const req = (id: string) => mockRequireCall(id)
      req.resolve = (id: string) => mockRequireResolve(id)
      return req
    }),
  }
})

// Mock remaining modules used by auto.ts (not tested here)
vi.mock('../../../modules/context-compiler/index.js', () => ({
  createContextCompiler: vi.fn(() => ({ compile: vi.fn(), registerTemplate: vi.fn() })),
}))
vi.mock('../../../modules/agent-dispatch/index.js', () => ({
  createDispatcher: vi.fn(() => ({
    dispatch: vi.fn(),
    shutdown: vi.fn(),
    getPending: vi.fn(() => 0),
    getRunning: vi.fn(() => 0),
  })),
}))
vi.mock('../../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: vi
      .fn()
      .mockResolvedValue({ registeredCount: 0, failedCount: 0, results: [] }),
  })),
}))
vi.mock('../../../modules/implementation-orchestrator/index.js', () => ({
  createImplementationOrchestrator: vi.fn(() => ({
    run: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getStatus: vi.fn(),
  })),
  discoverPendingStoryKeys: vi.fn(),
}))
vi.mock('../../../persistence/queries/decisions.js', () => ({
  createPipelineRun: vi.fn(),
  getLatestRun: vi.fn(),
  addTokenUsage: vi.fn(),
  getTokenUsageSummary: vi.fn(),
}))
vi.mock('../../../core/event-bus.js', () => ({
  createEventBus: vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), off: vi.fn() })),
}))

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import { scaffoldClaudeSettings, scaffoldStatuslineScript, runInitAction } from '../init.js'
import { SUBSTRATE_OWNED_SETTINGS_KEYS } from '../pipeline-shared.js'

const mockRegistry = {
  discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }),
} as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUSLINE_TEMPLATE = `#!/bin/bash
# Substrate AI — persistent status line
# Receives JSON on stdin with session metadata

input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null)
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' 2>/dev/null | cut -d. -f1)
COST=$(echo "$input" | jq -r '.session.cost // "0.00"' 2>/dev/null)
BRANCH=$(echo "$input" | jq -r '.git.branch // ""' 2>/dev/null)

BRANCH_PART=""
if [ -n "$BRANCH" ]; then
  BRANCH_PART=" | $BRANCH"
fi

echo "⚡ substrate-ai | $MODEL | ctx \${PCT}% | \\$\${COST}\${BRANCH_PART}"
`

function mockPack() {
  return {
    manifest: {
      name: 'bmad',
      version: '1.0.0',
      description: 'BMAD methodology pack',
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPrompt: vi.fn(),
    getConstraint: vi.fn(),
    getTemplate: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests: scaffoldStatuslineScript
// ---------------------------------------------------------------------------

describe('scaffoldStatuslineScript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
  })

  it('creates statusline.sh when .claude/ does not exist', async () => {
    mockExistsSync.mockReturnValue(false) // template not in dist
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('statusline.sh')) {
        return Promise.resolve(STATUSLINE_TEMPLATE)
      }
      return Promise.reject(new Error('ENOENT'))
    })

    await scaffoldStatuslineScript('/test/project')

    expect(mockMkdirSync).toHaveBeenCalledWith(join('/test/project', '.claude'), {
      recursive: true,
    })

    const writeCall = mockWriteFile.mock.calls.find(([p]) => String(p).includes('statusline.sh'))
    expect(writeCall).toBeDefined()
    expect(String(writeCall![1])).toContain('#!/bin/bash')
    expect(String(writeCall![1])).toContain('substrate-ai')
  })

  it('sets executable permissions on statusline.sh', async () => {
    mockExistsSync.mockReturnValue(false)
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('statusline.sh')) {
        return Promise.resolve(STATUSLINE_TEMPLATE)
      }
      return Promise.reject(new Error('ENOENT'))
    })

    await scaffoldStatuslineScript('/test/project')

    expect(mockChmodSync).toHaveBeenCalledWith(
      join('/test/project', '.claude', 'statusline.sh'),
      0o755
    )
  })

  it('always overwrites existing statusline.sh', async () => {
    mockExistsSync.mockReturnValue(false)
    mockReadFile.mockImplementation((path: string) => {
      if (String(path).includes('statusline.sh')) {
        return Promise.resolve(STATUSLINE_TEMPLATE)
      }
      return Promise.reject(new Error('ENOENT'))
    })

    // Call twice — both should write
    await scaffoldStatuslineScript('/test/project')
    await scaffoldStatuslineScript('/test/project')

    const writeCalls = mockWriteFile.mock.calls.filter(([p]) => String(p).includes('statusline.sh'))
    expect(writeCalls).toHaveLength(2)
  })

  it('handles missing template gracefully', async () => {
    mockExistsSync.mockReturnValue(false)
    mockReadFile.mockRejectedValue(new Error('ENOENT: template not found'))

    await scaffoldStatuslineScript('/test/project')

    const writeCalls = mockWriteFile.mock.calls.filter(([p]) => String(p).includes('statusline.sh'))
    expect(writeCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: scaffoldClaudeSettings
// ---------------------------------------------------------------------------

describe('scaffoldClaudeSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
  })

  it('creates settings.json from scratch when file does not exist', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    await scaffoldClaudeSettings('/test/project')

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const [writePath, writeContent] = mockWriteFile.mock.calls[0]
    expect(String(writePath)).toContain('settings.json')

    const parsed = JSON.parse(String(writeContent))
    expect(parsed.$schema).toBe('https://json.schemastore.org/claude-code-settings.json')
    expect(parsed.statusLine).toBeDefined()
    expect(parsed.statusLine.type).toBe('command')
    expect(parsed.statusLine.command).toContain('statusline.sh')
  })

  it('preserves user permissions when merging', async () => {
    const existing = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: {
        allow: ['Bash(npm test:*)'],
        deny: ['Bash(rm -rf:*)'],
      },
    }
    mockReadFile.mockResolvedValue(JSON.stringify(existing))

    await scaffoldClaudeSettings('/test/project')

    const [, writeContent] = mockWriteFile.mock.calls[0]
    const parsed = JSON.parse(String(writeContent))

    // User permissions preserved
    expect(parsed.permissions).toEqual(existing.permissions)
    // Substrate statusLine added
    expect(parsed.statusLine).toBeDefined()
    expect(parsed.statusLine.command).toContain('statusline.sh')
  })

  it('updates statusLine without touching other keys', async () => {
    const existing = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      statusLine: {
        type: 'command',
        command: 'echo "old status"',
        padding: 5,
      },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }
    mockReadFile.mockResolvedValue(JSON.stringify(existing))

    await scaffoldClaudeSettings('/test/project')

    const [, writeContent] = mockWriteFile.mock.calls[0]
    const parsed = JSON.parse(String(writeContent))

    // statusLine updated to substrate default
    expect(parsed.statusLine.command).toContain('statusline.sh')
    expect(parsed.statusLine.command).not.toContain('old status')
    // hooks preserved
    expect(parsed.hooks).toEqual(existing.hooks)
  })

  it('preserves custom $schema if present', async () => {
    const existing = {
      $schema: 'https://custom-schema.example.com/settings.json',
    }
    mockReadFile.mockResolvedValue(JSON.stringify(existing))

    await scaffoldClaudeSettings('/test/project')

    const [, writeContent] = mockWriteFile.mock.calls[0]
    const parsed = JSON.parse(String(writeContent))

    expect(parsed.$schema).toBe('https://custom-schema.example.com/settings.json')
  })

  it('adds $schema if missing', async () => {
    mockReadFile.mockResolvedValue('{}')

    await scaffoldClaudeSettings('/test/project')

    const [, writeContent] = mockWriteFile.mock.calls[0]
    const parsed = JSON.parse(String(writeContent))

    expect(parsed.$schema).toBe('https://json.schemastore.org/claude-code-settings.json')
  })

  it('handles malformed JSON gracefully', async () => {
    mockReadFile.mockResolvedValue('{ invalid json }}}')

    await scaffoldClaudeSettings('/test/project')

    // Should still write valid settings
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const [, writeContent] = mockWriteFile.mock.calls[0]
    const parsed = JSON.parse(String(writeContent))
    expect(parsed.statusLine).toBeDefined()
  })

  it('output is pretty-printed with trailing newline', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    await scaffoldClaudeSettings('/test/project')

    const [, writeContent] = mockWriteFile.mock.calls[0]
    const content = String(writeContent)

    // Trailing newline
    expect(content.endsWith('\n')).toBe(true)
    // 2-space indent (JSON.stringify with indent 2)
    expect(content).toContain('  "statusLine"')
    // Valid JSON
    expect(() => JSON.parse(content)).not.toThrow()
  })

  it('creates .claude/ directory if needed', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'))

    await scaffoldClaudeSettings('/test/project')

    expect(mockMkdirSync).toHaveBeenCalledWith(join('/test/project', '.claude'), {
      recursive: true,
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: SUBSTRATE_OWNED_SETTINGS_KEYS
// ---------------------------------------------------------------------------

describe('SUBSTRATE_OWNED_SETTINGS_KEYS', () => {
  it('includes statusLine', () => {
    expect(SUBSTRATE_OWNED_SETTINGS_KEYS).toContain('statusLine')
  })
})

// ---------------------------------------------------------------------------
// Tests: runInitAction integration
// ---------------------------------------------------------------------------

describe('runInitAction settings scaffold integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockRequireResolve.mockReturnValue('/fake/node_modules/bmad-method/package.json')
    mockRequireCall.mockReturnValue({ version: '6.0.3' })
    mockPackLoad.mockResolvedValue(mockPack())
    mockWriteFile.mockResolvedValue(undefined)

    // Default: templates readable, settings.json does not exist
    mockReadFile.mockImplementation((path: string) => {
      const p = String(path)
      if (p.includes('claude-md-substrate-section.md')) {
        return Promise.resolve(
          '<!-- substrate:start -->\n## Substrate Pipeline\n<!-- substrate:end -->\n'
        )
      }
      if (p.includes('statusline.sh')) {
        return Promise.resolve(STATUSLINE_TEMPLATE)
      }
      return Promise.reject(new Error('ENOENT'))
    })
  })

  it('auto init writes .claude/statusline.sh', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)

    const statuslineCall = mockWriteFile.mock.calls.find(([p]) =>
      String(p).includes('statusline.sh')
    )
    expect(statuslineCall).toBeDefined()
    expect(String(statuslineCall![1])).toContain('substrate-ai')

    stdoutWrite.mockRestore()
  })

  it('auto init writes .claude/settings.json with statusLine', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)

    const settingsCall = mockWriteFile.mock.calls.find(([p]) => String(p).includes('settings.json'))
    expect(settingsCall).toBeDefined()
    const parsed = JSON.parse(String(settingsCall![1]))
    expect(parsed.statusLine).toBeDefined()
    expect(parsed.statusLine.command).toContain('statusline.sh')

    stdoutWrite.mockRestore()
  })

  it('auto init with existing settings preserves permissions', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const existingSettings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: { allow: ['Bash(npm test:*)'] },
    }

    mockReadFile.mockImplementation((path: string) => {
      const p = String(path)
      if (p.includes('claude-md-substrate-section.md')) {
        return Promise.resolve(
          '<!-- substrate:start -->\n## Substrate Pipeline\n<!-- substrate:end -->\n'
        )
      }
      if (p.includes('statusline.sh')) {
        return Promise.resolve(STATUSLINE_TEMPLATE)
      }
      if (p.includes('settings.json')) {
        return Promise.resolve(JSON.stringify(existingSettings))
      }
      return Promise.reject(new Error('ENOENT'))
    })

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)

    const settingsCall = mockWriteFile.mock.calls.find(([p]) => String(p).includes('settings.json'))
    expect(settingsCall).toBeDefined()
    const parsed = JSON.parse(String(settingsCall![1]))
    expect(parsed.permissions).toEqual(existingSettings.permissions)
    expect(parsed.statusLine).toBeDefined()

    stdoutWrite.mockRestore()
  })
})
