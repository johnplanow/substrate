/**
 * substrate annotate — operator post-hoc tagging of verification findings
 * (Story 60-15).
 *
 * Persists a `StoredVerificationAnnotation` to the run manifest under
 * `per_story_state[storyKey].verification_result.annotations[]`. Powers the
 * catch-rate KPI's confirmed-defect count: a probe-author probe failure
 * that the operator subsequently confirms as catching a real defect counts
 * toward `authoredProbesCaughtConfirmedDefectCount` in the per-story rollup
 * and `totalConfirmedDefectsCaught` / `catchRateByConfirmedDefect` in the
 * cross-run aggregate (`substrate metrics --probe-author-summary`).
 *
 * Three judgments per the corpus protocol:
 *   --confirmed-defect: probe failure caught a real bug
 *   --false-positive:   probe failed but no real bug was present
 *   --probe-bug:        probe failed because the probe itself was buggy
 *
 * Usage:
 *   substrate annotate --story <key> --finding-category <cat>
 *     [--probe-name <name>] [--note <text>] [--run-id <id>]
 *     (--confirmed-defect | --false-positive | --probe-bug)
 *
 * --run-id resolves to the latest run when omitted (most common operator
 * flow: annotate findings from the most recent run).
 */

import { join } from 'node:path'

import type { Command } from 'commander'

import { RunManifest } from '@substrate-ai/sdlc'
import type { StoredVerificationAnnotation } from '@substrate-ai/sdlc'

import { resolveMainRepoRoot } from '../../utils/git-root.js'
import { createDatabaseAdapter } from '../../persistence/adapter.js'
import { getLatestRun } from '../../persistence/queries/decisions.js'

interface AnnotateOptions {
  story: string
  findingCategory: string
  probeName?: string
  note?: string
  runId?: string
  confirmedDefect?: boolean
  falsePositive?: boolean
  probeBug?: boolean
  outputFormat: string
  projectRoot: string
}

export function registerAnnotateCommand(program: Command, _version: string, projectRoot: string): void {
  program
    .command('annotate')
    .description(
      'Post-hoc operator annotation on a verification finding ' +
        '(probe-author KPI confirmed-defect tagging — Story 60-15)',
    )
    .requiredOption('--story <key>', 'Story key (e.g. 1-12)')
    .requiredOption(
      '--finding-category <category>',
      'Finding category to annotate (e.g. runtime-probe-fail, runtime-probe-error-response)',
    )
    .option(
      '--probe-name <name>',
      'Optional probe name to narrow the annotation when multiple probes share a category',
    )
    .option('--note <text>', 'Free-form note explaining the judgment')
    .option(
      '--run-id <id>',
      'Run ID to annotate (defaults to the latest run for this project)',
    )
    .option('--confirmed-defect', 'Annotate as: probe failure caught a real defect')
    .option('--false-positive', 'Annotate as: probe failure was not a real defect')
    .option('--probe-bug', 'Annotate as: probe itself was buggy (not a defect catch or false positive)')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .option('--project-root <path>', 'Project root directory', projectRoot)
    .action(async (opts: AnnotateOptions) => {
      const exitCode = await runAnnotateAction(opts)
      process.exitCode = exitCode
    })
}

export async function runAnnotateAction(opts: AnnotateOptions): Promise<number> {
  const format = opts.outputFormat === 'json' ? 'json' : 'human'

  // Validate exactly one judgment flag was provided.
  const judgmentCount =
    (opts.confirmedDefect ? 1 : 0) + (opts.falsePositive ? 1 : 0) + (opts.probeBug ? 1 : 0)
  if (judgmentCount !== 1) {
    return emitError(
      format,
      `exactly one of --confirmed-defect, --false-positive, --probe-bug must be provided (got ${judgmentCount})`,
    )
  }
  const judgment: StoredVerificationAnnotation['judgment'] = opts.confirmedDefect
    ? 'confirmed-defect'
    : opts.falsePositive
      ? 'false-positive'
      : 'probe-bug'

  const dbRoot = await resolveMainRepoRoot(opts.projectRoot)

  // Resolve target run-id: explicit > latest run.
  let runId = opts.runId
  if (runId === undefined) {
    const adapter = createDatabaseAdapter({ backend: 'auto', basePath: opts.projectRoot })
    try {
      const latest = await getLatestRun(adapter)
      if (latest === null || latest === undefined) {
        return emitError(format, 'no runs found — pass --run-id explicitly')
      }
      runId = latest.id
    } finally {
      await adapter.close()
    }
  }

  // Read manifest, append annotation to the story's verification_result.annotations[],
  // write back via patchStoryState. Non-destructive: existing annotations preserved.
  const manifest = RunManifest.open(runId, join(dbRoot, 'runs'))
  let existingData: Awaited<ReturnType<typeof manifest.read>>
  try {
    existingData = await manifest.read()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return emitError(format, `failed to read manifest for run ${runId}: ${msg}`)
  }

  const storyState = existingData.per_story_state[opts.story]
  if (storyState === undefined) {
    return emitError(format, `story ${opts.story} not found in run ${runId}`)
  }
  const verificationResult = storyState.verification_result
  if (verificationResult === undefined || verificationResult === null) {
    return emitError(format, `story ${opts.story} has no verification_result to annotate`)
  }

  const newAnnotation: StoredVerificationAnnotation = {
    findingCategory: opts.findingCategory,
    judgment,
    createdAt: new Date().toISOString(),
    ...(opts.probeName !== undefined ? { probeName: opts.probeName } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  }

  const existingAnnotations = verificationResult.annotations ?? []
  const updatedVerificationResult = {
    ...verificationResult,
    annotations: [...existingAnnotations, newAnnotation],
  }

  try {
    await manifest.patchStoryState(opts.story, { verification_result: updatedVerificationResult })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return emitError(format, `failed to write annotation: ${msg}`)
  }

  if (format === 'json') {
    process.stdout.write(
      JSON.stringify({
        success: true,
        runId,
        storyKey: opts.story,
        annotation: newAnnotation,
        totalAnnotations: existingAnnotations.length + 1,
      }) + '\n',
    )
  } else {
    process.stdout.write(
      `annotated story ${opts.story} (${runId}): ${judgment} on ${opts.findingCategory}` +
        (opts.probeName !== undefined ? ` [${opts.probeName}]` : '') +
        '\n',
    )
  }
  return 0
}

function emitError(format: 'human' | 'json', message: string): number {
  if (format === 'json') {
    process.stdout.write(JSON.stringify({ success: false, error: message }) + '\n')
  } else {
    process.stderr.write(`Error: ${message}\n`)
  }
  return 1
}
