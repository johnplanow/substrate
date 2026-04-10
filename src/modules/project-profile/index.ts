/**
 * Project Profile module public API.
 *
 * Re-exports all public types, schemas, detection functions, and the loader
 * from the project-profile module. Downstream consumers (build gate, contract
 * verifier, test patterns, compiled workflows) import from this barrel.
 */

// Types
export type { Language, BuildTool, PackageEntry, ProjectProfile } from './types.js'

// Schemas (for validation and YAML override loading)
export {
  LanguageSchema,
  BuildToolSchema,
  PackageEntrySchema,
  ProjectProfileSchema,
} from './schema.js'

// Detection functions
export { detectProjectProfile, detectSingleProjectStack, detectMonorepoProfile } from './detect.js'

// Loader (primary entry point for runtime consumers)
export { loadProjectProfile } from './loader.js'
