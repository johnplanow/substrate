/**
 * Unit tests for llm-evaluator.ts (story 50-4).
 * Covers isLlmCondition, extractLlmQuestion, buildEvaluationPrompt,
 * parseLlmBoolResponse, and evaluateLlmCondition.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isLlmCondition,
  extractLlmQuestion,
  buildEvaluationPrompt,
  parseLlmBoolResponse,
  evaluateLlmCondition,
} from '../llm-evaluator.js'

// ---------------------------------------------------------------------------
// isLlmCondition
// ---------------------------------------------------------------------------

describe('isLlmCondition', () => {
  it('returns true for "llm:question"', () => {
    expect(isLlmCondition('llm:question')).toBe(true)
  })

  it('returns false for "outcome=success"', () => {
    expect(isLlmCondition('outcome=success')).toBe(false)
  })

  it('returns true for "llm:" with empty question', () => {
    expect(isLlmCondition('llm:')).toBe(true)
  })

  it('returns false for empty string', () => {
    expect(isLlmCondition('')).toBe(false)
  })

  it('returns true for "  llm:trimmed" with leading whitespace', () => {
    expect(isLlmCondition('  llm:Is it ready?')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractLlmQuestion
// ---------------------------------------------------------------------------

describe('extractLlmQuestion', () => {
  it('extracts the question from "llm:Is it ready?"', () => {
    expect(extractLlmQuestion('llm:Is it ready?')).toBe('Is it ready?')
  })

  it('trims whitespace from "llm:  Trimmed  "', () => {
    expect(extractLlmQuestion('llm:  Trimmed  ')).toBe('Trimmed')
  })
})

// ---------------------------------------------------------------------------
// buildEvaluationPrompt
// ---------------------------------------------------------------------------

describe('buildEvaluationPrompt', () => {
  it('contains the question text and JSON-serialized context key', () => {
    const question = 'Is this output production-ready?'
    const contextSnapshot = { status: 'success', score: 42 }
    const prompt = buildEvaluationPrompt(question, contextSnapshot)
    expect(prompt).toContain(question)
    expect(prompt).toContain('"status"')
    expect(prompt).toContain('"success"')
  })
})

// ---------------------------------------------------------------------------
// parseLlmBoolResponse
// ---------------------------------------------------------------------------

describe('parseLlmBoolResponse', () => {
  it('returns true for "yes"', () => {
    expect(parseLlmBoolResponse('yes')).toBe(true)
  })

  it('returns true for "YES\\n" (uppercase with newline)', () => {
    expect(parseLlmBoolResponse('YES\n')).toBe(true)
  })

  it('returns false for "no"', () => {
    expect(parseLlmBoolResponse('no')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(parseLlmBoolResponse('')).toBe(false)
  })

  it('returns true for "true"', () => {
    expect(parseLlmBoolResponse('true')).toBe(true)
  })

  it('returns false for "false"', () => {
    expect(parseLlmBoolResponse('false')).toBe(false)
  })

  it('returns true for "affirmative"', () => {
    expect(parseLlmBoolResponse('affirmative')).toBe(true)
  })

  it('returns true for "correct"', () => {
    expect(parseLlmBoolResponse('correct')).toBe(true)
  })

  it('returns true for "1"', () => {
    expect(parseLlmBoolResponse('1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// evaluateLlmCondition
// ---------------------------------------------------------------------------

describe('evaluateLlmCondition', () => {
  it('returns true when mock llmCall returns "yes"', async () => {
    const mockLlmCall = vi.fn(async (_prompt: string) => 'yes')
    const result = await evaluateLlmCondition('Is it ready?', { status: 'success' }, mockLlmCall)
    expect(result).toBe(true)
    expect(mockLlmCall).toHaveBeenCalledOnce()
  })

  it('returns false when mock llmCall returns "no"', async () => {
    const mockLlmCall = vi.fn(async (_prompt: string) => 'no')
    const result = await evaluateLlmCondition('Is it ready?', { status: 'failure' }, mockLlmCall)
    expect(result).toBe(false)
  })

  it('returns false without re-throwing when llmCall throws an error', async () => {
    const mockLlmCall = vi.fn(async (_prompt: string): Promise<string> => {
      throw new Error('fail')
    })
    await expect(evaluateLlmCondition('Is it ready?', {}, mockLlmCall)).resolves.toBe(false)
  })
})
