import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { LLMSummaryEngine } from '../summarizer.js'
import type { LLMRequest, LLMResponse } from '../../llm/types.js'
import type { Summary } from '../summary-types.js'

// ---------------------------------------------------------------------------
// Mock LLM client
// ---------------------------------------------------------------------------

class MockLLMClient {
  public lastRequest: LLMRequest | undefined
  public callCount = 0
  public responseContent = 'summarized text'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = request
    this.callCount++
    return {
      content: this.responseContent,
      toolCalls: [],
      usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
      model: request.model,
      stopReason: 'stop' as const,
      providerMetadata: {},
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPromptText(client: MockLLMClient): string {
  const parts = client.lastRequest?.messages[0]?.content ?? []
  return parts.map((p) => p.text ?? '').join('')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LLMSummaryEngine', () => {
  // AC7: constructor + name field
  it('has name === "llm" and exposes summarize and expand methods', () => {
    const client = new MockLLMClient()
    const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
    expect(engine.name).toBe('llm')
    expect(typeof engine.summarize).toBe('function')
    expect(typeof engine.expand).toBe('function')
  })

  // ---------------------------------------------------------------------------
  // AC1: Structural preservation
  // ---------------------------------------------------------------------------

  describe('AC1 — structural preservation', () => {
    it('prompt contains "verbatim"', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      await engine.summarize('some content', 'medium')
      expect(getPromptText(client).toLowerCase()).toContain('verbatim')
    })

    it('prompt contains "code block"', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      await engine.summarize('some content', 'medium')
      expect(getPromptText(client).toLowerCase()).toContain('code block')
    })

    it('returned Summary.content equals mock response content', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const summary = await engine.summarize('some content', 'medium')
      expect(summary.content).toBe('summarized text')
    })
  })

  // ---------------------------------------------------------------------------
  // AC2: Prompt targets token budget
  // ---------------------------------------------------------------------------

  describe('AC2 — token budget in prompt', () => {
    it('prompt includes target token count when modelTokenLimit is provided (200_000 × 0.5 = 100_000)', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      await engine.summarize('content', 'medium', { modelTokenLimit: 200_000 })
      // Math.floor(200_000 * 0.5) = 100_000
      expect(getPromptText(client)).toContain('100000')
    })

    it('prompt uses default 100_000 token limit when modelTokenLimit is omitted (100_000 × 0.5 = 50_000)', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      await engine.summarize('content', 'medium')
      // Math.floor(100_000 * 0.5) = 50_000
      expect(getPromptText(client)).toContain('50000')
    })
  })

  // ---------------------------------------------------------------------------
  // AC3: SHA-256 hash and token counts
  // ---------------------------------------------------------------------------

  describe('AC3 — originalHash and token counts', () => {
    it('originalHash matches SHA-256 of original content', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const testContent = 'hello world content for hashing'
      const expectedHash = createHash('sha256').update(testContent).digest('hex')
      const summary = await engine.summarize(testContent, 'medium')
      expect(summary.originalHash).toBe(expectedHash)
    })

    it('originalTokenCount is set from LLMResponse.usage.inputTokens (500)', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const summary = await engine.summarize('some content', 'medium')
      expect(summary.originalTokenCount).toBe(500)
    })

    it('summaryTokenCount is set from LLMResponse.usage.outputTokens (100)', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const summary = await engine.summarize('some content', 'medium')
      expect(summary.summaryTokenCount).toBe(100)
    })
  })

  // ---------------------------------------------------------------------------
  // AC4: expand() lossless path with originalContent
  // ---------------------------------------------------------------------------

  describe('AC4 — expand() lossless path (originalContent provided)', () => {
    it('returns originalContent directly without calling the LLM', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const fakeSummary: Summary = {
        level: 'medium',
        content: 'summarized text',
        originalHash: 'abc123',
        createdAt: new Date().toISOString(),
      }
      const result = await engine.expand(fakeSummary, 'full', { originalContent: 'original text' })
      expect(result).toBe('original text')
    })

    it('does NOT call LLM when originalContent is provided (callCount stays at 0)', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const fakeSummary: Summary = {
        level: 'medium',
        content: 'summarized text',
        originalHash: 'abc123',
        createdAt: new Date().toISOString(),
      }
      await engine.expand(fakeSummary, 'full', { originalContent: 'original text' })
      expect(client.callCount).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // AC5: expand() LLM path when originalContent is absent
  // ---------------------------------------------------------------------------

  describe('AC5 — expand() LLM path (no originalContent)', () => {
    it('calls LLM when no originalContent is provided', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const fakeSummary: Summary = {
        level: 'medium',
        content: 'summarized text here',
        originalHash: 'abc123',
        createdAt: new Date().toISOString(),
      }
      await engine.expand(fakeSummary, 'full')
      expect(client.callCount).toBe(1)
    })

    it('captured prompt contains summary.content', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)
      const fakeSummary: Summary = {
        level: 'medium',
        content: 'summarized text here',
        originalHash: 'abc123',
        createdAt: new Date().toISOString(),
      }
      await engine.expand(fakeSummary, 'full')
      expect(getPromptText(client)).toContain('summarized text here')
    })
  })

  // ---------------------------------------------------------------------------
  // AC6: Round-trip structural fidelity via originalContent path
  // ---------------------------------------------------------------------------

  describe('AC6 — round-trip structural fidelity', () => {
    it('expand() with originalContent returns original content exactly', async () => {
      const client = new MockLLMClient()
      const engine = new LLMSummaryEngine(client as unknown as import('../../llm/client.js').LLMClient)

      const originalContent = `Some preamble text.

\`\`\`typescript
const x = 1
const y = 2
\`\`\`

See also src/foo/bar.ts for details.`

      const summary = await engine.summarize(originalContent, 'medium')
      const expanded = await engine.expand(summary, 'full', { originalContent })
      expect(expanded).toBe(originalContent)
    })
  })
})
