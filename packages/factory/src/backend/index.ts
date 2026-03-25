/**
 * Barrel export for the backend module.
 * Story 42-18.
 */

export type { ICodergenBackend, MockBackendResponse, MockCodergenBackendConfig, CallRecord } from './types.js'
export { MockCodergenBackend, createMockCodergenBackend } from './mock-backend.js'
export type { DirectBackendOptions } from './direct-backend.js'
export { DirectCodergenBackend, createDirectCodergenBackend } from './direct-backend.js'
