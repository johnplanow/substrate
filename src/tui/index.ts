/**
 * TUI Dashboard module for substrate auto run --tui
 *
 * Exports the main TUI application factory and non-TTY detection utilities.
 */

export { createTuiApp, isTuiCapable, printNonTtyWarning } from './app.js'
export type { TuiApp } from './app.js'
export type {
  TuiState,
  TuiStoryState,
  TuiLogEntry,
  TuiView,
  StoryStatus,
  StoryPhaseLabel,
} from './types.js'
