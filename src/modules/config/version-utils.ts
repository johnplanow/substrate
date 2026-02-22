/**
 * Version utility functions for config and task graph format versioning.
 *
 * Provides pure utility functions for parsing, comparing, and formatting
 * version strings used in config and task graph format versioning (FR60, NFR12).
 */

import { ConfigError } from '../../core/errors.js'

/**
 * Parse an integer version string into a number.
 *
 * @param version - A string like "1", "2", "10"
 * @returns The integer value
 * @throws {ConfigError} if the string is not a valid positive integer version
 */
export function parseVersion(version: string): number {
  if (version === '' || version === null || version === undefined) {
    throw new ConfigError(
      `Invalid version string: "${version}". Version must be a positive integer string (e.g. "1", "2").`,
      { version }
    )
  }

  // Must be a string of digits only (no dots, no signs, no decimals)
  if (!/^\d+$/.test(version)) {
    throw new ConfigError(
      `Invalid version string: "${version}". Version must be a positive integer string (e.g. "1", "2").`,
      { version }
    )
  }

  const num = parseInt(version, 10)

  if (num <= 0) {
    throw new ConfigError(
      `Invalid version string: "${version}". Version must be a positive integer (greater than 0).`,
      { version }
    )
  }

  return num
}

/**
 * Check whether a version string is in a list of supported versions.
 *
 * @param version - Version string to check
 * @param supported - List of supported version strings
 * @returns true if version is in the supported list
 */
export function isVersionSupported(version: string, supported: readonly string[]): boolean {
  return supported.includes(version)
}

/**
 * Return the next integer version string.
 *
 * @param version - Current version string like "1"
 * @returns Next version string like "2"
 */
export function getNextVersion(version: string): string {
  return String(parseInt(version, 10) + 1)
}

/**
 * Format the standard "unsupported version" error message.
 *
 * @param formatType - 'config' or 'task_graph'
 * @param version - The unsupported version string found
 * @param supported - List of supported version strings
 * @returns Formatted error message string
 */
export function formatUnsupportedVersionError(
  formatType: 'config' | 'task_graph',
  version: string,
  supported: readonly string[]
): string {
  if (formatType === 'config') {
    return (
      `Configuration format version "${version}" is not supported. ` +
      `This toolkit supports: ${supported.join(', ')}. ` +
      `Please upgrade the toolkit: npm install -g substrate@latest`
    )
  }
  return (
    `Task graph format version "${version}" is not supported. ` +
    `This toolkit supports: ${supported.join(', ')}. ` +
    `Please upgrade the toolkit: npm install -g substrate@latest`
  )
}
