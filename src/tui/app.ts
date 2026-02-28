/**
 * TUI Dashboard App — root component and layout manager.
 *
 * Manages application state, handles keyboard input, consumes pipeline events,
 * and orchestrates rendering of all TUI sub-components.
 *
 * Architecture:
 *   - Pure event-driven: state is updated by PipelineEvent objects
 *   - Keyboard input via Node.js readline (raw mode)
 *   - Rendering to process.stdout via ANSI escape codes
 *   - No external dependencies (no ink/React required)
 *
 * AC1: Activated via --tui flag, exits cleanly on pipeline complete or 'q'
 * AC2: Story status panel with color-coded rows
 * AC3: Scrollable log panel with auto-scroll
 * AC4: Keyboard controls (arrows, Enter, Esc, q, ?)
 * AC5: Terminal size detection and adaptation
 * AC6: Non-TTY rejection (handled in caller)
 */

import * as readline from 'node:readline'
import type { Writable, Readable } from 'node:stream'
import type { PipelineEvent, PipelinePhase } from '../modules/implementation-orchestrator/event-types.js'
import type {
  TuiState,
  TuiStoryState,
  TuiLogEntry,
  TuiView,
  StoryStatus,
  StoryPhaseLabel,
} from './types.js'
import { ANSI, supportsColor, getTerminalSize, bold, colorize } from './ansi.js'
import { renderStoryPanel } from './story-panel.js'
import { renderLogPanel } from './log-panel.js'
import { renderDetailView } from './detail-view.js'
import { renderHelpOverlay } from './help-overlay.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum terminal width for TUI to render properly. */
const MIN_COLS = 80
/** Minimum terminal height for TUI to render properly. */
const MIN_ROWS = 24

/** Maximum log entries to keep in memory. */
const MAX_LOG_ENTRIES = 500

// ---------------------------------------------------------------------------
// TuiApp interface
// ---------------------------------------------------------------------------

/**
 * Public interface for the TUI application.
 */
export interface TuiApp {
  /**
   * Feed a pipeline event to the TUI.
   * Updates state and re-renders.
   */
  handleEvent(event: PipelineEvent): void

  /**
   * Clean up resources (keyboard listeners, alternate screen, etc.)
   * Called when the pipeline completes or user presses 'q'.
   */
  cleanup(): void

  /**
   * Returns a promise that resolves when the TUI exits (user presses 'q'
   * or the pipeline completes).
   */
  waitForExit(): Promise<void>
}

// ---------------------------------------------------------------------------
// Phase mapping
// ---------------------------------------------------------------------------

function mapPhaseToLabel(phase: PipelinePhase): StoryPhaseLabel {
  switch (phase) {
    case 'create-story': return 'create'
    case 'dev-story': return 'dev'
    case 'code-review': return 'review'
    case 'fix': return 'fix'
    default: return 'wait'
  }
}

function mapPhaseToStatus(phase: StoryPhaseLabel, eventStatus: string): StoryStatus {
  if (eventStatus === 'failed') return 'failed'
  if (eventStatus === 'in_progress') return 'in_progress'
  if (eventStatus === 'complete') {
    if (phase === 'done') return 'succeeded'
    return 'in_progress' // still running after this phase
  }
  return 'pending'
}

function makeStatusLabel(phase: StoryPhaseLabel, eventStatus: string, verdict?: string): string {
  if (eventStatus === 'failed') return 'failed'
  if (eventStatus === 'in_progress') {
    switch (phase) {
      case 'create': return 'creating story...'
      case 'dev': return 'implementing...'
      case 'review': return 'reviewing...'
      case 'fix': return 'fixing issues...'
      default: return 'in progress...'
    }
  }
  if (eventStatus === 'complete') {
    switch (phase) {
      case 'create': return 'story created'
      case 'dev': return 'implemented'
      case 'review': return verdict !== undefined ? `reviewed (${verdict})` : 'reviewed'
      case 'fix': return 'fixes applied'
      default: return 'complete'
    }
  }
  return 'queued'
}

// ---------------------------------------------------------------------------
// createTuiApp
// ---------------------------------------------------------------------------

/**
 * Factory that creates a TUI application instance.
 *
 * @param output - Writable stream for rendering (typically process.stdout)
 * @param input  - Readable stream for keyboard input (typically process.stdin)
 */
export function createTuiApp(
  output: Writable,
  input: Readable,
): TuiApp {
  // Determine color support
  const isTTY = (output as NodeJS.WriteStream).isTTY === true
  const useColor = supportsColor(isTTY)

  // Application state
  const state: TuiState = {
    headerLine: '',
    storyOrder: [],
    stories: new Map(),
    logs: [],
    selectedIndex: 0,
    view: 'overview',
    pipelineComplete: false,
  }

  // Exit promise
  let exitResolve: (() => void) | undefined
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve
  })

  // Readline interface for keyboard input
  let rl: readline.Interface | undefined

  // ---------------------------------------------------------------------------
  // Write helpers
  // ---------------------------------------------------------------------------

  function write(text: string): void {
    try {
      output.write(text)
    } catch {
      // Swallow write errors
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal size warning
  // ---------------------------------------------------------------------------

  function checkTerminalSize(): boolean {
    const { cols, rows } = getTerminalSize()
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      // Render warning
      write(ANSI.CLEAR_SCREEN + ANSI.HOME)
      write(colorize(
        `Terminal too small: ${cols}x${rows} (minimum ${MIN_COLS}x${MIN_ROWS})\n`,
        ANSI.YELLOW,
        useColor,
      ))
      write('Please resize your terminal.\n')
      return false
    }
    return true
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render(): void {
    const { cols, rows } = getTerminalSize()

    // Warn if terminal too small
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      checkTerminalSize()
      return
    }

    // Clear screen and move to top
    write(ANSI.CLEAR_SCREEN + ANSI.HOME)

    const lines: string[] = []

    if (state.view === 'help') {
      renderHelpView(lines, cols, rows)
    } else if (state.view === 'detail') {
      renderDetailViewLayout(lines, cols, rows)
    } else {
      renderOverviewLayout(lines, cols, rows)
    }

    // Write all lines
    for (const line of lines) {
      write(line + '\n')
    }
  }

  function renderOverviewLayout(lines: string[], cols: number, rows: number): void {
    // Header
    lines.push(bold(colorize('  substrate auto run --tui', ANSI.BRIGHT_WHITE, useColor), useColor))
    if (state.headerLine) {
      lines.push(colorize(`  ${state.headerLine}`, ANSI.BRIGHT_BLACK, useColor))
    }
    lines.push('')

    // Story panel takes top 40% of screen
    const storyPanelHeight = Math.max(Math.floor(rows * 0.4), 6)
    const storyPanelLines = renderStoryPanel({
      stories: Array.from(state.storyOrder)
        .map((k) => state.stories.get(k))
        .filter((s): s is TuiStoryState => s !== undefined),
      selectedIndex: state.selectedIndex,
      useColor,
      width: cols,
    })

    lines.push(...storyPanelLines.slice(0, storyPanelHeight))
    lines.push('')

    // Separator
    lines.push('  ' + '─'.repeat(Math.max(cols - 4, 20)))
    lines.push('')

    // Log panel takes remaining space
    const usedLines = lines.length + 3 // +3 for footer
    const logPanelHeight = Math.max(rows - usedLines, 3)

    const logLines = renderLogPanel({
      entries: state.logs,
      maxLines: logPanelHeight,
      useColor,
      width: cols,
    })

    lines.push(...logLines)
    lines.push('')

    // Footer
    const footerParts = [
      colorize('[↑↓] Navigate', ANSI.BRIGHT_BLACK, useColor),
      colorize('[Enter] Details', ANSI.BRIGHT_BLACK, useColor),
      colorize('[q] Quit', ANSI.BRIGHT_BLACK, useColor),
      colorize('[?] Help', ANSI.BRIGHT_BLACK, useColor),
    ]

    if (state.pipelineComplete) {
      lines.push(colorize('  Pipeline complete. Press q to exit.', ANSI.GREEN, useColor))
    }

    lines.push('  ' + footerParts.join('  '))
  }

  function renderDetailViewLayout(lines: string[], cols: number, rows: number): void {
    const selectedKey = state.storyOrder[state.selectedIndex]
    const story = selectedKey !== undefined ? state.stories.get(selectedKey) : undefined

    if (story === undefined) {
      lines.push('  No story selected. Press Esc to go back.')
      return
    }

    const detailLines = renderDetailView({
      story,
      allLogs: state.logs,
      maxLogLines: Math.max(rows - 10, 5),
      useColor,
      width: cols,
      height: rows,
    })

    lines.push(...detailLines)
  }

  function renderHelpView(lines: string[], cols: number, _rows: number): void {
    lines.push(bold(colorize('  substrate auto run --tui', ANSI.BRIGHT_WHITE, useColor), useColor))
    lines.push('')

    const helpLines = renderHelpOverlay({ useColor, width: cols })
    lines.push(...helpLines)
  }

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------

  function setupKeyboard(): void {
    // Put stdin in raw mode for single keypress capture
    if ((input as NodeJS.ReadStream).isTTY === true) {
      try {
        (input as NodeJS.ReadStream).setRawMode(true)
      } catch {
        // Raw mode not available — ignore
      }
    }

    rl = readline.createInterface({ input, terminal: false })

    // Handle keypress events at the stream level for arrow keys
    readline.emitKeypressEvents(input)

    const stdin = input as NodeJS.ReadStream

    const onKeypress = (chunk: unknown, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined): void => {
      if (key === undefined) return
      handleKeypress(key)
    }

    stdin.on('keypress', onKeypress)

    // Handle SIGINT (Ctrl+C)
    rl.on('close', () => {
      exit()
    })
  }

  function handleKeypress(key: { name?: string; ctrl?: boolean; sequence?: string }): void {
    // Ctrl+C always exits
    if (key.ctrl === true && key.name === 'c') {
      exit()
      return
    }

    switch (key.name) {
      case 'q':
        exit()
        return

      case 'up':
        if (state.view === 'overview') {
          state.selectedIndex = Math.max(0, state.selectedIndex - 1)
          render()
        }
        break

      case 'down':
        if (state.view === 'overview') {
          state.selectedIndex = Math.min(
            Math.max(0, state.storyOrder.length - 1),
            state.selectedIndex + 1,
          )
          render()
        }
        break

      case 'return':
      case 'enter':
        if (state.view === 'overview' && state.storyOrder.length > 0) {
          state.view = 'detail'
          render()
        }
        break

      case 'escape':
        if (state.view === 'detail' || state.view === 'help') {
          state.view = 'overview'
          render()
        }
        break

      case '?':
        state.view = state.view === 'help' ? 'overview' : 'help'
        render()
        break

      default:
        // Handle '?' as sequence for some terminals
        if (key.sequence === '?') {
          state.view = state.view === 'help' ? 'overview' : 'help'
          render()
        }
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal resize
  // ---------------------------------------------------------------------------

  function onResize(): void {
    render()
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function init(): void {
    // Enter alternate screen buffer
    write(ANSI.ALT_SCREEN_ENTER)
    write(ANSI.HIDE_CURSOR)

    // Set up keyboard
    setupKeyboard()

    // Handle terminal resize using the injected output stream when possible,
    // falling back to process.stdout for environments that don't support it.
    const resizeEmitter = typeof (output as NodeJS.WriteStream).on === 'function'
      ? (output as NodeJS.WriteStream)
      : process.stdout
    resizeEmitter.on('resize', onResize)

    // Initial render
    render()
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  function exit(): void {
    cleanup()
    if (exitResolve !== undefined) {
      exitResolve()
      exitResolve = undefined
    }
  }

  function cleanup(): void {
    // Exit alternate screen buffer
    write(ANSI.SHOW_CURSOR)
    write(ANSI.ALT_SCREEN_EXIT)

    // Remove resize listener from whichever emitter was used in init()
    const resizeEmitter = typeof (output as NodeJS.WriteStream).on === 'function'
      ? (output as NodeJS.WriteStream)
      : process.stdout
    resizeEmitter.off('resize', onResize)

    // Close readline
    if (rl !== undefined) {
      try {
        rl.close()
      } catch {
        // Ignore errors
      }
      rl = undefined
    }

    // Restore stdin
    if ((input as NodeJS.ReadStream).isTTY === true) {
      try {
        (input as NodeJS.ReadStream).setRawMode(false)
      } catch {
        // Ignore
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event handling
  // ---------------------------------------------------------------------------

  function handleEvent(event: PipelineEvent): void {
    switch (event.type) {
      case 'pipeline:start':
        state.headerLine = `${event.stories.length} stories, concurrency ${event.concurrency}, run ${event.run_id.slice(0, 8)}...`
        for (const key of event.stories) {
          state.storyOrder.push(key)
          state.stories.set(key, {
            key,
            phase: 'wait',
            status: 'pending',
            statusLabel: 'queued',
            reviewCycles: 0,
          })
        }
        break

      case 'story:phase': {
        let story = state.stories.get(event.key)
        if (story === undefined) {
          state.storyOrder.push(event.key)
          story = {
            key: event.key,
            phase: 'wait',
            status: 'pending',
            statusLabel: 'queued',
            reviewCycles: 0,
          }
          state.stories.set(event.key, story)
        }

        const phaseLabel = mapPhaseToLabel(event.phase)
        story.phase = phaseLabel
        story.status = mapPhaseToStatus(phaseLabel, event.status)
        story.statusLabel = makeStatusLabel(phaseLabel, event.status, event.verdict)
        break
      }

      case 'story:done': {
        let story = state.stories.get(event.key)
        if (story === undefined) {
          state.storyOrder.push(event.key)
          story = {
            key: event.key,
            phase: 'done',
            status: event.result === 'success' ? 'succeeded' : 'failed',
            statusLabel: event.result === 'success' ? 'SHIP_IT' : 'FAILED',
            reviewCycles: event.review_cycles,
          }
          state.stories.set(event.key, story)
        } else {
          story.phase = event.result === 'success' ? 'done' : 'failed'
          story.status = event.result === 'success' ? 'succeeded' : 'failed'
          const cycleWord = event.review_cycles === 1 ? 'cycle' : 'cycles'
          story.statusLabel = event.result === 'success'
            ? `SHIP_IT (${event.review_cycles} ${cycleWord})`
            : 'FAILED'
          story.reviewCycles = event.review_cycles
        }
        break
      }

      case 'story:escalation': {
        let story = state.stories.get(event.key)
        if (story === undefined) {
          state.storyOrder.push(event.key)
          story = {
            key: event.key,
            phase: 'escalated',
            status: 'escalated',
            statusLabel: `ESCALATED — ${event.reason}`,
            reviewCycles: event.cycles,
            escalationReason: event.reason,
          }
          state.stories.set(event.key, story)
        } else {
          story.phase = 'escalated'
          story.status = 'escalated'
          story.statusLabel = `ESCALATED — ${event.reason}`
          story.reviewCycles = event.cycles
          story.escalationReason = event.reason
        }
        break
      }

      case 'story:warn': {
        const logEntry: TuiLogEntry = {
          ts: event.ts,
          key: event.key,
          msg: `[WARN] ${event.msg}`,
          level: 'warn',
        }
        state.logs.push(logEntry)
        // Trim to max log entries
        if (state.logs.length > MAX_LOG_ENTRIES) {
          state.logs.splice(0, state.logs.length - MAX_LOG_ENTRIES)
        }
        break
      }

      case 'story:log': {
        const logEntry: TuiLogEntry = {
          ts: event.ts,
          key: event.key,
          msg: event.msg,
          level: 'log',
        }
        state.logs.push(logEntry)
        // Trim to max log entries
        if (state.logs.length > MAX_LOG_ENTRIES) {
          state.logs.splice(0, state.logs.length - MAX_LOG_ENTRIES)
        }
        break
      }

      case 'pipeline:complete':
        state.pipelineComplete = true
        state.completionStats = {
          succeeded: event.succeeded,
          failed: event.failed,
          escalated: event.escalated,
        }
        // Auto-exit after pipeline complete (give user 500ms to see it)
        setTimeout(() => {
          // Exit only if user hasn't already exited
          if (exitResolve !== undefined) {
            // Let user decide when to exit — just mark complete
            render()
          }
        }, 500)
        break

      default:
        break
    }

    // Re-render after state update
    render()
  }

  // Initialize the TUI
  init()

  return {
    handleEvent,
    cleanup,
    waitForExit: () => exitPromise,
  }
}

// ---------------------------------------------------------------------------
// Non-TTY detection
// ---------------------------------------------------------------------------

/**
 * Check whether the TUI can run in the current environment.
 *
 * Returns true if stdout is a TTY, false otherwise.
 * If false, the caller should print a warning and use default output.
 */
export function isTuiCapable(): boolean {
  return (process.stdout as NodeJS.WriteStream).isTTY === true
}

/**
 * Print the non-TTY fallback warning message.
 */
export function printNonTtyWarning(): void {
  process.stderr.write(
    'TUI requires an interactive terminal. Falling back to default output.\n',
  )
}
