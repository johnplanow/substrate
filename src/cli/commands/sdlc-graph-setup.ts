/**
 * SDLC handler registration via runtime composition.
 *
 * Story 43-6.
 *
 * Architecture note (ADR-003): This file is the ONLY place that imports from both
 * @substrate-ai/sdlc and @substrate-ai/factory. It is the CLI composition root for
 * graph-based SDLC execution — keeping both package imports here prevents
 * circular compile-time coupling between the two packages.
 */

// Composition root: this file is the ONLY place that imports from both packages.
import { HandlerRegistry } from '@substrate-ai/factory'
import type { NodeHandler } from '@substrate-ai/factory'
import {
  createSdlcPhaseHandler,
  createSdlcCreateStoryHandler,
  createSdlcDevStoryHandler,
  createSdlcCodeReviewHandler,
} from '@substrate-ai/sdlc'
import type {
  SdlcPhaseHandlerDeps,
  SdlcCreateStoryHandlerOptions,
  SdlcDevStoryHandlerOptions,
  SdlcCodeReviewHandlerOptions,
} from '@substrate-ai/sdlc'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Dependency injection container for buildSdlcHandlerRegistry.
 *
 * Each field corresponds to the options/deps accepted by one of the four
 * SDLC handler factories. The CLI composition root assembles this from live
 * pipeline dependencies and passes it to buildSdlcHandlerRegistry at startup.
 */
export interface SdlcRegistryDeps {
  /** Deps for the sdlc.phase handler (createSdlcPhaseHandler). */
  phaseHandlerDeps: SdlcPhaseHandlerDeps
  /** Options for the sdlc.create-story handler (createSdlcCreateStoryHandler). */
  createStoryOptions: SdlcCreateStoryHandlerOptions
  /** Options for the sdlc.dev-story handler (createSdlcDevStoryHandler). */
  devStoryOptions: SdlcDevStoryHandlerOptions
  /** Options for the sdlc.code-review handler (createSdlcCodeReviewHandler). */
  codeReviewOptions: SdlcCodeReviewHandlerOptions
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a HandlerRegistry pre-wired with the four SDLC node handlers.
 *
 * Registered type keys:
 *   - 'sdlc.phase'         → createSdlcPhaseHandler(deps.phaseHandlerDeps)
 *   - 'sdlc.create-story'  → createSdlcCreateStoryHandler(deps.createStoryOptions)
 *   - 'sdlc.dev-story'     → createSdlcDevStoryHandler(deps.devStoryOptions)
 *   - 'sdlc.code-review'   → createSdlcCodeReviewHandler(deps.codeReviewOptions)
 *
 * Note: No default handler is set. Any unrecognised node type will throw the
 * HandlerRegistry's standard error — this is intentional to surface
 * configuration errors early rather than silently falling back.
 *
 * Duck-typing note: SDLC handlers return SdlcOutcome which is structurally
 * compatible with Outcome from @substrate-ai/factory, but defined locally in
 * the sdlc package per ADR-003. Cast via `as unknown as NodeHandler` here at
 * the composition root — the sdlc package itself must NOT import from factory.
 *
 * @param deps - Handler factory options, one per SDLC node type.
 * @returns A HandlerRegistry with all four SDLC handlers registered.
 */
export function buildSdlcHandlerRegistry(deps: SdlcRegistryDeps): HandlerRegistry {
  const registry = new HandlerRegistry()

  registry.register(
    'sdlc.phase',
    createSdlcPhaseHandler(deps.phaseHandlerDeps) as unknown as NodeHandler,
  )
  registry.register(
    'sdlc.create-story',
    createSdlcCreateStoryHandler(deps.createStoryOptions) as unknown as NodeHandler,
  )
  registry.register(
    'sdlc.dev-story',
    createSdlcDevStoryHandler(deps.devStoryOptions) as unknown as NodeHandler,
  )
  registry.register(
    'sdlc.code-review',
    createSdlcCodeReviewHandler(deps.codeReviewOptions) as unknown as NodeHandler,
  )

  return registry
}
