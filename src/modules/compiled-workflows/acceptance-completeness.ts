/**
 * runCompletenessCheck — compiled acceptance-completeness workflow (RP3.2,
 * registry-provenance program).
 *
 * The mirror of the acceptance gate's coverage invariant, one level up:
 * enumerate the journey-shaped claims a PRD makes and map each to a registry
 * disposition — registered, excluded (operator-recorded reason), or
 * UNDISPOSITIONED (the transcription-loss class this program exists to
 * close). Same separate-lineage posture as the judge: the checker sees the
 * PRD and the ratified registry, never the derivation conversation or any
 * implementer context.
 *
 * ADVISORY BY DESIGN (F7 lesson): PRD prose is fuzzy and the checker WILL
 * surface aspirational sentences that aren't really journeys — findings are
 * information with a one-command resolution path, never a block.
 *
 * Evidence rule, deterministically enforced: every claim must cite a PRD
 * span, and the span must actually GROUND in the document (token overlap) —
 * a fabricated citation retries once, then the whole check fails invalid
 * rather than emitting unverifiable findings.
 */

import { createLogger } from '../../utils/logger.js'
import { assemblePrompt } from './prompt-assembler.js'
import { AcceptanceCompletenessResultSchema } from './schemas.js'
import type { AcceptanceCompletenessClaim } from './schemas.js'
import { getTokenCeiling } from './token-ceiling.js'
import type { WorkflowDeps } from './types.js'
import type { JourneyRegistry } from '@substrate-ai/sdlc'

const logger = createLogger('compiled-workflows:acceptance-completeness')

const SOURCE_CONTENT_CAP = 120_000

export interface CompletenessCheckParams {
  prdRelPath: string
  prdContent: string
  /** The RATIFIED registry (trusted source) the claims are dispositioned against. */
  registry: JourneyRegistry
}

export interface CompletenessCheckResult {
  result: 'success' | 'failed'
  claims?: AcceptanceCompletenessClaim[]
  error?: string
  details?: string
  tokenUsage: { input: number; output: number }
}

function normalizeForGrounding(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Validate claims against the registry and the PRD (deterministic, no LLM):
 * - registered claims must cite a real journey id
 * - excluded claims must cite a real exclusion candidate
 * - every prd_span must ground in the document (≥0.6 substantive-token
 *   overlap — the judge's F7-calibrated threshold; verbatim quotes of a
 *   120k-char document ground trivially, fabrications don't)
 */
export function validateCompletenessClaims(
  claims: AcceptanceCompletenessClaim[],
  registry: JourneyRegistry,
  prdContent: string,
): string | undefined {
  const registered = new Set(registry.journeys.map((j) => j.id))
  const excluded = new Set((registry.provenance?.excluded ?? []).map((e) => e.candidate))
  const haystack = ` ${normalizeForGrounding(prdContent)} `
  for (const claim of claims) {
    if (claim.disposition === 'registered') {
      if (claim.registry_ref === undefined || !registered.has(claim.registry_ref)) {
        return `claim "${claim.description}" says registered but cites no real registry id (got ${JSON.stringify(claim.registry_ref)})`
      }
    }
    if (claim.disposition === 'excluded') {
      if (claim.registry_ref === undefined || !excluded.has(claim.registry_ref)) {
        return `claim "${claim.description}" says excluded but cites no real exclusion candidate (got ${JSON.stringify(claim.registry_ref)})`
      }
    }
    const tokens = normalizeForGrounding(claim.prd_span)
      .split(' ')
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length >= 4)
    if (tokens.length < 2) {
      return `claim "${claim.description}" cites too thin a prd_span ("${claim.prd_span}") — quote a substantive span of the document`
    }
    const present = tokens.filter((t) => haystack.includes(t)).length
    if (present / tokens.length < 0.6) {
      return `claim "${claim.description}" prd_span does not appear in ${'the document'} (only ${String(present)}/${String(tokens.length)} tokens present — fabricated citation?)`
    }
  }
  return undefined
}

function renderRegistryForPrompt(registry: JourneyRegistry): string {
  const journeys = registry.journeys
    .map((j) => `- id: ${j.id}\n  title: ${j.title}\n  criticality: ${j.criticality}`)
    .join('\n')
  const excluded = (registry.provenance?.excluded ?? [])
    .map((e) => `- candidate: ${e.candidate}\n  reason: ${e.reason}`)
    .join('\n')
  return (
    `Registered journeys (version ${String(registry.version)}):\n${journeys || '(none)'}\n\n` +
    `Operator-excluded candidates:\n${excluded || '(none)'}`
  )
}

export async function runCompletenessCheck(
  deps: WorkflowDeps,
  params: CompletenessCheckParams,
): Promise<CompletenessCheckResult> {
  const { prdRelPath, prdContent, registry } = params

  let template: string
  try {
    template = await deps.pack.getPrompt('acceptance-completeness')
  } catch (err) {
    return {
      result: 'failed',
      error: `Failed to retrieve acceptance-completeness prompt: ${err instanceof Error ? err.message : String(err)}`,
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
        { name: 'registry_summary', content: renderRegistryForPrompt(registry), priority: 'required' },
      ],
      getTokenCeiling('acceptance-completeness', deps.tokenCeilings).ceiling,
    )
    return correctivePreamble !== undefined ? `${correctivePreamble}\n\n${prompt}` : prompt
  }

  let totalTokens = { input: 0, output: 0 }
  let lastProblem = 'unknown'

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? buildPrompt()
        : buildPrompt(
            `PREVIOUS ATTEMPT REJECTED: ${lastProblem}. Emit ONLY the YAML block per the Output Contract — ` +
              `every claim with a VERBATIM prd_span; registered/excluded claims must cite real registry_ref values.`,
          )

    const handle = deps.dispatcher.dispatch({
      prompt,
      agent: deps.agentId ?? 'claude-code',
      taskType: 'acceptance-completeness',
      outputSchema: AcceptanceCompletenessResultSchema,
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

    const parsed = AcceptanceCompletenessResultSchema.safeParse(dispatchResult.parsed)
    if (!parsed.success) {
      lastProblem = `output failed schema validation (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500)})`
      logger.warn({ prdRelPath, attempt, lastProblem }, 'RP3.2: completeness output invalid')
      continue
    }
    if (parsed.data.result === 'failed') {
      return {
        result: 'failed',
        error: 'acceptance-completeness-refused',
        details: parsed.data.error ?? 'checker reported failure without a reason',
        tokenUsage: totalTokens,
      }
    }
    const problem = validateCompletenessClaims(parsed.data.claims, registry, prdContent)
    if (problem !== undefined) {
      lastProblem = problem
      logger.warn({ prdRelPath, attempt, problem }, 'RP3.2: completeness claims failed validation')
      continue
    }

    logger.info(
      {
        prdRelPath,
        claims: parsed.data.claims.length,
        undispositioned: parsed.data.claims.filter((c) => c.disposition === 'undispositioned').length,
      },
      'RP3.2: completeness claims accepted',
    )
    return { result: 'success', claims: parsed.data.claims, tokenUsage: totalTokens }
  }

  return {
    result: 'failed',
    error: 'acceptance-completeness-invalid',
    details: `checker produced invalid output twice — last problem: ${lastProblem}`,
    tokenUsage: totalTokens,
  }
}
