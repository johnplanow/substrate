/**
 * Interactive Prompt — Phase D Story 54-3 (2026-04-05): original spec.
 * Epic 72: Decision Router that triggers prompts (Story 72-1 / 72-2).
 * Story 73-1: Recovery Engine that the prompt collects responses for.
 *
 * Presents an interactive numbered-choice prompt when the Decision Router halts
 * execution, and writes a filesystem notification file before prompting so
 * external monitors can detect the halt immediately.
 *
 * Non-interactive mode (SUBSTRATE_NON_INTERACTIVE=true or
 * decisionContext.nonInteractive=true) bypasses stdin, applies the default
 * action, and emits a decision:halt-skipped-non-interactive event for audit.
 */

import * as readline from 'node:readline'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { readCurrentRunId } from '../../cli/commands/manifest-read.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('interactive-prompt')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context provided to the interactive prompt when a halt is triggered.
 * Consumed by the Recovery Engine (Story 73-1) to route the operator's choice.
 */
export interface DecisionContext {
  /** Pipeline run ID — resolved from manifest-read if not provided. */
  runId?: string
  /** Decision type that triggered the halt (e.g., 'cost-ceiling-exhausted'). */
  decisionType: string
  /** Severity of the halt (e.g., 'critical', 'fatal'). */
  severity: string
  /** Human-readable summary of the halt condition to display to the operator. */
  summary: string
  /** Default action to apply if operator presses Enter or is in non-interactive mode. */
  defaultAction: string
  /** List of choice labels (e.g., ['retry', 'abort']). Used in the notification file. */
  choices: string[]
  /** When true, bypass stdin and return defaultAction immediately (AC4). */
  nonInteractive?: boolean
  /** Optional event emitter callback for decision:halt-skipped-non-interactive. */
  onHaltSkipped?: (payload: HaltSkippedPayload) => void
}

/**
 * Payload emitted when a halt is skipped under non-interactive mode (AC4).
 * Matches OrchestratorEvents['decision:halt-skipped-non-interactive'].
 */
export interface HaltSkippedPayload {
  runId: string
  decisionType: string
  severity: string
  defaultAction: string
  reason: string
}

/**
 * The operator's chosen action, returned by runInteractivePrompt.
 * Maps choice 1–4 to the corresponding action string.
 */
export type OperatorAction =
  | string // defaultAction (choice 1 or non-interactive)
  | 'retry-with-custom-context' // choice 2
  | 'propose-re-scope' // choice 3
  | 'abort-run' // choice 4

// ---------------------------------------------------------------------------
// Notification file type (AC5)
// ---------------------------------------------------------------------------

/**
 * Shape written to .substrate/notifications/<runId>-<timestamp>.json.
 * Exported so callers (e.g., report.ts) can parse typed notifications.
 */
export interface HaltNotification {
  runId: string
  timestamp: string
  decisionType: string
  severity: string
  context: Record<string, unknown>
  choices: string[]
  operatorChoice: string | null
}

// ---------------------------------------------------------------------------
// Prompt rendering (AC2)
// ---------------------------------------------------------------------------

const SEPARATOR = '─────────────────────────────────────────────────'

/**
 * Write the numbered-choice prompt to stdout (AC2).
 * Called before readline to ensure the separator appears before stdin read.
 */
function renderPrompt(ctx: DecisionContext): void {
  process.stdout.write(`${SEPARATOR}\n`)
  process.stdout.write(`⚠ Halt: ${ctx.decisionType} (${ctx.severity})\n`)
  process.stdout.write(`${SEPARATOR}\n`)
  process.stdout.write(`${ctx.summary}\n\n`)
  process.stdout.write(`1) Accept default: ${ctx.defaultAction}\n`)
  process.stdout.write(`2) Retry with custom context\n`)
  process.stdout.write(`3) Propose re-scope\n`)
  process.stdout.write(`4) Abort run\n`)
  process.stdout.write(`\nChoice [1]: `)
}

// ---------------------------------------------------------------------------
// Notification file helpers (AC5, AC7, AC8)
// ---------------------------------------------------------------------------

/**
 * Sanitize an ISO timestamp string for use in a filename (replace colons and dots).
 */
function sanitizeTimestampForFilename(iso: string): string {
  return iso.replace(/:/g, '-').replace(/\./g, '-')
}

/**
 * Resolve the notifications directory (AC8 — use resolveMainRepoRoot).
 */
async function resolveNotificationsDir(): Promise<string> {
  const repoRoot = await resolveMainRepoRoot()
  return join(repoRoot, '.substrate', 'notifications')
}

/**
 * Write the initial notification file BEFORE prompting (AC5).
 * Returns the file path so we can update operatorChoice after the prompt.
 */
async function writeNotificationFile(
  runId: string,
  ctx: DecisionContext,
  timestamp: string,
): Promise<string> {
  const notifDir = await resolveNotificationsDir()
  await mkdir(notifDir, { recursive: true })

  const safeTs = sanitizeTimestampForFilename(timestamp)
  const filePath = join(notifDir, `${runId}-${safeTs}.json`)

  const notification: HaltNotification = {
    runId,
    timestamp,
    decisionType: ctx.decisionType,
    severity: ctx.severity,
    context: {
      summary: ctx.summary,
      defaultAction: ctx.defaultAction,
    },
    choices: ctx.choices,
    operatorChoice: null,
  }

  await writeFile(filePath, JSON.stringify(notification, null, 2), 'utf8')
  logger.debug({ filePath }, 'notification file written')
  return filePath
}

/**
 * Update operatorChoice in the notification file after the operator responds (AC5).
 * If the file was deleted by an external monitor, swallow ENOENT and continue (AC7).
 */
async function updateNotificationChoice(filePath: string, operatorChoice: string): Promise<void> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as HaltNotification
    parsed.operatorChoice = operatorChoice
    await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8')
    logger.debug({ filePath, operatorChoice }, 'notification file updated with operator choice')
  } catch (err) {
    // AC7: if external monitor deleted the file, continue normally
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.debug({ filePath }, 'notification file already deleted by external monitor — continuing')
      return
    }
    // Log other errors but don't throw — notification update is non-fatal
    logger.warn({ err, filePath }, 'failed to update notification file — continuing')
  }
}

// ---------------------------------------------------------------------------
// Choice parsing (AC3)
// ---------------------------------------------------------------------------

/**
 * Parse a raw stdin line into a 1–4 integer choice, defaulting to 1 on failure.
 */
function parseChoice(raw: string): 1 | 2 | 3 | 4 {
  const trimmed = raw.trim()
  if (trimmed === '') return 1
  const n = parseInt(trimmed, 10)
  if (isNaN(n) || n < 1 || n > 4) return 1
  return n as 1 | 2 | 3 | 4
}

/**
 * Map a parsed choice integer to the corresponding operator action string.
 */
function mapChoiceToAction(choice: 1 | 2 | 3 | 4, defaultAction: string): string {
  switch (choice) {
    case 1: return defaultAction
    case 2: return 'retry-with-custom-context'
    case 3: return 'propose-re-scope'
    case 4: return 'abort-run'
  }
}

// ---------------------------------------------------------------------------
// Main export (AC1, AC3, AC4, AC5)
// ---------------------------------------------------------------------------

/**
 * Run the interactive prompt for a Decision Router halt.
 *
 * Workflow:
 * 1. Resolve run ID (from context or manifest-read.ts).
 * 2. Write notification file BEFORE prompting (AC5).
 * 3. If non-interactive mode, emit halt-skipped event and return default (AC4).
 * 4. If stdin is not a TTY, log warning and treat as non-interactive (defensive).
 * 5. Render the numbered-choice prompt (AC2).
 * 6. Read one line from stdin via readline.createInterface (AC3).
 * 7. Parse and return the chosen action.
 * 8. Update notification file with the operator's choice (AC5).
 *
 * @param decisionContext - Decision context from the Decision Router halt.
 * @returns The operator's chosen action string.
 */
export async function runInteractivePrompt(decisionContext: DecisionContext): Promise<string> {
  // Step 1: Resolve run ID (AC8)
  let runId = decisionContext.runId ?? null
  if (!runId) {
    try {
      const repoRoot = await resolveMainRepoRoot()
      runId = await readCurrentRunId(repoRoot)
    } catch {
      // Non-fatal — use fallback
    }
  }
  if (!runId) {
    runId = 'unknown'
  }

  // Step 2: Write notification file BEFORE prompting (AC5)
  const timestamp = new Date().toISOString()
  let notifPath: string | null = null
  try {
    notifPath = await writeNotificationFile(runId, decisionContext, timestamp)
  } catch (err) {
    logger.warn({ err }, 'failed to write notification file — continuing without it')
  }

  // Determine non-interactive mode (AC4)
  const isNonInteractive =
    process.env['SUBSTRATE_NON_INTERACTIVE'] === 'true' ||
    decisionContext.nonInteractive === true

  // Step 3: Non-interactive bypass (AC4)
  if (isNonInteractive) {
    // Emit halt-skipped event via optional callback
    const haltSkippedPayload: HaltSkippedPayload = {
      runId,
      decisionType: decisionContext.decisionType,
      severity: decisionContext.severity,
      defaultAction: decisionContext.defaultAction,
      reason: 'non-interactive: stdin prompt suppressed',
    }
    decisionContext.onHaltSkipped?.(haltSkippedPayload)
    logger.debug({ runId, decisionType: decisionContext.decisionType }, 'non-interactive mode: returning default action')

    // DO NOT update notification file — leave operatorChoice: null per AC5
    // ("leave null if non-interactive")

    return decisionContext.defaultAction
  }

  // Step 4: TTY guard — defensive default if stdin is not a TTY
  if (!process.stdin.isTTY) {
    logger.warn(
      { runId, decisionType: decisionContext.decisionType },
      'stdin is not a TTY — treating as non-interactive and returning default action',
    )
    // DO NOT update notification file — leave operatorChoice: null (treated as non-interactive)
    return decisionContext.defaultAction
  }

  // Step 5: Render the numbered-choice prompt (AC2)
  renderPrompt(decisionContext)

  // Step 6: Read one line from stdin via readline.createInterface (AC3)
  const chosenAction = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.once('line', (line) => {
      rl.close()
      const choice = parseChoice(line)
      resolve(mapChoiceToAction(choice, decisionContext.defaultAction))
    })
    // Handle EOF / closed stdin — default to choice 1
    rl.once('close', () => {
      resolve(decisionContext.defaultAction)
    })
  })

  // Step 7: Update notification file with the operator's choice (AC5, AC7)
  if (notifPath) {
    await updateNotificationChoice(notifPath, chosenAction)
  }

  return chosenAction
}
