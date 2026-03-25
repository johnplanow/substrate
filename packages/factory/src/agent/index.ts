/**
 * Barrel export for the agent loop module.
 * Story 48-7: Coding Agent Loop — Core Agentic Loop
 * Story 48-8: Loop Detection and Steering Injection
 * Story 48-9: Output Truncation — Two-Phase Algorithm
 */

export * from './types.js'
export * from './loop.js'
// truncation.ts owns DEFAULT_TOOL_LIMITS, DEFAULT_FALLBACK_CHAR_LIMIT, DEFAULT_LINE_LIMIT,
// and truncateToolOutput — export all from the truncation module.
export * from './truncation.js'
export * from './loop-detection.js'
