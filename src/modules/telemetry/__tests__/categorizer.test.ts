/**
 * Unit tests for Categorizer.
 *
 * Covers:
 *   - Three-tier classification (exact match, prefix pattern, fuzzy substring)
 *   - toolName override for fallback
 *   - computeCategoryStats: all 6 categories returned, percentages, zero-span categories
 *   - computeTrend: growing, shrinking, stable, edge cases
 *
 * No SQLite or Dolt involved. Logger is a vi.fn() stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type pino from 'pino'

import { Categorizer } from '../categorizer.js'
import type { NormalizedSpan, TurnAnalysis } from '../types.js'

// ---------------------------------------------------------------------------
// Mock logger factory
// ---------------------------------------------------------------------------

function makeMockLogger(): pino.Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeSpan(overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'test_operation',
    source: 'claude-code',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 100,
    startTime: 1000,
    attributes: {},
    ...overrides,
  }
}

function makeTurn(overrides: Partial<TurnAnalysis> = {}): TurnAnalysis {
  return {
    spanId: 'turn-span-1',
    turnNumber: 1,
    name: 'assistant_turn',
    timestamp: 1000,
    source: 'claude-code',
    model: 'claude-sonnet',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    freshTokens: 1000,
    cacheHitRate: 0,
    costUsd: 0.001,
    durationMs: 1000,
    contextSize: 1000,
    contextDelta: 1000,
    isContextSpike: false,
    childSpans: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Categorizer', () => {
  let categorizer: Categorizer

  beforeEach(() => {
    categorizer = new Categorizer(makeMockLogger())
  })

  // -------------------------------------------------------------------------
  // classify() — Tier 1: Exact Match
  // -------------------------------------------------------------------------

  describe('classify()', () => {
    describe('Tier 1: exact match', () => {
      it.each([
        ['read_file', 'file_reads'],
        ['bash', 'tool_outputs'],
        ['system_prompt', 'system_prompts'],
        ['human_turn', 'user_prompts'],
        ['assistant_turn', 'conversation_history'],
        ['write_file', 'tool_outputs'],
        ['tool_use', 'tool_outputs'],
        ['tool_result', 'tool_outputs'],
        ['user_message', 'user_prompts'],
        ['assistant_message', 'conversation_history'],
        ['search_files', 'file_reads'],
        ['list_files', 'file_reads'],
        ['run_command', 'tool_outputs'],
        ['memory_read', 'system_prompts'],
        ['web_fetch', 'tool_outputs'],
      ] as const)('should classify "%s" → "%s"', (opName, expected) => {
        expect(categorizer.classify(opName)).toBe(expected)
      })
    })

    describe('Tier 2: prefix pattern fallback', () => {
      it('should classify "tool_result_extra" → "tool_outputs" via prefix "^tool"', () => {
        // "tool_result" is in exact map, but "tool_result_extra" is not
        expect(categorizer.classify('tool_result_extra')).toBe('tool_outputs')
      })

      it('should classify "spawn_process" → "tool_outputs" via prefix "^(bash|exec|run|spawn)"', () => {
        expect(categorizer.classify('spawn_process')).toBe('tool_outputs')
      })

      it('should classify "exec_command" → "tool_outputs" via exec prefix', () => {
        expect(categorizer.classify('exec_command')).toBe('tool_outputs')
      })

      it('should classify "read_large_file" → "file_reads" via read.*file prefix', () => {
        expect(categorizer.classify('read_large_file')).toBe('file_reads')
      })

      it('should classify "open_file_for_edit" → "file_reads" via open.*file prefix', () => {
        expect(categorizer.classify('open_file_for_edit')).toBe('file_reads')
      })

      it('should classify "list_directory_files" → "file_reads" via list.*file prefix', () => {
        expect(categorizer.classify('list_directory_files')).toBe('file_reads')
      })

      it('should classify "system_context_load" → "system_prompts" via system prefix', () => {
        expect(categorizer.classify('system_context_load')).toBe('system_prompts')
      })

      it('should classify "human_input_event" → "user_prompts" via human prefix', () => {
        expect(categorizer.classify('human_input_event')).toBe('user_prompts')
      })

      it('should classify "user_query_start" → "user_prompts" via user prefix', () => {
        expect(categorizer.classify('user_query_start')).toBe('user_prompts')
      })

      it('should classify "assistant_response" → "conversation_history" via assistant prefix', () => {
        expect(categorizer.classify('assistant_response')).toBe('conversation_history')
      })

      it('should classify "ai_completion" → "conversation_history" via ai prefix', () => {
        expect(categorizer.classify('ai_completion')).toBe('conversation_history')
      })

      it('should classify "model_prediction" → "conversation_history" via model prefix', () => {
        expect(categorizer.classify('model_prediction')).toBe('conversation_history')
      })
    })

    describe('Tier 3: fuzzy substring fallback', () => {
      it('should classify "read_partial_file" → "file_reads" (contains "file" and "read")', () => {
        expect(categorizer.classify('read_partial_file')).toBe('file_reads')
      })

      it('should classify "open_temp_file" → "file_reads" (contains "file" and "open")', () => {
        expect(categorizer.classify('open_temp_file')).toBe('file_reads')
      })

      it('should classify "load_system_config" → "system_prompts" (contains "system")', () => {
        expect(categorizer.classify('load_system_config')).toBe('system_prompts')
      })

      it('should classify "initial_prompt_setup" → "system_prompts" (contains "prompt")', () => {
        expect(categorizer.classify('initial_prompt_setup')).toBe('system_prompts')
      })

      it('should classify "run_bash_script" → "tool_outputs" (contains "bash")', () => {
        expect(categorizer.classify('run_bash_script')).toBe('tool_outputs')
      })

      it('should classify "execute_tool_call" → "tool_outputs" (contains "tool")', () => {
        expect(categorizer.classify('execute_tool_call')).toBe('tool_outputs')
      })
    })

    describe('Tier 4: toolName override', () => {
      it('should classify unknown operation + non-empty toolName → "tool_outputs"', () => {
        expect(categorizer.classify('completely_unknown_op', 'some_tool')).toBe('tool_outputs')
      })

      it('should return "other" for empty operation name with no toolName', () => {
        expect(categorizer.classify('')).toBe('other')
      })

      it('should return "other" for empty operation name with empty toolName', () => {
        expect(categorizer.classify('', '')).toBe('other')
      })

      it('should NOT override if tier 1/2/3 already matched (exact wins over toolName)', () => {
        // read_file is exact match → file_reads, not tool_outputs
        expect(categorizer.classify('read_file', 'some_tool')).toBe('file_reads')
      })
    })

    describe('Tier 0 — taskType classification', () => {
      it('should classify taskType "create-story" → "system_prompts"', () => {
        expect(categorizer.classify('api_request', undefined, 'create-story')).toBe(
          'system_prompts'
        )
      })

      it('should classify taskType "dev-story" → "tool_outputs"', () => {
        expect(categorizer.classify('api_request', undefined, 'dev-story')).toBe('tool_outputs')
      })

      it('should classify taskType "code-review" → "conversation_history"', () => {
        expect(categorizer.classify('api_request', undefined, 'code-review')).toBe(
          'conversation_history'
        )
      })

      it('should classify taskType "test-plan" → "system_prompts"', () => {
        expect(categorizer.classify('api_request', undefined, 'test-plan')).toBe('system_prompts')
      })

      it('should classify taskType "minor-fixes" → "tool_outputs"', () => {
        expect(categorizer.classify('api_request', undefined, 'minor-fixes')).toBe('tool_outputs')
      })

      it('should fall through to Tier 1 when taskType is unknown', () => {
        // 'api_request' is in exact map → 'conversation_history'
        expect(categorizer.classify('api_request', undefined, 'unknown-task')).toBe(
          'conversation_history'
        )
      })

      it('should fall through to Tier 1 when taskType is undefined', () => {
        // 'api_request' is in exact map → 'conversation_history'
        expect(categorizer.classify('api_request', undefined, undefined)).toBe(
          'conversation_history'
        )
      })

      it('should fall through to Tier 1 when taskType is empty string', () => {
        // 'read_file' is in exact map → 'file_reads'
        expect(categorizer.classify('read_file', undefined, '')).toBe('file_reads')
      })

      it('Tier 0 overrides Tier 1 exact match (dev-story wins over api_request→conversation_history)', () => {
        expect(categorizer.classify('api_request', undefined, 'dev-story')).toBe('tool_outputs')
      })
    })

    describe('Tier 5: log_turn default', () => {
      it('should classify "log_turn" as conversation_history', () => {
        expect(categorizer.classify('log_turn')).toBe('conversation_history')
      })

      it('should classify "log_turn" with toolName as tool_outputs (tier 4 wins)', () => {
        expect(categorizer.classify('log_turn', 'some_tool')).toBe('tool_outputs')
      })
    })

    describe('case-insensitivity for tier 3', () => {
      it('should handle mixed-case operations in fuzzy tier', () => {
        expect(categorizer.classify('Read_Partial_File')).toBe('file_reads')
      })
    })
  })

  // -------------------------------------------------------------------------
  // computeCategoryStats()
  // -------------------------------------------------------------------------

  describe('computeCategoryStats()', () => {
    it('should return all 6 SemanticCategory values even when some have zero spans', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'read_file', inputTokens: 100, outputTokens: 50 }),
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      const categories = result.map((r) => r.category)
      expect(categories).toContain('tool_outputs')
      expect(categories).toContain('file_reads')
      expect(categories).toContain('system_prompts')
      expect(categories).toContain('conversation_history')
      expect(categories).toContain('user_prompts')
      expect(categories).toContain('other')
      expect(result).toHaveLength(6)
    })

    it('should return all 6 categories with totalTokens:0 for zero-span categories', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'read_file', inputTokens: 100, outputTokens: 50 }),
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      const fileReads = result.find((r) => r.category === 'file_reads')!
      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!

      expect(fileReads.totalTokens).toBe(150) // 100 + 50
      expect(fileReads.eventCount).toBe(1)
      expect(toolOutputs.totalTokens).toBe(0)
      expect(toolOutputs.eventCount).toBe(0)
    })

    it('should correctly compute totalTokens = sum(inputTokens + outputTokens)', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'bash', inputTokens: 200, outputTokens: 100 }),
        makeSpan({ spanId: 's2', operationName: 'bash', inputTokens: 300, outputTokens: 50 }),
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.totalTokens).toBe(650) // (200+100) + (300+50)
      expect(toolOutputs.eventCount).toBe(2)
      expect(toolOutputs.avgTokensPerEvent).toBe(325)
    })

    it('should correctly compute percentage summing to 100 for all-positive categories', () => {
      // Only bash spans: all tokens in tool_outputs, others get 0%
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'bash', inputTokens: 500, outputTokens: 500 }),
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.percentage).toBe(100)

      const others = result.filter((r) => r.category !== 'tool_outputs')
      for (const other of others) {
        expect(other.percentage).toBe(0)
      }
    })

    it('should compute percentage as 0 when grandTotal is 0', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'bash', inputTokens: 0, outputTokens: 0 }),
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      for (const stat of result) {
        expect(stat.percentage).toBe(0)
      }
    })

    it('should sort results by totalTokens descending', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'read_file', inputTokens: 100, outputTokens: 50 }), // file_reads: 150
        makeSpan({ spanId: 's2', operationName: 'bash', inputTokens: 1000, outputTokens: 500 }), // tool_outputs: 1500
        makeSpan({
          spanId: 's3',
          operationName: 'system_prompt',
          inputTokens: 200,
          outputTokens: 0,
        }), // system_prompts: 200
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      expect(result[0].category).toBe('tool_outputs')
      expect(result[1].category).toBe('system_prompts')
      expect(result[2].category).toBe('file_reads')
    })

    it('should return empty turn trend as stable when turns is empty', () => {
      const spans = [
        makeSpan({ spanId: 's1', operationName: 'bash', inputTokens: 100, outputTokens: 50 }),
      ]
      const result = categorizer.computeCategoryStats(spans, [])

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.trend).toBe('stable')
    })
  })

  // -------------------------------------------------------------------------
  // computeCategoryStatsFromTurns()
  // -------------------------------------------------------------------------

  describe('computeCategoryStatsFromTurns()', () => {
    it('should return all 6 SemanticCategory values with zeros when turns is empty', () => {
      const result = categorizer.computeCategoryStatsFromTurns([])

      const categories = result.map((r) => r.category)
      expect(categories).toContain('tool_outputs')
      expect(categories).toContain('file_reads')
      expect(categories).toContain('system_prompts')
      expect(categories).toContain('conversation_history')
      expect(categories).toContain('user_prompts')
      expect(categories).toContain('other')
      expect(result).toHaveLength(6)
      for (const stat of result) {
        expect(stat.totalTokens).toBe(0)
        expect(stat.eventCount).toBe(0)
        expect(stat.trend).toBe('stable')
      }
    })

    it('should classify turns with toolName → tool_outputs', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'unknown_op',
          toolName: 'bash',
          inputTokens: 100,
          outputTokens: 50,
        }),
      ]
      const result = categorizer.computeCategoryStatsFromTurns(turns)

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.totalTokens).toBe(150)
      expect(toolOutputs.eventCount).toBe(1)
    })

    it('should classify turns without toolName using name classification', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'read_file',
          toolName: undefined,
          inputTokens: 200,
          outputTokens: 100,
          turnNumber: 1,
        }),
        makeTurn({
          spanId: 't2',
          name: 'system_prompt',
          toolName: undefined,
          inputTokens: 300,
          outputTokens: 0,
          turnNumber: 2,
          timestamp: 2000,
        }),
      ]
      const result = categorizer.computeCategoryStatsFromTurns(turns)

      const fileReads = result.find((r) => r.category === 'file_reads')!
      const systemPrompts = result.find((r) => r.category === 'system_prompts')!
      expect(fileReads.totalTokens).toBe(300)
      expect(fileReads.eventCount).toBe(1)
      expect(systemPrompts.totalTokens).toBe(300)
      expect(systemPrompts.eventCount).toBe(1)
    })

    it('should return all 6 categories even when some have zero turns', () => {
      const turns = [makeTurn({ spanId: 't1', name: 'bash', inputTokens: 1000, outputTokens: 500 })]
      const result = categorizer.computeCategoryStatsFromTurns(turns)

      expect(result).toHaveLength(6)
      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      const fileReads = result.find((r) => r.category === 'file_reads')!
      expect(toolOutputs.totalTokens).toBe(1500)
      expect(fileReads.totalTokens).toBe(0)
      expect(fileReads.eventCount).toBe(0)
    })

    it('should compute percentage correctly', () => {
      const turns = [makeTurn({ spanId: 't1', name: 'bash', inputTokens: 500, outputTokens: 500 })]
      const result = categorizer.computeCategoryStatsFromTurns(turns)

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.percentage).toBe(100)
      const fileReads = result.find((r) => r.category === 'file_reads')!
      expect(fileReads.percentage).toBe(0)
    })

    it('should compute avgTokensPerEvent correctly', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'bash',
          inputTokens: 100,
          outputTokens: 100,
          turnNumber: 1,
        }),
        makeTurn({
          spanId: 't2',
          name: 'bash',
          inputTokens: 200,
          outputTokens: 200,
          turnNumber: 2,
          timestamp: 2000,
        }),
      ]
      const result = categorizer.computeCategoryStatsFromTurns(turns)

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.totalTokens).toBe(600)
      expect(toolOutputs.eventCount).toBe(2)
      expect(toolOutputs.avgTokensPerEvent).toBe(300)
    })

    it('should sort results by totalTokens descending', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'read_file',
          inputTokens: 100,
          outputTokens: 50,
          turnNumber: 1,
        }),
        makeTurn({
          spanId: 't2',
          name: 'bash',
          inputTokens: 1000,
          outputTokens: 500,
          turnNumber: 2,
          timestamp: 2000,
        }),
        makeTurn({
          spanId: 't3',
          name: 'system_prompt',
          inputTokens: 200,
          outputTokens: 0,
          turnNumber: 3,
          timestamp: 3000,
        }),
      ]
      const result = categorizer.computeCategoryStatsFromTurns(turns)

      expect(result[0].category).toBe('tool_outputs')
      expect(result[1].category).toBe('system_prompts')
      expect(result[2].category).toBe('file_reads')
    })

    it('should detect growing trend when second-half turns have > 1.2x first-half tokens', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'bash',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: 1,
          timestamp: 1000,
        }),
        makeTurn({
          spanId: 't2',
          name: 'bash',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: 2,
          timestamp: 2000,
        }),
        makeTurn({
          spanId: 't3',
          name: 'bash',
          inputTokens: 200,
          outputTokens: 0,
          turnNumber: 3,
          timestamp: 3000,
        }),
        makeTurn({
          spanId: 't4',
          name: 'bash',
          inputTokens: 200,
          outputTokens: 0,
          turnNumber: 4,
          timestamp: 4000,
        }),
      ]
      // firstHalf (turns[0,1]) = 200, secondHalf (turns[2,3]) = 400; 400 > 1.2 * 200 = 240
      const result = categorizer.computeCategoryStatsFromTurns(turns)
      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.trend).toBe('growing')
    })

    it('should detect shrinking trend when second-half turns have < 0.8x first-half tokens', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'bash',
          inputTokens: 400,
          outputTokens: 0,
          turnNumber: 1,
          timestamp: 1000,
        }),
        makeTurn({
          spanId: 't2',
          name: 'bash',
          inputTokens: 400,
          outputTokens: 0,
          turnNumber: 2,
          timestamp: 2000,
        }),
        makeTurn({
          spanId: 't3',
          name: 'bash',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: 3,
          timestamp: 3000,
        }),
        makeTurn({
          spanId: 't4',
          name: 'bash',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: 4,
          timestamp: 4000,
        }),
      ]
      // firstHalf = 800, secondHalf = 200; 200 < 0.8 * 800 = 640
      const result = categorizer.computeCategoryStatsFromTurns(turns)
      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.trend).toBe('shrinking')
    })

    it('should return stable trend when < 2 turns', () => {
      const turns = [makeTurn({ spanId: 't1', name: 'bash', inputTokens: 100, outputTokens: 50 })]
      const result = categorizer.computeCategoryStatsFromTurns(turns)
      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      expect(toolOutputs.trend).toBe('stable')
    })

    it('should return growing trend when first-half is zero and second-half has tokens', () => {
      const turns = [
        makeTurn({
          spanId: 't1',
          name: 'read_file',
          inputTokens: 0,
          outputTokens: 0,
          turnNumber: 1,
        }),
        makeTurn({
          spanId: 't2',
          name: 'read_file',
          inputTokens: 500,
          outputTokens: 0,
          turnNumber: 2,
          timestamp: 2000,
        }),
      ]
      const result = categorizer.computeCategoryStatsFromTurns(turns)
      const fileReads = result.find((r) => r.category === 'file_reads')!
      expect(fileReads.trend).toBe('growing')
    })

    it('should return stable trend for zero-token category (first=0, second=0)', () => {
      const turns = [
        makeTurn({ spanId: 't1', name: 'bash', inputTokens: 100, outputTokens: 0, turnNumber: 1 }),
        makeTurn({
          spanId: 't2',
          name: 'bash',
          inputTokens: 200,
          outputTokens: 0,
          turnNumber: 2,
          timestamp: 2000,
        }),
      ]
      const result = categorizer.computeCategoryStatsFromTurns(turns)
      const fileReads = result.find((r) => r.category === 'file_reads')!
      expect(fileReads.trend).toBe('stable')
    })

    it('should compute 0 percentage when grandTotal is 0', () => {
      const turns = [makeTurn({ spanId: 't1', name: 'bash', inputTokens: 0, outputTokens: 0 })]
      const result = categorizer.computeCategoryStatsFromTurns(turns)
      for (const stat of result) {
        expect(stat.percentage).toBe(0)
      }
    })

    it('AC5: multi-dispatch story produces 3+ non-zero category entries when taskType is used', () => {
      // 5 turns with taskType 'dev-story' → tool_outputs
      const devStoryTurns = Array.from({ length: 5 }, (_, i) =>
        makeTurn({
          spanId: `dev-${i}`,
          name: 'api_request',
          taskType: 'dev-story',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: i + 1,
          timestamp: 1000 + i * 1000,
        })
      )
      // 4 turns with taskType 'code-review' → conversation_history
      const codeReviewTurns = Array.from({ length: 4 }, (_, i) =>
        makeTurn({
          spanId: `review-${i}`,
          name: 'api_request',
          taskType: 'code-review',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: 6 + i,
          timestamp: 6000 + i * 1000,
        })
      )
      // 3 turns with taskType 'create-story' → system_prompts
      const createStoryTurns = Array.from({ length: 3 }, (_, i) =>
        makeTurn({
          spanId: `create-${i}`,
          name: 'api_request',
          taskType: 'create-story',
          inputTokens: 100,
          outputTokens: 0,
          turnNumber: 10 + i,
          timestamp: 10000 + i * 1000,
        })
      )

      const allTurns = [...devStoryTurns, ...codeReviewTurns, ...createStoryTurns]
      const result = categorizer.computeCategoryStatsFromTurns(allTurns)

      const toolOutputs = result.find((r) => r.category === 'tool_outputs')!
      const conversationHistory = result.find((r) => r.category === 'conversation_history')!
      const systemPrompts = result.find((r) => r.category === 'system_prompts')!

      expect(toolOutputs.totalTokens).toBeGreaterThan(0)
      expect(conversationHistory.totalTokens).toBeGreaterThan(0)
      expect(systemPrompts.totalTokens).toBeGreaterThan(0)

      // Verify exact counts
      expect(toolOutputs.totalTokens).toBe(500) // 5 dev-story turns × 100
      expect(conversationHistory.totalTokens).toBe(400) // 4 code-review turns × 100
      expect(systemPrompts.totalTokens).toBe(300) // 3 create-story turns × 100

      // At least 3 non-zero category entries
      const nonZero = result.filter((r) => r.totalTokens > 0)
      expect(nonZero.length).toBeGreaterThanOrEqual(3)
    })
  })

  // -------------------------------------------------------------------------
  // computeTrend()
  // -------------------------------------------------------------------------

  describe('computeTrend()', () => {
    it('should return "stable" when turns array is empty', () => {
      const spans = [makeSpan({ spanId: 's1', inputTokens: 100, outputTokens: 50 })]
      expect(categorizer.computeTrend(spans, [])).toBe('stable')
    })

    it('should return "stable" when there is only 1 turn', () => {
      const spans = [makeSpan({ spanId: 's1', inputTokens: 100, outputTokens: 50 })]
      const turns = [makeTurn({ spanId: 's1', timestamp: 1000 })]
      expect(categorizer.computeTrend(spans, turns)).toBe('stable')
    })

    it('should return "stable" when all spans have zero tokens', () => {
      const turns = [
        makeTurn({ spanId: 's1', timestamp: 1000 }),
        makeTurn({ spanId: 's2', timestamp: 2000, turnNumber: 2 }),
      ]
      const spans = [makeSpan({ spanId: 'x1', startTime: 500, inputTokens: 0, outputTokens: 0 })]
      expect(categorizer.computeTrend(spans, turns)).toBe('stable')
    })

    it('should return "growing" when second half tokens > 1.2× first half tokens', () => {
      const turns = [
        makeTurn({ spanId: 's1', timestamp: 1000 }),
        makeTurn({ spanId: 's2', timestamp: 2000, turnNumber: 2 }),
        makeTurn({ spanId: 's3', timestamp: 3000, turnNumber: 3 }),
        makeTurn({ spanId: 's4', timestamp: 4000, turnNumber: 4 }),
      ]
      // First half: turns[0] and [1], second half: turns[2] and [3]
      // Make second half tokens > 1.2× first half
      const spans = [
        makeSpan({ spanId: 's1', startTime: 1000, inputTokens: 100, outputTokens: 0 }), // turn 0 → first half
        makeSpan({ spanId: 's2', startTime: 2000, inputTokens: 100, outputTokens: 0 }), // turn 1 → first half
        makeSpan({ spanId: 's3', startTime: 3000, inputTokens: 200, outputTokens: 0 }), // turn 2 → second half
        makeSpan({ spanId: 's4', startTime: 4000, inputTokens: 200, outputTokens: 0 }), // turn 3 → second half
      ]
      // firstHalf = 200, secondHalf = 400; 400 > 1.2 * 200 = 240 → growing
      expect(categorizer.computeTrend(spans, turns)).toBe('growing')
    })

    it('should return "shrinking" when second half tokens < 0.8× first half tokens', () => {
      const turns = [
        makeTurn({ spanId: 's1', timestamp: 1000 }),
        makeTurn({ spanId: 's2', timestamp: 2000, turnNumber: 2 }),
        makeTurn({ spanId: 's3', timestamp: 3000, turnNumber: 3 }),
        makeTurn({ spanId: 's4', timestamp: 4000, turnNumber: 4 }),
      ]
      const spans = [
        makeSpan({ spanId: 's1', startTime: 1000, inputTokens: 400, outputTokens: 0 }), // turn 0 → first half
        makeSpan({ spanId: 's2', startTime: 2000, inputTokens: 400, outputTokens: 0 }), // turn 1 → first half
        makeSpan({ spanId: 's3', startTime: 3000, inputTokens: 100, outputTokens: 0 }), // turn 2 → second half
        makeSpan({ spanId: 's4', startTime: 4000, inputTokens: 100, outputTokens: 0 }), // turn 3 → second half
      ]
      // firstHalf = 800, secondHalf = 200; 200 < 0.8 * 800 = 640 → shrinking
      expect(categorizer.computeTrend(spans, turns)).toBe('shrinking')
    })

    it('should return "stable" when second half tokens is between 0.8× and 1.2× first half', () => {
      const turns = [
        makeTurn({ spanId: 's1', timestamp: 1000 }),
        makeTurn({ spanId: 's2', timestamp: 2000, turnNumber: 2 }),
        makeTurn({ spanId: 's3', timestamp: 3000, turnNumber: 3 }),
        makeTurn({ spanId: 's4', timestamp: 4000, turnNumber: 4 }),
      ]
      const spans = [
        makeSpan({ spanId: 's1', startTime: 1000, inputTokens: 100, outputTokens: 0 }), // first half
        makeSpan({ spanId: 's2', startTime: 2000, inputTokens: 100, outputTokens: 0 }), // first half
        makeSpan({ spanId: 's3', startTime: 3000, inputTokens: 110, outputTokens: 0 }), // second half
        makeSpan({ spanId: 's4', startTime: 4000, inputTokens: 90, outputTokens: 0 }), // second half
      ]
      // firstHalf = 200, secondHalf = 200; 200 is between 0.8*200=160 and 1.2*200=240 → stable
      expect(categorizer.computeTrend(spans, turns)).toBe('stable')
    })

    it('should return "growing" when first half is zero and second half has tokens', () => {
      const turns = [
        makeTurn({ spanId: 's1', timestamp: 1000 }),
        makeTurn({ spanId: 's2', timestamp: 2000, turnNumber: 2 }),
      ]
      const spans = [
        // s2 is in second half only
        makeSpan({ spanId: 's2', startTime: 2000, inputTokens: 500, outputTokens: 0 }),
      ]
      // firstHalf = 0, secondHalf = 500 → growing
      expect(categorizer.computeTrend(spans, turns)).toBe('growing')
    })

    it('should attribute unmatched spans by timestamp proximity', () => {
      const turns = [
        makeTurn({ spanId: 'turn1', timestamp: 1000 }),
        makeTurn({ spanId: 'turn2', timestamp: 2000, turnNumber: 2 }),
        makeTurn({ spanId: 'turn3', timestamp: 3000, turnNumber: 3 }),
        makeTurn({ spanId: 'turn4', timestamp: 4000, turnNumber: 4 }),
      ]
      // Unmatched span at startTime 1500 → attributed to turn at timestamp 1000 (turn index 0, first half)
      // Unmatched span at startTime 3500 → attributed to turn at timestamp 3000 (turn index 2, second half)
      const spans = [
        makeSpan({ spanId: 'unmatched-1', startTime: 1500, inputTokens: 100, outputTokens: 0 }),
        makeSpan({ spanId: 'unmatched-2', startTime: 3500, inputTokens: 300, outputTokens: 0 }),
      ]
      // firstHalf = 100, secondHalf = 300; 300 > 1.2 * 100 = 120 → growing
      expect(categorizer.computeTrend(spans, turns)).toBe('growing')
    })

    it('should attribute spans before all turns to turn index 0', () => {
      const turns = [
        makeTurn({ spanId: 'turn1', timestamp: 5000 }),
        makeTurn({ spanId: 'turn2', timestamp: 6000, turnNumber: 2 }),
      ]
      // Span starts before all turns → attributed to turn 0 (first half)
      const spans = [
        makeSpan({ spanId: 'early', startTime: 1000, inputTokens: 100, outputTokens: 0 }),
      ]
      // firstHalf = 100, secondHalf = 0; 0 < 0.8*100=80 → shrinking
      expect(categorizer.computeTrend(spans, turns)).toBe('shrinking')
    })

    it('should use childSpans for matching when span ID is not a direct turn spanId', () => {
      const turns = [
        makeTurn({
          spanId: 'parent-turn-1',
          timestamp: 1000,
          childSpans: [
            {
              spanId: 'child-span-1',
              name: 'tool_call',
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
            },
          ],
        }),
        makeTurn({
          spanId: 'parent-turn-2',
          timestamp: 2000,
          turnNumber: 2,
          childSpans: [
            {
              spanId: 'child-span-2',
              name: 'tool_call',
              inputTokens: 0,
              outputTokens: 0,
              durationMs: 0,
            },
          ],
        }),
        makeTurn({ spanId: 'parent-turn-3', timestamp: 3000, turnNumber: 3 }),
        makeTurn({ spanId: 'parent-turn-4', timestamp: 4000, turnNumber: 4 }),
      ]
      // child-span-2 is in turn 1 (index 1, first half for 4 turns)
      // child-span-extra is unmatched, attributed by timestamp
      const spans = [
        makeSpan({ spanId: 'child-span-2', startTime: 2100, inputTokens: 500, outputTokens: 0 }), // first half via childSpans
        makeSpan({ spanId: 'parent-turn-3', startTime: 3000, inputTokens: 100, outputTokens: 0 }), // second half direct
      ]
      // firstHalf = 500, secondHalf = 100; 100 < 0.8*500=400 → shrinking
      expect(categorizer.computeTrend(spans, turns)).toBe('shrinking')
    })
  })
})
