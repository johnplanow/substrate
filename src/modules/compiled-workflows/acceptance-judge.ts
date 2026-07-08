/**
 * runAcceptanceJudge — compiled acceptance-judge workflow (A2.1).
 *
 * Dispatches the Agent-as-a-Judge step of the acceptance stage: per-end-state
 * PASS / FAIL / UNREACHABLE verdicts for ONE journey, grounded in rendered
 * artifacts with MANDATORY evidence citations.
 *
 * SEPARATE LINEAGE BY CONSTRUCTION (guardrail b): the params accept the
 * journey (from the TRUSTED registry) and the rendered artifacts — there is
 * no parameter through which a story diff, files_modified list, or
 * implementer transcript could reach the prompt. Tests pin this.
 *
 * Invalid judge output retries ONCE with a corrective preamble, then returns
 * error `acceptance-judge-invalid` — never a silent pass, never an inferred
 * verdict (AC3).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../../utils/logger.js'
import { assemblePrompt } from './prompt-assembler.js'
import { AcceptanceJudgeResultSchema } from './schemas.js'
import type { AcceptanceJudgeVerdict } from './schemas.js'
import { getTokenCeiling } from './token-ceiling.js'
import type { WorkflowDeps } from './types.js'
import type { Journey } from '@substrate-ai/sdlc'

const logger = createLogger('compiled-workflows:acceptance-judge')

/** Cap per-artifact content injected into the prompt (chars). */
const ARTIFACT_CONTENT_CAP = 16_000

export interface AcceptanceJudgeParams {
  /** The journey under judgment — from the TRUSTED registry, never a worktree copy. */
  journey: Journey
  /** External artifacts dir produced by the render executor. */
  artifactsDir: string
  /** Relative artifact paths (the render result's manifest). */
  artifacts: string[]
  /** Story attribution for telemetry/cost only — never enters the prompt. */
  storyKey?: string
}

export interface AcceptanceJudgeWorkflowResult {
  result: 'success' | 'failed'
  /** One verdict per end-state (success only; validated complete + known ids). */
  verdicts?: AcceptanceJudgeVerdict[]
  error?: string
  details?: string
  tokenUsage: { input: number; output: number }
}

function renderEndStates(journey: Journey): string {
  return journey.end_states
    .map((es) => `- id: ${es.id}\n  given: ${es.given}\n  walk: ${es.walk}\n  then: ${es.then}`)
    .join('\n')
}

async function renderArtifactContents(artifactsDir: string, artifacts: string[]): Promise<string> {
  const blocks: string[] = []
  for (const rel of artifacts) {
    let content: string
    try {
      content = await readFile(join(artifactsDir, rel), 'utf-8')
    } catch {
      blocks.push(`--- ${rel} ---\n(unreadable or binary — judge from the other artifacts)`)
      continue
    }
    const truncated = content.length > ARTIFACT_CONTENT_CAP
    blocks.push(
      `--- ${rel}${truncated ? ` (truncated to first ${String(ARTIFACT_CONTENT_CAP)} chars)` : ''} ---\n` +
        content.slice(0, ARTIFACT_CONTENT_CAP),
    )
  }
  return blocks.join('\n\n')
}

/** Validate verdict completeness: every end-state exactly once, no unknown ids. */
export function validateVerdictCoverage(
  journey: Journey,
  verdicts: AcceptanceJudgeVerdict[],
): string | undefined {
  const expected = new Set(journey.end_states.map((es) => es.id))
  const seen = new Set<string>()
  for (const v of verdicts) {
    if (!expected.has(v.end_state_id)) return `verdict for unknown end-state id "${v.end_state_id}"`
    if (seen.has(v.end_state_id)) return `duplicate verdict for end-state "${v.end_state_id}"`
    seen.add(v.end_state_id)
  }
  const missing = [...expected].filter((id) => !seen.has(id))
  if (missing.length > 0) return `missing verdict(s) for end-state(s): ${missing.join(', ')}`
  return undefined
}

export async function runAcceptanceJudge(
  deps: WorkflowDeps,
  params: AcceptanceJudgeParams,
): Promise<AcceptanceJudgeWorkflowResult> {
  const { journey, artifactsDir, artifacts, storyKey } = params

  let template: string
  try {
    template = await deps.pack.getPrompt('acceptance-judge')
  } catch (err) {
    return {
      result: 'failed',
      error: `Failed to retrieve acceptance-judge prompt: ${err instanceof Error ? err.message : String(err)}`,
      tokenUsage: { input: 0, output: 0 },
    }
  }

  const artifactContents = await renderArtifactContents(artifactsDir, artifacts)
  const buildPrompt = (correctivePreamble?: string): string => {
    const { prompt } = assemblePrompt(
      template,
      [
        { name: 'journey_id', content: journey.id, priority: 'required' },
        { name: 'journey_title', content: journey.title, priority: 'required' },
        { name: 'end_states', content: renderEndStates(journey), priority: 'required' },
        {
          name: 'artifact_manifest',
          content: artifacts.length > 0 ? artifacts.map((a) => `- ${a}`).join('\n') : '(no artifacts)',
          priority: 'required',
        },
        { name: 'artifact_contents', content: artifactContents, priority: 'required' },
      ],
      getTokenCeiling('acceptance-judge', deps.tokenCeilings).ceiling,
    )
    return correctivePreamble !== undefined ? `${correctivePreamble}\n\n${prompt}` : prompt
  }

  let totalTokens = { input: 0, output: 0 }
  let lastProblem = 'unknown'

  // AC3: one dispatch + one corrective retry, then acceptance-judge-invalid.
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? buildPrompt()
        : buildPrompt(
            `PREVIOUS ATTEMPT REJECTED: ${lastProblem}. Emit ONLY the YAML block per the Output Contract — ` +
              `every end-state exactly once, every verdict with evidence {artifact, excerpt}.`,
          )

    const handle = deps.dispatcher.dispatch({
      prompt,
      agent: deps.agentId ?? 'claude-code',
      taskType: 'acceptance-judge',
      outputSchema: AcceptanceJudgeResultSchema,
      maxTurns: 20,
      workingDirectory: artifactsDir,
      ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
      ...(storyKey !== undefined ? { storyKey } : {}),
    })

    let dispatchResult
    try {
      dispatchResult = await handle.result
    } catch (err) {
      return {
        result: 'failed',
        error: `Dispatch error: ${err instanceof Error ? err.message : String(err)}`,
        tokenUsage: totalTokens,
      }
    }
    totalTokens = {
      input: totalTokens.input + dispatchResult.tokenEstimate.input,
      output: totalTokens.output + dispatchResult.tokenEstimate.output,
    }

    if (dispatchResult.status === 'failed' || dispatchResult.status === 'timeout') {
      return {
        result: 'failed',
        error: `Dispatch status: ${dispatchResult.status}. ${dispatchResult.parseError ?? ''}`.trim(),
        tokenUsage: totalTokens,
      }
    }

    const parsed = AcceptanceJudgeResultSchema.safeParse(dispatchResult.parsed)
    if (!parsed.success) {
      lastProblem = `output failed schema validation (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500)})`
      logger.warn({ journeyId: journey.id, storyKey, attempt, lastProblem }, 'A2.1: judge output invalid')
      continue
    }
    if (parsed.data.result === 'failed') {
      return {
        result: 'failed',
        error: 'acceptance-judge-refused',
        details: parsed.data.error ?? 'judge reported failure without a reason',
        tokenUsage: totalTokens,
      }
    }
    const coverageProblem = validateVerdictCoverage(journey, parsed.data.verdicts)
    if (coverageProblem !== undefined) {
      lastProblem = coverageProblem
      logger.warn({ journeyId: journey.id, storyKey, attempt, coverageProblem }, 'A2.1: judge verdicts incomplete')
      continue
    }

    logger.info(
      { journeyId: journey.id, storyKey, verdicts: parsed.data.verdicts.map((v) => `${v.end_state_id}=${v.verdict}`) },
      'A2.1: acceptance judge verdicts accepted',
    )
    return { result: 'success', verdicts: parsed.data.verdicts, tokenUsage: totalTokens }
  }

  return {
    result: 'failed',
    error: 'acceptance-judge-invalid',
    details: `judge produced invalid output twice — last problem: ${lastProblem}`,
    tokenUsage: totalTokens,
  }
}
