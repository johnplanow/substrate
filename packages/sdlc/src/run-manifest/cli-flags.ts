/**
 * run-manifest/cli-flags.ts — alias path for architectural spec conformance.
 *
 * Story 52-3 specified CliFlags at packages/sdlc/src/run-manifest/cli-flags.ts.
 * The implementation lives at ../run-model/cli-flags.ts (established by Story 52-1
 * which used run-model/ as the module namespace). This file re-exports from there
 * so both import paths work.
 */
export { CliFlagsSchema } from '../run-model/cli-flags.js'
export type { CliFlags } from '../run-model/cli-flags.js'
