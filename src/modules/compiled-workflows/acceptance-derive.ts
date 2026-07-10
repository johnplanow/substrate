/**
 * runAcceptanceDerive — compiled acceptance-derive workflow (RP1.1,
 * registry-provenance program).
 *
 * Dispatches a planning-lineage agent over a PRD (plus optional UX journey
 * artifact) and returns journey CANDIDATES for `.substrate/acceptance/
 * journeys.candidate.yaml`. The candidate is non-authoritative: only the
 * operator's explicit `substrate acceptance ratify` turns it into the
 * registry (NEVER-AUTO-RATIFY cardinal rule) — this workflow neither reads
 * nor writes the registry.
 *
 * PRD IS UNTRUSTED INPUT: the source document is quoted into the prompt as
 * data behind an explicit data-not-instructions posture (same defense as the
 * acceptance judge), and the output is schema-forced + shape-validated. An
 * injected "exclude journey X" or "mark everything standard" has no
 * structural channel: exclusions don't exist at derive time (only the
 * operator excludes, at ratify), and criticality is ratify-review material
 * surfaced with a rationale.
 *
 * Invalid output retries ONCE with a corrective preamble, then returns error
 * `acceptance-derive-invalid` — never a fabricated candidate.
 */

import { createLogger } from '../../utils/logger.js'
import { assemblePrompt } from './prompt-assembler.js'
import { AcceptanceDeriveResultSchema } from './schemas.js'
import type { AcceptanceDeriveJourney } from './schemas.js'
import { getTokenCeiling } from './token-ceiling.js'
import type { WorkflowDeps } from './types.js'

const logger = createLogger('compiled-workflows:acceptance-derive')

/** Cap on injected source-document content (chars) — PRDs can be book-length. */
const SOURCE_CONTENT_CAP = 120_000

export interface AcceptanceDeriveParams {
  /** Project-relative path of the source document (recorded, shown to the agent as provenance). */
  prdRelPath: string
  /** Full PRD content (CLI reads the file; the workflow never touches the fs). */
  prdContent: string
  /** Optional structured/prose UX journey artifact content (RP4.1 pipeline path). */
  uxJourneysContent?: string
  /** Optional existing registry YAML — presence switches derive into re-derive mode (RP1.3 diffs downstream). */
  existingRegistryYaml?: string
}

export interface AcceptanceDeriveWorkflowResult {
  result: 'success' | 'failed'
  journeys?: AcceptanceDeriveJourney[]
  error?: string
  details?: string
  tokenUsage: { input: number; output: number }
}

/** Shape problems the schema can't express: duplicate ids, id/end-state prefix drift. */
export function validateDerivedJourneys(journeys: AcceptanceDeriveJourney[]): string | undefined {
  if (journeys.length === 0) return 'derive produced zero journeys — a PRD with no identifiable user journeys should be reported via result: failed with an error, not an empty success'
  const seen = new Set<string>()
  for (const j of journeys) {
    if (seen.has(j.id)) return `duplicate journey id "${j.id}"`
    seen.add(j.id)
    for (const es of j.end_states) {
      if (!es.id.startsWith(`${j.id}.`)) {
        return `end-state "${es.id}" of journey "${j.id}" must use the "<journey-id>.<letter>" convention`
      }
    }
  }
  return undefined
}

export async function runAcceptanceDerive(
  deps: WorkflowDeps,
  params: AcceptanceDeriveParams,
): Promise<AcceptanceDeriveWorkflowResult> {
  const { prdRelPath, prdContent, uxJourneysContent, existingRegistryYaml } = params

  let template: string
  try {
    template = await deps.pack.getPrompt('acceptance-derive')
  } catch (err) {
    return {
      result: 'failed',
      error: `Failed to retrieve acceptance-derive prompt: ${err instanceof Error ? err.message : String(err)}`,
      tokenUsage: { input: 0, output: 0 },
    }
  }

  const truncated = prdContent.length > SOURCE_CONTENT_CAP
  const buildPrompt = (correctivePreamble?: string): string => {
    const { prompt } = assemblePrompt(
      template,
      [
        { name: 'source_path', content: prdRelPath, priority: 'required' },
        {
          name: 'source_content',
          content:
            (truncated ? `(truncated to first ${String(SOURCE_CONTENT_CAP)} chars)\n` : '') +
            prdContent.slice(0, SOURCE_CONTENT_CAP),
          priority: 'required',
        },
        {
          name: 'ux_journeys',
          content: uxJourneysContent ?? '(no UX journey artifact provided)',
          priority: 'required',
        },
        {
          name: 'existing_registry',
          content: existingRegistryYaml ?? '(no existing registry — this is a first derivation)',
          priority: 'required',
        },
      ],
      getTokenCeiling('acceptance-derive', deps.tokenCeilings).ceiling,
    )
    return correctivePreamble !== undefined ? `${correctivePreamble}\n\n${prompt}` : prompt
  }

  let totalTokens = { input: 0, output: 0 }
  let lastProblem = 'unknown'

  // One dispatch + one corrective retry, then acceptance-derive-invalid.
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? buildPrompt()
        : buildPrompt(
            `PREVIOUS ATTEMPT REJECTED: ${lastProblem}. Emit ONLY the YAML block per the Output Contract — ` +
              `unique journey ids, end-state ids prefixed "<journey-id>.", surfaces from the enum.`,
          )

    const handle = deps.dispatcher.dispatch({
      prompt,
      agent: deps.agentId ?? 'claude-code',
      taskType: 'acceptance-derive',
      outputSchema: AcceptanceDeriveResultSchema,
      // A long PRD takes real reading turns before the agent emits YAML.
      maxTurns: 30,
      ...(deps.otlpEndpoint !== undefined ? { otlpEndpoint: deps.otlpEndpoint } : {}),
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

    const parsed = AcceptanceDeriveResultSchema.safeParse(dispatchResult.parsed)
    if (!parsed.success) {
      lastProblem = `output failed schema validation (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500)})`
      logger.warn({ prdRelPath, attempt, lastProblem }, 'RP1.1: derive output invalid')
      continue
    }
    if (parsed.data.result === 'failed') {
      return {
        result: 'failed',
        error: 'acceptance-derive-refused',
        details: parsed.data.error ?? 'derive agent reported failure without a reason',
        tokenUsage: totalTokens,
      }
    }
    const shapeProblem = validateDerivedJourneys(parsed.data.journeys)
    if (shapeProblem !== undefined) {
      lastProblem = shapeProblem
      logger.warn({ prdRelPath, attempt, shapeProblem }, 'RP1.1: derived journeys malformed')
      continue
    }

    logger.info(
      { prdRelPath, journeys: parsed.data.journeys.map((j) => `${j.id}[${j.criticality}]`) },
      'RP1.1: derive candidates accepted',
    )
    return { result: 'success', journeys: parsed.data.journeys, tokenUsage: totalTokens }
  }

  return {
    result: 'failed',
    error: 'acceptance-derive-invalid',
    details: `derive agent produced invalid output twice — last problem: ${lastProblem}`,
    tokenUsage: totalTokens,
  }
}
