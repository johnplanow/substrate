/**
 * Barrel export for the handlers module.
 * Story 42-9, 42-10.
 */

export { startHandler } from './start.js'
export { exitHandler } from './exit.js'
export { conditionalHandler } from './conditional.js'
export { HandlerRegistry, createDefaultRegistry } from './registry.js'
export { createCodergenHandler } from './codergen-handler.js'
export type { CodergenHandlerOptions } from './codergen-handler.js'
export { createToolHandler } from './tool.js'
export type { ToolHandlerOptions } from './tool.js'
export { createWaitHumanHandler, parseAcceleratorKey, deriveChoices } from './wait-human.js'
export type { WaitHumanHandlerOptions, Choice } from './wait-human.js'
export type { NodeHandler, IHandlerRegistry } from './types.js'
// Re-export ICodergenBackend so callers can import from @substrate-ai/factory/handlers (story 42-18)
export type { ICodergenBackend } from '../backend/types.js'
