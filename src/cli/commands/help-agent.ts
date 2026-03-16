/**
 * `substrate run --help-agent` command handler
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
    description: 'Pipeline begins.',
    when: 'First event emitted.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string', description: 'Run identifier.' },
      { name: 'stories', type: 'string[]', description: 'Story keys (e.g., ["10-1","10-2"]).' },
      { name: 'concurrency', type: 'number', description: 'Max parallel groups.' },
    ],
  },
  {
    type: 'pipeline:complete',
    description: 'Pipeline finishes.',
    when: 'Last event emitted.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'succeeded', type: 'string[]', description: 'Successful story keys.' },
      { name: 'failed', type: 'string[]', description: 'Failed story keys.' },
      { name: 'escalated', type: 'string[]', description: 'Escalated story keys.' },
    ],
  },
  {
    type: 'story:phase',
    description: 'Story enters or exits a phase.',
    when: 'Each phase transition per story.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'key', type: 'string', description: 'Story key.' },
      { name: 'phase', type: 'create-story|dev-story|code-review|fix', description: 'Phase name.' },
      { name: 'status', type: 'in_progress|complete|failed', description: 'Transition direction.' },
      { name: 'verdict', type: 'string', description: 'Code-review verdict.', optional: true },
      { name: 'file', type: 'string', description: 'Generated story file path.', optional: true },
    ],
  },
  {
    type: 'story:done',
    description: 'Story reaches terminal state.',
    when: 'Once per story on completion.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'key', type: 'string', description: 'Story key.' },
      { name: 'result', type: 'success|failed', description: 'Terminal result.' },
      { name: 'review_cycles', type: 'number', description: 'Review cycles completed.' },
    ],
  },
  {
    type: 'story:escalation',
    description: 'Story escalated after exhausting review cycles.',
    when: 'When max review cycles exceeded.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'key', type: 'string', description: 'Story key.' },
      { name: 'reason', type: 'string', description: 'Escalation reason.' },
      { name: 'cycles', type: 'number', description: 'Cycles completed.' },
      { name: 'issues', type: 'EscalationIssue[]', description: 'Final review issues; each has severity, file, desc.' },
    ],
  },
  {
    type: 'story:warn',
    description: 'Non-fatal warning during execution.',
    when: 'Non-blocking issues (e.g., token truncation).',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'key', type: 'string', description: 'Story key.' },
      { name: 'msg', type: 'string', description: 'Warning message.' },
    ],
  },
  {
    type: 'story:log',
    description: 'Informational message.',
    when: 'Progress messages during story processing.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'key', type: 'string', description: 'Story key.' },
      { name: 'msg', type: 'string', description: 'Log message.' },
    ],
  },
  {
    type: 'pipeline:heartbeat',
    description: 'Periodic heartbeat (every 30s with no other events).',
    when: 'Every 30s during execution.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string', description: 'Run ID.' },
      { name: 'active_dispatches', type: 'number', description: 'Running sub-agents.' },
      { name: 'completed_dispatches', type: 'number', description: 'Completed dispatches.' },
      { name: 'queued_dispatches', type: 'number', description: 'Queued dispatches.' },
    ],
  },
  {
    type: 'story:stall',
    description: 'Watchdog detected no progress (default: 10 min).',
    when: 'Story silent longer than watchdog timeout.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string', description: 'Run ID.' },
      { name: 'story_key', type: 'string', description: 'Stalled story key.' },
      { name: 'phase', type: 'string', description: 'Phase at stall detection.' },
      { name: 'elapsed_ms', type: 'number', description: 'Ms since last progress.' },
    ],
  },
  {
    type: 'supervisor:poll',
    description: 'Heartbeat each poll (JSON only).',
    when: 'Per cycle.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'verdict', type: 'HEALTHY|STALLED|NO_PIPELINE_RUNNING', description: 'Verdict.' },
      { name: 'staleness_seconds', type: 'number', description: 'Seconds stale.' },
      { name: 'stories', type: 'object', description: 'active/completed/escalated.' },
      { name: 'story_details', type: 'object', description: 'phase+cycles per story.' },
      { name: 'tokens', type: 'object', description: 'input/output/cost_usd.' },
      { name: 'process', type: 'object', description: 'pid/child/zombie counts.' },
    ],
  },
  {
    type: 'supervisor:kill',
    description: 'Supervisor killed stalled pipeline process tree.',
    when: 'Staleness exceeds stall threshold.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Killed run ID.' },
      { name: 'reason', type: 'stall', description: 'Always "stall".' },
      { name: 'staleness_seconds', type: 'number', description: 'Stall duration (seconds).' },
      { name: 'pids', type: 'number[]', description: 'Killed PIDs.' },
    ],
  },
  {
    type: 'supervisor:restart',
    description: 'Emitted by the supervisor when it restarts a killed pipeline via resume.',
    when: 'Immediately after killing a stalled pipeline, when the restart count is within the max limit.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Resumed run ID.' },
      { name: 'attempt', type: 'number', description: 'Attempt number (1-based).' },
    ],
  },
  {
    type: 'supervisor:abort',
    description: 'Supervisor gave up after max restarts.',
    when: 'Restart count reached --max-restarts.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Abandoned run ID.' },
      { name: 'reason', type: 'max_restarts_exceeded', description: 'Always "max_restarts_exceeded".' },
      { name: 'attempts', type: 'number', description: 'Total attempts made.' },
    ],
  },
  {
    type: 'supervisor:summary',
    description: 'Pipeline reached terminal state; supervisor exits.',
    when: 'Pipeline no longer running.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'elapsed_seconds', type: 'number', description: 'Total elapsed seconds.' },
      { name: 'succeeded', type: 'string[]', description: 'Succeeded keys.' },
      { name: 'failed', type: 'string[]', description: 'Failed keys.' },
      { name: 'escalated', type: 'string[]', description: 'Escalated keys.' },
      { name: 'restarts', type: 'number', description: 'Supervisor restart count.' },
    ],
  },
  {
    type: 'supervisor:analysis:complete',
    description: 'Post-run analysis succeeded.',
    when: 'After analysis report is written.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Analyzed run ID.' },
    ],
  },
  {
    type: 'supervisor:analysis:error',
    description: 'Post-run analysis failed (best-effort).',
    when: 'Analysis step threw an error.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'error', type: 'string', description: 'Error message.' },
    ],
  },
  {
    type: 'supervisor:experiment:start',
    description: 'Experiment cycle beginning.',
    when: 'When --experiment enabled and recommendations found.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
    ],
  },
  {
    type: 'supervisor:experiment:skip',
    description: 'Experiment cycle skipped.',
    when: 'No recommendations or missing analysis report.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'reason', type: 'string', description: '"no_recommendations" or "no_analysis_report".' },
    ],
  },
  {
    type: 'supervisor:experiment:recommendations',
    description: 'Analysis report has recommendations to test.',
    when: 'Just before experiments begin.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'count', type: 'number', description: 'Recommendation count.' },
    ],
  },
  {
    type: 'supervisor:experiment:complete',
    description: 'All experiments finished.',
    when: 'After all experiment verdicts assigned.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'improved', type: 'number', description: 'IMPROVED count.' },
      { name: 'mixed', type: 'number', description: 'MIXED count.' },
      { name: 'regressed', type: 'number', description: 'REGRESSED count.' },
    ],
  },
  {
    type: 'supervisor:experiment:error',
    description: 'Experiment execution failed (best-effort).',
    when: 'Experimenter module threw an error.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string|null', description: 'Run ID.' },
      { name: 'error', type: 'string', description: 'Error message.' },
    ],
  },
  {
    type: 'routing:model-selected',
    description: 'Model routing resolver selected a model for a dispatch.',
    when: 'When a story dispatch uses model routing and the resolver returns a non-null model.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'dispatch_id', type: 'string', description: 'Unique dispatch ID.' },
      { name: 'task_type', type: 'string', description: 'Task type (dev-story, test-plan, code-review).' },
      { name: 'phase', type: 'string', description: 'Routing phase that matched (generate, explore, review).' },
      { name: 'model', type: 'string', description: 'Selected model ID.' },
      { name: 'source', type: 'string', description: 'How selected: phase, baseline, or override.' },
    ],
  },
  {
    type: 'pipeline:pre-flight-failure',
    description: 'Pre-flight build check failed before any story was dispatched. Pipeline aborts immediately.',
    when: 'When the build command exits with a non-zero code before the first story dispatch.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'exitCode', type: 'number', description: 'Exit code from the build command (-1 for timeout).' },
      { name: 'output', type: 'string', description: 'Combined stdout+stderr from the build command (truncated to 2000 chars).' },
    ],
  },
  {
    type: 'story:zero-diff-escalation',
    description: 'Dev-story reported COMPLETE but git diff shows no file changes (phantom completion).',
    when: 'After dev-story succeeds with zero file changes in working tree.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key.' },
      { name: 'reason', type: 'string', description: 'Always "zero-diff-on-complete".' },
    ],
  },
  {
    type: 'story:build-verification-failed',
    description: 'Build verification command (default: npm run build) exited with non-zero code or timed out.',
    when: 'After dev-story and zero-diff check pass, but before code-review is dispatched.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key.' },
      { name: 'exitCode', type: 'number', description: 'Exit code from the build command (-1 for timeout).' },
      { name: 'output', type: 'string', description: 'Combined stdout+stderr from the build command (truncated to 2000 chars).' },
    ],
  },
  {
    type: 'story:build-verification-passed',
    description: 'Build verification command exited with code 0 — compilation clean.',
    when: 'After dev-story completes and build verification command succeeds.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key.' },
    ],
  },
  {
    type: 'story:interface-change-warning',
    description: 'Non-blocking warning: modified files export shared TypeScript interfaces that may be referenced by test files outside the same module (potential stale mock risk). Story proceeds to code-review.',
    when: 'After build verification passes, before code-review, when exported interfaces in modified .ts files are referenced by cross-module test files.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key.' },
      { name: 'modifiedInterfaces', type: 'string[]', description: 'Exported interface/type names found in modified files.' },
      { name: 'potentiallyAffectedTests', type: 'string[]', description: 'Test file paths (relative to project root) that reference the modified interface names.' },
    ],
  },
  {
    type: 'story:metrics',
    description: 'Per-story metrics on terminal state.',
    when: 'After terminal state (success/escalation/failure).',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key.' },
      { name: 'wallClockMs', type: 'number', description: 'Wall-clock ms.' },
      { name: 'phaseBreakdown', type: 'Record<string,number>', description: 'Phase→ms durations.' },
      { name: 'tokens', type: '{input:number;output:number}', description: 'Token counts.' },
      { name: 'reviewCycles', type: 'number', description: 'Review cycle count.' },
      { name: 'dispatches', type: 'number', description: 'Dispatch count.' },
    ],
  },
  {
    type: 'pipeline:contract-mismatch',
    description: 'Post-sprint contract mismatch found. Non-blocking — stories done. Manual fix required.',
    when: 'After all stories complete, before pipeline:complete. When contract declarations exist and mismatch found.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'exporter', type: 'string', description: 'Exporting story key.' },
      { name: 'importer', type: 'string|null', description: 'Importing story key (null if none).' },
      { name: 'contractName', type: 'string', description: 'Contract name (e.g., "JudgeResult").' },
      { name: 'mismatchDescription', type: 'string', description: 'Mismatch details (missing file, type error).' },
    ],
  },
  {
    type: 'pipeline:contract-verification-summary',
    description: 'Contract verification summary. Consolidates pass/fail into a single event.',
    when: 'After all stories complete, before pipeline:complete. Emitted once per verification pass.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'verified', type: 'number', description: 'Declarations verified (current sprint).' },
      { name: 'stalePruned', type: 'number', description: 'Stale declarations pruned (previous epics).' },
      { name: 'mismatches', type: 'number', description: 'Real mismatches found.' },
      { name: 'verdict', type: 'pass|fail', description: 'Overall verification result.' },
    ],
  },
  {
    type: 'pipeline:profile-stale',
    description: 'Project profile may be outdated. Non-blocking warning — run `substrate init --force` to re-detect.',
    when: 'After all stories complete, before pipeline:complete. Emitted when staleness indicators are found.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'message', type: 'string', description: 'Human-readable staleness warning message.' },
      { name: 'indicators', type: 'string[]', description: 'List of staleness indicators (e.g., "turbo.json exists but profile says type: single").' },
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

All commands are top-level \`substrate\` subcommands.

### substrate run
Run the autonomous implementation pipeline.

\`\`\`
substrate run [options]
\`\`\`

Options:
- \`--events\` — Emit structured NDJSON events on stdout for programmatic consumption
- \`--stories <keys>\` — Comma-separated story keys to process (e.g., \`7-1,7-2\`)
- \`--verbose\` — Enable verbose logging output
- \`--pack <name>\` — Methodology pack name (default: bmad)
- \`--from <phase>\` — Start from this phase: research, analysis, planning, solutioning, implementation
- \`--stop-after <phase>\` — Stop pipeline after this phase completes
- \`--concurrency <n>\` — Maximum parallel conflict groups (default: 3)
- \`--output-format <format>\` — Output format: human (default) or json
- \`--concept <text>\` — Inline concept text (required when --from analysis)
- \`--research\` — Enable the research phase even if not set in the pack config
- \`--skip-research\` — Skip the research phase even if enabled in the pack config
- \`--skip-ux\` — Skip the UX design phase even if enabled in the pack config
- \`--help-agent\` — Print this agent instruction fragment and exit

Examples:
\`\`\`
# Run pipeline with NDJSON event stream
substrate run --events

# Run specific stories with event stream
substrate run --events --stories 7-1,7-2

# Run pipeline with human-readable output (default)
substrate run
\`\`\`

### substrate status
Show status of the most recent pipeline run.

\`\`\`
substrate status [--run-id <id>] [--output-format json]
\`\`\`

### substrate resume
Resume a previously interrupted pipeline run.

\`\`\`
substrate resume [--run-id <id>]
\`\`\`

### substrate init
Initialize a methodology pack and decision store.

\`\`\`
substrate init [--pack bmad] [--project-root .]
\`\`\`

### substrate supervisor
Long-running process that monitors pipeline health, kills stalled runs, and auto-restarts.

\`\`\`
substrate supervisor [options]
\`\`\`

Options:
- \`--poll-interval <seconds>\` — Health check interval (default: 60)
- \`--stall-threshold <seconds>\` — Staleness before killing (default: 600)
- \`--max-restarts <n>\` — Maximum restart attempts (default: 3)
- \`--experiment\` — After pipeline completes, run optimization experiments from analysis recommendations
- \`--max-experiments <n>\` — Maximum number of experiments to run per cycle (default: 2)
- \`--output-format <format>\` — Output format: human (default) or json

Exit codes: 0 = all succeeded, 1 = failures/escalations, 2 = max restarts exceeded.

### substrate metrics
Show historical pipeline run metrics and cross-run comparison.

\`\`\`
substrate metrics [options]
\`\`\`

Options:
- \`--limit <n>\` — Number of runs to show (default: 10)
- \`--compare <run-id-a,run-id-b>\` — Compare two runs side-by-side (token, time, review cycle deltas)
- \`--tag-baseline <run-id>\` — Mark a run as the performance baseline
- \`--analysis <run-id>\` — Read and output the analysis report with optimization recommendations for a specific run
- \`--output-format <format>\` — Output format: human (default) or json

### substrate export
Export decision store contents as human-readable markdown files.

\`\`\`
substrate export [options]
\`\`\`

Options:
- \`--run-id <id>\` — Pipeline run ID to export (defaults to latest run)
- \`--output-dir <path>\` — Directory to write exported files to (default: _bmad-output/planning-artifacts/)
- \`--output-format <format>\` — Output format: human (default) or json

### substrate health
Check pipeline health, stall detection, and process status.

\`\`\`
substrate health [--output-format json]
\`\`\`

### substrate cost
Show cost breakdown for the current session.

\`\`\`
substrate cost [--output-format json]
\`\`\`

### substrate amend
Run an amendment pipeline against a completed run.

\`\`\`
substrate amend [options]
\`\`\`

### substrate brainstorm
Interactive multi-persona brainstorm session with Pragmatic Engineer, Product Thinker, and Devil's Advocate.

\`\`\`
substrate brainstorm [options]
\`\`\`

Session commands: \`!wrap\` (save & exit), \`!quit\` (exit without saving), \`!help\`

## Environment Variables

- \`SUBSTRATE_MEMORY_THRESHOLD_MB\` — Override the free-memory threshold (in MB) for agent dispatch. Default: 512. On macOS, the conservative memory detection may report low availability even when ample RAM exists. Lower this (e.g., 256) if pipelines stall due to memory pressure false positives.
`
}

/**
 * Generate the interaction patterns section.
 */
export function generateInteractionPatternsSection(): string {
  return `## Interaction Patterns

Use this decision flowchart when handling events from \`substrate run --events\`:

### On \`story:done\` with \`result: success\`
- Report success to the user.

### On \`story:done\` with \`result: failed\`
- Report failure with the story key.

### On \`story:escalation\`
- Read \`issues\`: each has \`severity\`, \`file\`, \`desc\`.
- Present grouped by severity; ask user to retry or abandon.

### On \`story:phase\` with \`verdict: NEEDS_MINOR_FIXES\`
- Non-blocking minor suggestions. Offer to apply or skip.

### On \`story:warn\`
- Non-blocking warning; pipeline continues normally.

### On \`story:log\`
- Informational only. Display in verbose mode.

### On \`pipeline:complete\`
- Summarize \`succeeded\`, \`failed\`, \`escalated\` counts.

## Supervisor Interaction Patterns

Patterns for \`substrate supervisor --output-format json\` events:

### On \`supervisor:poll\`
- Track \`verdict\` and \`tokens.cost_usd\` each cycle. JSON only.

### On \`supervisor:summary\`
- Summarize \`succeeded\`, \`failed\`, \`escalated\` counts and \`restarts\`.
- Offer analysis: \`substrate metrics --analysis <run_id> --output-format json\`.

### On \`supervisor:kill\`
- Inform user: stall detected, pipeline killed. Supervisor will auto-restart.
- No action required unless \`--max-restarts\` is reached.

### On \`supervisor:abort\`
- Escalate: supervisor exhausted \`attempts\` restarts.
- Suggest increasing \`--max-restarts\` or \`--stall-threshold\`.

### On \`supervisor:analysis:complete\`
- Report ready at \`_bmad-output/supervisor-reports/<run_id>-analysis.md\`.
- Run experiments: \`substrate supervisor --experiment --output-format json\`.
- Read report: \`substrate metrics --analysis <run_id> --output-format json\`.

### On \`supervisor:experiment:complete\`
- Summarize verdicts: \`improved\`, \`mixed\`, \`regressed\` counts.
- Warn user if any \`regressed\` — suggest reverting those changes.
- No PRs are created automatically; changes remain on experiment branches.

### On \`supervisor:experiment:error\`
- Report error. Suggest running without \`--experiment\` for a clean run.

### On \`routing:model-selected\`
- Informational. Log which model was selected for the dispatch and why (phase config, baseline, or override).
`
}

/**
 * Generate the complete help-agent prompt fragment.
 */
export function generateHelpAgentOutput(version: string, events: EventMetadata[] = PIPELINE_EVENT_METADATA): string {
  const lines: string[] = []

  lines.push('# Substrate Pipeline — Agent Instructions')
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
