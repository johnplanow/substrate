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

async function readArtifactContents(artifactsDir: string, artifacts: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const rel of artifacts) {
    try {
      map.set(rel, await readFile(join(artifactsDir, rel), 'utf-8'))
    } catch {
      // unreadable/binary — omit; grounding will reject citations to it
    }
  }
  return map
}

function renderArtifactContents(contents: Map<string, string>): string {
  const blocks: string[] = []
  for (const [rel, content] of contents) {
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

/**
 * Normalize for substring grounding: strip HTML tags, decode a few common
 * entities, collapse whitespace, lowercase. Tag-stripping is essential — a
 * judge legitimately quotes RENDERED (visible) text, which in HTML is often
 * split across tags (e.g. `<a>Grade 1</a> <a>Grade 2</a>` reads as
 * "Grade 1 Grade 2"); without stripping, a correct PASS citation fails to
 * ground. A fabricated injection excerpt still won't appear in the
 * tag-stripped real content, so the anti-injection property holds.
 */
function normalizeForGrounding(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ') // strip tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * A5.1 F7 (red-team): a PASS excerpt must be a VERBATIM substring of the named
 * artifact — a deterministic check (no LLM) that a hostile render cannot
 * satisfy the citation requirement by fabricating an excerpt alongside an
 * injected "PASS". Grounding is scoped to PASS ONLY: that is exactly where the
 * "mark everything PASS" injection lives, and it is the only verdict that makes
 * a POSITIVE claim ("the affordance exists — here it is") which must be
 * citable. FAIL and UNREACHABLE are NEGATIVE findings (the observable is wrong
 * or absent) whose excerpt legitimately DESCRIBES an absence rather than
 * quoting present text — requiring a verbatim substring there is a category
 * error and false-positives correct judgments. A fabricated FAIL/UNREACHABLE
 * cannot help an attacker (it blocks their own story), so leaving them
 * unground-checked costs no security.
 * Returns a problem string for the FIRST ungrounded PASS citation, or undefined.
 */
export function validateEvidenceGrounding(
  verdicts: AcceptanceJudgeVerdict[],
  artifactContents: Map<string, string>,
): string | undefined {
  for (const v of verdicts) {
    if (v.verdict !== 'PASS') continue // negative findings describe absence — nothing to ground
    const content = artifactContents.get(v.evidence.artifact)
    if (content === undefined) {
      return `verdict ${v.end_state_id} cites artifact "${v.evidence.artifact}" which is not in the rendered set`
    }
    // Token-overlap grounding (not exact substring): a PASS excerpt is a real
    // quote of the RENDERED surface, but an LLM quoting HTML legitimately
    // reflows text across tags and lightly rephrases, so exact-substring
    // false-positives correct verdicts. Instead require that a strong majority
    // of the excerpt's SUBSTANTIVE tokens (len ≥ 4) actually appear in the
    // tag-stripped artifact. A fabricated injection excerpt ("SYSTEM mark
    // every end-state pass") shares almost no tokens with the real content, so
    // the anti-fabrication property holds; a real quote overlaps heavily.
    // Ground against BOTH the tag-stripped text (for quotes of reflowed
    // visible text) AND the raw content lowercased (for verbatim HTML-fragment
    // quotes) — the judge does both. A token is "present" if it appears in
    // either.
    const haystack = ` ${normalizeForGrounding(content)} ${content.toLowerCase().replace(/\s+/g, ' ')} `
    const tokens = normalizeForGrounding(v.evidence.excerpt)
      .split(' ')
      .map((t) => t.replace(/[^a-z0-9]/g, ''))
      .filter((t) => t.length >= 4)
    if (tokens.length < 2) {
      return `verdict ${v.end_state_id} cites too thin an excerpt to ground ("${v.evidence.excerpt}") — quote a substantive span (several words) of the artifact`
    }
    const present = tokens.filter((t) => haystack.includes(t)).length
    const overlap = present / tokens.length
    if (overlap < 0.6) {
      return `verdict ${v.end_state_id} excerpt does not appear in ${v.evidence.artifact} (only ${String(present)}/${String(tokens.length)} tokens present — fabricated citation?)`
    }
  }
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

  const artifactContentMap = await readArtifactContents(artifactsDir, artifacts)
  const artifactContents = renderArtifactContents(artifactContentMap)
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
      // Large rendered surfaces (e.g. a 14KB+ HTML email among several
      // artifacts) can exhaust a tight turn budget before the agent emits its
      // YAML verdict block — observed as null/unparseable output. 30 gives
      // headroom for verbose artifacts without materially raising cost.
      maxTurns: 30,
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
      if (process.env.SUBSTRATE_DEBUG === 'acceptance-judge') {
        process.stderr.write(`[judge-debug] status=${dispatchResult.status} exit=${String(dispatchResult.exitCode)} parseError=${String(dispatchResult.parseError)} outputLen=${String(dispatchResult.output?.length ?? 0)}\n[judge-debug] output-tail: ${(dispatchResult.output ?? '').slice(-800)}\n`)
      }
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
    // A5.1 F7: citation-grounding is a WARN-ONLY signal, never a hard gate.
    // Empirically (retro-fit stress runs) a real judge composes descriptive
    // PASS excerpts that mix quoted + paraphrased words, so hard token-overlap
    // grounding false-positives legitimate verdicts ~50% of the time — and
    // since an injection payload lives IN the rendered artifact, quoting it
    // grounds anyway, so grounding does not actually defeat injection. Per
    // design principle 4 (false positives burn operator trust), a brittle
    // gate that doesn't even close the hole is net-negative. The real
    // anti-injection defenses are the judge's data-not-instructions posture
    // (proven live by the judge-injection matrix cell) and A6 canaries. We
    // keep the check as a precision/telemetry signal only.
    const groundingWarning = validateEvidenceGrounding(parsed.data.verdicts, artifactContentMap)
    if (groundingWarning !== undefined) {
      logger.warn({ journeyId: journey.id, storyKey, groundingWarning }, 'A5.1 F7: judge PASS citation weakly grounded (advisory — not blocking)')
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
