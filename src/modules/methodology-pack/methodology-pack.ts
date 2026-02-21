/**
 * MethodologyPack interface re-export.
 *
 * The public contract for consuming a loaded methodology pack.
 * Implementations must lazily load and cache content files.
 */

export type {
  MethodologyPack,
  PackManifest,
  PhaseDefinition,
  ConstraintRule,
  ConstraintSeverity,
  PackInfo,
} from './types.js'
