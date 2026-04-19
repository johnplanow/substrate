# Epic 15 — Pipeline Observability & Agent Integration
## Demo Walkthrough Script

### Executive Summary

Epic 15 implements complete end-to-end observability and agent integration for the Substrate autonomous pipeline. The five stories deliver:

1. **Event Protocol Foundation**: A typed NDJSON event emitter emits `PipelineEvent` objects as the pipeline runs, allowing external systems to consume and react to real-time execution state.
2. **Human-Readable Progress Output**: A lightweight progress renderer displays pipeline status in the terminal with TTY-aware formatting, auto-suppressing verbose logs by default.
3. **Agent Self-Documentation**: The `--help-agent` flag generates machine-optimized prompt fragments describing the event protocol and interaction patterns.
4. **CLAUDE.md Integration**: Auto-initialized projects now include a pre-populated substrate pipeline section guiding AI agents on expected behaviors and event handling.
5. **Interactive TUI Dashboard**: A terminal UI with story panels, log viewing, keyboard controls, and real-time event rendering provides rich monitoring capabilities.

This epic enables **both programmatic monitoring** (via events and JSON output) **and interactive human monitoring** (via progress bar and TUI), with automatic agent documentation generation supporting the broader agent integration roadmap.

---

## Key Features to Demonstrate
*Ordered by impact and user engagement*

### Feature 1: --events Flag — Structured NDJSON Event Stream
**Impact**: Enables downstream integrations (dashboards, monitoring systems, external agents) to consume pipeline state changes in real-time.

**What changed**:
- `src/modules/implementation-orchestrator/event-types.ts` defines 7 event types (pipeline:start, pipeline:complete, story:phase, story:done, story:escalation, story:warn, story:log)
- `src/modules/implementation-orchestrator/event-emitter.ts` provides fire-and-forget NDJSON emitter
- `src/cli/commands/auto.ts` wires event emitter when `--events` flag is passed

**Verification steps**:

1. **Run the pipeline with --events flag and observe NDJSON output**:
   ```bash
   # In a test project with at least one story (e.g., 10-1)
   substrate auto run --pack bmad --stories 10-1 --events 2>/dev/null | head -20
   ```
   Expected: Each line is valid JSON with `type` field matching one of the 7 event types.

2. **Parse events in a downstream script**:
   ```bash
   substrate auto run --pack bmad --stories 10-1 --events 2>/dev/null | jq '.type' | sort | uniq
   ```
   Expected: See event types like `pipeline:start`, `story:phase`, `story:done`, `pipeline:complete`.

3. **Verify --events suppresses default progress output**:
   ```bash
   # With --events, no progress bar should appear (only NDJSON on stdout)
   substrate auto run --pack bmad --stories 10-1 --events 2>/dev/null > /tmp/events.ndjson
   cat /tmp/events.ndjson | wc -l
   # Should be non-zero (multiple events)
   ```

4. **Inspect a story:phase event structure**:
   ```bash
   substrate auto run --pack bmad --stories 10-1 --events 2>/dev/null | jq 'select(.type=="story:phase") | .' | head -40
   ```
   Expected: Event contains `key`, `phase` (create-story|dev-story|code-review|fix), `status` (in_progress|complete|failed), optional `verdict` (code-review) or `file` (create-story).

---

### Feature 2: Human-Readable Progress Renderer
**Impact**: Makes terminal output approachable and professional, replacing verbose logs with a clean progress bar similar to npm install.

**What changed**:
- `src/modules/implementation-orchestrator/progress-renderer.ts` renders compact, updating story progress to terminal
- Detects TTY and uses ANSI cursor control for in-place updates
- Respects `NO_COLOR` environment variable
- Auto-suppresses pino logs (LOG_LEVEL=silent) when running without --verbose

**Verification steps**:

1. **Run without flags and observe progress bar**:
   ```bash
   substrate auto run --pack bmad --stories 10-1,10-2 --concurrency 2
   ```
   Expected: Terminal shows:
   - Header: `substrate auto run — 2 stories, concurrency 2`
   - Story rows updating in place: `[create ] 10-1 creating story...` → `[create ] 10-1 story created`
   - Final summary: `Pipeline complete: X succeeded, Y failed, Z escalated`

2. **Verify color output (yellow warnings)**:
   ```bash
   # Run a story that may generate warnings
   substrate auto run --pack bmad --stories 10-1 2>&1
   ```
   Expected: Any warnings appear in yellow (ANSI code \x1b[33m).

3. **Disable color with NO_COLOR**:
   ```bash
   NO_COLOR=1 substrate auto run --pack bmad --stories 10-1 2>&1 | head -10
   ```
   Expected: Output contains no ANSI escape codes; text is plain.

4. **Verify pino suppression (no verbose logs)**:
   ```bash
   # Default: no verbose logs
   substrate auto run --pack bmad --stories 10-1 2>&1 | grep -c '^\{' || echo "No JSON logs (expected)"
   ```
   Expected: Few or no raw JSON log lines in default output.

5. **Verify --verbose restores pino output**:
   ```bash
   substrate auto run --pack bmad --stories 10-1 --verbose 2>&1 | grep -c 'level' || true
   ```
   Expected: Some pino log lines appear when --verbose is set.

6. **Non-TTY mode (piped to file)**:
   ```bash
   substrate auto run --pack bmad --stories 10-1 > /tmp/pipeline.log 2>&1
   cat /tmp/pipeline.log
   ```
   Expected: Output is line-based (not using cursor movement), suitable for log files.

---

### Feature 3: --help-agent Self-Describing CLI
**Impact**: Allows AI agents to introspect the CLI and understand event protocol without external documentation, reducing integration friction.

**What changed**:
- `src/cli/commands/help-agent.ts` generates prompt fragment from hardcoded event metadata
- Metadata mirrors PipelineEvent type definitions to prevent drift
- Emits markdown with event descriptions, field documentation, and interaction patterns

**Verification steps**:

1. **Run --help-agent and observe output**:
   ```bash
   substrate auto --help-agent
   ```
   Expected: Outputs markdown prompt fragment (multi-line text starting with event protocol description).

2. **Verify event types are documented**:
   ```bash
   substrate auto --help-agent | grep -E "^\#\#\# (pipeline|story):" | head -10
   ```
   Expected: See section headers for each of the 7 event types.

3. **Inspect field documentation for a specific event**:
   ```bash
   substrate auto --help-agent | grep -A 20 "pipeline:start" | head -25
   ```
   Expected: See `run_id`, `stories`, `concurrency` fields with descriptions.

4. **Verify CLI flag documentation**:
   ```bash
   substrate auto --help-agent | grep -i "flag" | head -5
   ```
   Expected: Contains references to --events, --output-format json, --tui flags and their purposes.

5. **Check for interaction guidelines**:
   ```bash
   substrate auto --help-agent | grep -i "agent behavior\|escalation\|fix" | head -10
   ```
   Expected: Includes recommendations for agent behavior on escalation, fix cycles, and completion.

---

### Feature 4: CLAUDE.md Scaffold Integration
**Impact**: Automatically injects pipeline usage instructions into AI agent context when a new project is initialized, enabling agents to understand substrate without extra setup.

**What changed**:
- `src/cli/templates/claude-md-substrate-section.md` provides a markdown template
- `substrate auto init` injects this section into newly created CLAUDE.md (between <!-- substrate:start --> and <!-- substrate:end --> markers)
- Section includes quick start, --help-agent pointer, --events flag usage, and agent behavior guidelines

**Verification steps**:

1. **Create a fresh test project and initialize substrate**:
   ```bash
   mkdir /tmp/test-project-new && cd /tmp/test-project-new
   npm init -y
   substrate auto init --pack bmad --project-root .
   ```
   Expected: A CLAUDE.md file is created in the project root.

2. **Verify substrate section is present in CLAUDE.md**:
   ```bash
   grep -A 10 "## Substrate Pipeline" /tmp/test-project-new/CLAUDE.md
   ```
   Expected: Shows the scaffold section with Quick Start, Agent Behavior guidance.

3. **Check quick start links**:
   ```bash
   grep "help-agent" /tmp/test-project-new/CLAUDE.md
   ```
   Expected: Contains reference to `substrate auto --help-agent` command.

4. **Verify agent behavior guidelines are present**:
   ```bash
   grep "escalation\|failed story\|auto" /tmp/test-project-new/CLAUDE.md | head -5
   ```
   Expected: Contains guidelines like "On story escalation: read the flagged files and issues, propose a fix, ask the user before applying".

---

### Feature 5: Interactive TUI Dashboard
**Impact**: Provides a rich, scrollable terminal interface for monitoring complex multi-story pipelines in real-time, suitable for long-running processes.

**What changed**:
- `src/tui/` (8 source files) implements a zero-dependency terminal UI using Node.js readline and ANSI codes
- `src/tui/app.ts` (TUI root) orchestrates state, keyboard input, and rendering
- `src/tui/story-panel.ts` renders color-coded story progress rows
- `src/tui/log-panel.ts` provides scrollable log viewing
- `src/tui/detail-view.ts` shows issue details on escalation
- `src/tui/help-overlay.ts` displays keyboard shortcuts
- `src/cli/commands/auto.ts` wires TUI when --tui flag is used (requires TTY)

**Verification steps**:

1. **Launch the TUI dashboard**:
   ```bash
   # Run a multi-story pipeline with --tui
   substrate auto run --pack bmad --stories 10-1,10-2,10-3 --tui
   ```
   Expected:
   - Alternate screen buffer opens (terminal is cleared)
   - Header shows `substrate auto run — 3 stories, concurrency ...`
   - Story panel displays status rows (color-coded by phase)
   - Log panel on bottom shows real-time messages
   - Help overlay in corner shows keyboard shortcuts

2. **Verify story status color coding**:
   - Green for SHIP_IT (success)
   - Red for FAILED or ESCALATED
   - Yellow for warnings
   ```bash
   # Visual inspection during step 1; look for colors in story panel
   ```
   Expected: Stories show appropriate colors as they progress through phases.

3. **Test keyboard navigation**:
   - Press arrow keys to select stories (log detail view changes)
   - Press 'h' to toggle help overlay
   - Press 'q' to exit cleanly
   ```bash
   # During TUI session: press 'h' and observe help text overlay
   # Press 'q' and observe clean exit back to terminal prompt
   ```
   Expected: Help overlay appears/disappears; 'q' closes TUI without errors.

4. **Test non-TTY rejection**:
   ```bash
   # Pipe to file (non-TTY); --tui should be rejected with warning
   substrate auto run --pack bmad --stories 10-1 --tui < /dev/null 2>&1 | head -5
   ```
   Expected: Warning message like `TUI is only supported in an interactive terminal` and fallback to default output.

5. **Verify scrollable log panel**:
   ```bash
   # In TUI: observe log messages accumulate (up to 500 entries)
   # If log exceeds height, press up/down arrows to scroll
   ```
   Expected: Log panel shows scrollbar and updates as messages arrive; arrow keys scroll history.

6. **Inspect escalation detail view**:
   ```bash
   # If a story escalates: press Enter on that story to view issue details
   # Detail view should show file paths, severity, and descriptions
   ```
   Expected: Detail panel appears with structured escalation issue information.

---

## Surprising/Noteworthy Behaviors

### 1. Event Emission is Fire-and-Forget
The NDJSON emitter **does not wait for stream drain events**. This means:
- Events are emitted as rapidly as the pipeline generates them
- If a consumer pauses reading, the emitter does not block
- Broken pipes do not crash the pipeline (write errors are swallowed)

**Why it matters**: Enables use cases where the consumer is slower than the emitter (e.g., external monitoring service briefly unavailable).

### 2. Progress Renderer Uses Cursor Control to Avoid Spam
Instead of printing a new line for each update, the progress renderer **erases and redraws** the entire display in-place (in TTY mode). This prevents log files from filling with hundreds of intermediate states.

**Why it matters**: Monitoring logs stay clean; users see a single coherent progress bar that evolves, not a waterfall of status messages.

### 3. Three Output Modes Can Run Simultaneously
The pipeline supports three independent output modes:
- `--events`: NDJSON to stdout (for programmatic consumption)
- `--output-format json`: JSON summary to stdout (for CI/CD pipelines)
- `--tui`: Interactive dashboard (for human monitoring)

**Constraint**: Only one of `--events` or `--tui` can be active (they both need stdout). Default "human" mode can coexist with `--events`.

### 4. pino Logging is Auto-Suppressed in Default Mode
When running without `--verbose` or `--events`, the pipeline sets `LOG_LEVEL=silent`, suppressing all pino log output. This keeps the terminal clean and avoids JSON noise.

**Why it matters**: Default experience is distraction-free; users see only progress and results. Verbose debugging remains available with a single flag.

### 5. CLAUDE.md Section is Idempotent
The scaffold section in CLAUDE.md is wrapped in `<!-- substrate:start -->` and `<!-- substrate:end -->` markers. Re-running `substrate auto init` **replaces the section** rather than appending duplicates.

**Why it matters**: Safe to re-init a project without accumulating cruft in the documentation.

### 6. TUI Requires Interactive Terminal (TTY)
If `--tui` is used but stdout is not a TTY (e.g., piped to file), the TUI is automatically disabled with a warning message, and the pipeline falls back to default progress output.

**Why it matters**: Prevents cryptic failures when running in CI/CD environments; graceful degradation.

---

## Known Limitations & Deferred Items

### Current Limitations

1. **TUI Terminal Size Constraints**
   - Minimum terminal size: 80 columns × 24 rows
   - Very narrow terminals (< 80 cols) are not supported; TUI will reject or render poorly
   - *Workaround*: Resize terminal window before launching TUI

2. **Log Buffer Size**
   - TUI keeps a maximum of 500 log entries in memory
   - Older entries are discarded (circular buffer)
   - *Impact*: Very long pipelines may lose early log context
   - *Mitigation*: Export full pipeline logs via `--output-format json` for archival

3. **No Persistent Event Storage**
   - Events are emitted in real-time but not persisted
   - If a consumer crashes, it misses events that occurred before restart
   - *Workaround*: Pipe `--events` output to a file for replay: `substrate auto run --events > events.ndjson 2>&1`

4. **Help Overlay Content is Hardcoded**
   - Keyboard shortcuts in the help overlay are not configurable
   - No customization per project or user

### Deferred / Future Enhancements

1. **Event Filtering & Subscription**
   - Currently all events are emitted unconditionally
   - Future: Allow consumers to subscribe to only certain event types (e.g., `--events-filter story:escalation`)

2. **TUI Themes**
   - Currently colors are hardcoded (yellow warnings, green success, red errors)
   - Future: Support theme customization via config file or environment variables

3. **Structured Log Levels**
   - story:log and story:warn events exist but are not heavily used
   - Future: Integrate debug, info, warn, error log levels throughout the pipeline

4. **Event Backpressure & Buffering**
   - Current fire-and-forget approach may drop events if stream is congested
   - Future: Optional buffered mode with bounded queue and overflow handling

5. **TUI Export & Recording**
   - No built-in way to export TUI session state or record events during TUI interaction
   - Future: `--tui-export <file>` to record all events while running TUI

6. **Agent Event Metrics & Aggregation**
   - Help agent output is static; no runtime metrics (e.g., story duration, token usage)
   - Future: Enhance `--help-agent` output with example metrics and performance expectations

---

## Integration Checklist for Other Teams

If your team is consuming the Substrate event protocol or building on Epic 15, ensure:

- [ ] You are parsing events from `--events` output using a robust NDJSON parser (handle partial lines gracefully)
- [ ] Your system handles both `story:phase` (in-progress) and `story:done` (terminal) events to track story lifecycle
- [ ] You implement exponential backoff if your consumer is slower than the emitter
- [ ] You preserve the timestamp (`ts` field) from each event for audit trails and performance analysis
- [ ] For AI agents: Run `substrate auto --help-agent` at startup and include its output in your system prompt
- [ ] For dashboards: Test against `--output-format json` for structured story summaries (alternative to events for post-hoc analysis)
- [ ] For human monitoring: Communicate that `--tui` provides a better UX than piping raw logs

---

## Demo Session Transcript (Optional Quick Run)

For a rapid demo, run this sequence:

```bash
# 1. Show --help-agent output (fast, no execution)
substrate auto --help-agent | head -50

# 2. Show default progress output (short run)
substrate auto run --pack bmad --stories 10-1 --concurrency 1

# 3. Show --events NDJSON format
substrate auto run --pack bmad --stories 10-1 --events 2>/dev/null | jq '.' | head -40

# 4. Show interactive TUI (requires manual interaction; press 'q' to exit)
substrate auto run --pack bmad --stories 10-1,10-2 --tui
```

Expected time: ~5–10 minutes per full pipeline run (depending on CPU and AI backend latency).

---

## Appendix: Event Type Quick Reference

| Event Type | When | Key Fields |
|---|---|---|
| `pipeline:start` | First event; once at start | `run_id`, `stories[]`, `concurrency` |
| `story:phase` | Story enters/exits a phase | `key`, `phase`, `status` (in_progress\|complete\|failed), optional `verdict` / `file` |
| `story:done` | Story reaches terminal state | `key`, `result` (success\|failed), `review_cycles` |
| `story:escalation` | Story exceeds max review cycles | `key`, `reason`, `cycles`, `issues[]` |
| `story:warn` | Non-fatal warning during execution | `key`, `msg` |
| `story:log` | Informational message | `key`, `msg` |
| `pipeline:complete` | Last event; after all stories done | `succeeded[]`, `failed[]`, `escalated[]` |

All events include `ts` (ISO-8601 timestamp generated at emit time).

---

## Appendix: Source Files Summary

- **Event Definitions**: `/Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/event-types.ts` (187 lines)
  - 7 event type interfaces + 1 discriminated union type
  - TypeScript-first approach: no external schema files

- **Event Emitter**: `/Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/event-emitter.ts` (63 lines)
  - Simple factory function `createEventEmitter(stream)`
  - Fire-and-forget NDJSON writer

- **Progress Renderer**: `/Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/progress-renderer.ts` (446 lines)
  - TTY detection and ANSI cursor control
  - Per-story state tracking
  - Color support with NO_COLOR respect

- **Help Agent**: `/Users/John.Planow/code/jplanow/substrate/src/cli/commands/help-agent.ts` (200+ lines)
  - Hardcoded `PIPELINE_EVENT_METADATA` array
  - Markdown fragment generator
  - Field descriptions and interaction guidelines

- **CLAUDE.md Template**: `/Users/John.Planow/code/jplanow/substrate/src/cli/templates/claude-md-substrate-section.md` (16 lines)
  - Markers for idempotent replacement
  - Quick start commands and agent behavior guidelines

- **TUI Dashboard** (8 files, ~800 lines total):
  - `app.ts`: Root state & orchestration (300 lines)
  - `types.ts`: TypeScript interfaces for TUI state
  - `story-panel.ts`: Story row rendering
  - `log-panel.ts`: Scrollable log view
  - `detail-view.ts`: Escalation issue detail display
  - `help-overlay.ts`: Keyboard help text
  - `ansi.ts`: ANSI code helpers
  - `index.ts`: Public exports

- **CLI Integration**: `/Users/John.Planow/code/jplanow/substrate/src/cli/commands/auto.ts` (3000+ lines)
  - Lines 28–32: Imports for event emitter and progress renderer
  - Lines 1040–1045: Non-TTY TUI rejection
  - Lines 1046–1052: pino suppression logic
  - Lines 1054–1120: TUI wiring
  - Lines 1122–1189: Progress renderer wiring
  - Lines 1190–1261: NDJSON emitter wiring
  - Lines 2846–2864: CLI flag definitions and option parsing
