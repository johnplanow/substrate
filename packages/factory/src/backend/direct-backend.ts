/**
 * Direct codergen backend that executes codergen nodes using the Coding Agent
 * Loop and Unified LLM Client, providing per-turn event visibility, loop
 * detection, and output truncation unavailable with the CLI backend.
 *
 * Story 48-10.
 */

import { createSession } from '../agent/loop.js'
import type { LLMClient } from '../llm/client.js'
import type { ProviderProfile } from '../agent/tools/profiles.js'
import type { ExecutionEnvironment } from '../agent/tools/types.js'
import { EventKind, type SessionConfig, type SessionEvent } from '../agent/types.js'
import type { GraphNode, IGraphContext, Outcome } from '../graph/types.js'
import type { ICodergenBackend } from './types.js'

// ---------------------------------------------------------------------------
// DirectBackendOptions
// ---------------------------------------------------------------------------

export interface DirectBackendOptions {
  llmClient: LLMClient
  providerProfile: ProviderProfile
  executionEnv: ExecutionEnvironment
  config?: Partial<SessionConfig>
  onEvent?: (event: SessionEvent) => void
}

// ---------------------------------------------------------------------------
// DirectCodergenBackend
// ---------------------------------------------------------------------------

export class DirectCodergenBackend implements ICodergenBackend {
  constructor(private readonly options: DirectBackendOptions) {}

  async run(node: GraphNode, prompt: string, _context: IGraphContext): Promise<Outcome> {
    const { llmClient, providerProfile, executionEnv, config, onEvent } = this.options
    const sessionOptions: { llmClient: LLMClient; providerProfile: ProviderProfile; executionEnv: ExecutionEnvironment; config?: Partial<SessionConfig> } = {
      llmClient,
      providerProfile,
      executionEnv,
    }
    if (config !== undefined) {
      sessionOptions.config = config
    }
    const session = createSession(sessionOptions)

    let turnLimitHit = false

    // Subscribe to all events before processInput so the host can bridge
    // session events to the factory event bus.
    if (onEvent) {
      for (const kind of Object.values(EventKind)) {
        session.on(kind, onEvent)
      }
    }

    // Separately track turn limit regardless of whether onEvent is provided.
    session.on(EventKind.TURN_LIMIT, () => {
      turnLimitHit = true
    })

    try {
      await session.processInput(prompt)
    } catch (err: unknown) {
      // Map errors to FAILURE outcomes — do NOT rethrow so the pipeline executor
      // can handle them normally.
      const failureReason = err instanceof Error ? err.message : String(err)
      return { status: 'FAILURE', failureReason }
    } finally {
      // Always close the session to emit SESSION_END and release resources.
      session.close()
    }

    if (turnLimitHit) {
      return { status: 'FAILURE', failureReason: 'turn limit exceeded' }
    }

    // Extract final assistant text from history by scanning in reverse.
    const finalAssistantTurn = [...session.history]
      .reverse()
      .find(t => t.type === 'assistant')

    if (!finalAssistantTurn || finalAssistantTurn.type !== 'assistant') {
      return { status: 'SUCCESS' }
    }

    return {
      status: 'SUCCESS',
      contextUpdates: { [`${node.id}_output`]: finalAssistantTurn.content },
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createDirectCodergenBackend(options: DirectBackendOptions): DirectCodergenBackend {
  return new DirectCodergenBackend(options)
}
