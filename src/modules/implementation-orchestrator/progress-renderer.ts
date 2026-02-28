/**
 * Human-readable progress renderer for the pipeline.
 *
 * Consumes `PipelineEvent` objects and renders a compact, updating progress
 * display to the terminal — similar to `npm install` or `docker build` output.
 *
 * Modes:
 *   - TTY mode:     uses ANSI cursor control for in-place line updates.
 *   - Non-TTY mode: appends new lines without cursor manipulation.
 *
 * Color support: renders yellow warnings when TTY supports color.
 * Respects `NO_COLOR` env var (https://no-color.org/).
 *
 * This renderer does NOT handle raw pino log suppression — that is handled
 * in the caller (auto.ts) by setting pino level to 'silent'.
 */

import type { Writable } from 'node:stream'
import type {
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  StoryPhaseEvent,
  StoryDoneEvent,
  StoryEscalationEvent,
  StoryWarnEvent,
} from './event-types.js'

// ---------------------------------------------------------------------------
// ANSI helpers (no external dependencies)
// ---------------------------------------------------------------------------

/** True when color output is allowed (TTY + NO_COLOR not set). */
function supportsColor(stream: Writable): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  // Cast to NodeJS.WriteStream to access isTTY
  return (stream as NodeJS.WriteStream).isTTY === true
}

const ANSI_RESET = '\x1b[0m'
const ANSI_YELLOW = '\x1b[33m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_RED = '\x1b[31m'

/** Move cursor up N lines and clear from cursor to end of screen. */
function cursorUpAndClear(n: number): string {
  if (n <= 0) return ''
  // \x1b[{n}A = cursor up N lines, \x1b[J = erase from cursor to end of screen
  return `\x1b[${n}A\x1b[J`
}

// ---------------------------------------------------------------------------
// Internal state tracking
// ---------------------------------------------------------------------------

/**
 * Per-story progress state tracked by the renderer.
 */
interface StoryState {
  /** Current phase label (e.g., 'create', 'dev', 'review', 'fix') */
  phase: string
  /** Current status (e.g., 'queued', 'in-progress', 'done', 'escalated') */
  statusLabel: string
  /** True when story has reached a terminal state */
  terminal: boolean
  /** Number of review cycles (for SHIP_IT display) */
  reviewCycles: number
  /** Escalation reason (populated on escalation) */
  escalationReason?: string
}

// ---------------------------------------------------------------------------
// ProgressRenderer interface
// ---------------------------------------------------------------------------

/**
 * Public interface for the progress renderer.
 */
export interface ProgressRenderer {
  /**
   * Feed a pipeline event to the renderer.
   * The renderer updates its internal state and redraws.
   */
  render(event: PipelineEvent): void
}

// ---------------------------------------------------------------------------
// Phase label mapping
// ---------------------------------------------------------------------------

function phaseToLabel(phase: string): string {
  switch (phase) {
    case 'create-story':
      return 'create'
    case 'dev-story':
      return 'dev'
    case 'code-review':
      return 'review'
    case 'fix':
      return 'fix'
    default:
      return phase
  }
}

// ---------------------------------------------------------------------------
// createProgressRenderer
// ---------------------------------------------------------------------------

/**
 * Factory that creates a `ProgressRenderer` bound to the given output stream.
 *
 * @param stream - Writable stream to render progress to (e.g., `process.stdout`).
 * @param isTTY  - Override for TTY detection (useful in tests). Defaults to
 *                 `(stream as NodeJS.WriteStream).isTTY`.
 */
export function createProgressRenderer(
  stream: Writable,
  isTTY?: boolean,
): ProgressRenderer {
  const tty = isTTY !== undefined ? isTTY : (stream as NodeJS.WriteStream).isTTY === true
  const color = tty && process.env.NO_COLOR === undefined

  // Ordered list of story keys (insertion order from pipeline:start)
  const storyOrder: string[] = []
  // Per-story state map
  const storyState = new Map<string, StoryState>()

  // Header line (e.g., "substrate auto run — 6 stories, concurrency 3")
  let headerLine = ''

  // Number of lines we last rendered (used to overwrite in TTY mode)
  let lastRenderedLines = 0

  // Whether we've received pipeline:complete
  let pipelineComplete = false

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function write(text: string): void {
    try {
      stream.write(text)
    } catch {
      // Swallow write errors
    }
  }

  function colorize(text: string, ansiCode: string): string {
    if (!color) return text
    return `${ansiCode}${text}${ANSI_RESET}`
  }

  /**
   * Build display lines for each tracked story.
   */
  function buildStoryLines(): string[] {
    const lines: string[] = []
    for (const key of storyOrder) {
      const state = storyState.get(key)
      if (state === undefined) continue

      const phaseLabel = state.phase.padEnd(6)
      let statusText = state.statusLabel

      if (state.terminal) {
        if (state.phase === 'done') {
          const cycleWord = state.reviewCycles === 1 ? 'cycle' : 'cycles'
          statusText = colorize(
            `SHIP_IT (${state.reviewCycles} ${cycleWord})`,
            ANSI_GREEN,
          )
        } else if (state.phase === 'escalated') {
          statusText = colorize(
            `ESCALATED${state.escalationReason ? ' — ' + state.escalationReason : ''}`,
            ANSI_RED,
          )
        } else if (state.phase === 'failed') {
          statusText = colorize('FAILED', ANSI_RED)
        }
      }

      lines.push(`[${phaseLabel}] ${key} ${statusText}`)
    }
    return lines
  }

  /**
   * Redraw the progress display.
   *
   * In TTY mode:  erase previous output and re-render all lines in-place.
   * In non-TTY mode: just append the new status line (no cursor manipulation).
   */
  function redraw(newStatusLine?: string): void {
    if (pipelineComplete) return

    if (tty) {
      // Erase previous render
      if (lastRenderedLines > 0) {
        write(cursorUpAndClear(lastRenderedLines))
      }

      const lines: string[] = []
      if (headerLine) lines.push(headerLine)
      if (storyOrder.length > 0) {
        lines.push('')
        lines.push(...buildStoryLines())
        lines.push('')
      }

      const output = lines.join('\n') + (lines.length > 0 ? '\n' : '')
      write(output)
      lastRenderedLines = lines.length
    } else {
      // Non-TTY: just append a line
      if (newStatusLine !== undefined) {
        write(newStatusLine + '\n')
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleStart(event: PipelineStartEvent): void {
    headerLine = `substrate auto run — ${event.stories.length} stories, concurrency ${event.concurrency}`

    for (const key of event.stories) {
      storyOrder.push(key)
      storyState.set(key, {
        phase: 'wait',
        statusLabel: 'queued',
        terminal: false,
        reviewCycles: 0,
      })
    }

    if (tty) {
      redraw()
    } else {
      write(headerLine + '\n')
      write('\n')
    }
  }

  function handleStoryPhase(event: StoryPhaseEvent): void {
    let state = storyState.get(event.key)
    if (state === undefined) {
      // Story wasn't in pipeline:start — add it now
      storyOrder.push(event.key)
      state = {
        phase: 'wait',
        statusLabel: 'queued',
        terminal: false,
        reviewCycles: 0,
      }
      storyState.set(event.key, state)
    }

    const label = phaseToLabel(event.phase)

    if (event.status === 'in_progress') {
      state.phase = label
      state.statusLabel = statusInProgressLabel(event.phase)
    } else if (event.status === 'complete') {
      state.phase = label
      state.statusLabel = statusCompleteLabel(event.phase, event.verdict)
    } else if (event.status === 'failed') {
      state.phase = label
      state.statusLabel = 'failed'
    }

    const nonTtyLine = `[${label.padEnd(6)}] ${event.key} ${state.statusLabel}`
    redraw(nonTtyLine)
  }

  function statusInProgressLabel(phase: string): string {
    switch (phase) {
      case 'create-story':
        return 'creating story...'
      case 'dev-story':
        return 'implementing...'
      case 'code-review':
        return 'reviewing...'
      case 'fix':
        return 'fixing issues...'
      default:
        return 'in progress...'
    }
  }

  function statusCompleteLabel(phase: string, verdict?: string): string {
    switch (phase) {
      case 'create-story':
        return 'story created'
      case 'dev-story':
        return 'implemented'
      case 'code-review':
        return verdict !== undefined ? `reviewed (${verdict})` : 'reviewed'
      case 'fix':
        return 'fixes applied'
      default:
        return 'complete'
    }
  }

  function handleStoryDone(event: StoryDoneEvent): void {
    let state = storyState.get(event.key)
    if (state === undefined) {
      storyOrder.push(event.key)
      state = {
        phase: 'done',
        statusLabel: '',
        terminal: true,
        reviewCycles: event.review_cycles,
      }
      storyState.set(event.key, state)
    } else {
      state.phase = event.result === 'success' ? 'done' : 'failed'
      state.terminal = true
      state.reviewCycles = event.review_cycles
    }

    const cycleWord = event.review_cycles === 1 ? 'cycle' : 'cycles'
    const nonTtyLine =
      event.result === 'success'
        ? `[done  ] ${event.key} SHIP_IT (${event.review_cycles} ${cycleWord})`
        : `[failed] ${event.key} FAILED`

    redraw(nonTtyLine)
  }

  function handleEscalation(event: StoryEscalationEvent): void {
    let state = storyState.get(event.key)
    if (state === undefined) {
      storyOrder.push(event.key)
      state = {
        phase: 'escalated',
        statusLabel: '',
        terminal: true,
        reviewCycles: event.cycles,
        escalationReason: event.reason,
      }
      storyState.set(event.key, state)
    } else {
      state.phase = 'escalated'
      state.terminal = true
      state.reviewCycles = event.cycles
      state.escalationReason = event.reason
    }

    const nonTtyLine = `[escalated] ${event.key} — ${event.reason}`
    redraw(nonTtyLine)
  }

  function handleWarn(event: StoryWarnEvent): void {
    const line = colorize(`  warning [${event.key}]: ${event.msg}`, ANSI_YELLOW)
    if (tty) {
      // In TTY mode, print the warning above the progress display
      // by writing it and then re-rendering the display
      if (lastRenderedLines > 0) {
        write(cursorUpAndClear(lastRenderedLines))
      }
      write(line + '\n')
      // Reset lastRenderedLines so redraw starts fresh
      lastRenderedLines = 0
      redraw()
    } else {
      write(line + '\n')
    }
  }

  function handleComplete(event: PipelineCompleteEvent): void {
    pipelineComplete = true

    if (tty && lastRenderedLines > 0) {
      write(cursorUpAndClear(lastRenderedLines))
    }

    // Final TTY display with all story states
    if (tty && headerLine) {
      write(headerLine + '\n')
      write('\n')
      for (const line of buildStoryLines()) {
        write(line + '\n')
      }
      write('\n')
    }

    // Summary block
    const succeeded = event.succeeded.length
    const failed = event.failed.length
    const escalated = event.escalated.length

    write(`Pipeline complete: ${succeeded} succeeded, ${failed} failed, ${escalated} escalated\n`)

    if (failed > 0) {
      for (const key of event.failed) {
        write(`  failed: ${key}\n`)
      }
    }

    if (escalated > 0) {
      for (const key of event.escalated) {
        const state = storyState.get(key)
        const reason = state?.escalationReason ?? 'escalated'
        write(`  escalated: ${key} — ${reason}\n`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public render method
  // ---------------------------------------------------------------------------

  function render(event: PipelineEvent): void {
    switch (event.type) {
      case 'pipeline:start':
        handleStart(event)
        break
      case 'story:phase':
        handleStoryPhase(event)
        break
      case 'story:done':
        handleStoryDone(event)
        break
      case 'story:escalation':
        handleEscalation(event)
        break
      case 'story:warn':
        handleWarn(event)
        break
      case 'pipeline:complete':
        handleComplete(event)
        break
      default:
        // story:log and any future events — silently ignore
        break
    }
  }

  return { render }
}
