/**
 * run-manifest/index.ts — alias path for architectural spec conformance.
 *
 * Story 52-3 specified the module barrel at packages/sdlc/src/run-manifest/index.ts.
 * The implementation lives at ../run-model/index.ts (established by Story 52-1
 * which used run-model/ as the module namespace). This file re-exports from there
 * so both import paths work.
 */
export * from '../run-model/index.js'
