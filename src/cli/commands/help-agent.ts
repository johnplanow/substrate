/**
 * `substrate auto --help-agent` command handler
 *
 * Generates a machine-optimized prompt fragment describing the event protocol,
 * available commands, and interaction patterns for AI agents.
 *
 * This is "Layer 2" of the agent integration strategy — the CLI teaching the
 * agent how to use it. Output is derived from TypeScript type definitions
 * to ensure documentation never drifts from implementation.
 */

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'path'
import { EVENT_TYPE_NAMES } from '../../modules/implementation-orchestrator/event-types.js'

// Re-export so tests can import from a single location.
export { EVENT_TYPE_NAMES }

// ---------------------------------------------------------------------------
// Event field metadata — mirrors PipelineEvent type definitions
// ---------------------------------------------------------------------------

/**
 * Description of a single field in an event type.
 */
export interface FieldDescription {
  name: string
  type: string
  description: string
  optional?: boolean
}

/**
 * Metadata for a single pipeline event type.
 */
export interface EventMetadata {
  type: string
  description: string
  when: string
  fields: FieldDescription[]
}

// ---------------------------------------------------------------------------
// SYNC CONTRACT
//
// PIPELINE_EVENT_METADATA is a hand-maintained array that MUST stay in sync
// with the PipelineEvent discriminated union in:
//   src/modules/implementation-orchestrator/event-types.ts
//
// Alignment is enforced by tests in:
//   src/cli/commands/__tests__/help-agent.test.ts
//
// Those tests import EVENT_TYPE_NAMES from event-types.ts and verify:
//   1. Every type name in EVENT_TYPE_NAMES has a matching entry here.
//   2. The field count in each metadata entry matches the actual interface.
//   3. No extra entries exist here that are absent from EVENT_TYPE_NAMES.
//
// When you add a new PipelineEvent member:
//   1. Add its interface to event-types.ts.
//   2. Add it to the PipelineEvent union in event-types.ts.
//   3. Add its type string to EVENT_TYPE_NAMES in event-types.ts.
//   4. Add a matching entry to PIPELINE_EVENT_METADATA below.
//   5. Run the test suite — the alignment tests will catch any gap.
// ---------------------------------------------------------------------------

/**
 * Metadata object mirroring all PipelineEvent discriminated union members.
 * This is the runtime source of truth for the --help-agent output.
 *
 * See the SYNC CONTRACT comment above before modifying this array.
 */
export const PIPELINE_EVENT_METADATA: EventMetadata[] = [
  {
    type: 'pipeline:start',
    description: 'Emitted as the first event when the pipeline begins.',
    when: 'Once at pipeline start, before any stories are processed.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string', description: 'Unique identifier for this pipeline run.' },
      { name: 'stories', type: 'string[]', description: 'Story keys being processed (e.g., ["10-1","10-2"]).' },
      { name: 'concurrency', type: 'number', description: 'Maximum parallel conflict groups.' },
    ],
  },
  {
    type: 'pipeline:complete',
    description: 'Emitted as the last event when the pipeline finishes.',
    when: 'Once at pipeline end, after all stories reach a terminal state.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'succeeded', type: 'string[]', description: 'Story keys that completed successfully.' },
      { name: 'failed', type: 'string[]', description: 'Story keys that failed with an error.' },
      { name: 'escalated', type: 'string[]', description: 'Story keys escalated after exhausting review cycles.' },
    ],
  },
  {
    type: 'story:phase',
    description: 'Emitted when a story transitions into or out of a phase.',
    when: 'Each time a story enters (status: in_progress) or exits (status: complete|failed) a phase.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'key', type: 'string', description: 'Story key (e.g., "10-1").' },
      { name: 'phase', type: 'create-story|dev-story|code-review|fix', description: 'The phase being transitioned.' },
      { name: 'status', type: 'in_progress|complete|failed', description: 'Whether the phase is starting or completing.' },
      { name: 'verdict', type: 'string', description: 'Code-review verdict (only present on code-review phase complete events).', optional: true },
      { name: 'file', type: 'string', description: 'Path to generated story file (only present on create-story phase complete events).', optional: true },
    ],
  },
  {
    type: 'story:done',
    description: 'Emitted when a story reaches a terminal success state.',
    when: 'Once per story upon successful completion or unrecoverable failure.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'key', type: 'string', description: 'Story key (e.g., "10-1").' },
      { name: 'result', type: 'success|failed', description: 'Terminal result.' },
      { name: 'review_cycles', type: 'number', description: 'Number of review cycles completed.' },
    ],
  },
  {
    type: 'story:escalation',
    description: 'Emitted when a story is escalated after exhausting the maximum review cycles.',
    when: 'When a story exceeds the maximum number of code-review/fix cycles.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'key', type: 'string', description: 'Story key (e.g., "10-1").' },
      { name: 'reason', type: 'string', description: 'Human-readable escalation reason.' },
      { name: 'cycles', type: 'number', description: 'Number of review cycles that occurred.' },
      { name: 'issues', type: 'EscalationIssue[]', description: 'Issues from the final review. Each has: severity (string), file (path:line), desc (string).' },
    ],
  },
  {
    type: 'story:warn',
    description: 'Emitted for non-fatal warnings during pipeline execution.',
    when: 'For non-blocking issues such as token ceiling truncation or partial batch failures.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'key', type: 'string', description: 'Story key (e.g., "10-1").' },
      { name: 'msg', type: 'string', description: 'Warning message.' },
    ],
  },
  {
    type: 'story:log',
    description: 'Emitted for informational messages during pipeline execution.',
    when: 'For progress and informational messages during story processing.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'key', type: 'string', description: 'Story key (e.g., "10-1").' },
      { name: 'msg', type: 'string', description: 'Log message.' },
    ],
  },
  {
    type: 'pipeline:heartbeat',
    description: 'Periodic heartbeat emitted every 30s when no other progress events have fired.',
    when: 'Every 30 seconds during pipeline execution. Allows detection of stalled pipelines.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string', description: 'Pipeline run ID.' },
      { name: 'active_dispatches', type: 'number', description: 'Number of sub-agents currently running.' },
      { name: 'completed_dispatches', type: 'number', description: 'Number of dispatches completed.' },
      { name: 'queued_dispatches', type: 'number', description: 'Number of dispatches waiting to start.' },
    ],
  },
  {
    type: 'story:stall',
    description: 'Emitted when the watchdog detects no progress for an extended period (default: 10 minutes).',
    when: 'When a story has shown no progress for longer than the watchdog timeout. Indicates likely stall.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string', description: 'Pipeline run ID.' },
      { name: 'story_key', type: 'string', description: 'Story key that appears stalled.' },
      { name: 'phase', type: 'string', description: 'Phase the story was in when stall was detected.' },
      { name: 'elapsed_ms', type: 'number', description: 'Milliseconds since last progress event.' },
    ],
  },
  {
    type: 'supervisor:kill',
    description: 'Emitted by the supervisor when it kills a stalled pipeline process tree.',
    when: 'When the supervisor detects a STALLED verdict and staleness exceeds the stall threshold.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string|null', description: 'Pipeline run ID that was killed.' },
      { name: 'reason', type: 'stall', description: 'Reason for the kill — always "stall" for threshold-triggered kills.' },
      { name: 'staleness_seconds', type: 'number', description: 'Seconds the pipeline had been stalled.' },
      { name: 'pids', type: 'number[]', description: 'PIDs that were killed (orchestrator + child processes).' },
    ],
  },
  {
    type: 'supervisor:restart',
    description: 'Emitted by the supervisor when it restarts a killed pipeline via auto resume.',
    when: 'Immediately after killing a stalled pipeline, when the restart count is within the max limit.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string|null', description: 'Pipeline run ID being resumed.' },
      { name: 'attempt', type: 'number', description: 'Restart attempt number (1-based).' },
    ],
  },
  {
    type: 'supervisor:abort',
    description: 'Emitted by the supervisor when it exceeds the maximum restart limit and gives up.',
    when: 'When the restart count reaches or exceeds --max-restarts and another stall is detected.',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string|null', description: 'Pipeline run ID that was abandoned.' },
      { name: 'reason', type: 'max_restarts_exceeded', description: 'Always "max_restarts_exceeded".' },
      { name: 'attempts', type: 'number', description: 'Number of restart attempts that were made.' },
    ],
  },
  {
    type: 'supervisor:summary',
    description: 'Emitted by the supervisor when the pipeline reaches a terminal state.',
    when: 'When the supervisor detects a NO_PIPELINE_RUNNING verdict (completed, failed, or stopped).',
    fields: [
      { name: 'ts', type: 'string', description: 'ISO-8601 timestamp generated at emit time.' },
      { name: 'run_id', type: 'string|null', description: 'Pipeline run ID.' },
      { name: 'elapsed_seconds', type: 'number', description: 'Total elapsed seconds from supervisor start to terminal state.' },
      { name: 'succeeded', type: 'string[]', description: 'Story keys that completed successfully.' },
      { name: 'failed', type: 'string[]', description: 'Story keys that failed (non-COMPLETE, non-PENDING phases).' },
      { name: 'escalated', type: 'string[]', description: 'Story keys that were escalated.' },
      { name: 'restarts', type: 'number', description: 'Number of restart cycles performed by the supervisor.' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Help-agent output generation
// ---------------------------------------------------------------------------

/**
 * Resolve package.json version by walking up from startDir.
 * Returns '0.0.0' if not found.
 */
export async function resolvePackageVersion(startDir?: string): Promise<string> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const base = startDir ?? __dirname

  const paths = [
    join(base, '../../package.json'),
    join(base, '../../../package.json'),
    join(base, '../../../../package.json'),
  ]

  for (const p of paths) {
    try {
      const content = await readFile(p, 'utf-8')
      const pkg = JSON.parse(content) as { version?: string; name?: string }
      if (pkg.name === 'substrate' || pkg.name === 'substrate-ai') {
        return pkg.version ?? '0.0.0'
      }
    } catch {
      // Try next
    }
  }
  return '0.0.0'
}

/**
 * Generate the event schema section from metadata.
 */
export function generateEventSchemaSection(events: EventMetadata[]): string {
  const lines: string[] = ['## Event Protocol', '']
  lines.push('Events are newline-delimited JSON (NDJSON) on stdout when `--events` is passed.')
  lines.push('Parse each line independently with `JSON.parse(line)`.')
  lines.push('')

  for (const event of events) {
    lines.push(`### ${event.type}`)
    lines.push(event.description)
    lines.push(`_When emitted:_ ${event.when}`)
    lines.push('')
    lines.push('Fields:')
    for (const field of event.fields) {
      const optTag = field.optional ? ' _(optional)_' : ''
      lines.push(`- \`${field.name}\` (${field.type})${optTag}: ${field.description}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Generate the command reference section.
 */
export function generateCommandReferenceSection(): string {
  return `## Commands

All commands are run via the \`substrate auto\` subcommand group.

### substrate auto run
Run the autonomous implementation pipeline.

\`\`\`
substrate auto run [options]
\`\`\`

Options:
- \`--events\` — Emit structured NDJSON events on stdout for programmatic consumption
- \`--stories <keys>\` — Comma-separated story keys to process (e.g., \`7-1,7-2\`)
- \`--verbose\` — Enable verbose logging output
- \`--pack <name>\` — Methodology pack name (default: bmad)
- \`--from <phase>\` — Start from this phase: analysis, planning, solutioning, implementation
- \`--stop-after <phase>\` — Stop pipeline after this phase completes
- \`--concurrency <n>\` — Maximum parallel conflict groups (default: 3)
- \`--output-format <format>\` — Output format: human (default) or json
- \`--help-agent\` — Print this agent instruction fragment and exit

Examples:
\`\`\`
# Run pipeline with NDJSON event stream
substrate auto run --events

# Run specific stories with event stream
substrate auto run --events --stories 7-1,7-2

# Run pipeline with human-readable output (default)
substrate auto run
\`\`\`

### substrate auto status
Show status of the most recent pipeline run.

\`\`\`
substrate auto status [--run-id <id>] [--output-format json]
\`\`\`

### substrate auto resume
Resume a previously interrupted pipeline run.

\`\`\`
substrate auto resume [--run-id <id>]
\`\`\`

### substrate auto init
Initialize a methodology pack and decision store.

\`\`\`
substrate auto init [--pack bmad] [--project-root .]
\`\`\`
`
}

/**
 * Generate the interaction patterns section.
 */
export function generateInteractionPatternsSection(): string {
  return `## Interaction Patterns

Use this decision flowchart when handling events from \`substrate auto run --events\`:

### On \`story:done\` with \`result: success\`
- Report successful completion to the user.
- Note the story key and number of review_cycles for telemetry.

### On \`story:done\` with \`result: failed\`
- Report failure to the user with the story key.
- Suggest checking logs or running \`substrate auto status\` for details.

### On \`story:escalation\`
- Read the \`issues\` array. Each issue has \`severity\`, \`file\` (path:line), and \`desc\`.
- Present the issues to the user grouped by severity.
- Offer to fix the issues or explain them.
- Ask the user whether to retry or abandon the story.

### On \`story:phase\` with \`verdict: NEEDS_MINOR_FIXES\`
- The story passed code review but has minor suggestions.
- Offer to apply the fixes or skip.
- This is non-blocking — pipeline continues unless you intervene.

### On \`story:warn\`
- Inform the user of the warning message but do NOT treat it as an error.
- Common warnings: token ceiling truncation, partial batch failures.
- Pipeline continues normally after a warn event.

### On \`story:log\`
- These are informational only.
- Display if verbose mode is active; otherwise buffer or discard.

### On \`pipeline:complete\`
- Summarize results: report \`succeeded.length\` successes.
- List any \`failed\` or \`escalated\` stories with reasons if available.
- This is always the last event emitted.
`
}

/**
 * Generate the complete help-agent prompt fragment.
 */
export function generateHelpAgentOutput(version: string, events: EventMetadata[] = PIPELINE_EVENT_METADATA): string {
  const lines: string[] = []

  lines.push('# Substrate Auto Pipeline — Agent Instructions')
  lines.push(`Version: ${version}`)
  lines.push('')
  lines.push(
    'This document is a machine-optimized instruction fragment for AI agents operating the Substrate pipeline. ' +
    'Ingest it as a system prompt fragment to understand commands, event protocol, and interaction patterns.',
  )
  lines.push('')

  lines.push(generateCommandReferenceSection())
  lines.push(generateEventSchemaSection(events))
  lines.push(generateInteractionPatternsSection())

  return lines.join('\n')
}

/**
 * Run the --help-agent command: generate and print the prompt fragment, then exit 0.
 */
export async function runHelpAgent(): Promise<number> {
  const version = await resolvePackageVersion()
  const output = generateHelpAgentOutput(version)
  process.stdout.write(output + '\n')
  return 0
}
