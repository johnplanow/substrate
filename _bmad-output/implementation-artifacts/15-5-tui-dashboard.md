# Story 15.5: TUI Dashboard

Status: draft
Blocked-by: 15-1

## Story

As a developer monitoring a long-running pipeline,
I want a rich terminal UI with story status panels, live logs, and keyboard controls,
so that I can observe progress at a glance and interact with the pipeline without switching tools.

## Context

This is the "Option A" rendering layer — a full TUI dashboard that consumes the event protocol from Story 15-1. It is an optional mode activated via `--tui` flag, layered on top of the event stream architecture. The TUI is a pure consumer — it renders events, it does not own pipeline state.

This story is a stretch goal / Sprint 2 item. The MVP (Stories 15-1 through 15-4) delivers full functionality without it.

## Acceptance Criteria

### AC1: --tui Flag
**Given** the user runs `substrate auto run --tui`
**When** the pipeline executes
**Then** a full-screen terminal UI is rendered
**And** the TUI replaces both the default progress output and raw event output
**And** the TUI exits cleanly when the pipeline completes or the user presses `q`

### AC2: Story Status Panel
**Given** the TUI is active
**When** stories progress through phases
**Then** each story is displayed as a row with: key, current phase, status indicator (color-coded)
**And** pending stories show as gray, in-progress as yellow, succeeded as green, failed as red
**And** the panel updates in real-time as events arrive

### AC3: Log Panel
**Given** the TUI is active
**When** `story:warn` or `story:log` events arrive
**Then** they are displayed in a scrollable log panel below the story status panel
**And** logs are prefixed with the story key and timestamp
**And** the log panel auto-scrolls to the latest entry

### AC4: Keyboard Controls
**Given** the TUI is active
**Then** the following keyboard controls are available:
- Arrow keys: navigate between stories in the status panel
- `Enter`: drill into selected story's detailed log view
- `Esc`: return to overview from detail view
- `q`: quit TUI (pipeline continues in background or is cancelled — TBD)
- `?`: show help overlay

### AC5: Terminal Compatibility
**Given** the user's terminal
**When** `--tui` is activated
**Then** the TUI detects terminal size and adapts layout
**And** minimum terminal size is 80x24 (shows warning if smaller)
**And** the TUI handles terminal resize events gracefully

### AC6: Non-TTY Rejection
**Given** stdout is not a TTY (piped, CI, non-interactive)
**When** `--tui` is passed
**Then** the TUI is not activated
**And** a warning is printed: "TUI requires an interactive terminal. Falling back to default output."
**And** default progress output is used instead

## Dev Notes

### Architecture

- Framework recommendation: `ink` (React for CLIs)
  - TypeScript-native, composable components, built-in test renderer
  - Active maintenance, used by Vercel CLI, Gatsby, etc.
  - Alternative: `blessed` / `neo-blessed` — more powerful but unmaintained
- New directory: `src/tui/`
  - `App.tsx` — root component, layout management
  - `StoryPanel.tsx` — story status rows
  - `LogPanel.tsx` — scrollable log display
  - `DetailView.tsx` — per-story drill-down
  - `HelpOverlay.tsx` — keyboard shortcut reference
- Event consumption: TUI subscribes to the same `PipelineEvent` stream
  - Internal event emitter (not stdout) feeds the TUI components
  - React state updates driven by events

### Testing Strategy

- Use `ink-testing-library` for component rendering tests
- Event sequence fixtures from Story 15-1 tests (reuse)
- Manual QA checklist for visual correctness, keyboard interaction, resize handling
- Do NOT attempt screenshot/visual regression testing — too brittle for a v1

### Open Questions

- Should `q` quit the TUI only (pipeline continues in background) or cancel the pipeline?
- Should the TUI support mouse interaction (click on story to drill in)?
- Color theme: respect terminal theme or force specific colors?

## Tasks

- [ ] Evaluate and install `ink` + `react` dependencies
- [ ] Create TUI directory structure and root `App.tsx`
- [ ] Implement `StoryPanel` component with color-coded status rows
- [ ] Implement `LogPanel` component with auto-scrolling
- [ ] Implement `DetailView` for per-story drill-down
- [ ] Implement `HelpOverlay` for keyboard shortcuts
- [ ] Wire keyboard event handlers (arrow, enter, esc, q, ?)
- [ ] Add `--tui` flag to auto command
- [ ] Connect event stream to TUI components
- [ ] Handle terminal resize events
- [ ] Add non-TTY detection and fallback
- [ ] Write component tests with ink-testing-library
- [ ] Create manual QA checklist
