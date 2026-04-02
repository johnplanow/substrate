/**
 * OutputQualityEstimator — lightweight pre-schema quality signal extraction.
 *
 * Analyzes raw agent stdout for indicators of output quality before the YAML
 * extraction and schema validation pipeline runs. Provides early signals for
 * backends that lack OTLP telemetry (e.g., Codex, Gemini).
 *
 * Signals detected:
 * - Hedging language ("I couldn't", "I was unable", "I'm not sure")
 * - Completeness indicators (test results, file modification mentions)
 * - Error/failure mentions in the narrative
 * - Output length relative to expectations
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputQualitySignals {
  /** Number of hedging phrases detected (uncertainty, inability) */
  hedgingCount: number
  /** Specific hedging phrases found */
  hedgingPhrases: string[]
  /** Whether the output mentions running tests */
  mentionsTestExecution: boolean
  /** Whether the output mentions test passes */
  mentionsTestPass: boolean
  /** Whether the output mentions test failures */
  mentionsTestFailure: boolean
  /** Number of file modification mentions (created, modified, updated) */
  fileModificationMentions: number
  /** Whether the output contains error/exception mentions in narrative */
  mentionsErrors: boolean
  /** Raw output character count */
  outputLength: number
  /** Estimated quality score 0-100 (higher = better) */
  qualityScore: number
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const HEDGING_PATTERNS: RegExp[] = [
  /I (?:couldn't|could not|can't|cannot|was unable to|am unable to)/i,
  /I'm not sure/i,
  /I (?:don't|do not) (?:know|understand) how/i,
  /(?:unfortunately|regrettably),? I/i,
  /I (?:wasn't|was not) able to/i,
  /this is beyond/i,
  /I need (?:more information|clarification|help)/i,
  /I (?:skipped|omitted|left out)/i,
  /TODO:? (?:implement|fix|add|complete)/i,
]

const TEST_EXECUTION_PATTERNS: RegExp[] = [
  /(?:running|ran|executing|executed) (?:the )?tests/i,
  /npm (?:run )?test/i,
  /npx (?:vitest|jest|mocha|pytest)/i,
  /turbo (?:run )?test/i,
  /test suite/i,
]

const TEST_PASS_PATTERNS: RegExp[] = [
  /tests? pass(?:ed|ing)?/i,
  /all tests pass/i,
  /\d+ pass(?:ed|ing)/i,
  /test(?:s)? (?:are )?(?:all )?(?:passing|green)/i,
]

const TEST_FAILURE_PATTERNS: RegExp[] = [
  /tests? fail(?:ed|ing|ure)?/i,
  /\d+ fail(?:ed|ing|ure)/i,
  /test(?:s)? (?:are )?(?:failing|red|broken)/i,
  /FAIL\s/,
]

const FILE_MODIFICATION_PATTERNS: RegExp[] = [
  /(?:created|modified|updated|wrote|wrote to|editing|changed) (?:file |the file )?[`"']?[\w/.]+\.\w+/i,
  /writing (?:to )?[`"']?[\w/.]+\.\w+/i,
]

const ERROR_PATTERNS: RegExp[] = [
  /(?:error|exception|stack trace|traceback):/i,
  /(?:TypeError|SyntaxError|ReferenceError|ImportError|ModuleNotFoundError)/,
  /compilation (?:error|failed)/i,
  /build (?:error|failed)/i,
]

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

/**
 * Analyze raw agent output for quality signals.
 *
 * This is intentionally lightweight — it scans for patterns in the text
 * without parsing structure. The goal is early detection of problematic
 * outputs (agent gave up, didn't run tests, hit errors) before the
 * heavier YAML extraction + schema validation pipeline runs.
 */
export function estimateOutputQuality(output: string): OutputQualitySignals {
  if (!output || output.trim() === '') {
    return {
      hedgingCount: 0,
      hedgingPhrases: [],
      mentionsTestExecution: false,
      mentionsTestPass: false,
      mentionsTestFailure: false,
      fileModificationMentions: 0,
      mentionsErrors: false,
      outputLength: 0,
      qualityScore: 0,
    }
  }

  // Detect hedging
  const hedgingPhrases: string[] = []
  for (const pattern of HEDGING_PATTERNS) {
    const match = output.match(pattern)
    if (match) {
      hedgingPhrases.push(match[0])
    }
  }

  // Detect test execution/results
  const mentionsTestExecution = TEST_EXECUTION_PATTERNS.some((p) => p.test(output))
  const mentionsTestPass = TEST_PASS_PATTERNS.some((p) => p.test(output))
  const mentionsTestFailure = TEST_FAILURE_PATTERNS.some((p) => p.test(output))

  // Count file modification mentions
  let fileModificationMentions = 0
  for (const pattern of FILE_MODIFICATION_PATTERNS) {
    const matches = output.match(new RegExp(pattern.source, 'gi'))
    if (matches) fileModificationMentions += matches.length
  }

  // Detect errors
  const mentionsErrors = ERROR_PATTERNS.some((p) => p.test(output))

  // Detect YAML result block (strong quality signal — agent followed output contract)
  const hasYamlBlock = /```yaml[\s\S]*?```/.test(output) || /^result:\s/m.test(output)

  // Detect completion language
  const mentionsCompletion = /(?:all tasks? (?:complete|done|finished)|implementation complete|AC\d? met|story complete)/i.test(output)

  // Compute quality score (0-100)
  // Start pessimistic (30) — agent must demonstrate quality through positive signals
  let score = 30

  // Strong positive: YAML output block present (+20)
  if (hasYamlBlock) score += 20

  // Positive signals
  if (mentionsTestExecution) score += 10
  if (mentionsTestPass) score += 15
  if (mentionsCompletion) score += 10
  if (fileModificationMentions > 0) score += Math.min(10, fileModificationMentions * 3)
  if (output.length > 5000) score += 5 // substantial output

  // Negative signals
  score -= hedgingPhrases.length * 15
  if (mentionsTestFailure) score -= 15
  if (mentionsErrors) score -= 10
  if (output.length < 200) score -= 20 // suspiciously short
  if (!hasYamlBlock && output.length > 1000) score -= 10 // long output but no YAML = likely didn't follow contract

  // Clamp
  score = Math.max(0, Math.min(100, score))

  return {
    hedgingCount: hedgingPhrases.length,
    hedgingPhrases,
    mentionsTestExecution,
    mentionsTestPass,
    mentionsTestFailure,
    fileModificationMentions,
    mentionsErrors,
    outputLength: output.length,
    qualityScore: score,
  }
}
