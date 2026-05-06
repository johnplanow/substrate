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

import { readFile, access } from 'fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { EVENT_TYPE_NAMES } from '../../modules/implementation-orchestrator/event-types.js'

const execFileAsync = promisify(execFile)

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
    type: 'story:auto-approved',
    description: 'Story auto-approved after exhausting review cycles with only minor issues.',
    when: 'When review cycles reach the maximum and the final verdict is NEEDS_MINOR_FIXES (not MAJOR_REWORK).',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'key', type: 'string', description: 'Story key.' },
      { name: 'verdict', type: 'string', description: 'Final review verdict (NEEDS_MINOR_FIXES).' },
      { name: 'review_cycles', type: 'number', description: 'Review cycles completed.' },
      { name: 'max_review_cycles', type: 'number', description: 'Maximum review cycles configured.' },
      { name: 'issue_count', type: 'number', description: 'Remaining issues at auto-approve time.' },
      { name: 'reason', type: 'string', description: 'Human-readable reason for auto-approval.' },
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
    type: 'pipeline:phase-start',
    description: 'A pipeline phase has started during full pipeline execution.',
    when: 'When --from is used and a phase begins (analysis, planning, solutioning, implementation).',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'phase', type: 'string', description: 'Phase name (e.g., analysis, implementation).' },
    ],
  },
  {
    type: 'pipeline:phase-complete',
    description: 'A pipeline phase has completed during full pipeline execution.',
    when: 'When --from is used and a phase finishes successfully.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'phase', type: 'string', description: 'Phase name (e.g., analysis, implementation).' },
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
  {
    type: 'verification:check-complete',
    description: 'Emitted after each Tier A verification check completes. Payload includes check name, status (pass/warn/fail), human-readable details, and execution duration.',
    when: 'After a story reaches SHIP_IT verdict, once per individual verification check (phantom-review, trivial-output, build).',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key (e.g., "51-5").' },
      { name: 'checkName', type: 'string', description: 'Check name (e.g., "phantom-review", "trivial-output", "build").' },
      { name: 'status', type: 'pass|warn|fail', description: 'Check result.' },
      { name: 'details', type: 'string', description: 'Human-readable check details.' },
      { name: 'duration_ms', type: 'number', description: 'Check execution time in milliseconds.' },
    ],
  },
  {
    type: 'verification:story-complete',
    description: 'Emitted once per story after all Tier A verification checks complete. Payload is the full VerificationSummary with aggregated worst-case status.',
    when: 'After all Tier A checks complete for a story (after SHIP_IT verdict). Precedes story:done on pass/warn, or replaces it on fail.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'storyKey', type: 'string', description: 'Story key (e.g., "51-5").' },
      { name: 'checks', type: 'array', description: 'Per-check results (checkName, status, details, duration_ms).' },
      { name: 'status', type: 'pass|warn|fail', description: 'Aggregated worst-case status across all checks.' },
      { name: 'duration_ms', type: 'number', description: 'Total duration of all checks in milliseconds.' },
    ],
  },
  {
    type: 'cost:warning',
    description: 'Cumulative pipeline cost has crossed 80% of the --cost-ceiling threshold.',
    when: 'Emitted at most once per run, between story dispatches, when cumulative cost ≥ 80% of ceiling.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'cumulative_cost', type: 'number', description: 'Cumulative pipeline cost in USD at time of check.' },
      { name: 'ceiling', type: 'number', description: 'Configured cost ceiling in USD.' },
      { name: 'percent_used', type: 'number', description: '(cumulative / ceiling) * 100, rounded to two decimal places.' },
    ],
  },
  {
    type: 'cost:ceiling-reached',
    description: 'Cost ceiling reached — remaining undispatched stories are skipped.',
    when: 'Emitted between story dispatches when cumulative cost ≥ 100% of ceiling.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'cumulative_cost', type: 'number', description: 'Cumulative pipeline cost in USD at time of check.' },
      { name: 'ceiling', type: 'number', description: 'Configured cost ceiling in USD.' },
      { name: 'halt_on', type: 'string', description: '--halt-on value in effect (none, all, critical).' },
      { name: 'action', type: 'string', description: 'Action taken — stopped when policy requires halt, or the defaultAction when proceeding autonomously.' },
      { name: 'skipped_stories', type: 'string[]', description: 'Story keys skipped because budget was exhausted.' },
      { name: 'severity', type: 'string', description: 'Severity from routeDecision (critical for cost-ceiling-exhausted).', optional: true },
    ],
  },
  {
    type: 'decision:halt-skipped-non-interactive',
    description: 'A critical halt decision was skipped under --non-interactive mode; default action was applied autonomously.',
    when: 'Emitted when --non-interactive suppresses an operator prompt and applies the default action. Story 72-2.',
    fields: [
      { name: 'ts', type: 'string', description: 'Timestamp.' },
      { name: 'run_id', type: 'string', description: 'Pipeline run ID.' },
      { name: 'decision_type', type: 'string', description: 'Halt decision type that was skipped (e.g., halt:escalation).' },
      { name: 'severity', type: 'string', description: 'Severity of the skipped halt (e.g., critical).' },
      { name: 'default_action', type: 'string', description: 'Action applied in place of the operator prompt.' },
      { name: 'reason', type: 'string', description: 'Human-readable reason for skipping.' },
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

  // Walk multiple ancestor levels to handle bundler chunking variations:
  //   src/cli/commands/help-agent.ts  →  ../../../package.json (dev)
  //   dist/cli/commands/help-agent.js →  ../../../package.json (unbundled)
  //   dist/cli/index.js (bundled)     →  ../../package.json
  //   dist/run-<hash>.js (chunked)    →  ../package.json  ← was missing
  const paths = [
    join(base, '../package.json'),
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
- \`--engine <linear|graph>\` — Pipeline execution engine (default: linear)
- \`--max-review-cycles <n>\` — Per-story review cycles (default: 2; use 3 for migrations / interface extraction)
- \`--cost-ceiling <usd>\` — Halt the pipeline when cumulative cost crosses this threshold
- \`--halt-on <severity>\` — Decision Router halt policy: \`all\` halts on every decision, \`critical\` (default) halts only on cost-ceiling / build-fail / scope-violation, \`none\` halts only on fatal
- \`--non-interactive\` — Suppress all stdin prompts and apply default actions; required for CI/CD. Combine with \`--halt-on none\` for fully autonomous overnight runs
- \`--verify-ac\` — On-demand AC-to-Test traceability matrix (heuristic word-overlap matching between AC text and test names)
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

# Fully autonomous (CI/CD canonical pattern):
substrate run --halt-on none --non-interactive --events --output-format json
\`\`\`

#### Autonomy Modes

Pick the operator-attention level for the run:

| Mode | Invocation | Halts on |
|---|---|---|
| Attended | \`substrate run --halt-on all\` | Every decision (info, warning, critical, fatal) |
| Supervised (default) | \`substrate run\` | Critical + fatal (cost-ceiling, build-fail, scope-violation) |
| Autonomous | \`substrate run --halt-on none --non-interactive --events --output-format json\` | Only fatal — scope violations always halt regardless |

Exit codes from autonomous runs:
- \`0\` — all stories succeeded or were auto-recovered.
- \`1\` — some stories escalated; the run completed.
- \`2\` — run-level failure (cost ceiling, fatal halt, orchestrator died).

After every autonomous run, review the result with \`substrate report --run latest\`.

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

### substrate report
Structured per-run completion report — story outcomes, cost vs ceiling, escalation diagnostics, and operator halt notifications. Resolves the active run via the canonical chain (explicit \`--run-id\` → \`.substrate/current-run-id\` → Dolt fallback).

\`\`\`
substrate report [--run <id|latest>] [--output-format human|json] [--verify-ac]
\`\`\`

Options:
- \`--run <id|latest>\` — Run ID, or \`latest\` (default) to resolve via the canonical chain
- \`--output-format <format>\` — Output format: human (default) or json
- \`--verify-ac\` — Append an AC-to-Test traceability matrix (heuristic word-overlap matching between AC text and test names)

When \`substrate run\` is invoked with \`--halt-on\`, the Recovery Engine writes operator halt notifications to \`.substrate/notifications/<run-id>-<timestamp>.json\`. \`substrate report\` reads and clears those files, surfacing each one in its output.

### substrate reconcile-from-disk
Path A reconciliation primitive — when the pipeline reports failure but the working tree is coherent (gates green, files durable), this command detects working-tree changes since the run started, runs the project's gates, and prompts to mark stories complete in Dolt.

\`\`\`
substrate reconcile-from-disk [--run-id <id>] [--dry-run] [--yes] [--output-format json]
\`\`\`

Options:
- \`--run-id <id>\` — Run ID to reconcile (defaults to latest)
- \`--dry-run\` — Report what would change without mutating Dolt
- \`--yes\` — Skip the confirmation prompt (e.g., for non-interactive use after \`--dry-run\` review)
- \`--output-format <format>\` — Output format: human (default) or json

Use this when \`substrate report\` shows stories \`failed\` but \`git status\` + the project gates indicate the implementation is on disk and passing. The pipeline's failure verdict can be misleading after auto-recovery races; reconcile-from-disk codifies the manual fix.

## Operator Files (\`.substrate/\`)

These on-disk files back the new autonomy commands. External monitors (dashboards, Slack bots) can also tail them.

- \`.substrate/runs/<run-id>.json\` — per-run manifest (one file per run; NOT an aggregate \`manifest.json\`). Production format: do not invent an aggregate file — it does not exist.
- \`.substrate/current-run-id\` — plain text file containing the latest run ID; consulted by the canonical run-discovery chain.
- \`.substrate/notifications/<run-id>-<timestamp>.json\` — operator halt notifications written by the Recovery Engine when \`--halt-on\` triggers; deleted by \`substrate report\` after read.
- \`pending_proposals[]\` field in the run manifest — Recovery Engine Tier B re-scope proposals collected here for next-morning operator review. Back-pressure pauses dispatching at \`>= 2\` proposals (work-graph-aware) or \`>= 5\` (safety valve).

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

// ---------------------------------------------------------------------------
// Capabilities manifest
// ---------------------------------------------------------------------------

/**
 * Describes the capabilities of this Substrate installation.
 */
export interface CapabilitiesManifest {
  version: string
  engines: string[]
  providers: { name: string; available: boolean }[]
  factoryEnabled: boolean
  qualityMode: string
  doltAvailable: boolean
}

/**
 * Generate the capabilities manifest section.
 */
export function generateCapabilitiesSection(caps: CapabilitiesManifest): string {
  const lines: string[] = ['## Capabilities', '']
  lines.push(`Substrate version: ${caps.version}`)
  lines.push(`Engines: ${caps.engines.join(', ')}`)
  lines.push('')
  lines.push('Providers:')
  for (const p of caps.providers) {
    lines.push(`- ${p.name}: ${p.available ? 'available' : 'not found'}`)
  }
  lines.push('')
  lines.push(`Quality mode: ${caps.qualityMode}`)
  lines.push(`Factory features: ${caps.factoryEnabled ? 'enabled' : 'disabled'}`)
  lines.push(`Dolt (versioned state): ${caps.doltAvailable ? 'available' : 'not installed'}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Probe the local environment for capabilities.
 */
export async function probeCapabilities(version: string): Promise<CapabilitiesManifest> {
  // Check which CLI tools are on PATH
  const providerChecks = ['claude', 'codex', 'gemini'].map(async (name) => {
    try {
      await execFileAsync('which', [name])
      return { name, available: true }
    } catch {
      return { name, available: false }
    }
  })
  const providers = await Promise.all(providerChecks)

  // Check for Dolt
  let doltAvailable = false
  try {
    await execFileAsync('which', ['dolt'])
    doltAvailable = true
  } catch {
    // not installed
  }

  // Read config if it exists
  let qualityMode = 'code-review'
  let factoryEnabled = false
  try {
    const configPath = join(process.cwd(), '.substrate', 'config.yaml')
    await access(configPath)
    const configText = await readFile(configPath, 'utf-8')
    // Simple YAML extraction — avoid importing full YAML parser to keep help-agent lightweight
    const qmMatch = /quality_mode:\s*['"]?(\S+?)['"]?\s*$/m.exec(configText)
    if (qmMatch) qualityMode = qmMatch[1]
    const factoryMatch = /^\s*factory:/m.exec(configText)
    if (factoryMatch) factoryEnabled = true
  } catch {
    // No config — use defaults
  }

  return {
    version,
    engines: ['linear', 'graph'],
    providers,
    factoryEnabled,
    qualityMode,
    doltAvailable,
  }
}

/**
 * Generate the complete help-agent prompt fragment.
 */
export function generateHelpAgentOutput(version: string, events: EventMetadata[] = PIPELINE_EVENT_METADATA, capabilities?: CapabilitiesManifest): string {
  const lines: string[] = []

  lines.push('# Substrate Pipeline — Agent Instructions')
  lines.push(`Version: ${version}`)
  lines.push('')
  lines.push(
    'This document is a machine-optimized instruction fragment for AI agents operating the Substrate pipeline. ' +
    'Ingest it as a system prompt fragment to understand commands, event protocol, and interaction patterns.',
  )
  lines.push('')

  if (capabilities) {
    lines.push(generateCapabilitiesSection(capabilities))
  }

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
  const capabilities = await probeCapabilities(version)
  const output = generateHelpAgentOutput(version, PIPELINE_EVENT_METADATA, capabilities)
  process.stdout.write(output + '\n')
  return 0
}
