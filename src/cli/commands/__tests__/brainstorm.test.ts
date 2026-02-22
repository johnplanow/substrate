/**
 * Unit tests for `src/cli/commands/brainstorm.ts`
 *
 * Covers all 8 Acceptance Criteria:
 *   AC1: Command registration and entry point
 *   AC2: Amendment context detection and pre-loading
 *   AC3: Multi-persona LLM dispatch
 *   AC4: Session structure — !help, !wrap, !quit commands
 *   AC5: Concept file generation with FR-2.5 fields
 *   AC6: Persistent session output to disk
 *   AC7: Helper functions exported and typed
 *   AC8: Error handling and edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Mocks — declared before imports that reference mocked modules
// ---------------------------------------------------------------------------

// Mock fs/promises
const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockAccess = vi.fn()

vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  access: (...args: unknown[]) => mockAccess(...args),
}))

// Mock readline
const mockRlOn = vi.fn()
const mockRlClose = vi.fn()
const mockRlInterface = {
  on: mockRlOn,
  close: mockRlClose,
}

vi.mock('readline', () => ({
  createInterface: vi.fn(() => mockRlInterface),
}))

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  detectBrainstormContext,
  loadAmendmentContextDocuments,
  generateConceptFile,
  formatConceptFileAsMarkdown,
  dispatchToPersonas,
  saveSessionToDisk,
  runBrainstormSession,
  registerBrainstormCommand,
} from '../brainstorm.js'
import type {
  ConceptFile,
  BrainstormSession,
  BrainstormTurn,
  PersonaResponse,
  BrainstormOptions,
} from '../brainstorm.js'
import { Command } from 'commander'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<BrainstormSession> = {}): BrainstormSession {
  return {
    sessionId: 'test-session-123',
    startedAt: new Date('2026-02-22T14:30:00Z'),
    isAmendment: false,
    turns: [],
    ...overrides,
  }
}

function makeTurn(userInput = 'test idea', personas: PersonaResponse[] = []): BrainstormTurn {
  return {
    timestamp: new Date('2026-02-22T14:31:00Z'),
    userInput,
    personas:
      personas.length > 0
        ? personas
        : [
            { name: 'Pragmatic Engineer', response: 'Engineering perspective here.' },
            { name: 'Product Thinker', response: 'Product perspective here.' },
            { name: "Devil's Advocate", response: 'Challenge: this might not work.' },
          ],
  }
}

// ---------------------------------------------------------------------------
// AC7: Helper functions are exported and callable
// ---------------------------------------------------------------------------

describe('AC7: Helper function exports', () => {
  it('exports detectBrainstormContext as a function', () => {
    expect(typeof detectBrainstormContext).toBe('function')
  })

  it('exports loadAmendmentContextDocuments as a function', () => {
    expect(typeof loadAmendmentContextDocuments).toBe('function')
  })

  it('exports generateConceptFile as a function', () => {
    expect(typeof generateConceptFile).toBe('function')
  })

  it('exports formatConceptFileAsMarkdown as a function', () => {
    expect(typeof formatConceptFileAsMarkdown).toBe('function')
  })

  it('exports dispatchToPersonas as a function', () => {
    expect(typeof dispatchToPersonas).toBe('function')
  })

  it('exports saveSessionToDisk as a function', () => {
    expect(typeof saveSessionToDisk).toBe('function')
  })

  it('exports runBrainstormSession as a function', () => {
    expect(typeof runBrainstormSession).toBe('function')
  })

  it('exports registerBrainstormCommand as a function', () => {
    expect(typeof registerBrainstormCommand).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// AC1: Command Registration
// ---------------------------------------------------------------------------

describe('AC1: Command registration and entry point', () => {
  it('registers brainstorm command on the Commander program', () => {
    const program = new Command()
    registerBrainstormCommand(program)
    const commands = program.commands.map((c) => c.name())
    expect(commands).toContain('brainstorm')
  })

  it('brainstorm command has a description', () => {
    const program = new Command()
    registerBrainstormCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'brainstorm')
    expect(cmd?.description()).toMatch(/brainstorm/i)
  })

  it('brainstorm command accepts --existing option', () => {
    const program = new Command()
    registerBrainstormCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'brainstorm')
    const options = cmd?.options.map((o) => o.long)
    expect(options).toContain('--existing')
  })

  it('brainstorm command accepts --project-root option', () => {
    const program = new Command()
    registerBrainstormCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'brainstorm')
    const options = cmd?.options.map((o) => o.long)
    expect(options).toContain('--project-root')
  })

  it('help text mentions !wrap, !quit, !help commands', () => {
    const program = new Command()
    registerBrainstormCommand(program)
    const cmd = program.commands.find((c) => c.name() === 'brainstorm')
    const desc = cmd?.description() ?? ''
    expect(desc).toContain('!wrap')
    expect(desc).toContain('!quit')
    expect(desc).toContain('!help')
  })
})

// ---------------------------------------------------------------------------
// AC2: Amendment Context Detection
// ---------------------------------------------------------------------------

describe('AC2: Amendment context detection and pre-loading', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('detectBrainstormContext: returns isAmendment=true when both files exist', async () => {
    mockAccess.mockResolvedValue(undefined)

    const result = await detectBrainstormContext('/test/project')

    expect(result.isAmendment).toBe(true)
    expect(result.briefPath).toBeDefined()
    expect(result.prdPath).toBeDefined()
  })

  it('detectBrainstormContext: returns isAmendment=false when brief is missing', async () => {
    // First access (brief) throws, second (prd) succeeds
    mockAccess.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce(undefined)

    const result = await detectBrainstormContext('/test/project')

    expect(result.isAmendment).toBe(false)
    expect(result.briefPath).toBeUndefined()
    expect(result.prdPath).toBeDefined()
  })

  it('detectBrainstormContext: returns isAmendment=false when prd is missing', async () => {
    // First access (brief) succeeds, second (prd) throws
    mockAccess.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('ENOENT'))

    const result = await detectBrainstormContext('/test/project')

    expect(result.isAmendment).toBe(false)
    expect(result.briefPath).toBeDefined()
    expect(result.prdPath).toBeUndefined()
  })

  it('detectBrainstormContext: returns isAmendment=false when both files are missing', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'))

    const result = await detectBrainstormContext('/test/project')

    expect(result.isAmendment).toBe(false)
    expect(result.briefPath).toBeUndefined()
    expect(result.prdPath).toBeUndefined()
  })

  it('detectBrainstormContext: throws when projectRoot is empty', async () => {
    await expect(detectBrainstormContext('')).rejects.toThrow('projectRoot is required')
  })

  it('loadAmendmentContextDocuments: loads both files when present', async () => {
    mockReadFile
      .mockResolvedValueOnce('# Product Brief Content')
      .mockResolvedValueOnce('# PRD Content')

    const result = await loadAmendmentContextDocuments('/test/project')

    expect(result.brief).toBe('# Product Brief Content')
    expect(result.prd).toBe('# PRD Content')
  })

  it('loadAmendmentContextDocuments: continues when brief is missing (logs warning)', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce('# PRD Content')

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = await loadAmendmentContextDocuments('/test/project')

    expect(result.brief).toBeUndefined()
    expect(result.prd).toBe('# PRD Content')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('product-brief.md not found'))

    stderrSpy.mockRestore()
  })

  it('loadAmendmentContextDocuments: continues when PRD is missing (logs warning)', async () => {
    mockReadFile
      .mockResolvedValueOnce('# Product Brief Content')
      .mockRejectedValueOnce(new Error('ENOENT'))

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = await loadAmendmentContextDocuments('/test/project')

    expect(result.brief).toBe('# Product Brief Content')
    expect(result.prd).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('requirements.md not found'))

    stderrSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// AC3: Multi-Persona LLM Dispatch
// ---------------------------------------------------------------------------

describe('AC3: Multi-persona LLM dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatchToPersonas: returns 3 persona responses', async () => {
    const mockLlm = vi.fn().mockResolvedValue('Mock LLM response')

    const result = await dispatchToPersonas('test idea', {}, mockLlm)

    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('Pragmatic Engineer')
    expect(result[1].name).toBe('Product Thinker')
    expect(result[2].name).toBe("Devil's Advocate")
  })

  it('dispatchToPersonas: each persona gets called with a distinct prompt', async () => {
    const mockLlm = vi.fn().mockResolvedValue('Response')

    await dispatchToPersonas('build a feature', { brief: 'product brief', prd: 'prd content' }, mockLlm)

    expect(mockLlm).toHaveBeenCalledTimes(3)
    // Each prompt should contain the persona name
    const calls = mockLlm.mock.calls as [string, string][]
    expect(calls[0][1]).toBe('Pragmatic Engineer')
    expect(calls[1][1]).toBe('Product Thinker')
    expect(calls[2][1]).toBe("Devil's Advocate")
  })

  it('dispatchToPersonas: includes context in prompts when provided', async () => {
    const mockLlm = vi.fn().mockResolvedValue('Response')

    await dispatchToPersonas('idea', { brief: 'My brief', prd: 'My prd' }, mockLlm)

    const firstCall = mockLlm.mock.calls[0][0] as string
    expect(firstCall).toContain('My brief')
    expect(firstCall).toContain('My prd')
  })

  it('dispatchToPersonas: handles LLM errors gracefully', async () => {
    const mockLlm = vi.fn().mockRejectedValue(new Error('LLM network error'))

    const result = await dispatchToPersonas('test', {}, mockLlm)

    expect(result).toHaveLength(3)
    for (const r of result) {
      expect(r.response).toContain('Error')
    }
  })

  it('dispatchToPersonas: dispatches all 3 personas in parallel (Promise.all)', async () => {
    const callOrder: string[] = []
    const mockLlm = vi.fn().mockImplementation(async (_prompt: string, name: string) => {
      callOrder.push(name)
      return `${name} response`
    })

    await dispatchToPersonas('idea', {}, mockLlm)

    expect(mockLlm).toHaveBeenCalledTimes(3)
    expect(callOrder).toHaveLength(3)
  })

  it('dispatchToPersonas: uses default stub when no llmDispatch provided', async () => {
    // Should not throw and should return 3 responses
    const result = await dispatchToPersonas('test idea', {})

    expect(result).toHaveLength(3)
    expect(result[0].name).toBe('Pragmatic Engineer')
  })
})

// ---------------------------------------------------------------------------
// AC5: Concept File Generation
// ---------------------------------------------------------------------------

describe('AC5: Concept file generation with FR-2.5 fields', () => {
  it('generateConceptFile: returns ConceptFile with all required fields', () => {
    const session = makeSession({ turns: [makeTurn('We need a new feature')] })
    const concept = generateConceptFile(session)

    expect(concept).toHaveProperty('problemStatement')
    expect(concept).toHaveProperty('decisionsMade')
    expect(concept).toHaveProperty('keyConstraints')
    expect(concept).toHaveProperty('amendmentTypeHint')
    expect(concept).toHaveProperty('rawSummary')
    expect(concept).toHaveProperty('generatedAt')
    expect(concept).toHaveProperty('sessionId')
  })

  it('generateConceptFile: problemStatement comes from first user input', () => {
    const session = makeSession({ turns: [makeTurn('We need a payment gateway')] })
    const concept = generateConceptFile(session)

    expect(concept.problemStatement).toBe('We need a payment gateway')
  })

  it('generateConceptFile: sessionId matches session.sessionId', () => {
    const session = makeSession({ sessionId: 'abc-123', turns: [makeTurn()] })
    const concept = generateConceptFile(session)

    expect(concept.sessionId).toBe('abc-123')
  })

  it('generateConceptFile: generatedAt is a valid ISO timestamp', () => {
    const session = makeSession({ turns: [makeTurn()] })
    const concept = generateConceptFile(session)

    expect(() => new Date(concept.generatedAt)).not.toThrow()
    expect(new Date(concept.generatedAt).getTime()).toBeGreaterThan(0)
  })

  it('generateConceptFile: amendmentTypeHint is one of the valid values', () => {
    const session = makeSession({ turns: [makeTurn()] })
    const concept = generateConceptFile(session)

    const validHints = ['pure_new_scope', 'change_existing_scope', 'architecture_correction', 'mixed']
    expect(validHints).toContain(concept.amendmentTypeHint)
  })

  it('generateConceptFile: rawSummary contains user input', () => {
    const session = makeSession({ turns: [makeTurn('My unique user input XYZ')] })
    const concept = generateConceptFile(session)

    expect(concept.rawSummary).toContain('My unique user input XYZ')
  })

  it('generateConceptFile: rawSummary contains persona names', () => {
    const session = makeSession({ turns: [makeTurn()] })
    const concept = generateConceptFile(session)

    expect(concept.rawSummary).toContain('Pragmatic Engineer')
    expect(concept.rawSummary).toContain('Product Thinker')
    expect(concept.rawSummary).toContain("Devil's Advocate")
  })

  it('generateConceptFile: handles empty session turns', () => {
    const session = makeSession({ turns: [] })
    const concept = generateConceptFile(session)

    expect(concept.problemStatement).toBeDefined()
    expect(concept.decisionsMade).toEqual([])
    expect(concept.keyConstraints).toEqual([])
    expect(concept.rawSummary).toContain('No discussion recorded')
  })

  it('generateConceptFile: detects architecture_correction from keywords', () => {
    const session = makeSession({
      turns: [
        makeTurn('breaking change needed', [
          { name: 'Pragmatic Engineer', response: 'This is a breaking change to the architecture.' },
          { name: 'Product Thinker', response: 'We need architecture redesign.' },
          { name: "Devil's Advocate", response: 'Migration will be costly.' },
        ]),
      ],
    })
    const concept = generateConceptFile(session)
    expect(concept.amendmentTypeHint).toBe('architecture_correction')
  })

  it('generateConceptFile: detects pure_new_scope for new feature language', () => {
    const session = makeSession({
      turns: [
        makeTurn('add new feature for payments', [
          { name: 'Pragmatic Engineer', response: 'We should create a new payment module and implement new API.' },
          { name: 'Product Thinker', response: 'Build a new capability for users.' },
          { name: "Devil's Advocate", response: 'Why do we need a new feature at all?' },
        ]),
      ],
    })
    const concept = generateConceptFile(session)
    expect(['pure_new_scope', 'mixed']).toContain(concept.amendmentTypeHint)
  })
})

// ---------------------------------------------------------------------------
// AC5 continued: Markdown formatting
// ---------------------------------------------------------------------------

describe('formatConceptFileAsMarkdown', () => {
  it('returns a valid Markdown string with all required sections', () => {
    const session = makeSession({ turns: [makeTurn()] })
    const concept = generateConceptFile(session)
    const md = formatConceptFileAsMarkdown(concept)

    expect(md).toContain('# Brainstorm Session:')
    expect(md).toContain('## Problem Statement')
    expect(md).toContain('## Decisions Made')
    expect(md).toContain('## Key Constraints')
    expect(md).toContain('## Amendment Type')
    expect(md).toContain('## Raw Discussion Summary')
  })

  it('includes the amendment type hint in markdown', () => {
    const concept: ConceptFile = {
      problemStatement: 'Test problem',
      decisionsMade: ['Decision 1'],
      keyConstraints: ['Constraint 1'],
      amendmentTypeHint: 'pure_new_scope',
      rawSummary: 'Some summary',
      generatedAt: '2026-02-22T14:30:00.000Z',
      sessionId: 'test-123',
    }
    const md = formatConceptFileAsMarkdown(concept)

    expect(md).toContain('**Hint:** pure_new_scope')
  })

  it('includes decisions and constraints as bullet lists', () => {
    const concept: ConceptFile = {
      problemStatement: 'Problem',
      decisionsMade: ['Decision A', 'Decision B'],
      keyConstraints: ['Constraint X'],
      amendmentTypeHint: 'mixed',
      rawSummary: 'Summary',
      generatedAt: new Date().toISOString(),
      sessionId: 'sess-1',
    }
    const md = formatConceptFileAsMarkdown(concept)

    expect(md).toContain('- Decision A')
    expect(md).toContain('- Decision B')
    expect(md).toContain('- Constraint X')
  })

  it('handles empty decisions and constraints gracefully', () => {
    const concept: ConceptFile = {
      problemStatement: 'Problem',
      decisionsMade: [],
      keyConstraints: [],
      amendmentTypeHint: 'change_existing_scope',
      rawSummary: 'Summary',
      generatedAt: new Date().toISOString(),
      sessionId: 'sess-2',
    }
    const md = formatConceptFileAsMarkdown(concept)

    expect(md).toContain('*No explicit decisions recorded.*')
    expect(md).toContain('*No explicit constraints recorded.*')
  })

  it('includes session ID in the markdown', () => {
    const concept: ConceptFile = {
      problemStatement: 'Problem',
      decisionsMade: [],
      keyConstraints: [],
      amendmentTypeHint: 'pure_new_scope',
      rawSummary: 'Summary',
      generatedAt: new Date().toISOString(),
      sessionId: 'unique-session-id-xyz',
    }
    const md = formatConceptFileAsMarkdown(concept)

    expect(md).toContain('unique-session-id-xyz')
  })
})

// ---------------------------------------------------------------------------
// AC6: Persistent Session Output
// ---------------------------------------------------------------------------

describe('AC6: Persistent session output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saveSessionToDisk: calls writeFile with the generated markdown', async () => {
    mockWriteFile.mockResolvedValue(undefined)

    const session = makeSession({ turns: [makeTurn()] })
    await saveSessionToDisk(session, '/project')

    expect(mockWriteFile).toHaveBeenCalledOnce()
    const [path, content] = mockWriteFile.mock.calls[0] as [string, string, string]
    expect(path).toContain('brainstorm-session-')
    expect(content).toContain('# Brainstorm Session:')
  })

  it('saveSessionToDisk: generates timestamp-based filename', async () => {
    mockWriteFile.mockResolvedValue(undefined)

    const session = makeSession({ turns: [makeTurn()] })
    const filePath = await saveSessionToDisk(session, '/project')

    expect(filePath).toMatch(/brainstorm-session-\d{4}-\d{2}-\d{2}T/)
    expect(filePath).toMatch(/\.md$/)
  })

  it('saveSessionToDisk: uses provided outputPath when specified', async () => {
    mockWriteFile.mockResolvedValue(undefined)

    const session = makeSession({ turns: [makeTurn()] })
    const filePath = await saveSessionToDisk(session, '/project', '/custom/path/output.md')

    expect(filePath).toBe('/custom/path/output.md')
    expect(mockWriteFile.mock.calls[0][0]).toBe('/custom/path/output.md')
  })

  it('saveSessionToDisk: throws on file write failure', async () => {
    mockWriteFile.mockRejectedValue(new Error('Permission denied'))

    const session = makeSession({ turns: [makeTurn()] })

    await expect(saveSessionToDisk(session, '/project')).rejects.toThrow('Failed to save brainstorm session')
  })
})

// ---------------------------------------------------------------------------
// AC4: REPL Session Commands
// ---------------------------------------------------------------------------

describe('AC4: REPL session command handling', () => {
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

  it('!help: displays help text when user types !help', async () => {
    // Simulate readline that immediately sends !help then closes
    const lineHandlers: Array<(line: string) => void> = []
    const closeHandlers: Array<() => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      if (event === 'close') closeHandlers.push(handler as () => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    // Fire !help
    for (const handler of lineHandlers) {
      handler('!help')
    }

    // Fire !quit to end session
    for (const handler of lineHandlers) {
      handler('!quit')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)

    const stdoutCalls = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutCalls).toContain('!help')
    expect(stdoutCalls).toContain('!wrap')
    expect(stdoutCalls).toContain('!quit')
  })

  it('!quit: exits without saving', async () => {
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
      handler('!quit')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)
    // writeFile should NOT have been called (no save)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('!wrap: saves session and prints file path and next command', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const mockLlm = vi.fn().mockResolvedValue('Persona response text')

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      mockLlm,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    // Send a user input first to create a turn
    for (const handler of lineHandlers) {
      handler('I want to build a new feature')
    }

    // Wait a tick for async persona dispatch
    await new Promise((r) => setTimeout(r, 10))

    // Then wrap
    for (const handler of lineHandlers) {
      handler('!wrap')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)
    expect(mockWriteFile).toHaveBeenCalledOnce()

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toContain('brainstorm-session-')
    expect(stdoutContent).toContain('substrate auto run --concept-file')
  })

  it('stdin close without !wrap: exits without saving', async () => {
    const closeHandlers: Array<() => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'close') closeHandlers.push(handler as () => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    for (const handler of closeHandlers) {
      handler()
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)
    expect(mockWriteFile).not.toHaveBeenCalled()
  })

  it('REPL displays persona responses after user input', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const mockLlm = vi.fn().mockResolvedValue('Unique persona response content here')

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      mockLlm,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    for (const handler of lineHandlers) {
      handler('a user idea')
    }

    await new Promise((r) => setTimeout(r, 10))

    for (const handler of lineHandlers) {
      handler('!quit')
    }

    await sessionPromise

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toContain('Unique persona response content here')
  })
})

// ---------------------------------------------------------------------------
// AC8: Error Handling and Edge Cases
// ---------------------------------------------------------------------------

describe('AC8: Error handling and edge cases', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    mockAccess.mockRejectedValue(new Error('ENOENT'))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('loadAmendmentContextDocuments: missing brief logs warning, continues with prd', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT')).mockResolvedValueOnce('PRD content')

    const result = await loadAmendmentContextDocuments('/test')

    expect(result.brief).toBeUndefined()
    expect(result.prd).toBe('PRD content')
    // Warning should have been written
    expect(stderrSpy).toHaveBeenCalled()
  })

  it('loadAmendmentContextDocuments: missing prd logs warning, continues with brief', async () => {
    mockReadFile
      .mockResolvedValueOnce('Brief content')
      .mockRejectedValueOnce(new Error('ENOENT'))

    const result = await loadAmendmentContextDocuments('/test')

    expect(result.brief).toBe('Brief content')
    expect(result.prd).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalled()
  })

  it('LLM failures: persona dispatch shows error in response, does not crash session', async () => {
    const lineHandlers: Array<(line: string) => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      return mockRlInterface
    })

    const mockLlm = vi.fn().mockRejectedValue(new Error('LLM unavailable'))

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: false },
      mockLlm,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    for (const handler of lineHandlers) {
      handler('test idea')
    }

    await new Promise((r) => setTimeout(r, 10))

    for (const handler of lineHandlers) {
      handler('!quit')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toContain('Error')
  })

  it('detectBrainstormContext: throws on empty projectRoot', async () => {
    await expect(detectBrainstormContext('')).rejects.toThrow('projectRoot is required')
  })

  it('saveSessionToDisk: throws with descriptive error on write failure', async () => {
    mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'))

    const session = makeSession({ turns: [makeTurn()] })
    await expect(saveSessionToDisk(session, '/test')).rejects.toThrow('Failed to save brainstorm session')
  })

  it('runBrainstormSession: returns exit code 0 on successful completion', async () => {
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
      handler('!quit')
    }

    const exitCode = await sessionPromise
    expect(exitCode).toBe(0)
  })

  it('generates session welcome message on start', async () => {
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
      handler('!quit')
    }

    await sessionPromise

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toContain('Substrate Brainstorm Session')
  })

  it('amendment mode shows framing message about existing context', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('Content')

    const lineHandlers: Array<(line: string) => void> = []
    const closeHandlers: Array<() => void> = []

    mockRlOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'line') lineHandlers.push(handler as (line: string) => void)
      if (event === 'close') closeHandlers.push(handler as () => void)
      return mockRlInterface
    })

    const sessionPromise = runBrainstormSession(
      { projectRoot: '/test', existing: true },
      undefined,
      mockRlInterface as ReturnType<typeof import('readline').createInterface>,
    )

    // Wait a tick for async init (detectBrainstormContext + loadAmendmentContextDocuments)
    await new Promise((r) => setTimeout(r, 20))

    for (const handler of lineHandlers) {
      handler('!quit')
    }

    await sessionPromise

    const stdoutContent = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(stdoutContent).toContain('Here is what has already been decided')
  })
})

// ---------------------------------------------------------------------------
// Type interface validation
// ---------------------------------------------------------------------------

describe('Type interfaces', () => {
  it('BrainstormSession has required fields', () => {
    const session: BrainstormSession = {
      sessionId: 'test',
      startedAt: new Date(),
      isAmendment: false,
      turns: [],
    }
    expect(session.sessionId).toBe('test')
    expect(session.turns).toEqual([])
  })

  it('ConceptFile has all required fields with correct types', () => {
    const concept: ConceptFile = {
      problemStatement: 'test',
      decisionsMade: [],
      keyConstraints: [],
      amendmentTypeHint: 'pure_new_scope',
      rawSummary: 'summary',
      generatedAt: new Date().toISOString(),
      sessionId: 'test',
    }
    expect(concept.amendmentTypeHint).toBe('pure_new_scope')
  })

  it('BrainstormOptions requires projectRoot', () => {
    const opts: BrainstormOptions = {
      projectRoot: '/test',
    }
    expect(opts.projectRoot).toBe('/test')
  })
})
