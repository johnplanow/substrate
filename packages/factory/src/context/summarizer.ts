/**
 * LLMSummaryEngine — LLM-backed implementation of the SummaryEngine interface.
 *
 * Compresses long context strings to a target level while preserving structural
 * elements (code blocks, file paths, error messages) for faithful recovery.
 */
import { createHash } from 'node:crypto'
import type { LLMClient } from '../llm/client.js'
import type { LLMRequest } from '../llm/types.js'
import type { SummaryEngine } from './summary-engine.js'
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from './summary-types.js'
import { SUMMARY_BUDGET } from './summary-types.js'

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSummarizePrompt(
  content: string,
  targetTokenCount: number,
  opts: SummarizeOptions,
): string {
  const preserveCodeBlocks = opts.preserveCodeBlocks ?? true
  const preserveFilePaths = opts.preserveFilePaths ?? true
  const preserveErrorMessages = opts.preserveErrorMessages ?? true

  return `Summarize the following content to approximately ${targetTokenCount} tokens.

PRESERVATION RULES (MANDATORY — do NOT paraphrase or omit):
${preserveCodeBlocks ? '- Code blocks (triple-backtick fenced sections): copy VERBATIM' : ''}
${preserveFilePaths ? '- File paths (e.g. src/foo/bar.ts, /absolute/path): copy VERBATIM' : ''}
${preserveErrorMessages ? '- Error messages and stack traces: copy VERBATIM' : ''}
- Key decisions, conclusions, and action items: preserve the substance

REDUCTION RULES (apply in order of preference):
1. Remove verbose explanations and commentary
2. Shorten transition sentences between sections
3. Condense repetitive content to a single representative example
4. Summarize narrative prose into concise bullet points

Content:
---
${content}
---`
}

function buildExpandPrompt(summary: Summary): string {
  return `The following is a ${summary.level}-level summary of a longer technical document.
Expand it back toward the full version by restoring context, explanations, and detail that would have been in the original.

EXPANSION RULES:
- Preserve all code blocks VERBATIM as they appear in the summary
- Preserve all file paths VERBATIM as they appear in the summary
- Preserve all error messages VERBATIM as they appear in the summary
- Infer and restore narrative context and explanations from the summary's content

Summary (${summary.level} level):
---
${summary.content}
---`
}

// ---------------------------------------------------------------------------
// LLMSummaryEngine
// ---------------------------------------------------------------------------

export class LLMSummaryEngine implements SummaryEngine {
  readonly name = 'llm'

  constructor(
    private readonly llmClient: LLMClient,
    private readonly modelName: string = 'claude-opus-4-5',
  ) {}

  async summarize(
    content: string,
    targetLevel: SummaryLevel,
    opts?: SummarizeOptions,
  ): Promise<Summary> {
    const originalHash = createHash('sha256').update(content).digest('hex')

    const resolvedOpts: SummarizeOptions = opts ?? {}
    const modelTokenLimit = resolvedOpts.modelTokenLimit ?? 100_000
    const targetTokenCount = Math.floor(modelTokenLimit * SUMMARY_BUDGET[targetLevel])

    const prompt = buildSummarizePrompt(content, targetTokenCount, resolvedOpts)

    const request: LLMRequest = {
      model: this.modelName,
      messages: [
        {
          role: 'user',
          content: [{ kind: 'text', text: prompt }],
        },
      ],
      maxTokens: targetTokenCount + 500,
    }

    const response = await this.llmClient.complete(request)

    return {
      level: targetLevel,
      content: response.content,
      originalHash,
      createdAt: new Date().toISOString(),
      originalTokenCount: response.usage.inputTokens,
      summaryTokenCount: response.usage.outputTokens,
    }
  }

  async expand(
    summary: Summary,
    targetLevel: SummaryLevel,
    opts?: ExpandOptions,
  ): Promise<string> {
    if (opts?.originalContent) {
      return opts.originalContent
    }

    const prompt = buildExpandPrompt(summary)

    const request: LLMRequest = {
      model: this.modelName,
      messages: [
        {
          role: 'user',
          content: [{ kind: 'text', text: prompt }],
        },
      ],
    }

    const response = await this.llmClient.complete(request)
    return response.content
  }
}
