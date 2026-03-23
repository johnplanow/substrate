/**
 * Types for the ScenarioStore — scenario file discovery and integrity verification.
 */

/**
 * Represents a single discovered scenario file with its checksum.
 */
export interface ScenarioEntry {
  /** Filename without directory (e.g., 'scenario-login.sh') */
  name: string
  /** Absolute path to the scenario file on disk */
  path: string
  /** Hex-encoded SHA-256 digest of the file's content at discovery time */
  checksum: string
}

/**
 * Manifest produced by `ScenarioStore.discover()`.
 * Contains the list of discovered scenario files and the time of discovery.
 */
export interface ScenarioManifest {
  /** Discovered scenario entries, sorted alphabetically by name */
  scenarios: ScenarioEntry[]
  /** Unix timestamp in milliseconds (Date.now()) when the manifest was captured */
  capturedAt: number
  /**
   * Names of digital twins required for scenario execution.
   * Populated from the .substrate/twins/ registry.
   * Omit or leave empty when no twins are needed.
   */
  twins?: string[]
}

/**
 * Result of `ScenarioStore.verify()` — integrity check against a previously captured manifest.
 */
export interface ScenarioStoreVerifyResult {
  /** True if all files match their recorded checksums; false if any are tampered or missing */
  valid: boolean
  /** List of file names (not full paths) whose checksum differs from the manifest or that are missing */
  tampered: string[]
}
