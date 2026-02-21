/**
 * methodology-pack module — pluggable content packs for pipeline methodology.
 *
 * Public API:
 *   - createPackLoader()        — create a PackLoader to load/discover packs
 *   - PackLoader                — interface for loading packs
 *   - MethodologyPack           — interface for loaded pack with content access
 *   - PackManifest              — manifest type
 *   - PhaseDefinition           — phase type
 *   - ConstraintRule            — constraint rule type
 *   - PackInfo                  — lightweight pack discovery info
 */

export { createPackLoader } from './pack-loader.js'
export type { PackLoader } from './pack-loader.js'
export type {
  MethodologyPack,
  PackManifest,
  PhaseDefinition,
  ConstraintRule,
  ConstraintSeverity,
  PackInfo,
} from './types.js'
