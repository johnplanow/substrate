/**
 * Bootstrap function for the DirectCodergenBackend.
 *
 * Instantiates the correct provider adapter, LLMClient, and ExecutionEnvironment
 * based on the given options, and returns a ready-to-use DirectCodergenBackend.
 *
 * Story 48-12.
 */

import { execSync } from 'node:child_process'
import { LLMClient } from '../llm/client.js'
import { AnthropicAdapter } from '../llm/providers/anthropic.js'
import { OpenAIAdapter } from '../llm/providers/openai.js'
import { GeminiAdapter } from '../llm/providers/gemini.js'
import { AnthropicProfile, OpenAIProfile, GeminiProfile } from '../agent/tools/profiles.js'
import { createDirectCodergenBackend, DirectCodergenBackend } from './direct-backend.js'
import type { ExecutionEnvironment, ShellResult } from '../agent/tools/types.js'
import type { SessionEvent } from '../agent/types.js'

// ---------------------------------------------------------------------------
// DirectBootstrapOptions
// ---------------------------------------------------------------------------

export interface DirectBootstrapOptions {
  provider: string
  model: string
  maxTurns: number
  projectDir: string
  onEvent?: (event: SessionEvent) => void
}

// ---------------------------------------------------------------------------
// bootstrapDirectBackend
// ---------------------------------------------------------------------------

/**
 * Bootstrap a DirectCodergenBackend for the given provider and model.
 *
 * Reads the required API key from the environment, instantiates the correct
 * provider adapter and profile, constructs an LLMClient, and returns a
 * DirectCodergenBackend configured with the given options.
 *
 * @throws Error if the required API key environment variable is missing
 * @throws Error if the provider string is not recognised
 */
export function bootstrapDirectBackend(opts: DirectBootstrapOptions): DirectCodergenBackend {
  const { provider, model, maxTurns, projectDir, onEvent } = opts

  // Build an ExecutionEnvironment backed by child_process.execSync
  const executionEnv: ExecutionEnvironment = {
    workdir: projectDir,
    exec: (command: string, timeoutMs: number): Promise<ShellResult> => {
      return new Promise((resolve) => {
        try {
          const stdout = execSync(command, {
            cwd: projectDir,
            timeout: timeoutMs,
            encoding: 'utf-8',
          })
          resolve({ stdout: stdout || '', stderr: '', exitCode: 0 })
        } catch (err: unknown) {
          const execError = err as {
            stdout?: Buffer | string
            stderr?: Buffer | string
            status?: number
          }
          resolve({
            stdout: execError.stdout ? String(execError.stdout) : '',
            stderr: execError.stderr ? String(execError.stderr) : '',
            exitCode: typeof execError.status === 'number' ? execError.status : 1,
          })
        }
      })
    },
  }

  const client = new LLMClient()

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY']
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is required for direct backend with anthropic provider'
      )
    }
    const adapter = new AnthropicAdapter({ apiKey })
    client.registerProvider('anthropic', adapter)
    client.registerModelPattern('claude-*', 'anthropic')
    const providerProfile = new AnthropicProfile(model)
    return createDirectCodergenBackend({
      llmClient: client,
      providerProfile,
      executionEnv,
      config: { max_turns: maxTurns },
      ...(onEvent !== undefined ? { onEvent } : {}),
    })
  }

  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY']
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY environment variable is required for direct backend with openai provider'
      )
    }
    const adapter = new OpenAIAdapter({ apiKey })
    client.registerProvider('openai', adapter)
    client.registerModelPattern('gpt-*', 'openai')
    const providerProfile = new OpenAIProfile(model)
    return createDirectCodergenBackend({
      llmClient: client,
      providerProfile,
      executionEnv,
      config: { max_turns: maxTurns },
      ...(onEvent !== undefined ? { onEvent } : {}),
    })
  }

  if (provider === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY']
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY environment variable is required for direct backend with gemini provider'
      )
    }
    const adapter = new GeminiAdapter({ apiKey })
    client.registerProvider('gemini', adapter)
    client.registerModelPattern('gemini-*', 'gemini')
    const providerProfile = new GeminiProfile(model)
    return createDirectCodergenBackend({
      llmClient: client,
      providerProfile,
      executionEnv,
      config: { max_turns: maxTurns },
      ...(onEvent !== undefined ? { onEvent } : {}),
    })
  }

  throw new Error(`Unknown direct backend provider: ${provider}`)
}
