/**
 * TUI Dashboard types for substrate auto run --tui
 *
 * These types define the internal state model used by the TUI components.
 */

// ---------------------------------------------------------------------------
// Story status types
// ---------------------------------------------------------------------------

/**
 * Color-coded status for a story row in the TUI.
 */
export type StoryStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'escalated'

/**
 * Current phase label for a story.
 */
export type StoryPhaseLabel = 'wait' | 'create' | 'dev' | 'review' | 'fix' | 'done' | 'escalated' | 'failed'

/**
 * Per-story state tracked by the TUI.
 */
export interface TuiStoryState {
  /** Story key (e.g., "10-1") */
  key: string
  /** Current phase */
  phase: StoryPhaseLabel
  /** Status for color-coding */
  status: StoryStatus
  /** Human-readable status label */
  statusLabel: string
  /** Number of review cycles */
  reviewCycles: number
  /** Escalation reason if escalated */
  escalationReason?: string
}

/**
 * A log entry displayed in the log panel.
 */
export interface TuiLogEntry {
  /** Timestamp (ISO-8601) */
  ts: string
  /** Story key that generated this log */
  key: string
  /** Log message */
  msg: string
  /** Log level */
  level: 'log' | 'warn'
}

/**
 * TUI view modes.
 */
export type TuiView = 'overview' | 'detail' | 'help'

/**
 * Overall TUI application state.
 */
export interface TuiState {
  /** Header line (pipeline info) */
  headerLine: string
  /** Ordered list of story keys */
  storyOrder: string[]
  /** Per-story state */
  stories: Map<string, TuiStoryState>
  /** Log entries */
  logs: TuiLogEntry[]
  /** Currently selected story index (for keyboard navigation) */
  selectedIndex: number
  /** Currently active view */
  view: TuiView
  /** Whether pipeline has completed */
  pipelineComplete: boolean
  /** Pipeline completion stats */
  completionStats?: {
    succeeded: string[]
    failed: string[]
    escalated: string[]
  }
}
