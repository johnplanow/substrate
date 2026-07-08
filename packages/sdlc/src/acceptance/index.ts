/**
 * Acceptance Gate module (epics A0–A7).
 *
 * Sits beside `verification/` — verification checks the changes an agent
 * MADE; acceptance checks the journeys that were SUPPOSED TO EXIST.
 * Design: _planning/2026-07-07-acceptance-gate-design-brief.md (rev 2).
 */
export * from './types.js'
export { JOURNEY_REGISTRY_PATH, JourneyRegistrySchema, parseJourneyRegistry } from './registry.js'
export { loadJourneyRegistryFromTrustedTree, loadJourneyRegistryFromFile } from './loader.js'
