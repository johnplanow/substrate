/**
 * Runtime probe public surface — Epic 55 / Phase 2.
 *
 * Re-exports the parser, executor, and supporting types. The actual
 * VerificationCheck implementation lives in ../checks/runtime-probe-check.ts
 * to keep the existing `checks/` directory as the canonical location for
 * all VerificationCheck subclasses.
 */

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_TAIL_BYTES,
  RuntimeProbeListSchema,
  RuntimeProbeSandboxSchema,
  RuntimeProbeSchema,
} from './types.js'
export type {
  ProbeResult,
  RuntimeProbe,
  RuntimeProbeParseResult,
  RuntimeProbeSandbox,
} from './types.js'

export { parseRuntimeProbes } from './parser.js'

export { executeProbeOnHost } from './executor.js'
export type { HostExecuteOptions } from './executor.js'
