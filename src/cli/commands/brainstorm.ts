/**
 * `substrate brainstorm` command
 *
 * Provides an interactive multi-persona AI brainstorm REPL session:
 *   substrate brainstorm
 *   substrate brainstorm --existing
 *   substrate brainstorm --project-root <path>
 *
 * Session commands:
 *   !help  — display available commands
 *   !wrap  — finalize session, generate concept file, save to disk, exit
 *   !quit  — exit immediately without saving
 *
 * Architecture:
 *   - Single command file, no subdirectories
 *   - Uses Node.js built-in readline for interactive REPL
 *   - Dispatches 3 AI personas in parallel (mocked in tests)
 *   - Saves concept file to CWD by default
 *
 * Exit codes:
 *   0 - Success (session completed or quit)
 *   1 - System error (initialization failure)
 */

import type { Command } from 'commander'
import { readFile, writeFile, access } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('brainstorm-cmd')

// ---------------------------------------------------------------------------
// Types and Interfaces
// ---------------------------------------------------------------------------

/**
 * Represents the final output from a brainstorm session.
 */
export interface ConceptFile {
  problemStatement: string
  decisionsMade: string[]
  keyConstraints: string[]
  amendmentTypeHint: 'pure_new_scope' | 'change_existing_scope' | 'architecture_correction' | 'mixed'
  rawSummary: string
  generatedAt: string
  sessionId: string
}

/**
 * A single exchange in the brainstorm session.
 */
export interface BrainstormTurn {
  timestamp: Date
  userInput: string
  personas: PersonaResponse[]
}

/**
 * A single persona's response in a turn.
 */
export interface PersonaResponse {
  name: string // 'Pragmatic Engineer' | 'Product Thinker' | "Devil's Advocate"
  response: string
}

/**
 * Represents the full brainstorm session state.
 */
export interface BrainstormSession {
  sessionId: string
  startedAt: Date
  isAmendment: boolean
  contextBrief?: string
  contextPrd?: string
  turns: BrainstormTurn[]
}

/**
 * Options for the brainstorm command.
 */
export interface BrainstormOptions {
  existing?: boolean
  projectRoot: string
  outputPath?: string
}

// ---------------------------------------------------------------------------
// Context Detection and Document Loading
// ---------------------------------------------------------------------------

/**
 * Detect whether the project has existing planning artifacts that indicate
 * this is an amendment session (vs. a brand-new project brainstorm).
 *
 * @param projectRoot - Root directory of the project
 * @returns Object indicating if amendment context exists and paths to documents
 * @throws if projectRoot is empty or not provided
 */
export async function detectBrainstormContext(
  projectRoot: string,
): Promise<{ isAmendment: boolean; briefPath?: string; prdPath?: string }> {
  if (!projectRoot) {
    throw new Error('projectRoot is required')
  }

  const briefPath = join(projectRoot, 'product-brief.md')
  const prdPath = join(projectRoot, 'requirements.md')

  let briefExists = false
  let prdExists = false

  try {
    await access(briefPath)
    briefExists = true
  } catch {
    // file not found, continue
  }

  try {
    await access(prdPath)
    prdExists = true
  } catch {
    // file not found, continue
  }

  const isAmendment = briefExists && prdExists

  return {
    isAmendment,
    briefPath: briefExists ? briefPath : undefined,
    prdPath: prdExists ? prdPath : undefined,
  }
}

/**
 * Load existing product brief and PRD documents from disk for amendment sessions.
 *
 * Logs warnings if files are missing but does NOT throw.
 *
 * @param projectRoot - Root directory of the project
 * @returns Object with loaded document content (undefined if file missing)
 */
export async function loadAmendmentContextDocuments(
  projectRoot: string,
): Promise<{ brief?: string; prd?: string }> {
  const briefPath = join(projectRoot, 'product-brief.md')
  const prdPath = join(projectRoot, 'requirements.md')

  let brief: string | undefined
  let prd: string | undefined

  try {
    brief = await readFile(briefPath, 'utf-8')
  } catch {
    logger.warn({ briefPath }, 'product-brief.md not found — continuing without brief context')
    process.stderr.write(`Warning: product-brief.md not found at ${briefPath}\n`)
  }

  try {
    prd = await readFile(prdPath, 'utf-8')
  } catch {
    logger.warn({ prdPath }, 'requirements.md not found — continuing without PRD context')
    process.stderr.write(`Warning: requirements.md not found at ${prdPath}\n`)
  }

  return { brief, prd }
}

// ---------------------------------------------------------------------------
// Concept File Generation
// ---------------------------------------------------------------------------

/**
 * Infer the amendment type hint from session discussion content.
 *
 * Uses keyword analysis on user input and persona responses.
 */
function inferAmendmentTypeHint(
  session: BrainstormSession,
): ConceptFile['amendmentTypeHint'] {
  const allText = session.turns
    .flatMap((t) => [
      t.userInput,
      ...t.personas.map((p) => p.response),
    ])
    .join(' ')
    .toLowerCase()

  const architectureKeywords = ['breaking change', 'refactor', 'redesign', 'migration', 'architecture', 'rewrite']
  const changeExistingKeywords = ['modify', 'update', 'change', 'improve', 'enhance', 'fix', 'tweak', 'adjust']
  const newScopeKeywords = ['new feature', 'new capability', 'add', 'create', 'build', 'implement new']

  let archScore = 0
  let changeScore = 0
  let newScore = 0

  for (const kw of architectureKeywords) {
    if (allText.includes(kw)) archScore++
  }
  for (const kw of changeExistingKeywords) {
    if (allText.includes(kw)) changeScore++
  }
  for (const kw of newScopeKeywords) {
    if (allText.includes(kw)) newScore++
  }

  const maxScore = Math.max(archScore, changeScore, newScore)

  if (maxScore === 0) {
    return session.isAmendment ? 'change_existing_scope' : 'pure_new_scope'
  }

  if (archScore === maxScore && archScore > 0) return 'architecture_correction'
  if (newScore === maxScore && changeScore > 0 && newScore > 0) return 'mixed'
  if (newScore === maxScore) return 'pure_new_scope'
  return 'change_existing_scope'
}

/**
 * Generate a ConceptFile from the brainstorm session transcript.
 *
 * Extracts problem statement, decisions, constraints, and amendment type hint
 * from the session history using heuristics.
 *
 * @param session - The completed brainstorm session
 * @returns ConceptFile object with all required fields
 */
export function generateConceptFile(session: BrainstormSession): ConceptFile {
  // Problem statement: synthesized from first turn
  let problemStatement = 'A new product concept to be explored.'
  if (session.turns.length > 0) {
    const firstTurn = session.turns[0]
    problemStatement = firstTurn.userInput || problemStatement
  }

  // Decisions: extract from persona responses looking for decision language
  const decisionsMade: string[] = []
  for (const turn of session.turns) {
    for (const persona of turn.personas) {
      const lines = persona.response.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (
          trimmed.startsWith('- ') &&
          (trimmed.toLowerCase().includes('decision') ||
            trimmed.toLowerCase().includes('recommend') ||
            trimmed.toLowerCase().includes('should') ||
            trimmed.toLowerCase().includes('we will'))
        ) {
          const decision = trimmed.replace(/^- /, '')
          if (decision.length > 0 && !decisionsMade.includes(decision)) {
            decisionsMade.push(decision)
          }
        }
      }
    }
  }

  // Key constraints: extract from persona responses
  const keyConstraints: string[] = []
  for (const turn of session.turns) {
    for (const persona of turn.personas) {
      const lines = persona.response.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (
          trimmed.startsWith('- ') &&
          (trimmed.toLowerCase().includes('constraint') ||
            trimmed.toLowerCase().includes('limitation') ||
            trimmed.toLowerCase().includes('cannot') ||
            trimmed.toLowerCase().includes('must not') ||
            trimmed.toLowerCase().includes('risk'))
        ) {
          const constraint = trimmed.replace(/^- /, '')
          if (constraint.length > 0 && !keyConstraints.includes(constraint)) {
            keyConstraints.push(constraint)
          }
        }
      }
    }
  }

  // Raw summary: concatenate all turns chronologically
  const rawSummary = session.turns
    .map((turn) => {
      const personaTexts = turn.personas
        .map((p) => `**${p.name}:** ${p.response}`)
        .join('\n\n')
      return `**User:** ${turn.userInput}\n\n${personaTexts}`
    })
    .join('\n\n---\n\n')

  const amendmentTypeHint = inferAmendmentTypeHint(session)

  return {
    problemStatement,
    decisionsMade,
    keyConstraints,
    amendmentTypeHint,
    rawSummary: rawSummary || 'No discussion recorded.',
    generatedAt: new Date().toISOString(),
    sessionId: session.sessionId,
  }
}

/**
 * Render a ConceptFile as structured Markdown.
 *
 * @param concept - The ConceptFile to render
 * @returns Markdown string
 */
export function formatConceptFileAsMarkdown(concept: ConceptFile): string {
  const lines: string[] = [
    `# Brainstorm Session: ${concept.generatedAt}`,
    '',
    `*Session ID: ${concept.sessionId}*`,
    '',
    '## Problem Statement',
    '',
    concept.problemStatement,
    '',
    '## Decisions Made',
    '',
  ]

  if (concept.decisionsMade.length === 0) {
    lines.push('*No explicit decisions recorded.*')
  } else {
    for (const decision of concept.decisionsMade) {
      lines.push(`- ${decision}`)
    }
  }

  lines.push('')
  lines.push('## Key Constraints')
  lines.push('')

  if (concept.keyConstraints.length === 0) {
    lines.push('*No explicit constraints recorded.*')
  } else {
    for (const constraint of concept.keyConstraints) {
      lines.push(`- ${constraint}`)
    }
  }

  lines.push('')
  lines.push('## Amendment Type')
  lines.push('')
  lines.push(`**Hint:** ${concept.amendmentTypeHint}`)
  lines.push('')
  lines.push('## Raw Discussion Summary')
  lines.push('')
  lines.push(concept.rawSummary)
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// File I/O and Persistence
// ---------------------------------------------------------------------------

/**
 * Save the brainstorm session to disk as a concept file.
 *
 * @param session - The completed brainstorm session
 * @param projectRoot - Root directory (used as default output location)
 * @param outputPath - Optional override for output file path
 * @returns The full file path of the saved concept file
 */
export async function saveSessionToDisk(
  session: BrainstormSession,
  projectRoot: string,
  outputPath?: string,
): Promise<string> {
  const concept = generateConceptFile(session)
  const markdown = formatConceptFileAsMarkdown(concept)

  let filePath: string
  if (outputPath) {
    filePath = outputPath
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T').slice(0, 19) + 'Z'
    const filename = `brainstorm-session-${timestamp}.md`
    filePath = join(projectRoot, filename)
  }

  try {
    await writeFile(filePath, markdown, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to save brainstorm session: ${msg}`)
  }

  return filePath
}

// ---------------------------------------------------------------------------
// Multi-Persona LLM Dispatch
// ---------------------------------------------------------------------------

/**
 * Context passed to persona dispatch.
 */
interface BrainstormContext {
  brief?: string
  prd?: string
}

/**
 * Build the prompt for a given persona.
 */
function buildPersonaPrompt(
  personaName: string,
  personaInstructions: string,
  userPrompt: string,
  context: BrainstormContext,
): string {
  const contextSection = [
    context.brief ? `**Product Brief:**\n${context.brief}` : '',
    context.prd ? `**PRD:**\n${context.prd}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return [
    'You are participating in a brainstorm session exploring a new product concept.',
    contextSection ? `\n**Context:**\n${contextSection}` : '',
    `\n**User's idea:** "${userPrompt}"`,
    `\nRespond as the **${personaName}** persona. ${personaInstructions}`,
    '\nRespond concisely (2-3 paragraphs max).',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Dispatch an idea to 3 AI personas in parallel.
 *
 * In test environments or when no LLM adapter is available, falls back to
 * placeholder responses. Production usage should inject a real dispatcher.
 *
 * @param userPrompt - The user's current idea or question
 * @param context - Pre-loaded context documents
 * @param llmDispatch - Optional function to call the LLM (injectable for testing)
 * @returns Array of 3 PersonaResponse objects
 */
export async function dispatchToPersonas(
  userPrompt: string,
  context: BrainstormContext,
  llmDispatch?: (prompt: string, personaName: string) => Promise<string>,
): Promise<PersonaResponse[]> {
  const personas = [
    {
      name: 'Pragmatic Engineer',
      instructions:
        'Think in terms of implementation complexity, technology constraints, integration points with existing systems, and technical debt implications.',
    },
    {
      name: 'Product Thinker',
      instructions:
        'Focus on customer value, market fit, user experience, and business outcomes. Consider the user journey and adoption challenges.',
    },
    {
      name: "Devil's Advocate",
      instructions:
        'Challenge assumptions, identify risks, explore failure modes, and ask hard questions about why this idea might not work.',
    },
  ]

  const defaultDispatch = async (prompt: string, personaName: string): Promise<string> => {
    // Minimal stub: in real deployment, this would call an LLM API
    logger.debug({ personaName, promptLength: prompt.length }, 'Dispatching to persona (stub mode)')
    return `[${personaName} response to: "${userPrompt.slice(0, 60)}..."]`
  }

  const dispatch = llmDispatch ?? defaultDispatch

  const results = await Promise.all(
    personas.map(async (persona) => {
      try {
        const prompt = buildPersonaPrompt(persona.name, persona.instructions, userPrompt, context)
        const response = await dispatch(prompt, persona.name)
        return { name: persona.name, response }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err, personaName: persona.name }, 'Persona dispatch failed')
        return {
          name: persona.name,
          response: `[Error: ${msg}. Please retry.]`,
        }
      }
    }),
  )

  return results
}

// ---------------------------------------------------------------------------
// REPL Formatting
// ---------------------------------------------------------------------------

const SEPARATOR = '─'.repeat(60)

function formatPersonaResponses(personas: PersonaResponse[]): string {
  return personas
    .map((p) => `\n**${p.name}:**\n${p.response}`)
    .join(`\n\n${SEPARATOR}`)
}

const HELP_TEXT = `
Available commands:
  !help   — Show this help message
  !wrap   — Generate concept file, save to disk, and exit
  !quit   — Exit without saving

Any other input will be dispatched to 3 AI personas for responses.
`

// ---------------------------------------------------------------------------
// Brainstorm Session Runner
// ---------------------------------------------------------------------------

/**
 * Run an interactive brainstorm REPL session.
 *
 * @param options - Session options (existing, projectRoot, outputPath)
 * @param llmDispatch - Optional LLM dispatch function (for testing)
 * @param rlInterface - Optional readline.Interface (for testing)
 * @returns Exit code (0 = success, 1 = error)
 */
export async function runBrainstormSession(
  options: BrainstormOptions,
  llmDispatch?: (prompt: string, personaName: string) => Promise<string>,
  rlInterface?: ReturnType<typeof createInterface>,
): Promise<number> {
  const { projectRoot, outputPath } = options

  // Generate a unique session ID
  const sessionId = `brainstorm-${Date.now()}`

  // Step 1: Context detection
  let isAmendment = options.existing ?? false
  let briefContent: string | undefined
  let prdContent: string | undefined

  try {
    if (options.existing) {
      const context = await detectBrainstormContext(projectRoot)
      isAmendment = context.isAmendment

      if (isAmendment) {
        const docs = await loadAmendmentContextDocuments(projectRoot)
        briefContent = docs.brief
        prdContent = docs.prd
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`Error detecting brainstorm context: ${msg}\n`)
    return 1
  }

  // Step 2: Create session
  const session: BrainstormSession = {
    sessionId,
    startedAt: new Date(),
    isAmendment,
    contextBrief: briefContent,
    contextPrd: prdContent,
    turns: [],
  }

  const brainstormContext: BrainstormContext = {
    brief: briefContent,
    prd: prdContent,
  }

  // Step 3: Welcome message
  process.stdout.write(`\n${SEPARATOR}\n`)
  process.stdout.write('  Substrate Brainstorm Session\n')
  process.stdout.write(`${SEPARATOR}\n`)
  if (isAmendment) {
    process.stdout.write('\nHere is what has already been decided. What new idea are we exploring?\n')
    if (briefContent) {
      process.stdout.write('  [Product brief loaded]\n')
    }
    if (prdContent) {
      process.stdout.write('  [PRD loaded]\n')
    }
  } else {
    process.stdout.write('\nStarting new brainstorm session. What product idea are we exploring?\n')
  }
  process.stdout.write('\nType !help for commands, !wrap to generate concept file, !quit to exit.\n\n')

  // Step 4: Set up readline interface
  const rl =
    rlInterface ??
    createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

  // Step 5: Signal handler for graceful exit on SIGINT (Ctrl+C)
  let sigintHandled = false
  const sigintHandler = async () => {
    if (sigintHandled) return
    sigintHandled = true
    process.stdout.write('\n\nInterrupted. Type !wrap to save session, or !quit to exit.\n')
    // Re-prompt: allow the user to continue
    sigintHandled = false
  }

  process.on('SIGINT', sigintHandler)

  return new Promise<number>((resolve) => {
    let sessionEnded = false

    const cleanup = () => {
      process.removeListener('SIGINT', sigintHandler)
      rl.close()
    }

    const endSession = async (save: boolean): Promise<void> => {
      if (sessionEnded) return
      sessionEnded = true

      cleanup()

      if (save && session.turns.length > 0) {
        try {
          const filePath = await saveSessionToDisk(session, projectRoot, outputPath)
          process.stdout.write(`\n${SEPARATOR}\n`)
          process.stdout.write(`Concept file saved: ${filePath}\n`)
          process.stdout.write(`\nNext step: substrate auto run --concept-file ${filePath}\n`)
          process.stdout.write(`${SEPARATOR}\n\n`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Error saving session: ${msg}\n`)
        }
      } else if (save && session.turns.length === 0) {
        process.stdout.write('\nNo turns recorded. Concept file not generated.\n')
      }

      resolve(0)
    }

    rl.on('line', async (line: string) => {
      if (sessionEnded) return

      const input = line.trim()

      if (input === '!help') {
        process.stdout.write(HELP_TEXT)
        return
      }

      if (input === '!wrap') {
        await endSession(true)
        return
      }

      if (input === '!quit') {
        process.stdout.write('\nExiting without saving.\n')
        await endSession(false)
        return
      }

      if (input === '') {
        return
      }

      // Dispatch to personas
      process.stdout.write('\nThinking...\n')
      try {
        const personaResponses = await dispatchToPersonas(input, brainstormContext, llmDispatch)

        const turn: BrainstormTurn = {
          timestamp: new Date(),
          userInput: input,
          personas: personaResponses,
        }
        session.turns.push(turn)

        process.stdout.write(`\n${SEPARATOR}\n`)
        process.stdout.write(formatPersonaResponses(personaResponses))
        process.stdout.write(`\n${SEPARATOR}\n\n`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error dispatching to personas: ${msg}\n`)
        process.stdout.write('An error occurred. Please try again.\n')
      }
    })

    rl.on('close', async () => {
      if (!sessionEnded) {
        // stdin closed without explicit !wrap or !quit
        process.stdout.write('\nSession ended. Type !wrap to generate concept file, or !quit to exit.\n')
        await endSession(false)
      }
    })

    rl.on('error', (err: Error) => {
      logger.error({ err }, 'readline error')
      if (!sessionEnded) {
        void endSession(false)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// registerBrainstormCommand
// ---------------------------------------------------------------------------

/**
 * Register the `substrate brainstorm` command with the CLI program.
 *
 * Usage:
 *   substrate brainstorm
 *   substrate brainstorm --existing
 *   substrate brainstorm --project-root <path>
 *
 * Interactive session commands:
 *   !help   — display available commands
 *   !wrap   — finalize session and generate concept file
 *   !quit   — exit without saving
 *
 * @param program     - Commander program instance
 * @param _version    - Package version (reserved for future use)
 * @param projectRoot - Project root directory (defaults to process.cwd())
 */
export function registerBrainstormCommand(
  program: Command,
  _version = '0.0.0',
  projectRoot = process.cwd(),
): void {
  program
    .command('brainstorm')
    .description(
      'Interactive multi-persona brainstorm session\n\n' +
        'Start an AI-facilitated ideation session with Pragmatic Engineer,\n' +
        'Product Thinker, and Devil\'s Advocate personas.\n\n' +
        'Session commands: !wrap (save & exit), !quit (exit without saving), !help',
    )
    .option(
      '--existing',
      'Auto-detect and pre-load existing product brief (product-brief.md) and PRD (requirements.md)',
      false,
    )
    .option('--project-root <path>', 'Override project root directory', projectRoot)
    .option('--output-path <path>', 'Override output file path for concept file')
    .action(
      async (opts: { existing: boolean; projectRoot: string; outputPath?: string }) => {
        try {
          const exitCode = await runBrainstormSession({
            existing: opts.existing,
            projectRoot: opts.projectRoot,
            outputPath: opts.outputPath,
          })
          process.exitCode = exitCode
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`Error: ${msg}\n`)
          process.exitCode = 1
        }
      },
    )
}
