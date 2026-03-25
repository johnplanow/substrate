// packages/factory/src/agent/types.ts
// Session types and configuration for the core agentic loop.
// Story 48-7: Coding Agent Loop — Core Agentic Loop

import type { LLMToolCall, LLMUsage } from '../llm/types.js'

// ---------------------------------------------------------------------------
// Session Configuration
// ---------------------------------------------------------------------------

export interface SessionConfig {
  /** Maximum total turns in history (0 = unlimited) */
  max_turns: number
  /** Maximum tool rounds per processInput call (0 = unlimited) */
  max_tool_rounds_per_input: number
  /** Default shell command timeout in ms */
  default_command_timeout_ms: number
  /** Maximum shell command timeout in ms */
  max_command_timeout_ms: number
  /** Reasoning effort level ('low'|'medium'|'high' or null to disable) */
  reasoning_effort: string | null
  /** Per-tool character output limits (overrides DEFAULT_TOOL_LIMITS) */
  tool_output_limits: Map<string, number>
  /** Whether to enable loop detection */
  enable_loop_detection: boolean
  /** Number of turns to look back for loop detection */
  loop_detection_window: number
  /** Truncation mode: head_tail keeps head+tail with marker; tail keeps only the end */
  truncation_mode: 'head_tail' | 'tail'
  /** Maximum number of output lines before line-based truncation is applied (Phase 2) */
  max_output_lines: number
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_turns: 0,
  max_tool_rounds_per_input: 0,
  default_command_timeout_ms: 10_000,
  max_command_timeout_ms: 600_000,
  reasoning_effort: null,
  tool_output_limits: new Map(),
  enable_loop_detection: true,
  loop_detection_window: 10,
  truncation_mode: 'head_tail',
  max_output_lines: 500,
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

export const SessionState = {
  IDLE: 'IDLE',
  PROCESSING: 'PROCESSING',
  AWAITING_INPUT: 'AWAITING_INPUT',
  CLOSED: 'CLOSED',
} as const
export type SessionState = typeof SessionState[keyof typeof SessionState]

// ---------------------------------------------------------------------------
// Turn types
// ---------------------------------------------------------------------------

export interface UserTurn {
  type: 'user'
  content: string
  timestamp: Date
}

export interface AssistantTurn {
  type: 'assistant'
  content: string
  tool_calls: LLMToolCall[]
  reasoning: string | null
  usage: LLMUsage
  response_id: string | null
  timestamp: Date
}

export interface ToolCallResult {
  tool_call_id: string
  content: string
  is_error: boolean
}

export interface ToolResultsTurn {
  type: 'tool_results'
  results: ToolCallResult[]
  timestamp: Date
}

export interface SteeringTurn {
  type: 'steering'
  content: string
  timestamp: Date
}

export interface SystemTurn {
  type: 'system'
  content: string
  timestamp: Date
}

export type Turn = UserTurn | AssistantTurn | ToolResultsTurn | SteeringTurn | SystemTurn

// ---------------------------------------------------------------------------
// Event Kinds
// ---------------------------------------------------------------------------

export const EventKind = {
  SESSION_START: 'SESSION_START',
  SESSION_END: 'SESSION_END',
  USER_INPUT: 'USER_INPUT',
  PROCESSING_END: 'PROCESSING_END',
  ASSISTANT_TEXT_START: 'ASSISTANT_TEXT_START',
  ASSISTANT_TEXT_DELTA: 'ASSISTANT_TEXT_DELTA',
  ASSISTANT_TEXT_END: 'ASSISTANT_TEXT_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_OUTPUT_DELTA: 'TOOL_CALL_OUTPUT_DELTA',
  TOOL_CALL_END: 'TOOL_CALL_END',
  STEERING_INJECTED: 'STEERING_INJECTED',
  TURN_LIMIT: 'TURN_LIMIT',
  LOOP_DETECTION: 'LOOP_DETECTION',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
} as const
export type EventKind = typeof EventKind[keyof typeof EventKind]

// ---------------------------------------------------------------------------
// Session Event
// ---------------------------------------------------------------------------

export interface SessionEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  kind: EventKind
  timestamp: Date
  session_id: string
  data: T
}

