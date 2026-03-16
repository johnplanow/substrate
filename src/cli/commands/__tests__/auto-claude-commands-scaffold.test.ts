/**
 * Unit tests for .claude/commands/ scaffolding from bmad-method generators.
 *
 * Tests scaffoldClaudeCommands, scanBmadModules, and their integration
 * with runInitAction.
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
const mockReaddirSync = vi.fn()
const mockUnlinkSync = vi.fn()

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  cpSync: (...args: unknown[]) => mockCpSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
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

// Mock bmad-method generator instances
const mockCollectAgentArtifacts = vi.fn()
const mockAgentWriteDash = vi.fn()
const mockCollectWorkflowArtifacts = vi.fn()
const mockWorkflowWriteDash = vi.fn()
const mockCollectTaskToolArtifacts = vi.fn()
const mockTaskToolWriteDash = vi.fn()
const mockGenerateManifests = vi.fn()

// Mock node:module createRequire to return bmad-method generators
const mockRequireResolve = vi.fn()
const mockRequireCall = vi.fn()

vi.mock('node:module', () => {
  return {
    createRequire: vi.fn(() => {
      const req = (id: string) => {
        const s = String(id)
        if (s.includes('agent-command-generator')) {
          return {
            AgentCommandGenerator: vi.fn().mockImplementation(() => ({
              collectAgentArtifacts: mockCollectAgentArtifacts,
              writeDashArtifacts: mockAgentWriteDash,
            })),
          }
        }
        if (s.includes('workflow-command-generator')) {
          return {
            WorkflowCommandGenerator: vi.fn().mockImplementation(() => ({
              collectWorkflowArtifacts: mockCollectWorkflowArtifacts,
              writeDashArtifacts: mockWorkflowWriteDash,
            })),
          }
        }
        if (s.includes('task-tool-command-generator')) {
          return {
            TaskToolCommandGenerator: vi.fn().mockImplementation(() => ({
              collectTaskToolArtifacts: mockCollectTaskToolArtifacts,
              writeDashArtifacts: mockTaskToolWriteDash,
            })),
          }
        }
        if (s.includes('manifest-generator')) {
          return {
            ManifestGenerator: vi.fn().mockImplementation(() => ({
              generateManifests: mockGenerateManifests,
            })),
          }
        }
        if (s.includes('path-utils')) {
          return {
            toDashPath: (relativePath: string) => {
              // Minimal stub: strip extension, replace slashes with dashes, prepend bmad-
              const withoutExt = relativePath.replace(/\.(md|yaml|yml)$/i, '')
              return `bmad-${withoutExt.replace(/[/\\]/g, '-')}.md`
            },
          }
        }
        return mockRequireCall(id)
      }
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
    discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 0, failedCount: 0, results: [] }),
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
// Shared mock registry instance (runInitAction requires registry in options)
// ---------------------------------------------------------------------------

const mockRegistry = { discoverAndRegister: vi.fn().mockResolvedValue({ results: [], failedCount: 0 }) } as any

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  scaffoldClaudeCommands,
  scanBmadModules,
  resolveBmadMethodInstallerLibPath,
  runInitAction,
} from '../init.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const STATUSLINE_TEMPLATE = '#!/bin/bash\necho "substrate-ai"\n'

// ---------------------------------------------------------------------------
// Tests: resolveBmadMethodInstallerLibPath
// ---------------------------------------------------------------------------

describe('resolveBmadMethodInstallerLibPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns installer lib path when bmad-method is installed', () => {
    mockRequireResolve.mockReturnValue('/fake/node_modules/bmad-method/package.json')
    const result = resolveBmadMethodInstallerLibPath()
    expect(result).toBe(join('/fake/node_modules/bmad-method', 'tools', 'cli', 'installers', 'lib'))
  })

  it('returns null when bmad-method is not installed', () => {
    mockRequireResolve.mockImplementation(() => {
      throw new Error('MODULE_NOT_FOUND')
    })
    const result = resolveBmadMethodInstallerLibPath()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: scanBmadModules
// ---------------------------------------------------------------------------

describe('scanBmadModules', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns module names that have agents/ or workflows/ subdirs', () => {
    mockReaddirSync.mockReturnValue([
      { name: 'core', isDirectory: () => true },
      { name: 'bmm', isDirectory: () => true },
      { name: 'tea', isDirectory: () => true },
      { name: '_config', isDirectory: () => true },
    ])
    // existsSync: bmm has agents + workflows, tea has agents only
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('bmm/agents')) return true
      if (s.includes('bmm/workflows')) return true
      if (s.includes('bmm/tasks')) return false
      if (s.includes('tea/agents')) return true
      if (s.includes('tea/workflows')) return false
      if (s.includes('tea/tasks')) return false
      return false
    })

    const result = scanBmadModules('/test/_bmad')

    // Should exclude 'core' and '_config'
    expect(result).toContain('bmm')
    expect(result).toContain('tea')
    expect(result).not.toContain('core')
    expect(result).not.toContain('_config')
  })

  it('returns empty array when _bmad/ is not readable', () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    const result = scanBmadModules('/nonexistent/_bmad')
    expect(result).toEqual([])
  })

  it('skips directories without agents/, workflows/, or tasks/', () => {
    mockReaddirSync.mockReturnValue([
      { name: 'bmm', isDirectory: () => true },
      { name: 'empty-mod', isDirectory: () => true },
    ])
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('bmm/agents')) return true
      return false
    })

    const result = scanBmadModules('/test/_bmad')
    expect(result).toEqual(['bmm'])
  })

  it('skips non-directory entries', () => {
    mockReaddirSync.mockReturnValue([
      { name: 'config.yaml', isDirectory: () => false },
      { name: 'bmm', isDirectory: () => true },
    ])
    mockExistsSync.mockReturnValue(true)

    const result = scanBmadModules('/test/_bmad')
    expect(result).toEqual(['bmm'])
  })
})

// ---------------------------------------------------------------------------
// Tests: scaffoldClaudeCommands
// ---------------------------------------------------------------------------

describe('scaffoldClaudeCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireResolve.mockReturnValue('/fake/node_modules/bmad-method/package.json')
    mockRequireCall.mockReturnValue({ version: '6.0.3' })
    mockCollectAgentArtifacts.mockResolvedValue({ artifacts: [{ type: 'agent-launcher', name: 'pm' }] })
    mockAgentWriteDash.mockResolvedValue(5)
    mockCollectWorkflowArtifacts.mockResolvedValue({ artifacts: [{ type: 'workflow-command', name: 'dev-story' }] })
    mockWorkflowWriteDash.mockResolvedValue(10)
    mockCollectTaskToolArtifacts.mockResolvedValue({ artifacts: [], counts: { tasks: 0, tools: 0 } })
    mockTaskToolWriteDash.mockResolvedValue(3)
    mockGenerateManifests.mockResolvedValue({ workflows: 5, agents: 10, tasks: 3, tools: 0 })
    // _bmad/ exists, module scan returns bmm
    mockReaddirSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('_bmad') && !s.includes('.claude')) {
        return [
          { name: 'core', isDirectory: () => true },
          { name: 'bmm', isDirectory: () => true },
          { name: '_config', isDirectory: () => true },
        ]
      }
      // .claude/commands dir for clearBmadCommandFiles
      return []
    })
  })

  it('skips when _bmad/ does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'human')

    expect(mockCollectAgentArtifacts).not.toHaveBeenCalled()
    expect(mockCollectWorkflowArtifacts).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it('warns and skips when bmad-method is not installed', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).includes('_bmad')) return true
      return false
    })
    mockRequireResolve.mockImplementation(() => {
      throw new Error('MODULE_NOT_FOUND')
    })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'human')

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('bmad-method not found'),
    )
    expect(mockCollectAgentArtifacts).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it('suppresses warning in json output format when bmad-method missing', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).includes('_bmad')) return true
      return false
    })
    mockRequireResolve.mockImplementation(() => {
      throw new Error('MODULE_NOT_FOUND')
    })

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'json')

    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it('calls all three generators on happy path', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('_bmad')) return true
      if (s.includes('bmm/agents')) return true
      if (s.includes('bmm/workflows')) return true
      if (s.includes('bmm/tasks')) return false
      return false
    })

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'human')

    expect(mockGenerateManifests).toHaveBeenCalledWith(
      join('/test/project', '_bmad'),
      ['core', 'bmm'],
      [],
      { ides: ['claude-code'] },
    )
    expect(mockCollectAgentArtifacts).toHaveBeenCalledWith(
      join('/test/project', '_bmad'),
      ['bmm'],
    )
    expect(mockAgentWriteDash).toHaveBeenCalled()
    expect(mockCollectWorkflowArtifacts).toHaveBeenCalled()
    expect(mockWorkflowWriteDash).toHaveBeenCalled()
    expect(mockCollectTaskToolArtifacts).toHaveBeenCalled()
    expect(mockTaskToolWriteDash).toHaveBeenCalled()

    // Should report total count
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('Generated 18 Claude Code commands'),
    )
    stdoutSpy.mockRestore()
  })

  it('creates .claude/commands/ directory', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('_bmad')) return true
      if (s.includes('bmm/agents')) return true
      return false
    })

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'human')

    expect(mockMkdirSync).toHaveBeenCalledWith(
      join('/test/project', '.claude', 'commands'),
      { recursive: true },
    )
    stdoutSpy.mockRestore()
  })

  it('clears existing bmad-* files before regenerating', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('_bmad')) return true
      if (s.includes('bmm/agents')) return true
      return false
    })

    // Existing command files
    mockReaddirSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('.claude/commands') || s.includes('.claude\\commands')) {
        return ['bmad-agent-bmm-pm.md', 'bmad-bmm-dev-story.md', 'my-custom-command.md']
      }
      if (s.includes('_bmad')) {
        return [
          { name: 'core', isDirectory: () => true },
          { name: 'bmm', isDirectory: () => true },
          { name: '_config', isDirectory: () => true },
        ]
      }
      return []
    })

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'human')

    // Should delete bmad-* files but not my-custom-command.md
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      join('/test/project', '.claude', 'commands', 'bmad-agent-bmm-pm.md'),
    )
    expect(mockUnlinkSync).toHaveBeenCalledWith(
      join('/test/project', '.claude', 'commands', 'bmad-bmm-dev-story.md'),
    )
    // my-custom-command.md should NOT be deleted
    const unlinkPaths = mockUnlinkSync.mock.calls.map(([p]) => String(p))
    expect(unlinkPaths).not.toContain(
      expect.stringContaining('my-custom-command.md'),
    )
    stdoutSpy.mockRestore()
  })

  it('continues with agents when ManifestGenerator fails', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      const s = String(p)
      if (s.includes('_bmad')) return true
      if (s.includes('bmm/agents')) return true
      return false
    })
    mockGenerateManifests.mockRejectedValue(new Error('manifest parse error'))

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await scaffoldClaudeCommands('/test/project', 'human')

    // Agents should still be generated even though manifests failed
    expect(mockCollectAgentArtifacts).toHaveBeenCalled()
    expect(mockAgentWriteDash).toHaveBeenCalled()
    // Workflows/tasks also called (they'll return empty since no manifests)
    expect(mockCollectWorkflowArtifacts).toHaveBeenCalled()
    stdoutSpy.mockRestore()
  })

  it('handles generator error gracefully without failing init', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (String(p).includes('_bmad')) return true
      return false
    })
    mockCollectAgentArtifacts.mockRejectedValue(new Error('generator crash'))

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Should not throw
    await scaffoldClaudeCommands('/test/project', 'human')

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('.claude/commands/ generation failed'),
    )
    stderrSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Tests: runInitAction integration
// ---------------------------------------------------------------------------

describe('runInitAction commands scaffold integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockRequireResolve.mockReturnValue('/fake/node_modules/bmad-method/package.json')
    mockRequireCall.mockReturnValue({ version: '6.0.3' })
    mockPackLoad.mockResolvedValue(mockPack())
    mockWriteFile.mockResolvedValue(undefined)
    mockCollectAgentArtifacts.mockResolvedValue({ artifacts: [] })
    mockAgentWriteDash.mockResolvedValue(0)
    mockCollectWorkflowArtifacts.mockResolvedValue({ artifacts: [] })
    mockWorkflowWriteDash.mockResolvedValue(0)
    mockCollectTaskToolArtifacts.mockResolvedValue({ artifacts: [], counts: { tasks: 0, tools: 0 } })
    mockTaskToolWriteDash.mockResolvedValue(0)
    mockGenerateManifests.mockResolvedValue({})
    mockReaddirSync.mockReturnValue([])

    mockReadFile.mockImplementation((path: string) => {
      const p = String(path)
      if (p.includes('claude-md-substrate-section.md')) {
        return Promise.resolve('<!-- substrate:start -->\n## Substrate Pipeline\n<!-- substrate:end -->\n')
      }
      if (p.includes('statusline.sh')) {
        return Promise.resolve(STATUSLINE_TEMPLATE)
      }
      return Promise.reject(new Error('ENOENT'))
    })
  })

  it('auto init calls scaffoldClaudeCommands and succeeds', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    expect(exitCode).toBe(0)

    // Verify that at least the mkdirSync for .claude/commands was called
    const mkdirCalls = mockMkdirSync.mock.calls.map(([p]) => String(p))
    expect(mkdirCalls).toContain(join('/test/project', '.claude', 'commands'))

    stdoutSpy.mockRestore()
  })

  it('auto init succeeds even when commands scaffold fails', async () => {
    mockCollectAgentArtifacts.mockRejectedValue(new Error('generator crash'))

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runInitAction({
      pack: 'bmad',
      projectRoot: '/test/project',
      outputFormat: 'human',
      yes: true,
      registry: mockRegistry,
    })

    // Init should still succeed — commands failure is non-fatal
    expect(exitCode).toBe(0)

    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })
})
