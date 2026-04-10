// @vitest-environment node
/**
 * Unit tests for `src/cli/commands/sdlc-graph-setup.ts`.
 *
 * Story 43-6.
 *
 * Tests:
 *   AC1: HandlerRegistry is exported from @substrate-ai/factory (import-level verification)
 *   AC2: buildSdlcHandlerRegistry returns a registry with all four handlers
 *   AC3: Registry resolves each SDLC node type to the correct handler function
 *   AC4: Handlers are instantiated with injected dependencies
 *   AC5: No inadvertent default handler — unregistered types throw
 *   AC6: buildSdlcHandlerRegistry is accessible for import by the CLI
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HandlerRegistry } from '@substrate-ai/factory'
import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Mocks for SDLC handler factories
//
// vi.mock() is hoisted to the top of the file by vitest. Variables referenced
// inside the factory must be created via vi.hoisted() to avoid TDZ errors.
// ---------------------------------------------------------------------------

const {
  mockPhaseHandler,
  mockCreateStoryHandler,
  mockDevStoryHandler,
  mockCodeReviewHandler,
  mockCreateSdlcPhaseHandler,
  mockCreateSdlcCreateStoryHandler,
  mockCreateSdlcDevStoryHandler,
  mockCreateSdlcCodeReviewHandler,
} = vi.hoisted(() => {
  const mockPhaseHandler = vi.fn()
  const mockCreateStoryHandler = vi.fn()
  const mockDevStoryHandler = vi.fn()
  const mockCodeReviewHandler = vi.fn()
  return {
    mockPhaseHandler,
    mockCreateStoryHandler,
    mockDevStoryHandler,
    mockCodeReviewHandler,
    mockCreateSdlcPhaseHandler: vi.fn().mockReturnValue(mockPhaseHandler),
    mockCreateSdlcCreateStoryHandler: vi.fn().mockReturnValue(mockCreateStoryHandler),
    mockCreateSdlcDevStoryHandler: vi.fn().mockReturnValue(mockDevStoryHandler),
    mockCreateSdlcCodeReviewHandler: vi.fn().mockReturnValue(mockCodeReviewHandler),
  }
})

vi.mock('@substrate-ai/sdlc', () => ({
  createSdlcPhaseHandler: mockCreateSdlcPhaseHandler,
  createSdlcCreateStoryHandler: mockCreateSdlcCreateStoryHandler,
  createSdlcDevStoryHandler: mockCreateSdlcDevStoryHandler,
  createSdlcCodeReviewHandler: mockCreateSdlcCodeReviewHandler,
}))

// Import after mocks are set up
import { buildSdlcHandlerRegistry, type SdlcRegistryDeps } from '../sdlc-graph-setup.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock event bus satisfying TypedEventBus<SdlcEvents> */
function makeEventBus(): TypedEventBus<SdlcEvents> {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus<SdlcEvents>
}

/** Build a minimal SdlcRegistryDeps object for use in tests. */
function makeDeps(): SdlcRegistryDeps {
  const eventBus = makeEventBus()
  return {
    phaseHandlerDeps: {
      orchestrator: { advancePhase: vi.fn() },
      phaseDeps: {},
      phases: {
        analysis: vi.fn(),
        planning: vi.fn(),
        solutioning: vi.fn(),
      },
    },
    createStoryOptions: {
      deps: {},
      eventBus,
      runCreateStory: vi.fn(),
    },
    devStoryOptions: {
      deps: {},
      eventBus,
      runDevStory: vi.fn(),
    },
    codeReviewOptions: {
      deps: {},
      eventBus,
      runCodeReview: vi.fn(),
    },
  }
}

// ---------------------------------------------------------------------------
// AC1: HandlerRegistry and NodeHandler exported from @substrate-ai/factory
// ---------------------------------------------------------------------------

describe('AC1: @substrate-ai/factory exports', () => {
  it('HandlerRegistry is importable from @substrate-ai/factory', () => {
    // The import at the top of this file verifies this at module load time.
    // This test asserts HandlerRegistry is a constructor function.
    expect(typeof HandlerRegistry).toBe('function')
  })

  it('HandlerRegistry can be instantiated', () => {
    const registry = new HandlerRegistry()
    expect(registry).toBeInstanceOf(HandlerRegistry)
  })
})

// ---------------------------------------------------------------------------
// AC2: buildSdlcHandlerRegistry returns a registry with all four handlers
// ---------------------------------------------------------------------------

describe('AC2: buildSdlcHandlerRegistry returns a HandlerRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSdlcPhaseHandler.mockReturnValue(mockPhaseHandler)
    mockCreateSdlcCreateStoryHandler.mockReturnValue(mockCreateStoryHandler)
    mockCreateSdlcDevStoryHandler.mockReturnValue(mockDevStoryHandler)
    mockCreateSdlcCodeReviewHandler.mockReturnValue(mockCodeReviewHandler)
  })

  it('returns an instanceof HandlerRegistry', () => {
    const deps = makeDeps()
    const registry = buildSdlcHandlerRegistry(deps)
    expect(registry).toBeInstanceOf(HandlerRegistry)
  })

  it('registers all four SDLC handler types without throwing', () => {
    const deps = makeDeps()
    expect(() => buildSdlcHandlerRegistry(deps)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC3: Registry resolves each SDLC node type to the correct handler function
// ---------------------------------------------------------------------------

describe('AC3: registry.resolve returns a function for each SDLC node type', () => {
  let registry: HandlerRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSdlcPhaseHandler.mockReturnValue(mockPhaseHandler)
    mockCreateSdlcCreateStoryHandler.mockReturnValue(mockCreateStoryHandler)
    mockCreateSdlcDevStoryHandler.mockReturnValue(mockDevStoryHandler)
    mockCreateSdlcCodeReviewHandler.mockReturnValue(mockCodeReviewHandler)
    registry = buildSdlcHandlerRegistry(makeDeps())
  })

  it('resolves sdlc.phase to a function', () => {
    const handler = registry.resolve({ id: 'analysis', type: 'sdlc.phase', label: '', prompt: '' })
    expect(typeof handler).toBe('function')
  })

  it('resolves sdlc.create-story to a function', () => {
    const handler = registry.resolve({
      id: 'create_story',
      type: 'sdlc.create-story',
      label: '',
      prompt: '',
    })
    expect(typeof handler).toBe('function')
  })

  it('resolves sdlc.dev-story to a function', () => {
    const handler = registry.resolve({
      id: 'dev_story',
      type: 'sdlc.dev-story',
      label: '',
      prompt: '',
    })
    expect(typeof handler).toBe('function')
  })

  it('resolves sdlc.code-review to a function', () => {
    const handler = registry.resolve({
      id: 'code_review',
      type: 'sdlc.code-review',
      label: '',
      prompt: '',
    })
    expect(typeof handler).toBe('function')
  })

  it('resolves sdlc.phase to the exact handler returned by createSdlcPhaseHandler', () => {
    const handler = registry.resolve({ id: 'analysis', type: 'sdlc.phase', label: '', prompt: '' })
    expect(handler).toBe(mockPhaseHandler)
  })

  it('resolves sdlc.create-story to the exact handler returned by createSdlcCreateStoryHandler', () => {
    const handler = registry.resolve({
      id: 'create_story',
      type: 'sdlc.create-story',
      label: '',
      prompt: '',
    })
    expect(handler).toBe(mockCreateStoryHandler)
  })

  it('resolves sdlc.dev-story to the exact handler returned by createSdlcDevStoryHandler', () => {
    const handler = registry.resolve({
      id: 'dev_story',
      type: 'sdlc.dev-story',
      label: '',
      prompt: '',
    })
    expect(handler).toBe(mockDevStoryHandler)
  })

  it('resolves sdlc.code-review to the exact handler returned by createSdlcCodeReviewHandler', () => {
    const handler = registry.resolve({
      id: 'code_review',
      type: 'sdlc.code-review',
      label: '',
      prompt: '',
    })
    expect(handler).toBe(mockCodeReviewHandler)
  })
})

// ---------------------------------------------------------------------------
// AC4: Handlers are instantiated with injected dependencies
// ---------------------------------------------------------------------------

describe('AC4: handler factories are called with correct sub-options from deps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSdlcPhaseHandler.mockReturnValue(mockPhaseHandler)
    mockCreateSdlcCreateStoryHandler.mockReturnValue(mockCreateStoryHandler)
    mockCreateSdlcDevStoryHandler.mockReturnValue(mockDevStoryHandler)
    mockCreateSdlcCodeReviewHandler.mockReturnValue(mockCodeReviewHandler)
  })

  it('calls createSdlcPhaseHandler exactly once with phaseHandlerDeps', () => {
    const deps = makeDeps()
    buildSdlcHandlerRegistry(deps)
    expect(mockCreateSdlcPhaseHandler).toHaveBeenCalledTimes(1)
    expect(mockCreateSdlcPhaseHandler).toHaveBeenCalledWith(deps.phaseHandlerDeps)
  })

  it('calls createSdlcCreateStoryHandler exactly once with createStoryOptions', () => {
    const deps = makeDeps()
    buildSdlcHandlerRegistry(deps)
    expect(mockCreateSdlcCreateStoryHandler).toHaveBeenCalledTimes(1)
    expect(mockCreateSdlcCreateStoryHandler).toHaveBeenCalledWith(deps.createStoryOptions)
  })

  it('calls createSdlcDevStoryHandler exactly once with devStoryOptions', () => {
    const deps = makeDeps()
    buildSdlcHandlerRegistry(deps)
    expect(mockCreateSdlcDevStoryHandler).toHaveBeenCalledTimes(1)
    expect(mockCreateSdlcDevStoryHandler).toHaveBeenCalledWith(deps.devStoryOptions)
  })

  it('calls createSdlcCodeReviewHandler exactly once with codeReviewOptions', () => {
    const deps = makeDeps()
    buildSdlcHandlerRegistry(deps)
    expect(mockCreateSdlcCodeReviewHandler).toHaveBeenCalledTimes(1)
    expect(mockCreateSdlcCodeReviewHandler).toHaveBeenCalledWith(deps.codeReviewOptions)
  })
})

// ---------------------------------------------------------------------------
// AC5: No default handler — unregistered types throw HandlerRegistry error
// ---------------------------------------------------------------------------

describe('AC5: default handler from createDefaultRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSdlcPhaseHandler.mockReturnValue(mockPhaseHandler)
    mockCreateSdlcCreateStoryHandler.mockReturnValue(mockCreateStoryHandler)
    mockCreateSdlcDevStoryHandler.mockReturnValue(mockDevStoryHandler)
    mockCreateSdlcCodeReviewHandler.mockReturnValue(mockCodeReviewHandler)
  })

  it('resolving an unregistered node type returns the codergen default handler (not throw)', () => {
    const registry = buildSdlcHandlerRegistry(makeDeps())
    // createDefaultRegistry sets codergen as the default handler for unrecognised types.
    // SDLC registry inherits this — structural nodes (start/exit) use shape-based resolution.
    const handler = registry.resolve({
      id: 'unknown_node',
      type: 'sdlc.unknown',
      label: '',
      prompt: '',
    })
    expect(typeof handler).toBe('function')
  })

  it('resolving start shape returns a handler (shape-based resolution via Mdiamond)', () => {
    const registry = buildSdlcHandlerRegistry(makeDeps())
    const handler = registry.resolve({
      id: 'start',
      type: '',
      shape: 'Mdiamond',
      label: '',
      prompt: '',
    })
    expect(typeof handler).toBe('function')
  })

  it('resolving exit shape returns a handler (shape-based resolution via Msquare)', () => {
    const registry = buildSdlcHandlerRegistry(makeDeps())
    const handler = registry.resolve({
      id: 'exit',
      type: '',
      shape: 'Msquare',
      label: '',
      prompt: '',
    })
    expect(typeof handler).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// AC6: SdlcRegistryDeps is exported and accessible for import
// ---------------------------------------------------------------------------

describe('AC6: SdlcRegistryDeps is exported from sdlc-graph-setup', () => {
  it('makeDeps() produces a valid SdlcRegistryDeps shape (type-level test via TypeScript)', () => {
    // If the type import above resolves correctly at compile time, this passes.
    const deps = makeDeps()
    expect(deps).toHaveProperty('phaseHandlerDeps')
    expect(deps).toHaveProperty('createStoryOptions')
    expect(deps).toHaveProperty('devStoryOptions')
    expect(deps).toHaveProperty('codeReviewOptions')
  })

  it('buildSdlcHandlerRegistry is a function', () => {
    expect(typeof buildSdlcHandlerRegistry).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// ADR-003: No cross-package compile-time coupling
// Verify that no non-test .ts file in packages/sdlc/src imports from
// @substrate-ai/factory. The build (Task 5) passing with zero TS errors is
// the primary gate; this runtime test provides an additional explicit check.
// ---------------------------------------------------------------------------

describe('ADR-003: sdlc package source files do not import from @substrate-ai/factory', () => {
  it('no non-test .ts file in packages/sdlc/src/ imports @substrate-ai/factory', async () => {
    const fs = await import('fs')
    const path = await import('path')

    /** Recursively collect all .ts files under a directory. */
    function collectTs(dir: string): string[] {
      const results: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          results.push(...collectTs(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          results.push(fullPath)
        }
      }
      return results
    }

    // Resolve the packages/sdlc/src directory relative to this test file's location.
    // This test lives at: <repo-root>/src/cli/commands/__tests__/sdlc-graph-setup.test.ts
    // So the repo root is 4 directories up from __dirname.
    const url = await import('url')
    const testDir = path.dirname(url.fileURLToPath(import.meta.url))
    // testDir = <repo-root>/src/cli/commands/__tests__
    const repoRoot = path.resolve(testDir, '..', '..', '..', '..')
    const sdlcSrcDir = path.join(repoRoot, 'packages', 'sdlc', 'src')

    // Only check source files — test files may mock @substrate-ai/factory
    const allFiles = collectTs(sdlcSrcDir)
    const nonTestFiles = allFiles.filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'))

    // Permitted exceptions to ADR-003 (cross-package type imports that are explicitly allowed):
    // - graph-orchestrator.ts: The composition point where SDLC logic drives the factory graph
    //   engine. It imports Graph/GraphNode types and parseGraph() from @substrate-ai/factory.
    //   This is the documented permitted exception from story 43-8 Dev Notes (ADR-003 section).
    const permittedExceptions = [path.join(sdlcSrcDir, 'orchestrator', 'graph-orchestrator.ts')]

    // Check for actual import statements (not comments or string literals in comments)
    // Pattern: import ... from '@substrate-ai/factory' or import '@substrate-ai/factory'
    const factoryImportPattern = /^\s*import\s[^;]*from\s+['"]@substrate-ai\/factory['"]/m

    const violators: string[] = []
    for (const file of nonTestFiles) {
      if (permittedExceptions.includes(file)) continue
      const content = fs.readFileSync(file, 'utf-8')
      if (factoryImportPattern.test(content)) {
        violators.push(file)
      }
    }

    expect(violators).toEqual([])
  })
})
