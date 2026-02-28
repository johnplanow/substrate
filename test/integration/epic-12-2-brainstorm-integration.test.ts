/**
 * Epic 12.2 — Brainstorm Command
 * Cross-Story Integration Tests
 *
 * Covers integration gaps between:
 *   - Story 12-3: brainstorm.ts command implementation
 *   - Story 12-4: CLI registration in src/cli/index.ts
 *
 * Gaps addressed:
 *   Gap 1: createProgram() in index.ts registers brainstorm (never tested directly)
 *   Gap 2: AC3 (12-4) — substrate --help lists brainstorm with description
 *   Gap 3: AC3 (12-4) — substrate brainstorm --help shows all options including --output-path
 *   Gap 4: AC6 (12-4) — version parameter propagation to registerBrainstormCommand
 *   Gap 5: saveSessionToDisk uses projectRoot correctly as file output directory
 *   Gap 6: !wrap with empty session does not write a file (no turns recorded)
 *   Gap 7: --existing flag with missing files warns but session still starts
 *   Gap 8: generateConceptFile rawSummary separator between turns
 *   Gap 9: dispatchToPersonas default stub does not throw (no LLM injected)
 *   Gap 10: formatConceptFileAsMarkdown includes Session ID in rendered output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Mocks — fs/promises, readline, logger
// Must be declared before any dynamic imports that reference these modules.
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockAccess = vi.fn()

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  access: (...args: unknown[]) => mockAccess(...args),
}))

const mockRlOn = vi.fn()
const mockRlClose = vi.fn()
const mockRlInterface = {
  on: mockRlOn,
  close: mockRlClose,
}

vi.mock('readline', () => ({
  createInterface: vi.fn(() => mockRlInterface),
}))

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  registerBrainstormCommand,
  generateConceptFile,
  formatConceptFileAsMarkdown,
  saveSessionToDisk,
  dispatchToPersonas,
  runBrainstormSession,
  detectBrainstormContext,
  loadAmendmentContextDocuments,
} from '../../src/cli/commands/brainstorm.js'
import type {
  BrainstormSession,
  BrainstormTurn,
  PersonaResponse,
  ConceptFile,
} from '../../src/cli/commands/brainstorm.js'
import { createProgram } from '../../src/cli/index.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<BrainstormSession> = {}): BrainstormSession {
  return {
    sessionId: 'integration-session-001',
    startedAt: new Date('2026-02-22T14:00:00Z'),
    isAmendment: false,
    turns: [],
    ...overrides,
  }
}

function makeTurn(userInput = 'We need a new feature', personas: PersonaResponse[] = []): BrainstormTurn {
  return {
    timestamp: new Date('2026-02-22T14:01:00Z'),
    userInput,
    personas:
      personas.length > 0
        ? personas
        : [
            { name: 'Pragmatic Engineer', response: 'Engineering response.' },
            { name: 'Product Thinker', response: 'Product response.' },
            { name: "Devil's Advocate", response: 'Challenge the assumption.' },
          ],
  }
}

// ---------------------------------------------------------------------------
// Gap 1: createProgram() registers brainstorm command (12-4 AC1 + AC2)
// Story 12-3 tests only registerBrainstormCommand in isolation.
// This tests the actual CLI entry point wiring.
// ---------------------------------------------------------------------------

describe('Gap 1: createProgram() registers brainstorm command (12-4 AC1 + AC2)', () => {
  it('createProgram includes brainstorm in the registered command list', async () => {
    const program = await createProgram()
    const commandNames = program.commands.map((c) => c.name())
    expect(commandNames).toContain('brainstorm')
  })

  it('createProgram registers brainstorm alongside existing commands (no conflicts)', async () => {
    const program = await createProgram()
    const commandNames = program.commands.map((c) => c.name())

    // Both auto and brainstorm must be present — verifies no regression (12-4 AC5)
    expect(commandNames).toContain('auto')
    expect(commandNames).toContain('brainstorm')
  })

  it('each registered command name is unique — no duplicate registrations', async () => {
    const program = await createProgram()
    const commandNames = program.commands.map((c) => c.name())
    const uniqueNames = new Set(commandNames)
    expect(uniqueNames.size).toBe(commandNames.length)
  })
})

// ---------------------------------------------------------------------------
// Gap 2: substrate --help lists brainstorm (12-4 AC4)
// No existing test calls helpInformation() on the full program from createProgram().
// ---------------------------------------------------------------------------

describe('Gap 2: substrate --help lists brainstorm command (12-4 AC4)', () => {
  it('top-level help includes brainstorm in command listing', async () => {
    const program = await createProgram()
    program.exitOverride() // prevent process.exit during tests
    const helpText = program.helpInformation()
    expect(helpText).toContain('brainstorm')
  })
})

// ---------------------------------------------------------------------------
// Gap 3: substrate brainstorm --help shows all required options (12-4 AC3)
// Story 12-3 tests options exist; this tests they appear in full help output.
// ---------------------------------------------------------------------------

describe('Gap 3: brainstorm --help output shows all required options (12-4 AC3)', () => {
  let brCmd: Command | undefined

  beforeEach(async () => {
    const program = await createProgram()
    brCmd = program.commands.find((c) => c.name() === 'brainstorm')
  })

  it('brainstorm command has a description referencing brainstorm or ideation', () => {
    expect(brCmd).toBeDefined()
    expect(brCmd!.description()).toMatch(/brainstorm/i)
  })

  it('brainstorm --help includes --existing option', () => {
    expect(brCmd).toBeDefined()
    const helpText = brCmd!.helpInformation()
    expect(helpText).toContain('--existing')
  })

  it('brainstorm --help includes --project-root option', () => {
    expect(brCmd).toBeDefined()
    const helpText = brCmd!.helpInformation()
    expect(helpText).toContain('--project-root')
  })

  it('brainstorm --help includes --output-path option', () => {
    // This option is defined in 12-3 but not explicitly verified in 12-4 AC3.
    // Verifying it appears closes the documentation gap.
    expect(brCmd).toBeDefined()
    const helpText = brCmd!.helpInformation()
    expect(helpText).toContain('--output-path')
  })

  it('brainstorm --help references interactive session commands (!wrap, !quit, !help)', () => {
    expect(brCmd).toBeDefined()
    const desc = brCmd!.description()
    expect(desc).toContain('!wrap')
    expect(desc).toContain('!quit')
    expect(desc).toContain('!help')
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Version parameter propagation (12-4 AC6)
// registerBrainstormCommand accepts version; createProgram passes it.
// Verify the command does not crash when version is passed.
// ---------------------------------------------------------------------------

describe('Gap 4: Version parameter propagation (12-4 AC6)', () => {
  it('registerBrainstormCommand does not throw when version is passed', () => {
    const program = new Command()
    expect(() => registerBrainstormCommand(program, '1.2.3')).not.toThrow()
  })

  it('registerBrainstormCommand does not throw when version and projectRoot are passed', () => {
    const program = new Command()
    expect(() => registerBrainstormCommand(program, '1.2.3', '/some/project/root')).not.toThrow()
  })

  it('registerBrainstormCommand with version still registers the brainstorm command', () => {
    const program = new Command()
    registerBrainstormCommand(program, '2.0.0', '/some/root')
    const commandNames = program.commands.map((c) => c.name())
    expect(commandNames).toContain('brainstorm')
  })
})

// ---------------------------------------------------------------------------
// Gap 5: saveSessionToDisk uses projectRoot as output directory (12-3 AC6)
// Individual tests verify the path contains 'brainstorm-session-', but none
// verify the projectRoot is used as the parent directory in the file path.
// ---------------------------------------------------------------------------

describe('Gap 5: saveSessionToDisk places file inside projectRoot (12-3 AC6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteFile.mockResolvedValue(undefined)
  })

  it('output file path starts with projectRoot when no outputPath provided', async () => {
    const session = makeSession({ turns: [makeTurn()] })
    const filePath = await saveSessionToDisk(session, '/my/project/root')

    expect(filePath).toContain('/my/project/root')
    expect(filePath).toMatch(/\/my\/project\/root\/brainstorm-session-/)
  })

  it('output filename ends with .md extension', async () => {
    const session = makeSession({ turns: [makeTurn()] })
    const filePath = await saveSessionToDisk(session, '/project')

    expect(filePath).toMatch(/\.md$/)
  })

  it('custom outputPath overrides projectRoot directory entirely', async () => {
    const session = makeSession({ turns: [makeTurn()] })
    const filePath = await saveSessionToDisk(session, '/project', '/custom/output/file.md')

    expect(filePath).toBe('/custom/output/file.md')
    // Verify writeFile was called with the custom path
    expect(mockWriteFile.mock.calls[0][0]).toBe('/custom/output/file.md')
  })

  it('writeFile is called with the same path returned by saveSessionToDisk', async () => {
    const session = makeSession({ turns: [makeTurn()] })
    const filePath = await saveSessionToDisk(session, '/project/root')

    expect(mockWriteFile.mock.calls[0][0]).toBe(filePath)
  })
})

// ---------------------------------------------------------------------------
// Gap 6: !wrap with empty session (no turns) does not write concept file (12-3 AC4)
// Existing tests use !wrap after adding a turn. This tests the zero-turn edge case.
// ---------------------------------------------------------------------------

describe('Gap 6: !wrap with zero turns does not write a file (12-3 AC4 edge case)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockWriteFile.mockResolvedValue(undefined)
    mockAccess.mockRejectedValue(new Error('ENOENT'))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('!wrap with no turns does not call writeFile', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    // Immediately wrap without any turns
    for (const handler of lineHandlers) {
      handler('!wrap')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('!wrap with no turns outputs a message indicating no concept file was generated', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    for (const handler of lineHandlers) {
      handler('!wrap')
    }

    await sessionPromise

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toMatch(/No turns recorded|Concept file not generated/i)
  })
})

// ---------------------------------------------------------------------------
// Gap 7: --existing with missing files warns but session starts (12-3 AC2 + AC8)
// The individual AC8 test verifies warning text; this tests the full session
// starts and REPL becomes active even when both files are missing.
// ---------------------------------------------------------------------------

describe('Gap 7: --existing flag with missing documents still starts REPL (12-3 AC2 + AC8)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockAccess.mockRejectedValue(new Error('ENOENT')) // both files missing
    mockWriteFile.mockResolvedValue(undefined)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('session starts successfully (exit code 0) when --existing but files are absent', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: true },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    await new Promise((r) => setTimeout(r, 10))

    for (const handler of lineHandlers) {
      handler('!quit')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)
  })

  it('welcome message still appears when --existing but no files found', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: true },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    await new Promise((r) => setTimeout(r, 10))

    for (const handler of lineHandlers) {
      handler('!quit')
    }

    await sessionPromise

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toContain('Substrate Brainstorm Session')
  })
})

// ---------------------------------------------------------------------------
// Gap 8: generateConceptFile rawSummary includes turn separator (12-3 AC5)
// No existing test verifies multi-turn sessions produce correct separators.
// ---------------------------------------------------------------------------

describe('Gap 8: generateConceptFile rawSummary with multiple turns (12-3 AC5)', () => {
  it('rawSummary includes separator between turns for multi-turn sessions', () => {
    const session = makeSession({
      turns: [
        makeTurn('First idea'),
        makeTurn('Second idea'),
        makeTurn('Third idea'),
      ],
    })
    const concept = generateConceptFile(session)

    // Multi-turn sessions should have separators between turns
    expect(concept.rawSummary).toContain('---')
    // All user inputs should appear
    expect(concept.rawSummary).toContain('First idea')
    expect(concept.rawSummary).toContain('Second idea')
    expect(concept.rawSummary).toContain('Third idea')
  })

  it('rawSummary contains all 3 persona names for each turn', () => {
    const session = makeSession({ turns: [makeTurn('Test'), makeTurn('Test 2')] })
    const concept = generateConceptFile(session)

    // Each persona should appear (at minimum once per turn, so at least twice)
    const engineerCount = (concept.rawSummary.match(/Pragmatic Engineer/g) ?? []).length
    const productCount = (concept.rawSummary.match(/Product Thinker/g) ?? []).length
    const advocateCount = (concept.rawSummary.match(/Devil's Advocate/g) ?? []).length

    expect(engineerCount).toBeGreaterThanOrEqual(2)
    expect(productCount).toBeGreaterThanOrEqual(2)
    expect(advocateCount).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Gap 9: dispatchToPersonas default stub behavior (no LLM injected) (12-3 AC3)
// Existing test checks length=3; this also verifies names and response format.
// ---------------------------------------------------------------------------

describe('Gap 9: dispatchToPersonas default stub returns named responses (12-3 AC3)', () => {
  it('default stub returns responses with correct persona names', async () => {
    const result = await dispatchToPersonas('test idea', {})

    const names = result.map((r) => r.name)
    expect(names).toContain('Pragmatic Engineer')
    expect(names).toContain('Product Thinker')
    expect(names).toContain("Devil's Advocate")
  })

  it('default stub includes the user prompt text in each response (truncated)', async () => {
    const result = await dispatchToPersonas('a unique prompt string here', {})

    // Stub response format: "[PersonaName response to: "..."]"
    for (const r of result) {
      expect(r.response).toContain('a unique prompt string here'.slice(0, 30))
    }
  })

  it('default stub does not call any external service (response contains stub marker)', async () => {
    const result = await dispatchToPersonas('test', {})

    for (const r of result) {
      // Stub responses contain brackets indicating they are placeholders
      expect(r.response).toMatch(/\[.*\]/)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 10: formatConceptFileAsMarkdown Session ID in rendered output (12-3 AC5+AC6)
// Verifies the full markdown output roundtrip from session → concept → markdown.
// ---------------------------------------------------------------------------

describe('Gap 10: Full concept file roundtrip — session → generateConceptFile → formatConceptFileAsMarkdown (12-3 AC5)', () => {
  it('rendered markdown contains the session ID from the original session', () => {
    const session = makeSession({
      sessionId: 'unique-roundtrip-id-xyz-789',
      turns: [makeTurn('A product idea')],
    })
    const concept = generateConceptFile(session)
    const markdown = formatConceptFileAsMarkdown(concept)

    expect(markdown).toContain('unique-roundtrip-id-xyz-789')
  })

  it('rendered markdown contains the problem statement from the first user input', () => {
    const session = makeSession({
      turns: [makeTurn('Build a real-time collaboration tool')],
    })
    const concept = generateConceptFile(session)
    const markdown = formatConceptFileAsMarkdown(concept)

    expect(markdown).toContain('Build a real-time collaboration tool')
  })

  it('rendered markdown contains the amendment type hint', () => {
    const concept: ConceptFile = {
      problemStatement: 'Test',
      decisionsMade: [],
      keyConstraints: [],
      amendmentTypeHint: 'architecture_correction',
      rawSummary: 'Summary',
      generatedAt: new Date().toISOString(),
      sessionId: 'test-roundtrip',
    }
    const markdown = formatConceptFileAsMarkdown(concept)
    expect(markdown).toContain('**Hint:** architecture_correction')
  })

  it('all 4 amendmentTypeHint values render correctly in markdown', () => {
    const hints: ConceptFile['amendmentTypeHint'][] = [
      'pure_new_scope',
      'change_existing_scope',
      'architecture_correction',
      'mixed',
    ]

    for (const hint of hints) {
      const concept: ConceptFile = {
        problemStatement: 'Test',
        decisionsMade: [],
        keyConstraints: [],
        amendmentTypeHint: hint,
        rawSummary: 'Summary',
        generatedAt: new Date().toISOString(),
        sessionId: 'test',
      }
      const markdown = formatConceptFileAsMarkdown(concept)
      expect(markdown).toContain(`**Hint:** ${hint}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 11: loadAmendmentContextDocuments with projectRoot (12-3 AC2)
// Verifies the path resolution uses join(projectRoot, filename) correctly.
// ---------------------------------------------------------------------------

describe('Gap 11: loadAmendmentContextDocuments path resolution (12-3 AC2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads product-brief.md from inside the given projectRoot', async () => {
    mockReadFile.mockResolvedValue('Brief content')

    await loadAmendmentContextDocuments('/my/specific/root')

    const calls = mockReadFile.mock.calls as [string][]
    const briefCall = calls.find(([p]) => p.endsWith('product-brief.md'))
    expect(briefCall).toBeDefined()
    expect(briefCall![0]).toContain('/my/specific/root')
  })

  it('reads requirements.md from inside the given projectRoot', async () => {
    mockReadFile.mockResolvedValue('PRD content')

    await loadAmendmentContextDocuments('/my/specific/root')

    const calls = mockReadFile.mock.calls as [string][]
    const prdCall = calls.find(([p]) => p.endsWith('requirements.md'))
    expect(prdCall).toBeDefined()
    expect(prdCall![0]).toContain('/my/specific/root')
  })
})

// ---------------------------------------------------------------------------
// Gap 12: detectBrainstormContext path resolution (12-3 AC2)
// Verifies the paths checked by access() are inside projectRoot.
// ---------------------------------------------------------------------------

describe('Gap 12: detectBrainstormContext path resolution (12-3 AC2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAccess.mockRejectedValue(new Error('ENOENT'))
  })

  it('checks product-brief.md inside the given projectRoot', async () => {
    await detectBrainstormContext('/project/abc')

    const calls = mockAccess.mock.calls as [string][]
    const briefCall = calls.find(([p]) => p.endsWith('product-brief.md'))
    expect(briefCall).toBeDefined()
    expect(briefCall![0]).toContain('/project/abc')
  })

  it('checks requirements.md inside the given projectRoot', async () => {
    await detectBrainstormContext('/project/abc')

    const calls = mockAccess.mock.calls as [string][]
    const prdCall = calls.find(([p]) => p.endsWith('requirements.md'))
    expect(prdCall).toBeDefined()
    expect(prdCall![0]).toContain('/project/abc')
  })
})
