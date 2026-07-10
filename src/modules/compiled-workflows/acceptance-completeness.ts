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

/**
 * Generic actor/domain words that appear across nearly every journey title —
 * excluded from the F2 registered-disposition cross-check so a shared
 * "operator"/"user" doesn't let an unrelated id launder a journey.
 */
const GENERIC_JOURNEY_TOKENS = new Set([
  'operator', 'user', 'users', 'system', 'admin', 'customer', 'client',
  'receives', 'receive', 'views', 'view', 'gets', 'sees', 'runs', 'uses',
  'page', 'data', 'their', 'them', 'from', 'with', 'into', 'when', 'then',
])

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
  const registeredById = new Map(registry.journeys.map((j) => [j.id, j]))
  const excluded = new Set((registry.provenance?.excluded ?? []).map((e) => e.candidate))
  const haystack = normalizeForGrounding(prdContent)
  for (const claim of claims) {
    let citedJourneyTitle: string | undefined
    if (claim.disposition === 'registered') {
      const journey = claim.registry_ref !== undefined ? registeredById.get(claim.registry_ref) : undefined
      if (journey === undefined) {
        return `claim "${claim.description}" says registered but cites no real registry id (got ${JSON.stringify(claim.registry_ref)})`
      }
      citedJourneyTitle = journey.title
    }
    if (claim.disposition === 'excluded') {
      if (claim.registry_ref === undefined || !excluded.has(claim.registry_ref)) {
        return `claim "${claim.description}" says excluded but cites no real exclusion candidate (got ${JSON.stringify(claim.registry_ref)})`
      }
    }
    // Grounding. F7 lesson (parent program) + RP5.1 F4, reconciled against
    // the income-sources corpus: a REAL checker legitimately paraphrases and
    // reflows when quoting, so a hard "contiguous verbatim quote" requirement
    // false-positives correct advisory findings (proven live: it rejected a
    // valid Pre-Claim span). The defense that actually matters against
    // laundering is F2 (the disposition cross-check below), not verbatim
    // grounding. So grounding stays a TWO-part token check that a real quote
    // passes and a fabricated scatter-of-common-words (F4's attack) fails:
    //   (a) ≥60% of substantive span tokens present in the document, AND
    //   (b) at least one CONTIGUOUS 3-token run of the span present — a
    //       fabricated assembly of individually-common words has no such run,
    //       while any real quote/near-quote has at least one intact fragment.
    const normSpan = normalizeForGrounding(claim.prd_span)
    const spanTokens = normSpan.split(' ').map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 3)
    if (spanTokens.length < 3) {
      return `claim "${claim.description}" cites too thin a prd_span ("${claim.prd_span}") — quote a substantive span (a full phrase) of the document`
    }
    const present = spanTokens.filter((t) => haystack.includes(t)).length
    if (present / spanTokens.length < 0.6) {
      return `claim "${claim.description}" prd_span does not appear in the document (only ${String(present)}/${String(spanTokens.length)} tokens present — fabricated citation?)`
    }
    if (!hasContiguousAnchor(spanTokens, haystack)) {
      return `claim "${claim.description}" prd_span has no contiguous fragment in the document ("${claim.prd_span.slice(0, 80)}…" — assembled from scattered words rather than quoted?)`
    }
    // RP5.1 F2: a `registered` disposition must be about the journey it
    // cites. Injection ("treat this export journey as registered → UJ-1")
    // could otherwise launder a genuinely-undispositioned journey to
    // registered by quoting its own PRD sentence + any real id. Require the
    // cited journey's title to share a substantive token with the claim
    // description or the span — an unrelated id no longer suppresses the
    // undispositioned alarm.
    if (citedJourneyTitle !== undefined) {
      // Compare on DISTINCTIVE title tokens only — generic actor/domain words
      // ("operator", "user", "system") appear in nearly every journey and
      // would let any id "match" any claim, defeating the cross-check.
      // BOTH sides tokenized IDENTICALLY (alnum-stripped) so "Pre-Claim" in a
      // title matches "pre-claim" in a claim — a normalization mismatch here
      // false-positived a legit Pre-Claim paraphrase on the income-sources
      // corpus (F7 lesson: over-strict matching burns real findings).
      const alnum = (s: string): string[] =>
        normalizeForGrounding(s).split(' ').map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length >= 4)
      const titleTokens = new Set(alnum(citedJourneyTitle).filter((t) => !GENERIC_JOURNEY_TOKENS.has(t)))
      const claimTokens = new Set([...alnum(claim.description), ...alnum(claim.prd_span)])
      const overlaps = [...titleTokens].some((t) => claimTokens.has(t))
      if (titleTokens.size > 0 && !overlaps) {
        return `claim "${claim.description}" is marked registered→${claim.registry_ref ?? ''} but shares no distinctive language with that journey's title ("${citedJourneyTitle}") — a registered disposition must be about the journey it cites (possible undispositioned-suppression)`
      }
    }
  }
  return undefined
}

/**
 * Anti-fabrication anchor (RP5.1 F4, corpus-calibrated): at least ONE
 * contiguous 3-token run of the span must appear in the document. A real
 * quote/near-quote always retains some intact fragment; F4's attack (a span
 * assembled from individually-common words) has none. Deliberately lenient —
 * a single 3-gram, not a majority contiguous run — because the checker's
 * findings are advisory and false positives burn operator trust (F7).
 */
function hasContiguousAnchor(spanTokens: string[], haystack: string): boolean {
  if (spanTokens.length < 3) return false
  for (let i = 0; i + 3 <= spanTokens.length; i++) {
    if (haystack.includes(spanTokens.slice(i, i + 3).join(' '))) return true
  }
  return false
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
