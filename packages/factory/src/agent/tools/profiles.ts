/**
 * Provider profiles for Anthropic, OpenAI, and Gemini.
 * Story 48-6: Provider-Aligned Tool Sets
 */

import { createSharedTools } from './shared.js'
import { createEditFileTool } from './anthropic-tools.js'
import { createApplyPatchTool } from './openai-tools.js'
import { createReadManyFilesTool, createListDirTool, createGeminiEditFileTool } from './gemini-tools.js'
import type { ToolDefinition } from './types.js'

/**
 * Interface for provider profiles that define system prompts, tool sets,
 * and provider-specific request parameters.
 */
export interface ProviderProfile {
  id: string
  model: string
  supports_streaming: boolean
  context_window_size: number
  supports_parallel_tool_calls: boolean
  build_system_prompt(): string
  tools(): ToolDefinition[]
  provider_options(): Record<string, unknown>
}

/**
 * Anthropic (Claude) provider profile.
 * Uses edit_file for exact string search-and-replace.
 */
export class AnthropicProfile implements ProviderProfile {
  readonly id = 'anthropic'
  readonly supports_streaming = true
  readonly context_window_size = 200_000
  readonly supports_parallel_tool_calls = true

  constructor(public readonly model: string) {}

  build_system_prompt(): string {
    return [
      'You are a coding agent. You have access to tools for reading and modifying files, running shell commands, and searching code.',
      '',
      'Available tools:',
      '- read_file: Read file contents with optional line range (offset/limit)',
      '- write_file: Write content to a file (creates parent dirs as needed)',
      '- edit_file: Replace an exact string in a file (old_string must be unique)',
      '- shell: Execute shell commands',
      '- grep: Search for patterns in files',
      '- glob: Find files matching a pattern',
      '',
      'Guidelines:',
      '- Always read files before editing them to understand their current content',
      '- Use edit_file for targeted changes, write_file for full rewrites',
      '- Prefer targeted edits over full file rewrites when possible',
    ].join('\n')
  }

  tools(): ToolDefinition[] {
    return [...createSharedTools(120_000), createEditFileTool() as ToolDefinition]
  }

  provider_options(): Record<string, unknown> {
    return { max_tokens: 4096 }
  }
}

/**
 * OpenAI provider profile.
 * Uses apply_patch for v4a-format patch application.
 * Does NOT include edit_file.
 */
export class OpenAIProfile implements ProviderProfile {
  readonly id = 'openai'
  readonly supports_streaming = true
  readonly context_window_size = 128_000
  readonly supports_parallel_tool_calls = true

  constructor(public readonly model: string) {}

  build_system_prompt(): string {
    return [
      'You are a coding agent. You have access to tools for reading and modifying files, running shell commands, and searching code.',
      '',
      'Available tools:',
      '- read_file: Read file contents with optional line range',
      '- write_file: Write content to a file',
      '- apply_patch: Apply a v4a-format patch to modify files',
      '- shell: Execute shell commands',
      '- grep: Search for patterns in files',
      '- glob: Find files matching a pattern',
    ].join('\n')
  }

  tools(): ToolDefinition[] {
    return [...createSharedTools(10_000), createApplyPatchTool() as ToolDefinition]
  }

  provider_options(): Record<string, unknown> {
    return {}
  }
}

/**
 * Gemini provider profile.
 * Uses read_many_files, list_dir, and a Gemini-specific edit_file variant.
 */
export class GeminiProfile implements ProviderProfile {
  readonly id = 'gemini'
  readonly supports_streaming = true
  readonly context_window_size = 1_000_000
  readonly supports_parallel_tool_calls = true

  constructor(public readonly model: string) {}

  build_system_prompt(): string {
    return [
      'You are a coding agent. You have access to tools for reading and modifying files, running shell commands, and searching code.',
      '',
      'Available tools:',
      '- read_file: Read a single file with optional line range',
      '- read_many_files: Read multiple files at once',
      '- write_file: Write content to a file',
      '- edit_file: Replace an exact string in a file',
      '- list_dir: List directory contents',
      '- shell: Execute shell commands',
      '- grep: Search for patterns in files',
      '- glob: Find files matching a pattern',
    ].join('\n')
  }

  tools(): ToolDefinition[] {
    return [
      ...createSharedTools(10_000),
      createReadManyFilesTool() as ToolDefinition,
      createListDirTool() as ToolDefinition,
      createGeminiEditFileTool() as ToolDefinition,
    ]
  }

  provider_options(): Record<string, unknown> {
    return {}
  }
}
